# TASK-05: Structured Long-term Memory with Fact Extraction

## Goal
Add a structured memory layer that extracts and stores discrete facts from conversations, with categories, confidence scores, and deduplication. Inject relevant facts into the system prompt.

## Location
- New file: `packages/memory/src/structured.ts`
- New file: `packages/memory/src/fact-extractor.ts`
- Update: `packages/memory/src/index.ts` (add exports)
- New test: `packages/memory/test/structured.test.ts`
- New test: `packages/memory/test/fact-extractor.test.ts`
- Update: `config/default.toml` (add config section)

## Read First
- `packages/memory/src/semantic.ts` — existing SemanticMemory
- `packages/memory/src/types.ts` — existing memory types
- `packages/memory/src/preloader.ts` — existing memory preload plugin
- `packages/memory/src/conversation.ts` — conversation memory
- `packages/core/src/plugin.ts` — HairyClawPlugin interface
- `packages/core/src/agent-loop.ts` — AgentLoopMessage type

## Design

### Data Model
```typescript
// packages/memory/src/structured.ts

export type FactCategory = "preference" | "knowledge" | "context" | "behavior" | "goal";

export interface Fact {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;        // 0-1
  source: string;            // e.g., "conversation", "reflection"
  createdAt: string;         // ISO timestamp
  lastReferencedAt?: string; // updated when fact is recalled
}

export interface UserContext {
  workContext: string;       // what the user is working on
  personalContext: string;   // personal details/preferences
  topOfMind: string;         // 1-3 sentences of current focus
}

export interface StructuredMemoryData {
  userContext: UserContext;
  facts: Fact[];
  lastUpdated: string;
}
```

### StructuredMemory class
```typescript
export interface StructuredMemoryOptions {
  filePath: string;           // path to memory.json
  maxFacts?: number;          // default: 100
  confidenceThreshold?: number; // default: 0.7 — minimum confidence to store
  maxInjectionChars?: number; // default: 2000 — max chars to inject into prompt
}

export class StructuredMemory {
  constructor(opts: StructuredMemoryOptions);

  async load(): Promise<void>;
  async save(): Promise<void>;

  // Add a fact (deduplicates by normalized content)
  addFact(fact: Omit<Fact, "id" | "createdAt">): Fact | null; // null if duplicate

  // Get facts by category
  getFacts(category?: FactCategory): Fact[];

  // Update user context
  updateUserContext(partial: Partial<UserContext>): void;

  // Get data for prompt injection
  getPromptInjection(): string;  // formatted markdown block

  // Get raw data
  getData(): StructuredMemoryData;

  // Prune old low-confidence facts when over maxFacts
  prune(): number; // returns count pruned
}
```

### Deduplication
Normalize content before comparison: trim whitespace, collapse multiple spaces, lowercase. If a fact with the same normalized content already exists, skip insertion.

### Prompt Injection Format
```markdown
<memory>
## Current Context
- Work: {workContext}
- Personal: {personalContext}
- Focus: {topOfMind}

## Known Facts
- [preference] User prefers TypeScript over Python
- [knowledge] User's project uses pnpm workspaces
- [goal] User wants to ship HairyClaw v1 by March
</memory>
```

### Fact Extractor
```typescript
// packages/memory/src/fact-extractor.ts

// This is a rule-based extractor (no LLM needed).
// Extracts facts from conversation patterns.

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
}

export const extractFacts = (messages: Array<{
  role: string;
  text: string;
}>): ExtractedFact[]
```

Extraction rules:
1. **Preferences** — detect "I prefer", "I like", "I use", "my favorite" → confidence 0.8
2. **Knowledge** — detect "I work on", "my project", "our stack", "we use" → confidence 0.75
3. **Goals** — detect "I want to", "I need to", "goal is", "plan to" → confidence 0.7
4. **Context** — detect "I'm working on", "currently", "right now" → confidence 0.7
5. **Behavior** — detect "I always", "I usually", "I never" → confidence 0.75

Keep the extractor simple and high-precision (few false positives). Better to miss facts than to store noise.

### Memory Update Plugin
Create a plugin that runs fact extraction on conversation end:
```typescript
export const createMemoryUpdatePlugin = (memory: StructuredMemory): HairyClawPlugin => ({
  name: "memory_update",
  onRunEnd: async (ctx, result) => {
    // Extract user messages from the run
    // Run fact extraction
    // Add new facts to structured memory
    // Save (debounced — don't block the response)
  }
});
```

## Config Addition (config/default.toml)
```toml
[memory.structured]
enabled = true
file_path = "./data/memory/structured.json"
max_facts = 100
confidence_threshold = 0.7
max_injection_chars = 2000
```

## Tests

### structured.test.ts
1. Load/save cycle preserves data
2. addFact creates fact with id and timestamp
3. Duplicate detection (same content, different casing)
4. getFacts filters by category
5. updateUserContext merges partial updates
6. getPromptInjection formats correctly within char limit
7. prune removes lowest-confidence facts when over limit
8. Max facts enforced on insertion

### fact-extractor.test.ts
1. "I prefer TypeScript" → preference fact
2. "We use pnpm workspaces" → knowledge fact
3. "I want to ship by March" → goal fact
4. "I'm working on an agent framework" → context fact
5. "I always test my code" → behavior fact
6. Generic statement → no facts extracted
7. Multiple patterns in one message → multiple facts
8. Confidence scores within expected ranges

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
