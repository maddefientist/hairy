import { describe, it, expect } from "vitest";
import { nextQueueState } from "../../src/corra/x-draft-queue.js";

const q = [{ id: "1", text: "hello", status: "pending" as const }];

describe("nextQueueState", () => {
  it("approve marks a draft approved", () => {
    expect(nextQueueState(q, "approve", "1")[0].status).toBe("approved");
  });
  it("skip removes the draft", () => {
    expect(nextQueueState(q, "skip", "1")).toHaveLength(0);
  });
  it("edit replaces text and keeps pending", () => {
    const r = nextQueueState(q, "edit", "1", "new text")[0];
    expect(r.text).toBe("new text");
    expect(r.status).toBe("pending");
  });
  it("unknown id is a no-op", () => {
    expect(nextQueueState(q, "approve", "9")).toEqual(q);
  });
});
