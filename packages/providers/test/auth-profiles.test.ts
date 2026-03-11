import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProfileManager } from "../src/auth-profiles.js";

const makePath = (): string => join(tmpdir(), "hairy-auth-profiles", `${randomUUID()}.json`);

describe("AuthProfileManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds and removes profiles", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({
      id: "ollama:local",
      provider: "ollama",
      type: "none",
      credential: "",
    });

    expect(manager.getAvailable("ollama")?.id).toBe("ollama:local");

    manager.removeProfile("ollama:local");
    expect(manager.getAvailable("ollama")).toBeNull();
  });

  it("getAvailable returns healthy profile", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "anthropic", type: "api_key", credential: "sk-a" });

    expect(manager.getAvailable("anthropic")?.id).toBe("a");
  });

  it("getAvailable skips profiles in cooldown", () => {
    const manager = new AuthProfileManager({ filePath: makePath(), baseCooldownMs: 1_000 });
    manager.addProfile({ id: "a", provider: "anthropic", type: "api_key", credential: "sk-a" });
    manager.addProfile({ id: "b", provider: "anthropic", type: "api_key", credential: "sk-b" });

    manager.reportFailure("a", "server");

    expect(manager.getAvailable("anthropic")?.id).toBe("b");
  });

  it("returns null when all profiles are in cooldown", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "gemini", type: "api_key", credential: "k1" });
    manager.addProfile({ id: "b", provider: "gemini", type: "api_key", credential: "k2" });

    manager.reportFailure("a", "timeout");
    manager.reportFailure("b", "timeout");

    expect(manager.getAvailable("gemini")).toBeNull();
  });

  it("reportFailure increments counters", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "openrouter", type: "api_key", credential: "or" });

    manager.reportFailure("a", "rate_limit");
    manager.reportFailure("a", "rate_limit");

    const health = manager.getHealthSnapshot().get("a");
    expect(health?.errorCount).toBe(2);
    expect(health?.consecutiveErrors).toBe(2);
    expect(health?.failureCounts.rate_limit).toBe(2);
  });

  it("reportFailure triggers cooldown after threshold", () => {
    const manager = new AuthProfileManager({
      filePath: makePath(),
      baseCooldownMs: 1_000,
      cooldownThreshold: 2,
    });

    manager.addProfile({ id: "a", provider: "openrouter", type: "api_key", credential: "or" });

    manager.reportFailure("a", "server");
    expect(manager.isInCooldown("a")).toBe(false);

    manager.reportFailure("a", "server");
    expect(manager.isInCooldown("a")).toBe(true);
  });

  it("reportSuccess resets consecutive errors", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "anthropic", type: "api_key", credential: "sk-a" });

    manager.reportFailure("a", "server");
    manager.reportSuccess("a");

    const health = manager.getHealthSnapshot().get("a");
    expect(health?.consecutiveErrors).toBe(0);
    expect(health?.cooldownUntil).toBeUndefined();
  });

  it("clearCooldown makes profile available again", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "anthropic", type: "api_key", credential: "sk-a" });

    manager.reportFailure("a", "server");
    expect(manager.getAvailable("anthropic")).toBeNull();

    manager.clearCooldown("a");
    expect(manager.getAvailable("anthropic")?.id).toBe("a");
  });

  it("applies exponential backoff", () => {
    const manager = new AuthProfileManager({
      filePath: makePath(),
      baseCooldownMs: 1_000,
      cooldownThreshold: 1,
      maxCooldownMs: 60_000,
    });

    manager.addProfile({ id: "a", provider: "ollama", type: "none", credential: "" });

    manager.reportFailure("a", "server"); // 1s
    const firstUntil = manager.getHealthSnapshot().get("a")?.cooldownUntil ?? 0;
    expect(firstUntil).toBe(Date.now() + 1_000);

    vi.advanceTimersByTime(1_000);
    manager.reportFailure("a", "server"); // 2s
    const secondUntil = manager.getHealthSnapshot().get("a")?.cooldownUntil ?? 0;
    expect(secondUntil).toBe(Date.now() + 2_000);
  });

  it("caps cooldown at max cooldown", () => {
    const manager = new AuthProfileManager({
      filePath: makePath(),
      baseCooldownMs: 10_000,
      maxCooldownMs: 15_000,
      cooldownThreshold: 1,
    });

    manager.addProfile({ id: "a", provider: "gemini", type: "api_key", credential: "g" });

    manager.reportFailure("a", "timeout");
    vi.advanceTimersByTime(10_000);
    manager.reportFailure("a", "timeout");
    vi.advanceTimersByTime(15_000);
    manager.reportFailure("a", "timeout");

    const cooldownUntil = manager.getHealthSnapshot().get("a")?.cooldownUntil ?? 0;
    expect(cooldownUntil).toBe(Date.now() + 15_000);
  });

  it("persists and reloads state", async () => {
    const filePath = makePath();
    await mkdir(join(filePath, ".."), { recursive: true }).catch(() => {});

    const writer = new AuthProfileManager({ filePath });
    writer.addProfile({ id: "a", provider: "anthropic", type: "api_key", credential: "key" });
    writer.reportFailure("a", "auth");
    await writer.save();

    const reader = new AuthProfileManager({ filePath });
    await reader.load();

    expect(reader.getAvailable("anthropic")).toBeNull();
    const health = reader.getHealthSnapshot().get("a");
    expect(health?.failureCounts.auth).toBe(1);
  });

  it("fails over within provider", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "p1", provider: "openrouter", type: "api_key", credential: "k1" });
    manager.addProfile({ id: "p2", provider: "openrouter", type: "api_key", credential: "k2" });

    manager.reportFailure("p1", "server");
    expect(manager.getAvailable("openrouter")?.id).toBe("p2");
  });

  it("skips expired oauth profile without refresh token", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });

    manager.addProfile({
      id: "expired",
      provider: "anthropic",
      type: "oauth",
      credential: "tok",
      expiresAt: Date.now() - 1,
    });

    manager.addProfile({
      id: "refreshable",
      provider: "anthropic",
      type: "oauth",
      credential: "tok2",
      refreshToken: "rtok",
      expiresAt: Date.now() - 1,
    });

    expect(manager.getAvailable("anthropic")?.id).toBe("refreshable");
  });

  it("returns accurate health snapshot", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "ollama", type: "none", credential: "" });

    manager.reportFailure("a", "timeout");
    const snapshot = manager.getHealthSnapshot();

    expect(snapshot.size).toBe(1);
    expect(snapshot.get("a")?.failureCounts.timeout).toBe(1);
  });

  it("best-effort distributes consecutive getAvailable calls", () => {
    const manager = new AuthProfileManager({ filePath: makePath() });
    manager.addProfile({ id: "a", provider: "openrouter", type: "api_key", credential: "k1" });
    manager.addProfile({ id: "b", provider: "openrouter", type: "api_key", credential: "k2" });

    const first = manager.getAvailable("openrouter")?.id;
    const second = manager.getAvailable("openrouter")?.id;

    expect(first).toBe("a");
    expect(second).toBe("b");
  });
});
