import { GrammyError } from "grammy";
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

const createNotModifiedError = (): GrammyError => {
  const error = Object.create(GrammyError.prototype) as GrammyError & {
    error_code: number;
    description: string;
  };
  error.error_code = 400;
  error.description = "Bad Request: message is not modified";
  return error;
};

const setupBotAdapter = () => {
  const sendMessage = vi.fn(async () => ({ message_id: 123 }));
  const editMessageText = vi.fn(async () => ({ message_id: 123 }));

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
          editMessageText: typeof editMessageText;
          sendChatAction: (chatId: number, action: string) => Promise<void>;
        };
      };
      connected: boolean;
    }
  ).bot = {
    api: {
      sendMessage,
      editMessageText,
      sendChatAction: async () => {},
    },
  };

  (adapter as unknown as { connected: boolean }).connected = true;

  return { adapter, sendMessage, editMessageText };
};

const sendWithFallback = async (
  adapter: ChannelAdapter,
  channelId: string,
  responseText: string,
): Promise<void> => {
  if (adapter.sendStreamStart) {
    const handle = await adapter.sendStreamStart(channelId, "⏳");
    await handle.finalize(responseText);
    return;
  }
  await adapter.sendMessage(channelId, { text: responseText });
};

describe("TelegramAdapter streaming", () => {
  it("sendStreamStart returns a stream handle with messageId", async () => {
    const { adapter } = setupBotAdapter();
    const handle = await adapter.sendStreamStart("42", "⏳");

    expect(handle.messageId).toBe("123");
    expect(typeof handle.update).toBe("function");
    expect(typeof handle.finalize).toBe("function");
  });

  it("update edits the existing message", async () => {
    const { adapter, editMessageText } = setupBotAdapter();
    const handle = await adapter.sendStreamStart("42", "⏳");

    await handle.update("hello");

    expect(editMessageText).toHaveBeenCalledWith(42, 123, "hello");
  });

  it("rapid updates are debounced", async () => {
    vi.useFakeTimers();
    const { adapter, editMessageText } = setupBotAdapter();
    const handle = await adapter.sendStreamStart("42", "⏳");

    const p1 = handle.update("one");
    const p2 = handle.update("two");
    const p3 = handle.update("three");

    await Promise.resolve();
    expect(editMessageText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all([p1, p2, p3]);

    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(editMessageText.mock.calls[1]?.[2]).toBe("three");
    vi.useRealTimers();
  });

  it("finalize performs final edit and stops typing", async () => {
    const { adapter, editMessageText } = setupBotAdapter();
    const stopTyping = vi.spyOn(adapter, "stopTyping");
    const handle = await adapter.sendStreamStart("42", "⏳");

    await handle.finalize("done");

    expect(editMessageText).toHaveBeenCalledWith(42, 123, "done");
    expect(stopTyping).toHaveBeenCalledWith("42");
  });

  it("swallows 'message is not modified' errors", async () => {
    const { adapter, editMessageText } = setupBotAdapter();
    editMessageText.mockRejectedValue(createNotModifiedError());
    const handle = await adapter.sendStreamStart("42", "⏳");

    await expect(handle.update("same")).resolves.toBeUndefined();
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

    await sendWithFallback(adapter, "chat-1", "final text");

    expect(sendMessage).toHaveBeenCalledWith("chat-1", { text: "final text" });
  });
});
