# Hairy — Development Rules

## First Message
Read PROJECT.md and ARCHITECTURE.md before starting any work.
If no concrete task given, ask which package to work on.

## Code Quality
- No `any` types — use `unknown` + narrowing
- No inline imports — top-level only
- No `console.log` — use pino logger from packages/observability
- All inputs validated with Zod
- ESM only, no CommonJS
- Strict TypeScript

## Commands
- `pnpm check` — biome lint/format + typecheck all packages (must pass before commit)
- `pnpm build` — build all packages
- `pnpm test` — run all tests
- `pnpm dev` — start hairy-agent in dev mode
- Run specific tests: `cd packages/core && pnpm exec vitest --run test/specific.test.ts`

## Build Order
Packages have dependencies — build in this order:
1. observability (no deps)
2. core (depends on observability)
3. providers (depends on observability)
4. tools (depends on observability, core)
5. memory (depends on observability, core)
6. channels (depends on observability, core)
7. growth (depends on observability, core, memory)
8. hairy-agent app (depends on all packages)

## Git
- Never `git add -A` — only stage files you changed
- Commit messages: `type(scope): description` (e.g., `feat(core): add task queue`)
- No hardcoded secrets — all from env vars

## Testing
- Each package must have type checking pass
- Core logic needs unit tests (orchestrator, queue, scheduler, registry)
- Sidecar examples must compile
- Run tests after non-trivial changes

## Style
- Concise, direct communication
- No emoji in code/commits
- Functional patterns where stateless, classes for stateful objects
- Error messages must be actionable
