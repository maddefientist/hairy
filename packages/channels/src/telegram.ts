import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  AgentResponse,
  DocumentAttachment,
  MediaAttachment,
  MessageContent,
} from "@hairyclaw/core";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
import { Bot, type Context, GrammyError, HttpError } from "grammy";
import { TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { BaseAdapter } from "./adapter.js";
import type { StreamHandle } from "./types.js";

interface TelegramBaseOpts {
  /** If set, only messages from these chat IDs are accepted */
  allowedChatIds: string[];
  /** Data root for downloaded media. Defaults to <cwd>/data */
  dataDir?: string;
  logger: Logger;
}

interface TelegramBotOpts extends TelegramBaseOpts {
  mode: "bot";
  botToken: string;
}

interface TelegramMtprotoOpts extends TelegramBaseOpts {
  mode: "mtproto";
  apiId: number;
  apiHash: string;
  phoneNumber?: string;
  phoneCode?: string;
  password?: string;
  sessionString?: string;
  sessionFile: string;
}

export type TelegramOpts = TelegramBotOpts | TelegramMtprotoOpts;

const isMtproto = (opts: TelegramOpts): opts is TelegramMtprotoOpts => opts.mode === "mtproto";

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
};

const stringifyId = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
};

const extractPeerId = (value: unknown): string | undefined => {
  const peer = toRecord(value);
  if (!peer) return undefined;

  return (
    stringifyId(peer.userId) ??
    stringifyId(peer.chatId) ??
    stringifyId(peer.channelId) ??
    stringifyId(peer.id)
  );
};

