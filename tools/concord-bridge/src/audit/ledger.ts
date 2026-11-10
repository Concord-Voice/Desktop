import { createHash } from "node:crypto";
import fs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { evaluateEscalation } from "../gate/activation.js";
import { FLEET_MATRIX } from "../config/fleet-matrix.js";

/**
 * Append-only, hash-chained audit ledger.
 *
 * Storage: one JSON object per line in `<auditDir>/ledger.jsonl`, mode 0600.
 * Each record carries `prev_hash` (the previous record's `hash`, or 64 zeros
 * for the first) and `hash = sha256(prev_hash + "\n" + canonical(record
 * without hash))`. `verifyChain()` recomputes every link, so an edited,
 * reordered, inserted or deleted line is detected. This is tamper-EVIDENT,
 * not tamper-proof: whoever can write the file can rewrite the whole chain.
 *
 * New records omit task content and worker output; legacy records remain on disk.
 */

export const GENESIS_HASH = "0".repeat(64);
export const LEDGER_FILE = "ledger.jsonl";
const MAX_FIELD_CHARS = 16_000;

export interface DialogueRecord {
  turn: number;
  workerStatus: string;
  workerQuestion?: string;
  dispatcherReply?: string;
}

export interface AuditEntryInput {
  taskId: string;
  event: "dispatch" | "reply";
  timestamp?: string;
  initiator: {
    harness: string;
    repliesUsed: number;
    maxDialogueTurns: number;
  };
  admission?: {
    criterion: string;
    detail?: string;
  };
  execution: {
    agentRole: string;
    sovereignOwner: string;
    harnessUsed: string;
    modelResolved: string;
    effortPinned: string;
    access: string;
    durationMs: number;
    exitCode: number | null;
    signal?: string | null;
    status: string;
    failureReason?: string;
  };
  worktree: {
    branch: string;
    path: string;
    baseCommit: string;
    headCommit: string;
  };
  prompt: {
    initialPrompt: string;
    reply?: string;
    contextFiles?: string[];
    dialogueHistory?: DialogueRecord[];
  };
  results: {
    outputSummary?: string;
  };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type LedgerRecord = { [key: string]: JsonValue } & { hash: string; prev_hash: string; task_id: string };

type Replacer = (match: string, ...groups: string[]) => string;

const SECRET_KEYS = "password|passwd|secret|token|api[_-]?key|authorization";
const keepKeyRedactValue: Replacer = (_m, key, sep) => `${key}${sep}[REDACTED]`;

const SECRET_PATTERNS: Array<[RegExp, string | Replacer]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED:stripe-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_\w{20,}/g, "[REDACTED:github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:chat-service-token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"],
  // Quoted and bare values are two patterns: one combined regex exceeds the
  // complexity budget, and the quoted form must win so "a b" is fully redacted.
  [new RegExp(String.raw`\b(${SECRET_KEYS})(\s*[:=]\s*)(?:"[^"]*"|'[^']*')`, "gi"), keepKeyRedactValue],
  [new RegExp(String.raw`\b(${SECRET_KEYS})(\s*[:=]\s*)(?!\[REDACTED\])\S+`, "gi"), keepKeyRedactValue],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const replacer: Replacer = typeof replacement === "string" ? () => replacement : replacement;
    out = out.replace(pattern, replacer);
  }
  return out.length > MAX_FIELD_CHARS ? `${out.slice(0, MAX_FIELD_CHARS)}…[truncated]` : out;
}

function sanitize(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitize(v);
    }
    return out;
  }
  return null;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // Code-unit order, not localeCompare: the hash chain must not depend on locale.
    const keys = Object.keys(value).sort(compareCodeUnits);
    const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]));
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeHash(prevHash: string, body: { [key: string]: JsonValue }): string {
  return createHash("sha256").update(`${prevHash}\n${canonicalJson(body)}`).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  brokenAtLine?: number;
  reason?: string;
}

function auditObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function allowlisted(value: JsonValue | undefined, allowed: readonly (string | null)[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function commitId(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64}|unknown)$/.test(value) ? value : null;
}

function projectLegacyRecord(record: LedgerRecord): LedgerRecord {
  const execution = auditObject(record.execution);
  const worktree = auditObject(record.worktree);
  const prompt = auditObject(record.prompt);
  const admission = auditObject(record.admission);
  const role = execution.agentRole;
  const summary = auditObject(record.results).outputSummary;
  const fleet = Object.values(FLEET_MATRIX);
  return {
    schema: "concord-bridge-audit-legacy-projection",
    task_id: record.task_id,
    event: record.event,
    timestamp: record.timestamp,
    admission: { criterion: typeof admission.criterion === "string" ? /^RC-[1-4]/.exec(admission.criterion)?.[0] ?? null : null },
    execution: {
      agentRole: allowlisted(role, Object.keys(FLEET_MATRIX)),
      status: allowlisted(execution.status, ["RUNNING", "COMPLETED", "AWAITING_INPUT", "PERMISSION_GATE", "FAILED", "CIRCUIT_BREAKER_EXHAUSTED"]),
      harnessUsed: allowlisted(execution.harnessUsed, ["claude", "codex", "antigravity"]),
      sovereignOwner: allowlisted(execution.sovereignOwner, fleet.map((row) => row.sovereignOwner)),
      modelResolved: allowlisted(execution.modelResolved, fleet.flatMap((row) => [row.claudeModel, row.codexModel, row.agyModel])),
      effortPinned: allowlisted(execution.effortPinned, ["low", "medium", "high", "xhigh", "max"]),
      access: allowlisted(execution.access, ["read-only", "workspace-write", "isolated-write"]),
      durationMs: typeof execution.durationMs === "number" && Number.isFinite(execution.durationMs) ? execution.durationMs : null,
      exitCode: typeof execution.exitCode === "number" && Number.isFinite(execution.exitCode) ? execution.exitCode : null,
    },
    worktree: { baseCommit: commitId(worktree.baseCommit), headCommit: commitId(worktree.headCommit) },
    prompt: { contextFileCount: Array.isArray(prompt.contextFiles) ? prompt.contextFiles.length : 0, dialogueTurns: Array.isArray(prompt.dialogueHistory) ? prompt.dialogueHistory.length : 0 },
    results: { highSeverityFinding: typeof role === "string" && typeof summary === "string" && evaluateEscalation({ agentRole: role, outputSummary: summary }) },
    prev_hash: record.prev_hash,
    hash: record.hash,
  };
}

