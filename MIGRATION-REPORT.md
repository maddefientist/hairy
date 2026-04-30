# Migration Report: OpenClaw → HairyClaw
Date: 2026-03-17T19:20:15+00:00
Agent: Hari

## Backup
- Location: `/home/aghari/.openclaw/backups/pre-migration-20260317-192015`
- Size: 732K

## Identity
- Source files: IDENTITY.md, SOUL.md, USER.md, system.md, HEARTBEAT.md
- Output: `data/memory/identity.md` (145 lines)

## Knowledge
- Source: MEMORY.md, INFRASTRUCTURE.md, PROJECTS.md, PROJECT_TRACKER.md
- Output: `data/memory/knowledge.md` (409 lines)

## Skills
- Skills found: 17
- Output: `data/skills/openclaw-migrated/`
- Status: All marked review-needed — enable individually

## Workspace Archive
- Files preserved: 2882
- Location: `data/workspace-archive/`

## Config
- `config/local.toml`: agent=Hari, channel=telegram, provider=anthropic
- `.env`: exists

## Session History
- OpenClaw sessions found: 46 (64M)
- Migration: NOT migrated (format incompatible)
- Curated knowledge extracted to `data/memory/knowledge.md`
- Raw sessions preserved at original location

## Onboarding
- Owner: MadDefientist.sol (Telegram: @maddefientist)
- Note: First message may trigger onboarding — set onboarded=true in user profile after

## Next Steps

1. Review `data/memory/identity.md` — tweak personality and boundaries
2. Review `data/memory/knowledge.md` — prune stale facts, update projects
3. Fill in API keys in `.env`
4. Review migrated skills in `data/skills/openclaw-migrated/INDEX.md`
5. Build: `pnpm install && pnpm build`
6. Test with CLI first: temporarily set `[channels.cli] enabled = true` in local.toml
7. Deploy: `systemctl --user start hairyclaw`
8. Stop OpenClaw: `systemctl --user stop openclaw-gateway && systemctl --user disable openclaw-gateway`

## Data Locations

| What | OpenClaw | HairyClaw |
|------|---------|-----------|
| Identity | `workspace/IDENTITY.md` + `SOUL.md` + `USER.md` | `data/memory/identity.md` |
| Knowledge | `workspace/MEMORY.md` | `data/memory/knowledge.md` |
| Daily logs | `workspace/memory/*.md` | `data/memory/openclaw-archive/` |
| Skills | `skills/` | `data/skills/openclaw-migrated/` |
| Config | `openclaw.json` + `.env` | `config/local.toml` + `.env` |
| Sessions | `agents/main/sessions/` | Not migrated (preserved in place) |
| Workspace | `workspace/` | `data/workspace-archive/` |
| Hive memory | Unchanged | Same API, same namespace |

