const FREE_ATTEMPTS = 4;

const WINDOW_MS = 15 * 60 * 1000;

const MAX_DELAY_MS = WINDOW_MS;

interface Failure {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const failures = new Map<string, Failure>();

const MAX_TRACKED_ACCOUNTS = 20_000;

export interface ThrottleState {
  blocked: boolean;
  retryAfterMs: number;
  consecutiveFailures: number;
}

export function throttleKey(username: string): string {
  return username.trim().toLowerCase();
}

function prune(now: number): void {
  if (failures.size <= MAX_TRACKED_ACCOUNTS) return;
  const target = Math.floor(MAX_TRACKED_ACCOUNTS * 0.8);
  for (const [key, state] of failures) {
    if (state.blockedUntil <= now && state.firstAt + WINDOW_MS <= now) failures.delete(key);
    if (failures.size <= target) return;
  }
  for (const key of failures.keys()) {
    failures.delete(key);
    if (failures.size <= target) return;
  }
}

export function checkLoginThrottle(username: string, now = Date.now()): ThrottleState {
  const key = throttleKey(username);
  const state = failures.get(key);
  if (!state) return { blocked: false, retryAfterMs: 0, consecutiveFailures: 0 };
  const retryAfterMs = state.blockedUntil - now;
  if (retryAfterMs <= 0) {
    return { blocked: false, retryAfterMs: 0, consecutiveFailures: state.count };
  }
  return { blocked: true, retryAfterMs, consecutiveFailures: state.count };
}

export function recordLoginFailure(username: string, now = Date.now()): ThrottleState {
  const key = throttleKey(username);
  prune(now);
  const previous = failures.get(key);
  const count = previous && now - previous.firstAt <= WINDOW_MS ? previous.count + 1 : 1;
  const firstAt = previous && now - previous.firstAt <= WINDOW_MS ? previous.firstAt : now;
  const beyondFree = count - FREE_ATTEMPTS;
  const delay = beyondFree <= 0 ? 0 : Math.min(MAX_DELAY_MS, 2 ** (beyondFree - 1) * 1000);
  const next: Failure = { count, firstAt, blockedUntil: now + delay };
  failures.set(key, next);
  return { blocked: delay > 0, retryAfterMs: delay, consecutiveFailures: count };
}

export function recordLoginSuccess(username: string): void {
  failures.delete(throttleKey(username));
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

export function resetLoginThrottle(): void {
  failures.clear();
}

export function trackedAccounts(): number {
  return failures.size;
}

export const THROTTLE_LIMITS = { WINDOW_MS, MAX_DELAY_MS, FREE_ATTEMPTS } as const;
