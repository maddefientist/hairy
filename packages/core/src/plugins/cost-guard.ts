import type { HairyPlugin } from "../plugin.js";

export interface CostGuardOptions {
  dailyBudgetUsd: number;
  alertThresholdPct: number;
  onAlert?: (currentSpend: number, budget: number) => void;
  onBlock?: (currentSpend: number, budget: number) => void;
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

export const createCostGuardPlugin = (opts: CostGuardOptions): HairyPlugin => {
  let spendDay = utcDay(new Date());
  let dailySpend = 0;
  let alerted = false;

  const resetIfNeeded = (): void => {
    const today = utcDay(new Date());
    if (today === spendDay) {
      return;
    }

    spendDay = today;
    dailySpend = 0;
    alerted = false;
  };

  const maybeAlert = (): void => {
    const budget = opts.dailyBudgetUsd;
    if (budget <= 0 || alerted) {
      return;
    }

    const threshold = (budget * opts.alertThresholdPct) / 100;
    if (dailySpend >= threshold) {
      alerted = true;
      opts.onAlert?.(dailySpend, budget);
    }
  };

  return {
    name: "cost_guard",
    beforeModel: async (messages, streamOpts) => {
      resetIfNeeded();

      if (opts.dailyBudgetUsd <= 0 || dailySpend >= opts.dailyBudgetUsd) {
        opts.onBlock?.(dailySpend, opts.dailyBudgetUsd);
        return null;
      }

      maybeAlert();
      return { messages, opts: streamOpts };
    },
    onRunEnd: async (_ctx, result) => {
      resetIfNeeded();
      const cost = result?.usage.cost.total ?? 0;
      if (Number.isFinite(cost) && cost > 0) {
        dailySpend += cost;
      }
      maybeAlert();
      return;
    },
  };
};
