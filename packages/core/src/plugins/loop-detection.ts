import { createHash } from "node:crypto";
import type { HairyClawPlugin, PluginContext } from "../plugin.js";
import type { ToolCallRecord } from "../types.js";

export interface LoopDetectionOptions {
  warnThreshold?: number;
  hardLimit?: number;
  windowSize?: number;
  maxTrackedTraces?: number;
}

const WARN_MSG =
  "[LOOP DETECTED] You are repeating the same tool calls. Produce your final answer now.";
const HARD_STOP_MSG =
  "[HARD STOP] Loop detection triggered. The agent has been repeating the same tool calls and has been stopped.";

const hashToolCalls = (toolCalls: ToolCallRecord[]): string => {
  const normalized = toolCalls
    .map((tc) => ({ name: tc.toolName, args: tc.args }))
    .sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) return nameCompare;
      return JSON.stringify(a.args, Object.keys((a.args ?? {}) as object).sort()).localeCompare(
        JSON.stringify(b.args, Object.keys((b.args ?? {}) as object).sort()),
      );
    });
  return createHash("md5").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
};

export const createLoopDetectionPlugin = (opts?: LoopDetectionOptions): HairyClawPlugin => {
  const warnThreshold = opts?.warnThreshold ?? 3;
  const hardLimit = opts?.hardLimit ?? 5;
  const windowSize = opts?.windowSize ?? 20;
  const maxTrackedTraces = opts?.maxTrackedTraces ?? 100;

  // Map<traceId, hash[]> — insertion-order for LRU eviction
  const traceWindows = new Map<string, string[]>();
  // Track which hashes have already had their warning fired per trace
  const warnedHashes = new Map<string, Set<string>>();

  const touchTrace = (traceId: string): void => {
    // LRU: delete and re-set to move to end
    const window = traceWindows.get(traceId);
    if (window !== undefined) {
      traceWindows.delete(traceId);
      traceWindows.set(traceId, window);
    }

    const warned = warnedHashes.get(traceId);
    if (warned !== undefined) {
      warnedHashes.delete(traceId);
      warnedHashes.set(traceId, warned);
    }

    // Evict oldest if over limit
    while (traceWindows.size > maxTrackedTraces) {
      const oldest = traceWindows.keys().next().value as string;
      traceWindows.delete(oldest);
      warnedHashes.delete(oldest);
    }
  };

  const getWindow = (traceId: string): string[] => {
    let window = traceWindows.get(traceId);
    if (!window) {
      window = [];
      traceWindows.set(traceId, window);
    }
    return window;
  };

  const countHash = (window: string[], hash: string): number => {
    let count = 0;
    for (const h of window) {
      if (h === hash) count++;
    }
    return count;
  };

  return {
    name: "loop_detection",

    afterModel: async (
      responseText: string,
      toolCalls: ToolCallRecord[],
      ctx: PluginContext,
    ): Promise<string | null> => {
      if (toolCalls.length === 0) {
        return responseText;
      }

      const hash = hashToolCalls(toolCalls);
      const window = getWindow(ctx.traceId);

      // Add hash to sliding window
      window.push(hash);
      if (window.length > windowSize) {
        window.shift();
      }

      touchTrace(ctx.traceId);

      const count = countHash(window, hash);

      if (count >= hardLimit) {
        ctx.state.set("loopDetection.forcedStop", true);
        ctx.state.set("loopDetection.filteredResponse", HARD_STOP_MSG);
        ctx.logger.warn(
          { traceId: ctx.traceId, hash, count, hardLimit },
          "loop detection hard stop triggered",
        );
        return null;
      }

      if (count >= warnThreshold) {
        const warned = warnedHashes.get(ctx.traceId) ?? new Set<string>();
        if (!warned.has(hash)) {
          warned.add(hash);
          warnedHashes.set(ctx.traceId, warned);
          ctx.logger.warn(
            { traceId: ctx.traceId, hash, count, warnThreshold },
            "loop detection warning issued",
          );
          return `${responseText}\n\n${WARN_MSG}`;
        }
        // Already warned for this hash — pass through unchanged
        return responseText;
      }

      return responseText;
    },

    onRunEnd: async (ctx: PluginContext): Promise<void> => {
      traceWindows.delete(ctx.traceId);
      warnedHashes.delete(ctx.traceId);
    },
  };
};
