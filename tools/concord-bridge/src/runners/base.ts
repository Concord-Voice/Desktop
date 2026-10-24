import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AccessType } from "../config/fleet-matrix.js";

export type RunnerStatus = "COMPLETED" | "AWAITING_INPUT" | "PERMISSION_GATE" | "FAILED";

export interface RunnerResult {
  /** Process exit code; null when the process was killed by a signal or never started. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  status: RunnerStatus;
  /** Why the run is FAILED, when it is. */
  failureReason?: string;
  question?: string;
  permissionDetails?: string;
}

export interface RunOptions {
  model: string;
  effort: string;
  workdir: string;
  prompt: string;
  access: AccessType;
  maxTurns: number;
  /** Per-run nonce for status markers; generated when omitted. */
  nonce?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HarnessRunner {
  readonly command: string;
  buildArgs(options: RunOptions & { nonce: string }): string[];
  run(options: RunOptions): Promise<RunnerResult>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Env var set on every worker so a bridge started inside one refuses to dispatch. */
export const WORKER_ENV_FLAG = "CONCORD_BRIDGE_WORKER";

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Appended to every worker prompt. The nonce is unguessable per run, so text
 * the worker merely echoes from a file, a web page or a test fixture cannot
 * spoof a status marker; only output that knowingly reproduces the nonce can.
 */
export function statusProtocol(nonce: string): string {
  return [
    "",
    "---",
    "Bridge status protocol:",
    `- If you need a clarification before you can continue, print one line starting with [AWAITING_INPUT:${nonce}] followed by your question, then stop.`,
    `- If you need a permission you do not have, print one line starting with [PERMISSION_REQUIRED:${nonce}] followed by what you need and why, then stop.`,
    "- Otherwise finish the task and exit normally.",
  ].join("\n");
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputCapExceeded: boolean;
  spawnError?: string;
}

function findMarker(stdout: string, tag: string, nonce: string): string | undefined {
  const marker = `[${tag}:${nonce}]`;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(marker);
    if (idx !== -1) {
      const rest = [lines[i].slice(idx + marker.length), ...lines.slice(i + 1)].join("\n").trim();
      return rest.slice(0, 4000);
    }
  }
  return undefined;
}

/**
 * Pure status classifier. Order matters and fails closed:
 * spawn error > timeout > output cap > signal/null exit > non-zero exit > markers > COMPLETED.
 * A marker never upgrades a failed process.
 */
export function classifyOutcome(outcome: ProcessOutcome, nonce: string): RunnerResult {
  const base = {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: outcome.durationMs,
  };
  const failed = (failureReason: string): RunnerResult => ({ ...base, status: "FAILED", failureReason });

  if (outcome.spawnError !== undefined) return failed(`spawn error: ${outcome.spawnError}`);
  if (outcome.timedOut) return failed("timeout: worker killed with SIGKILL");
  if (outcome.outputCapExceeded) return failed("output cap exceeded: worker killed with SIGKILL");
  if (outcome.exitCode === null || outcome.signal !== null) {
    return failed(`terminated by signal ${outcome.signal ?? "unknown"}`);
  }
  if (outcome.exitCode !== 0) return failed(`exit code ${outcome.exitCode}`);

  const question = findMarker(outcome.stdout, "AWAITING_INPUT", nonce);
  if (question !== undefined) return { ...base, status: "AWAITING_INPUT", question };
  const permissionDetails = findMarker(outcome.stdout, "PERMISSION_REQUIRED", nonce);
  if (permissionDetails !== undefined) return { ...base, status: "PERMISSION_GATE", permissionDetails };
  return { ...base, status: "COMPLETED" };
}

export interface ExecuteOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

/** Spawn without a shell, enforce a kill timer and a byte cap, and collect the outcome. */
export function executeProcess(command: string, args: string[], options: ExecuteOptions): Promise<ProcessOutcome> {
  const start = Date.now();
  const spawnFn = options.spawnFn ?? nodeSpawn;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let outputCapExceeded = false;
    let settled = false;

    const finish = (partial: Partial<ProcessOutcome>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
        outputCapExceeded,
        ...partial,
      });
    };

    let proc: ChildProcess;
    try {
      proc = spawnFn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(options.env ?? process.env), [WORKER_ENV_FLAG]: "1" },
      });
    } catch (err) {
      settled = true;
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
        timedOut: false,
        outputCapExceeded: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, options.timeoutMs);

    const onData = (target: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = chunk.toString();
      bytes += Buffer.byteLength(text);
      if (bytes > options.maxOutputBytes) {
        if (!outputCapExceeded) {
          outputCapExceeded = true;
          proc.kill("SIGKILL");
        }
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };
    proc.stdout?.on("data", onData("stdout"));
    proc.stderr?.on("data", onData("stderr"));

    proc.on("error", (err) => finish({ spawnError: err.message }));
    proc.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

export abstract class BaseRunner implements HarnessRunner {
  public abstract readonly command: string;
  public abstract buildArgs(options: RunOptions & { nonce: string }): string[];

  constructor(private readonly spawnFn?: SpawnFn) {}

  public async run(options: RunOptions): Promise<RunnerResult> {
    const nonce = options.nonce ?? newNonce();
    const args = this.buildArgs({ ...options, nonce, prompt: options.prompt + statusProtocol(nonce) });
    const outcome = await executeProcess(this.command, args, {
      cwd: options.workdir,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      spawnFn: this.spawnFn,
    });
    return classifyOutcome(outcome, nonce);
  }
}
