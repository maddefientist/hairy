import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentResponse, MediaAttachment } from "@hairy/core";
import type { HairyLogger as Logger } from "@hairy/observability";
import { Bot, GrammyError, HttpError } from "grammy";
import { TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { BaseAdapter } from "./adapter.js";

interface TelegramBaseOpts {
  /** If set, only messages from these chat IDs are accepted */
  allowedChatIds: string[];
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

export class TelegramAdapter extends BaseAdapter {
  readonly channelType = "telegram";
  private bot: Bot | null = null;
  private mtprotoClient: TelegramClient | null = null;

  constructor(private readonly opts: TelegramOpts) {
    super();
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

    bot.on("message:text", (ctx) => {
      const chatId = String(ctx.chat.id);

      if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chatId)) {
        this.opts.logger.warn({ chatId }, "telegram message from unlisted chat, ignoring");
        return;
      }

      this.emitMessage({
        channelId: chatId,
        channelType: "telegram",
        senderId: String(ctx.from?.id ?? ctx.chat.id),
        senderName:
          [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
          ctx.from?.username ||
          "Telegram User",
        content: { text: ctx.message.text },
        metadata: {
          messageId: ctx.message.message_id,
          chatType: ctx.chat.type,
          mode: "bot",
        },
      });
    });

    bot.on("message:photo", (ctx) => {
      const chatId = String(ctx.chat.id);
      if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chatId)) return;

      const largest = ctx.message.photo[ctx.message.photo.length - 1];

      this.emitMessage({
        channelId: chatId,
        channelType: "telegram",
        senderId: String(ctx.from?.id ?? ctx.chat.id),
        senderName:
          [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "Telegram User",
        content: {
          text: ctx.message.caption ?? "",
          images: [
            {
              mimeType: "image/jpeg",
              metadata: { fileId: largest?.file_id },
            } as unknown as MediaAttachment,
          ],
        },
        metadata: { messageId: ctx.message.message_id, mode: "bot" },
      });
    });

    bot.on("message:document", (ctx) => {
      const chatId = String(ctx.chat.id);
      if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chatId)) return;

      const doc = ctx.message.document;
      this.emitMessage({
        channelId: chatId,
        channelType: "telegram",
        senderId: String(ctx.from?.id ?? ctx.chat.id),
        senderName:
          [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "Telegram User",
        content: {
          text: ctx.message.caption ?? "",
          documents: [
            {
              path: doc.file_id,
              fileName: doc.file_name ?? "document",
              mimeType: doc.mime_type ?? "application/octet-stream",
            },
          ],
        },
        metadata: { messageId: ctx.message.message_id, mode: "bot" },
      });
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

    this.emitMessage({
      channelId: chatId,
      channelType: "telegram",
      senderId,
      senderName,
      content: { text },
      metadata: {
        messageId: messageRecord?.id,
        mode: "mtproto",
      },
    });
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
}

export const createTelegramAdapter = (opts: TelegramOpts): TelegramAdapter =>
  new TelegramAdapter(opts);
