import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/telegram.js";
import type { ChannelAdapter } from "../src/types.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

const setupBotAdapter = () => {
  const sendMessage = vi.fn(async () => ({ message_id: 123 }));
  const sendChatAction = vi.fn(async () => {});

  const adapter = new TelegramAdapter({
    mode: "bot",
    botToken: "token",
    allowedChatIds: [],
    logger,
  });

  (
    adapter as unknown as {
      bot: {
        api: {
          sendMessage: typeof sendMessage;
          sendChatAction: typeof sendChatAction;
        };
      };
      connected: boolean;
    }
  ).bot = {
    api: {
      sendMessage,
      sendChatAction,
    },
  };

  (adapter as unknown as { connected: boolean }).connected = true;

  return { adapter, sendMessage, sendChatAction };
};

describe("TelegramAdapter typing and delivery", () => {
  it("sendStreamStart is not defined (sends complete messages instead)", () => {
    const { adapter } = setupBotAdapter();
    expect(adapter.sendStreamStart).toBeUndefined();
  });

  it("startTyping sends chat action and sets up interval", () => {
    vi.useFakeTimers();
    const { adapter, sendChatAction } = setupBotAdapter();

    adapter.startTyping("42");

    expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    // After 4 seconds, should send again
    vi.advanceTimersByTime(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    adapter.stopTyping("42");
    vi.advanceTimersByTime(4_000);
    // No more calls after stop
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("stopTyping clears the interval", () => {
    vi.useFakeTimers();
    const { adapter, sendChatAction } = setupBotAdapter();

    adapter.startTyping("42");
    adapter.stopTyping("42");

    vi.advanceTimersByTime(10_000);
    // Only the initial call, no interval repeats
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("adapters without sendStreamStart fall back to sendMessage", async () => {
    const sendMessage = vi.fn(async () => {});
    const adapter: ChannelAdapter = {
      channelType: "cli",
      connect: async () => {},
      disconnect: async () => {},
      sendMessage,
      onMessage: () => {},
      startTyping: () => {},
      stopTyping: () => {},
      isConnected: () => true,
    };

    // This mirrors the logic in main.ts: if no sendStreamStart, use sendMessage
    if (adapter.sendStreamStart) {
      const handle = await adapter.sendStreamStart("chat-1", "⏳");
      await handle.finalize("final text");
    } else {
      await adapter.sendMessage("chat-1", { text: "final text" });
    }

    expect(sendMessage).toHaveBeenCalledWith("chat-1", { text: "final text" });
  });

  it("sendMessage calls bot.api.sendMessage for delivery", async () => {
    const { adapter, sendMessage: botSendMessage } = setupBotAdapter();

    await adapter.sendMessage("42", { text: "hello from hari" });

    expect(botSendMessage).toHaveBeenCalledWith(42, "hello from hari");
  });
});
