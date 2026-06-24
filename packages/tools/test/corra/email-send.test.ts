import { describe, it, expect, vi } from "vitest";
import { createEmailSendTool } from "../../src/corra/email-send.js";

const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: () => noopLogger };
const ctx = { traceId: "t", cwd: "/", dataDir: "/tmp", logger: noopLogger } as never;
const smtp = { host: "h", port: 587, user: "u", password: "p" };

describe("corra_email_send", () => {
  it("sends with from = fromAddress", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
    const factory = vi.fn().mockReturnValue({ sendMail });
    const tool = createEmailSendTool({ smtp, fromAddress: "corra@x.dev", transportFactory: factory as never });
    const res = await tool.execute({ action: "send", to: "a@b.c", subject: "s", body: "hi" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: "corra@x.dev", to: "a@b.c", subject: "s" });
  });
  it("reply sets inReplyTo header", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "y" });
    const factory = vi.fn().mockReturnValue({ sendMail });
    const tool = createEmailSendTool({ smtp, fromAddress: "c@x.dev", transportFactory: factory as never });
    await tool.execute({ action: "reply", to: "a@b.c", body: "re", inReplyTo: "<m1>" }, ctx);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ inReplyTo: "<m1>" });
  });
});
