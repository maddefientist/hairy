# Moni — Personal Development Agent

Deployment example: Telegram agent using GLM-5:cloud (orchestrator) + qwen3.5:9b (executor) via Ollama on LAN.

## Architecture

```
User (Telegram @MoneyMariBot)
    ↓
GLM-5:cloud (orchestrator — thinks, plans, responds)
    │
    ├─ memory_recall     (direct)
    ├─ memory_ingest     (direct)
    ├─ identity_evolve   (direct)
    │
    └─ delegate ──→ qwen3.5:9b (executor — runs tools)
                       ├─ bash
                       ├─ read
                       ├─ write
                       ├─ edit
                       └─ web-search
```

## Config

### `config/default.toml` (override for Moni)
```toml
[agent]
name = "Moni"
data_dir = "/home/moni/hairy/data"
mode = "orchestrator"

[channels.telegram]
enabled = true
mode = "bot"

[channels.cli]
enabled = false

[providers.ollama]
enabled = true
base_url = "http://192.168.1.225:11434"
default_model = "glm-5:cloud"
fallback_model = "qwen3.5:9b"

[routing]
default_provider = "ollama"
fallback_chain = ["ollama", "ollama-fallback"]
```

### `.env`
```bash
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_IDS=<chat_id>
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://192.168.1.225:11434
OLLAMA_MODEL=glm-5:cloud
OLLAMA_FALLBACK_MODEL=qwen3.5:9b
HAIRY_AGENT_MODE=orchestrator
HARI_HIVE_URL=http://192.168.1.225:8088
HARI_HIVE_API_KEY=<key>
HARI_HIVE_NAMESPACE=moni-agent
HARI_HIVE_DEVICE=moni-hairy
SEARXNG_URL=http://192.168.1.225:8080
```

## Deployment

```bash
# Install
pnpm install && pnpm build

# Start (via systemd user service)
cp examples/moni/moni-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable moni-agent.service
systemctl --user start moni-agent.service

# Enable boot persistence
loginctl enable-linger $(whoami)

# Check
systemctl --user status moni-agent
curl http://127.0.0.1:9090/health | jq
```

## Cost

$0 — all inference via Ollama on LAN. No cloud API keys needed.
