# Sidecars

Sidecars are standalone binaries that speak JSON-RPC 2.0 over stdio.

## Lifecycle
1. Hairy reads each `manifest.json`
2. Builds sidecar binary if missing (`build_cmd`)
3. Starts process and registers declared tools
4. Runs health checks periodically
5. Sends `shutdown` on graceful exit

## Included examples
- `example-rust` — health, echo, hash_file
- `example-go` — health, echo, count_words