function nonnegativeCount(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function projectV3Record(record: LedgerRecord): LedgerRecord {
  const projected = projectLegacyRecord(record);
  const initiator = auditObject(record.initiator);
  const execution = auditObject(record.execution);
  const prompt = auditObject(record.prompt);
  const results = auditObject(record.results);
  return {
    ...projected,
    schema: "concord-bridge-audit-v3",
    initiator: {
      repliesUsed: nonnegativeCount(initiator.repliesUsed),
      maxDialogueTurns: nonnegativeCount(initiator.maxDialogueTurns),
    },
    execution: {
      ...auditObject(projected.execution),
      signal: typeof execution.signal === "string" && execution.signal in osConstants.signals ? execution.signal : null,
    },
    prompt: {
      contextFileCount: nonnegativeCount(prompt.contextFileCount),
      dialogueTurns: nonnegativeCount(prompt.dialogueTurns),
    },
    results: { highSeverityFinding: results.highSeverityFinding === true },
  };
}

export class AuditLedger {
  public readonly auditDir: string;
  public readonly ledgerPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(auditDir = ".agent-bus/audit") {
    this.auditDir = path.resolve(auditDir);
    this.ledgerPath = path.join(this.auditDir, LEDGER_FILE);
  }

  private readLines(): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.ledgerPath, "utf-8");
    } catch {
      return [];
    }
    return raw.split("\n").filter((l) => l.length > 0);
  }

  private lastHash(): string {
    const lines = this.readLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed: unknown = JSON.parse(lines[i]);
        if (typeof parsed === "object" && parsed !== null && "hash" in parsed && typeof parsed.hash === "string") {
          return parsed.hash;
        }
      } catch {
        // A corrupt tail line is chained over; verifyChain() still reports it.
      }
    }
    return GENESIS_HASH;
  }

  public writeEntry(entry: AuditEntryInput): Promise<LedgerRecord> {
    const next = this.writeQueue.then(() => this.append(entry));
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async append(entry: AuditEntryInput): Promise<LedgerRecord> {
    await fs.promises.mkdir(this.auditDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date(entry.timestamp ?? Date.now()).toISOString();
    const highSeverityFinding = evaluateEscalation({
      agentRole: entry.execution.agentRole,
      outputSummary: redactSecrets(entry.results.outputSummary ?? ""),
    });
    const body = sanitize({
      schema: "concord-bridge-audit-v3",
      task_id: entry.taskId,
      event: entry.event,
      timestamp,
      initiator: { repliesUsed: entry.initiator.repliesUsed, maxDialogueTurns: entry.initiator.maxDialogueTurns },
      admission: entry.admission ? { criterion: /^RC-[1-4]/.exec(entry.admission.criterion)?.[0] ?? null } : undefined,
      execution: {
        agentRole: entry.execution.agentRole,
        sovereignOwner: entry.execution.sovereignOwner,
        harnessUsed: entry.execution.harnessUsed,
        modelResolved: entry.execution.modelResolved,
        effortPinned: entry.execution.effortPinned,
        access: entry.execution.access,
        durationMs: entry.execution.durationMs,
        exitCode: entry.execution.exitCode,
        signal: entry.execution.signal,
        status: entry.execution.status,
      },
      worktree: { baseCommit: entry.worktree.baseCommit, headCommit: entry.worktree.headCommit },
      prompt: { contextFileCount: entry.prompt.contextFiles?.length ?? 0, dialogueTurns: entry.prompt.dialogueHistory?.length ?? 0 },
      results: { highSeverityFinding },
    });
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("audit entry did not serialize to an object");
    }
    const prevHash = this.lastHash();
    const withPrev = { ...body, prev_hash: prevHash };
    const record = { ...withPrev, hash: computeHash(prevHash, withPrev) } as LedgerRecord;
    const handle = await fs.promises.open(this.ledgerPath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(`${JSON.stringify(record)}\n`, "utf-8");
    } finally {
      await handle.close();
    }
    return record;
  }

  /** Newest first. Corrupt lines are skipped, never thrown. Limit is clamped to 1..200. */
  public query(options: { taskId?: string; limit?: number } = {}): LedgerRecord[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 10) || 10));
    const lines = this.readLines();
    const results: LedgerRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || !("task_id" in parsed) || typeof parsed.task_id !== "string") {
        continue;
      }
      if (options.taskId !== undefined && parsed.task_id !== options.taskId) continue;
      const record = parsed as LedgerRecord;
      results.push(record.schema === "concord-bridge-audit-v3" ? projectV3Record(record) : projectLegacyRecord(record));
    }
    return results;
  }

  public verifyChain(): VerifyResult {
    const lines = this.readLines();
    let prev = GENESIS_HASH;
    for (let i = 0; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "unparseable line" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "not an object" };
      }
      const { hash, ...rest } = parsed as { [key: string]: JsonValue };
      if (rest.prev_hash !== prev) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "prev_hash does not match previous record" };
      }
      if (typeof hash !== "string" || computeHash(prev, rest) !== hash) {
        return { ok: false, entries: i, brokenAtLine: i + 1, reason: "hash mismatch" };
      }
      prev = hash;
    }
    return { ok: true, entries: lines.length };
  }
}
