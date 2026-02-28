import type { AgentResponse, HairyMessage } from "@hairy/core";

export interface ChannelAdapter {
  readonly channelType: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(channelId: string, response: AgentResponse): Promise<void>;
  onMessage(handler: (msg: HairyMessage) => void): void;
  startTyping(channelId: string): void;
  stopTyping(channelId: string): void;
  isConnected(): boolean;
}
