import { z } from "zod";

export const AGENT_ROLES = [
  "architect",
  "system-engineer",
  "platform-engineer",
  "network-engineer",
  "frontend-designer",
  "ui-designer",
  "ux-designer",
  "backend-developer",
  "frontend-developer",
  "devops-engineer",
  "database-migration",
  "senior-engineer",
  "e2ee-reviewer",
  "rbac-reviewer",
  "red-team",
  "red-team-critical",
  "code-reviewer",
  "scope-reviewer",
  "test-reviewer",
  "frontend-reviewer",
  "migration-reviewer",
  "socket-io-reviewer",
  "deployment-config-reviewer",
  "test-writer",
  "researcher",
  "docs-reviewer",
  "docs-writer",
] as const;

export type ConcordAgentRole = (typeof AGENT_ROLES)[number];

/** Strict schema for a role name, as stored in the fleet matrix (no leading "@"). */
export const AgentRoleSchema = z.enum(AGENT_ROLES);

export type HarnessType = "claude" | "codex" | "antigravity";
export type AccessType = "read-only" | "workspace-write" | "isolated-write";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AntigravityEffort = "low" | "medium" | "high";

export interface AgentConfig {
  role: ConcordAgentRole;
  sovereignOwner: string;
  defaultHarness: HarnessType;
  access: AccessType;
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  codexModel: string | null;
  codexEffort: CodexEffort | null;
  agyModel: string | null;
  agyEffort: AntigravityEffort | null;
  maxTurns: number;
  maxDialogueTurns: number;
}

type FleetRow = [
  role: ConcordAgentRole,
  sovereignOwner: string,
  defaultHarness: HarnessType,
  access: AccessType,
  claudeModel: string,
  claudeEffort: ClaudeEffort,
  codexModel: string | null,
  codexEffort: CodexEffort | null,
  agyModel: string | null,
  agyEffort: AntigravityEffort | null,
  maxTurns: number,
  maxDialogueTurns: number,
];

// One row per agent, columns in AgentConfig order. A table rather than 28
// near-identical object literals so a pin change is a one-cell diff.
const FLEET_ROWS: readonly FleetRow[] = [
  ["architect", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 40, 2],
  ["system-engineer", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 30, 2],
  ["platform-engineer", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 30, 2],
  ["network-engineer", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 30, 2],
  ["frontend-designer", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 30, 2],
  ["ui-designer", "Claude Sonnet", "claude", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 25, 2],
  ["ux-designer", "Claude Sonnet", "claude", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 25, 2],
  ["backend-developer", "gpt-6.1-sol", "codex", "workspace-write", "sonnet", "xhigh", "gpt-6.1-sol", "high", "gemini-3.8-flash", "high", 45, 3],
  ["frontend-developer", "gpt-6.1-sol", "codex", "workspace-write", "sonnet", "xhigh", "gpt-6.1-sol", "high", "gemini-3.8-flash", "high", 45, 3],
  ["devops-engineer", "gpt-6.1-sol", "codex", "workspace-write", "sonnet", "xhigh", "gpt-6.1-sol", "high", "gemini-3.8-flash", "high", 40, 3],
  ["database-migration", "gpt-6.1-sol", "codex", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 20, 2],
  ["senior-engineer", "Claude Opus", "claude", "workspace-write", "opus", "xhigh", "gpt-6-astra", "high", "gemini-3.8-flash", "high", 50, 3],
  ["e2ee-reviewer", "Claude Opus", "claude", "read-only", "opus", "high", "gpt-6-sol", "medium", null, null, 25, 1],
  ["rbac-reviewer", "Claude Opus", "claude", "read-only", "opus", "high", "gpt-6-sol", "medium", null, null, 25, 1],
  ["red-team", "gpt-6-sol", "codex", "isolated-write", "opus", "max", "gpt-6-sol", "xhigh", null, null, 40, 2],
  ["red-team-critical", "Claude Mythos 5.1", "claude", "isolated-write", "claude-mythos-5-1", "max", null, null, null, null, 40, 2],
  ["code-reviewer", "Claude Opus", "claude", "read-only", "opus", "high", "gpt-6-astra", "medium", "gemini-3.8-flash", "medium", 30, 1],
  ["scope-reviewer", "Antigravity", "antigravity", "read-only", "sonnet", "medium", "gpt-6.1-sol", "low", "gemini-3.8-flash", "low", 20, 1],
  ["test-reviewer", "Antigravity", "antigravity", "read-only", "sonnet", "medium", "gpt-6.1-sol", "low", "gemini-3.8-flash", "low", 15, 1],
  ["frontend-reviewer", "Claude Sonnet", "claude", "read-only", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 20, 1],
  ["migration-reviewer", "Claude Sonnet", "claude", "read-only", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 20, 1],
  ["socket-io-reviewer", "Claude Sonnet", "claude", "read-only", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 20, 1],
  ["deployment-config-reviewer", "Claude Sonnet", "claude", "read-only", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 20, 1],
  ["test-writer", "gpt-6.1-sol", "codex", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 25, 2],
  ["researcher", "Antigravity", "antigravity", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "high", 30, 2],
  ["docs-reviewer", "Antigravity", "antigravity", "read-only", "sonnet", "medium", "gpt-6.1-sol", "low", "gemini-3.8-flash", "low", 15, 1],
  ["docs-writer", "Claude Sonnet", "claude", "workspace-write", "sonnet", "high", "gpt-6.1-sol", "medium", "gemini-3.8-flash", "medium", 25, 2],
];

export const FLEET_MATRIX = Object.fromEntries(
  FLEET_ROWS.map(
    ([role, sovereignOwner, defaultHarness, access, claudeModel, claudeEffort, codexModel, codexEffort, agyModel, agyEffort, maxTurns, maxDialogueTurns]) => [
      role,
      { role, sovereignOwner, defaultHarness, access, claudeModel, claudeEffort, codexModel, codexEffort, agyModel, agyEffort, maxTurns, maxDialogueTurns },
    ],
  ),
) as Record<ConcordAgentRole, AgentConfig>;

/**
 * Normalize a caller-supplied role name: strip ONE leading "@" and require an
 * exact match against the known role list. Returns null for anything else,
 * including prototype keys such as "constructor" or "__proto__".
 */
export function normalizeRole(raw: string): ConcordAgentRole | null {
  const candidate = raw.startsWith("@") ? raw.slice(1) : raw;
  const parsed = AgentRoleSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function getAgentConfig(role: string): AgentConfig {
  const normalized = normalizeRole(role);
  if (normalized === null || !Object.hasOwn(FLEET_MATRIX, normalized)) {
    throw new Error(`Unknown agent role: ${role}`);
  }
  return FLEET_MATRIX[normalized];
}
