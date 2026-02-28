import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunResult } from "@hairy/core";
import type { MemoryEvent } from "./types.js";

interface EpisodicMemoryOptions {
  dataDir: string;
}

export class EpisodicMemory {
  constructor(private readonly opts: EpisodicMemoryOptions) {}

  async logRun(runResult: RunResult): Promise<void> {
    await this.logEvent({
      type: "run",
      timestamp: new Date().toISOString(),
      payload: {
        traceId: runResult.traceId,
        durationMs: runResult.durationMs,
        stopReason: runResult.stopReason,
        toolCalls: runResult.toolCalls.length,
      },
    });
  }

  async logEvent(event: MemoryEvent): Promise<void> {
    const filePath = this.fileForDate(new Date());
    await mkdir(dirname(filePath), { recursive: true });

    const existing = await this.readLines(filePath);
    existing.push(JSON.stringify(event));
    await writeFile(filePath, `${existing.join("\n")}\n`, "utf8");
  }

  async query(filter: (event: MemoryEvent) => boolean): Promise<MemoryEvent[]> {
    const filePath = this.fileForDate(new Date());
    const lines = await this.readLines(filePath);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEvent;
        } catch {
          return null;
        }
      })
      .filter((item): item is MemoryEvent => item !== null)
      .filter(filter);
  }

  async getRecentRuns(n: number): Promise<MemoryEvent[]> {
    const runs = await this.query((event) => event.type === "run");
    return runs.slice(-n);
  }

  private fileForDate(date: Date): string {
    const day = date.toISOString().slice(0, 10);
    return join(this.opts.dataDir, "episodic", `${day}.jsonl`);
  }

  private async readLines(path: string): Promise<string[]> {
    try {
      const raw = await readFile(path, "utf8");
      return raw.split("\n").filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }
}
