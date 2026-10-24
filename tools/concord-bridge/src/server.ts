import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AuditLedger, type JsonValue, type LedgerRecord } from "./audit/ledger.js";
import { getAgentConfig, normalizeRole, type AgentConfig, type HarnessType } from "./config/fleet-matrix.js";
import {
  evaluateActivationGate,
  evaluateEscalation,
  normalizeRepoPath,
  type ElicitOutcome,
  type Elicitor,
  type EscalationEvidence,
} from "./gate/activation.js";
import { AntigravityRunner } from "./runners/agy-runner.js";
import { WORKER_ENV_FLAG, type HarnessRunner, type RunnerResult } from "./runners/base.js";
import { ClaudeRunner } from "./runners/claude-runner.js";
import { CodexRunner } from "./runners/codex-runner.js";
import { SessionStateMachine, type SessionExecution } from "./session/state-machine.js";
import { isStrictlyInside, WorktreeManager } from "./worktree/manager.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface BridgeOptions {
  repoRoot?: string;
  worktreesRoot?: string;
  auditDir?: string;
  runners?: Partial<Record<HarnessType, HarnessRunner>>;
  /** Overrides the MCP elicitation call (tests). */
  elicitor?: Elicitor;
  runnerTimeoutMs?: number;
  /** Overrides the in-worker recursion check (tests). */
  isWorkerCheckout?: (repoRoot: string) => Promise<boolean>;
}

const HARNESSES = ["claude", "codex", "antigravity"] as const;

const dispatchShape = {
  agent_role: z.string().min(1).max(64),
  prompt: z.string().min(1).max(200_000),
  branch: z.string().min(1).max(100).optional(),
  harness_override: z.enum(HARNESSES).optional(),
  context_files: z.array(z.string().max(1024)).max(500).optional(),
  escalation_task_id: z.string().min(1).max(128).optional(),
};
const replyShape = {
  session_id: z.string().min(1).max(128),
  reply: z.string().min(1).max(200_000),
};
const queryShape = {
  task_id: z.string().max(128).optional(),
  limit: z.number().int().optional(),
  verify_chain: z.boolean().optional(),
};

type DispatchArgs = z.infer<z.ZodObject<typeof dispatchShape>>;
type ReplyArgs = z.infer<z.ZodObject<typeof replyShape>>;
type QueryArgs = z.infer<z.ZodObject<typeof queryShape>>;

