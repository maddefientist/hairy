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
# Telegram bot mode
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_IDS=123,456

# Telegram MTProto mode (user account)
export TELEGRAM_MODE=mtproto
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=...
export TELEGRAM_PHONE_NUMBER=+15551234567
export TELEGRAM_SESSION_FILE=./data/telegram/session.txt
# One-time: pnpm telegram:session

export WEBHOOK_SECRET=...
```

## Run
```bash
pnpm dev
```

Health endpoint:
- `GET /health` on `HAIRY_HEALTH_PORT` (default 9090)
