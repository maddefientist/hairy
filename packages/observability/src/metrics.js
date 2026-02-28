const keyFor = (name, labels) => {
  const labelString = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
  return `${name}|${labelString}`;
};
export class Metrics {
  counters = new Map();
  gauges = new Map();
  increment(name, value = 1, labels = {}) {
    const key = keyFor(name, labels);
    const current = this.counters.get(key);
    if (!current) {
      this.counters.set(key, { name, value, labels });
      return;
    }
    current.value += value;
  }
  gauge(name, value, labels = {}) {
    const key = keyFor(name, labels);
    this.gauges.set(key, { name, value, labels });
  }
  getAll() {
    return {
      counters: Array.from(this.counters.values()),
      gauges: Array.from(this.gauges.values()),
    };
  }
  toPrometheus() {
    const lines = [];
    const serialize = (entry) => {
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
//# sourceMappingURL=metrics.js.map
