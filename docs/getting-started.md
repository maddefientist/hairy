# Getting Started

## Prerequisites
- Node.js 22+
- pnpm 9+
- (Optional) Rust + Go for sidecars

## Install
```bash
pnpm install
```

## Configure
Set at least one provider key:
```bash
export ANTHROPIC_API_KEY=...
# or
export OPENROUTER_API_KEY=...
```

Optional channels:
```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_IDS=123,456
export WEBHOOK_SECRET=...
```

## Run
```bash
pnpm dev
```

Health endpoint:
- `GET /health` on `HAIRY_HEALTH_PORT` (default 9090)
