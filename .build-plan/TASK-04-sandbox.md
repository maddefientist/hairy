# TASK-04: Sandboxed Execution

## Goal
Add a sandbox abstraction layer that isolates tool execution with virtual path mapping. Start with a LocalSandboxProvider (path-restricted local execution) and a DockerSandboxProvider stub.

## Location
- New directory: `packages/sandbox/` (new package)
- New files:
  - `packages/sandbox/package.json`
  - `packages/sandbox/tsconfig.json`
  - `packages/sandbox/tsconfig.build.json`
  - `packages/sandbox/src/index.ts`
  - `packages/sandbox/src/types.ts`
  - `packages/sandbox/src/path-mapper.ts`
  - `packages/sandbox/src/local-provider.ts`
  - `packages/sandbox/src/docker-provider.ts`
  - `packages/sandbox/src/tools.ts` (sandbox-aware tool wrappers)
  - `packages/sandbox/test/path-mapper.test.ts`
  - `packages/sandbox/test/local-provider.test.ts`
  - `packages/sandbox/test/tools.test.ts`
- Update: `pnpm-workspace.yaml` (already has "packages/*" glob, so auto-included)
- Update: `config/default.toml` (add sandbox section)

## Read First
- `packages/tools/src/builtin/bash.ts` — current bash tool
- `packages/tools/src/builtin/read.ts` — current read tool
- `packages/tools/src/builtin/write.ts` — current write tool
- `packages/tools/src/types.ts` — Tool, ToolContext, ToolResult interfaces
- `config/tools.toml` — existing tool permissions

## Package Setup

### package.json
```json
{
  "name": "@hairyclaw/sandbox",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@hairyclaw/observability": "workspace:*",
    "zod": "^3.24.3"
  },
  "devDependencies": {
    "vitest": "^3.1.4"
  }
}
```

### tsconfig.json (for type checking in IDE/CI)
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "paths": {
      "@hairyclaw/observability": ["../observability/src"]
    }
  },
  "include": ["src"]
}
```

### tsconfig.build.json (for actual builds — no path aliases)
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

## Design

### types.ts
```typescript
export interface SandboxProvider {
  readonly name: string;
  acquire(threadId: string): Promise<Sandbox>;
  get(sandboxId: string): Sandbox | undefined;
  release(sandboxId: string): Promise<void>;
}

export interface Sandbox {
  readonly id: string;
  readonly threadId: string;
  executeCommand(command: string, timeoutMs?: number): Promise<SandboxExecResult>;
  readFile(virtualPath: string): Promise<string>;
  writeFile(virtualPath: string, content: string, append?: boolean): Promise<void>;
  listDir(virtualPath: string, maxDepth?: number): Promise<string[]>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PathMapping {
  virtual: string;   // e.g., "/workspace"
  physical: string;  // e.g., "/Users/admin/agenticharnes/hairy/data/threads/abc123/workspace"
}
```

### path-mapper.ts
Maps virtual paths (what the agent sees) to physical paths (real filesystem).

```typescript
export class PathMapper {
  constructor(private readonly mappings: PathMapping[]);

  // Convert virtual → physical. Throws if path escapes sandbox.
  toPhysical(virtualPath: string): string;

  // Convert physical → virtual (for display)
  toVirtual(physicalPath: string): string | null;

  // Check if a physical path is within any allowed mapping
  isAllowed(physicalPath: string): boolean;
}
```

Key rules:
- Resolve symlinks and `..` before checking (use `path.resolve`)
- Virtual paths must start with one of the mapping prefixes
- Physical paths must stay within the physical root of their mapping
- Throw on path traversal attempts

### local-provider.ts
```typescript
export interface LocalSandboxOptions {
  baseDir: string;       // e.g., "data/threads"
  allowedCommands?: string[];
  blockedCommands?: string[];
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
}

export class LocalSandboxProvider implements SandboxProvider {
  // Creates per-thread directories on acquire:
  //   {baseDir}/{threadId}/workspace/
  //   {baseDir}/{threadId}/uploads/
  //   {baseDir}/{threadId}/outputs/
  // Sets up PathMapper with:
  //   /workspace → {baseDir}/{threadId}/workspace
  //   /uploads   → {baseDir}/{threadId}/uploads
  //   /outputs   → {baseDir}/{threadId}/outputs
}
```

### docker-provider.ts (STUB only)
```typescript
export class DockerSandboxProvider implements SandboxProvider {
  // Stub — throws "Docker sandbox not yet implemented" on acquire
  // This is a placeholder for future Docker integration
}
```

### tools.ts — Sandbox-aware tool factories
Create wrapper factories that take a Sandbox and return Tool instances:

```typescript
export const createSandboxBashTool = (getSandbox: () => Sandbox | undefined): Tool
export const createSandboxReadTool = (getSandbox: () => Sandbox | undefined): Tool
export const createSandboxWriteTool = (getSandbox: () => Sandbox | undefined): Tool
```

These tools:
- Use the sandbox's executeCommand/readFile/writeFile when sandbox is available
- Fall back to direct execution when sandbox is undefined (backward compat)
- Enforce virtual path restrictions

## Config Addition (config/default.toml)
```toml
[sandbox]
enabled = false
provider = "local"  # "local" | "docker"
base_dir = "./data/threads"
```

## Tests

### path-mapper.test.ts
1. Virtual to physical mapping works
2. Physical to virtual reverse mapping works
3. Path traversal attempt (`/workspace/../../etc/passwd`) throws
4. Unknown virtual path throws
5. Multiple mappings handled correctly
6. Paths with trailing slashes normalized

### local-provider.test.ts
1. Acquire creates thread directories
2. Execute command returns stdout/stderr
3. Blocked commands rejected
4. Read/write files work through virtual paths
5. Path traversal in file operations blocked
6. Release cleans up sandbox state (but NOT files — keep for debugging)
7. Multiple sandboxes can coexist

### tools.test.ts
1. Sandbox bash tool routes through sandbox
2. Sandbox read tool uses virtual paths
3. Sandbox write tool uses virtual paths
4. Fallback to direct execution when no sandbox

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm install && pnpm check && pnpm build && pnpm test
```

IMPORTANT: After creating the package, run `pnpm install` first to link the new workspace package.
