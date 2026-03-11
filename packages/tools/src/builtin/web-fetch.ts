import { z } from "zod";
import type { Tool } from "../types.js";

const fetchInputSchema = z.object({
  url: z.string().url(),
  mode: z.enum(["readable", "raw", "markdown"]).optional(),
  maxLength: z.number().int().positive().max(100_000).optional(),
});

/**
 * Fetch a URL and extract readable text content.
 * Strips HTML boilerplate and returns clean text or markdown.
 */
export const createWebFetchTool = (): Tool => ({
  name: "web-fetch",
  description:
    "Fetch a URL and extract its readable content. Use for reading articles, docs, recipes, or any web page someone shares. Returns clean text/markdown.",
  parameters: fetchInputSchema,
  async execute(args) {
    const input = fetchInputSchema.parse(args);
    const maxLen = input.maxLength ?? 30_000;
    const mode = input.mode ?? "readable";

    try {
      const response = await fetch(input.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Betki/1.0; +https://github.com/hairy-agent)",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        return {
          content: `Fetch failed: HTTP ${response.status} ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isHtml = contentType.includes("html");
      const isJson = contentType.includes("json");
      const isPdf = contentType.includes("pdf");

      if (isPdf) {
        return {
          content:
            "This URL points to a PDF. Use the pdf-extract tool instead, or ask the user to paste the text.",
        };
      }

      const raw = await response.text();

      if (isJson) {
        try {
          const parsed = JSON.parse(raw);
          const pretty = JSON.stringify(parsed, null, 2);
          return { content: truncate(pretty, maxLen) };
        } catch {
          return { content: truncate(raw, maxLen) };
        }
      }

      if (!isHtml || mode === "raw") {
        return { content: truncate(raw, maxLen) };
      }

      // Extract readable content from HTML
      const readable = extractReadableContent(raw, input.url);
      return { content: truncate(readable, maxLen) };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Fetch error: ${msg}`, isError: true };
    }
  },
});

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n\n[Truncated — ${text.length} chars total, showing first ${maxLen}]`;
}

/**
 * Lightweight HTML-to-readable-text extractor.
 * No heavy dependencies — uses regex-based extraction good enough for articles.
 */
function extractReadableContent(html: string, _url: string): string {
  // Remove scripts, styles, nav, footer, header, aside
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Extract title
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";

  // Try to find main/article content
  const mainMatch =
    text.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i) ??
    text.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i) ??
    text.match(
      /<div[^>]*(?:class|id)="[^"]*(?:content|article|post|entry|main)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );

  const contentHtml = mainMatch
    ? mainMatch[1]
    : text.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");

  // Convert common HTML to markdown-ish text
  let content = contentHtml;

  // Headings
  content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  content = content.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");

  // Links
  content = content.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Bold/italic
  content = content.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
  content = content.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "_$1_");

  // Lists
  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Paragraphs and line breaks
  content = content.replace(/<br\s*\/?>/gi, "\n");
  content = content.replace(/<\/p>/gi, "\n\n");
  content = content.replace(/<p[^>]*>/gi, "");
  content = content.replace(/<\/div>/gi, "\n");
  content = content.replace(/<div[^>]*>/gi, "");

  // Images — keep alt text
  content = content.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "[Image: $1]");
  content = content.replace(/<img[^>]*>/gi, "");

  // Strip remaining tags
  content = content.replace(/<[^>]+>/g, "");

  // Decode entities
  content = decodeEntities(content);

  // Clean up whitespace
  content = content.replace(/[ \t]+/g, " ");
  content = content.replace(/\n{3,}/g, "\n\n");
  content = content.trim();

  const parts: string[] = [];
  if (title) parts.push(`# ${title}\n`);
  parts.push(content);

  return parts.join("\n");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/gi, "");
}
