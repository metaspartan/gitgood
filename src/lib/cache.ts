const MAX_ENTRIES = 4000;

interface Entry {
  value?: unknown;
  expires: number;
  promise?: Promise<unknown>;
}

const store = new Map<string, Entry>();
let hits = 0;
let misses = 0;
let coalesced = 0;
let invalidations = 0;

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  coalesced: number;
  invalidations: number;
  hitRate: number;
}

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (!entry.promise && entry.expires <= now) store.delete(key);
  }
  for (const key of store.keys()) {
    if (store.size <= MAX_ENTRIES) break;
    store.delete(key);
  }
}

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const existing = store.get(key);
  if (existing) {
    if (existing.promise) {
      coalesced += 1;
      return existing.promise as Promise<T>;
    }
    if (existing.expires > Date.now()) {
      hits += 1;
      return existing.value as T;
    }
  }
  misses += 1;

  const promise = loader().then(
    (value) => {
      const current = store.get(key);
      if (current && current.promise === promise) {
        store.set(key, { value, expires: Date.now() + ttlMs });
      }
      return value;
    },
    (error: unknown) => {
      const current = store.get(key);
      if (current?.promise === promise) store.delete(key);
      throw error;
    },
  );

  store.set(key, { expires: 0, promise: promise as Promise<unknown> });
  evictIfNeeded();
  return promise;
}

export function invalidatePrefix(prefix: string): number {
  let removed = 0;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }
  invalidations += removed;
  return removed;
}

export function cacheStats(): CacheStats {
  const total = hits + misses;
  return {
    entries: store.size,
    hits,
    misses,
    coalesced,
    invalidations,
    hitRate: total === 0 ? 0 : Math.round((hits / total) * 1000) / 10,
  };
}

export function clearCache(): void {
  store.clear();
}
