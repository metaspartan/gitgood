import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createLivePoller } from "../../src/web/live-poller.ts";
import { LiveStatus } from "../../src/web/components/LiveStatus.tsx";

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function harness(load: (signal: AbortSignal) => Promise<void>) {
  let available = true;
  let canceled = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  const poller = createLivePoller({ load, available: () => available, intervalMs: 10000,
    schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    cancel: timer => { if (timers.delete(timer as number)) canceled++; },
  });
  return { poller, timers, canceled: () => canceled, availability: (value: boolean) => { available = value; poller.availabilityChanged(); },
    tick: () => { const [key, timer] = [...timers][0]!; timers.delete(key); timer.callback(); } };
}

test("zero, one and multiple refreshes never overlap and coalesce to one follow-up", async () => {
  for (const count of [0, 1, 2]) {
    let started = 0;
    let resolve!: () => void;
    const h = harness(() => { started++; return new Promise<void>(r => { resolve = r; }); });
    h.poller.start();
    for (let i = 0; i < count; i++) h.poller.refresh();
    expect(started).toBe(1); expect(h.timers.size).toBe(0);
    resolve(); await settle();
    expect(h.timers.size).toBe(1);
    expect([...h.timers.values()][0]!.delay).toBe(count ? 0 : 10000);
    h.tick(); expect(started).toBe(2);
    h.poller.stop(); resolve(); await settle(); expect(h.timers.size).toBe(0);
  }
});

test("unavailable pages suspend timers and resume one request", async () => {
  let started = 0;
  const h = harness(async () => { started++; });
  h.availability(false); h.poller.start(); expect(started).toBe(0);
  h.availability(true); await settle(); expect(started).toBe(1);
  h.availability(false); expect(h.canceled()).toBe(1); expect(h.timers.size).toBe(0);
  h.poller.refresh(); expect(started).toBe(1);
  h.availability(true); await settle(); expect(started).toBe(2);
  h.poller.stop(); expect(h.canceled()).toBe(2);
});

test("retry backoff caps at sixty seconds and resets after success", async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error("offline"); });
  h.poller.start();
  for (const delay of [20000, 40000, 60000, 60000]) {
    await settle(); expect([...h.timers.values()][0]!.delay).toBe(delay); h.tick();
  }
  await settle(); fail = false; h.tick(); await settle();
  expect([...h.timers.values()][0]!.delay).toBe(10000);
  h.poller.stop(); expect(h.timers.size).toBe(0);
});

test("stop aborts an in-flight request and never schedules more work", async () => {
  let signal!: AbortSignal; let finish!: () => void;
  const h = harness(s => { signal = s; return new Promise<void>(r => { finish = r; }); });
  h.poller.start(); h.poller.refresh(); h.poller.stop();
  expect(signal.aborted).toBe(true); finish(); await settle();
  h.poller.refresh(); expect(h.timers.size).toBe(0);
});

test("status distinguishes stale data, pause and successful update without a refresh button", () => {
  for (const [error, paused, label] of [[null, false, "Auto-updating"], ["failure", false, "Reconnecting automatically"], [null, true, "Updates paused"]] as const) {
    const html = renderToStaticMarkup(<LiveStatus error={error} paused={paused} loading={false} updatedAt={1700000000000} />);
    expect(html).toContain(label); expect(html).toContain('role="status"'); expect(html).toContain('Last checked'); expect(html).not.toContain('<button');
  }
});
