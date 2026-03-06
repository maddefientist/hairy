#!/usr/bin/env bash
# Moni Agent — Hairy Framework startup script
set -euo pipefail

cd "$(dirname "$0")"

# Load environment
set -a
source .env
set +a

exec node apps/hairy-agent/dist/main.js
