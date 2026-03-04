# Memory Backends

Hairy's semantic memory uses a pluggable `MemoryBackend` interface. The agent works immediately with the local backend — no external infrastructure required.

## Available Backends

### Local (default)

- **File**: `data/memory/semantic.json`
- **Search**: Keyword overlap scoring (bag-of-words)
- **Dependencies**: None
- **Setup**: Nothing — it's the default

Good for: development, small deployments, privacy-sensitive use cases.

### Hive (optional)

Connects to an [agentssot](https://github.com/maddefientist/agentssot) instance for embedding-based semantic search.

```bash
export HARI_HIVE_URL=http://localhost:8088
export HARI_HIVE_API_KEY=your-key
export HARI_HIVE_NAMESPACE=my-agent

# Optional: separate read/write keys and namespaces
export HARI_HIVE_READ_API_KEY=read-only-key
export HARI_HIVE_WRITE_API_KEY=write-key
export HARI_HIVE_READ_NAMESPACES=ns1,ns2,shared
export HARI_HIVE_WRITE_NAMESPACE=my-agent
export HARI_HIVE_DEVICE=my-agent-01
```

Good for: production deployments, multi-agent setups, cross-session memory.

### Bring Your Own

Implement the `MemoryBackend` interface:

```typescript
import type { MemoryBackend, SearchResult } from "@hairy/memory";

export class MyCustomBackend implements MemoryBackend {
  readonly name = "my-backend";

  async store(content: string, tags?: string[]): Promise<string> {
    // Store content, return an ID
  }

  async search(query: string, topK?: number): Promise<SearchResult[]> {
    // Search and return ranked results
  }

  // Optional
  async feedback?(id: string, signal: "useful" | "noted" | "wrong"): Promise<void> {
    // Signal relevance feedback
  }
}
```

Then pass it to `SemanticMemory`:

```typescript
const backend = new MyCustomBackend({ /* config */ });
const semantic = new SemanticMemory({ filePath: "fallback.json", backend });
```

## How Backend Selection Works

`createMemoryBackend()` checks in order:

1. Explicit `hive` options passed in code → `HiveMemoryBackend`
2. `HARI_HIVE_URL` env var set → `HiveMemoryBackend`
3. Otherwise → `LocalMemoryBackend`

`SemanticMemory` wraps the chosen backend with automatic fallback: if the remote backend throws (network error), it falls back to the local JSON file silently.

## Tools

The `memory_recall` and `memory_ingest` tools are backend-agnostic. They call whatever `MemoryBackend` is active:

```
memory_recall  — semantic search across stored knowledge
memory_ingest  — store new knowledge for future recall
```

No vendor-specific tool names or APIs are exposed to the LLM.
