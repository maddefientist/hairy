import { randomUUID } from "node:crypto";
import type { SemanticMemory } from "./semantic.js";
import type { ReflectionInput } from "./types.js";

export class ReflectionEngine {
  constructor(private readonly semantic: SemanticMemory) {}

  async reflect(input: ReflectionInput): Promise<string> {
    const toolCount = input.runResult.toolCalls.length;
    const stopReason = input.runResult.stopReason;
    const summary = `Run ${input.runResult.traceId} finished with ${toolCount} tool calls and stop reason '${stopReason}'.`;

    const learnedPatterns: string[] = [];
    if (toolCount > 0) {
      learnedPatterns.push("Tool usage was required for this run.");
    }
    if (input.runResult.response.text.length < 20) {
      learnedPatterns.push("Response might be too short; check answer completeness.");
    }

    const reflectionText = [summary, ...learnedPatterns].join("\n");
    await this.semantic.store(reflectionText, ["reflection", "run"]);

    return randomUUID();
  }

  async getInsights(topic: string): Promise<string[]> {
    const matches = await this.semantic.search(topic, 5);
    return matches.map((item) => item.content);
  }
}
