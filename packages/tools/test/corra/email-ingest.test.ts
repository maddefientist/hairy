import { describe, it, expect } from "vitest";
import { parseNewsletter } from "../../src/corra/email-ingest.js";

describe("parseNewsletter", () => {
  it("extracts clean text, list-id and message-id", () => {
    const d = parseNewsletter({
      messageId: "<abc@news>",
      from: { text: "The Pragmatic Engineer <hi@pragmail.com>" },
      subject: "Issue #42",
      date: new Date("2026-06-23T07:00:00Z"),
      headers: new Map([["list-id", "<list.pragmail.com>"]]),
      html: "<h1>Title</h1><p>Body&nbsp;material</p><style>x</style>",
      text: undefined,
    } as never);
    expect(d.messageId).toBe("<abc@news>");
    expect(d.listId).toBe("<list.pragmail.com>");
    expect(d.cleanText).toContain("Body material");
    expect(d.cleanText).not.toContain("<h1>");
    expect(d.cleanText).not.toContain("x");
  });
  it("falls back to plain text body when no html", () => {
    const d = parseNewsletter({ messageId: "<2@n>", subject: "s", text: "plain body", date: new Date() } as never);
    expect(d.cleanText).toBe("plain body");
  });
});
