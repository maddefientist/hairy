# TASK-03: Parallel Sub-agent Executor

## Goal
Replace the current synchronous sub-agent tool with a parallel executor that can run multiple sub-agents concurrently with timeout enforcement, status tracking, and concurrency limits.

## Location
- New file: `packages/core/src/subagent-executor.ts`
- Update file: `packages/tools/src/builtin/subagent.ts` (rewrite to use new executor)
- Update: `packages/core/src/index.ts` (add export)
- Update: `packages/tools/src/index.ts` (exports already exist)
- New test: `packages/core/test/subagent-executor.test.ts`
- Update test: `packages/tools/test/subagent.test.ts` (update for new behavior)
- Update: `config/default.toml` (add config section)

## Read First
- `packages/tools/src/builtin/subagent.ts` — current SubAgentTool implementation
- `packages/core/src/agent-loop.ts` — AgentLoopProvider, runAgentLoop, AgentLoopResult
- `packages/core/src/plugin.ts` — PluginRunner, PluginContext
- `packages/tools/src/types.ts` — Tool, ToolContext, ToolResult
- `packages/core/src/types.ts` — ToolCallRecord, RunResult

## Design

### SubagentExecutor class
Manages a pool of concurrent sub-agent executions with:
- Configurable max concurrency (default: 3)
- Per-task timeout (default: 120s)
- Background execution with polling
- Status tracking per task
- Trace ID propagation from parent

```typescript
// packages/core/src/subagent-executor.ts

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "timed_out";

export interface SubagentResult {
  taskId: string;
  parentTraceId: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  toolCallCount: number;
}

export interface SubagentConfig {
  maxConcurrent?: number;    // default: 3
  defaultTimeoutMs?: number; // default: 120000
  maxIterations?: number;    // default: 10
}

export class SubagentExecutor {
  private readonly tasks = new Map<string, SubagentResult>();
  private readonly running = new Map<string, Promise<SubagentResult>>();
  private readonly config: Required<SubagentConfig>;

  constructor(config?: SubagentConfig);

  // Submit a task for background execution. Returns taskId immediately.
  async submit(opts: {
    taskId?: string;
    task: string;
    systemPrompt: string;
    provider: AgentLoopProvider;
    executor: ToolExecutor;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    model: string;
    parentTraceId: string;
    logger: HairyClawLogger;
    timeoutMs?: number;
  }): Promise<string>;

  // Poll a task's status
  getResult(taskId: string): SubagentResult | undefined;

  // List all tasks
  listTasks(): SubagentResult[];

  // Wait for a specific task to complete (with timeout)
  async waitFor(taskId: string, timeoutMs?: number): Promise<SubagentResult>;

  // Wait for all currently running tasks
  async waitForAll(timeoutMs?: number): Promise<SubagentResult[]>;

  // Clean up completed tasks
  cleanup(taskId: string): void;

  // Number of currently running tasks
  get activeCount(): number;
}
```

### Concurrency Control
Use a simple semaphore pattern:
```typescript
class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) { this.current++; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) { this.current++; next(); }
  }
}
```

### Timeout Enforcement
Wrap each sub-agent's runAgentLoop call with Promise.race against a timeout promise. On timeout, set status to "timed_out".

### Updated SubAgent Tool
The existing `createSubAgentTool` in `packages/tools/src/builtin/subagent.ts` should be updated to:
1. Accept an optional `SubagentExecutor` instance
2. If executor provided: submit task, then poll/wait for result
3. If no executor: fall back to current synchronous behavior (backward compat)

Add a new factory:
```typescript
export interface ParallelSubAgentToolOptions extends SubAgentToolOptions {
  executor?: SubagentExecutor;
}
```

The tool's execute function when using the executor:
1. Submit task to executor
2. Await result with timeout
3. Return result text or error

### Config Addition (config/default.toml)
```toml
[subagent]
max_concurrent = 3
default_timeout_ms = 120000
max_iterations = 10
```

## Tests

### subagent-executor.test.ts
1. Submit single task → completes successfully
2. Submit multiple tasks → run concurrently (verify with timing)
3. Concurrency limit respected (4 tasks with max 2 → some queue)
4. Task timeout → status becomes "timed_out"
5. Task error → status becomes "failed" with error message
6. getResult returns undefined for unknown taskId
7. waitFor resolves when task completes
8. waitForAll resolves when all tasks complete
9. cleanup removes completed tasks
10. activeCount tracks running tasks correctly

### subagent.test.ts updates
- Existing tests should still pass (backward compat)
- Add test: parallel sub-agent tool with executor

## Validation
```bash
cd /Users/admin/agenticharnes/hairy && pnpm check && pnpm build && pnpm test
```
