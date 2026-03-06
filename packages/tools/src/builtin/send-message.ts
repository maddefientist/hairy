/**
 * send_message — send a message to the user immediately while still processing.
 * Useful for acknowledging requests before starting longer work, or sending
 * partial results while continuing a multi-step task.
 */
import { z } from "zod";
import type { Tool } from "../types.js";

const sendMessageSchema = z.object({
  text: z.string().min(1).max(4096).describe("Message text to send immediately to the user."),
});

/** Minimal interface for sending messages — avoids depending on @hairy/channels */
interface MessageSender {
  sendMessage(channelId: string, response: { text: string }): Promise<void>;
}

export interface SendMessageToolOptions {
  /** Function that resolves the current channel sender and channel ID */
  getChannel: () => { adapter: MessageSender; channelId: string } | null;
}

export const createSendMessageTool = (opts: SendMessageToolOptions): Tool => ({
  name: "send_message",
  description:
    "Send a message to the user immediately while you continue processing. Use this to acknowledge requests before starting long tasks, or to send incremental updates.",
  parameters: sendMessageSchema,
  async execute(args) {
    const input = sendMessageSchema.parse(args);
    const channel = opts.getChannel();

    if (!channel) {
      return { content: "No active channel to send message to.", isError: true };
    }

    try {
      await channel.adapter.sendMessage(channel.channelId, { text: input.text });
      return { content: `Message sent: "${input.text.slice(0, 80)}..."` };
    } catch (err: unknown) {
      return {
        content: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
