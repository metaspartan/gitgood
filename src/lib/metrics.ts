const COUNTERS = new Map<string, number>();
const GAUGES = new Map<string, number>();
const LATENCY_WINDOW = 4096;

interface Histogram {
  samples: Float64Array;
  cursor: number;
  count: number;
  sum: number;
  max: number;
}

const HISTOGRAMS = new Map<string, Histogram>();

function histogram(name: string): Histogram {
  let existing = HISTOGRAMS.get(name);
  if (!existing) {
    existing = { samples: new Float64Array(LATENCY_WINDOW), cursor: 0, count: 0, sum: 0, max: 0 };
    HISTOGRAMS.set(name, existing);
  }
  return existing;
}

export function increment(name: string, delta = 1): void {
  COUNTERS.set(name, (COUNTERS.get(name) ?? 0) + delta);
}

export function setGauge(name: string, value: number): void {
  GAUGES.set(name, value);
}

export function observe(name: string, valueMs: number): void {
  const hist = histogram(name);
  hist.samples[hist.cursor] = valueMs;
  hist.cursor = (hist.cursor + 1) % LATENCY_WINDOW;
  hist.count += 1;
  hist.sum += valueMs;
  if (valueMs > hist.max) hist.max = valueMs;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  max: number;
  min: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export function snapshot(name: string): HistogramSnapshot {
  const hist = HISTOGRAMS.get(name);
  if (!hist) return { count: 0, sum: 0, max: 0, min: 0, avg: 0, p50: 0, p90: 0, p99: 0 };
  const filled = Math.min(hist.count, LATENCY_WINDOW);
  const values = Array.from(hist.samples.subarray(0, filled)).sort((x, y) => x - y);
  return {
    count: hist.count,
    sum: Math.round(hist.sum * 100) / 100,
    max: Math.round(hist.max * 100) / 100,
    min: Math.round((values[0] ?? 0) * 100) / 100,
    avg: hist.count > 0 ? Math.round((hist.sum / hist.count) * 100) / 100 : 0,
    p50: Math.round(percentile(values, 50) * 100) / 100,
    p90: Math.round(percentile(values, 90) * 100) / 100,
    p99: Math.round(percentile(values, 99) * 100) / 100,
  };
}

export function resetMetrics(): void {
  COUNTERS.clear();
  GAUGES.clear();
  HISTOGRAMS.clear();
}

export interface ProcessStats {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  cpuPercent: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  uptimeSeconds: number;
  eventLoopLagMs: number;
}

let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();

let eventLoopLagMs = 0;
const LAG_INTERVAL_MS = 500;
let lastTickAt = performance.now();
const lagTimer = setInterval(() => {
  const nowMs = performance.now();
  eventLoopLagMs = Math.round(Math.max(0, nowMs - lastTickAt - LAG_INTERVAL_MS) * 100) / 100;
  lastTickAt = nowMs;
}, LAG_INTERVAL_MS);
lagTimer.unref?.();

export function processStats(): ProcessStats {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const nowMs = performance.now();
  const wallMs = Math.max(1, nowMs - lastCpuAt);
  const userDelta = cpu.user - lastCpu.user;
  const systemDelta = cpu.system - lastCpu.system;
  const cpuPercent = Math.round(((userDelta + systemDelta) / (wallMs * 1000)) * 10000) / 100;
  lastCpu = cpu;
  lastCpuAt = nowMs;
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    cpuPercent,
    cpuUserMs: Math.round(userDelta / 1000),
    cpuSystemMs: Math.round(systemDelta / 1000),
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopLagMs,
  };
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [name, value] of COUNTERS) lines.push(`# TYPE ${name} counter\n${name} ${value}`);
  for (const [name, value] of GAUGES) lines.push(`# TYPE ${name} gauge\n${name} ${value}`);
  for (const [name, hist] of HISTOGRAMS) {
    const snap = snapshot(name);
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}_count ${snap.count}`);
    lines.push(`${name}_sum ${snap.sum}`);
    lines.push(`${name}{quantile="0.5"} ${snap.p50}`);
    lines.push(`${name}{quantile="0.9"} ${snap.p90}`);
    lines.push(`${name}{quantile="0.99"} ${snap.p99}`);
    void hist;
  }
  return `${lines.join("\n")}\n`;
}

export function allCounters(): Record<string, number> {
  return Object.fromEntries(COUNTERS);
}

export function allHistograms(): Record<string, HistogramSnapshot> {
  return Object.fromEntries([...HISTOGRAMS.keys()].map((name) => [name, snapshot(name)]));
}

export function gaugeValue(name: string): number {
  return GAUGES.get(name) ?? 0;
}
