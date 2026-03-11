/**
 * Agent Loop — the core multi-turn LLM ↔ tool execution cycle.
 *
 * Flow:
 * 1. Send conversation to LLM (with tool definitions)
 * 2. Collect response: text deltas + tool call events
 * 3. If tool calls → execute them → append results → go to 1
 * 4. If no tool calls → done, return final text
 *
 * Max iterations prevent infinite loops.
 */

import type { HairyLogger, Metrics } from "@hairy/observability";
import type { PluginContext, PluginRunner } from "./plugin.js";
import type { ToolCallRecord } from "./types.js";

/** Minimal provider interface — just what the loop needs */
export interface AgentLoopProvider {
  stream(messages: AgentLoopMessage[], opts: AgentLoopStreamOptions): AsyncIterable<AgentLoopEvent>;
}

export interface AgentLoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: AgentLoopContent[];
}

export interface AgentLoopContent {
  type: "text" | "tool_call" | "tool_result" | "thinking";
  text?: string;
  toolCall?: { id: string; name: string; args: unknown };
  toolResult?: { id: string; content: string; isError?: boolean };
}

export interface AgentLoopToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentLoopStreamOptions {
  model: string;
  systemPrompt?: string;
  tools?: AgentLoopToolDef[];
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  timeoutMs?: number;
}

export interface AgentLoopEvent {
  type:
    | "text_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "thinking"
    | "usage"
    | "stop"
    | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgsDelta?: string;
  usage?: { input: number; output: number; costUsd: number };
  reason?: string;
  error?: string;
}

/** Tool executor function — provided by the host */
export type ToolExecutor = (
  name: string,
  args: unknown,
  toolCallId: string,
) => Promise<{ content: string; isError: boolean }>;

export interface AgentLoopOptions {
  provider: AgentLoopProvider;
  executor: ToolExecutor;
  streamOpts: AgentLoopStreamOptions;
  logger: HairyLogger;
  metrics?: Metrics;
  plugins?: PluginRunner;
  pluginCtx?: PluginContext;
  /** Max tool-use round-trips before forcing stop (default: 10) */
  maxIterations?: number;
  /** Callback for each text chunk (for streaming to user) */
  onTextDelta?: (text: string) => void;
  /** Callback for tool execution start */
  onToolStart?: (name: string, callId: string) => void;
  /** Callback for tool execution end */
  onToolEnd?: (name: string, callId: string, result: string, isError: boolean) => void;
}

interface PendingToolCall {
  id: string;
  name: string;
  argsChunks: string[];
}

