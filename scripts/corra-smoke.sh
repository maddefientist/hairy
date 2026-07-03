#!/usr/bin/env bash
# Corra post-deploy smoke harness (M6). Verifies DEPLOYED behavior, not just unit-green — the whole
# reason the Fable audit found the running system was not the designed system for weeks.
#
# Run ON the deploy host (moni) from the app dir after `systemctl --user restart hairy-corra`:
#   cd ~/corra-app && bash scripts/corra-smoke.sh
# Exit 0 = all checks pass (safe). Non-zero = a check failed (investigate before trusting the deploy).
set -uo pipefail

APP_DIR="${CORRA_APP_DIR:-$HOME/corra-app}"
DATA_DIR="$APP_DIR/data"
UNIT="hairy-corra"
WINDOW="${CORRA_SMOKE_WINDOW:-10 minutes ago}"
MARKER="Corra — Research Correspondent"
fail=0
pass() { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[0;31m✗\033[0m %s\n' "$1"; fail=1; }

echo "== Corra smoke =="

# 1) service is active and not crash-looping
state=$(systemctl --user is-active "$UNIT" 2>/dev/null)
[ "$state" = "active" ] && pass "service active" || bad "service not active ($state)"

# 2) persona identity present at the path the prompt builder reads
IDF="$DATA_DIR/memory/identity.md"
if [ -f "$IDF" ] && grep -q "$MARKER" "$IDF"; then pass "identity file present with marker"; else bad "identity file missing/markerless: $IDF"; fi

# 3) the RENDERED prompt actually contains the persona (not 'No identity file found')
IDJS=$(find "$APP_DIR" -path '*/node_modules' -prune -o -name identity.js -path '*hairy-agent*' -print 2>/dev/null | head -1)
if [ -n "$IDJS" ]; then
  rendered=$(node --input-type=module -e "
    import { buildSystemPrompt } from '$IDJS';
    const p = await buildSystemPrompt({ dataDir: '$DATA_DIR', agentName: 'Corra', toolDescriptions: [] });
    console.log(p.includes('$MARKER') && !p.includes('No identity file found') ? 'OK' : 'MISS');
  " 2>/dev/null)
  [ "$rendered" = "OK" ] && pass "rendered system prompt carries the Corra persona" || bad "rendered prompt missing persona ($rendered)"
else
  bad "could not locate built identity.js to render the prompt"
fi

# 4) inbox is the reliable backbone and readable
if [ -f "$DATA_DIR/corra/inbox.json" ]; then
  n=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DATA_DIR/corra/inbox.json','utf8')).length)}catch(e){console.log('ERR')}" 2>/dev/null)
  [ "$n" != "ERR" ] && pass "inbox.json readable ($n entries)" || bad "inbox.json unreadable/corrupt"
else
  bad "inbox.json missing"
fi

# 5) no error storm in the recent window: no hive poison-loop, no ZodErrors, no unhandled errors
errs=$(journalctl --user -u "$UNIT" --since "$WINDOW" --no-pager 2>/dev/null \
  | grep -icE "all endpoints unreachable|ZodError|Expected array, received|unhandledRejection|identity NOT loaded")
[ "$errs" -eq 0 ] && pass "no error-storm signatures in last '$WINDOW'" || bad "$errs error-storm log lines in last '$WINDOW'"

# 6) hive reachable for the corra namespace
if [ -f "$HOME/corra.env" ]; then
  KEY=$(grep '^HARI_HIVE_API_KEY=' "$HOME/corra.env" | cut -d= -f2-)
  URL=$(grep '^HARI_HIVE_URL=' "$HOME/corra.env" | cut -d= -f2-); URL="${URL:-http://192.168.1.225:8088}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/recall" -H 'content-type: application/json' -H "x-api-key: $KEY" -d '{"namespace":"corra","query_text":"smoke","top_k":1}' 2>/dev/null)
  [ "$code" = "200" ] && pass "hive recall reachable (corra ns)" || bad "hive recall HTTP $code"
else
  bad "corra.env not found for hive check"
fi

echo "== $([ $fail -eq 0 ] && echo 'SMOKE PASS' || echo 'SMOKE FAIL') =="
exit $fail
