# Upgrading to HairyClaw v0.2 (DeerFlow-caliber release)

## Quick Self-Update (running agents)

If your agent is already deployed and running, just send it a message:

```
/update
```

That's it. The agent will:
1. `git pull --ff-only` the latest code
2. `pnpm install` if lockfile changed
3. `pnpm build` to recompile
4. Report what changed
5. Restart itself via systemd (2s delay so it can send you the response first)

You can also check the current version first:
```
/version
```

## Manual Update (stopped agents or first-time)

```bash
cd ~/hairyclaw          # or wherever you cloned it
git pull --ff-only
pnpm install
pnpm build
systemctl --user restart hairyclaw
```

## What's New in v0.2

### 8 New Subsystems
| Feature | What it does |
|---------|-------------|
| **Loop detection** | Stops the agent from repeating the same tool calls forever |
| **Context summarization** | Compresses old messages when context gets too long |
| **Parallel sub-agents** | Run up to 3 sub-tasks concurrently with timeout |
| **Sandbox execution** | Virtual path mapping, isolated per-thread workspaces |
| **Structured memory** | Extracts facts from conversations with categories + confidence |
| **Guardrails** | Policy enforcement before tool calls (allowlist/blocklist) |
| **MCP integration** | Connect external MCP tool servers via stdio |
| **File upload pipeline** | Accept files, auto-convert docs to text |

### Orchestrator/Executor Mode
Cloud brain + local hands split. See below.

### New Commands
| Command | Description |
|---------|-------------|
| `/update` or `/upgrade` | Self-update from git, rebuild, restart |
| `/version` or `/v` | Show current git commit and branch |

## Config Changes

### New sections in `config/default.toml`

All new config has sensible defaults — **nothing breaks if you don't touch it.**

```toml
# Agent mode (NEW — default: unified, no change needed)
[agent]
mode = "unified"    # or "orchestrator" for brain/hands split

# Orchestrator mode settings (only used if mode = "orchestrator")
[orchestrator]
model = ""          # e.g. "openrouter/glm-5:cloud"
tools = ["delegate", "memory_recall", "memory_ingest"]

[executor]
model = ""          # e.g. "ollama/qwen3.5:9b"
tools = ["bash", "read", "write", "edit", "web_search", "web_fetch"]
temperature = 0.1
max_iterations = 5

# Plugins (NEW — all enabled by default)
[plugins.loop_detection]
enabled = true
warn_threshold = 3
hard_limit = 5

[plugins.summarization]
enabled = true
trigger_tokens = 80000
keep_messages = 20

# Structured memory (NEW — enabled by default)
[memory.structured]
enabled = true
file_path = "./data/memory/structured.json"
max_facts = 100

# MCP servers (NEW — disabled by default)
[mcp]
enabled = false

# Sandbox (NEW — disabled by default)
[sandbox]
enabled = false
provider = "local"

# Sub-agent concurrency (NEW)
[subagent]
max_concurrent = 3
default_timeout_ms = 120000

# File uploads (NEW — enabled by default)
[uploads]
enabled = true
base_dir = "./data/uploads"
```

## Enabling Orchestrator Mode

For agents using cloud brain + local hands (e.g. Moni):

### Option 1: config/local.toml
```toml
[agent]
mode = "orchestrator"

[orchestrator]
model = "openrouter/glm-5:cloud"

[executor]
model = "ollama/qwen3.5:9b"
```

### Option 2: Environment variables
```bash
# In your .env file
AGENT_MODE=orchestrator
ORCHESTRATOR_MODEL=openrouter/glm-5:cloud
EXECUTOR_MODEL=ollama/qwen3.5:9b
```

### Option 3: Tell the agent to update its own config
```
/update
```
Then edit config/local.toml on the deployment machine.

## Breaking Changes

**None.** All new features are opt-in or have backwards-compatible defaults:
- `mode = "unified"` is the default — identical to previous behavior
- New plugins are enabled but only activate when relevant (loop detection only fires if tools repeat, summarization only fires at 80k tokens)
- MCP and sandbox are disabled by default
- The new `packages/sandbox` workspace package is auto-linked by pnpm

## New Package: @hairyclaw/sandbox

A new workspace package was added. After pulling, `pnpm install` will link it automatically. No manual steps needed.

## File Structure Changes

New files added (nothing moved or deleted):
```
packages/sandbox/              — NEW package
packages/core/src/plugins/     — 4 new plugins
packages/core/src/subagent-executor.ts
packages/memory/src/structured.ts
packages/memory/src/fact-extractor.ts
packages/memory/src/uploads.ts
packages/tools/src/mcp/        — MCP client
packages/tools/src/builtin/file-upload.ts
deploy/update.sh               — self-update script
docs/UPGRADE-v0.2.md           — this file
```

## Rollback

If something goes wrong:
```bash
cd ~/hairyclaw
git log --oneline -10           # find the commit to roll back to
git checkout <commit-hash>
pnpm build
systemctl --user restart hairyclaw
```
