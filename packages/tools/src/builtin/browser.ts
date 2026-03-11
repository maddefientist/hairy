import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { createWebFetchTool } from "./web-fetch.js";

interface BrowserLike {
  newPage(): Promise<PageLike>;
}

interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options?: { encoding?: "base64"; fullPage?: boolean }): Promise<string | Buffer>;
}

interface PlaywrightLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
  };
}

export interface BrowserToolOptions {
  loadPlaywright?: () => Promise<PlaywrightLike>;
  fallbackTool?: Tool;
}

const browserActionSchema = z.object({
  action: z.enum(["navigate", "screenshot", "click", "type", "evaluate"]),
  url: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  script: z.string().optional(),
});

const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[truncated]`;
};

const ensureValidUrl = (value: string): string => {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
};

const toText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
};

const dynamicImport = new Function("m", "return import(m)") as (
  moduleName: string,
) => Promise<unknown>;

const defaultPlaywrightLoader = async (): Promise<PlaywrightLike> => {
  const mod = (await dynamicImport("playwright")) as PlaywrightLike;
  return mod;
};

export const createBrowserTool = (opts: BrowserToolOptions = {}): Tool => {
  const loadPlaywright = opts.loadPlaywright ?? defaultPlaywrightLoader;
  const fallbackTool = opts.fallbackTool ?? createWebFetchTool();

  let pagePromise: Promise<PageLike> | null = null;

  const getPage = async (): Promise<PageLike> => {
    if (!pagePromise) {
      pagePromise = (async () => {
        const playwright = await loadPlaywright();
        const browser = await playwright.chromium.launch({ headless: true });
        return await browser.newPage();
      })();
    }

    return await pagePromise;
  };

  const fallbackNavigate = async (url: string, ctx: ToolContext): Promise<ToolResult> => {
    const result = await fallbackTool.execute({ url, mode: "readable" }, ctx);

    return {
      content: `Playwright unavailable; using web-fetch fallback.\n\n${result.content}`,
      ...(result.isError ? { isError: true } : {}),
    };
  };

  return {
    name: "browser",
    description:
      "Browser automation tool. Actions: navigate, screenshot, click, type, evaluate. Falls back to web-fetch for navigate when browser runtime is unavailable.",
    parameters: browserActionSchema,
    async execute(args, ctx) {
      const input = browserActionSchema.parse(args);

      try {
        if (input.url) {
          ensureValidUrl(input.url);
        }
      } catch (error: unknown) {
        return {
          content: error instanceof Error ? error.message : "invalid URL",
          isError: true,
        };
      }

      let page: PageLike | null = null;
      try {
        page = await getPage();
      } catch {
        page = null;
      }

      if (!page) {
        if (input.action === "navigate" && input.url) {
          return await fallbackNavigate(input.url, ctx);
        }

        return {
          content:
            "Playwright is unavailable in this environment. Only navigate action can fallback via web-fetch.",
          isError: true,
        };
      }

      try {
        switch (input.action) {
          case "navigate": {
            if (!input.url) {
              return { content: "navigate requires url", isError: true };
            }

            await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
            const title = await page.title();
            const text = await page.evaluate("document.body?.innerText ?? ''");
            return {
              content: `Title: ${title}\n\n${truncate(toText(text), 6_000)}`,
            };
          }
          case "screenshot": {
            if (input.url) {
              await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
            }

            const shot = await page.screenshot({ encoding: "base64", fullPage: true });
            const base64 = typeof shot === "string" ? shot : shot.toString("base64");
            return {
              content: base64,
            };
          }
          case "click": {
            if (!input.selector) {
              return { content: "click requires selector", isError: true };
            }
            await page.click(input.selector);
            return { content: `clicked ${input.selector}` };
          }
          case "type": {
            if (!input.selector || input.text === undefined) {
              return { content: "type requires selector and text", isError: true };
            }
            await page.type(input.selector, input.text);
            return { content: `typed into ${input.selector}` };
          }
          case "evaluate": {
            if (!input.script) {
              return { content: "evaluate requires script", isError: true };
            }
            const result = await page.evaluate(input.script);
            return { content: toText(result) };
          }
        }
      } catch (error: unknown) {
        return {
          content: error instanceof Error ? error.message : "browser action failed",
          isError: true,
        };
      }
    },
  };
};
