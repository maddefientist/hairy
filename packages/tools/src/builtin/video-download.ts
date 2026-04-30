import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "../types.js";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  url: z.string().url().describe("Public URL of the video to download (Instagram, YouTube, TikTok, Twitter/X, etc.)"),
  cookiesFile: z.string().optional().describe("Optional path to a Netscape cookies file for authenticated downloads."),
});

export const createVideoDownloadTool = (): Tool => ({
  name: "video_download",
  description:
    "Download a video from a public URL (Instagram reels/posts, YouTube, TikTok, Twitter/X, etc.) using yt-dlp. " +
    "Returns the local file path of the downloaded video. " +
    "Pass the returned path to video_extract to analyse the content, then use memory_ingest to store insights.",
  parameters: inputSchema,
  timeout_ms: 120_000,
  async execute(args, ctx) {
    const input = inputSchema.parse(args);

    let tmpDir: string | null = null;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), "hairy-dl-"));

      const ytdlpArgs = [
        "--no-playlist",
        "--format", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "--output", join(tmpDir, "%(id)s.%(ext)s"),
        "--no-warnings",
        "--quiet",
      ];

      if (input.cookiesFile) {
        ytdlpArgs.push("--cookies", input.cookiesFile);
      }

      ytdlpArgs.push(input.url);

      await execFileAsync("yt-dlp", ytdlpArgs, { timeout: 110_000 });

      const files = await readdir(tmpDir);
      const videoFile = files.find((f) =>
        [".mp4", ".mkv", ".webm", ".mov"].some((ext) => f.endsWith(ext)),
      );

      if (!videoFile) {
        return { content: "video_download: yt-dlp completed but no video file found", isError: true };
      }

      const filePath = join(tmpDir, videoFile);
      ctx.logger.info({ url: input.url, path: filePath }, "video downloaded");

      return {
        content: JSON.stringify({
          path: filePath,
          filename: videoFile,
          message: "Video downloaded successfully. Pass the path to video_extract to analyse its content.",
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Temp dir is intentionally NOT cleaned up here — video_extract needs the file.
      // The OS will reclaim it on reboot. For longer-lived cleanup, a cron could sweep /tmp/hairy-dl-*.
      return { content: `video_download failed: ${msg}`, isError: true };
    }
  },
});
