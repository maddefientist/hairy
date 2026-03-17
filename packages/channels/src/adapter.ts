import { randomUUID } from "node:crypto";
import type { AgentResponse, HairyClawMessage } from "@hairyclaw/core";
import type { ChannelAdapter, StreamHandle } from "./types.js";

export abstract class BaseAdapter implements ChannelAdapter {
  private handler: ((msg: HairyClawMessage) => void) | null = null;
  protected connected = false;

  abstract readonly channelType: string;

  abstract connect(): Promise<void>;

  abstract disconnect(): Promise<void>;

  abstract sendMessage(channelId: string, response: AgentResponse): Promise<void>;

  sendStreamStart?(_channelId: string, _initialText: string): Promise<StreamHandle>;

  onMessage(handler: (msg: HairyClawMessage) => void): void {
    this.handler = handler;
  }

  startTyping(_channelId: string): void {}

  stopTyping(_channelId: string): void {}

  isConnected(): boolean {
    return this.connected;
  }

  protected emitMessage(message: Omit<HairyClawMessage, "id" | "timestamp">): void {
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
