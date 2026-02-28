# Security Model

## Core rules
- No hardcoded secrets
- Validate all tool inputs with Zod
- Restrict file writes to project paths
- Restrict shell command usage via allow/block lists
- Log all tool execution with trace IDs

## Sidecar security
- Sidecars run as subprocesses
- Health checks detect crash loops
- Timeouts enforced at tool call boundary
- Resource limits declared in manifest and enforced by manager policies

## Operational guidance
- Keep webhook secrets in env vars
- Rotate provider API keys
- Review tool permission config before enabling autonomous behavior
