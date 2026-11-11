import { BaseRunner, type RunOptions, type RunnerResult } from "./base.js";

export const ANTIGRAVITY_READ_ONLY_UNAVAILABLE =
  "Antigravity cannot enforce read-only access; choose Claude or Codex instead.";

/**
 * UNVERIFIED: no `agy` binary or public CLI reference was available, so this
 * keeps the original minimal argv and adds only `--` before the prompt.
 * Read-only runs are refused; write-tier access and `maxTurns` are NOT enforced.
 */
export class AntigravityRunner extends BaseRunner {
  public readonly command = "agy";

  public async run(options: RunOptions): Promise<RunnerResult> {
    if (options.access === "read-only") {
      return { exitCode: null, signal: null, stdout: "", stderr: "", durationMs: 0, status: "FAILED", failureReason: ANTIGRAVITY_READ_ONLY_UNAVAILABLE };
    }
    return super.run(options);
  }

  public buildArgs(options: RunOptions & { nonce: string }): string[] {
    return ["run", "--model", options.model, "--effort", options.effort, "--", options.prompt];
  }
}
