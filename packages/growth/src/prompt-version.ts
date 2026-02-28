import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PromptVersion } from "./types.js";

interface PromptVersionManagerOptions {
  filePath: string;
}

export class PromptVersionManager {
  constructor(private readonly opts: PromptVersionManagerOptions) {}

  async save(prompt: string): Promise<PromptVersion> {
    const history = await this.history();
    const version: PromptVersion = {
      id: randomUUID(),
      prompt,
      hash: createHash("sha256").update(prompt).digest("hex"),
      createdAt: new Date().toISOString(),
    };

    history.push(version);
    await this.writeHistory(history);
    return version;
  }

  async getCurrent(): Promise<PromptVersion | null> {
    const history = await this.history();
    return history.at(-1) ?? null;
  }

  async rollback(versionId: string): Promise<boolean> {
    const history = await this.history();
    const target = history.find((item) => item.id === versionId);
    if (!target) {
      return false;
    }

    await this.save(target.prompt);
    return true;
  }

  async history(): Promise<PromptVersion[]> {
    try {
      const raw = await readFile(this.opts.filePath, "utf8");
      return JSON.parse(raw) as PromptVersion[];
    } catch {
      return [];
    }
  }

  private async writeHistory(history: PromptVersion[]): Promise<void> {
    await mkdir(dirname(this.opts.filePath), { recursive: true });
    await writeFile(this.opts.filePath, JSON.stringify(history, null, 2), "utf8");
  }
}
