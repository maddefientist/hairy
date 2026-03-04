/**
 * Local file-backed memory backend.
 * Zero external dependencies — works immediately on `git clone`.
 * Stores records as JSON, uses keyword overlap scoring for search.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryBackend, SearchResult, SemanticRecord } from "../types.js";

interface LocalBackendOptions {
  filePath: string;
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);

const score = (query: string, content: string): number => {
  const queryTokens = new Set(tokenize(query));
  const contentTokens = tokenize(content);
  if (contentTokens.length === 0) return 0;

  let hits = 0;
  for (const token of contentTokens) {
    if (queryTokens.has(token)) hits += 1;
  }
  return hits / contentTokens.length;
};

export class LocalMemoryBackend implements MemoryBackend {
  readonly name = "local";
  private readonly filePath: string;

  constructor(opts: LocalBackendOptions) {
    this.filePath = opts.filePath;
  }

  async store(content: string, tags: string[] = []): Promise<string> {
    const records = await this.read();
    const id = randomUUID();
    records.push({ id, content, tags, createdAt: new Date().toISOString() });
    await this.write(records);
    return id;
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const records = await this.read();
    return records
      .map((r) => ({ ...r, score: score(query, r.content) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ── internal ──────────────────────────────────────────────────────────

  private async read(): Promise<SemanticRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as SemanticRecord[];
    } catch {
      return [];
    }
  }

  private async write(records: SemanticRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}
