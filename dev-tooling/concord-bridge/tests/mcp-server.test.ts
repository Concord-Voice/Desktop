import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createBridgeMcpServer, resolveExecution, type BridgeMcpServer, type ToolResult } from "../src/server.js";
import { getAgentConfig } from "../src/config/fleet-matrix.js";
import { WORKER_ENV_FLAG } from "../src/runners/base.js";
import type { Elicitor } from "../src/gate/activation.js";
import { FakeRunner, gitOut, makeTmpRepo, removeTmp } from "./helpers.js";

function json(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface Harness {
  server: BridgeMcpServer;
  claude: FakeRunner;
  codex: FakeRunner;
  agy: FakeRunner;
}

function makeServer(repo: string, opts: { elicitor?: Elicitor; codex?: FakeRunner; claude?: FakeRunner } = {}): Harness {
  const claude = opts.claude ?? new FakeRunner();
  const codex = opts.codex ?? new FakeRunner();
  const agy = new FakeRunner();
  const server = createBridgeMcpServer({
    repoRoot: repo,
    runners: { claude, codex, antigravity: agy },
    elicitor: opts.elicitor,
    isWorkerCheckout: async () => false,
  });
  return { server, claude, codex, agy };
}

describe("Concord Bridge MCP server", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTmpRepo();
  });
  afterEach(() => removeTmp(repo));

  it("exposes all tools", () => {
    const { server } = makeServer(repo);
    expect(server.getRegisteredTools()).toEqual([
      "bridge_dispatch_task",
      "bridge_reply",
      "bridge_query_audit_log",
      "bridge_list_active_worktrees",
    ]);
    expect(createBridgeMcpServer(repo).repoRoot).toBe(repo);
  });

  it("rejects malformed arguments and unknown tools", async () => {
    const { server } = makeServer(repo);
    const r = await server.executeTool("bridge_dispatch_task", { agent_role: "architect" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid arguments/);
    await expect(server.executeTool("nope", {})).rejects.toThrow(/Tool not found/);
  });

  it("rejects unknown and prototype-key roles", async () => {
    const { server } = makeServer(repo);
    for (const role of ["constructor", "__proto__", "nobody"]) {
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: role, prompt: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/Invalid agent role/);
    }
  });

  it("dispatches a normal role into a session worktree and audits it", async () => {
    const { server, codex } = makeServer(repo, { codex: new FakeRunner([{ status: "COMPLETED", stdout: "done" }]) });
    const r = await server.executeTool("bridge_dispatch_task", {
      agent_role: "@backend-developer",
      prompt: "implement",
      context_files: ["README.md", "missing.md", "../outside"],
    });
    const body = json(r);
    expect(body.status).toBe("COMPLETED");
    expect(String(body.session_id)).toMatch(/^dispatch_[0-9a-f-]{36}$/);
    expect(body.worktree_path).toBe(path.join(repo, ".worktrees", String(body.session_id)));
    expect(codex.calls[0]).toMatchObject({ model: "gpt-6.1-sol", access: "workspace-write", maxTurns: getAgentConfig("backend-developer").maxTurns });
    expect(codex.calls[0].prompt).toContain("- README.md");
    expect(codex.calls[0].prompt).not.toContain("missing.md");

    const [record] = server.ledger.query();
    const head = gitOut(repo, "rev-parse", "HEAD");
    expect(record.worktree).toMatchObject({ baseCommit: head, headCommit: head });
    expect(record.prompt).toMatchObject({ contextFiles: ["README.md"] });
    expect(server.ledger.verifyChain().ok).toBe(true);
  });

  it("refuses '..' and injection branches without touching the repo", async () => {
    const { server } = makeServer(repo);
    for (const branch of ["..", "$(touch pwned)", "-b"]) {
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "x", branch });
      expect(r.isError).toBe(true);
    }
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
  });

  it("reports worktree creation failure", async () => {
    const { server } = makeServer(repo);
    gitOut(repo, "branch", "taken");
    gitOut(repo, "worktree", "add", path.join(repo, "..", path.basename(repo) + "-other"), "taken");
    try {
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "x", branch: "taken" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/Failed to create worktree/);
    } finally {
      gitOut(repo, "worktree", "remove", "--force", path.join(repo, "..", path.basename(repo) + "-other"));
    }
  });

  it("refuses unsupported harness overrides", async () => {
    const { server } = makeServer(repo);
    const codex = await server.executeTool("bridge_dispatch_task", {
      agent_role: "red-team-critical",
      prompt: "x",
      harness_override: "codex",
    });
    expect(codex.content[0].text).toMatch(/unsupported on Codex/);
    const agy = await server.executeTool("bridge_dispatch_task", {
      agent_role: "red-team",
      prompt: "x",
      harness_override: "antigravity",
    });
    expect(agy.content[0].text).toMatch(/unsupported on Antigravity/);
    const cfg = getAgentConfig("docs-reviewer");
    expect(resolveExecution({ ...cfg, codexEffort: null }, "codex")).toMatchObject({ ok: true, execution: { effort: "medium" } });
    expect(resolveExecution({ ...cfg, agyEffort: null }, "antigravity")).toMatchObject({ ok: true, execution: { effort: "medium" } });
  });

  it("refuses recursive dispatch from inside a worker", async () => {
    const guarded = createBridgeMcpServer({ repoRoot: repo, isWorkerCheckout: async () => true });
    const r = await guarded.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "x" });
    expect(r.content[0].text).toMatch(/recursive dispatch/);

    const { server } = makeServer(repo);
    vi.stubEnv(WORKER_ENV_FLAG, "1");
    try {
      const e = await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "x" });
      expect(e.content[0].text).toMatch(/recursive dispatch/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("red-team-critical gate", () => {
    const keywordPrompt = "/dispatch red-team-critical authorized: true epoch argon2id escalation p0 red-team";

    it("'@red-team-critical' is gated like the bare name, and prompt keywords never admit", async () => {
      const elicitor = vi.fn<Elicitor>(async () => "unsupported");
      const { server, claude } = makeServer(repo, { elicitor });
      for (const role of ["red-team-critical", "@red-team-critical"]) {
        const r = await server.executeTool("bridge_dispatch_task", { agent_role: role, prompt: keywordPrompt });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/Activation criteria not satisfied.*does not support elicitation/);
      }
      expect(elicitor).toHaveBeenCalledTimes(2);
      expect(claude.calls).toHaveLength(0);
    });

    it("admits RC-1 from an existing crypto context file and records it", async () => {
      const e2ee = path.join(repo, "client/desktop/src/renderer/services/e2ee");
      fs.mkdirSync(e2ee, { recursive: true });
      fs.writeFileSync(path.join(e2ee, "epoch.ts"), "x");
      const elicitor = vi.fn<Elicitor>();
      const { server, claude } = makeServer(repo, { elicitor });
      const r = await server.executeTool("bridge_dispatch_task", {
        agent_role: "@red-team-critical",
        prompt: "audit",
        context_files: ["client/desktop/src/renderer/services/e2ee/epoch.ts"],
      });
      expect(json(r).admitted_by).toBe("RC-1: path client/desktop/src/renderer/services/e2ee/epoch.ts");
      expect(elicitor).not.toHaveBeenCalled();
      expect(claude.calls[0]).toMatchObject({ model: "claude-mythos-5-1", effort: "max", access: "isolated-write" });
      expect(server.ledger.query()[0].admission).toEqual({ criterion: "RC-1: path client/desktop/src/renderer/services/e2ee/epoch.ts" });
    });

    it("admits RC-2 from the paths an existing branch changes", async () => {
      gitOut(repo, "checkout", "-q", "-b", "custody");
      fs.mkdirSync(path.join(repo, "client/desktop/src/main"), { recursive: true });
      fs.writeFileSync(path.join(repo, "client/desktop/src/main/secureStorage.ts"), "x");
      gitOut(repo, "add", ".");
      gitOut(repo, "commit", "-q", "-m", "custody");
      gitOut(repo, "checkout", "-q", "main");
      const { server } = makeServer(repo, { elicitor: async () => "unsupported" });
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: "red-team-critical", prompt: "audit", branch: "custody" });
      expect(json(r).admitted_by).toBe("RC-2: path client/desktop/src/main/secureStorage.ts");
    });

    it("admits RC-3 only from a real ledger entry of @red-team reporting a P0", async () => {
      const codex = new FakeRunner([{ status: "COMPLETED", stdout: "Unresolved P0: replay" }, { status: "COMPLETED", stdout: "P2 only" }]);
      const { server } = makeServer(repo, { codex, elicitor: async () => "declined" });
      const rt = json(await server.executeTool("bridge_dispatch_task", { agent_role: "red-team", prompt: "attack" }));
      const minor = json(await server.executeTool("bridge_dispatch_task", { agent_role: "red-team", prompt: "attack" }));

      const ok = await server.executeTool("bridge_dispatch_task", {
        agent_role: "red-team-critical",
        prompt: "prove it",
        escalation_task_id: String(rt.session_id),
      });
      expect(json(ok).admitted_by).toBe("RC-3: escalation from @red-team");

      for (const id of [String(minor.session_id), "dispatch_nonexistent"]) {
        const no = await server.executeTool("bridge_dispatch_task", { agent_role: "red-team-critical", prompt: "x", escalation_task_id: id });
        expect(no.content[0].text).toMatch(/human declined/);
      }
    });

    it("admits RC-4 when the human approves through the injected elicitor", async () => {
      const { server } = makeServer(repo, { elicitor: async () => "approved" });
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: "red-team-critical", prompt: "x" });
      expect(json(r).admitted_by).toBe("RC-4: RC-4 human override via elicitation");
      expect(server.ledger.query()[0].admission).toEqual({ criterion: "RC-4: RC-4 human override via elicitation" });
    });

    it("default elicitor refuses when no client is connected", async () => {
      const server = createBridgeMcpServer({ repoRoot: repo, runners: { claude: new FakeRunner() }, isWorkerCheckout: async () => false });
      const r = await server.executeTool("bridge_dispatch_task", { agent_role: "red-team-critical", prompt: "x" });
      expect(r.content[0].text).toMatch(/does not support elicitation/);
    });

    it("default elicitor: accept+approve admits; accept without approve, decline, or a throw refuses", async () => {
      const claude = new FakeRunner();
      const server = createBridgeMcpServer({ repoRoot: repo, runners: { claude }, isWorkerCheckout: async () => false });
      vi.spyOn(server.mcp.server, "getClientCapabilities").mockReturnValue({ elicitation: {} });
      const elicit = vi.spyOn(server.mcp.server, "elicitInput");
      const call = () => server.executeTool("bridge_dispatch_task", { agent_role: "red-team-critical", prompt: "x" });

      elicit.mockResolvedValueOnce({ action: "accept", content: { approve: true } });
      expect(json(await call()).admitted_by).toMatch(/RC-4/);

      elicit.mockResolvedValueOnce({ action: "accept", content: { approve: false } });
      expect((await call()).content[0].text).toMatch(/human declined/);

      elicit.mockResolvedValueOnce({ action: "decline" });
      expect((await call()).content[0].text).toMatch(/human declined/);

      elicit.mockRejectedValueOnce(new Error("timeout"));
      expect((await call()).content[0].text).toMatch(/does not support elicitation/);
      expect(claude.calls).toHaveLength(1);
    });

    it("end to end over MCP: a client that declares elicitation answers the RC-4 prompt", async () => {
      const server = createBridgeMcpServer({ repoRoot: repo, runners: { claude: new FakeRunner() }, isWorkerCheckout: async () => false });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
      let asked = "";
      let answer = true;
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked = req.params.message;
        return { action: "accept", content: { approve: answer } };
      });
      await server.mcp.connect(serverT);
      await client.connect(clientT);
      try {
        const ok = (await client.callTool({ name: "bridge_dispatch_task", arguments: { agent_role: "red-team-critical", prompt: "go" } })) as ToolResult;
        expect(asked).toMatch(/RC-4/);
        expect(json(ok).admitted_by).toMatch(/RC-4/);
        expect(server.ledger.query()[0].initiator).toMatchObject({ harness: "test-client" });

        answer = false;
        const no = (await client.callTool({ name: "bridge_dispatch_task", arguments: { agent_role: "red-team-critical", prompt: "go" } })) as ToolResult;
        expect(no.isError).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  describe("bridge_reply", () => {
    it("reuses the dispatch harness/model/effort/worktree and passes the full context", async () => {
      const codex = new FakeRunner([
        { status: "AWAITING_INPUT", question: "Which table?" },
        { status: "COMPLETED", stdout: "finished" },
      ]);
      const claude = new FakeRunner();
      const { server } = makeServer(repo, { codex, claude });
      // architect defaults to claude; override to codex and make sure the reply follows it.
      const d = json(await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "design the cache", harness_override: "codex" }));
      expect(d.status).toBe("AWAITING_INPUT");
      expect(d.question).toBe("Which table?");

      const r = json(await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "users" }));
      expect(r.status).toBe("COMPLETED");
      expect(claude.calls).toHaveLength(0);
      expect(codex.calls).toHaveLength(2);
      expect(codex.calls[1]).toMatchObject({ model: codex.calls[0].model, effort: codex.calls[0].effort, workdir: codex.calls[0].workdir });
      expect(codex.calls[1].prompt).toContain("design the cache");
      expect(codex.calls[1].prompt).toContain("Which table?");
      expect(codex.calls[1].prompt).toContain("users");

      const records = server.ledger.query();
      expect(records.map((x) => x.event)).toEqual(["reply", "dispatch"]);
      expect(records[0].prompt).toMatchObject({
        reply: "users",
        dialogueHistory: [{ turn: 1, workerStatus: "AWAITING_INPUT", workerQuestion: "Which table?", dispatcherReply: "users" }],
      });
      expect(server.ledger.verifyChain()).toEqual({ ok: true, entries: 2 });

      const again = await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "more" });
      expect(again.content[0].text).toMatch(/already COMPLETED/);
    });

    it("records PERMISSION_GATE and tells the worker a reply does not widen permissions", async () => {
      const claude = new FakeRunner([{ status: "PERMISSION_GATE", permissionDetails: "write to /etc" }, { status: "FAILED", failureReason: "exit code 1", stderr: "no" }]);
      const { server } = makeServer(repo, { claude });
      const d = json(await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "x" }));
      expect(d.status).toBe("PERMISSION_GATE");
      expect(d.permission_details).toBe("write to /etc");
      const r = json(await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "granted" }));
      expect(r.status).toBe("FAILED");
      expect(r.failure_reason).toBe("exit code 1");
      expect(claude.calls[1].prompt).toMatch(/does NOT change your sandbox/);
      expect(server.ledger.query()[0].prompt).toMatchObject({ dialogueHistory: [{ workerStatus: "PERMISSION_GATE", dispatcherReply: "granted" }] });
    });

    it("allows maxDialogueTurns replies, then reports budget exhaustion honestly", async () => {
      // e2ee-reviewer: maxDialogueTurns = 1
      const claude = new FakeRunner([
        { status: "AWAITING_INPUT", question: "q1" },
        { status: "AWAITING_INPUT", question: "q2" },
      ]);
      const { server } = makeServer(repo, { claude });
      const d = json(await server.executeTool("bridge_dispatch_task", { agent_role: "e2ee-reviewer", prompt: "review" }));
      expect(d.status).toBe("AWAITING_INPUT");

      const r1 = json(await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "a1" }));
      expect(r1.status).toBe("CIRCUIT_BREAKER_EXHAUSTED");
      expect(r1.recommendation).toMatch(/has NOT dispatched anything/);
      expect(claude.calls[1].prompt).toContain("q1");

      const r2 = await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "a2" });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toMatch(/Dialogue budget exhausted: 1 of 1 replies used.*NOT dispatched/);
      expect(claude.calls).toHaveLength(2);
    });

    it("includes earlier dialogue on a second reply", async () => {
      const codex = new FakeRunner([
        { status: "AWAITING_INPUT", question: "q1" },
        { status: "AWAITING_INPUT", question: "q2" },
        { status: "COMPLETED" },
      ]);
      const { server } = makeServer(repo, { codex });
      const d = json(await server.executeTool("bridge_dispatch_task", { agent_role: "backend-developer", prompt: "build" }));
      await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "a1" });
      await server.executeTool("bridge_reply", { session_id: String(d.session_id), reply: "a2" });
      expect(codex.calls[2].prompt).toMatch(/Earlier dialogue:[\s\S]*q1[\s\S]*a1[\s\S]*q2[\s\S]*a2/);
    });

    it("rejects unknown sessions", async () => {
      const { server } = makeServer(repo);
      const r = await server.executeTool("bridge_reply", { session_id: "nope", reply: "x" });
      expect(r.content[0].text).toMatch(/not found/);
    });
  });

  it("query and list tools", async () => {
    const { server } = makeServer(repo);
    await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "a" });
    await server.executeTool("bridge_dispatch_task", { agent_role: "architect", prompt: "b" });
    const all = JSON.parse((await server.executeTool("bridge_query_audit_log", {})).content[0].text) as unknown[];
    expect(all).toHaveLength(2);
    const one = JSON.parse((await server.executeTool("bridge_query_audit_log", { limit: 1 })).content[0].text) as unknown[];
    expect(one).toHaveLength(1);
    const verified = JSON.parse((await server.executeTool("bridge_query_audit_log", { verify_chain: true })).content[0].text) as {
      chain: { ok: boolean };
    };
    expect(verified.chain.ok).toBe(true);

    const list = JSON.parse((await server.executeTool("bridge_list_active_worktrees", {})).content[0].text) as Array<{ status: string; sessionId: string }>;
    expect(list).toHaveLength(2);
    expect(server.getSession(list[0].sessionId)?.getStatus()).toBe("COMPLETED");
  });
});
