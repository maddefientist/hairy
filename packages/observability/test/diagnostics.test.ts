import { describe, expect, it } from "vitest";
import { DiagnosticsRecorder } from "../src/diagnostics.js";

describe("DiagnosticsRecorder", () => {
  it("records and returns bounded, redacted events per category", () => {
    const recorder = new DiagnosticsRecorder({ maxPerCategory: 3 });
    recorder.record("provider_attempt", "success", { provider: "ollama" });
    recorder.record("provider_attempt", "rate_limit", { provider: "openrouter" });

    const snapshot = recorder.snapshot();
    expect(snapshot.provider_attempt).toHaveLength(2);
    expect(snapshot.provider_attempt[0]).toMatchObject({
      stage: "success",
      meta: { provider: "ollama" },
    });
  });

  it("caps entries per category (ring buffer)", () => {
    const recorder = new DiagnosticsRecorder({ maxPerCategory: 3 });
    for (let i = 0; i < 10; i++) {
      recorder.record("telegram_poll", `iteration-${i}`);
    }
    const snapshot = recorder.snapshot();
    expect(snapshot.telegram_poll).toHaveLength(3);
    // Oldest entries are dropped; most recent survive.
    expect(snapshot.telegram_poll.map((e) => e.stage)).toEqual([
      "iteration-7",
      "iteration-8",
      "iteration-9",
    ]);
  });

  it("strips meta keys that look sensitive (tokens, prompts, chat ids, urls)", () => {
    const recorder = new DiagnosticsRecorder();
    recorder.record("provider_attempt", "auth_failure", {
      provider: "anthropic",
      apiKey: "sk-should-not-appear",
      token: "should-not-appear",
      prompt: "should not appear",
      chatId: "12345",
      baseUrl: "https://internal.example.com",
    });

    const snapshot = recorder.snapshot();
    const meta = snapshot.provider_attempt[0].meta ?? {};
    expect(meta.provider).toBe("anthropic");
    expect(meta.apiKey).toBeUndefined();
    expect(meta.token).toBeUndefined();
    expect(meta.prompt).toBeUndefined();
    expect(meta.chatId).toBeUndefined();
    expect(meta.baseUrl).toBeUndefined();
  });

  it("truncates long string meta values", () => {
    const recorder = new DiagnosticsRecorder();
    recorder.record("tool_error", "schema_failure", { detail: "x".repeat(500) });
    const meta = recorder.snapshot().tool_error[0].meta ?? {};
    expect((meta.detail as string).length).toBeLessThanOrEqual(65);
  });

  it("caps the number of meta keys per event", () => {
    const recorder = new DiagnosticsRecorder();
    const meta: Record<string, string> = {};
    for (let i = 0; i < 20; i++) meta[`k${i}`] = "v";
    recorder.record("tool_error", "stage", meta);
    const stored = recorder.snapshot().tool_error[0].meta ?? {};
    expect(Object.keys(stored).length).toBeLessThanOrEqual(6);
  });

  it("counts() summarizes stage frequency per category", () => {
    const recorder = new DiagnosticsRecorder();
    recorder.record("audio_transcription", "ok");
    recorder.record("audio_transcription", "ok");
    recorder.record("audio_transcription", "no_provider");

    const counts = recorder.counts();
    expect(counts.audio_transcription).toEqual({ ok: 2, no_provider: 1 });
  });

  it("independent categories do not interfere with each other's bounds", () => {
    const recorder = new DiagnosticsRecorder({ maxPerCategory: 2 });
    recorder.record("a", "x");
    recorder.record("a", "y");
    recorder.record("a", "z");
    recorder.record("b", "x");

    const snapshot = recorder.snapshot();
    expect(snapshot.a).toHaveLength(2);
    expect(snapshot.b).toHaveLength(1);
  });
});
