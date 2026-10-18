import { config } from "../config.ts";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly capacity: number = config.rateLimitMax,
    private readonly windowMs: number = config.rateLimitWindowMs,
  ) {}

  check(key: string, cost = 1): boolean {
    const nowMs = Date.now();
    this.maybeSweep(nowMs);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsed = nowMs - bucket.updatedAt;
    if (elapsed > 0) {
      const refill = (elapsed / this.windowMs) * this.capacity;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.updatedAt = nowMs;
    }
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }

  retryAfterMs(key: string, cost = 1): number {
    const nowMs = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const elapsed = Math.max(0, nowMs - bucket.updatedAt);
    const msPerToken = this.windowMs / this.capacity;
    const deficit = cost - (bucket.tokens + (elapsed / this.windowMs) * this.capacity);
    if (deficit <= 0) return 0;
    return Math.ceil(deficit * msPerToken);
  }

  get size(): number {
    return this.buckets.size;
  }

  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweep < this.windowMs) return;
    this.lastSweep = nowMs;
    const cutoff = nowMs - this.windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }
}

export const apiRateLimiter = new RateLimiter();

export const authRateLimiter = new RateLimiter(30, config.rateLimitWindowMs);
