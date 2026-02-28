import { mkdir } from "node:fs/promises";
import type { AgentResponse } from "@hairy/core";
import type { HairyLogger as Logger } from "@hairy/observability";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type AnyMessageContent,
  DisconnectReason,
  type WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { BaseAdapter } from "./adapter.js";

export interface WhatsAppOpts {
  /** Directory to persist session credentials */
  sessionDir: string;
  /**
   * If set, only messages from these JIDs are accepted.
   * Format: "14155552671@s.whatsapp.net" or "1234567890-group@g.us"
   */
  allowedJids?: string[];
  logger: Logger;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly channelType = "whatsapp";
  private sock: WASocket | null = null;
  private stopping = false;

  constructor(private readonly opts: WhatsAppOpts) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.stopping = false;
    await mkdir(this.opts.sessionDir, { recursive: true });
    await this.createSocket();
  }

  private async createSocket(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // Baileys uses pino internally — give it a silent logger so it doesn't
    // flood stdout; we handle events ourselves
    const silentLogger = pino({ level: "silent" });

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      printQRInTerminal: true,
      logger: silentLogger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.opts.logger.info("whatsapp: scan QR code in terminal to log in");
      }

      if (connection === "open") {
        this.connected = true;
        this.opts.logger.info("whatsapp adapter connected");
      }

      if (connection === "close") {
        this.connected = false;
        const boom = lastDisconnect?.error as Boom | undefined;
        const code = boom?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        this.opts.logger.warn({ code, loggedOut }, "whatsapp connection closed");

        if (!loggedOut && !this.stopping) {
          this.opts.logger.info("whatsapp: reconnecting in 3 seconds...");
          setTimeout(() => {
            void this.createSocket();
          }, 3000);
        }
      }
    });

    // Persist credentials whenever they update
    sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip our own messages, status updates, and reactions
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        if (
          this.opts.allowedJids &&
          this.opts.allowedJids.length > 0 &&
          !this.opts.allowedJids.includes(jid)
        ) {
          this.opts.logger.debug({ jid }, "whatsapp: ignoring message from unlisted jid");
          continue;
        }

        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.imageMessage?.caption ??
          msg.message?.documentMessage?.caption ??
          "";

        const pushName = msg.pushName ?? jid.split("@")[0] ?? "WhatsApp User";

        // Images
        const hasImage = Boolean(msg.message?.imageMessage);
        const hasDocument = Boolean(msg.message?.documentMessage);

        this.emitMessage({
          channelId: jid,
          channelType: "whatsapp",
          senderId: msg.key.participant ?? jid,
          senderName: pushName,
          content: {
            text,
            ...(hasImage
              ? {
                  images: [
                    {
                      mimeType: msg.message?.imageMessage?.mimetype ?? "image/jpeg",
                      caption: msg.message?.imageMessage?.caption ?? undefined,
                    },
                  ],
                }
              : {}),
            ...(hasDocument
              ? {
                  documents: [
                    {
                      path: "",
                      fileName: msg.message?.documentMessage?.fileName ?? "document",
                      mimeType:
                        msg.message?.documentMessage?.mimetype ?? "application/octet-stream",
                    },
                  ],
                }
              : {}),
          },
          metadata: {
            messageId: msg.key.id,
            isGroup: jid.endsWith("@g.us"),
          },
        });
      }
    });
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.sock) {
      await this.sock.logout().catch(() => {
        // Logout may fail if already disconnected — ignore
      });
      this.sock.end(undefined);
      this.sock = null;
    }
    this.connected = false;
    this.opts.logger.info("whatsapp adapter disconnected");
  }

  async sendMessage(channelId: string, response: AgentResponse): Promise<void> {
    if (!this.sock || !this.connected) {
      this.opts.logger.warn({ channelId }, "whatsapp: sendMessage called while disconnected");
      return;
    }

    try {
      // Split long messages (WhatsApp limit is ~65535 chars but
      // 4096 is a sensible chunk size for UX)
      const chunks = splitMessage(response.text, 4096);
      for (const chunk of chunks) {
        const content: AnyMessageContent = { text: chunk };
        await this.sock.sendMessage(channelId, content);
      }
    } catch (err: unknown) {
      this.opts.logger.error({ err, channelId }, "whatsapp: failed to send message");
    }
  }

  override startTyping(channelId: string): void {
    if (!this.sock || !this.connected) return;
    this.sock.sendPresenceUpdate("composing", channelId).catch(() => {});
  }

  override stopTyping(channelId: string): void {
    if (!this.sock || !this.connected) return;
    this.sock.sendPresenceUpdate("paused", channelId).catch(() => {});
  }
}

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

export const createWhatsAppAdapter = (opts: WhatsAppOpts): WhatsAppAdapter =>
  new WhatsAppAdapter(opts);
