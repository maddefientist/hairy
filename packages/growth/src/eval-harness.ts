import { randomUUID } from "node:crypto";
import type { RunResult } from "@hairyclaw/core";
import type { EvalScore } from "./types.js";

export class EvalHarness {
  private readonly scores: EvalScore[] = [];

  score(runResult: RunResult): EvalScore {
    let score = 0.5;
    if (runResult.stopReason === "completed") {
      score += 0.2;
    }
    if (runResult.toolCalls.some((call) => call.isError)) {
      score -= 0.2;
    }
    if (runResult.response.text.length > 50) {
      score += 0.1;
    }

    const normalized = Math.max(0, Math.min(1, score));
    const record: EvalScore = {
      id: randomUUID(),
      traceId: runResult.traceId,
      score: normalized,
      createdAt: new Date().toISOString(),
    };

    this.scores.push(record);
    return record;
  }

  getScores(skillId?: string): EvalScore[] {
    if (!skillId) {
      return [...this.scores];
    }
    return this.scores.filter((score) => score.skillId === skillId);
  }

  compare(versionA: string, versionB: string): { versionA: number; versionB: number } {
    const avg = (items: EvalScore[]): number => {
      if (items.length === 0) {
        return 0;
      }
      return items.reduce((sum, item) => sum + item.score, 0) / items.length;
    };

    return {
      versionA: avg(this.scores.filter((item) => item.promptVersionId === versionA)),
      versionB: avg(this.scores.filter((item) => item.promptVersionId === versionB)),
    };
  }
}
