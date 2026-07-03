import { describe, it, expect } from "vitest";
import { parseNewsletter, stripTracking, distillNewsletter } from "../../src/corra/email-ingest.js";

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

describe("stripTracking (scanner-safe sanitizer)", () => {
  it("removes tracking URLs, AWS-key-shaped tokens and long base64/hex blobs", () => {
    const dirty =
      "Read more https://click.example.com/track/abc AKIAIOSFODNN7EXAMPLE token aGVsbG9fdGhpc19pc19hX3ZlcnlfbG9uZ190cmFja2luZ190b2tlbg== end";
    const clean = stripTracking(dirty);
    expect(clean).not.toContain("http");
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(clean).not.toMatch(/[A-Za-z0-9+/]{40,}/);
    expect(clean).toContain("Read more");
    expect(clean).toContain("end");
  });
});

describe("distillNewsletter", () => {
  it("produces a compact, sanitized summary with a Ref for dedup", () => {
    const d = parseNewsletter({
      messageId: "<abc@news>",
      from: { text: "The Pragmatic Engineer <hi@pragmail.com>" },
      subject: "Issue #42",
      date: new Date("2026-06-23T07:00:00Z"),
      text: `Big news about AI agents. Click https://track.me/${"x".repeat(80)} now.`,
    } as never);
    const summary = distillNewsletter(d);
    expect(summary).toContain("Newsletter: Issue #42");
    expect(summary).toContain("Ref: <abc@news>");
    expect(summary).toContain("AI agents");
    expect(summary).not.toContain("http");
    // compact: never the full 20k body
    expect(summary.length).toBeLessThan(1000);
  });
});
