# CONTEXT

## Current Task
Framework stabilization and public release preparation.

## Recent Decisions
- Memory backend abstracted behind `MemoryBackend` interface (local default, hive optional)
- Tools renamed from `hive_recall`/`hive_ingest` → `memory_recall`/`memory_ingest` (backend-agnostic)
- Added Google Gemini provider (native REST API, no SDK dep)
- Rewrote Ollama provider to use `/api/chat` with tool calling support
- Four providers: Anthropic, Gemini, OpenRouter, Ollama

## Next Steps
- Add more memory backend implementations (ChromaDB, SQLite+embeddings)
- Streaming support for Ollama and Gemini providers
- Docker compose for one-command deployment
- CI pipeline (GitHub Actions)
