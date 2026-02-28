import { z } from "zod";
import type { Tool } from "../types.js";

const searchInputSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(10).optional(),
});

interface DuckResponse {
  Heading?: string;
  AbstractText?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

export const createWebSearchTool = (): Tool => ({
  name: "web-search",
  description: "Search the web with DuckDuckGo instant answer API.",
  parameters: searchInputSchema,
  async execute(args) {
    const input = searchInputSchema.parse(args);

    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");

    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return {
        content: `search failed with ${response.status}`,
        isError: true,
      };
    }

    const payload = (await response.json()) as DuckResponse;
    const results = payload.RelatedTopics ?? [];
    const top = results.slice(0, input.topK ?? 5);

    const lines: string[] = [];
    if (payload.Heading) {
      lines.push(`Heading: ${payload.Heading}`);
    }
    if (payload.AbstractText) {
      lines.push(`Summary: ${payload.AbstractText}`);
    }
    for (const item of top) {
      if (!item.Text) {
        continue;
      }
      lines.push(`- ${item.Text}${item.FirstURL ? ` (${item.FirstURL})` : ""}`);
    }

    return {
      content: lines.join("\n") || "No results",
    };
  },
});
