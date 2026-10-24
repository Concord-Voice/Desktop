import { describe, it, expect, vi } from "vitest";
import {
  evaluateActivationGate,
  evaluateEscalation,
  evaluatePathCriteria,
  normalizeRepoPath,
} from "../src/gate/activation.js";

describe("normalizeRepoPath", () => {
  it("normalizes relative paths and rejects escapes and absolute paths", () => {
    expect(normalizeRepoPath("a/./b/../c.ts")).toBe("a/c.ts");
    expect(normalizeRepoPath("a\\b.ts")).toBe("a/b.ts");
    expect(normalizeRepoPath("../etc/passwd")).toBeNull();
    expect(normalizeRepoPath("a/../../x")).toBeNull();
    expect(normalizeRepoPath("/etc/passwd")).toBeNull();
    expect(normalizeRepoPath("C:/x")).toBeNull();
    expect(normalizeRepoPath("")).toBeNull();
    expect(normalizeRepoPath(".")).toBeNull();
    expect(normalizeRepoPath("a\0b")).toBeNull();
  });
});

describe("path criteria", () => {
  it("admits RC-1 on core crypto paths", () => {
    expect(evaluatePathCriteria(["desktop/src/renderer/services/e2ee/epoch.ts"])).toEqual({
      criterion: "RC-1",
      matchedPath: "desktop/src/renderer/services/e2ee/epoch.ts",
    });
    expect(evaluatePathCriteria(["services/control-plane/internal/mfa/totp.go"])?.criterion).toBe("RC-1");
  });

  it("admits RC-2 on key custody paths", () => {
    expect(evaluatePathCriteria(["desktop/src/main/secureStorage.ts"])?.criterion).toBe("RC-2");
    expect(evaluatePathCriteria(["services/control-plane/internal/credepoch/x.go"])?.criterion).toBe("RC-2");
  });

  it("does not match on keywords, traversal or near-miss prefixes", () => {
    expect(evaluatePathCriteria(["docs/epoch-argon2id-rsa-oaep.md", "README.md"])).toBeNull();
    expect(evaluatePathCriteria(["../desktop/src/renderer/services/e2ee/x.ts"])).toBeNull();
    expect(evaluatePathCriteria(["desktop/src/renderer/services/e2eeX/x.ts"])).toBeNull();
    expect(evaluatePathCriteria(["desktop/src/main/secureStorage.ts.bak"])).toBeNull();
  });
});

describe("escalation criterion (RC-3)", () => {
  it("requires a red-team record that reports a CRITICAL or HIGH finding", () => {
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "Found P0: token reuse" })).toBe(true);
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "P1 only" })).toBe(true);
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "PROVEN — HIGH, CWE-287" })).toBe(true);
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "CRITICAL" })).toBe(true);
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "MEDIUM, P2" })).toBe(false);
    expect(evaluateEscalation({ agentRole: "red-team", outputSummary: "ran at high effort" })).toBe(false);
    expect(evaluateEscalation({ agentRole: "security-reviewer", outputSummary: "P0" })).toBe(false);
    expect(evaluateEscalation({ agentRole: "code-reviewer", outputSummary: "P0" })).toBe(false);
    expect(evaluateEscalation(null)).toBe(false);
  });
});

describe("evaluateActivationGate", () => {
  const base = { paths: [], escalation: null, describeDispatch: "x" };

  it("admits on RC-1 without asking the human", async () => {
    const elicit = vi.fn();
    const decision = await evaluateActivationGate({
      ...base,
      paths: ["desktop/src/renderer/utils/crypto/aes.ts"],
      elicit,
    });
    expect(decision).toMatchObject({ admitted: true, criterion: "RC-1" });
    expect(elicit).not.toHaveBeenCalled();
  });

  it("admits on RC-3 escalation", async () => {
    const decision = await evaluateActivationGate({
      ...base,
      escalation: { agentRole: "red-team", outputSummary: "P0 open" },
      elicit: vi.fn(),
    });
    expect(decision).toMatchObject({ admitted: true, criterion: "RC-3" });
  });

  it("admits RC-4 only when the human approves through elicitation", async () => {
    const decision = await evaluateActivationGate({ ...base, elicit: async () => "approved" });
    expect(decision).toEqual({ admitted: true, criterion: "RC-4", detail: "RC-4 human override via elicitation" });
  });

  it("refuses when the human declines", async () => {
    const decision = await evaluateActivationGate({ ...base, elicit: async () => "declined" });
    expect(decision.admitted).toBe(false);
    expect(decision.detail).toMatch(/declined/);
  });

  it("refuses when elicitation is unsupported or throws", async () => {
    expect((await evaluateActivationGate({ ...base, elicit: async () => "unsupported" })).detail).toMatch(
      /does not support elicitation/,
    );
    const thrown = await evaluateActivationGate({
      ...base,
      elicit: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.admitted).toBe(false);
  });
});
