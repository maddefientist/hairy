import { describe, expect, it } from "vitest";
import {
  CHILD_PROFILE,
  DEFAULT_CHILD_DENY_LIST,
  PRIMARY_OPERATOR_PROFILE,
  buildChildProfile,
  primaryOperatorProfile,
} from "../src/tool-profiles.js";

const ALL_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "web_search",
  "web_fetch",
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
        "web_search",
        "web_fetch",
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
