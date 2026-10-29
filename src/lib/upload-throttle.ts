import { setTimeout as delay } from "node:timers/promises";

export const MAX_UPLOAD_BYTES_PER_SECOND = 1_250_000_000;
const MAX_SLICE_BYTES = 64 * 1024;

export interface UploadClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: UploadClock = {
  now: () => performance.now(),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};

export function validateUploadRate(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_UPLOAD_BYTES_PER_SECOND) {
    throw new Error(`Upload limit must be between 0 and ${MAX_UPLOAD_BYTES_PER_SECOND} bytes per second`);
  }
  return value;
}

export class UploadThrottle {
  private nextAt = 0;
  readonly sliceBytes: number;

  constructor(readonly bytesPerSecond: number, private readonly clock: UploadClock = systemClock) {
    validateUploadRate(bytesPerSecond);
    this.sliceBytes = Math.max(1, Math.min(MAX_SLICE_BYTES, Math.floor(bytesPerSecond / 10)));
  }

  async wait(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.bytesPerSecond === 0 || bytes === 0) return;
    this.nextAt = Math.max(this.nextAt, this.clock.now()) + (bytes * 1000) / this.bytesPerSecond;
    while (this.nextAt > this.clock.now()) {
      await this.clock.sleep(this.nextAt - this.clock.now(), signal);
      signal.throwIfAborted();
    }
  }

  body(bytes: Uint8Array<ArrayBufferLike>, signal: AbortSignal): ReadableStream<Uint8Array> {
    let offset = 0;
    let cancelled = false;
    const cancellation = new AbortController();
    const combined = AbortSignal.any([signal, cancellation.signal]);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, offset + this.sliceBytes);
        await this.wait(end - offset, combined);
        if (cancelled) return;
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel: () => {
        cancelled = true;
        cancellation.abort();
      },
    }, { highWaterMark: 0 });
  }
}
