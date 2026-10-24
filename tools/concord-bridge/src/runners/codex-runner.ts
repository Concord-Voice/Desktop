import type { AccessType } from "../config/fleet-matrix.js";
import { BaseRunner, type RunOptions } from "./base.js";

export type { RunnerResult } from "./base.js";

/** Fleet `access` -> `codex exec --sandbox`. Never danger-full-access. */
export function codexSandbox(access: AccessType): "read-only" | "workspace-write" {
  return access === "read-only" ? "read-only" : "workspace-write";
}

/**
 * Codex is not installed where this was written, so these flags come from the
 * upstream CLI source (codex-rs/utils/cli shared_options.rs, exec/cli.rs) and
 * are NOT verified against a live binary: -m/--model, -C/--cd, -c key=value,
 * --sandbox. `codex exec` has no max-turns flag, so maxTurns is not enforced
 * on this harness.
 */
export class CodexRunner extends BaseRunner {
  public readonly command = "codex";

  public buildArgs(options: RunOptions & { nonce: string }): string[] {
    return [
      "exec",
      "-m",
      options.model,
      "-c",
      `model_reasoning_effort=${options.effort}`,
      "--sandbox",
      codexSandbox(options.access),
      "-C",
      options.workdir,
      "--",
      options.prompt,
    ];
  }
}
