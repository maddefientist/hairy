import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/router.js";

describe("ModelRouter", () => {
  it("routes image requests using image_input rule", () => {
    const router = new ModelRouter({
      defaultProvider: "anthropic",
      fallbackChain: ["anthropic", "openrouter"],
      rules: {
        image_input: { provider: "ollama", model: "llava" },
      },
    });

    const routed = router.route({ hasImages: true });
    expect(routed.provider).toBe("ollama");
    expect(routed.model).toBe("llava");
  });
});
