import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES_PER_SECOND, UploadThrottle, validateUploadRate, type UploadClock } from "../../src/lib/upload-throttle.ts";

function fixture() {
  let time = 0;
  const sleeps: number[] = [];
  const clock: UploadClock = {
    now: () => time,
    sleep: async (milliseconds, signal) => {
      signal.throwIfAborted();
      sleeps.push(milliseconds);
      time += milliseconds;
    },
  };
  return { clock, sleeps, now: () => time, idle: (milliseconds: number) => { time += milliseconds; } };
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return chunks;
}

describe("paced upload bodies", () => {
  test("unlimited is the compatible default, and rate boundaries are validated", () => {
    expect(validateUploadRate(undefined)).toBe(0);
    expect(validateUploadRate(0)).toBe(0);
    expect(validateUploadRate(1)).toBe(1);
    expect(validateUploadRate(MAX_UPLOAD_BYTES_PER_SECOND)).toBe(MAX_UPLOAD_BYTES_PER_SECOND);
    for (const invalid of [-1, 0.5, MAX_UPLOAD_BYTES_PER_SECOND + 1, NaN, Infinity, "625000", null]) {
      expect(() => validateUploadRate(invalid)).toThrow("Upload limit");
    }
  });

  test("below, at and just above the slice boundary send every byte in order", async () => {
    for (const size of [0, 99, 100, 101]) {
      const f = fixture();
      const limiter = new UploadThrottle(1000, f.clock);
      const payload = Uint8Array.from({ length: size }, (_, index) => index % 251);
      const chunks = await collect(limiter.body(payload, new AbortController().signal));
      expect(chunks.map((chunk) => chunk.byteLength)).toEqual(size === 0 ? [] : size <= 100 ? [size] : [100, 1]);
      expect(Buffer.compare(Buffer.concat(chunks), Buffer.from(payload))).toBe(0);
      expect(f.now()).toBe(size);
      expect(f.sleeps.length).toBe(size === 0 ? 0 : size <= 100 ? 1 : 2);
    }
  });

  test("the first bytes are paced and retries share the same budget without accumulating idle credit", async () => {
    const f = fixture();
    const limiter = new UploadThrottle(1000, f.clock);
    const signal = new AbortController().signal;
    const reader = limiter.body(new Uint8Array(100), signal).getReader();
    expect(f.now()).toBe(0);
    expect((await reader.read()).value!.byteLength).toBe(100);
    expect(f.now()).toBe(100);
    await reader.cancel();
    f.idle(10_000);
    await collect(limiter.body(new Uint8Array(100), signal));
    expect(f.now()).toBe(10_200);
    await collect(limiter.body(new Uint8Array(100), signal));
    expect(f.now()).toBe(10_300);
    expect(f.sleeps).toEqual([100, 100, 100]);
  });

  test("unlimited uploads never sleep and high rates keep emission buffers bounded", async () => {
    const f = fixture();
    await collect(new UploadThrottle(0, f.clock).body(new Uint8Array(101), new AbortController().signal));
    expect(f.sleeps).toEqual([]);
    const chunks = await collect(new UploadThrottle(MAX_UPLOAD_BYTES_PER_SECOND, f.clock).body(new Uint8Array(65_537), new AbortController().signal));
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([65_536, 1]);
  });

  test("cancelling a body interrupts its pending sleep without emitting data", async () => {
    let sleeps = 0;
    let interrupted = 0;
    const clock: UploadClock = {
      now: () => 0,
      sleep: async (_milliseconds, signal) => {
        sleeps += 1;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => { interrupted += 1; reject(signal.reason); }, { once: true });
        });
      },
    };
    const reader = new UploadThrottle(1000, clock).body(new Uint8Array(100), new AbortController().signal).getReader();
    const waiting = reader.read();
    await Promise.resolve();
    await reader.cancel();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(sleeps).toBe(1);
    expect(interrupted).toBe(1);
  });

  test("aborted requests never begin throttled work", async () => {
    const f = fixture();
    const limiter = new UploadThrottle(1000, f.clock);
    await expect(collect(limiter.body(new Uint8Array(100), AbortSignal.abort()))).rejects.toThrow();
    expect(f.sleeps).toEqual([]);
  });
});
