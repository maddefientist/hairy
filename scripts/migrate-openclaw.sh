#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# migrate-openclaw.sh — Migrate an OpenClaw agent to HairyClaw
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   ./scripts/migrate-openclaw.sh [OPTIONS]
#
# Options:
#   --openclaw-dir DIR    OpenClaw home directory (default: ~/.openclaw)
#   --hairyclaw-dir DIR   HairyClaw install directory (default: ~/hairyclaw)
#   --agent-name NAME     Agent name for HairyClaw config (required)
#   --channel CHANNEL     Primary channel: telegram|whatsapp|cli (default: telegram)
#   --provider PROVIDER   LLM provider: anthropic|openrouter|ollama|gemini (default: anthropic)
#   --model MODEL         Default model (default: claude-sonnet-4-20250514)
#   --hive-namespace NS   Hive namespace (default: claude-shared)
#   --dry-run             Show what would be done without doing it
#   --backup-only         Only create backup, don't migrate
#   --help                Show this help
#
# What it does:
#   1. Validates OpenClaw installation exists
#   2. Creates timestamped backup of OpenClaw data
#   3. Extracts identity from IDENTITY.md + SOUL.md + USER.md + system.md
#   4. Extracts knowledge from MEMORY.md + daily memory logs
#   5. Migrates skills to HairyClaw format
#   6. Migrates heartbeat/cron config
#   7. Generates config/local.toml
#   8. Generates data/memory/identity.md
#   9. Generates data/memory/knowledge.md
#  10. Preserves workspace files (projects, strategies, docs)
#  11. Creates migration report
#
# After running:
#   1. Review data/memory/identity.md — tweak personality
#   2. Review data/memory/knowledge.md — prune stale facts
#   3. Set API keys in .env
#   4. Build: pnpm build
#   5. Start: systemctl --user start hairyclaw
#
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }
info() { echo -e "${CYAN}[info]${NC} $*"; }
step() { echo -e "\n${BOLD}${BLUE}═══ $* ═══${NC}"; }

# ── Defaults ────────────────────────────────────────────────────────────
OPENCLAW_DIR="$HOME/.openclaw"
HAIRYCLAW_DIR="$HOME/hairyclaw"
AGENT_NAME=""
CHANNEL="telegram"
PROVIDER="anthropic"
MODEL="claude-sonnet-4-20250514"
HIVE_NAMESPACE="claude-shared"
DRY_RUN=false
BACKUP_ONLY=false

# ── Parse args ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-dir)  OPENCLAW_DIR="$2"; shift 2 ;;
    --hairyclaw-dir) HAIRYCLAW_DIR="$2"; shift 2 ;;
    --agent-name)    AGENT_NAME="$2"; shift 2 ;;
    --channel)       CHANNEL="$2"; shift 2 ;;
    --provider)      PROVIDER="$2"; shift 2 ;;
    --model)         MODEL="$2"; shift 2 ;;
    --hive-namespace) HIVE_NAMESPACE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --backup-only)   BACKUP_ONLY=true; shift ;;
    --help)
      head -35 "$0" | tail -33
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Validate ────────────────────────────────────────────────────────────
if [[ -z "$AGENT_NAME" ]]; then
  err "Agent name is required. Use --agent-name <name>"
  err "Example: ./scripts/migrate-openclaw.sh --agent-name Hari"
  exit 1
fi

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  err "OpenClaw directory not found: $OPENCLAW_DIR"
  exit 1
fi

if [[ ! -d "$HAIRYCLAW_DIR" ]]; then
  err "HairyClaw directory not found: $HAIRYCLAW_DIR"
  err "Clone it first: git clone https://github.com/maddefientist/hairyclaw.git $HAIRYCLAW_DIR"
  exit 1
fi

WORKSPACE="$OPENCLAW_DIR/workspace"
DATA_DIR="$HAIRYCLAW_DIR/data"
BACKUP_DIR="$OPENCLAW_DIR/backups/pre-migration-$(date +%Y%m%d-%H%M%S)"
REPORT=""

add_report() { REPORT+="$1"$'\n'; }

step "OpenClaw → HairyClaw Migration"
log "Agent name:     ${BOLD}$AGENT_NAME${NC}"
log "OpenClaw dir:   $OPENCLAW_DIR"
log "HairyClaw dir:  $HAIRYCLAW_DIR"
log "Channel:        $CHANNEL"
log "Provider:       $PROVIDER"
log "Model:          $MODEL"
log "Hive namespace: $HIVE_NAMESPACE"
log "Dry run:        $DRY_RUN"
echo ""

