import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptVersionManager } from "../src/prompt-version.js";

const tmpFile = () => join(tmpdir(), `hairy-pv-${randomUUID()}.json`);

describe("PromptVersionManager", () => {
  it("starts with empty history", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const history = await pvm.history();
    expect(history).toHaveLength(0);
  });

  it("saves a prompt and returns a version", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const v = await pvm.save("You are a helpful assistant.");

    expect(v.id).toBeTruthy();
    expect(v.prompt).toBe("You are a helpful assistant.");
    expect(v.hash).toHaveLength(64); // SHA-256 hex
    expect(v.createdAt).toBeTruthy();
  });

  it("getCurrent returns the most recent version", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    await pvm.save("version one");
    await pvm.save("version two");

    const current = await pvm.getCurrent();
    expect(current?.prompt).toBe("version two");
  });

  it("getCurrent returns null when history is empty", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const current = await pvm.getCurrent();
    expect(current).toBeNull();
  });

  it("persists across instances", async () => {
    const path = tmpFile();
    const p1 = new PromptVersionManager({ filePath: path });
    const saved = await p1.save("persisted prompt");

    const p2 = new PromptVersionManager({ filePath: path });
    const current = await p2.getCurrent();
    expect(current?.id).toBe(saved.id);
    expect(current?.prompt).toBe("persisted prompt");
  });

  it("rollback re-saves a historical version as newest", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const v1 = await pvm.save("prompt A");
    await pvm.save("prompt B");
    await pvm.save("prompt C");

    const rolled = await pvm.rollback(v1.id);
    expect(rolled).toBe(true);

    const current = await pvm.getCurrent();
    expect(current?.prompt).toBe("prompt A");
    // History now has 4 entries (A B C A)
    const history = await pvm.history();
    expect(history).toHaveLength(4);
  });

  it("rollback returns false for unknown id", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const result = await pvm.rollback("does-not-exist");
    expect(result).toBe(false);
  });

  it("produces consistent hash for same prompt", async () => {
    const pvm = new PromptVersionManager({ filePath: tmpFile() });
    const v1 = await pvm.save("deterministic content");
    const v2 = await pvm.save("deterministic content");
    // Same content → same hash, different IDs
    expect(v1.hash).toBe(v2.hash);
    expect(v1.id).not.toBe(v2.id);
  });
});
