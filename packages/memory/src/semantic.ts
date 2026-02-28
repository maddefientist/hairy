import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SemanticRecord } from "./types.js";

interface SemanticMemoryOptions {
  filePath: string;
  hiveApiUrl?: string;
}

interface SearchResult extends SemanticRecord {
  score: number;
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
  if (contentTokens.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const token of contentTokens) {
    if (queryTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / contentTokens.length;
};

export class SemanticMemory {
  constructor(private readonly opts: SemanticMemoryOptions) {}

  async store(content: string, tags: string[] = []): Promise<string> {
    if (this.opts.hiveApiUrl) {
      try {
        const response = await fetch(`${this.opts.hiveApiUrl}/knowledge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, tags }),
        });

        if (response.ok) {
          const payload = (await response.json()) as { id?: string };
          if (payload.id) {
            return payload.id;
          }
        }
      } catch {
        // Hive unavailable — fall through to local storage
      }
    }

    const records = await this.readLocal();
    const id = randomUUID();
    records.push({
      id,
      content,
      tags,
      createdAt: new Date().toISOString(),
    });
    await this.writeLocal(records);
    return id;
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (this.opts.hiveApiUrl) {
      try {
        const response = await fetch(`${this.opts.hiveApiUrl}/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, topK }),
        });

        if (response.ok) {
          const payload = (await response.json()) as { items?: SearchResult[] };
          return payload.items ?? [];
        }
      } catch {
        // Hive unavailable — fall through to local search
      }
    }

    const local = await this.readLocal();
    return local
      .map((item) => ({ ...item, score: score(query, item.content) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async feedback(_id: string, _signal: "useful" | "noted" | "wrong"): Promise<void> {
    // Local fallback currently does not persist ranking feedback.
  }

  private async readLocal(): Promise<SemanticRecord[]> {
    try {
      const raw = await readFile(this.opts.filePath, "utf8");
      return JSON.parse(raw) as SemanticRecord[];
    } catch {
      return [];
    }
  }

  private async writeLocal(records: SemanticRecord[]): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true });
    await writeFile(this.opts.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}
