import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AuditLedger, GENESIS_HASH, redactSecrets, type AuditEntryInput } from "../src/audit/ledger.js";
import {
  isStrictlyInside,
  validateBranchNameSyntax,
  validateSessionId,
  WorktreeManager,
} from "../src/worktree/manager.js";
import { gitOut, makeTmpRepo, removeTmp } from "./helpers.js";

function entry(taskId: string, over: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    taskId,
    event: "dispatch",
    initiator: { harness: "test-client", repliesUsed: 0, maxDialogueTurns: 3 },
    execution: {
      agentRole: "backend-developer",
      sovereignOwner: "gpt-6.1-sol",
      harnessUsed: "codex",
      modelResolved: "gpt-6.1-sol",
      effortPinned: "high",
      access: "workspace-write",
      durationMs: 1200,
      exitCode: 0,
      status: "COMPLETED",
    },
    worktree: { branch: "feature/x", path: "/tmp/wt", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) },
    prompt: { initialPrompt: "Implement heartbeat", contextFiles: ["docs/x.md"], dialogueHistory: [] },
    results: { outputSummary: "ok" },
    ...over,
  };
}

describe("Audit ledger", () => {
  let dir: string;
  let ledger: AuditLedger;
  beforeEach(() => {
    dir = makeTmpRepo();
    ledger = new AuditLedger(path.join(dir, ".agent-bus", "audit"));
  });
  afterEach(() => removeTmp(dir));

  it("appends hash-chained records with mode 0600 and verifies the chain", async () => {
    const first = await ledger.writeEntry(entry("t1"));
    const second = await ledger.writeEntry(entry("t2"));
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.prev_hash).toBe(first.hash);
    expect(fs.statSync(ledger.ledgerPath).mode & 0o777).toBe(0o600);
    expect(ledger.verifyChain()).toEqual({ ok: true, entries: 2 });
    expect(new AuditLedger(path.join(dir, "nothing-here")).verifyChain()).toEqual({ ok: true, entries: 0 });
  });

  it("detects an edited, deleted or corrupt line", async () => {
    await ledger.writeEntry(entry("t1"));
    await ledger.writeEntry(entry("t2"));
    await ledger.writeEntry(entry("t3"));
    const lines = fs.readFileSync(ledger.ledgerPath, "utf-8").trim().split("\n");

    fs.writeFileSync(ledger.ledgerPath, [lines[0], lines[1].replace("Implement heartbeat", "Something else"), lines[2]].join("\n") + "\n");
    expect(ledger.verifyChain()).toMatchObject({ ok: false, brokenAtLine: 2, reason: "hash mismatch" });

    fs.writeFileSync(ledger.ledgerPath, [lines[0], lines[2]].join("\n") + "\n");
    expect(ledger.verifyChain()).toMatchObject({ ok: false, brokenAtLine: 2, reason: "prev_hash does not match previous record" });

    fs.writeFileSync(ledger.ledgerPath, [lines[0], "{not json", lines[1]].join("\n") + "\n");
    expect(ledger.verifyChain()).toMatchObject({ ok: false, brokenAtLine: 2, reason: "unparseable line" });

    fs.writeFileSync(ledger.ledgerPath, [lines[0], "[1,2]"].join("\n") + "\n");
    expect(ledger.verifyChain()).toMatchObject({ ok: false, reason: "not an object" });
  });

  it("redacts secrets before writing", async () => {
    const secret = "ghp_" + "A".repeat(36);
    await ledger.writeEntry(
      entry("t1", {
        prompt: { initialPrompt: `use token ${secret} and password=hunter2`, dialogueHistory: [] },
        results: { outputSummary: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----" },
      }),
    );
    const raw = fs.readFileSync(ledger.ledgerPath, "utf-8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("MIIE");
    expect(raw).toContain("[REDACTED:github-token]");
  });

  it("redactSecrets covers the common token shapes and truncates huge fields", () => {
    const samples = [
      "sk-ant-" + "a".repeat(30),
      "sk-proj-" + "b".repeat(30),
      "sk_live_" + "c".repeat(20),
      "github_pat_" + "d".repeat(30),
      "AKIA" + "E".repeat(16),
      "xoxb-" + "1".repeat(20),
      "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl",
      'api_key: "abc123"',
    ];
    for (const s of samples) expect(redactSecrets(`x ${s} y`)).toContain("[REDACTED");
    expect(redactSecrets("plain text")).toBe("plain text");
    expect(redactSecrets("z".repeat(20000)).endsWith("[truncated]")).toBe(true);
  });

  it("query is newest-first, filters by task id, clamps limit, and skips corrupt lines", async () => {
    for (let i = 0; i < 5; i++) await ledger.writeEntry(entry(`t${i}`));
    fs.appendFileSync(ledger.ledgerPath, "{corrupt\n[]\n{\"no_task\":1}\n");
    expect(ledger.query().map((r) => r.task_id)).toEqual(["t4", "t3", "t2", "t1", "t0"]);
    expect(ledger.query({ limit: 2 }).map((r) => r.task_id)).toEqual(["t4", "t3"]);
    expect(ledger.query({ limit: -5 })).toHaveLength(1);
    expect(ledger.query({ limit: 10_000 })).toHaveLength(5);
    expect(ledger.query({ taskId: "t2" }).map((r) => r.task_id)).toEqual(["t2"]);
    // Writing after a corrupt tail still chains to the last valid record.
    const next = await ledger.writeEntry(entry("t5"));
    expect(next.prev_hash).toBe(ledger.query({ taskId: "t4" })[0].hash);
  });
});

describe("Branch and path validation", () => {
  it("rejects traversal, shell syntax, option injection and git-invalid names", () => {
    const bad = [
      "..",
      "a/../b",
      "a..b",
      "$(touch pwned)",
      'x"; touch pwned; "',
      "x`id`",
      "-b",
      "--force",
      "-",
      "/abs",
      "a/",
      "a.lock",
      "a//b",
      "a/.hidden",
      ".hidden",
      "a.",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a\\b",
      "x".repeat(101),
      "",
    ];
    for (const b of bad) expect(() => validateBranchNameSyntax(b), b).toThrow();
    for (const good of ["feature/x", "fix/a-b_c.d", "bridge/dispatch_123", "a"]) expect(() => validateBranchNameSyntax(good)).not.toThrow();
  });

  it("validates session ids and strict containment", () => {
    expect(() => validateSessionId("dispatch_ab-12")).not.toThrow();
    for (const s of ["..", "a/b", "", "a b"]) expect(() => validateSessionId(s)).toThrow();
    expect(isStrictlyInside("/a/b", "/a/b/c")).toBe(true);
    expect(isStrictlyInside("/a/b", "/a/b")).toBe(false);
    expect(isStrictlyInside("/a/b", "/a")).toBe(false);
    expect(isStrictlyInside("/a/b", "/a/bc")).toBe(false);
  });
});

describe("Worktree manager (tmp git repo)", () => {
  let repo: string;
  let manager: WorktreeManager;
  beforeEach(() => {
    repo = makeTmpRepo();
    manager = new WorktreeManager(repo);
  });
  afterEach(() => removeTmp(repo));

  it("provisions a per-session worktree on a new branch and removes it", async () => {
    const wt = await manager.createWorktree({ sessionId: "s1", branch: "feature/a" });
    expect(wt.path).toBe(path.join(repo, ".worktrees", "s1"));
    expect(fs.existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(wt.baseCommit).toBe(gitOut(repo, "rev-parse", "HEAD"));
    expect(await WorktreeManager.isBridgeWorkerCheckout(wt.path)).toBe(true);
    expect(await WorktreeManager.isBridgeWorkerCheckout(repo)).toBe(false);
    await wt.cleanUp();
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await WorktreeManager.isBridgeWorkerCheckout(repo)).toBe(false);
  });

  it("checks out an existing branch and reports its changed paths", async () => {
    gitOut(repo, "branch", "existing");
    const wt = await manager.createWorktree({ sessionId: "s2", branch: "existing" });
    fs.mkdirSync(path.join(wt.path, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt.path, "src", "x.ts"), "x\n");
    gitOut(wt.path, "add", ".");
    gitOut(wt.path, "-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "-m", "x");
    expect(await manager.changedPaths("existing", "main")).toEqual(["src/x.ts"]);
    expect(await manager.revParse("existing")).toBe(gitOut(repo, "rev-parse", "existing"));
  });

  it("'..' as a branch never touches the repository", async () => {
    await expect(manager.createWorktree({ sessionId: "s3", branch: ".." })).rejects.toThrow(/Invalid branch/);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".git"))).toBe(true);
  });

  it("an injection payload in the branch does not execute", async () => {
    const marker = path.join(repo, "pwned");
    for (const branch of [`x$(touch ${marker})`, `x"; touch ${marker}; "`, `x\`touch ${marker}\``]) {
      await expect(manager.createWorktree({ sessionId: "s4", branch })).rejects.toThrow();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("names that pass the allowlist still go through git check-ref-format", async () => {
    await expect(manager.validateBranch("feature/ok")).resolves.toBeUndefined();
    await expect(manager.validateBranch("a.lock/b")).rejects.toThrow(/check-ref-format/);
  });

  it("refuses an existing target instead of cleaning it, and keeps colliding names apart", async () => {
    const a = await manager.createWorktree({ sessionId: "sa", branch: "a/b" });
    const b = await manager.createWorktree({ sessionId: "sb", branch: "a-b" });
    expect(a.path).not.toBe(b.path);
    fs.writeFileSync(path.join(a.path, "keep.txt"), "mine");
    await expect(manager.createWorktree({ sessionId: "sa", branch: "c" })).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(a.path, "keep.txt"), "utf-8")).toBe("mine");
  });

  it("refuses to remove anything outside the worktrees root, with no rm fallback", async () => {
    await expect(manager.cleanupWorktree(repo)).rejects.toThrow(/outside the worktrees root/);
    await expect(manager.cleanupWorktree(path.join(repo, ".worktrees"))).rejects.toThrow(/outside/);
    const stray = path.join(repo, ".worktrees", "stray");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "f"), "x");
    await expect(manager.cleanupWorktree(stray)).rejects.toThrow();
    expect(fs.existsSync(path.join(stray, "f"))).toBe(true);
  });

  it("rejects bad refs and session ids", async () => {
    await expect(manager.revParse("--all")).rejects.toThrow();
    expect(() => manager.targetPathFor("../x")).toThrow(/session id/);
    await expect(manager.branchExists("..")).rejects.toThrow();
    await expect(manager.changedPaths("ok", "-x")).rejects.toThrow();
    await expect(WorktreeManager.isBridgeWorkerCheckout(path.join(repo, "missing"))).resolves.toBe(false);
  });
});
