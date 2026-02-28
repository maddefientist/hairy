import type { AgentResponse } from "@hairy/core";
import type { HairyLogger as Logger } from "@hairy/observability";
import { BaseAdapter } from "./adapter.js";

export interface WhatsAppOpts {
  sessionDir: string;
  logger: Logger;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly channelType = "whatsapp";

  constructor(private readonly opts: WhatsAppOpts) {
    super();
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.opts.logger.info(
      { sessionDir: this.opts.sessionDir },
      "whatsapp adapter connected (stub)",
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.opts.logger.info("whatsapp adapter disconnected");
  }

  async sendMessage(channelId: string, response: AgentResponse): Promise<void> {
    this.opts.logger.info(
      { channelId, textLength: response.text.length },
      "whatsapp sendMessage not yet implemented",
    );
  }
}

export const createWhatsAppAdapter = (opts: WhatsAppOpts): WhatsAppAdapter => {
  return new WhatsAppAdapter(opts);
};
