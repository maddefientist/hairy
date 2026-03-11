import { describe, expect, it, vi } from "vitest";
import { type TelegramBotMessageLike, extractBotMessageContent } from "../src/telegram.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const makeDownloader = () =>
  vi.fn(
    async (fileId: string, _channelId: string, hint: { mimeType: string; fileName: string }) => ({
      path: `/tmp/${fileId}`,
      buffer: Buffer.from(fileId),
      mimeType: hint.mimeType,
      fileName: hint.fileName,
    }),
  );

describe("telegram media extraction", () => {
  it("photo message populates images array", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      photo: [{ file_id: "small" }, { file_id: "large" }],
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.images).toHaveLength(1);
    expect(content.images?.[0]?.mimeType).toBe("image/jpeg");
    expect(download).toHaveBeenCalledWith(
      "large",
      "chat-1",
      expect.objectContaining({ kind: "image" }),
    );
  });

  it("voice message populates audio array", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      voice: { file_id: "voice-1", mime_type: "audio/ogg" },
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.audio).toHaveLength(1);
    expect(content.audio?.[0]?.mimeType).toBe("audio/ogg");
  });

  it("document message populates documents array", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      document: { file_id: "doc-1", file_name: "report.pdf", mime_type: "application/pdf" },
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.documents).toHaveLength(1);
    expect(content.documents?.[0]?.fileName).toBe("report.pdf");
  });

  it("caption is preserved on media messages", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      caption: "This is a caption",
      photo: [{ file_id: "photo-1" }],
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.text).toBe("This is a caption");
    expect(content.images?.[0]?.caption).toBe("This is a caption");
  });

  it("text-only message has no attachments", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      text: "hello",
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.text).toBe("hello");
    expect(content.images).toBeUndefined();
    expect(content.audio).toBeUndefined();
    expect(content.video).toBeUndefined();
    expect(content.documents).toBeUndefined();
  });

  it("supports multiple media types in one message", async () => {
    const download = makeDownloader();
    const message: TelegramBotMessageLike = {
      caption: "bundle",
      photo: [{ file_id: "photo-1" }],
      document: { file_id: "doc-1", file_name: "a.txt", mime_type: "text/plain" },
    };

    const content = await extractBotMessageContent(message, "chat-1", download, logger);

    expect(content.images).toHaveLength(1);
    expect(content.documents).toHaveLength(1);
    expect(content.text).toBe("bundle");
  });
});
