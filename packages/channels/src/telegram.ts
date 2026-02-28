import type { AgentResponse } from "@hairy/core";
import type { HairyLogger as Logger } from "@hairy/observability";
import { BaseAdapter } from "./adapter.js";

export interface TelegramOpts {
  botToken: string;
  allowedChatIds: string[];
  logger: Logger;
}

export class TelegramAdapter extends BaseAdapter {
  readonly channelType = "telegram";

  constructor(private readonly opts: TelegramOpts) {
    super();
  }

  async connect(): Promise<void> {
    this.opts.logger.info(
      { chatIds: this.opts.allowedChatIds },
      "telegram adapter connected (stub)",
    );
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.opts.logger.info("telegram adapter disconnected");
  }

  async sendMessage(channelId: string, response: AgentResponse): Promise<void> {
    this.opts.logger.info(
      { channelId, textLength: response.text.length },
      "telegram sendMessage not yet implemented",
    );
  }

  override startTyping(channelId: string): void {
    this.opts.logger.debug({ channelId }, "telegram startTyping noop");
  }

  override stopTyping(channelId: string): void {
    this.opts.logger.debug({ channelId }, "telegram stopTyping noop");
  }
}

export const createTelegramAdapter = (opts: TelegramOpts): TelegramAdapter => {
  return new TelegramAdapter(opts);
};
