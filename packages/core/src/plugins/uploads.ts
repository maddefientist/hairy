/**
 * Uploads Plugin — injects uploaded file context into the system prompt.
 *
 * When files are uploaded to a thread, this plugin appends a summary
 * of available files to the system prompt so the model knows about them.
 *
 * Uses a minimal interface to avoid circular dependency with @hairyclaw/memory.
 * The UploadManager from @hairyclaw/memory satisfies UploadsPromptProvider.
 */

import type { HairyClawPlugin } from "../plugin.js";

/** Minimal interface — satisfied by UploadManager from @hairyclaw/memory */
export interface UploadsPromptProvider {
  getPromptContext(threadId: string): string;
}

export interface UploadsPluginOptions {
  uploadManager: UploadsPromptProvider;
  threadId: string;
  maxInjectionChars?: number;
}

const DEFAULT_MAX_INJECTION_CHARS = 500;

export const createUploadsPlugin = (opts: UploadsPluginOptions): HairyClawPlugin => ({
  name: "uploads",
  beforeModel: async (messages, streamOpts) => {
    const context = opts.uploadManager.getPromptContext(opts.threadId);
    if (!context) {
      return { messages, opts: streamOpts };
    }

    const maxChars = opts.maxInjectionChars ?? DEFAULT_MAX_INJECTION_CHARS;
    const trimmed = context.length > maxChars ? context.slice(0, maxChars) : context;

    const existing = streamOpts.systemPrompt?.trim() ?? "";
    const systemPrompt = existing.length > 0 ? `${existing}\n\n${trimmed}` : trimmed;

    return {
      messages,
      opts: { ...streamOpts, systemPrompt },
    };
  },
});