const readOptionalFile = async (path: string): Promise<string | undefined> => {
  try {
    const content = await readFile(path, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const STREAM_EDIT_DEBOUNCE_MS = 1_500;

const isMessageNotModified = (error: unknown): boolean => {
  if (!(error instanceof GrammyError)) {
    return false;
  }
  return (
    error.error_code === 400 &&
    typeof error.description === "string" &&
    error.description.toLowerCase().includes("message is not modified")
  );
};

const splitMessage = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const breakAt = lastNewline > maxLen / 2 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
};

const resolveSenderName = async (event: NewMessageEvent): Promise<string | undefined> => {
  try {
    const sender = await event.message.getSender();
    const senderRecord = toRecord(sender);
    if (!senderRecord) return undefined;

    const firstName =
      typeof senderRecord.firstName === "string" ? senderRecord.firstName.trim() : "";
    const lastName = typeof senderRecord.lastName === "string" ? senderRecord.lastName.trim() : "";
    const fullName = [firstName, lastName]
      .filter((part) => part.length > 0)
      .join(" ")
      .trim();
    if (fullName.length > 0) return fullName;

    if (typeof senderRecord.username === "string" && senderRecord.username.length > 0) {
      return senderRecord.username;
    }

    if (typeof senderRecord.title === "string" && senderRecord.title.length > 0) {
      return senderRecord.title;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const resolveChatId = (event: NewMessageEvent): string | undefined => {
  const message = toRecord(event.message as unknown);
  if (message) {
    const fromChat = stringifyId(message.chatId);
    if (fromChat) return fromChat;

    const fromPeer = extractPeerId(message.peerId);
    if (fromPeer) return fromPeer;
  }

  const eventRecord = toRecord(event as unknown);
  if (!eventRecord) return undefined;

  return stringifyId(eventRecord.chatId);
};

const resolveSenderId = (event: NewMessageEvent, fallback: string): string => {
  const message = toRecord(event.message as unknown);
  if (!message) return fallback;

  const senderId = extractPeerId(message.senderId) ?? extractPeerId(message.fromId);
  return senderId ?? fallback;
};

interface TelegramPhotoLike {
  file_id: string;
}

interface TelegramMediaLike {
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramBotMessageLike {
  text?: string;
  caption?: string;
  photo?: TelegramPhotoLike[];
  voice?: TelegramMediaLike;
  audio?: TelegramMediaLike;
  video?: TelegramMediaLike;
  video_note?: TelegramMediaLike;
  document?: TelegramMediaLike;
}

interface DownloadedMediaFile {
  path: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

interface DownloadHint {
  kind: "image" | "audio" | "video" | "document";
  mimeType: string;
  fileName: string;
}

type DownloadFn = (
  fileId: string,
  channelId: string,
  hint: DownloadHint,
) => Promise<DownloadedMediaFile | null>;

const sanitizePathSegment = (value: string): string => value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

const sanitizeFileName = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "file.bin";
  }
  return trimmed.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
};

const extensionFromMime = (mimeType: string): string => {
  if (mimeType.startsWith("image/")) return ".jpg";
  if (mimeType.startsWith("audio/")) return ".ogg";
  if (mimeType.startsWith("video/")) return ".mp4";
  if (mimeType === "application/pdf") return ".pdf";
  return ".bin";
};

const withExtension = (fileName: string, mimeType: string): string => {
  if (extname(fileName).length > 0) {
    return fileName;
  }
  return `${fileName}${extensionFromMime(mimeType)}`;
};

const toMediaAttachment = (
  file: DownloadedMediaFile,
  caption: string | undefined,
): MediaAttachment => ({
  path: file.path,
  buffer: file.buffer,
  mimeType: file.mimeType,
  ...(caption ? { caption } : {}),
});

const toDocumentAttachment = (file: DownloadedMediaFile): DocumentAttachment => ({
  path: file.path,
  fileName: file.fileName,
  mimeType: file.mimeType,
});

export const extractBotMessageContent = async (
  message: TelegramBotMessageLike,
  channelId: string,
  download: DownloadFn,
  logger: Logger,
): Promise<MessageContent> => {
  const text = message.text ?? message.caption ?? "";
  const content: MessageContent = {
    text,
  };

  const images: MediaAttachment[] = [];
  const audio: MediaAttachment[] = [];
  const video: MediaAttachment[] = [];
  const documents: DocumentAttachment[] = [];

  const photo = message.photo?.[message.photo.length - 1];
  if (photo?.file_id) {
    const downloaded = await download(photo.file_id, channelId, {
      kind: "image",
      mimeType: "image/jpeg",
      fileName: `photo-${photo.file_id}.jpg`,
    });
    if (downloaded) {
      images.push(toMediaAttachment(downloaded, message.caption));
    }
  }

  const voiceOrAudio = message.voice ?? message.audio;
  if (voiceOrAudio?.file_id) {
    const mimeType = voiceOrAudio.mime_type ?? "audio/ogg";
    const downloaded = await download(voiceOrAudio.file_id, channelId, {
      kind: "audio",
      mimeType,
      fileName: withExtension(
        sanitizeFileName(voiceOrAudio.file_name ?? `audio-${voiceOrAudio.file_id}`),
        mimeType,
      ),
    });
    if (downloaded) {
      audio.push(toMediaAttachment(downloaded, message.caption));
    }
  }

  const videoOrNote = message.video ?? message.video_note;
  if (videoOrNote?.file_id) {
    const mimeType = videoOrNote.mime_type ?? "video/mp4";
    const downloaded = await download(videoOrNote.file_id, channelId, {
      kind: "video",
      mimeType,
      fileName: withExtension(
        sanitizeFileName(videoOrNote.file_name ?? `video-${videoOrNote.file_id}`),
        mimeType,
      ),
    });
    if (downloaded) {
      video.push(toMediaAttachment(downloaded, message.caption));
    }
  }

  if (message.document?.file_id) {
    const mimeType = message.document.mime_type ?? "application/octet-stream";
    const downloaded = await download(message.document.file_id, channelId, {
      kind: "document",
      mimeType,
      fileName: withExtension(
        sanitizeFileName(message.document.file_name ?? `document-${message.document.file_id}`),
        mimeType,
      ),
    });
    if (downloaded) {
      documents.push(toDocumentAttachment(downloaded));
    }
  }

  if (images.length > 0) content.images = images;
  if (audio.length > 0) content.audio = audio;
  if (video.length > 0) content.video = video;
  if (documents.length > 0) content.documents = documents;

  if (
    images.length === 0 &&
    audio.length === 0 &&
    video.length === 0 &&
    documents.length === 0 &&
    text.length === 0
  ) {
    logger.debug({ channelId }, "telegram message had no text or supported media");
  }

  return content;
};

export class TelegramAdapter extends BaseAdapter {
  readonly channelType = "telegram";
  private bot: Bot | null = null;
  private mtprotoClient: TelegramClient | null = null;
  private readonly dataDir: string;

  constructor(private readonly opts: TelegramOpts) {
    super();
    this.dataDir = opts.dataDir ?? join(process.cwd(), "data");
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.opts.mode === "bot") {
      await this.connectBot();
      return;
    }

    await this.connectMtproto();
  }

  private async connectBot(): Promise<void> {
    if (this.opts.mode !== "bot") {
      throw new Error("connectBot called with non-bot options");
    }

    const opts = this.opts;
    const bot = new Bot(opts.botToken);
    this.bot = bot;

    bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        this.opts.logger.error(
          { code: e.error_code, description: e.description },
          "telegram api error",
        );
      } else if (e instanceof HttpError) {
        this.opts.logger.error({ err: e }, "telegram http error");
      } else {
        this.opts.logger.error({ err: e }, "telegram unknown error");
      }
    });

    bot.on("message", (ctx) => {
      void this.handleBotMessage(ctx);
    });

    bot
      .start({
        drop_pending_updates: true,
        onStart: (me) => {
          this.opts.logger.info({ username: me.username, id: me.id }, "telegram bot started");
        },
      })
      .catch((err: unknown) => {
        this.opts.logger.error({ err }, "telegram bot crashed");
      });

    this.connected = true;
    this.opts.logger.info(
      { allowedChatIds: this.opts.allowedChatIds, mode: "bot" },
      "telegram adapter connected",
    );
  }

  private async handleBotMessage(ctx: Context): Promise<void> {
    if (!ctx.message) {
      return;
    }

    const chatId = String(ctx.chat?.id ?? "");
    if (chatId.length === 0) {
      return;
    }

    // Allow DMs (positive chat IDs) unless allowlist explicitly contains only group IDs
    const isDm = !chatId.startsWith("-");
    const isAllowed =
      this.opts.allowedChatIds.length === 0 ||
      this.opts.allowedChatIds.includes(chatId) ||
      (isDm && this.opts.allowedChatIds.every((id) => id.startsWith("-")));

    if (!isAllowed) {
      this.opts.logger.warn({ chatId }, "telegram message from unlisted chat, ignoring");
      return;
    }

    const content = await extractBotMessageContent(
      ctx.message as unknown as TelegramBotMessageLike,
      chatId,
      async (fileId, channelId, hint) => this.downloadBotFile(fileId, channelId, hint),
      this.opts.logger,
    );

    const senderName =
      [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
      ctx.from?.username ||
      "Telegram User";

    this.emitMessage({
      channelId: chatId,
      channelType: "telegram",
      senderId: String(ctx.from?.id ?? ctx.chat?.id ?? chatId),
      senderName,
      content,
      metadata: {
        messageId: ctx.message.message_id,
        chatType: ctx.chat?.type,
        mode: "bot",
      },
    });
  }

  private async downloadBotFile(
    fileId: string,
    channelId: string,
    hint: DownloadHint,
  ): Promise<DownloadedMediaFile | null> {
    if (this.opts.mode !== "bot" || !this.bot) {
      return null;
    }

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        return null;
      }

      const dir = join(this.dataDir, "media", "inbound", sanitizePathSegment(channelId));
      await mkdir(dir, { recursive: true });

      const sourceName = sanitizeFileName(hint.fileName || basename(file.file_path));
      const fileName = withExtension(sourceName, hint.mimeType);
      const outPath = join(dir, `${Date.now()}-${fileName}`);

      const downloadUrl = `https://api.telegram.org/file/bot${this.opts.botToken}/${file.file_path}`;
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        this.opts.logger.warn(
          { fileId, status: response.status },
          "telegram media download failed",
        );
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(outPath, buffer);

      return {
        path: outPath,
        buffer,
        mimeType: hint.mimeType,
        fileName,
      };
    } catch (error: unknown) {
      this.opts.logger.warn(
        { fileId, error: error instanceof Error ? error.message : String(error) },
        "telegram media download threw",
      );
      return null;
    }
  }

  private async connectMtproto(): Promise<void> {
    const opts = this.opts;
    if (!isMtproto(opts)) {
      throw new Error("connectMtproto called with non-mtproto options");
    }

    const fileSession = await readOptionalFile(opts.sessionFile);
    const initialSession = opts.sessionString ?? fileSession ?? "";

    const client = new TelegramClient(new StringSession(initialSession), opts.apiId, opts.apiHash, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: async () => {
        if (!opts.phoneNumber) {
          throw new Error(
            "Telegram MTProto needs TELEGRAM_PHONE_NUMBER for first-time login when no saved session is available.",
          );
        }
        return opts.phoneNumber;
      },
      phoneCode: async () => {
        if (!opts.phoneCode) {
          throw new Error(
            "Telegram MTProto needs TELEGRAM_PHONE_CODE for first-time login. Generate and save a session first.",
          );
        }
        return opts.phoneCode;
      },
      password: async () => opts.password ?? "",
      onError: (err: unknown) => {
        opts.logger.error({ err }, "telegram mtproto auth error");
      },
    });

    const savedSession = (client.session as StringSession).save();
    if (savedSession.length > 0) {
      await mkdir(dirname(opts.sessionFile), { recursive: true });
      await writeFile(opts.sessionFile, `${savedSession}\n`, { mode: 0o600 });
    }

    client.addEventHandler(
      (event: NewMessageEvent) => {
        void this.handleMtprotoEvent(event);
      },
      new NewMessage({ incoming: true }),
    );

    this.mtprotoClient = client;
    this.connected = true;

    this.opts.logger.info(
      {
        allowedChatIds: opts.allowedChatIds,
        mode: "mtproto",
        sessionFile: opts.sessionFile,
      },
      "telegram adapter connected",
    );
  }

  private async handleMtprotoEvent(event: NewMessageEvent): Promise<void> {
    const chatId = resolveChatId(event);
    if (!chatId) {
      this.opts.logger.debug("telegram mtproto message without resolvable chat id, ignoring");
      return;
    }

    if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chatId)) {
      this.opts.logger.debug({ chatId }, "telegram mtproto message from unlisted chat, ignoring");
      return;
    }

    const messageRecord = toRecord(event.message as unknown);
    const text = typeof messageRecord?.message === "string" ? messageRecord.message : "";
    const senderName = (await resolveSenderName(event)) ?? "Telegram User";
    const senderId = resolveSenderId(event, chatId);

    const media = await this.downloadMtprotoMedia(event, chatId, messageRecord);

    this.emitMessage({
      channelId: chatId,
      channelType: "telegram",
      senderId,
      senderName,
      content: {
        text,
        ...(media.images ? { images: media.images } : {}),
        ...(media.audio ? { audio: media.audio } : {}),
        ...(media.video ? { video: media.video } : {}),
        ...(media.documents ? { documents: media.documents } : {}),
      },
      metadata: {
        messageId: messageRecord?.id,
        mode: "mtproto",
      },
    });
  }

  private async downloadMtprotoMedia(
    event: NewMessageEvent,
    channelId: string,
    messageRecord: Record<string, unknown> | null,
  ): Promise<Pick<MessageContent, "images" | "audio" | "video" | "documents">> {
    const mediaRecord = toRecord(messageRecord?.media);
    if (!mediaRecord) {
      return {};
    }

    const className =
      (typeof mediaRecord.className === "string" ? mediaRecord.className : "").toLowerCase() ||
      "media";

    const downloaded = await this.downloadMtprotoFile(event, channelId, className);
    if (!downloaded) {
      return {};
    }

    if (downloaded.mimeType.startsWith("image/")) {
      return { images: [toMediaAttachment(downloaded, undefined)] };
    }
    if (downloaded.mimeType.startsWith("audio/")) {
      return { audio: [toMediaAttachment(downloaded, undefined)] };
    }
    if (downloaded.mimeType.startsWith("video/")) {
      return { video: [toMediaAttachment(downloaded, undefined)] };
    }

    return {
      documents: [toDocumentAttachment(downloaded)],
    };
  }

  private async downloadMtprotoFile(
    event: NewMessageEvent,
    channelId: string,
    className: string,
  ): Promise<DownloadedMediaFile | null> {
    try {
      const eventMessageRecord = toRecord(event.message as unknown);
      const messageDownload = eventMessageRecord?.downloadMedia;

      let payload: unknown;
      if (typeof messageDownload === "function") {
        payload = await (
          messageDownload as (opts?: Record<string, unknown>) => Promise<unknown>
        ).call(event.message, {});
      } else {
        const clientRecord = toRecord(this.mtprotoClient as unknown);
        const clientDownload = clientRecord?.downloadMedia;
        if (typeof clientDownload !== "function") {
          return null;
        }
        payload = await (
          clientDownload as (message: unknown, opts?: Record<string, unknown>) => Promise<unknown>
        ).call(this.mtprotoClient, event.message, {});
      }

      let buffer: Buffer | null = null;
      if (Buffer.isBuffer(payload)) {
        buffer = payload;
      } else if (payload instanceof Uint8Array) {
        buffer = Buffer.from(payload);
      } else if (typeof payload === "string") {
        const disk = await readFile(payload);
        buffer = Buffer.from(disk);
      }

      if (!buffer) {
        return null;
      }

      const mimeType = className.includes("photo")
        ? "image/jpeg"
        : className.includes("document")
          ? "application/octet-stream"
          : className.includes("video")
            ? "video/mp4"
            : className.includes("audio") || className.includes("voice")
              ? "audio/ogg"
              : "application/octet-stream";

      const dir = join(this.dataDir, "media", "inbound", sanitizePathSegment(channelId));
      await mkdir(dir, { recursive: true });
      const fileName = withExtension(sanitizeFileName(`mtproto-${className}`), mimeType);
      const outPath = join(dir, `${Date.now()}-${fileName}`);
      await writeFile(outPath, buffer);

      return {
        path: outPath,
        buffer,
        mimeType,
        fileName,
      };
    } catch (error: unknown) {
      this.opts.logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        "telegram mtproto media download failed",
      );
      return null;
    }
  }

  async sendStreamStart(channelId: string, initialText: string): Promise<StreamHandle> {
    if (this.opts.mode !== "bot" || !this.bot) {
      throw new Error("telegram streaming is only available in bot mode after connect()");
    }

    const chatId = Number(channelId);
    if (Number.isNaN(chatId)) {
      throw new Error("telegram: invalid chat id for streaming");
    }

    const botApi = this.bot.api;
    const sent = await botApi.sendMessage(chatId, initialText);
    let currentText = initialText;
    let pendingText: string | null = null;
    let nextAllowedEditAt = 0;
    let worker: Promise<void> | null = null;
    let finalized = false;

    const editMessage = async (text: string): Promise<void> => {
      if (text === currentText) {
        return;
      }

      try {
        await botApi.editMessageText(chatId, sent.message_id, text);
        currentText = text;
      } catch (error: unknown) {
        if (isMessageNotModified(error)) {
          return;
        }
        throw error;
      }
    };

    const runWorker = (): Promise<void> => {
      if (worker) {
        return worker;
      }

      worker = (async () => {
        while (pendingText !== null) {
          const target = pendingText;
          pendingText = null;

          const waitMs = Math.max(0, nextAllowedEditAt - Date.now());
          if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }

          await editMessage(target);
          nextAllowedEditAt = Date.now() + STREAM_EDIT_DEBOUNCE_MS;
        }
      })().finally(() => {
        worker = null;
      });

      return worker;
    };

    return {
      messageId: String(sent.message_id),
      update: async (text: string) => {
        if (finalized) {
          return;
        }
        pendingText = text;
        await runWorker();
      },
      finalize: async (text: string) => {
        if (finalized) {
          return;
        }

        finalized = true;
        pendingText = text;
        nextAllowedEditAt = 0;

        try {
          await runWorker();
        } finally {
          this.stopTyping(channelId);
        }
      },
    };
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }

    if (this.mtprotoClient) {
      await this.mtprotoClient.disconnect();
      this.mtprotoClient = null;
    }

    this.connected = false;
    this.opts.logger.info("telegram adapter disconnected");
  }

  async sendMessage(channelId: string, response: AgentResponse): Promise<void> {
    if (this.opts.mode === "bot") {
      if (!this.bot) {
        this.opts.logger.warn({ channelId }, "telegram sendMessage called before connect");
        return;
      }

      const chatId = Number(channelId);
      if (Number.isNaN(chatId)) {
        this.opts.logger.error({ channelId }, "telegram: invalid chat id");
        return;
      }

      try {
        const chunks = splitMessage(response.text, 4096);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, chunk);
        }

        for (const att of response.attachments ?? []) {
          if (att.url) {
            await this.bot.api.sendDocument(chatId, att.url);
          }
        }
      } catch (err: unknown) {
        this.opts.logger.error({ err, channelId }, "telegram: failed to send message");
        throw err instanceof Error ? err : new Error(String(err));
      }

      return;
    }

    if (!this.mtprotoClient) {
      this.opts.logger.warn({ channelId }, "telegram mtproto sendMessage called before connect");
      return;
    }

    try {
      const chunks = splitMessage(response.text, 4096);
      for (const chunk of chunks) {
        await this.mtprotoClient.sendMessage(channelId, { message: chunk });
      }

      if ((response.attachments ?? []).length > 0) {
        this.opts.logger.warn(
          { channelId, attachmentCount: response.attachments?.length ?? 0 },
          "telegram mtproto: attachments are not yet sent by this adapter",
        );
      }
    } catch (err: unknown) {
      this.opts.logger.error({ err, channelId }, "telegram mtproto: failed to send message");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  override startTyping(channelId: string): void {
    if (this.opts.mode !== "bot" || !this.bot) return;
    const chatId = Number(channelId);
    if (Number.isNaN(chatId)) return;
    this.bot.api.sendChatAction(chatId, "typing").catch(() => {
      // Best-effort — ignore errors
    });
  }

  override stopTyping(_channelId: string): void {
    // Telegram typing indicator auto-expires quickly; no explicit stop API.
  }
}

export const createTelegramAdapter = (opts: TelegramOpts): TelegramAdapter =>
  new TelegramAdapter(opts);
