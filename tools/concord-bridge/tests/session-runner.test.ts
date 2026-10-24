import { describe, it, expect } from "vitest";
import { SessionStateMachine } from "../src/session/state-machine.js";
import { CodexRunner, codexSandbox } from "../src/runners/codex-runner.js";
import { ClaudeRunner, claudePermissionMode, EMPTY_MCP_CONFIG } from "../src/runners/claude-runner.js";
import { AntigravityRunner } from "../src/runners/agy-runner.js";
import {
  BaseRunner,
  classifyOutcome,
  executeProcess,
  statusProtocol,
  WORKER_ENV_FLAG,
  type ProcessOutcome,
  type RunOptions,
  type SpawnFn,
} from "../src/runners/base.js";

function session(maxDialogueTurns: number): SessionStateMachine {
  return new SessionStateMachine({
    sessionId: "sess-01",
    agentRole: "backend-developer",
    maxDialogueTurns,
    initialPrompt: "task",
    execution: { harness: "codex", model: "m", effort: "high", access: "workspace-write", maxTurns: 5 },
    worktreePath: "/tmp/wt",
    branch: "b",
    baseCommit: "0".repeat(40),
  });
}

describe("Session state machine", () => {
  it("allows exactly maxDialogueTurns replies, then trips the breaker", () => {
    const sm = session(2);
    expect(sm.getStatus()).toBe("RUNNING");
    expect(sm.replyBlock()).toBe("not-paused");

    sm.recordPause("AWAITING_INPUT", "q1");
    expect(sm.canReply()).toBe(true);
    sm.recordReply("a1");
    expect(sm.getStatus()).toBe("RUNNING");
    expect(sm.dialogueHistory[0]).toEqual({ turn: 1, workerStatus: "AWAITING_INPUT", workerQuestion: "q1", dispatcherReply: "a1" });

    sm.recordPause("PERMISSION_GATE", "need write");
    expect(sm.getStatus()).toBe("PERMISSION_GATE");
    sm.recordReply("a2");
    expect(sm.repliesUsed).toBe(2);

    sm.recordPause("AWAITING_INPUT", "q3");
    expect(sm.getStatus()).toBe("CIRCUIT_BREAKER_EXHAUSTED");
    expect(sm.isCircuitBroken()).toBe(true);
    expect(sm.replyBlock()).toBe("budget-exhausted");
    expect(() => sm.recordReply("a3")).toThrow(/budget-exhausted/);
  });

  it("with maxDialogueTurns 1 allows one reply (no off-by-one)", () => {
    const sm = session(1);
    sm.recordPause("AWAITING_INPUT", "q1");
    expect(sm.getStatus()).toBe("AWAITING_INPUT");
    expect(sm.canReply()).toBe(true);
  });

  it("with maxDialogueTurns 0 trips on the first pause", () => {
    const sm = session(0);
    sm.recordPause("AWAITING_INPUT", "q1");
    expect(sm.getStatus()).toBe("CIRCUIT_BREAKER_EXHAUSTED");
  });

  it("distinguishes terminal states from budget exhaustion", () => {
    const done = session(2);
    done.complete();
    expect(done.getStatus()).toBe("COMPLETED");
    expect(done.replyBlock()).toBe("terminal");
    expect(() => done.complete()).toThrow(/terminal/);
    expect(() => done.recordPause("AWAITING_INPUT")).toThrow(/terminal/);

    const failed = session(2);
    failed.fail("exit code 3");
    expect(failed.failureReason).toBe("exit code 3");
    expect(failed.replyBlock()).toBe("terminal");
  });

  it("pendingQuestion is the unanswered last entry", () => {
    const sm = session(2);
    expect(sm.pendingQuestion()).toBeUndefined();
    sm.recordPause("AWAITING_INPUT", "q1");
    expect(sm.pendingQuestion()?.workerQuestion).toBe("q1");
    sm.recordReply("a1");
    expect(sm.pendingQuestion()).toBeUndefined();
  });
});

