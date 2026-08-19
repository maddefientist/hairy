/**
 * Named tool profiles. The primary operator (the top-level agent loop
 * talking directly to the human/channel) gets the full registered tool
 * surface — that is the trusted shell boundary. Any spawned/child agent
 * (spawn_agent, delegate, run_chain roles, and future subagents) gets a
 * strictly narrower profile with the highest-impact tools removed by
 * default, so a child can never invoke a hidden tool by name even if a
 * caller mistakenly hands it a broader tool list.
 */

export const PRIMARY_OPERATOR_PROFILE = "primary" as const;
export const CHILD_PROFILE = "child" as const;

/**
 * Tools that are never available to child/sub-agent profiles by default:
 * raw shell access, remote shell access, headless-browser control, identity
 * mutation, and anything that could re-delegate/re-chain to spawn further
 * children (which would let a child regain the removed capabilities
 * indirectly).
 */
export const DEFAULT_CHILD_DENY_LIST: readonly string[] = [
  "bash",
  "ssh_exec",
  "browser",
  "identity_evolve",
  "delegate",
  "spawn_agent",
  "run_chain",
];

export interface ToolProfile {
  name: string;
  allowedTools: readonly string[];
}

/**
 * Legacy (pre-hyphenation) config tool-name spellings, mapped to their
 * canonical registered tool names. Kept so existing deployments' TOML/env
 * configuration (`web_search`, `web_fetch`) keeps working after the
 * registered tool names moved to hyphenated form (`web-search`,
 * `web-fetch`) — never silently drops the configured tool.
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  web_search: "web-search",
  web_fetch: "web-fetch",
};

/** Resolve a single configured tool name to its canonical registered form. */
export const canonicalizeToolName = (name: string): string =>
  LEGACY_TOOL_NAME_ALIASES[name] ?? name;

/**
 * Resolve a list of configured tool names (e.g. `[executor].tools` /
 * `[orchestrator].tools`) against the actually-registered tool names.
 *
 * - Legacy underscore aliases (`web_search`, `web_fetch`, ...) are
 *   canonicalized to their registered hyphenated names.
 * - Any configured name that still doesn't match a registered tool after
 *   canonicalization throws — a deployment can never silently lose a tool
 *   it explicitly asked for (e.g. a typo or truly unknown tool name) by
 *   having it filtered out without any signal.
 * - Duplicate configured names (including a legacy alias and its canonical
 *   form both being configured) collapse to a single entry, order-preserving.
 */
export const resolveConfiguredToolNames = (
  configuredNames: readonly string[],
  registeredToolNames: readonly string[],
): string[] => {
  const registered = new Set(registeredToolNames);
  const seen = new Set<string>();
  const resolved: string[] = [];
  const unknown: string[] = [];

  for (const raw of configuredNames) {
    const canonical = canonicalizeToolName(raw);
    if (!registered.has(canonical)) {
      unknown.push(raw === canonical ? raw : `"${raw}" (canonicalized to "${canonical}")`);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    resolved.push(canonical);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown configured tool name(s): ${unknown.join(", ")}. ` +
        `Registered tools: ${registeredToolNames.join(", ")}.`,
    );
  }

  return resolved;
};

/** The primary operator profile always includes every currently-registered tool. */
export const primaryOperatorProfile = (allToolNames: readonly string[]): ToolProfile => ({
  name: PRIMARY_OPERATOR_PROFILE,
  allowedTools: [...allToolNames],
});

/**
 * Build the child profile from the full tool set, removing the default deny
 * list plus any deployment-specific extra denials. This is intentionally an
 * allow-list (not a denial check at call time) so a newly-added tool is
 * excluded from child access unless explicitly added here.
 */
export const buildChildProfile = (
  allToolNames: readonly string[],
  extraDenied: readonly string[] = [],
): ToolProfile => {
  const denied = new Set([...DEFAULT_CHILD_DENY_LIST, ...extraDenied]);
  return {
    name: CHILD_PROFILE,
    allowedTools: allToolNames.filter((name) => !denied.has(name)),
  };
};