function text(value: unknown, isError = false): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError ? { isError: true, content: [{ type: "text", text: body }] } : { content: [{ type: "text", text: body }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function field(record: { [key: string]: JsonValue }, ...keys: string[]): JsonValue | undefined {
  let cur: JsonValue | undefined = record;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function resolveExecution(
  config: AgentConfig,
  harness: HarnessType,
): { ok: true; execution: SessionExecution } | { ok: false; reason: string } {
  const common = { access: config.access, maxTurns: config.maxTurns };
  if (harness === "claude") {
    return { ok: true, execution: { harness, model: config.claudeModel, effort: config.claudeEffort, ...common } };
  }
  if (harness === "codex") {
    if (!config.codexModel) return { ok: false, reason: `Role ${config.role} is unsupported on Codex.` };
    return { ok: true, execution: { harness, model: config.codexModel, effort: config.codexEffort ?? "medium", ...common } };
  }
  if (!config.agyModel) return { ok: false, reason: `Role ${config.role} is unsupported on Antigravity.` };
  return { ok: true, execution: { harness, model: config.agyModel, effort: config.agyEffort ?? "medium", ...common } };
}

export class BridgeMcpServer {
  public readonly mcp: McpServer;
  public readonly repoRoot: string;
  private readonly registeredToolNames: string[] = [];
  private readonly toolHandlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
  private readonly activeSessions = new Map<string, SessionStateMachine>();
  private readonly worktreeManager: WorktreeManager;
  private readonly auditLedger: AuditLedger;
  private readonly runners: Record<HarnessType, HarnessRunner>;
  private readonly elicitor: Elicitor;
  private readonly runnerTimeoutMs?: number;
  private readonly isWorkerCheckout: (repoRoot: string) => Promise<boolean>;

  constructor(options: BridgeOptions = {}) {
    this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    this.mcp = new McpServer({ name: "concord-bridge", version: "1.1.0" });
    this.worktreeManager = new WorktreeManager(this.repoRoot, options.worktreesRoot);
    this.auditLedger = new AuditLedger(options.auditDir ?? path.join(this.repoRoot, ".agent-bus", "audit"));
    this.runners = {
      claude: options.runners?.claude ?? new ClaudeRunner(),
      codex: options.runners?.codex ?? new CodexRunner(),
      antigravity: options.runners?.antigravity ?? new AntigravityRunner(),
    };
    this.elicitor = options.elicitor ?? ((message) => this.elicitViaClient(message));
    this.runnerTimeoutMs = options.runnerTimeoutMs;
    this.isWorkerCheckout = options.isWorkerCheckout ?? ((dir) => WorktreeManager.isBridgeWorkerCheckout(dir));
    this.registerTools();
  }

  public getRegisteredTools(): string[] {
    return [...this.registeredToolNames];
  }

  public getSession(sessionId: string): SessionStateMachine | undefined {
    return this.activeSessions.get(sessionId);
  }

  public get ledger(): AuditLedger {
    return this.auditLedger;
  }

  public async executeTool(name: string, args: unknown): Promise<ToolResult> {
    const handler = this.toolHandlers.get(name);
    if (!handler) throw new Error(`Tool not found: ${name}`);
    return handler(args);
  }

  private registerTool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ): void {
    const schema = z.object(shape).strict();
    const safeHandler = async (raw: unknown): Promise<ToolResult> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ");
        return text(`Invalid arguments: ${issues}`, true);
      }
      return handler(parsed.data);
    };
    this.registeredToolNames.push(name);
    this.toolHandlers.set(name, safeHandler);
    // Widened to the non-generic shape type for the SDK; safeHandler re-validates strictly.
    const sdkShape: z.ZodRawShape = shape;
    this.mcp.registerTool(name, { description, inputSchema: sdkShape }, (args) => safeHandler(args));
  }

  /** RC-4: ask the human through MCP elicitation. Anything but an explicit "approve: true" refuses. */
  private async elicitViaClient(message: string): Promise<ElicitOutcome> {
    if (!this.mcp.server.getClientCapabilities()?.elicitation) return "unsupported";
    try {
      const result = await this.mcp.server.elicitInput(
        {
          message,
          requestedSchema: {
            type: "object",
            properties: {
              approve: {
                type: "boolean",
                title: "Approve RC-4 override",
                description: "Dispatch red-team-critical even though RC-1..RC-3 are not met",
              },
            },
            required: ["approve"],
          },
        },
        { timeout: 5 * 60 * 1000 },
      );
      return result.action === "accept" && result.content?.approve === true ? "approved" : "declined";
    } catch {
      return "unsupported";
    }
  }

  private clientName(): string {
    return this.mcp.server.getClientVersion()?.name ?? "unknown-mcp-client";
  }

  private async findEscalation(taskId: string): Promise<EscalationEvidence | null> {
    for (const record of this.auditLedger.query({ taskId, limit: 200 })) {
      const role = field(record, "execution", "agentRole");
      const summary = field(record, "results", "outputSummary");
      const status = field(record, "execution", "status");
      if (typeof role !== "string" || typeof summary !== "string" || status !== "COMPLETED") continue;
      const evidence = { agentRole: role, outputSummary: summary };
      if (evaluateEscalation(evidence)) return evidence;
    }
    return null;
  }

  private existingContextPaths(contextFiles: readonly string[]): string[] {
    const out: string[] = [];
    for (const raw of contextFiles) {
      const rel = normalizeRepoPath(raw);
      if (rel === null) continue;
      const abs = path.join(this.repoRoot, rel);
      try {
        const real = fs.realpathSync(abs);
        if (isStrictlyInside(fs.realpathSync(this.repoRoot), real)) out.push(rel);
      } catch {
        // Nonexistent paths are not evidence.
      }
    }
    return out;
  }

  private async headCommit(worktreePath: string): Promise<string> {
    try {
      return await this.worktreeManager.revParse("HEAD", worktreePath);
    } catch {
      return "unknown";
    }
  }

  private applyResult(sm: SessionStateMachine, result: RunnerResult): void {
    if (result.status === "AWAITING_INPUT") sm.recordPause("AWAITING_INPUT", result.question);
    else if (result.status === "PERMISSION_GATE") sm.recordPause("PERMISSION_GATE", result.permissionDetails);
    else if (result.status === "COMPLETED") sm.complete();
    else sm.fail(result.failureReason);
  }

  private async audit(
    sm: SessionStateMachine,
    event: "dispatch" | "reply",
    result: RunnerResult,
    config: AgentConfig,
    reply?: string,
  ): Promise<void> {
    await this.auditLedger.writeEntry({
      taskId: sm.sessionId,
      event,
      initiator: { harness: this.clientName(), repliesUsed: sm.repliesUsed, maxDialogueTurns: sm.maxDialogueTurns },
      admission: sm.admittedBy ? { criterion: sm.admittedBy } : undefined,
      execution: {
        agentRole: sm.agentRole,
        sovereignOwner: config.sovereignOwner,
        harnessUsed: sm.execution.harness,
        modelResolved: sm.execution.model,
        effortPinned: sm.execution.effort,
        access: sm.execution.access,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        signal: result.signal,
        status: sm.getStatus(),
        failureReason: result.failureReason,
      },
      worktree: {
        branch: sm.branch,
        path: sm.worktreePath,
        baseCommit: sm.baseCommit,
        headCommit: await this.headCommit(sm.worktreePath),
      },
      prompt: {
        initialPrompt: sm.initialPrompt,
        reply,
        contextFiles: sm.contextFiles,
        dialogueHistory: sm.dialogueHistory.map((d) => ({ ...d })),
      },
      results: { outputSummary: result.stdout || result.stderr },
    });
  }

  private sessionView(sm: SessionStateMachine, result: RunnerResult): Record<string, unknown> {
    const view: Record<string, unknown> = {
      session_id: sm.sessionId,
      status: sm.getStatus(),
      replies_used: sm.repliesUsed,
      max_dialogue_turns: sm.maxDialogueTurns,
      harness: sm.execution.harness,
      model: sm.execution.model,
      worktree_path: sm.worktreePath,
      branch: sm.branch,
      admitted_by: sm.admittedBy,
      question: result.question,
      permission_details: result.permissionDetails,
      failure_reason: result.failureReason,
      output: result.stdout || result.stderr,
    };
    if (sm.isCircuitBroken()) {
      view.recommendation =
        "Dialogue budget exhausted. Recommendation only (the bridge has NOT dispatched anything): escalate to @senior-engineer under E4.";
    }
    return view;
  }

  private buildTaskPrompt(prompt: string, contextFiles: readonly string[]): string {
    if (contextFiles.length === 0) return prompt;
    const list = contextFiles.map((f) => "- " + f).join("\n");
    return `${prompt}\n\nContext files:\n${list}`;
  }

  private buildReplyPrompt(sm: SessionStateMachine, reply: string): string {
    const pending = sm.pendingQuestion();
    const history = sm.dialogueHistory
      .filter((d) => d !== pending)
      .map((d) => `Turn ${d.turn} (${d.workerStatus}):\nWorker: ${d.workerQuestion ?? ""}\nDispatcher: ${d.dispatcherReply ?? ""}`)
      .join("\n\n");
    const permissionNote =
      pending?.workerStatus === "PERMISSION_GATE"
        ? "\n\nThis reply answers your permission request. It does NOT change your sandbox or permission mode; if the action still needs a permission you do not have, say so and stop."
        : "";
    return [
      "You are resuming a task in the same worktree. Your earlier changes are on disk.",
      "",
      "Original task:",
      this.buildTaskPrompt(sm.initialPrompt, sm.contextFiles),
      history ? `\nEarlier dialogue:\n${history}` : "",
      "",
      `Your last question (${pending?.workerStatus ?? "AWAITING_INPUT"}):`,
      pending?.workerQuestion ?? "",
      "",
      `Dispatcher reply:${permissionNote}`,
      reply,
    ].join("\n");
  }

  private async dispatch(args: DispatchArgs): Promise<ToolResult> {
    if (process.env[WORKER_ENV_FLAG] === "1" || (await this.isWorkerCheckout(this.repoRoot))) {
      return text("Refused: this bridge is running inside a bridge worker; recursive dispatch is not allowed.", true);
    }

    const role = normalizeRole(args.agent_role);
    if (role === null) return text(`Invalid agent role: ${args.agent_role}`, true);
    const config = getAgentConfig(role);

    const resolved = resolveExecution(config, args.harness_override ?? config.defaultHarness);
    if (!resolved.ok) return text(resolved.reason, true);

    const sessionId = `dispatch_${randomUUID()}`;
    const branch = args.branch ?? `bridge/${sessionId}`;
    try {
      await this.worktreeManager.validateBranch(branch);
    } catch (err) {
      return text(errorMessage(err), true);
    }

    const contextFiles = this.existingContextPaths(args.context_files ?? []);
    let admittedBy: string | undefined;
    if (role === "red-team-critical") {
      const gate = await this.admitRedTeamCritical(args, contextFiles, branch, resolved.execution.harness);
      if (!gate.admitted) return text(gate.detail, true);
      admittedBy = gate.detail;
    }

    let worktree;
    try {
      worktree = await this.worktreeManager.createWorktree({ sessionId, branch });
    } catch (err) {
      return text(`Failed to create worktree: ${errorMessage(err)}`, true);
    }

    const sm = new SessionStateMachine({
      sessionId,
      agentRole: role,
      maxDialogueTurns: config.maxDialogueTurns,
      initialPrompt: args.prompt,
      execution: resolved.execution,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      contextFiles,
      admittedBy,
    });
    this.activeSessions.set(sessionId, sm);

    const result = await this.runners[sm.execution.harness].run({
      ...sm.execution,
      workdir: sm.worktreePath,
      prompt: this.buildTaskPrompt(args.prompt, contextFiles),
      timeoutMs: this.runnerTimeoutMs,
    });
    this.applyResult(sm, result);
    await this.audit(sm, "dispatch", result, config);
    return text(this.sessionView(sm, result));
  }

  private async admitRedTeamCritical(
    args: DispatchArgs,
    contextFiles: string[],
    branch: string,
    harness: string,
  ): Promise<{ admitted: boolean; detail: string }> {
    let branchPaths: string[] = [];
    if (args.branch !== undefined && (await this.worktreeManager.branchExists(args.branch))) {
      try {
        branchPaths = await this.worktreeManager.changedPaths(args.branch);
      } catch {
        branchPaths = [];
      }
    }
    const decision = await evaluateActivationGate({
      paths: [...contextFiles, ...branchPaths],
      escalation: args.escalation_task_id ? await this.findEscalation(args.escalation_task_id) : null,
      elicit: this.elicitor,
      describeDispatch: `Role: red-team-critical\nBranch: ${branch}\nHarness: ${harness}\nPrompt (first 500 chars):\n${args.prompt.slice(0, 500)}`,
    });
    if (!decision.admitted) {
      return {
        admitted: false,
        detail: `Activation criteria not satisfied for red-team-critical: ${decision.detail}. Request rejected fail-closed.`,
      };
    }
    return { admitted: true, detail: `${decision.criterion}: ${decision.detail}` };
  }

  private async reply(args: ReplyArgs): Promise<ToolResult> {
    const sm = this.activeSessions.get(args.session_id);
    if (!sm) return text(`Session ${args.session_id} not found.`, true);

    const block = sm.replyBlock();
    if (block === "terminal") {
      return text(`Session ${sm.sessionId} is already ${sm.getStatus()}; it cannot accept a reply.`, true);
    }
    if (block === "budget-exhausted") {
      return text(
        `Dialogue budget exhausted: ${sm.repliesUsed} of ${sm.maxDialogueTurns} replies used. Recommendation only (the bridge has NOT dispatched anything): escalate to @senior-engineer under E4.`,
        true,
      );
    }
    if (block === "not-paused") {
      return text(`Session ${sm.sessionId} is ${sm.getStatus()}; it is not waiting for input.`, true);
    }

    const config = getAgentConfig(sm.agentRole);
    const prompt = this.buildReplyPrompt(sm, args.reply);
    sm.recordReply(args.reply);
    const result = await this.runners[sm.execution.harness].run({
      ...sm.execution,
      workdir: sm.worktreePath,
      prompt,
      timeoutMs: this.runnerTimeoutMs,
    });
    this.applyResult(sm, result);
    await this.audit(sm, "reply", result, config, args.reply);
    return text(this.sessionView(sm, result));
  }

  private async queryAudit(args: QueryArgs): Promise<ToolResult> {
    const entries: LedgerRecord[] = this.auditLedger.query({ taskId: args.task_id, limit: args.limit });
    if (args.verify_chain) {
      return text({ chain: this.auditLedger.verifyChain(), entries });
    }
    return text(entries);
  }

  private registerTools(): void {
    this.registerTool(
      "bridge_dispatch_task",
      "Spawn a headless worker (Claude, Codex, Antigravity) in a new isolated git worktree. red-team-critical is gated by RC-1..RC-3 or a human RC-4 override asked through MCP elicitation.",
      dispatchShape,
      (args) => this.dispatch(args),
    );
    this.registerTool(
      "bridge_reply",
      "Reply to a worker paused at AWAITING_INPUT or PERMISSION_GATE. Reuses the session's harness, model, effort and worktree.",
      replyShape,
      (args) => this.reply(args),
    );
    this.registerTool(
      "bridge_query_audit_log",
      "Query recent entries of the hash-chained audit ledger (newest first, limit 1-200); optionally verify the chain.",
      queryShape,
      (args) => this.queryAudit(args),
    );
    this.registerTool("bridge_list_active_worktrees", "List the sessions and worktrees this bridge process manages.", {}, async () =>
      text(
        Array.from(this.activeSessions.values()).map((s) => ({
          sessionId: s.sessionId,
          agentRole: s.agentRole,
          repliesUsed: s.repliesUsed,
          maxDialogueTurns: s.maxDialogueTurns,
          status: s.getStatus(),
          harness: s.execution.harness,
          worktreePath: s.worktreePath,
          branch: s.branch,
          admittedBy: s.admittedBy,
        })),
      ),
    );
  }
}

export function createBridgeMcpServer(options: BridgeOptions | string = {}): BridgeMcpServer {
  return new BridgeMcpServer(typeof options === "string" ? { repoRoot: options } : options);
}