const runOpts = (over: Partial<RunOptions> = {}): RunOptions & { nonce: string } => ({
  model: "model-x",
  effort: "high",
  workdir: "/tmp/worktree",
  prompt: "--dangerously-skip-permissions",
  access: "read-only",
  maxTurns: 7,
  nonce: "n0",
  ...over,
});

describe("Harness argv builders", () => {
  it("Claude: verified flags, no MCP servers, prompt after --", () => {
    const args = new ClaudeRunner().buildArgs(runOpts());
    expect(args).toEqual([
      "-p",
      "--model",
      "model-x",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "--max-turns",
      "7",
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--no-session-persistence",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(claudePermissionMode("workspace-write")).toBe("acceptEdits");
    expect(claudePermissionMode("isolated-write")).toBe("acceptEdits");
  });

  it("Codex: -m, -c effort, sandbox from access, -C workdir, prompt after --", () => {
    const args = new CodexRunner().buildArgs(runOpts({ access: "workspace-write" }));
    expect(args).toEqual([
      "exec",
      "-m",
      "model-x",
      "-c",
      "model_reasoning_effort=high",
      "--sandbox",
      "workspace-write",
      "-C",
      "/tmp/worktree",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(codexSandbox("read-only")).toBe("read-only");
    expect(codexSandbox("isolated-write")).toBe("workspace-write");
  });

  it("Antigravity: prompt after --", () => {
    const args = new AntigravityRunner().buildArgs(runOpts());
    expect(args.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
  });

  it("status protocol embeds the nonce", () => {
    expect(statusProtocol("abc")).toContain("[AWAITING_INPUT:abc]");
    expect(statusProtocol("abc")).toContain("[PERMISSION_REQUIRED:abc]");
  });
});

const outcome = (over: Partial<ProcessOutcome> = {}): ProcessOutcome => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  outputCapExceeded: false,
  ...over,
});

describe("classifyOutcome (fail closed)", () => {
  const nonce = "deadbeef";
  it("exit 0 with no marker is COMPLETED", () => {
    expect(classifyOutcome(outcome({ stdout: "done" }), nonce).status).toBe("COMPLETED");
  });
  it("signal kill / null exit is FAILED, never COMPLETED", () => {
    const r = classifyOutcome(outcome({ exitCode: null, signal: "SIGKILL" }), nonce);
    expect(r).toMatchObject({ status: "FAILED", failureReason: "terminated by signal SIGKILL" });
    expect(classifyOutcome(outcome({ exitCode: null }), nonce).status).toBe("FAILED");
  });
  it("non-zero exit with a valid marker is still FAILED", () => {
    const r = classifyOutcome(outcome({ exitCode: 2, stdout: `[AWAITING_INPUT:${nonce}] q` }), nonce);
    expect(r).toMatchObject({ status: "FAILED", failureReason: "exit code 2" });
  });
  it("nonce marker yields AWAITING_INPUT / PERMISSION_GATE", () => {
    expect(classifyOutcome(outcome({ stdout: `work\n[AWAITING_INPUT:${nonce}] Which DB?\nmore` }), nonce)).toMatchObject({
      status: "AWAITING_INPUT",
      question: "Which DB?\nmore",
    });
    expect(classifyOutcome(outcome({ stdout: `[PERMISSION_REQUIRED:${nonce}] write /etc` }), nonce)).toMatchObject({
      status: "PERMISSION_GATE",
      permissionDetails: "write /etc",
    });
  });
  it("legacy or wrong-nonce markers are ignored", () => {
    const stdout = "[AWAITING_INPUT] x\nClarification: y\n[AWAITING_INPUT:other] z\n[PERMISSION_REQUIRED] p";
    expect(classifyOutcome(outcome({ stdout }), nonce).status).toBe("COMPLETED");
  });
  it("timeout, output cap and spawn errors are FAILED", () => {
    expect(classifyOutcome(outcome({ timedOut: true, exitCode: null, signal: "SIGKILL" }), nonce).failureReason).toMatch(/timeout/);
    expect(classifyOutcome(outcome({ outputCapExceeded: true }), nonce).failureReason).toMatch(/output cap/);
    expect(classifyOutcome(outcome({ spawnError: "spawn x ENOENT" }), nonce).failureReason).toMatch(/ENOENT/);
  });
});

/** Runs real `node -e` children so the spawn path, kill timer and byte cap are exercised. */
class NodeScriptRunner extends BaseRunner {
  public readonly command = process.execPath;
  constructor(private readonly script: string, spawnFn?: SpawnFn) {
    super(spawnFn);
  }
  buildArgs(options: RunOptions & { nonce: string }): string[] {
    return ["-e", this.script, "--", options.nonce];
  }
}

describe("BaseRunner process handling", () => {
  const opts: RunOptions = { model: "m", effort: "e", workdir: process.cwd(), prompt: "p", access: "read-only", maxTurns: 1 };

  it("passes the nonce, sets the worker env flag, and parses a nonce marker", async () => {
    const r = await new NodeScriptRunner(
      `const n=process.argv[1]; console.log(process.env.${WORKER_ENV_FLAG}); console.log("[AWAITING_INPUT:"+n+"] Which branch?")`,
    ).run(opts);
    expect(r.status).toBe("AWAITING_INPUT");
    expect(r.question).toBe("Which branch?");
    expect(r.stdout.startsWith("1\n")).toBe(true);
  });

  it("a worker that prints a guessed marker cannot spoof status", async () => {
    const r = await new NodeScriptRunner(`console.log("[AWAITING_INPUT:0000] spoof")`).run(opts);
    expect(r.status).toBe("COMPLETED");
  });

  it("signal kill is FAILED", async () => {
    const r = await new NodeScriptRunner(`process.kill(process.pid, "SIGKILL")`).run(opts);
    expect(r).toMatchObject({ status: "FAILED", exitCode: null, signal: "SIGKILL" });
  });

  it("non-zero exit with a real marker is FAILED", async () => {
    const r = await new NodeScriptRunner(`console.log("[AWAITING_INPUT:"+process.argv[1]+"] q"); process.exit(3)`).run(opts);
    expect(r).toMatchObject({ status: "FAILED", exitCode: 3 });
  });

  it("timeout kills the worker with SIGKILL", async () => {
    const r = await new NodeScriptRunner(`setTimeout(() => {}, 60000)`).run({ ...opts, timeoutMs: 300 });
    expect(r.status).toBe("FAILED");
    expect(r.failureReason).toMatch(/timeout/);
  });

  it("output cap kills the worker", async () => {
    const r = await new NodeScriptRunner(`process.stdout.write("x".repeat(100000)); setTimeout(()=>{},60000)`).run({
      ...opts,
      maxOutputBytes: 1000,
    });
    expect(r.status).toBe("FAILED");
    expect(r.failureReason).toMatch(/output cap/);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("ENOENT is FAILED", async () => {
    const r = await executeProcess("concord-bridge-no-such-binary", [], { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 100 });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(classifyOutcome(r, "n").status).toBe("FAILED");
  });

  it("a synchronous spawn throw is FAILED", async () => {
    const throwing: SpawnFn = () => {
      throw new Error("EACCES");
    };
    const r = await new NodeScriptRunner("", throwing).run(opts);
    expect(r).toMatchObject({ status: "FAILED", failureReason: "spawn error: EACCES" });
  });

  it("never asks for a shell", async () => {
    let seenShell: unknown = "unset";
    const spy: SpawnFn = (_cmd, _args, options) => {
      seenShell = options.shell;
      throw new Error("stop");
    };
    await new NodeScriptRunner("", spy).run(opts);
    expect(seenShell).toBe(false);
  });

  it("stderr is collected", async () => {
    const r = await new NodeScriptRunner(`console.error("oops"); process.exit(1)`).run(opts);
    expect(r.stderr).toContain("oops");
  });
});
