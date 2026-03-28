/**
 * Upload Manager — thread-isolated file storage with automatic document conversion.
 *
 * Stores uploaded files per-thread, optionally converts documents (PDF, DOCX)
 * to plaintext, and provides prompt context injection for the agent.
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface UploadedFile {
  id: string;
  originalName: string;
  storedPath: string;
  virtualPath: string;
  mimeType: string;
  sizeBytes: number;
  convertedPath?: string;
  convertedText?: string;
  uploadedAt: string;
}

export interface UploadManagerOptions {
  baseDir: string;
  maxFileSizeMb?: number;
  maxFilesPerThread?: number;
  convertDocuments?: boolean;
}

const DEFAULT_MAX_FILE_SIZE_MB = 50;
const DEFAULT_MAX_FILES_PER_THREAD = 20;

const TEXT_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
]);

const isTextMime = (mime: string): boolean => mime.startsWith("text/") || TEXT_MIMES.has(mime);

const isImageMime = (mime: string): boolean => mime.startsWith("image/");

const convertDocument = async (filePath: string, mimeType: string): Promise<string | null> => {
  // PDF: try pdftotext
  if (mimeType === "application/pdf") {
    try {
      const { stdout } = await execAsync(`pdftotext "${filePath}" -`, {
        timeout: 30_000,
        maxBuffer: 5_000_000,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  // Text-based files: read directly
  if (isTextMime(mimeType)) {
    const content = await readFile(filePath, "utf8");
    return content;
  }

  // DOCX: extract from word/document.xml
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const { stdout } = await execAsync(
        `unzip -p "${filePath}" word/document.xml | sed 's/<[^>]*>//g'`,
        { timeout: 15_000 },
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  return null;
};

const fileLabel = (upload: UploadedFile): string => {
  const sizeKb = (upload.sizeBytes / 1024).toFixed(1);
  let tag = "";

  if (upload.convertedText !== undefined) {
    tag = " [converted to text]";
  } else if (isImageMime(upload.mimeType)) {
    tag = " [image]";
  } else if (isTextMime(upload.mimeType)) {
    tag = " [readable]";
  }

  return `- ${upload.originalName} (${upload.mimeType}, ${sizeKb}KB)${tag}`;
};

export class UploadManager {
  private readonly baseDir: string;
  private readonly maxFileSizeMb: number;
  private readonly maxFilesPerThread: number;
  private readonly convertDocuments: boolean;

  /** In-memory map: threadId → UploadedFile[] */
  private readonly threads = new Map<string, UploadedFile[]>();

  constructor(opts: UploadManagerOptions) {
    this.baseDir = opts.baseDir;
    this.maxFileSizeMb = opts.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
    this.maxFilesPerThread = opts.maxFilesPerThread ?? DEFAULT_MAX_FILES_PER_THREAD;
    this.convertDocuments = opts.convertDocuments ?? true;
  }

  async upload(
    threadId: string,
    fileName: string,
    content: Buffer,
    mimeType: string,
  ): Promise<UploadedFile> {
    const maxBytes = this.maxFileSizeMb * 1024 * 1024;
    if (content.length > maxBytes) {
      throw new Error(
        `File exceeds maximum size of ${this.maxFileSizeMb}MB (got ${(content.length / 1024 / 1024).toFixed(1)}MB)`,
      );
    }

    const existing = this.threads.get(threadId) ?? [];
    if (existing.length >= this.maxFilesPerThread) {
      throw new Error(`Thread has reached the maximum of ${this.maxFilesPerThread} uploaded files`);
    }

    const id = randomUUID();
    const threadDir = join(this.baseDir, threadId);
    await mkdir(threadDir, { recursive: true });

    const storedPath = join(threadDir, `${id}-${fileName}`);
    await writeFile(storedPath, content);

    const virtualPath = `/uploads/${fileName}`;

    let convertedText: string | undefined;
    let convertedPath: string | undefined;

    if (this.convertDocuments) {
      const text = await convertDocument(storedPath, mimeType);
      if (text !== null) {
        convertedText = text;
        const convertedFilePath = join(threadDir, `${id}-${fileName}.txt`);
        await writeFile(convertedFilePath, text, "utf8");
        convertedPath = convertedFilePath;
      }
    }

    const uploaded: UploadedFile = {
      id,
      originalName: fileName,
      storedPath,
      virtualPath,
      mimeType,
      sizeBytes: content.length,
      convertedPath,
      convertedText,
      uploadedAt: new Date().toISOString(),
    };

    existing.push(uploaded);
    this.threads.set(threadId, existing);

    return uploaded;
  }

  list(threadId: string): UploadedFile[] {
    return this.threads.get(threadId) ?? [];
  }

  async delete(threadId: string, fileId: string): Promise<boolean> {
    const uploads = this.threads.get(threadId);
    if (!uploads) {
      return false;
    }

    const index = uploads.findIndex((f) => f.id === fileId);
    if (index === -1) {
      return false;
    }

    const file = uploads[index];

    try {
      await rm(file.storedPath, { force: true });
      if (file.convertedPath) {
        await rm(file.convertedPath, { force: true });
      }
    } catch {
      // Best-effort cleanup — file may already be gone
    }

    uploads.splice(index, 1);
    return true;
  }

  getPromptContext(threadId: string): string {
    const uploads = this.list(threadId);
    if (uploads.length === 0) {
      return "";
    }

    const lines = uploads.map(fileLabel);
    return [
      "## Uploaded Files",
      "The following files are available in this conversation:",
      ...lines,
      "",
      "Use the read tool with virtual path /uploads/{filename} to access file contents.",
    ].join("\n");
  }
}
