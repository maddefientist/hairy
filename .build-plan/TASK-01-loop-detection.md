# TASK-01: Loop Detection Plugin

## Goal
Create a plugin that detects when the agent repeats the same tool calls and breaks the loop.

## Location
- New file: `packages/core/src/plugins/loop-detection.ts`
- Update: `packages/core/src/index.ts` (add export)
- New test: `packages/core/test/loop-detection.test.ts`
- Update: `config/default.toml` (add config section)

## Read First
- `packages/core/src/plugin.ts` — PluginRunner + HairyClawPlugin interface
- `packages/core/src/plugins/cost-guard.ts` — example plugin pattern
- `packages/core/src/types.ts` — ToolCallRecord type

## Design

### Algorithm (stolen from DeerFlow's LoopDetectionMiddleware)
1. In `afterModel`, hash tool calls from the current turn (deterministic: sort by name + JSON.stringify(args))
2. Track hashes per traceId in a sliding window (last 20)
3. At `warnThreshold` (default 3) identical hash occurrences: return a warning message telling the agent to stop repeating
4. At `hardLimit` (default 5): return null to trigger the plugin runner's retry/block behavior, and set `ctx.state("loopDetection.forcedStop", true)` and `ctx.state("loopDetection.filteredResponse", HARD_STOP_MSG)`

### Interface
```typescript
export interface LoopDetectionOptions {
  warnThreshold?: number;   // default: 3
  hardLimit?: number;        // default: 5
  windowSize?: number;       // default: 20
  maxTrackedTraces?: number; // default: 100 (LRU eviction)
}

export const createLoopDetectionPlugin = (opts?: LoopDetectionOptions): HairyClawPlugin
```

### Hashing
```typescript
import { createHash } from "node:crypto";

const hashToolCalls = (toolCalls: ToolCallRecord[]): string => {
  const normalized = toolCalls
    .map(tc => ({ name: tc.toolName, args: tc.args }))
    .sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) return nameCompare;
      return JSON.stringify(a.args, Object.keys(a.args as object).sort())
        .localeCompare(JSON.stringify(b.args, Object.keys(b.args as object).sort()));
    });
  return createHash("md5").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
};
```

### Plugin hooks to implement
- `afterModel(responseText, toolCalls, ctx)`:
  - If toolCalls is empty, return responseText (no loop possible)
  - Hash the tool calls
  - Track in sliding window keyed by ctx.traceId
  - If count >= hardLimit: set ctx.state values and return null
  - If count >= warnThreshold (first time for this hash): return `${responseText}\n\n[LOOP DETECTED] You are repeating the same tool calls. Produce your final answer now.`
  - Otherwise: return responseText

- `onRunEnd(ctx)`: clean up tracking state for this traceId

### LRU eviction
Use a Map and delete+re-set to move entries to end. When size > maxTrackedTraces, delete the first entry.

## Config Addition (config/default.toml)
```toml
[plugins.loop_detection]
enabled = true
warn_threshold = 3
hard_limit = 5
window_size = 20
```

## Tests (Vitest)
1. No tool calls → passes through unchanged
2. Different tool calls each time → no warning
3. Same tool calls 3 times → warning injected
4. Same tool calls 5 times → returns null (hard stop)
5. Warning only fires once per unique hash
6. LRU eviction works when maxTrackedTraces exceeded
7. onRunEnd cleans up traceId state
8. Different traceIds tracked independently

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
