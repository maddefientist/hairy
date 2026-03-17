import { type Interface, createInterface } from "node:readline";
import type { AgentResponse } from "@hairyclaw/core";
import { BaseAdapter } from "./adapter.js";

export class CliAdapter extends BaseAdapter {
  readonly channelType = "cli";
  private rl: Interface | null = null;

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on("line", (line) => {
      this.emitMessage({
        channelId: "local-cli",
        channelType: "cli",
        senderId: "local-user",
        senderName: "Local User",
        content: { text: line.trim() },
      });
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.connected = false;
  }

  async sendMessage(_channelId: string, response: AgentResponse): Promise<void> {
    process.stdout.write(`\nassistant> ${response.text}\n`);
  }
}

export const createCliAdapter = (): CliAdapter => {
  return new CliAdapter();
};
