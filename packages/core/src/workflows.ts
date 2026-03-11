import type { HairyLogger } from "@hairy/observability";
import {
  type AgentLoopProvider,
  type AgentLoopToolDef,
  type ToolExecutor,
  runAgentLoop,
} from "./agent-loop.js";
import type { PluginContext } from "./plugin.js";

export interface WorkflowStep {
  name: string;
  run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>>;
}

const mergeState = (target: Map<string, unknown>, output: Map<string, unknown>): void => {
  for (const [key, value] of output.entries()) {
    target.set(key, value);
  }
};

export class SequentialFlow implements WorkflowStep {
  constructor(
    public readonly name: string,
    private readonly steps: WorkflowStep[],
  ) {}

  async run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>> {
    for (const step of this.steps) {
      const output = await step.run(state, ctx);
      mergeState(state, output);
    }

    return state;
  }
}

export class ParallelFlow implements WorkflowStep {
  private readonly maxConcurrency: number;

  constructor(
    public readonly name: string,
    private readonly steps: WorkflowStep[],
    opts: { maxConcurrency?: number } = {},
  ) {
    const requested = opts.maxConcurrency ?? this.steps.length;
    this.maxConcurrency = Math.max(1, requested);
  }

  async run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>> {
    if (this.steps.length === 0) {
      return state;
    }

    const outputs: Array<Map<string, unknown> | null> = Array.from(
      { length: this.steps.length },
      () => null,
    );
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < this.steps.length) {
        const current = next;
        next += 1;

        const step = this.steps[current];
        try {
          outputs[current] = await step.run(new Map(state), ctx);
        } catch (error: unknown) {
          state.set(
            `workflow.error.${step.name}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.maxConcurrency, this.steps.length) }, () =>
      worker(),
    );
    await Promise.all(workers);

    for (const output of outputs) {
      if (!output) {
        continue;
      }
      mergeState(state, output);
    }

    return state;
  }
}

export class LoopFlow implements WorkflowStep {
  constructor(
    public readonly name: string,
    private readonly step: WorkflowStep,
    private readonly opts: {
      until: (state: Map<string, unknown>, iteration: number) => boolean;
      maxIterations: number;
    },
  ) {}

  async run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>> {
    for (let iteration = 0; iteration < this.opts.maxIterations; iteration += 1) {
      if (this.opts.until(state, iteration)) {
        break;
      }

      const output = await this.step.run(state, ctx);
      mergeState(state, output);
    }

    return state;
  }
}

interface AgentStepOptions {
  name: string;
  promptTemplate: string;
  outputKey: string;
  model?: string;
  provider?: string;
  tools?: AgentLoopToolDef[];
  maxIterations?: number;
}

interface AgentStepRuntime {
  provider: AgentLoopProvider;
  executor: ToolExecutor;
  defaultModel?: string;
  systemPrompt?: string;
}

const AGENT_RUNTIME_KEY = "workflow.agentRuntime";

const interpolatePrompt = (template: string, state: Map<string, unknown>): string => {
  return template.replaceAll(/\{state\.([a-zA-Z0-9_.-]+)\}/g, (_full, key: string) => {
    const value = state.get(key);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  });
};

export class AgentStep implements WorkflowStep {
  readonly name: string;

  constructor(private readonly opts: AgentStepOptions) {
    this.name = opts.name;
  }

  async run(state: Map<string, unknown>, ctx: PluginContext): Promise<Map<string, unknown>> {
    const runtime = this.resolveRuntime(state, ctx);
    const model = this.resolveModel(state, runtime);

    const prompt = interpolatePrompt(this.opts.promptTemplate, state);

    const result = await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: prompt }] }],
      {
        provider: runtime.provider,
        executor: runtime.executor,
        streamOpts: {
          model,
          systemPrompt: runtime.systemPrompt,
          tools: this.opts.tools ?? [],
        },
        maxIterations: this.opts.maxIterations,
        logger: ctx.logger,
      },
    );

    return new Map([[this.opts.outputKey, result.text]]);
  }

  private resolveRuntime(state: Map<string, unknown>, ctx: PluginContext): AgentStepRuntime {
    const fromState = state.get(AGENT_RUNTIME_KEY) ?? ctx.state.get(AGENT_RUNTIME_KEY);
    if (!fromState || typeof fromState !== "object") {
      throw new Error(
        `AgentStep \"${this.name}\" requires runtime at state key \"${AGENT_RUNTIME_KEY}\"`,
      );
    }

    const runtime = fromState as AgentStepRuntime;
    if (!runtime.provider || !runtime.executor) {
      throw new Error(`AgentStep \"${this.name}\" runtime is missing provider or executor`);
    }

    return runtime;
  }

  private resolveModel(state: Map<string, unknown>, runtime: AgentStepRuntime): string {
    if (this.opts.model) {
      return this.opts.model;
    }

    if (this.opts.provider) {
      const stateModel = state.get(`workflow.model.${this.opts.provider}`);
      if (typeof stateModel === "string" && stateModel.length > 0) {
        return stateModel;
      }
    }

    if (runtime.defaultModel && runtime.defaultModel.length > 0) {
      return runtime.defaultModel;
    }

    throw new Error(`AgentStep \"${this.name}\" requires a model override or runtime.defaultModel`);
  }
}

const defaultLogger: HairyLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => defaultLogger,
};

export const runWorkflow = async (
  workflow: WorkflowStep,
  initialState?: Map<string, unknown>,
  ctx?: PluginContext,
): Promise<Map<string, unknown>> => {
  const state = initialState ? new Map(initialState) : new Map<string, unknown>();

  const context: PluginContext = ctx
    ? { ...ctx, state }
    : {
        traceId: "workflow",
        channelType: "workflow",
        channelId: "workflow",
        senderId: "workflow",
        state,
        logger: defaultLogger,
      };

  const output = await workflow.run(state, context);
  mergeState(state, output);
  return state;
};
