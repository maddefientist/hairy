import type { AgentResponse } from "@hairy/core";
import type { HairyLogger as Logger } from "@hairy/observability";
import { Bot, GrammyError, HttpError } from "grammy";
import { BaseAdapter } from "./adapter.js";

export interface TelegramOpts {
  botToken: string;
  /** If set, only messages from these chat IDs are accepted */
  allowedChatIds: string[];
  logger: Logger;
}

export class TelegramAdapter extends BaseAdapter {
  readonly channelType = "telegram";
  private bot: Bot | null = null;

  constructor(private readonly opts: TelegramOpts) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const bot = new Bot(this.opts.botToken);
    this.bot = bot;

    // Global error handler — log and continue rather than crash
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

    // Handle text messages
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
        },
      });
    });

    // Handle photo messages (attach caption as text)
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
            } as unknown as import("@hairy/core").MediaAttachment,
          ],
        },
        metadata: { messageId: ctx.message.message_id },
      });
    });

    // Handle document messages
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
        metadata: { messageId: ctx.message.message_id },
      });
    });

    // Start long polling (non-blocking — returns immediately, runs in background)
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
      { allowedChatIds: this.opts.allowedChatIds },
      "telegram adapter connected",
    );
  }

  async disconnect(): Promise<void> {
    if (!this.bot) return;
    await this.bot.stop();
    this.bot = null;
    this.connected = false;
    this.opts.logger.info("telegram adapter disconnected");
  }

  async sendMessage(channelId: string, response: AgentResponse): Promise<void> {
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
      // Telegram has a 4096-char message limit — split if needed
      const chunks = splitMessage(response.text, 4096);
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk);
      }

      // Send any attachments
      for (const att of response.attachments ?? []) {
        if (att.url) {
          await this.bot.api.sendDocument(chatId, att.url);
        }
      }
    } catch (err: unknown) {
      this.opts.logger.error({ err, channelId }, "telegram: failed to send message");
    }
  }

  override startTyping(channelId: string): void {
    if (!this.bot) return;
    const chatId = Number(channelId);
    if (Number.isNaN(chatId)) return;
    this.bot.api.sendChatAction(chatId, "typing").catch(() => {
      // Best-effort — ignore errors
    });
  }
}

/** Split a string into chunks no longer than maxLen, respecting newlines */
const splitMessage = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline within the limit
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const breakAt = lastNewline > maxLen / 2 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
};

export const createTelegramAdapter = (opts: TelegramOpts): TelegramAdapter =>
  new TelegramAdapter(opts);
