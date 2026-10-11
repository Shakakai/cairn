/**
 * Minimal Prometheus registry (docs/10 metric names). Counters and gauges keyed by
 * name + sorted label set; rendered as text exposition format on /metrics.
 */

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, value = 1, labels?: Record<string, string>): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  render(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters].sort()) {
      lines.push(`# TYPE ${key.split("{")[0]} counter`.replace("_total ", " "));
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of [...this.gauges].sort()) {
      lines.push(`# TYPE ${key.split("{")[0]} gauge`);
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels?: Record<string, string>): string {
  if (labels === undefined || Object.keys(labels).length === 0) return name;
  const rendered = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${name}{${rendered}}`;
}
