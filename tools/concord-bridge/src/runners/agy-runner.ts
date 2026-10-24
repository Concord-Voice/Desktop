import { BaseRunner, type RunOptions } from "./base.js";

/**
 * UNVERIFIED: no `agy` binary or public CLI reference was available, so this
 * keeps the original minimal argv and adds only `--` before the prompt.
 * `access` and `maxTurns` are NOT enforced on this harness.
 */
export class AntigravityRunner extends BaseRunner {
  public readonly command = "agy";

  public buildArgs(options: RunOptions & { nonce: string }): string[] {
    return ["run", "--model", options.model, "--effort", options.effort, "--", options.prompt];
  }
}
