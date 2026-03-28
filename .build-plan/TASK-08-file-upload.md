# TASK-08: File Upload & Document Conversion Pipeline

## Goal
Add file upload support with automatic document conversion (PDF, DOCX, XLSX → plaintext), thread-isolated storage, and system prompt injection of uploaded file list.

## Location
- New file: `packages/tools/src/builtin/file-upload.ts`
- New file: `packages/memory/src/uploads.ts`
- New file: `packages/core/src/plugins/uploads.ts`
- Update: `packages/tools/src/index.ts` (add export)
- Update: `packages/memory/src/index.ts` (add export)
- Update: `packages/core/src/index.ts` (add export)
- New test: `packages/memory/test/uploads.test.ts`
- New test: `packages/core/test/uploads.test.ts`
- Update: `config/default.toml` (add uploads section)

## Read First
- `packages/tools/src/builtin/read.ts` — existing file read tool
- `packages/tools/src/types.ts` — Tool interface
- `packages/memory/src/preloader.ts` — existing preload plugin pattern
- `packages/core/src/plugin.ts` — HairyClawPlugin interface
- `packages/channels/src/types.ts` — (for future: channel adapters already support attachments)

## Design

### Upload Manager
```typescript
// packages/memory/src/uploads.ts

export interface UploadedFile {
  id: string;
  originalName: string;
  storedPath: string;       // physical path
  virtualPath: string;      // e.g., "/uploads/report.pdf"
  mimeType: string;
  sizeBytes: number;
  convertedPath?: string;   // path to plaintext conversion
  convertedText?: string;   // inline text for small files
  uploadedAt: string;
}

export interface UploadManagerOptions {
  baseDir: string;          // e.g., "data/uploads"
  maxFileSizeMb?: number;   // default: 50
  maxFilesPerThread?: number; // default: 20
  convertDocuments?: boolean; // default: true
}

export class UploadManager {
  constructor(opts: UploadManagerOptions);

  // Store a file for a thread
  async upload(threadId: string, fileName: string, content: Buffer, mimeType: string): Promise<UploadedFile>;

  // List uploads for a thread
  list(threadId: string): UploadedFile[];

  // Delete an upload
  async delete(threadId: string, fileId: string): Promise<boolean>;

  // Get formatted file list for prompt injection
  getPromptContext(threadId: string): string;
}
```

### Document Conversion
For document conversion, use shell commands (no heavy npm dependencies):
- **PDF**: `pdftotext` (from poppler-utils) if available, otherwise skip
- **DOCX/XLSX/PPTX**: Use `unzip` to extract XML content, parse text from it
- **Plain text**: No conversion needed (.txt, .md, .json, .ts, .py, etc.)
- **Images**: Store as-is, note in prompt as "[image file]"

```typescript
// packages/memory/src/uploads.ts (internal function)

const convertDocument = async (filePath: string, mimeType: string): Promise<string | null> => {
  // PDF: try pdftotext
  if (mimeType === "application/pdf") {
    try {
      const { stdout } = await execAsync(`pdftotext "${filePath}" -`, { timeout: 30000, maxBuffer: 5_000_000 });
      return stdout;
    } catch { return null; }
  }

  // Text-based files: read directly
  if (mimeType.startsWith("text/") || isTextMime(mimeType)) {
    const content = await readFile(filePath, "utf8");
    return content;
  }

  // DOCX: extract from word/document.xml
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const { stdout } = await execAsync(`unzip -p "${filePath}" word/document.xml | sed 's/<[^>]*>//g'`, { timeout: 15000 });
      return stdout.trim();
    } catch { return null; }
  }

  return null;
};

const isTextMime = (mime: string): boolean => {
  const textMimes = [
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
  ];
  return textMimes.includes(mime);
};
```

### Upload Plugin
```typescript
// packages/core/src/plugins/uploads.ts

export interface UploadsPluginOptions {
  uploadManager: UploadManager;
  threadId: string;         // current thread
  maxInjectionChars?: number; // default: 500
}

export const createUploadsPlugin = (opts: UploadsPluginOptions): HairyClawPlugin => ({
  name: "uploads",
  beforeModel: async (messages, streamOpts) => {
    const context = opts.uploadManager.getPromptContext(opts.threadId);
    if (!context) return { messages, opts: streamOpts };

    const existing = streamOpts.systemPrompt?.trim() ?? "";
    const systemPrompt = existing.length > 0
      ? `${existing}\n\n${context}`
      : context;

    return {
      messages,
      opts: { ...streamOpts, systemPrompt },
    };
  },
});
```

### Upload Tool
```typescript
// packages/tools/src/builtin/file-upload.ts
// This tool allows the agent to list and read uploaded files

export const createFileUploadTool = (getUploads: () => UploadedFile[]): Tool => ({
  name: "list_uploads",
  description: "List files that have been uploaded to this conversation",
  parameters: z.object({}),
  async execute() {
    const uploads = getUploads();
    if (uploads.length === 0) return { content: "No files have been uploaded." };
    const lines = uploads.map(f =>
      `- ${f.originalName} (${f.mimeType}, ${(f.sizeBytes / 1024).toFixed(1)}KB)${f.convertedText ? " [converted]" : ""}`
    );
    return { content: `Uploaded files:\n${lines.join("\n")}` };
  }
});
```

### Prompt Context Format
```
## Uploaded Files
The following files are available in this conversation:
- report.pdf (application/pdf, 245.3KB) [converted to text]
- data.csv (text/csv, 12.1KB) [readable]
- screenshot.png (image/png, 1.2MB) [image]

Use the read tool with virtual path /uploads/{filename} to access file contents.
```

## Config Addition (config/default.toml)
```toml
[uploads]
enabled = true
base_dir = "./data/uploads"
max_file_size_mb = 50
max_files_per_thread = 20
convert_documents = true
```

## Tests

### uploads.test.ts (packages/memory/)
1. Upload stores file in thread directory
2. Upload with conversion extracts text
3. List returns all uploads for thread
4. Delete removes file and metadata
5. Different threads isolated
6. Max files per thread enforced
7. Max file size enforced (reject oversized)
8. getPromptContext formats file list correctly
9. Text files read directly without conversion
10. Unknown mime types stored but not converted

### uploads.test.ts (packages/core/)
1. Plugin injects upload context into system prompt
2. Plugin does nothing when no uploads
3. Plugin respects maxInjectionChars

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
