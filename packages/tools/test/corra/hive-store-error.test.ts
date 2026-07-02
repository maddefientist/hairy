import { describe, expect, it } from "vitest";
import { HiveStoreError } from "@hairyclaw/memory";

// email-ingest relies on these semantics to decide whether a hive rejection is worth ever retrying.
describe("HiveStoreError classification", () => {
  it("422 (secret-scanner reject) is permanent and reports the status", () => {
    const e = new HiveStoreError(422);
    expect(e.status).toBe(422);
    expect(e.permanent).toBe(true);
    expect(e.message).toContain("422");
  });

  it("500 (server error) is transient (not permanent)", () => {
    expect(new HiveStoreError(500).permanent).toBe(false);
  });

  it("429 (rate limit) is transient (not permanent)", () => {
    expect(new HiveStoreError(429).permanent).toBe(false);
  });

  it("0 (no response) keeps the legacy 'all endpoints unreachable' message and is not permanent", () => {
    const e = new HiveStoreError(0);
    expect(e.permanent).toBe(false);
    expect(e.message).toBe("hive store: all endpoints unreachable");
  });
});
