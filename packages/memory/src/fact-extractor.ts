/**
 * Rule-based fact extractor — extracts discrete facts from conversation messages.
 *
 * No LLM needed. High-precision, low-recall approach:
 * better to miss facts than store noise.
 */

import type { FactCategory } from "./structured.js";

export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
}

interface ExtractionRule {
  category: FactCategory;
  patterns: RegExp[];
  confidence: number;
}

const EXTRACTION_RULES: ExtractionRule[] = [
  {
    category: "preference",
    patterns: [
      /\bi\s+prefer\s+(.+?)(?:\.|$)/i,
      /\bi\s+like\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\.|$)/i,
      /\bi\s+use\s+(.+?)(?:\.|$)/i,
      /\bmy\s+favorite\s+(.+?)(?:\.|$)/i,
    ],
    confidence: 0.8,
  },
  {
    category: "knowledge",
    patterns: [
      /\bi\s+work\s+on\s+(.+?)(?:\.|$)/i,
      /\bmy\s+project\s+(.+?)(?:\.|$)/i,
      /\bour\s+stack\s+(.+?)(?:\.|$)/i,
      /\bwe\s+use\s+(.+?)(?:\.|$)/i,
    ],
    confidence: 0.75,
  },
  {
    category: "goal",
    patterns: [
      /\bi\s+want\s+to\s+(.+?)(?:\.|$)/i,
      /\bi\s+need\s+to\s+(.+?)(?:\.|$)/i,
      /\bgoal\s+is\s+(?:to\s+)?(.+?)(?:\.|$)/i,
      /\bplan\s+to\s+(.+?)(?:\.|$)/i,
    ],
    confidence: 0.7,
  },
  {
    category: "context",
    patterns: [
      /\bi'?m\s+working\s+on\s+(.+?)(?:\.|$)/i,
      /\bcurrently\s+(.+?)(?:\.|$)/i,
      /\bright\s+now\s+(.+?)(?:\.|$)/i,
    ],
    confidence: 0.7,
  },
  {
    category: "behavior",
    patterns: [
      /\bi\s+always\s+(.+?)(?:\.|$)/i,
      /\bi\s+usually\s+(.+?)(?:\.|$)/i,
      /\bi\s+never\s+(.+?)(?:\.|$)/i,
    ],
    confidence: 0.75,
  },
];

/**
 * Extract facts from a list of conversation messages.
 *
 * Only processes user messages (role === "user").
 * Returns deduplicated facts with category and confidence.
 */
export const extractFacts = (messages: Array<{ role: string; text: string }>): ExtractedFact[] => {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }

    for (const rule of EXTRACTION_RULES) {
      for (const pattern of rule.patterns) {
        const match = pattern.exec(text);
        if (!match) {
          continue;
        }

        // Use the full matched portion as the fact content
        const fullMatch = match[0].trim();
        if (fullMatch.length < 5) {
          continue; // Skip trivially short matches
        }

        // Normalize for dedup
        const normalized = fullMatch.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        facts.push({
          content: fullMatch,
          category: rule.category,
          confidence: rule.confidence,
        });
      }
    }
  }

  return facts;
};
