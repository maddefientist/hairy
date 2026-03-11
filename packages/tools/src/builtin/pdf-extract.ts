import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import type { Tool } from "../types.js";

const pdfInputSchema = z.object({
  source: z.string().describe("URL to a PDF file, or a local file path."),
  maxLength: z.number().int().positive().max(100_000).optional(),
});

/**
 * Extract text from PDFs — either from a URL or local file path.
 */
export const createPdfExtractTool = (): Tool => ({
  name: "pdf-extract",
  description:
    "Extract text content from a PDF file. Accepts a URL or local file path. Returns the readable text from the document.",
  parameters: pdfInputSchema,
  async execute(args) {
    const input = pdfInputSchema.parse(args);
    const maxLen = input.maxLength ?? 50_000;

    try {
      let buffer: Buffer;

      if (input.source.startsWith("http://") || input.source.startsWith("https://")) {
        const response = await fetch(input.source, {
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; Betki/1.0)",
            accept: "application/pdf,*/*",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          return { content: `Failed to download PDF: HTTP ${response.status}`, isError: true };
        }

        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        buffer = await readFile(input.source);
      }

      const text = extractTextFromPdf(buffer);

      if (!text || text.trim().length === 0) {
        return {
          content:
            "Could not extract text from this PDF. It may be image-based (scanned) or encrypted. Try: bash with pdftotext if available on system.",
        };
      }

      return { content: truncate(text.trim(), maxLen) };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `PDF extraction error: ${msg}`, isError: true };
    }
  },
});

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n\n[Truncated — ${text.length} chars total, showing first ${maxLen}]`;
}

function extractTextFromPdf(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const textParts: string[] = [];

  // Find all stream...endstream blocks
  for (const streamBlock of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const streamContent = streamBlock[1];

    let decoded: string;
    try {
      const first = streamContent.charCodeAt(0);
      const second = streamContent.charCodeAt(1);
      if (first === 0x78 && (second === 0x9c || second === 0x01 || second === 0xda)) {
        const inflated = inflateSync(Buffer.from(streamContent, "latin1"));
        decoded = inflated.toString("utf8");
      } else {
        decoded = streamContent;
      }
    } catch {
      decoded = streamContent;
    }

    // Extract text from BT...ET blocks
    for (const btBlock of decoded.matchAll(/BT\s([\s\S]*?)ET/g)) {
      const block = btBlock[1];

      // Tj operator: (text) Tj
      for (const tj of block.matchAll(/\(([^)]*)\)\s*Tj/g)) {
        textParts.push(decodePdfString(tj[1]));
      }

      // TJ array: [(text) kerning (text)] TJ
      for (const tjArr of block.matchAll(/\[((?:\([^)]*\)|[^\]])*?)\]\s*TJ/g)) {
        const inner = tjArr[1];
        for (const str of inner.matchAll(/\(([^)]*)\)/g)) {
          textParts.push(decodePdfString(str[1]));
        }
      }

      // ' operator: (text) '
      for (const q of block.matchAll(/\(([^)]*)\)\s*'/g)) {
        textParts.push(decodePdfString(q[1]));
      }
    }
  }

  let result = textParts.join(" ");
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/\.\s+([A-Z])/g, ".\n\n$1");
  return result;
}

function decodePdfString(str: string): string {
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
