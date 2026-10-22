import path from "node:path";

/**
 * Activation gate for `red-team-critical` (RC-1..RC-4).
 *
 * RC-1..RC-3 are automatic and are computed from concrete inputs only:
 *  - RC-1 / RC-2: repository-relative paths, taken from `context_files` that
 *    exist in the repo and from the paths a requested branch changes. No
 *    prompt text is ever inspected.
 *  - RC-3: a reference to a prior audit-ledger entry written by this bridge
 *    for `red-team` whose output reports a CRITICAL or HIGH finding (P0/P1).
 *
 * RC-4 is a human override, asked through MCP elicitation only when RC-1..RC-3
 * do not admit the dispatch. If the client cannot elicit, or the human does
 * not explicitly approve, the dispatch is refused (fail closed).
 */

export type Criterion = "RC-1" | "RC-2" | "RC-3" | "RC-4";

/** RC-1: core cryptography surfaces (mirrors internal-reference). */
export const RC1_PREFIXES = [
  "client/desktop/src/renderer/services/e2ee/",
  "client/desktop/src/renderer/utils/crypto/",
  ...["auth", "mfa", "oauth", "stepup", "devicerecovery", "authority", "authoritycontract", "keyrotation", "age"].map(
    (pkg) => `services/control-plane/internal/${pkg}/`,
  ),
];

/** RC-2: root authority and key custody (#2553, #2627). */
export const RC2_PREFIXES = [
  "client/desktop/src/main/secureStorage.ts",
  "services/control-plane/internal/credepoch/",
  "services/control-plane/internal/devicerecovery/",
  "services/control-plane/internal/authority/",
  "services/control-plane/internal/keyrotation/",
];

export const RC3_SOURCE_ROLES = ["red-team"] as const;

/** Normalize to a repo-relative POSIX path; null when it escapes the repo or is absolute. */
export function normalizeRepoPath(p: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  const posix = p.replaceAll("\\", "/");
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:/.test(posix)) return null;
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function matches(prefixes: readonly string[], p: string): boolean {
  return prefixes.some((prefix) => (prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix));
}

export interface PathCriteria {
  criterion: "RC-1" | "RC-2";
  matchedPath: string;
}

export function evaluatePathCriteria(paths: readonly string[]): PathCriteria | null {
  const normalized = paths.map(normalizeRepoPath).filter((p): p is string => p !== null);
  const rc1 = normalized.find((p) => matches(RC1_PREFIXES, p));
  if (rc1) return { criterion: "RC-1", matchedPath: rc1 };
  const rc2 = normalized.find((p) => matches(RC2_PREFIXES, p));
  if (rc2) return { criterion: "RC-2", matchedPath: rc2 };
  return null;
}

export interface EscalationEvidence {
  agentRole: string;
  outputSummary: string;
}

export function evaluateEscalation(evidence: EscalationEvidence | null): boolean {
  if (!evidence) return false;
  if (!(RC3_SOURCE_ROLES as readonly string[]).includes(evidence.agentRole)) return false;
  // Case-sensitive: red-team reports severities as CRITICAL / HIGH / MEDIUM.
  return /\b(P0|P1|CRITICAL|HIGH)\b/.test(evidence.outputSummary);
}

export type ElicitOutcome = "approved" | "declined" | "unsupported";

/** Asks the human a yes/no question. Must resolve "unsupported" when the client cannot elicit. */
export type Elicitor = (message: string) => Promise<ElicitOutcome>;

export interface GateDecision {
  admitted: boolean;
  criterion?: Criterion;
  detail: string;
}

export interface GateInputs {
  paths: readonly string[];
  escalation: EscalationEvidence | null;
  elicit: Elicitor;
  describeDispatch: string;
}

export async function evaluateActivationGate(inputs: GateInputs): Promise<GateDecision> {
  const pathHit = evaluatePathCriteria(inputs.paths);
  if (pathHit) {
    return { admitted: true, criterion: pathHit.criterion, detail: `path ${pathHit.matchedPath}` };
  }
  if (evaluateEscalation(inputs.escalation)) {
    return { admitted: true, criterion: "RC-3", detail: `escalation from @${inputs.escalation?.agentRole ?? "?"}` };
  }
  let outcome: ElicitOutcome;
  try {
    outcome = await inputs.elicit(
      `RC-1..RC-3 are not met. Approve a red-team-critical dispatch as a human override (RC-4)?\n\n${inputs.describeDispatch}`,
    );
  } catch {
    outcome = "unsupported";
  }
  if (outcome === "approved") {
    return { admitted: true, criterion: "RC-4", detail: "RC-4 human override via elicitation" };
  }
  return {
    admitted: false,
    detail:
      outcome === "unsupported"
        ? "RC-1..RC-3 not met and the MCP client does not support elicitation, so no RC-4 human override is possible"
        : "RC-1..RC-3 not met and the human declined the RC-4 override",
  };
}
