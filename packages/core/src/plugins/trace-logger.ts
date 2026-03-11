import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HairyPlugin, PluginContext } from "../plugin.js";

export interface TraceLoggerOptions {
  logDir: string;
  includeContent?: boolean;
}

const TRACE_START_KEY = "traceLogger.startedAt";

const filePathFor = (logDir: string, timestamp: string): string => {
  const day = timestamp.slice(0, 10);
  return join(logDir, `traces-${day}.jsonl`);
};

export const createTraceLoggerPlugin = (opts: TraceLoggerOptions): HairyPlugin => {
  const includeContent = opts.includeContent ?? false;

  const writeEntry = async (entry: Record<string, unknown>): Promise<void> => {
    const timestamp = String(entry.timestamp ?? new Date().toISOString());
    const path = filePathFor(opts.logDir, timestamp);
    await mkdir(opts.logDir, { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const safeWrite = async (ctx: PluginContext, entry: Record<string, unknown>): Promise<void> => {
    try {
      await writeEntry(entry);
    } catch (error: unknown) {
      ctx.logger.error(
        {
          traceId: ctx.traceId,
          error: error instanceof Error ? error.message : String(error),
          logDir: opts.logDir,
        },
        "trace logger write failed",
      );
    }
  };

  return {
    name: "trace_logger",
    onRunStart: async (ctx) => {
      const timestamp = new Date().toISOString();
      ctx.state.set(TRACE_START_KEY, Date.now());
      await safeWrite(ctx, {
        type: "run_start",
        traceId: ctx.traceId,
        channelType: ctx.channelType,
        channelId: ctx.channelId,
        timestamp,
      });
    },
    beforeModel: async (messages, streamOpts, ctx) => {
      const timestamp = new Date().toISOString();
      await safeWrite(ctx, {
        type: "model_request",
        traceId: ctx.traceId,
        messageCount: messages.length,
        model: streamOpts.model,
        ...(includeContent
          ? {
              requestContent: messages,
              systemPrompt: streamOpts.systemPrompt,
            }
          : {}),
        timestamp,
      });
      return { messages, opts: streamOpts };
    },
    afterModel: async (responseText, toolCalls, ctx) => {
      const timestamp = new Date().toISOString();
      await safeWrite(ctx, {
        type: "model_response",
        traceId: ctx.traceId,
        responseLength: responseText.length,
        toolCallCount: toolCalls.length,
        ...(includeContent ? { responseText } : {}),
        timestamp,
      });
      return responseText;
    },
    beforeTool: async (toolName, args, ctx) => {
      const timestamp = new Date().toISOString();
      await safeWrite(ctx, {
        type: "tool_start",
        traceId: ctx.traceId,
        toolName,
        ...(includeContent ? { args } : {}),
        timestamp,
      });
      return { args };
    },
    afterTool: async (toolName, result, isError, ctx) => {
      const timestamp = new Date().toISOString();
      await safeWrite(ctx, {
        type: "tool_end",
        traceId: ctx.traceId,
        toolName,
        isError,
        resultLength: result.length,
        ...(includeContent ? { result } : {}),
        timestamp,
      });
      return { result, isError };
    },
    onRunEnd: async (ctx, result, error) => {
      const timestamp = new Date().toISOString();
      const startedAtRaw = ctx.state.get(TRACE_START_KEY);
      const startedAt = typeof startedAtRaw === "number" ? startedAtRaw : Date.now();
      const durationMs = result?.durationMs ?? Math.max(0, Date.now() - startedAt);

      await safeWrite(ctx, {
        type: "run_end",
        traceId: ctx.traceId,
        durationMs,
        success: error === undefined,
        ...(includeContent && result ? { responseText: result.response.text } : {}),
        timestamp,
      });
    },
  };
};
