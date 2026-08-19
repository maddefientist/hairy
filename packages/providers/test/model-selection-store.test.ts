import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelSelectionStore } from "../src/model-selection-store.js";

const makePath = (): string => join(tmpdir(), "hairy-model-selection", `${randomUUID()}.json`);

describe("ModelSelectionStore", () => {
  it("starts with the configured default primary", () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    expect(store.getCurrent().primaryId).toBe("ollama/kimi-k2.6:cloud");
    expect(store.getHistory()).toEqual([]);
  });

  it("atomically persists configured defaults when the state file is initially absent", async () => {
    const filePath = makePath();
    const store = new ModelSelectionStore({
      filePath,
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
      defaultFallbackIds: ["ollama/minimax-m3:cloud", "ollama/glm-5.2:cloud"],
    });

    await store.load();

    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw.current.primaryId).toBe("ollama/kimi-k2.6:cloud");
    expect(raw.current.fallbackIds).toEqual(["ollama/minimax-m3:cloud", "ollama/glm-5.2:cloud"]);
    expect(raw.history).toEqual([]);
  });

  it("setPrimary updates current and records history", async () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    const updated = await store.setPrimary("openrouter/z-ai/glm-5.2", "operator-1");
    expect(updated.primaryId).toBe("openrouter/z-ai/glm-5.2");
    expect(updated.updatedBy).toBe("operator-1");
    expect(store.getHistory().length).toBe(1);
    expect(store.getHistory()[0].primaryId).toBe("ollama/kimi-k2.6:cloud");
  });

  it("persists atomically and reloads identical state", async () => {
    const filePath = makePath();
    const writer = new ModelSelectionStore({
      filePath,
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    await writer.setPrimary("openrouter/minimax/minimax-m3", "operator-1");
    await writer.setFallbacks(["ollama/kimi-k2.6:cloud"], "operator-1");

    const reader = new ModelSelectionStore({
      filePath,
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    await reader.load();
    expect(reader.getCurrent().primaryId).toBe("openrouter/minimax/minimax-m3");
    expect(reader.getCurrent().fallbackIds).toEqual(["ollama/kimi-k2.6:cloud"]);
    expect(reader.getHistory().length).toBe(2);

    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw.current.primaryId).toBe("openrouter/minimax/minimax-m3");
  });

  it("rollback restores the previous record and shrinks history", async () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    await store.setPrimary("openrouter/z-ai/glm-5.2", "operator-1");
    await store.setPrimary("openrouter/minimax/minimax-m3", "operator-1");
    expect(store.getHistory().length).toBe(2);

    const rolled = await store.rollback("operator-2");
    expect(rolled?.primaryId).toBe("openrouter/z-ai/glm-5.2");
    expect(store.getCurrent().primaryId).toBe("openrouter/z-ai/glm-5.2");
    expect(store.getHistory().length).toBe(1);
  });

  it("rollback with no history returns null and leaves state unchanged", async () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    const rolled = await store.rollback("operator-1");
    expect(rolled).toBeNull();
    expect(store.getCurrent().primaryId).toBe("ollama/kimi-k2.6:cloud");
  });

  it("bounds history to maxHistory entries", async () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
      maxHistory: 3,
    });
    for (let i = 0; i < 10; i++) {
      await store.setPrimary(`openrouter/model-${i}`, "operator-1");
    }
    expect(store.getHistory().length).toBe(3);
  });

  it("serializes concurrent setPrimary calls without corrupting history", async () => {
    const store = new ModelSelectionStore({
      filePath: makePath(),
      defaultPrimaryId: "ollama/kimi-k2.6:cloud",
    });
    await Promise.all([
      store.setPrimary("openrouter/a", "operator-1"),
      store.setPrimary("openrouter/b", "operator-2"),
      store.setPrimary("openrouter/c", "operator-3"),
    ]);
    // All three mutations must be recorded: 1 default + 2 intermediate in history, 1 as current.
    expect(store.getHistory().length).toBe(3);
    const ids = [...store.getHistory().map((h) => h.primaryId), store.getCurrent().primaryId];
    expect(new Set(ids).size).toBe(4);
  });
});
