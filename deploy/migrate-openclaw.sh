#!/usr/bin/env bash
# Migrate OpenClaw config into Hairy config + env files.
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$OPENCLAW_DIR/openclaw.json}"
HAIRY_DIR="${HAIRY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ ! -f "$OPENCLAW_CONFIG" ]; then
  echo "OpenClaw config not found: $OPENCLAW_CONFIG" >&2
  exit 1
fi

mkdir -p "$HAIRY_DIR/config"
mkdir -p "$HAIRY_DIR/data/skills"

OPENCLAW_CONFIG="$OPENCLAW_CONFIG" HAIRY_DIR="$HAIRY_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = process.env.OPENCLAW_CONFIG;
const hairyDir = process.env.HAIRY_DIR;

const raw = fs.readFileSync(sourcePath, "utf8");
const source = JSON.parse(raw);

const provider = source.providers ?? {};
const routing = source.routing ?? {};
const channels = source.channels ?? {};

const fallback = Array.isArray(routing.modelFallbackChain)
  ? routing.modelFallbackChain
  : Array.isArray(routing.fallback)
    ? routing.fallback
    : [];

const toml = [
  "[providers.anthropic]",
  `enabled = ${provider.anthropic ? "true" : "false"}`,
  `default_model = \"${provider.anthropic?.model ?? "claude-sonnet-4-20250514"}\"`,
  "",
  "[providers.openrouter]",
  `enabled = ${provider.openrouter ? "true" : "false"}`,
  `default_model = \"${provider.openrouter?.model ?? "anthropic/claude-sonnet-4-20250514"}\"`,
  "",
  "[providers.gemini]",
  `enabled = ${provider.gemini ? "true" : "false"}`,
  `default_model = \"${provider.gemini?.model ?? "gemini-2.5-flash"}\"`,
  "",
  "[providers.ollama]",
  `enabled = ${provider.ollama ? "true" : "false"}`,
  `base_url = \"${provider.ollama?.baseUrl ?? "http://localhost:11434"}\"`,
  `default_model = \"${provider.ollama?.model ?? "llama3.2"}\"`,
  `model_fallback_chain = [${fallback.map((entry) => `\"${String(entry)}\"`).join(", ")}]`,
  "",
  "[routing]",
  `default_provider = \"${routing.defaultProvider ?? "anthropic"}\"`,
  `fallback_chain = [${(Array.isArray(routing.fallbackChain) ? routing.fallbackChain : []).map((entry) => `\"${String(entry)}\"`).join(", ")}]`,
  "",
  "[channels.telegram]",
  `enabled = ${channels.telegram ? "true" : "false"}`,
  `mode = \"${channels.telegram?.mode ?? "bot"}\"`,
  "",
  "[channels.whatsapp]",
  `enabled = ${channels.whatsapp ? "true" : "false"}`,
  "",
].join("\n");

const envLines = [
  `ANTHROPIC_API_KEY=${provider.anthropic?.apiKey ?? ""}`,
  `OPENROUTER_API_KEY=${provider.openrouter?.apiKey ?? ""}`,
  `GEMINI_API_KEY=${provider.gemini?.apiKey ?? ""}`,
  `OLLAMA_ENABLED=${provider.ollama ? "true" : "false"}`,
  `OLLAMA_BASE_URL=${provider.ollama?.baseUrl ?? "http://localhost:11434"}`,
  `OLLAMA_MODEL=${provider.ollama?.model ?? "llama3.2"}`,
  `TELEGRAM_MODE=${channels.telegram?.mode ?? "bot"}`,
  `TELEGRAM_BOT_TOKEN=${channels.telegram?.botToken ?? ""}`,
  `TELEGRAM_CHAT_IDS=${Array.isArray(channels.telegram?.chatIds) ? channels.telegram.chatIds.join(",") : ""}`,
].join("\n");

fs.writeFileSync(path.join(hairyDir, "config", "production.toml"), `${toml}\n`, "utf8");
fs.writeFileSync(path.join(hairyDir, ".env"), `${envLines}\n`, "utf8");
NODE

if [ -d "$OPENCLAW_DIR/skills" ]; then
  cp -R "$OPENCLAW_DIR/skills/." "$HAIRY_DIR/data/skills/"
fi

echo "Migration complete:"
echo "- $HAIRY_DIR/config/production.toml"
echo "- $HAIRY_DIR/.env"
echo "- $HAIRY_DIR/data/skills/"
