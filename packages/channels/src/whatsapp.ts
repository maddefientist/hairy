import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentResponse } from "@hairyclaw/core";
import type { HairyClawLogger as Logger } from "@hairyclaw/observability";
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
import qrcode from "qrcode-terminal";
import { BaseAdapter } from "./adapter.js";

export interface WhatsAppOpts {
  /** Directory to persist session credentials */
  sessionDir: string;
  /**
   * If set, request a WhatsApp linking code for this phone number
   * (digits only or +E.164 accepted).
   */
  pairPhone?: string;
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
  private pairingCodeRequested = false;

  constructor(private readonly opts: WhatsAppOpts) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.stopping = false;
    this.pairingCodeRequested = false;
    await mkdir(this.opts.sessionDir, { recursive: true });
    await this.createSocket();
  }

  private sanitizePairPhone(input: string): string {
    return input.replaceAll(/[^0-9]/g, "");
  }

  private async maybeRequestPairingCode(sock: WASocket, alreadyRegistered: boolean): Promise<void> {
    if (alreadyRegistered || !this.opts.pairPhone || this.pairingCodeRequested) {
      return;
    }

    const phone = this.sanitizePairPhone(this.opts.pairPhone);
    if (phone.length < 8) {
      this.opts.logger.warn(
        { pairPhone: this.opts.pairPhone },
        "whatsapp pair phone appears invalid; skipping pairing-code mode",
      );
      return;
    }

    this.pairingCodeRequested = true;
    try {
      // Give the socket a moment to finish initial handshake before requesting code
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const code = await sock.requestPairingCode(phone);
      this.opts.logger.info(
        { pairPhone: phone, pairingCode: code },
        "whatsapp pairing code ready (use 'Link with phone number instead')",
      );
    } catch (error: unknown) {
      this.opts.logger.error({ err: error }, "failed to request whatsapp pairing code");
      this.pairingCodeRequested = false;
    }
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
      printQRInTerminal: false,
      logger: silentLogger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    void this.maybeRequestPairingCode(sock, state.creds.registered);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
        if (this.opts.pairPhone) {
          this.opts.logger.info(
            "whatsapp: QR shown; pairing-code mode also enabled (check logs for pairingCode)",
          );
        } else {
          this.opts.logger.info("whatsapp: scan the QR code shown above to log in");
        }
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
      // Only close the websocket — do NOT call logout() which permanently
      // unlinks the device from WhatsApp and destroys the session.
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
      throw err instanceof Error ? err : new Error(String(err));
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
