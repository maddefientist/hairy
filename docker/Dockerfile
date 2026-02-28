FROM node:22-slim AS node-build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config
RUN pnpm install --frozen-lockfile=false
RUN pnpm build

FROM rust:1.86-bookworm AS rust-build
WORKDIR /app/sidecars/example-rust
COPY sidecars/example-rust ./
RUN cargo build --release

FROM golang:1.23-bookworm AS go-build
WORKDIR /app/sidecars/example-go
COPY sidecars/example-go ./
RUN go build -o example-go-sidecar ./main.go

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=node-build /app /app
COPY --from=rust-build /app/sidecars/example-rust/target/release/hairy-example-sidecar /app/sidecars/example-rust/target/release/hairy-example-sidecar
COPY --from=go-build /app/sidecars/example-go/example-go-sidecar /app/sidecars/example-go/example-go-sidecar
EXPOSE 9090
ENTRYPOINT ["node", "apps/hairy-agent/dist/main.js"]
