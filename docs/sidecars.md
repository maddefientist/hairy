# Sidecars

Sidecars are external binaries (Rust/Go) connected over JSON-RPC 2.0 via stdio.

## Required files
- `manifest.json`
- compiled binary
- source code (Rust or Go)

## Manifest fields
- `name`, `version`, `binary`
- `build_cmd`
- `tools[]` (name, description, JSON Schema)
- optional `health_check`
- optional `resource_limits`

## Runtime
`SidecarManager`:
1. Reads manifests
2. Builds missing binaries
3. Starts processes
4. Registers tool shims in `ToolRegistry`
5. Performs health checks
