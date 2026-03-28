# TASK-02: Context Summarization Plugin

## Goal
Create a plugin that automatically summarizes old conversation messages when context gets too long, keeping recent messages verbatim.

## Location
- New file: `packages/core/src/plugins/summarization.ts`
- Update: `packages/core/src/index.ts` (add export)
- New test: `packages/core/test/summarization.test.ts`
- Update: `config/default.toml` (add config section)

## Read First
- `packages/core/src/plugin.ts` — HairyClawPlugin interface
- `packages/core/src/agent-loop.ts` — AgentLoopMessage and AgentLoopStreamOptions types
- `packages/core/src/plugins/cost-guard.ts` — example plugin pattern
- `packages/providers/src/types.ts` — any provider-related types

## Design

### Trigger Logic
Estimate token count from messages. If exceeds `triggerTokens`, summarize old messages and keep recent ones.

### Token Estimation
Simple heuristic: `Math.ceil(text.length / 4)` per message content. Count all text parts in all messages.

### Summary Generation
The plugin calls the SAME provider that the agent uses (passed through streamOpts) with a special summarization prompt. It uses the `beforeModel` hook which has access to messages and streamOpts.

BUT — the plugin should NOT make its own LLM call (that would require provider access it doesn't have). Instead, it should:
1. Detect when context is too long
2. Compress by truncating/collapsing old tool results (which are the biggest context hogs)
3. Keep a configurable number of recent messages verbatim

### Compression Strategy (no LLM needed)
1. Count tokens across all messages
2. If under triggerTokens, pass through
3. If over: split messages into `old` (first N) and `recent` (last `keepMessages`)
4. For old messages: collapse tool_result content to `[tool result: {toolName} — {length} chars]`
5. For old assistant messages with tool_call content: keep the tool call info but strip verbose args
6. Inject a system-level note: `[Earlier conversation summarized. {oldCount} messages compressed.]`
7. Return compressed messages + recent messages

### Interface
```typescript
export interface SummarizationOptions {
  triggerTokens?: number;  // default: 80000
  keepMessages?: number;   // default: 20
  maxToolResultChars?: number; // default: 500 (truncate old tool results to this)
}

export const createSummarizationPlugin = (opts?: SummarizationOptions): HairyClawPlugin
```

### Plugin hooks
- `beforeModel(messages, streamOpts, ctx)`:
  - Estimate total tokens
  - If under threshold, return { messages, opts: streamOpts }
  - Otherwise, compress old messages and return { messages: compressed, opts: streamOpts }
  - Log compression stats via ctx.logger

### Helper Functions
```typescript
const estimateTokens = (messages: AgentLoopMessage[]): number => {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.text) total += Math.ceil(part.text.length / 4);
      if (part.toolCall) total += Math.ceil(JSON.stringify(part.toolCall.args).length / 4) + 20;
      if (part.toolResult) total += Math.ceil(part.toolResult.content.length / 4) + 10;
    }
  }
  return total;
};

const truncateText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated, was ${text.length} chars]`;
};
```

## Config Addition (config/default.toml)
```toml
[plugins.summarization]
enabled = true
trigger_tokens = 80000
keep_messages = 20
max_tool_result_chars = 500
```

## Tests (Vitest)
1. Short conversation → passes through unchanged
2. Long conversation → old messages compressed, recent kept
3. Tool results in old messages get truncated
4. System note injected at boundary
5. keepMessages = 0 → everything compressed except summary note
6. Custom triggerTokens respected
7. Messages array not mutated (returns new array)
8. Empty messages → passes through

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
