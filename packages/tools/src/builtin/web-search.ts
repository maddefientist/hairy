import { z } from "zod";
import type { Tool } from "../types.js";

const searchInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(20).optional(),
  categories: z
    .enum(["general", "images", "news", "science", "it", "files", "music", "social media"])
    .optional(),
  language: z.string().optional(),
});

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  publishedDate?: string;
  score?: number;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
  answers?: string[];
  infoboxes?: Array<{
    infobox?: string;
    content?: string;
    urls?: Array<{ title?: string; url?: string }>;
  }>;
  suggestions?: string[];
  query?: string;
  number_of_results?: number;
}

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";

/**
 * Web search via SearXNG (self-hosted meta-search engine).
 * Falls back to DuckDuckGo instant-answer API if SearXNG is unreachable.
 */
export const createWebSearchTool = (): Tool => ({
  name: "web-search",
  description:
    "Search the web using SearXNG (aggregates Google, DuckDuckGo, Brave, Wikipedia, Reddit, StackOverflow, GitHub, arXiv). Returns titles, snippets, and URLs.",
  parameters: searchInputSchema,
  async execute(args) {
    const input = searchInputSchema.parse(args);
    const searxngUrl = process.env.SEARXNG_URL ?? DEFAULT_SEARXNG_URL;
    const topK = input.topK ?? 8;

    try {
      return await searchSearXNG(searxngUrl, input.query, topK, input.categories, input.language);
    } catch {
      // SearXNG unreachable — fall back to DuckDuckGo
      try {
        return await searchDuckDuckGo(input.query, topK);
      } catch {
        return { content: "Both SearXNG and DuckDuckGo search failed.", isError: true };
      }
    }
  },
});

async function searchSearXNG(
  baseUrl: string,
  query: string,
  topK: number,
  categories?: string,
  language?: string,
): Promise<{ content: string; isError?: boolean }> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (categories) url.searchParams.set("categories", categories);
  if (language) url.searchParams.set("language", language);

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG returned ${response.status}`);
  }

  const payload = (await response.json()) as SearXNGResponse;
  const lines: string[] = [];

  // Direct answers (highest quality)
  if (payload.answers && payload.answers.length > 0) {
    lines.push("## Direct Answers");
    for (const answer of payload.answers) {
      lines.push(`> ${answer}`);
    }
    lines.push("");
  }

  // Infoboxes
  if (payload.infoboxes && payload.infoboxes.length > 0) {
    for (const box of payload.infoboxes.slice(0, 2)) {
      if (box.infobox) lines.push(`## ${box.infobox}`);
      if (box.content) lines.push(box.content.slice(0, 500));
      if (box.urls) {
        for (const u of box.urls.slice(0, 3)) {
          lines.push(`- [${u.title ?? "link"}](${u.url})`);
        }
      }
      lines.push("");
    }
  }

  // Main results
  const results = (payload.results ?? []).slice(0, topK);
  if (results.length > 0) {
    lines.push(`## Results (${payload.number_of_results ?? results.length} total)`);
    for (const r of results) {
      const title = r.title ?? "Untitled";
      const snippet = r.content ?? "";
      const source = r.engine ?? "";
      const date = r.publishedDate ? ` (${r.publishedDate})` : "";
      lines.push(`### ${title}${date}`);
      if (r.url) lines.push(r.url);
      if (snippet) lines.push(snippet.slice(0, 400));
      if (source) lines.push(`_via ${source}_`);
      lines.push("");
    }
  }

  // Suggestions
  if (payload.suggestions && payload.suggestions.length > 0) {
    lines.push(`**Related searches:** ${payload.suggestions.slice(0, 5).join(", ")}`);
  }

  return { content: lines.join("\n") || "No results found." };
}

async function searchDuckDuckGo(
  query: string,
  topK: number,
): Promise<{ content: string; isError?: boolean }> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results = payload.RelatedTopics ?? [];
  const top = results.slice(0, topK);
  const lines: string[] = [];

  if (payload.Heading) lines.push(`Heading: ${payload.Heading}`);
  if (payload.AbstractText) lines.push(`Summary: ${payload.AbstractText}`);
  for (const item of top) {
    if (!item.Text) continue;
    lines.push(`- ${item.Text}${item.FirstURL ? ` (${item.FirstURL})` : ""}`);
  }

  return { content: lines.join("\n") || "No results" };
}
