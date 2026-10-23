import { describe, it, expect } from "vitest";
import { AGENT_ROLES, FLEET_MATRIX, getAgentConfig, normalizeRole } from "../src/config/fleet-matrix.js";

describe("Fleet Matrix Configuration", () => {
  it("resolves backend-developer to gpt-6.1-sol with effort high on codex", () => {
    const config = getAgentConfig("backend-developer");
    expect(config.sovereignOwner).toBe("gpt-6.1-sol");
    expect(config.defaultHarness).toBe("codex");
    expect(config.codexModel).toBe("gpt-6.1-sol");
    expect(config.codexEffort).toBe("high");
    expect(config.maxDialogueTurns).toBe(3);
  });

  it("resolves red-team to gpt-6-sol on codex", () => {
    const config = getAgentConfig("red-team");
    expect(config.codexModel).toBe("gpt-6-sol");
    expect(config.codexEffort).toBe("xhigh");
    expect(config.maxDialogueTurns).toBe(2);
  });

  it("resolves red-team-critical to Mythos on claude with max effort and no codex profile", () => {
    const config = getAgentConfig("@red-team-critical");
    expect(config.defaultHarness).toBe("claude");
    expect(config.claudeModel).toBe("claude-mythos-5-1");
    expect(config.claudeEffort).toBe("max");
    expect(config.codexModel).toBeNull();
  });

  it("has exactly one matrix entry per declared role, keyed by its own role", () => {
    expect(Object.keys(FLEET_MATRIX).sort()).toEqual([...AGENT_ROLES].sort());
    for (const role of AGENT_ROLES) expect(FLEET_MATRIX[role].role).toBe(role);
  });

  it("normalizes one leading @ and rejects unknown and prototype keys", () => {
    expect(normalizeRole("@architect")).toBe("architect");
    expect(normalizeRole("architect")).toBe("architect");
    expect(normalizeRole("@@architect")).toBeNull();
    for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "Architect"]) {
      expect(normalizeRole(bad)).toBeNull();
      expect(() => getAgentConfig(bad)).toThrow(/Unknown agent role/);
    }
  });
});
