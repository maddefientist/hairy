/**
 * Iteration budget for an agent loop.
 * Each agent (parent or subagent) gets its own IterationBudget.
 * Prevents runaway agents from consuming unbounded iterations.
 * Refund mechanism for programmatic tool calls (execute_code).
 */
export class IterationBudget {
  private _used = 0;

  constructor(public readonly maxTotal: number) {}

  /** Try to consume one iteration. Returns true if allowed. */
  consume(): boolean {
    if (this._used >= this.maxTotal) return false;
    this._used++;
    return true;
  }

  /** Give back one iteration (e.g. for execute_code turns). */
  refund(): void {
    if (this._used > 0) this._used--;
  }

  /** Current iteration count. */
  get used(): number {
    return this._used;
  }

  /** Remaining iterations. */
  get remaining(): number {
    return Math.max(0, this.maxTotal - this._used);
  }

  /** Has the budget been exhausted? */
  get exhausted(): boolean {
    return this._used >= this.maxTotal;
  }

  /** Reset for reuse. */
  reset(): void {
    this._used = 0;
  }
}

/** Factory: create a subagent budget (default 25, less than parent's 90) */
export const createSubagentBudget = (maxIterations = 25): IterationBudget =>
  new IterationBudget(maxIterations);
