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
  let finalText = "";
  let iterations = 0;

  for (let i = 0; i < maxIter; i++) {
    iterations = i + 1;

    // Collect events from this turn
    const textParts: string[] = [];
    const pendingCalls = new Map<string, PendingToolCall>();
    let stopReason = "end";
    let hadError = false;

    for await (const event of opts.provider.stream(conversation, opts.streamOpts)) {
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
        case "tool_call_end": {
          // Nothing to do — args are already accumulated
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
        case "stop": {
          stopReason = event.reason ?? "end";
          break;
        }
        case "error": {
          opts.logger.error({ error: event.error }, "agent loop provider error");
          hadError = true;
          break;
        }
        case "thinking": {
          // Log but don't include in output
          opts.logger.debug({ thinking: event.text }, "llm thinking");
          break;
        }
      }
    }

    if (hadError && pendingCalls.size === 0 && textParts.length === 0) {
      finalText = "An error occurred while processing your request.";
      break;
    }

    const turnText = textParts.join("");

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

      // Add to assistant content
      assistantContent.push({
        type: "tool_call",
        toolCall: { id: call.id, name: call.name, args: parsedArgs },
      });

      // Execute tool
      opts.onToolStart?.(call.name, call.id);
      const startedAt = Date.now();

      const result = await opts.executor(call.name, parsedArgs, call.id);

      const durationMs = Date.now() - startedAt;
      opts.onToolEnd?.(call.name, call.id, result.content, result.isError);

      opts.logger.info(
        {
          toolName: call.name,
          callId: call.id,
          isError: result.isError,
          durationMs,
          resultLength: result.content.length,
        },
        "tool executed",
      );

      opts.metrics?.increment("tool_calls", 1, {
        tool: call.name,
        status: result.isError ? "error" : "ok",
      });

      allToolCalls.push({
        toolName: call.name,
        args: parsedArgs,
        result: result.content,
        isError: result.isError,
        durationMs,
      });

      toolResultContent.push({
        type: "tool_result",
        toolResult: {
          id: call.id,
          content: result.content,
          isError: result.isError,
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
