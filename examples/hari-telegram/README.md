# Hari — Telegram Agent

Example HairyClaw deployment for Hari on the agent VM.

## Setup

1. Copy `local.toml` → `config/local.toml` on the agent VM
2. Copy `identity.md` → `data/memory/identity.md` on the agent VM
3. Set `.env` with `HARI_HIVE_NAMESPACE=claude-shared` and API keys
4. Build: `pnpm build`
5. Start: `systemctl --user start hairyclaw`

## Required .env vars

```bash
ANTHROPIC_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=...
HARI_HIVE_URL=http://192.168.1.225:8088
HARI_HIVE_API_KEY=...
HARI_HIVE_NAMESPACE=claude-shared
```
