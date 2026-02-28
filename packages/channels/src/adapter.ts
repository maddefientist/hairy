import { randomUUID } from "node:crypto";
import type { AgentResponse, HairyMessage } from "@hairy/core";
import type { ChannelAdapter } from "./types.js";

export abstract class BaseAdapter implements ChannelAdapter {
  private handler: ((msg: HairyMessage) => void) | null = null;
  protected connected = false;

  abstract readonly channelType: string;

  abstract connect(): Promise<void>;

  abstract disconnect(): Promise<void>;

  abstract sendMessage(channelId: string, response: AgentResponse): Promise<void>;

  onMessage(handler: (msg: HairyMessage) => void): void {
    this.handler = handler;
  }

  startTyping(_channelId: string): void {}

  stopTyping(_channelId: string): void {}

  isConnected(): boolean {
    return this.connected;
  }

  protected emitMessage(message: Omit<HairyMessage, "id" | "timestamp">): void {
    if (!this.handler) {
      return;
    }

    this.handler({
      ...message,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }
}
