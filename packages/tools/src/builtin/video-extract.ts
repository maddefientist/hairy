import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "../types.js";

const execFileAsync = promisify(execFile);

const videoInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path to the video file to analyse."),
  frames: z.number().int().min(1).max(10).default(4).optional().describe("Number of frames to extract (1–10, default 4)."),
});

const probeVideo = async (path: string): Promise<{ duration: string; codec: string; width: number; height: number } | null> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      path,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; duration?: string }> };
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    if (!video) return null;
    return {
      duration: video.duration ?? "unknown",
      codec: video.codec_name ?? "unknown",
      width: video.width ?? 0,
      height: video.height ?? 0,
    };
  } catch {
    return null;
  }
};

export const createVideoExtractTool = (): Tool => ({
  name: "video_extract",
  description:
    "Extract frames from a video file and return them as base64-encoded images for visual analysis. " +
    "Use this when the user sends a video and wants you to describe or analyse its content. " +
    "Returns JSON with video metadata and base64 JPEG frames.",
  parameters: videoInputSchema,
  timeout_ms: 60_000,
  async execute(args) {
    const input = videoInputSchema.parse(args);
    const numFrames = input.frames ?? 4;
    let tmpDir: string | null = null;

    try {
      const probe = await probeVideo(input.path);
      const durationSec = probe ? parseFloat(probe.duration) || 0 : 0;

      tmpDir = await mkdtemp(join(tmpdir(), "hairy-video-"));

      // Extract evenly-spaced frames
      const interval = durationSec > 0 ? durationSec / (numFrames + 1) : 1;
      const framePaths: string[] = [];
      const frames: Array<{ timestampSec: number; data: string }> = [];

      for (let i = 1; i <= numFrames; i++) {
        const ts = interval * i;
        const outPath = join(tmpDir, `frame-${i}.jpg`);
        framePaths.push(outPath);
        try {
          await execFileAsync("ffmpeg", [
            "-ss", String(ts),
            "-i", input.path,
            "-frames:v", "1",
            "-q:v", "3",
            "-vf", "scale=640:-1",
            "-y",
            outPath,
          ]);
          const buf = await readFile(outPath);
          frames.push({ timestampSec: Math.round(ts * 100) / 100, data: buf.toString("base64") });
        } catch {
          // frame extraction failed for this timestamp — skip it
        }
      }

      const result = {
        path: input.path,
        metadata: probe
          ? { duration: `${Math.round(durationSec)}s`, codec: probe.codec, resolution: `${probe.width}x${probe.height}` }
          : null,
        frames: frames.map((f) => ({ timestampSec: f.timestampSec, mimeType: "image/jpeg", base64: f.data })),
      };

      return { content: JSON.stringify(result) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `video_extract failed: ${msg}`, isError: true };
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
});
