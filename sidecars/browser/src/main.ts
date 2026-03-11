import { createInterface } from "node:readline";
import { type JsonRpcRequest, type JsonRpcResponse, failure, success } from "./protocol.js";

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
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

const parseRequest = (line: string): JsonRpcRequest | null => {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest;
    if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const ensureUrl = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("url is required");
  }

  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }

  return parsed.toString();
};

class BrowserRuntime {
  private browser: BrowserLike | null = null;
  private page: PageLike | null = null;

  async navigate(url: string): Promise<{ title: string; text: string }> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await page.title();
    const text = await page.evaluate("document.body?.innerText ?? ''");
    return {
      title,
      text: typeof text === "string" ? text : JSON.stringify(text),
    };
  }

  async screenshot(url?: string): Promise<string> {
    const page = await this.ensurePage();
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    const raw = await page.screenshot({ encoding: "base64", fullPage: true });
    return typeof raw === "string" ? raw : raw.toString("base64");
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    const page = await this.ensurePage();
    await page.type(selector, text);
  }

  async evaluate(script: string): Promise<unknown> {
    const page = await this.ensurePage();
    return await page.evaluate(script);
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
    this.browser = null;
    this.page = null;
  }

  private async ensurePage(): Promise<PageLike> {
    if (!this.page) {
      const mod = (await import("playwright")) as unknown as PlaywrightLike;
      this.browser = await mod.chromium.launch({ headless: true });
      this.page = await this.browser.newPage();
    }

    return this.page;
  }
}

const runtime = new BrowserRuntime();

const writeResponse = (response: JsonRpcResponse): void => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

const handleRequest = async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "health":
        return success(id, { ok: true, sidecar: "browser" });
      case "shutdown":
        await runtime.shutdown();
        return success(id, { ok: true });
      case "browser_navigate": {
        const url = ensureUrl(request.params?.url);
        const result = await runtime.navigate(url);
        return success(id, result);
      }
      case "browser_screenshot": {
        const rawUrl = request.params?.url;
        const url = rawUrl === undefined ? undefined : ensureUrl(rawUrl);
        const base64 = await runtime.screenshot(url);
        return success(id, { base64 });
      }
      case "browser_click": {
        const selector = request.params?.selector;
        if (typeof selector !== "string" || selector.length === 0) {
          return failure(id, "selector is required", -32602);
        }
        await runtime.click(selector);
        return success(id, { ok: true });
      }
      case "browser_type": {
        const selector = request.params?.selector;
        const text = request.params?.text;
        if (typeof selector !== "string" || selector.length === 0) {
          return failure(id, "selector is required", -32602);
        }
        if (typeof text !== "string") {
          return failure(id, "text is required", -32602);
        }
        await runtime.type(selector, text);
        return success(id, { ok: true });
      }
      case "browser_evaluate": {
        const script = request.params?.script;
        if (typeof script !== "string" || script.length === 0) {
          return failure(id, "script is required", -32602);
        }
        const result = await runtime.evaluate(script);
        return success(id, { result });
      }
      default:
        return failure(id, `method not found: ${request.method}`, -32601);
    }
  } catch (error: unknown) {
    return failure(id, error instanceof Error ? error.message : String(error));
  }
};

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

readline.on("line", (line) => {
  void (async () => {
    const request = parseRequest(line.trim());
    if (!request) {
      writeResponse(failure(null, "invalid JSON-RPC request", -32600));
      return;
    }

    const response = await handleRequest(request);
    if (response) {
      writeResponse(response);
    }

    if (request.method === "shutdown") {
      process.exit(0);
    }
  })();
});
