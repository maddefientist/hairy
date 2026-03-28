import type { HairyClawLogger } from "@hairyclaw/observability";
import type {
  AgentLoopMessage as ProviderMessage,
  AgentLoopStreamOptions as StreamOptions,
} from "./agent-loop.js";
import type { AgentResponse, HairyClawMessage, RunResult, ToolCallRecord } from "./types.js";

export interface PluginContext {
  traceId: string;
  channelType: string;
  channelId: string;
  senderId: string;
  state: Map<string, unknown>;
  logger: HairyClawLogger;
}

export interface HairyClawPlugin {
  name: string;
  priority?: number;

  onUserMessage?(msg: HairyClawMessage, ctx: PluginContext): Promise<HairyClawMessage | null>;
  beforeModel?(
    messages: ProviderMessage[],
    opts: StreamOptions,
    ctx: PluginContext,
  ): Promise<{ messages: ProviderMessage[]; opts: StreamOptions } | null>;
  afterModel?(
    responseText: string,
    toolCalls: ToolCallRecord[],
    ctx: PluginContext,
  ): Promise<string | null>;
  onModelError?(error: Error, ctx: PluginContext): Promise<string | null>;
  beforeTool?(
    toolName: string,
    args: unknown,
    ctx: PluginContext,
  ): Promise<{ args: unknown } | null>;
  afterTool?(
    toolName: string,
    result: string,
    isError: boolean,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean }>;
  onToolError?(
    toolName: string,
    error: Error,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean } | null>;
  beforeSend?(response: AgentResponse, ctx: PluginContext): Promise<AgentResponse | null>;
  onRunStart?(ctx: PluginContext): Promise<void>;
  onRunEnd?(ctx: PluginContext, result?: RunResult, error?: Error): Promise<void>;
}

const pluginPriority = (plugin: HairyClawPlugin): number => plugin.priority ?? 100;

export class PluginRunner {
  private readonly plugins: HairyClawPlugin[];

  constructor(plugins: HairyClawPlugin[]) {
    this.plugins = [...plugins].sort((left, right) => pluginPriority(left) - pluginPriority(right));
  }

  async runOnUserMessage(
    msg: HairyClawMessage,
    ctx: PluginContext,
  ): Promise<HairyClawMessage | null> {
    let current: HairyClawMessage | null = msg;

    for (const plugin of this.plugins) {
      if (!plugin.onUserMessage || current === null) {
        continue;
      }

      const hook = plugin.onUserMessage;
      const currentMessage: HairyClawMessage = current;
      const next: HairyClawMessage | null | undefined =
        await this.safeHook<HairyClawMessage | null>(
          plugin,
          "onUserMessage",
          () => hook(currentMessage, ctx),
          ctx,
        );

      if (next === null) {
        return null;
      }

      if (next) {
        current = next;
      }
    }

    return current;
  }

  async runBeforeModel(
    messages: ProviderMessage[],
    opts: StreamOptions,
    ctx: PluginContext,
  ): Promise<{ messages: ProviderMessage[]; opts: StreamOptions } | null> {
    let current = { messages, opts };

    for (const plugin of this.plugins) {
      if (!plugin.beforeModel) {
        continue;
      }

      const hook = plugin.beforeModel;
      const next = await this.safeHook(
        plugin,
        "beforeModel",
        () => hook(current.messages, current.opts, ctx),
        ctx,
      );

      if (next === null) {
        return null;
      }

      if (next) {
        current = next;
      }
    }

    return current;
  }

  async runAfterModel(
    text: string,
    toolCalls: ToolCallRecord[],
    ctx: PluginContext,
  ): Promise<string | null> {
    let current: string | null = text;

    for (const plugin of this.plugins) {
      if (!plugin.afterModel || current === null) {
        continue;
      }

      const hook = plugin.afterModel;
      const responseText: string = current;
      const next: string | null | undefined = await this.safeHook<string | null>(
        plugin,
        "afterModel",
        () => hook(responseText, toolCalls, ctx),
        ctx,
      );

      if (next === null) {
        return null;
      }

      if (typeof next === "string") {
        current = next;
      }
    }

    return current;
  }

