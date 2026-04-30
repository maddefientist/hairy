import { type AgentLoopProvider, runAgentLoop } from "@hairyclaw/core";
import type { HairyClawLogger } from "@hairyclaw/observability";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

type ThinkingLevel = "off" | "low" | "medium" | "high";

interface RoleSpec {
  role: string;
  thinking: ThinkingLevel;
  systemPrompt: string;
  /** Override the default model for this role */
  model?: string;
  maxIterations?: number;
}

interface ChainDef {
  description: string;
  roles: RoleSpec[];
}

// ---------------------------------------------------------------------------
// Chain definitions — mirrors .pi/agent/agents/*.chain.md
// Model assignments and thinking levels are intentionally defaults;
// they can be overridden per-deployment via createChainTool options.
// ---------------------------------------------------------------------------
const CHAINS: Record<string, ChainDef> = {
  build: {
    description: "Full build pipeline: scout → plan → code → review",
    roles: [
      {
        role: "scout",
        thinking: "low",
        systemPrompt:
          "You are a Scout. Your job is to quickly gather essential context for the task: " +
          "relevant files, existing code patterns, documentation, and constraints. " +
          "Be fast and factual. Output a concise brief for the Planner.",
      },
      {
        role: "planner",
        thinking: "high",
        systemPrompt:
          "You are a Planner. Given the Scout's brief and the original task, produce a detailed " +
          "implementation plan: steps, file changes, edge cases, and potential risks. " +
          "Think carefully. Output a structured plan for the Coder.",
      },
      {
        role: "coder",
        thinking: "high",
        systemPrompt:
          "You are a Coder. Implement the Planner's plan exactly. Write clean, working code. " +
          "Run tests if available. Fix any errors you encounter. " +
          "Output the final implementation with a summary of what was done.",
      },
      {
        role: "reviewer",
        thinking: "high",
        systemPrompt:
          "You are a Reviewer. Critically review the Coder's output against the original task and plan. " +
          "Check correctness, edge cases, security, and code quality. " +
          "Output a final verdict and any required fixes applied.",
      },
    ],
  },

  design: {
    description: "Design pipeline: scout → plan → design → review",
    roles: [
      {
        role: "scout",
        thinking: "low",
        systemPrompt:
          "You are a Scout. Gather context for the design task: existing patterns, constraints, " +
          "user requirements, and relevant prior art. Output a concise brief for the Planner.",
      },
      {
        role: "planner",
        thinking: "high",
        systemPrompt:
          "You are a Planner. Given the Scout's brief, produce a design plan: " +
          "architecture decisions, component breakdown, data flows, and trade-offs. " +
          "Think carefully. Output a structured design brief for the Designer.",
      },
      {
        role: "designer",
        thinking: "high",
        systemPrompt:
          "You are a Designer. Execute the design plan. Produce the final design: " +
          "schemas, interfaces, architecture docs, or UI specs as appropriate. " +
          "Output the complete design artifact.",
      },
      {
        role: "reviewer",
        thinking: "high",
        systemPrompt:
          "You are a Reviewer. Critically review the design against requirements and best practices. " +
          "Check consistency, completeness, and correctness. Output a final verdict and any revisions.",
      },
    ],
  },

  document: {
    description: "Documentation pipeline: plan → write → review",
    roles: [
      {
        role: "planner",
        thinking: "medium",
        systemPrompt:
          "You are a Documentation Planner. Outline the structure for the documentation: " +
          "sections, audience, tone, and key points to cover. Output a clear outline.",
      },
      {
        role: "writer",
        thinking: "low",
        systemPrompt:
          "You are a Writer. Following the Planner's outline, write clear, complete documentation. " +
          "Use appropriate formatting. Be precise and helpful. Output the final draft.",
      },
      {
        role: "reviewer",
        thinking: "medium",
        systemPrompt:
          "You are a Reviewer. Review the documentation for accuracy, clarity, and completeness. " +
          "Fix any errors or gaps. Output the polished final version.",
      },
    ],
  },

  implement: {
    description: "Fast implementation pipeline: code → review",
    roles: [
      {
        role: "coder",
        thinking: "high",
        systemPrompt:
          "You are a Coder. Implement the task directly. Write clean, working code. " +
          "Run tests if available. Fix errors. Output the implementation with a summary.",
      },
      {
        role: "reviewer",
        thinking: "high",
        systemPrompt:
          "You are a Reviewer. Review the implementation for correctness, edge cases, and quality. " +
          "Apply any required fixes. Output the final verified implementation.",
      },
    ],
  },

  qlt: {
    description: "Quality pipeline: analyse → review (no new code)",
    roles: [
      {
        role: "analyst",
        thinking: "high",
        systemPrompt:
          "You are a Quality Analyst. Deeply analyse the code or output for bugs, security issues, " +
          "performance problems, and code quality. Produce a structured findings report.",
      },
      {
        role: "reviewer",
        thinking: "medium",
        systemPrompt:
          "You are a Reviewer. Based on the analyst's findings, produce a prioritised list of issues " +
          "and apply fixes where possible. Output a final quality report.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------

const chainArgsSchema = z.object({
  chain: z.enum(["build", "design", "document", "implement", "qlt"]),
  task: z.string().min(1).max(20_000),
});

const noopLogger: HairyClawLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => noopLogger,
};

export interface ChainToolOptions {
  /** Factory: given a model string and thinking level, return a provider */
  providerFactory: (model: string, thinking: ThinkingLevel) => AgentLoopProvider;
  /** Default model used for all roles unless overridden in the chain def */
  defaultModel: string;
  /** Tools available to each role in the chain */
  tools: Tool[];
  logger?: HairyClawLogger;
  /** Optional per-role model overrides: { "build.coder": "ollama/qwen3.5:27b" } */
  modelOverrides?: Record<string, string>;
  /** Timeout per role in ms (default 5 min) */
  roleTimeoutMs?: number;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`role timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e); },
    );
  });

export const createChainTool = (opts: ChainToolOptions): Tool => ({
  name: "run_chain",
  description:
    "Run a multi-role agent chain for complex tasks. " +
    "Chains: build (scout→plan→code→review), design (scout→plan→design→review), " +
    "document (plan→write→review), implement (code→review), qlt (analyse→review). " +
    "Each role uses appropriate thinking depth. Use this instead of spawn_agent for tasks " +
    "that require planning, implementation, or quality review.",
  parameters: chainArgsSchema,

  async execute(args, ctx) {
    const { chain: chainName, task } = chainArgsSchema.parse(args);
    const chainDef = CHAINS[chainName];
    const logger = opts.logger ?? ctx.logger ?? noopLogger;
    const roleTimeoutMs = opts.roleTimeoutMs ?? 300_000;

    const toToolDef = (tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {} as Record<string, unknown>,
    });

    const toolExecutor = async (name: string, toolArgs: unknown) => {
      const tool = opts.tools.find((t) => t.name === name);
      if (!tool) return { content: `tool not found: ${name}`, isError: true };
      const result = await tool.execute(toolArgs, ctx);
      return { content: result.content, isError: result.isError ?? false };
    };

    const outputs: Array<{ role: string; output: string }> = [];

    for (const roleSpec of chainDef.roles) {
      const overrideKey = `${chainName}.${roleSpec.role}`;
      const model =
        opts.modelOverrides?.[overrideKey] ??
        opts.modelOverrides?.[roleSpec.role] ??
        roleSpec.model ??
        opts.defaultModel;

      const provider = opts.providerFactory(model, roleSpec.thinking);

      // Build context from prior role outputs
      const priorContext =
        outputs.length > 0
          ? "\n\n---\nPrior outputs from earlier roles in this chain:\n" +
            outputs.map((o) => `### ${o.role}\n${o.output}`).join("\n\n")
          : "";

      const userMessage = `Task: ${task}${priorContext}`;

      logger.info({ chain: chainName, role: roleSpec.role, model, thinking: roleSpec.thinking }, "chain role starting");

      try {
        const result = await withTimeout(
          runAgentLoop(
            [{ role: "user", content: [{ type: "text", text: userMessage }] }],
            {
              provider,
              executor: toolExecutor,
              logger,
              maxIterations: roleSpec.maxIterations ?? 20,
              streamOpts: {
                model,
                systemPrompt: roleSpec.systemPrompt,
                tools: opts.tools.map(toToolDef),
                thinkingLevel: roleSpec.thinking,
              },
            },
          ),
          roleTimeoutMs,
        );

        const output = result.text ?? "(no output)";
        outputs.push({ role: roleSpec.role, output });
        logger.info({ chain: chainName, role: roleSpec.role, outputLength: output.length }, "chain role complete");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "role failed";
        logger.error({ chain: chainName, role: roleSpec.role, err: msg }, "chain role error");
        outputs.push({ role: roleSpec.role, output: `ERROR: ${msg}` });
      }
    }

    // Return the final role's output as the chain result, with a header
    const final = outputs.at(-1)?.output ?? "(chain produced no output)";
    const summary =
      `[Chain: ${chainName} | Roles: ${outputs.map((o) => o.role).join(" → ")}]\n\n` + final;

    return { content: summary };
  },
});
