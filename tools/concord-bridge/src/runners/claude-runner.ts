import type { AccessType } from "../config/fleet-matrix.js";
import { BaseRunner, type RunOptions } from "./base.js";

/** Empty MCP config: with --strict-mcp-config the worker loads no MCP servers, so it cannot reach this bridge. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * Fleet `access` -> Claude Code `--permission-mode`.
 * read-only uses plan mode (no edits, no command execution); the write tiers
 * auto-accept file edits inside the worker's worktree only.
 */
export function claudePermissionMode(access: AccessType): string {
  return access === "read-only" ? "plan" : "acceptEdits";
}

/**
 * Flags verified against `claude --help` (Claude Code 2.1.307): -p, --model,
 * --effort, --permission-mode, --strict-mcp-config, --mcp-config,
 * --no-session-persistence. --max-turns is accepted by the parser but is not
 * listed in --help.
 */
export class ClaudeRunner extends BaseRunner {
  public readonly command = "claude";

  public buildArgs(options: RunOptions & { nonce: string }): string[] {
    return [
      "-p",
      "--model",
      options.model,
      "--effort",
      options.effort,
      "--permission-mode",
      claudePermissionMode(options.access),
      "--max-turns",
      String(options.maxTurns),
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--no-session-persistence",
      "--",
      options.prompt,
    ];
  }
}
