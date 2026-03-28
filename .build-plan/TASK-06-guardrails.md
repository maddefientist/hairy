# TASK-06: Guardrail Plugin

## Goal
Create a guardrail plugin that evaluates tool calls against configurable policies before execution. Denied calls return error messages so the agent can adapt.

## Location
- New file: `packages/core/src/plugins/guardrails.ts`
- Update: `packages/core/src/index.ts` (add export)
- New test: `packages/core/test/guardrails.test.ts`
- Update: `config/tools.toml` (add guardrail rules section)

## Read First
- `packages/core/src/plugin.ts` — HairyClawPlugin interface
- `packages/core/src/plugins/content-safety.ts` — related safety plugin
- `packages/tools/src/types.ts` — Tool, ToolPermissions
- `config/tools.toml` — existing tool permissions

## Design

### GuardrailProvider Interface
```typescript
export interface GuardrailRequest {
  toolName: string;
  toolArgs: unknown;
  senderId?: string;
  channelType?: string;
  traceId: string;
}

export interface GuardrailDecision {
  allow: boolean;
  reason?: string;
  code?: string;  // e.g., "policy.blocked_command", "policy.blocked_path"
}

export interface GuardrailProvider {
  evaluate(request: GuardrailRequest): Promise<GuardrailDecision>;
}
```

### Built-in Providers

#### AllowlistProvider
```typescript
export interface AllowlistConfig {
  // Tool-level rules
  allowedTools?: string[];     // if set, only these tools can execute
  blockedTools?: string[];     // these tools are always blocked

  // Bash-specific rules
  bash?: {
    allowedCommands?: string[];
    blockedCommands?: string[];
    blockedPatterns?: string[]; // regex patterns
  };

  // File operation rules
  fileOps?: {
    allowedPaths?: string[];
    blockedPaths?: string[];
  };

  // Per-sender overrides
  senderOverrides?: Record<string, Partial<AllowlistConfig>>;
}

export class AllowlistProvider implements GuardrailProvider {
  constructor(config: AllowlistConfig);
  async evaluate(request: GuardrailRequest): Promise<GuardrailDecision>;
}
```

### Guardrail Plugin
```typescript
export interface GuardrailPluginOptions {
  provider: GuardrailProvider;
  failClosed?: boolean;  // default: true — block on provider error
}

export const createGuardrailPlugin = (opts: GuardrailPluginOptions): HairyClawPlugin
```

### Plugin Hooks
- `beforeTool(toolName, args, ctx)`:
  - Build GuardrailRequest from params + ctx
  - Call provider.evaluate()
  - If not allowed: log warning, return null (blocks tool)
  - If allowed: return { args }
  - If provider throws:
    - failClosed=true → return null (block)
    - failClosed=false → return { args } (allow through with warning log)

### Bash Tool Argument Inspection
For the bash tool, inspect args to extract the command:
```typescript
const extractBashCommand = (args: unknown): string | null => {
  if (typeof args === "object" && args !== null && "command" in args) {
    return String((args as { command: string }).command);
  }
  return null;
};
```

Then check the command against bash-specific rules.

### File Op Argument Inspection
For read/write/edit tools, inspect args for path:
```typescript
const extractFilePath = (args: unknown): string | null => {
  if (typeof args === "object" && args !== null && "path" in args) {
    return String((args as { path: string }).path);
  }
  return null;
};
```

## Config Addition (config/tools.toml)
```toml
[guardrails]
enabled = true
fail_closed = true

[guardrails.bash]
blocked_commands = ["sudo", "rm -rf", "mkfs", "dd", "chmod 777"]
blocked_patterns = ["curl.*\\|.*sh", "wget.*\\|.*bash"]

[guardrails.file_ops]
blocked_paths = ["/etc", "/usr", "/var", "~/.ssh", "~/.aws", "~/.config"]
```

## Tests (Vitest)

1. Allowed tool call → passes through
2. Blocked tool name → returns null with log
3. Bash blocked command → returns null
4. Bash blocked pattern (regex) → returns null
5. File op blocked path → returns null
6. Provider error + failClosed=true → blocks
7. Provider error + failClosed=false → allows through
8. Sender override respected
9. AllowlistProvider with empty config → allows everything
10. Custom GuardrailProvider works (mock implementation)

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
