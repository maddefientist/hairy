import { describe, expect, it } from "vitest";
import {
  CHILD_PROFILE,
  DEFAULT_CHILD_DENY_LIST,
  PRIMARY_OPERATOR_PROFILE,
  buildChildProfile,
  canonicalizeToolName,
  primaryOperatorProfile,
  resolveConfiguredToolNames,
} from "../src/tool-profiles.js";

const ALL_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "web-search",
  "web-fetch",
  "browser",
  "reminder",
  "ssh_exec",
  "memory_recall",
  "memory_ingest",
  "identity_evolve",
  "spawn_agent",
  "delegate",
  "run_chain",
];

describe("primaryOperatorProfile", () => {
  it("includes every registered tool — the trusted primary operator shell boundary", () => {
    const profile = primaryOperatorProfile(ALL_TOOLS);
    expect(profile.name).toBe(PRIMARY_OPERATOR_PROFILE);
    expect(profile.allowedTools).toEqual(ALL_TOOLS);
  });
});

describe("buildChildProfile", () => {
  it("removes bash, ssh_exec, browser, identity_evolve, delegate, spawn_agent, run_chain by default", () => {
    const profile = buildChildProfile(ALL_TOOLS);
    expect(profile.name).toBe(CHILD_PROFILE);
    for (const denied of DEFAULT_CHILD_DENY_LIST) {
      expect(profile.allowedTools).not.toContain(denied);
    }
  });

  it("keeps benign tools available to children", () => {
    const profile = buildChildProfile(ALL_TOOLS);
    expect(profile.allowedTools).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "web-search",
        "web-fetch",
        "reminder",
        "memory_recall",
        "memory_ingest",
      ]),
    );
  });

  it("is strictly narrower than the primary operator profile", () => {
    const primary = primaryOperatorProfile(ALL_TOOLS);
    const child = buildChildProfile(ALL_TOOLS);
    expect(child.allowedTools.length).toBeLessThan(primary.allowedTools.length);
    for (const name of child.allowedTools) {
      expect(primary.allowedTools).toContain(name);
    }
  });

  it("supports additional deployment-specific denials", () => {
    const profile = buildChildProfile(ALL_TOOLS, ["memory_ingest"]);
    expect(profile.allowedTools).not.toContain("memory_ingest");
    expect(profile.allowedTools).not.toContain("bash");
  });

  it("never grants a tool that is not in the full registry list", () => {
    const profile = buildChildProfile(["read", "write"]);
    expect(profile.allowedTools).toEqual(["read", "write"]);
  });
});

describe("canonicalizeToolName", () => {
  it("maps legacy underscore web tool spellings to the registered hyphenated names", () => {
    expect(canonicalizeToolName("web_search")).toBe("web-search");
    expect(canonicalizeToolName("web_fetch")).toBe("web-fetch");
  });

  it("passes through already-canonical and unrelated names unchanged", () => {
    expect(canonicalizeToolName("web-search")).toBe("web-search");
    expect(canonicalizeToolName("bash")).toBe("bash");
  });
});

describe("resolveConfiguredToolNames", () => {
  const REGISTERED = ["bash", "read", "write", "edit", "web-search", "web-fetch", "delegate"];

  it("passes through configured names that already match registered tools", () => {
    expect(resolveConfiguredToolNames(["bash", "read"], REGISTERED)).toEqual(["bash", "read"]);
  });

  it("canonicalizes legacy web_search/web_fetch config spellings to the registered tools", () => {
    const resolved = resolveConfiguredToolNames(
      ["bash", "read", "write", "edit", "web_search", "web_fetch"],
      REGISTERED,
    );
    expect(resolved).toEqual(["bash", "read", "write", "edit", "web-search", "web-fetch"]);
  });

  it("exposes the actual registered web-search/web-fetch tools from legacy config", () => {
    const resolved = resolveConfiguredToolNames(["web_search", "web_fetch"], REGISTERED);
    expect(resolved).toContain("web-search");
    expect(resolved).toContain("web-fetch");
    for (const name of resolved) {
      expect(REGISTERED).toContain(name);
    }
  });

  it("deduplicates when both a legacy alias and its canonical form are configured", () => {
    expect(resolveConfiguredToolNames(["web_search", "web-search"], REGISTERED)).toEqual([
      "web-search",
    ]);
  });

  it("throws for a truly unknown configured tool name instead of silently dropping it", () => {
    expect(() => resolveConfiguredToolNames(["bash", "not_a_real_tool"], REGISTERED)).toThrow(
      /Unknown configured tool name/,
    );
  });

  it("throws naming the unresolvable tool so the failure is actionable", () => {
    expect(() => resolveConfiguredToolNames(["frobnicate"], REGISTERED)).toThrow(/frobnicate/);
  });

  it("fails startup validation rather than filtering an unknown name out of the tool set", () => {
    let resolved: string[] | undefined;
    expect(() => {
      resolved = resolveConfiguredToolNames(["bash", "bogus"], REGISTERED);
    }).toThrow();
    expect(resolved).toBeUndefined();
  });
});
