#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR/sidecars/example-rust"
cargo build --release

cd "$ROOT_DIR/sidecars/example-go"
go build -o example-go-sidecar ./main.go

echo "Sidecars built successfully"
