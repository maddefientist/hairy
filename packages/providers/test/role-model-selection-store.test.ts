import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelSelectionStore } from "../src/model-selection-store.js";
import { RoleModelSelectionStore } from "../src/role-model-selection-store.js";

const makeDir = (): string => join(tmpdir(), "hairy-role-model-selection", randomUUID());

describe("RoleModelSelectionStore", () => {
  it("seeds independent brain/hands defaults when no state exists", async () => {
    const dataDir = makeDir();
    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath: join(dataDir, "model-selection.json"),
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });

    await store.load();

    expect(store.getCurrent("brain").primaryId).toBe("ollama/glm-5.2:cloud");
    expect(store.getCurrent("hands").primaryId).toBe("ollama/kimi-k2.6:cloud");
    expect(store.didMigrateLegacy()).toBe(false);
  });

  it("seeds independent fallback chains", async () => {
    const dataDir = makeDir();
    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath: join(dataDir, "model-selection.json"),
      defaultPrimaryId: { brain: "ollama/deepseek-v4-flash:cloud", hands: "supergrok/grok-4.6" },
      defaultFallbackIds: {
        brain: ["ollama/minimax-m3:cloud"],
        hands: ["ollama/deepseek-v4-pro:cloud", "ollama/kimi-k2.6:cloud"],
      },
    });

    await store.load();

    expect(store.getCurrent("brain").fallbackIds).toEqual(["ollama/minimax-m3:cloud"]);
    expect(store.getCurrent("hands").fallbackIds).toEqual([
      "ollama/deepseek-v4-pro:cloud",
      "ollama/kimi-k2.6:cloud",
    ]);
  });

  it("brain and hands maintain independent primary/fallback/history state", async () => {
    const dataDir = makeDir();
    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath: join(dataDir, "model-selection.json"),
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    await store.setPrimary("brain", "supergrok/grok-4.6", "operator-1");
    await store.setFallbacks("hands", ["ollama/deepseek-v4-pro:cloud"], "operator-1");

    expect(store.getCurrent("brain").primaryId).toBe("supergrok/grok-4.6");
    expect(store.getCurrent("hands").primaryId).toBe("ollama/kimi-k2.6:cloud");
    expect(store.getCurrent("hands").fallbackIds).toEqual(["ollama/deepseek-v4-pro:cloud"]);
    expect(store.getCurrent("brain").fallbackIds).toEqual([]);

    expect(store.getHistory("brain").length).toBe(1);
    expect(store.getHistory("hands").length).toBe(1);
  });

  it("rollback is independent per role", async () => {
    const dataDir = makeDir();
    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath: join(dataDir, "model-selection.json"),
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    await store.setPrimary("hands", "ollama/deepseek-v4-pro:cloud", "operator-1");
    const rolledHands = await store.rollback("hands", "operator-2");
    const rolledBrain = await store.rollback("brain", "operator-2");

    expect(rolledHands?.primaryId).toBe("ollama/kimi-k2.6:cloud");
    expect(rolledBrain).toBeNull();
    expect(store.getCurrent("brain").primaryId).toBe("ollama/glm-5.2:cloud");
  });

  it("atomically migrates a legacy unified-mode selection file into the brain role on first load", async () => {
    const dataDir = makeDir();
    await mkdir(dataDir, { recursive: true });
    const legacyFilePath = join(dataDir, "model-selection.json");
    const legacyState = {
      current: {
        primaryId: "ollama/minimax-m3:cloud",
        fallbackIds: ["ollama/glm-5.2:cloud"],
        updatedAt: Date.now(),
        updatedBy: "operator-legacy",
      },
      history: [],
    };
    await writeFile(legacyFilePath, JSON.stringify(legacyState, null, 2), "utf8");

    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath,
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    expect(store.didMigrateLegacy()).toBe(true);
    expect(store.getCurrent("brain").primaryId).toBe("ollama/minimax-m3:cloud");
    expect(store.getCurrent("brain").fallbackIds).toEqual(["ollama/glm-5.2:cloud"]);
    // hands is unaffected by the legacy unified-mode selection
    expect(store.getCurrent("hands").primaryId).toBe("ollama/kimi-k2.6:cloud");

    const raw = JSON.parse(await readFile(join(dataDir, "model-selection-brain.json"), "utf8"));
    expect(raw.current.primaryId).toBe("ollama/minimax-m3:cloud");
  });

  it("does not re-migrate once a brain role file already exists", async () => {
    const dataDir = makeDir();
    await mkdir(dataDir, { recursive: true });
    const legacyFilePath = join(dataDir, "model-selection.json");
    await writeFile(
      legacyFilePath,
      JSON.stringify({
        current: {
          primaryId: "ollama/minimax-m3:cloud",
          fallbackIds: [],
          updatedAt: 0,
          updatedBy: "x",
        },
        history: [],
      }),
      "utf8",
    );

    // Prime the brain role file directly, as if brain_hands mode already ran.
    const primed = new ModelSelectionStore({
      filePath: join(dataDir, "model-selection-brain.json"),
      defaultPrimaryId: "ollama/glm-5.2:cloud",
    });
    await primed.load();

    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath,
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    expect(store.didMigrateLegacy()).toBe(false);
    expect(store.getCurrent("brain").primaryId).toBe("ollama/glm-5.2:cloud");
  });

  it("skips migration and starts from defaults when the legacy file is corrupt", async () => {
    const dataDir = makeDir();
    await mkdir(dataDir, { recursive: true });
    const legacyFilePath = join(dataDir, "model-selection.json");
    await writeFile(legacyFilePath, "{not valid json", "utf8");

    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath,
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    expect(store.didMigrateLegacy()).toBe(false);
    expect(store.getCurrent("brain").primaryId).toBe("ollama/glm-5.2:cloud");
  });

  it("skips migration when the legacy JSON has the wrong shape", async () => {
    const dataDir = makeDir();
    await mkdir(dataDir, { recursive: true });
    const legacyFilePath = join(dataDir, "model-selection.json");
    await writeFile(legacyFilePath, JSON.stringify({ current: {}, history: [] }), "utf8");

    const store = new RoleModelSelectionStore({
      dataDir,
      legacyFilePath,
      defaultPrimaryId: { brain: "ollama/glm-5.2:cloud", hands: "ollama/kimi-k2.6:cloud" },
    });
    await store.load();

    expect(store.didMigrateLegacy()).toBe(false);
    expect(store.getCurrent("brain").primaryId).toBe("ollama/glm-5.2:cloud");
  });
});
