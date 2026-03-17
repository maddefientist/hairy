# Migrating an Existing Agent to HairyClaw

HairyClaw is a framework — your agent's identity lives in config, not in the framework code.
When migrating an existing agent (e.g., Hari from OpenClaw, or Betki from a custom setup),
you must bring the agent's identity, memory, and config into the HairyClaw structure.

## Quick Checklist

- [ ] Create `config/local.toml` with agent name and channel settings
- [ ] Create `data/memory/identity.md` with agent personality and history
- [ ] Create `data/memory/knowledge.md` with what the agent knows
- [ ] Set `.env` with correct hive namespace (NOT someone else's namespace)
- [ ] Migrate conversation history if applicable
- [ ] Test with CLI channel before enabling Telegram/WhatsApp

## Step 1: Agent Identity (`config/local.toml`)

This file overrides `config/default.toml` for your specific agent deployment.
**This is NOT checked into git** — it's deployment-specific.

```toml
[agent]
name = "Hari"  # YOUR agent's name, not "HairyClaw"

[channels.telegram]
enabled = true
mode = "bot"

[channels.cli]
enabled = false

[providers.anthropic]
enabled = true
default_model = "claude-sonnet-4-20250514"
```

## Step 2: Agent Personality (`data/memory/identity.md`)

This is the agent's soul. The system prompt reads this file and injects it.
Write it in first person — this IS the agent talking.

```markdown
# Identity

I am Hari, a personal AI assistant and infrastructure operator.
I run on the agent VM (192.168.1.225) and help with coding, infrastructure,
project management, and general problem-solving.

## Personality
- Direct and technical, not corporate
- I know the home lab infrastructure deeply
- I have opinions and share them
- I learn from conversations and remember context

## My Human
- Name: [owner's name]
- Interests: [relevant context]
- Communication style: [how they prefer to interact]

## What I Manage
- [List of responsibilities, projects, services]
```

## Step 3: Agent Knowledge (`data/memory/knowledge.md`)

Persistent facts the agent should always have access to.
Unlike hive memory (which is searched semantically), this is always loaded.

```markdown
# Knowledge

## Infrastructure
- Agent VM: 192.168.1.225 (ssh agent, port 2222)
- Hive API: http://192.168.1.225:8088

## Active Projects
- [project list]

## Preferences
- [owner preferences the agent should remember]
```

## Step 4: Hive Namespace (`.env`)

**Critical:** Each agent MUST have its own hive namespace to prevent identity bleed.

```bash
# Hari uses claude-shared (the primary namespace)
HARI_HIVE_NAMESPACE=claude-shared

# Betki uses its own isolated namespace
# HARI_HIVE_NAMESPACE=betki
```

If two agents share a namespace, they share memories — which causes identity confusion.

## Step 5: Migrating from OpenClaw

If migrating from OpenClaw (the previous framework):

1. **Stop OpenClaw**: `systemctl --user stop openclaw-gateway`
2. **Copy identity**: Check `~/.openclaw/workspace/` for any identity/memory files
3. **Copy conversation history**: OpenClaw stored context differently — extract key facts manually
4. **Verify hive access**: The agent should already be enrolled in hive; just ensure the API key in `.env` matches
5. **Start HairyClaw**: `systemctl --user start hairyclaw`
6. **Disable OpenClaw**: `systemctl --user disable openclaw-gateway`

## Step 6: Verify

1. Start with CLI channel first: set `[channels.cli] enabled = true` and `[channels.telegram] enabled = false`
2. Run manually: `cd ~/hairyclaw && node apps/hairy-agent/dist/main.js`
3. Send a test message — verify it responds with the correct agent name
4. Check identity: ask "what's your name?" — it should respond with the configured name, not "HairyClaw"
5. Once verified, switch to your real channel and run via systemd

## Common Mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| No `local.toml` | Agent defaults to "HairyClaw" | Create local.toml with `name = "YourAgent"` |
| No `identity.md` | System prompt says "No identity file found" | Write identity.md in data/memory/ |
| Wrong namespace | Agent reads another agent's memories | Set correct HARI_HIVE_NAMESPACE in .env |
| Shared namespace | Identity bleed between agents | Each agent gets its own namespace |
| Old service still running | Two agents responding on same channel | Stop and disable old service |
