import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConversationEntry } from "./types.js";

interface ConversationMemoryOptions {
  filePath: string;
  maxEntries?: number;
}

export class ConversationMemory {
  private readonly maxEntries: number;

  constructor(private readonly opts: ConversationMemoryOptions) {
    this.maxEntries = opts.maxEntries ?? 200;
  }

  async append(entry: ConversationEntry): Promise<void> {
    const history = await this.getHistory(this.maxEntries);
    history.push(entry);
    const trimmed = history.slice(-this.maxEntries);
    await this.writeAll(trimmed);
  }

  async getContext(maxTokens = 4000): Promise<ConversationEntry[]> {
    const history = await this.getHistory(this.maxEntries);
    const result: ConversationEntry[] = [];
    let tokenBudget = 0;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
      const text = "content" in item ? (item.content.text ?? "") : item.text;
      const estimate = Math.ceil(text.length / 4);
      if (tokenBudget + estimate > maxTokens) {
        break;
      }
      tokenBudget += estimate;
      result.unshift(item);
    }

    return result;
  }

  async compact(summary: string): Promise<void> {
    const compacted: ConversationEntry = {
      role: "assistant",
      text: `Context summary: ${summary}`,
      timestamp: new Date().toISOString(),
    };
    await this.writeAll([compacted]);
  }

  async clear(): Promise<void> {
    await this.writeAll([]);
  }

  async getHistory(limit = 100): Promise<ConversationEntry[]> {
    try {
      const raw = await readFile(this.opts.filePath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const parsed = lines
        .map((line) => {
          try {
            return JSON.parse(line) as ConversationEntry;
          } catch {
            return null;
          }
        })
        .filter((line): line is ConversationEntry => line !== null);
      return parsed.slice(-limit);
    } catch {
      return [];
    }
  }

  private async writeAll(entries: ConversationEntry[]): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true });
    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.opts.filePath, payload.length > 0 ? `${payload}\n` : "", "utf8");
  }
}