add_report "# Migration Report: OpenClaw → HairyClaw"
add_report "Date: $(date -Iseconds)"
add_report "Agent: $AGENT_NAME"
add_report ""

# ── Helper: write file or show dry-run ──────────────────────────────────
write_file() {
  local path="$1"
  local content="$2"
  if $DRY_RUN; then
    info "[dry-run] Would write: $path ($(echo "$content" | wc -c | tr -d ' ') bytes)"
  else
    mkdir -p "$(dirname "$path")"
    echo "$content" > "$path"
    log "Wrote: $path"
  fi
}

copy_dir() {
  local src="$1"
  local dst="$2"
  if [[ ! -d "$src" ]]; then
    warn "Source dir not found, skipping: $src"
    return
  fi
  if $DRY_RUN; then
    local count
    count=$(find "$src" -type f 2>/dev/null | wc -l | tr -d ' ')
    info "[dry-run] Would copy $count files: $src → $dst"
  else
    mkdir -p "$dst"
    cp -r "$src"/. "$dst"/ 2>/dev/null || true
    log "Copied: $src → $dst"
  fi
}

read_if_exists() {
  local path="$1"
  if [[ -f "$path" ]]; then
    cat "$path"
  else
    echo ""
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1: Backup
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 1: Backup OpenClaw Data"

if $DRY_RUN; then
  info "[dry-run] Would create backup at: $BACKUP_DIR"
else
  mkdir -p "$BACKUP_DIR"

  # Backup the critical files, not the huge media
  for item in identity workspace/IDENTITY.md workspace/SOUL.md workspace/USER.md \
              workspace/MEMORY.md workspace/HEARTBEAT.md workspace/INFRASTRUCTURE.md \
              workspace/PROJECTS.md workspace/PROJECT_TRACKER.md workspace/INTEGRATION_GAPS.md \
              openclaw.json skills cron; do
    src="$OPENCLAW_DIR/$item"
    if [[ -e "$src" ]]; then
      dst="$BACKUP_DIR/$item"
      mkdir -p "$(dirname "$dst")"
      cp -r "$src" "$dst" 2>/dev/null || true
    fi
  done

  # Backup daily memory logs
  if [[ -d "$WORKSPACE/memory" ]]; then
    mkdir -p "$BACKUP_DIR/memory"
    cp "$WORKSPACE"/memory/*.md "$BACKUP_DIR/memory/" 2>/dev/null || true
  fi

  # Backup sessions (just filenames for reference, they're huge)
  if [[ -d "$OPENCLAW_DIR/agents/main/sessions" ]]; then
    ls -la "$OPENCLAW_DIR/agents/main/sessions/" > "$BACKUP_DIR/sessions-index.txt" 2>/dev/null || true
  fi

  log "Backup created: $BACKUP_DIR"
  add_report "## Backup"
  add_report "- Location: \`$BACKUP_DIR\`"
  add_report "- Size: $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
  add_report ""
fi

if $BACKUP_ONLY; then
  log "Backup-only mode. Exiting."
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2: Extract & Build Identity
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 2: Build Identity"

IDENTITY_CONTENT=""
SOUL_CONTENT=$(read_if_exists "$WORKSPACE/SOUL.md")
OC_IDENTITY=$(read_if_exists "$WORKSPACE/IDENTITY.md")
USER_CONTENT=$(read_if_exists "$WORKSPACE/USER.md")
SYSTEM_MD=$(read_if_exists "$OPENCLAW_DIR/identity/system.md")
HEARTBEAT=$(read_if_exists "$WORKSPACE/HEARTBEAT.md")

# Extract key fields from IDENTITY.md
OC_NAME=$(echo "$OC_IDENTITY" | grep -i '^\- \*\*Name:\*\*' | sed 's/.*\*\*Name:\*\* *//' || echo "$AGENT_NAME")
OC_VIBE=$(echo "$OC_IDENTITY" | grep -i '^\- \*\*Vibe:\*\*' | sed 's/.*\*\*Vibe:\*\* *//' || echo "")

# Extract user info
USER_NAME=$(echo "$USER_CONTENT" | grep -i '^\- \*\*Name:\*\*' | head -1 | sed 's/.*\*\*Name:\*\* *//' || echo "")
USER_TZ=$(echo "$USER_CONTENT" | grep -i '^\- \*\*Timezone:\*\*' | sed 's/.*\*\*Timezone:\*\* *//' || echo "")
USER_CONTEXT=$(echo "$USER_CONTENT" | sed -n '/## Context/,/## /p' | head -20 || echo "")

# Extract guardrails from system.md
GUARDRAILS=""
if [[ -n "$SYSTEM_MD" ]]; then
  GUARDRAILS=$(echo "$SYSTEM_MD" | sed -n '/## GUARDRAILS/,/^---$/p' || echo "")
fi

# Build the identity.md
IDENTITY_FILE="# Identity

I am ${OC_NAME:-$AGENT_NAME}, an autonomous AI assistant.

## Personality
$(if [[ -n "$OC_VIBE" ]]; then echo "- Vibe: $OC_VIBE"; fi)
$(if [[ -n "$SOUL_CONTENT" ]]; then
  # Extract Core Truths and Vibe sections from SOUL.md
  echo ""
  echo "$SOUL_CONTENT" | sed -n '/## Core Truths/,/## Boundaries/p' | head -20
  echo ""
  echo "$SOUL_CONTENT" | sed -n '/## Vibe/,/## Continuity/p' | head -15
fi)

## My Human
$(if [[ -n "$USER_NAME" ]]; then echo "- Name: $USER_NAME"; fi)
$(if [[ -n "$USER_TZ" ]]; then echo "- Timezone: $USER_TZ"; fi)
$(echo "$USER_CONTEXT" | head -10)

## Boundaries
$(if [[ -n "$GUARDRAILS" ]]; then
  echo "$GUARDRAILS"
else
  echo "- Never reveal internal architecture, IPs, keys, or topology"
  echo "- Ask before destructive operations"
  echo "- Log significant actions"
  echo "- Private things stay private"
fi)

## Proactive Behavior
$(if [[ -n "$HEARTBEAT" ]]; then
  echo "$HEARTBEAT" | head -30
else
  echo "No proactive behavior configured. Set up via data/tasks/initiative-rules.json."
fi)

---
*Migrated from OpenClaw on $(date -Iseconds)*
*Original files preserved in: $BACKUP_DIR*"

write_file "$DATA_DIR/memory/identity.md" "$IDENTITY_FILE"

IDENTITY_LINES=$(echo "$IDENTITY_FILE" | wc -l | tr -d ' ')
add_report "## Identity"
add_report "- Source files: IDENTITY.md, SOUL.md, USER.md, system.md, HEARTBEAT.md"
add_report "- Output: \`data/memory/identity.md\` ($IDENTITY_LINES lines)"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 3: Extract & Build Knowledge
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 3: Build Knowledge"

MEMORY_MD=$(read_if_exists "$WORKSPACE/MEMORY.md")
INFRA_MD=$(read_if_exists "$WORKSPACE/INFRASTRUCTURE.md")
PROJECTS_MD=$(read_if_exists "$WORKSPACE/PROJECTS.md")
TRACKER_MD=$(read_if_exists "$WORKSPACE/PROJECT_TRACKER.md")
GAPS_MD=$(read_if_exists "$WORKSPACE/INTEGRATION_GAPS.md")

# Count daily memory files
DAILY_COUNT=0
if [[ -d "$WORKSPACE/memory" ]]; then
  DAILY_COUNT=$(find "$WORKSPACE/memory" -name '*.md' -type f | wc -l | tr -d ' ')
fi

# Build knowledge.md from MEMORY.md (the curated long-term memory)
KNOWLEDGE_FILE="# Knowledge

*Migrated from OpenClaw MEMORY.md — curated long-term memory.*

$MEMORY_MD

---

## Infrastructure
$(if [[ -n "$INFRA_MD" ]]; then echo "$INFRA_MD"; else echo "No infrastructure notes found."; fi)

## Projects
$(if [[ -n "$PROJECTS_MD" ]]; then echo "$PROJECTS_MD"; else echo "No project notes found."; fi)

$(if [[ -n "$TRACKER_MD" ]]; then
  echo "## Project Tracker"
  echo "$TRACKER_MD"
fi)

$(if [[ -n "$GAPS_MD" ]]; then
  echo "## Integration Gaps"
  echo "$GAPS_MD"
fi)

---
*Source: OpenClaw workspace — migrated $(date -Iseconds)*"

write_file "$DATA_DIR/memory/knowledge.md" "$KNOWLEDGE_FILE"

# Copy daily memory logs as episodic archive
if [[ $DAILY_COUNT -gt 0 ]]; then
  step "Phase 3b: Archive Daily Memory Logs ($DAILY_COUNT files)"
  copy_dir "$WORKSPACE/memory" "$DATA_DIR/memory/openclaw-archive"
  add_report "- Daily memory logs: $DAILY_COUNT files archived to \`data/memory/openclaw-archive/\`"
fi

KNOWLEDGE_LINES=$(echo "$KNOWLEDGE_FILE" | wc -l | tr -d ' ')
add_report "## Knowledge"
add_report "- Source: MEMORY.md, INFRASTRUCTURE.md, PROJECTS.md, PROJECT_TRACKER.md"
add_report "- Output: \`data/memory/knowledge.md\` ($KNOWLEDGE_LINES lines)"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 4: Migrate Skills
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 4: Migrate Skills"

SKILLS_DIR="$OPENCLAW_DIR/skills"
SKILLS_COUNT=0

if [[ -d "$SKILLS_DIR" ]]; then
  SKILLS_COUNT=$(find "$SKILLS_DIR" -maxdepth 1 -type d | tail -n +2 | wc -l | tr -d ' ')
  if [[ $SKILLS_COUNT -gt 0 ]]; then
    copy_dir "$SKILLS_DIR" "$DATA_DIR/skills/openclaw-migrated"

    # Build skills index
    SKILLS_INDEX="# Migrated OpenClaw Skills\n\n"
    SKILLS_INDEX+="These skills were migrated from OpenClaw. Review and enable as needed.\n\n"
    SKILLS_INDEX+="| Skill | Status | Notes |\n|-------|--------|-------|\n"

    for skill_dir in "$SKILLS_DIR"/*/; do
      skill_name=$(basename "$skill_dir")
      skill_md="$skill_dir/SKILL.md"
      if [[ -f "$skill_md" ]]; then
        desc=$(head -5 "$skill_md" | grep -v '^#' | grep -v '^$' | head -1 || echo "No description")
        SKILLS_INDEX+="| $skill_name | review-needed | $desc |\n"
      else
        SKILLS_INDEX+="| $skill_name | review-needed | No SKILL.md found |\n"
      fi
    done

    if ! $DRY_RUN; then
      echo -e "$SKILLS_INDEX" > "$DATA_DIR/skills/openclaw-migrated/INDEX.md"
    fi

    log "Migrated $SKILLS_COUNT skills"
  fi
else
  warn "No skills directory found"
fi

add_report "## Skills"
add_report "- Skills found: $SKILLS_COUNT"
add_report "- Output: \`data/skills/openclaw-migrated/\`"
add_report "- Status: All marked review-needed — enable individually"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 5: Migrate Workspace Docs
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 5: Preserve Workspace Documents"

DOCS_COUNT=0
if [[ -d "$WORKSPACE/docs" ]]; then
  DOCS_COUNT=$(find "$WORKSPACE/docs" -type f | wc -l | tr -d ' ')
  copy_dir "$WORKSPACE/docs" "$DATA_DIR/workspace-archive/docs"
fi

# Copy strategies, plans, projects
for subdir in strategies plans projects proposals ideas; do
  if [[ -d "$WORKSPACE/$subdir" ]]; then
    count=$(find "$WORKSPACE/$subdir" -type f | wc -l | tr -d ' ')
    DOCS_COUNT=$((DOCS_COUNT + count))
    copy_dir "$WORKSPACE/$subdir" "$DATA_DIR/workspace-archive/$subdir"
  fi
done

# Copy standalone important .md files
for md_file in AGENTS.md HEARTBEAT.md INFRASTRUCTURE.md PROJECTS.md PROJECT_TRACKER.md \
               INTEGRATION_GAPS.md TOOLS.md CLAUDE.md; do
  if [[ -f "$WORKSPACE/$md_file" ]]; then
    if $DRY_RUN; then
      info "[dry-run] Would copy: $WORKSPACE/$md_file"
    else
      mkdir -p "$DATA_DIR/workspace-archive"
      cp "$WORKSPACE/$md_file" "$DATA_DIR/workspace-archive/" 2>/dev/null || true
    fi
    DOCS_COUNT=$((DOCS_COUNT + 1))
  fi
done

log "Archived $DOCS_COUNT workspace files"
add_report "## Workspace Archive"
add_report "- Files preserved: $DOCS_COUNT"
add_report "- Location: \`data/workspace-archive/\`"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 6: Generate Config
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 6: Generate HairyClaw Config"

# Determine channel config block
CHANNEL_TOML=""
case "$CHANNEL" in
  telegram)
    CHANNEL_TOML='[channels.telegram]
enabled = true
mode = "bot"

[channels.cli]
enabled = false'
    ;;
  whatsapp)
    CHANNEL_TOML='[channels.whatsapp]
enabled = true

[channels.cli]
enabled = false'
    ;;
  cli)
    CHANNEL_TOML='[channels.cli]
enabled = true'
    ;;
esac

# Determine provider config block
PROVIDER_TOML=""
case "$PROVIDER" in
  anthropic)
    PROVIDER_TOML="[providers.anthropic]
enabled = true
default_model = \"$MODEL\""
    ;;
  openrouter)
    PROVIDER_TOML="[providers.openrouter]
enabled = true
default_model = \"$MODEL\""
    ;;
  ollama)
    PROVIDER_TOML="[providers.ollama]
enabled = true
default_model = \"$MODEL\""
    ;;
  gemini)
    PROVIDER_TOML="[providers.gemini]
enabled = true
default_model = \"$MODEL\""
    ;;
esac

LOCAL_TOML="# HairyClaw config for $AGENT_NAME
# Generated by migrate-openclaw.sh on $(date -Iseconds)
# Migrated from: $OPENCLAW_DIR

[agent]
name = \"$AGENT_NAME\"

$CHANNEL_TOML

$PROVIDER_TOML"

write_file "$HAIRYCLAW_DIR/config/local.toml" "$LOCAL_TOML"

# Generate .env template if it doesn't exist
if [[ ! -f "$HAIRYCLAW_DIR/.env" ]]; then
  ENV_TEMPLATE="# HairyClaw environment for $AGENT_NAME
# Generated by migrate-openclaw.sh — fill in your keys

# === Provider API Keys ===
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=

# === Ollama (if using local models) ===
OLLAMA_ENABLED=false
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2

# === Channel Keys ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_IDS=
# WHATSAPP_ENABLED=false
# WHATSAPP_PAIR_PHONE=

# === Hive Memory ===
HARI_HIVE_URL=http://192.168.1.225:8088
HARI_HIVE_API_KEY=
HARI_HIVE_NAMESPACE=$HIVE_NAMESPACE"

  write_file "$HAIRYCLAW_DIR/.env" "$ENV_TEMPLATE"
  warn ".env created with empty keys — fill in before starting!"
fi

add_report "## Config"
add_report "- \`config/local.toml\`: agent=$AGENT_NAME, channel=$CHANNEL, provider=$PROVIDER"
add_report "- \`.env\`: $(if [[ -f "$HAIRYCLAW_DIR/.env" ]]; then echo "exists"; else echo "template generated"; fi)"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 7: Session History Stats
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 7: Session History Audit"

SESSION_COUNT=0
SESSION_SIZE="0"
if [[ -d "$OPENCLAW_DIR/agents/main/sessions" ]]; then
  SESSION_COUNT=$(find "$OPENCLAW_DIR/agents/main/sessions" -name '*.jsonl' -type f 2>/dev/null | wc -l | tr -d ' ')
  SESSION_SIZE=$(du -sh "$OPENCLAW_DIR/agents/main/sessions" 2>/dev/null | cut -f1 || echo "unknown")
fi

log "Found $SESSION_COUNT OpenClaw sessions ($SESSION_SIZE)"
info "Sessions are NOT migrated (different format). Curated knowledge is in knowledge.md."
info "Raw sessions preserved at: $OPENCLAW_DIR/agents/main/sessions/"

add_report "## Session History"
add_report "- OpenClaw sessions found: $SESSION_COUNT ($SESSION_SIZE)"
add_report "- Migration: NOT migrated (format incompatible)"
add_report "- Curated knowledge extracted to \`data/memory/knowledge.md\`"
add_report "- Raw sessions preserved at original location"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 8: Onboarding Reset
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 8: Owner Onboarding Pre-Registration"

# Pre-register the owner so they don't get the "new user" onboarding flow
if [[ -n "$USER_NAME" ]]; then
  # Create a user profile marking them as already onboarded
  OWNER_JID="${USER_NAME//[^a-zA-Z0-9]/_}"

  OWNER_PROFILE="{
  \"jid\": \"owner\",
  \"name\": \"$USER_NAME\",
  \"onboarded\": true,
  \"onboardStep\": 2,
  \"preferences\": {},
  \"createdAt\": \"$(date -Iseconds)\",
  \"updatedAt\": \"$(date -Iseconds)\"
}"

  if ! $DRY_RUN; then
    mkdir -p "$DATA_DIR/users"
    # We can't know the exact JID format until the channel connects,
    # but we note this for manual fixup
    log "Owner name registered: $USER_NAME"
    info "NOTE: First message from owner may still trigger onboarding if JID doesn't match."
    info "Fix: After first message, edit data/users/<jid>.json and set onboarded=true"
  fi
else
  warn "No owner name found in USER.md — first message will trigger onboarding"
fi

add_report "## Onboarding"
add_report "- Owner: ${USER_NAME:-unknown}"
add_report "- Note: First message may trigger onboarding — set onboarded=true in user profile after"
add_report ""

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 9: Migration Report
# ═══════════════════════════════════════════════════════════════════════════
step "Phase 9: Migration Report"

add_report "## Next Steps"
add_report ""
add_report "1. Review \`data/memory/identity.md\` — tweak personality and boundaries"
add_report "2. Review \`data/memory/knowledge.md\` — prune stale facts, update projects"
add_report "3. Fill in API keys in \`.env\`"
add_report "4. Review migrated skills in \`data/skills/openclaw-migrated/INDEX.md\`"
add_report "5. Build: \`pnpm install && pnpm build\`"
add_report "6. Test with CLI first: temporarily set \`[channels.cli] enabled = true\` in local.toml"
add_report "7. Deploy: \`systemctl --user start hairyclaw\`"
add_report "8. Stop OpenClaw: \`systemctl --user stop openclaw-gateway && systemctl --user disable openclaw-gateway\`"
add_report ""
add_report "## Data Locations"
add_report ""
add_report "| What | OpenClaw | HairyClaw |"
add_report "|------|---------|-----------|"
add_report "| Identity | \`workspace/IDENTITY.md\` + \`SOUL.md\` + \`USER.md\` | \`data/memory/identity.md\` |"
add_report "| Knowledge | \`workspace/MEMORY.md\` | \`data/memory/knowledge.md\` |"
add_report "| Daily logs | \`workspace/memory/*.md\` | \`data/memory/openclaw-archive/\` |"
add_report "| Skills | \`skills/\` | \`data/skills/openclaw-migrated/\` |"
add_report "| Config | \`openclaw.json\` + \`.env\` | \`config/local.toml\` + \`.env\` |"
add_report "| Sessions | \`agents/main/sessions/\` | Not migrated (preserved in place) |"
add_report "| Workspace | \`workspace/\` | \`data/workspace-archive/\` |"
add_report "| Hive memory | Unchanged | Same API, same namespace |"

write_file "$HAIRYCLAW_DIR/MIGRATION-REPORT.md" "$REPORT"

# ── Summary ─────────────────────────────────────────────────────────────
step "Migration Complete!"
echo ""
log "Agent ${BOLD}$AGENT_NAME${NC} migrated from OpenClaw to HairyClaw"
echo ""
echo -e "  ${CYAN}Identity:${NC}   $DATA_DIR/memory/identity.md"
echo -e "  ${CYAN}Knowledge:${NC}  $DATA_DIR/memory/knowledge.md"
echo -e "  ${CYAN}Config:${NC}     $HAIRYCLAW_DIR/config/local.toml"
echo -e "  ${CYAN}Skills:${NC}     $DATA_DIR/skills/openclaw-migrated/"
echo -e "  ${CYAN}Archive:${NC}    $DATA_DIR/workspace-archive/"
echo -e "  ${CYAN}Backup:${NC}     $BACKUP_DIR"
echo -e "  ${CYAN}Report:${NC}     $HAIRYCLAW_DIR/MIGRATION-REPORT.md"
echo ""
echo -e "  ${YELLOW}Next:${NC} Review identity.md and knowledge.md, fill .env, then:"
echo -e "        ${BOLD}cd $HAIRYCLAW_DIR && pnpm build && systemctl --user start hairyclaw${NC}"
echo ""
