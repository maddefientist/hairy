import type { PluginManifest } from "../plugin-manifest.js";
import type { HairyClawPlugin } from "../plugin.js";

export const MANIFEST: PluginManifest = {
  name: "content_safety",
  version: "1.0.0",
  description: "Filters model responses for secret leakage, blocked patterns, and length limits",
  capabilities: ["content-filtering", "response-safety"],
  requiredPermissions: [],
  trustLevel: "builtin",
};

export interface ContentSafetyOptions {
  blockedPatterns?: RegExp[];
  protectEnvVars?: string[];
  maxResponseLength?: number;
  customCheck?: (text: string) => { safe: boolean; reason?: string };
}

const DEFAULT_MAX_RESPONSE_LENGTH = 8_000;
const DEFAULT_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "WHATSAPP_API_KEY",
];

const API_SECRET_PATTERNS: RegExp[] = [/sk-[A-Za-z0-9_-]{10,}/, /Bearer\s+[A-Za-z0-9._-]{10,}/i];

const SAFETY_REPLACEMENT = "I've filtered my response for safety. Let me try again differently.";
const TRUNCATED_SUFFIX = "[truncated — full response available via /expand]";

const findPatternHit = (text: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return `blocked pattern matched: ${pattern.toString()}`;
    }
  }
  return null;
};

const findProtectedEnvLeak = (text: string, envNames: string[]): string | null => {
  for (const name of envNames) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0 && text.includes(value)) {
      return `protected env value leaked: ${name}`;
    }

    const namePattern = new RegExp(`${name}\\s*[:=]`, "i");
    if (namePattern.test(text)) {
      return `protected env variable referenced: ${name}`;
    }
  }

  return null;
};

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }

  const reserve = Math.max(0, maxLength - TRUNCATED_SUFFIX.length - 1);
  return `${text.slice(0, reserve)}\n${TRUNCATED_SUFFIX}`;
};

export const createContentSafetyPlugin = (opts: ContentSafetyOptions = {}): HairyClawPlugin => {
  const blockedPatterns = opts.blockedPatterns ?? [];
  const protectEnvVars = opts.protectEnvVars ?? DEFAULT_ENV_VARS;
  const maxResponseLength = opts.maxResponseLength ?? DEFAULT_MAX_RESPONSE_LENGTH;

  return {
    name: "content_safety",
    afterModel: async (responseText, _toolCalls, ctx) => {
      const customResult = opts.customCheck?.(responseText);
      if (customResult && !customResult.safe) {
        ctx.state.set("contentSafety.retry", true);
        ctx.state.set("contentSafety.filteredResponse", SAFETY_REPLACEMENT);
        ctx.state.set(
          "contentSafety.reason",
          customResult.reason ?? "custom check blocked response",
        );
        return null;
      }

      const blockedReason = findPatternHit(responseText, blockedPatterns);
      if (blockedReason) {
        ctx.state.set("contentSafety.retry", true);
        ctx.state.set("contentSafety.filteredResponse", SAFETY_REPLACEMENT);
        ctx.state.set("contentSafety.reason", blockedReason);
        return null;
      }

      const secretReason = findPatternHit(responseText, API_SECRET_PATTERNS);
      if (secretReason) {
        ctx.state.set("contentSafety.retry", true);
        ctx.state.set("contentSafety.filteredResponse", SAFETY_REPLACEMENT);
        ctx.state.set("contentSafety.reason", secretReason);
        return null;
      }

      const envReason = findProtectedEnvLeak(responseText, protectEnvVars);
      if (envReason) {
        ctx.state.set("contentSafety.retry", true);
        ctx.state.set("contentSafety.filteredResponse", SAFETY_REPLACEMENT);
        ctx.state.set("contentSafety.reason", envReason);
        return null;
      }

      return truncateText(responseText, maxResponseLength);
    },
  };
};
