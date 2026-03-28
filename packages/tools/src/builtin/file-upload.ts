/**
 * File Upload Tool — list files uploaded to the current conversation.
 *
 * Allows the agent to discover what files the user has uploaded
 * and see their metadata (name, type, size, conversion status).
 */

import type { UploadedFile } from "@hairyclaw/memory";
import { z } from "zod";
import type { Tool } from "../types.js";

export const createFileUploadTool = (getUploads: () => UploadedFile[]): Tool => ({
  name: "list_uploads",
  description: "List files that have been uploaded to this conversation",
  parameters: z.object({}),
  async execute() {
    const uploads = getUploads();
    if (uploads.length === 0) {
      return { content: "No files have been uploaded." };
    }

    const lines = uploads.map(
      (f) =>
        `- ${f.originalName} (${f.mimeType}, ${(f.sizeBytes / 1024).toFixed(1)}KB)${f.convertedText ? " [converted]" : ""}`,
    );
    return { content: `Uploaded files:\n${lines.join("\n")}` };
  },
});
