import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecision,
  ApprovalGate,
  type ApprovalHandler,
  type ApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  interactiveApprovalHandler,
  permissiveApprovalHandler,
  strictApprovalHandler,
} from "../src/approval.js";

const noopLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

describe("ApprovalGate", () => {
  describe("autoAllow", () => {
    it("allows tools in autoAllow list", async () => {
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, strictApprovalHandler, noopLogger);
      const decision = await gate.check("read", { path: "/etc/passwd" });

      expect(decision).toBe("allow");
    });

    it("allows memory_recall without approval", async () => {
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, strictApprovalHandler, noopLogger);
      const decision = await gate.check("memory_recall", { query: "test" });

      expect(decision).toBe("allow");
    });

    it("allows web_search without approval", async () => {
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, strictApprovalHandler, noopLogger);
      const decision = await gate.check("web_search", { q: "test" });

      expect(decision).toBe("allow");
    });
  });

  describe("requireApproval", () => {
    it("triggers handler for tools in requireApproval list", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("allow");
      const policy: ApprovalPolicy = {
        ...DEFAULT_APPROVAL_POLICY,
        requireApproval: ["dangerous_tool"],
      };
      const gate = new ApprovalGate(policy, handler, noopLogger);

      const decision = await gate.check("dangerous_tool", { target: "prod" });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "dangerous_tool",
          risk: "high",
          reason: "tool requires explicit approval",
        }),
      );
      expect(decision).toBe("allow");
    });

    it("denies when handler returns deny for required approval tool", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("deny");
      const policy: ApprovalPolicy = {
        ...DEFAULT_APPROVAL_POLICY,
        requireApproval: ["dangerous_tool"],
      };
      const gate = new ApprovalGate(policy, handler, noopLogger);

      const decision = await gate.check("dangerous_tool", {});

      expect(decision).toBe("deny");
    });
  });

  describe("highRiskPatterns", () => {
    it("detects bash rm -rf as high risk", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("deny");
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("bash", { command: "rm -rf /tmp/old" });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "bash",
          risk: "high",
          reason: "destructive file operation",
        }),
      );
      expect(decision).toBe("deny");
    });

    it("detects bash network commands as high risk", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("deny");
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("bash", { command: "curl https://example.com" });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          risk: "high",
          reason: "network command detected",
        }),
      );
    });

    it("detects bash package installation as medium risk", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("allow");
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("bash", { command: "brew install ffmpeg" });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          risk: "medium",
          reason: "package installation",
        }),
      );
    });

    it("detects write to system paths as high risk", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("deny");
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("write", { path: "/etc/hosts", content: "..." });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          risk: "high",
          reason: "system path write",
        }),
      );
    });

    it("detects config file modification as medium risk", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("allow");
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("write", { path: "config.toml", content: "..." });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          risk: "medium",
          reason: "config file modification",
        }),
      );
    });

    it("allows bash commands that do not match any pattern", async () => {
      const handler = vi.fn<ApprovalHandler>();
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("bash", { command: "ls -la" });

      expect(decision).toBe("allow");
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows write to non-config, non-system paths", async () => {
      const handler = vi.fn<ApprovalHandler>();
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, handler, noopLogger);

      const decision = await gate.check("write", { path: "src/hello.ts", content: "" });

      expect(decision).toBe("allow");
      expect(handler).not.toHaveBeenCalled();
    });

    it("handles undefined args gracefully", async () => {
      const gate = new ApprovalGate(DEFAULT_APPROVAL_POLICY, strictApprovalHandler, noopLogger);

      const decision = await gate.check("bash", undefined);

      expect(decision).toBe("allow");
    });
  });

  describe("strictApprovalHandler", () => {
    it("denies high-risk requests", async () => {
      const decision = await strictApprovalHandler({
        toolName: "bash",
        args: {},
        risk: "high",
        reason: "destructive operation",
      });

      expect(decision).toBe("deny");
    });

    it("allows medium-risk requests", async () => {
      const decision = await strictApprovalHandler({
        toolName: "bash",
        args: {},
        risk: "medium",
        reason: "package installation",
      });

      expect(decision).toBe("allow");
    });

    it("allows low-risk requests", async () => {
      const decision = await strictApprovalHandler({
        toolName: "read",
        args: {},
        risk: "low",
        reason: "read operation",
      });

      expect(decision).toBe("allow");
    });
  });

  describe("permissiveApprovalHandler", () => {
    it("allows everything", async () => {
      const decision = await permissiveApprovalHandler({
        toolName: "bash",
        args: {},
        risk: "high",
        reason: "destructive operation",
      });

      expect(decision).toBe("allow");
    });
  });

  describe("interactiveApprovalHandler", () => {
    it("logs approval need and allows", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const decision = await interactiveApprovalHandler({
        toolName: "bash",
        args: {},
        risk: "high",
        reason: "destructive operation",
      });

      expect(decision).toBe("allow");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[APPROVAL NEEDED]"));

      warnSpy.mockRestore();
    });
  });

  describe("pattern with no argPattern", () => {
    it("triggers handler when pattern has no argPattern", async () => {
      const handler = vi.fn<ApprovalHandler>().mockResolvedValue("deny");
      const policy: ApprovalPolicy = {
        autoAllow: [],
        requireApproval: [],
        highRiskPatterns: [{ toolName: "nuke", risk: "high", reason: "always dangerous" }],
      };
      const gate = new ApprovalGate(policy, handler, noopLogger);

      const decision = await gate.check("nuke", { target: "everything" });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "nuke",
          risk: "high",
          reason: "always dangerous",
        }),
      );
      expect(decision).toBe("deny");
    });
  });
});