export interface AgentLoopResult {
  text: string;
  toolCalls: ToolCallRecord[];
  totalUsage: { input: number; output: number; costUsd: number };
  iterations: number;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const blockedResponseText = (ctx: PluginContext | null): string | null => {
  if (!ctx) {
    return null;
  }

  const filtered = ctx.state.get("contentSafety.filteredResponse");
  if (typeof filtered === "string" && filtered.trim().length > 0) {
    return filtered;
  }

  return null;
};

/**
 * Run the agent loop: LLM → tool calls → execute → repeat until done.
 */
export const runAgentLoop = async (
  messages: AgentLoopMessage[],
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> => {
  const maxIter = opts.maxIterations ?? 10;
  const conversation = [...messages];
  const allToolCalls: ToolCallRecord[] = [];
  const totalUsage = { input: 0, output: 0, costUsd: 0 };
  const pluginCtx = opts.plugins ? (opts.pluginCtx ?? null) : null;

  let finalText = "";
  let iterations = 0;

  outer: for (let i = 0; i < maxIter; i++) {
    iterations = i + 1;

    let retryAfterModel = false;
    let turnText = "";
    let pendingCalls = new Map<string, PendingToolCall>();

    while (true) {
      const textParts: string[] = [];
      pendingCalls = new Map<string, PendingToolCall>();
      let hadModelError = false;
      let modelErrorMessage = "unknown model error";

      let streamMessages = conversation;
      let streamOpts = opts.streamOpts;

      if (opts.plugins && pluginCtx) {
        const transformed = await opts.plugins.runBeforeModel(
          streamMessages,
          streamOpts,
          pluginCtx,
        );
        if (transformed === null) {
          finalText = blockedResponseText(pluginCtx) ?? "Request blocked by runtime policy.";
          break outer;
        }

        streamMessages = transformed.messages;
        streamOpts = transformed.opts;
      }

      try {
        for await (const event of opts.provider.stream(streamMessages, streamOpts)) {
          switch (event.type) {
            case "text_delta": {
              if (event.text) {
                textParts.push(event.text);
                opts.onTextDelta?.(event.text);
              }
              break;
            }
            case "tool_call_start": {
              if (event.toolCallId && event.toolName) {
                pendingCalls.set(event.toolCallId, {
                  id: event.toolCallId,
                  name: event.toolName,
                  argsChunks: [],
                });
              }
              break;
            }
            case "tool_call_delta": {
              if (event.toolCallId && event.toolArgsDelta) {
                const pending = pendingCalls.get(event.toolCallId);
                if (pending) {
                  pending.argsChunks.push(event.toolArgsDelta);
                }
              }
              break;
            }
            case "usage": {
              if (event.usage) {
                totalUsage.input += event.usage.input;
                totalUsage.output += event.usage.output;
                totalUsage.costUsd += event.usage.costUsd;
              }
              break;
            }
            case "error": {
              hadModelError = true;
              modelErrorMessage = event.error ?? "model stream error";
              break;
            }
            case "thinking": {
              opts.logger.debug({ thinking: event.text }, "llm thinking");
              break;
            }
            case "tool_call_end":
            case "stop": {
              break;
            }
          }

          if (hadModelError) {
            break;
          }
        }
      } catch (error: unknown) {
        hadModelError = true;
        modelErrorMessage = asError(error).message;
      }

      if (hadModelError) {
        opts.logger.error({ error: modelErrorMessage }, "agent loop provider error");
        if (opts.plugins && pluginCtx) {
          const replacement = await opts.plugins.runOnModelError(
            new Error(modelErrorMessage),
            pluginCtx,
          );
          if (typeof replacement === "string") {
            turnText = replacement;
            pendingCalls.clear();
            break;
          }
        }

        if (pendingCalls.size === 0 && textParts.length === 0) {
          finalText = "An error occurred while processing your request.";
          break outer;
        }
      }

      turnText = textParts.join("");

      if (opts.plugins && pluginCtx) {
        const afterModel = await opts.plugins.runAfterModel(turnText, [], pluginCtx);
        if (afterModel === null) {
          if (!retryAfterModel) {
            retryAfterModel = true;
            continue;
          }

          finalText = blockedResponseText(pluginCtx) ?? "I couldn't produce a safe response.";
          break outer;
        }

        turnText = afterModel;
      }

      break;
    }

    // No tool calls → we're done
    if (pendingCalls.size === 0) {
      finalText = turnText;
      break;
    }

    // Build assistant message with text + tool calls
    const assistantContent: AgentLoopContent[] = [];
    if (turnText) {
      assistantContent.push({ type: "text", text: turnText });
    }

    // Execute each tool call
    const toolResultContent: AgentLoopContent[] = [];

    for (const [, call] of pendingCalls) {
      const argsStr = call.argsChunks.join("");
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(argsStr);
      } catch {
        parsedArgs = {};
        opts.logger.warn(
          { toolName: call.name, rawArgs: argsStr },
          "failed to parse tool args as JSON",
        );
      }

      if (opts.plugins && pluginCtx) {
        const beforeTool = await opts.plugins.runBeforeTool(call.name, parsedArgs, pluginCtx);
        if (beforeTool === null) {
          const blocked = `tool call blocked by plugin: ${call.name}`;
          allToolCalls.push({
            toolName: call.name,
            args: parsedArgs,
            result: blocked,
            isError: true,
            durationMs: 0,
          });

          toolResultContent.push({
            type: "tool_result",
            toolResult: {
              id: call.id,
              content: blocked,
              isError: true,
            },
          });

          assistantContent.push({
            type: "tool_call",
            toolCall: { id: call.id, name: call.name, args: parsedArgs },
          });

          continue;
        }

        parsedArgs = beforeTool.args;
      }

      // Add to assistant content
      assistantContent.push({
        type: "tool_call",
        toolCall: { id: call.id, name: call.name, args: parsedArgs },
      });

      // Execute tool
      opts.onToolStart?.(call.name, call.id);
      const startedAt = Date.now();

      let toolResult: { content: string; isError: boolean };
      try {
        toolResult = await opts.executor(call.name, parsedArgs, call.id);
      } catch (error: unknown) {
        const toolError = asError(error);
        if (opts.plugins && pluginCtx) {
          const fallback = await opts.plugins.runOnToolError(call.name, toolError, pluginCtx);
          if (fallback) {
            toolResult = {
              content: fallback.result,
              isError: fallback.isError,
            };
          } else {
            toolResult = { content: toolError.message, isError: true };
          }
        } else {
          toolResult = { content: toolError.message, isError: true };
        }
      }

      if (opts.plugins && pluginCtx) {
        const afterTool = await opts.plugins.runAfterTool(
          call.name,
          toolResult.content,
          toolResult.isError,
          pluginCtx,
        );
        toolResult = {
          content: afterTool.result,
          isError: afterTool.isError,
        };
      }

      const durationMs = Date.now() - startedAt;
      opts.onToolEnd?.(call.name, call.id, toolResult.content, toolResult.isError);

      opts.logger.info(
        {
          toolName: call.name,
          callId: call.id,
          isError: toolResult.isError,
          durationMs,
          resultLength: toolResult.content.length,
        },
        "tool executed",
      );

      opts.metrics?.increment("tool_calls", 1, {
        tool: call.name,
        status: toolResult.isError ? "error" : "ok",
      });

      allToolCalls.push({
        toolName: call.name,
        args: parsedArgs,
        result: toolResult.content,
        isError: toolResult.isError,
        durationMs,
      });

      toolResultContent.push({
        type: "tool_result",
        toolResult: {
          id: call.id,
          content: toolResult.content,
          isError: toolResult.isError,
        },
      });
    }

    // Append assistant message (with tool calls) and user message (with results)
    conversation.push({
      role: "assistant",
      content: assistantContent,
    });
    conversation.push({
      role: "user",
      content: toolResultContent,
    });

    opts.logger.info(
      { iteration: iterations, toolCount: pendingCalls.size },
      "agent loop iteration complete, continuing",
    );
  }

  if (iterations >= maxIter && !finalText) {
    finalText = "I reached the maximum number of tool-use iterations. Here's what I have so far.";
    opts.logger.warn({ maxIterations: maxIter }, "agent loop hit max iterations");
  }

  return {
    text: finalText,
    toolCalls: allToolCalls,
    totalUsage,
    iterations,
  };
};
