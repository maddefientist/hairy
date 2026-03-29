#!/usr/bin/env bash
# Self-update script for HairyClaw agent deployments.
# Called by the /update command at runtime.
#
# Usage: deploy/update.sh [--restart]
#   --restart  Restart the systemd service after update (default: true)
#
# Output: JSON on the last line for the agent to parse.
# Exit 0 = success, non-zero = failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

RESTART="${1:-true}"
SERVICE_NAME="${HAIRYCLAW_SERVICE:-hairyclaw}"

# Capture current state
PREV_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
PREV_SUBJECT="$(git log --oneline -1 2>/dev/null || echo 'unknown')"

# Check for uncommitted changes that would block pull
if ! git diff --quiet 2>/dev/null; then
  echo '{"success":false,"error":"working tree has uncommitted changes — stash or commit first","previousVersion":"'"$PREV_COMMIT"'","currentVersion":"'"$PREV_COMMIT"'","changes":""}'
  exit 1
fi

# Pull latest
if ! git pull --ff-only 2>/dev/null; then
  echo '{"success":false,"error":"git pull failed — branch may have diverged","previousVersion":"'"$PREV_COMMIT"'","currentVersion":"'"$PREV_COMMIT"'","changes":""}'
  exit 1
fi

NEW_COMMIT="$(git rev-parse --short HEAD)"

# If no changes, skip build
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo '{"success":true,"previousVersion":"'"$PREV_COMMIT"'","currentVersion":"'"$NEW_COMMIT"'","changes":"already up to date"}'
  exit 0
fi

# Collect changelog
CHANGES="$(git log --oneline "${PREV_COMMIT}..${NEW_COMMIT}" 2>/dev/null | head -20)"

# Install deps if lockfile changed
if git diff --name-only "${PREV_COMMIT}..${NEW_COMMIT}" | grep -q "pnpm-lock.yaml"; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install 2>/dev/null
fi

# Build
if ! pnpm build 2>/dev/null; then
  echo '{"success":false,"error":"build failed after pull","previousVersion":"'"$PREV_COMMIT"'","currentVersion":"'"$NEW_COMMIT"'","changes":"'"$(echo "$CHANGES" | tr '\n' '; ' | sed 's/"/\\"/g')"'"}'
  exit 1
fi

# Escape changes for JSON
CHANGES_ESCAPED="$(echo "$CHANGES" | tr '\n' '; ' | sed 's/"/\\"/g')"

echo '{"success":true,"previousVersion":"'"$PREV_COMMIT"'","currentVersion":"'"$NEW_COMMIT"'","changes":"'"$CHANGES_ESCAPED"'"}'

# Restart if requested (happens AFTER the JSON output so the agent can respond)
if [ "$RESTART" = "--restart" ] || [ "$RESTART" = "true" ]; then
  # Give the agent 2 seconds to send the response before we kill it
  (sleep 2 && systemctl --user restart "$SERVICE_NAME" 2>/dev/null) &
fi
