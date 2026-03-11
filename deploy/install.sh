#!/usr/bin/env bash
# Install Hairy on aghari VM
set -euo pipefail

HAIRY_DIR="/home/aghari/hairy"
REPO_URL="${HAIRY_REPO_URL:-<repo-url>}"

if [ -d "$HAIRY_DIR" ]; then
  cd "$HAIRY_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$HAIRY_DIR"
  cd "$HAIRY_DIR"
fi

npm install -g pnpm
pnpm install
pnpm build

[ -f .env ] || cp deploy/hairy-agent.env.example .env

mkdir -p ~/.config/systemd/user
cp deploy/hairy-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable hairy-agent

echo "Install complete. Run: systemctl --user start hairy-agent"