  async runOnModelError(error: Error, ctx: PluginContext): Promise<string | null> {
    let replacement: string | null = null;

    for (const plugin of this.plugins) {
      if (!plugin.onModelError) {
        continue;
      }

      const hook = plugin.onModelError;
      const result = await this.safeHook(plugin, "onModelError", () => hook(error, ctx), ctx);
      if (typeof result === "string") {
        replacement = result;
      }
    }

    return replacement;
  }

  async runBeforeTool(
    name: string,
    args: unknown,
    ctx: PluginContext,
  ): Promise<{ args: unknown } | null> {
    let current = { args };

    for (const plugin of this.plugins) {
      if (!plugin.beforeTool) {
        continue;
      }

      const hook = plugin.beforeTool;
      const next = await this.safeHook(
        plugin,
        "beforeTool",
        () => hook(name, current.args, ctx),
        ctx,
      );

      if (next === null) {
        return null;
      }

      if (next) {
        current = next;
      }
    }

    return current;
  }

  async runAfterTool(
    name: string,
    result: string,
    isError: boolean,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean }> {
    let current = { result, isError };

    for (const plugin of this.plugins) {
      if (!plugin.afterTool) {
        continue;
      }

      const hook = plugin.afterTool;
      const next = await this.safeHook(
        plugin,
        "afterTool",
        () => hook(name, current.result, current.isError, ctx),
        ctx,
      );
      if (next) {
        current = next;
      }
    }

    return current;
  }

  async runOnToolError(
    name: string,
    error: Error,
    ctx: PluginContext,
  ): Promise<{ result: string; isError: boolean } | null> {
    let replacement: { result: string; isError: boolean } | null = null;

    for (const plugin of this.plugins) {
      if (!plugin.onToolError) {
        continue;
      }

      const hook = plugin.onToolError;
      const result = await this.safeHook(plugin, "onToolError", () => hook(name, error, ctx), ctx);
      if (result) {
        replacement = result;
      }
    }

    return replacement;
  }

  async runBeforeSend(response: AgentResponse, ctx: PluginContext): Promise<AgentResponse | null> {
    let current: AgentResponse | null = response;

    for (const plugin of this.plugins) {
      if (!plugin.beforeSend || current === null) {
        continue;
      }

      const hook = plugin.beforeSend;
      const currentResponse: AgentResponse = current;
      const next: AgentResponse | null | undefined = await this.safeHook<AgentResponse | null>(
        plugin,
        "beforeSend",
        () => hook(currentResponse, ctx),
        ctx,
      );

      if (next === null) {
        return null;
      }

      if (next) {
        current = next;
      }
    }

    return current;
  }

  async runOnRunStart(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onRunStart) {
        continue;
      }

      const hook = plugin.onRunStart;
      await this.safeHook(plugin, "onRunStart", () => hook(ctx), ctx);
    }
  }

  async runOnRunEnd(ctx: PluginContext, result?: RunResult, error?: Error): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onRunEnd) {
        continue;
      }

      const hook = plugin.onRunEnd;
      await this.safeHook(plugin, "onRunEnd", () => hook(ctx, result, error), ctx);
    }
  }

  private async safeHook<T>(
    plugin: HairyClawPlugin,
    hookName: string,
    call: () => Promise<T | undefined>,
    ctx: PluginContext,
  ): Promise<T | undefined> {
    try {
      return await call();
    } catch (error: unknown) {
      ctx.logger.error(
        {
          plugin: plugin.name,
          hook: hookName,
          error: error instanceof Error ? error.message : String(error),
          traceId: ctx.traceId,
        },
        "plugin hook failed",
      );
      return undefined;
    }
  }
}
