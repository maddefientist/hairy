import type { MetricLabels } from "./types.js";

interface MetricEntry {
  name: string;
  value: number;
  labels: MetricLabels;
}

const keyFor = (name: string, labels: MetricLabels): string => {
  const labelString = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  return `${name}|${labelString}`;
};

export class Metrics {
  private readonly counters = new Map<string, MetricEntry>();
  private readonly gauges = new Map<string, MetricEntry>();

  increment(name: string, value = 1, labels: MetricLabels = {}): void {
    const key = keyFor(name, labels);
    const current = this.counters.get(key);
    if (!current) {
      this.counters.set(key, { name, value, labels });
      return;
    }
    current.value += value;
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = keyFor(name, labels);
    this.gauges.set(key, { name, value, labels });
  }

  getAll(): { counters: MetricEntry[]; gauges: MetricEntry[] } {
    return {
      counters: Array.from(this.counters.values()),
      gauges: Array.from(this.gauges.values()),
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];

    const serialize = (entry: MetricEntry): string => {
      const labels = Object.entries(entry.labels)
        .map(([k, v]) => `${k}="${String(v).replaceAll('"', '\\"')}"`)
        .join(",");
      const suffix = labels.length > 0 ? `{${labels}}` : "";
      return `${entry.name}${suffix} ${entry.value}`;
    };

    for (const entry of this.counters.values()) {
      lines.push(serialize(entry));
    }

    for (const entry of this.gauges.values()) {
      lines.push(serialize(entry));
    }

    return lines.join("\n");
  }
}
