#!/usr/bin/env bash
# Install HairyClaw agent framework
set -euo pipefail

INSTALL_DIR="${HAIRYCLAW_DIR:-$HOME/hairyclaw}"
REPO_URL="${HAIRYCLAW_REPO_URL:-https://github.com/maddefientist/hairyclaw.git}"
SERVICE_NAME="${HAIRYCLAW_SERVICE:-hairyclaw}"

echo "=== HairyClaw Agent Framework Installer ==="
echo "Install dir: $INSTALL_DIR"
echo "Service name: $SERVICE_NAME"

if [ -d "$INSTALL_DIR" ]; then
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install deps and build
command -v pnpm >/dev/null || npm install -g pnpm
pnpm install
pnpm build

# Create .env from example if missing
[ -f .env ] || cp deploy/hairyclaw.env.example .env

# Install systemd service
mkdir -p ~/.config/systemd/user
cp deploy/hairyclaw.service ~/.config/systemd/user/${SERVICE_NAME}.service
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

echo ""
echo "=== Install complete ==="
echo "1. Edit .env with your API keys and agent config"
echo "2. Create config/local.toml with agent name and channel settings"
echo "3. Create data/memory/identity.md with agent personality"
echo "4. Run: systemctl --user start $SERVICE_NAME"
echo ""
echo "See docs/MIGRATION.md for migrating from OpenClaw or other frameworks."
