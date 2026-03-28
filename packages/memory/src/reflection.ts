import { randomUUID } from "node:crypto";
import type { SemanticMemory } from "./semantic.js";
import type { ReflectionInput } from "./types.js";

export class ReflectionEngine {
  constructor(private readonly semantic: SemanticMemory) {}

  async reflect(input: ReflectionInput): Promise<string> {
    const { runResult, userMessage } = input;
    const toolCount = runResult.toolCalls.length;
    const durationSec = ((runResult.durationMs ?? 0) / 1000).toFixed(1);
    const responseLen = runResult.response.text.length;

    // Extract tool names used
    const toolNames = [
      ...new Set(
        runResult.toolCalls.map((tc) => {
          if (typeof tc === "string") return tc;
          if (typeof tc === "object" && tc !== null && "name" in tc)
            return (tc as { name: string }).name;
          return "unknown";
        }),
      ),
    ];

    // Build meaningful reflection
    const parts: string[] = [];

    // What was the user asking about?
    const userText =
      typeof userMessage === "object" && userMessage !== null && "content" in userMessage
        ? ((userMessage as { content?: { text?: string } }).content?.text ?? "").slice(0, 200)
        : "";
    if (userText.length > 10) {
      parts.push(`User asked: "${userText.slice(0, 150)}${userText.length > 150 ? "..." : ""}"`);
    }

    // Tools and patterns
    if (toolNames.length > 0) {
      parts.push(`Tools used: ${toolNames.join(", ")} (${toolCount} calls total)`);
    }

    // Performance observations
    if (Number(durationSec) > 60) {
      parts.push(`Slow run: ${durationSec}s — may need optimization or simpler approach.`);
    }
    if (responseLen < 20 && toolCount === 0) {
      parts.push(
        "Very short response with no tool use — may indicate confusion or lack of context.",
      );
    }
    if (toolCount > 15) {
      parts.push(`Heavy tool usage (${toolCount} calls) — consider if approach was efficient.`);
    }

    // Skip trivial reflections (simple greetings, short exchanges)
    if (toolCount === 0 && responseLen < 100 && userText.length < 50) {
      return randomUUID(); // Don't store trivial exchanges
    }

    const reflectionText = parts.join("\n");
    if (reflectionText.length > 0) {
      await this.semantic.store(reflectionText, ["reflection", "run-insight"]);
    }

    return randomUUID();
  }

  async getInsights(topic: string): Promise<string[]> {
    const matches = await this.semantic.search(topic, 5);
    return matches.map((item) => item.content);
  }
}
