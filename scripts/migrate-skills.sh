#!/usr/bin/env bash
# Migrate OpenClaw-format skills (SKILL.md with YAML frontmatter) to HairyClaw format (skill.json)
# Usage: ./scripts/migrate-skills.sh [skills_dir]

set -euo pipefail

SKILLS_DIR="${1:-./data/skills}"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "Skills directory not found: $SKILLS_DIR"
  exit 1
fi

count=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name=$(basename "$skill_dir")
  skill_json="$skill_dir/skill.json"
  skill_md="$skill_dir/SKILL.md"

  # Skip if skill.json already exists
  if [ -f "$skill_json" ]; then
    echo "  SKIP $skill_name (skill.json exists)"
    continue
  fi

  if [ ! -f "$skill_md" ]; then
    echo "  SKIP $skill_name (no SKILL.md)"
    continue
  fi

  # Extract name and description from YAML frontmatter
  name=$(grep '^name:' "$skill_md" 2>/dev/null | head -1 | sed 's/^name:[[:space:]]*//')
  desc=$(grep '^description:' "$skill_md" 2>/dev/null | head -1 | sed 's/^description:[[:space:]]*//')

  # Use directory name as fallback
  name="${name:-$skill_name}"
  desc="${desc:-Migrated skill from OpenClaw}"

  # Extract the body after frontmatter as the prompt fragment
  prompt_fragment=$(awk '/^---$/{n++; next} n>=2' "$skill_md" | head -30)

  # If no frontmatter delimiters, use the whole file
  if [ -z "$prompt_fragment" ]; then
    prompt_fragment=$(cat "$skill_md" | head -30)
  fi

  # Escape for JSON
  prompt_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "$prompt_fragment")

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  cat > "$skill_json" << JSONEOF
{
  "id": "$skill_name",
  "name": "$name",
  "description": "$desc",
  "promptFragment": $prompt_json,
  "status": "candidate",
  "createdAt": "$now",
  "updatedAt": "$now"
}
JSONEOF

  echo "  OK $skill_name → candidate"
  count=$((count + 1))
done

echo ""
echo "Migrated $count skills to HairyClaw format."
echo "Review them, then promote with: promote <skill-id>"
