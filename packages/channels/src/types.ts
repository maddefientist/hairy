import type { AgentResponse, HairyClawMessage } from "@hairyclaw/core";

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
  onMessage(handler: (msg: HairyClawMessage) => void): void;
  startTyping(channelId: string): void;
  stopTyping(channelId: string): void;
  isConnected(): boolean;
}
