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
