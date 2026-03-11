import type { AgentResponse, HairyMessage } from "@hairy/core";

export interface StreamHandle {
  messageId: string;
  update(text: string): Promise<void>;
  finalize(text: string): Promise<void>;
}

export interface ChannelAdapter {
  readonly channelType: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, response: AgentResponse): Promise<void>;
  sendStreamStart?(channelId: string, initialText: string): Promise<StreamHandle>;
  onMessage(handler: (msg: HairyMessage) => void): void;
  startTyping(channelId: string): void;
  stopTyping(channelId: string): void;
  isConnected(): boolean;
}
