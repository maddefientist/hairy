export interface CostEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface CostReport {
  periodStart: number;
  periodEnd: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<
    string,
    { costUsd: number; calls: number; inputTokens: number; outputTokens: number }
  >;
  byModel: Record<
    string,
    { costUsd: number; calls: number; inputTokens: number; outputTokens: number }
  >;
}

export class CostTracker {
  private entries: CostEntry[] = [];
  private dailyResetDay = "";
  private dailyCost = 0;

  constructor(
    private readonly dailyBudgetUsd: number,
    private readonly alertThresholdPct: number = 80,
    private readonly onBudgetAlert?: (spend: number, budget: number) => void,
    private readonly onBudgetExceeded?: (spend: number, budget: number) => void,
  ) {}

  /** Record a cost entry from a model call */
  record(entry: Omit<CostEntry, "timestamp">): void {
    const full: CostEntry = { ...entry, timestamp: Date.now() };
    this.entries.push(full);
    this.dailyCost += entry.costUsd;

    this.checkDailyBudget();
  }

  /** Check if within daily budget */
  isWithinBudget(): boolean {
    return this.dailyCost < this.dailyBudgetUsd;
  }

  /** Get current daily spend */
  get dailySpend(): number {
    return this.dailyCost;
  }

  /** Generate a cost report for a time period */
  report(startMs: number, endMs: number): CostReport {
    const filtered = this.entries.filter((e) => e.timestamp >= startMs && e.timestamp <= endMs);

    const byProvider: CostReport["byProvider"] = {};
    const byModel: CostReport["byModel"] = {};
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const entry of filtered) {
      totalCostUsd += entry.costUsd;
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;

      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = {
          costUsd: 0,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      byProvider[entry.provider].costUsd += entry.costUsd;
      byProvider[entry.provider].calls++;
      byProvider[entry.provider].inputTokens += entry.inputTokens;
      byProvider[entry.provider].outputTokens += entry.outputTokens;

      if (!byModel[entry.model]) {
        byModel[entry.model] = {
          costUsd: 0,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      byModel[entry.model].costUsd += entry.costUsd;
      byModel[entry.model].calls++;
      byModel[entry.model].inputTokens += entry.inputTokens;
      byModel[entry.model].outputTokens += entry.outputTokens;
    }

    return {
      periodStart: startMs,
      periodEnd: endMs,
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      byProvider,
      byModel,
    };
  }

  /** Get all entries for export */
  getEntries(): CostEntry[] {
    return [...this.entries];
  }

  /** Clear all entries and reset daily spend */
  reset(): void {
    this.entries = [];
    this.dailyCost = 0;
  }

  private checkDailyBudget(): void {
    if (this.dailyBudgetUsd <= 0) return;

    const threshold = (this.dailyBudgetUsd * this.alertThresholdPct) / 100;
    if (this.dailyCost >= threshold && this.dailyCost < this.dailyBudgetUsd) {
      this.onBudgetAlert?.(this.dailyCost, this.dailyBudgetUsd);
    }
    if (this.dailyCost >= this.dailyBudgetUsd) {
      this.onBudgetExceeded?.(this.dailyCost, this.dailyBudgetUsd);
    }
  }
}
