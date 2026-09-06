export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export type RateLimiter = {
  consume(key: string): RateLimitDecision;
};

export type FixedWindowRateLimiterOptions = {
  maximumAttempts: number;
  windowMs: number;
  maximumTrackedKeys?: number;
  clock?: () => number;
};

type WindowState = {
  attempts: number;
  resetsAt: number;
};

const DEFAULT_MAXIMUM_TRACKED_KEYS = 10_000;

export function createFixedWindowRateLimiter(options: FixedWindowRateLimiterOptions): RateLimiter {
  const maximumAttempts = positiveInteger(options.maximumAttempts, 'maximum attempts');
  const windowMs = positiveInteger(options.windowMs, 'rate-limit window');
  const maximumTrackedKeys = positiveInteger(
    options.maximumTrackedKeys ?? DEFAULT_MAXIMUM_TRACKED_KEYS,
    'maximum tracked rate-limit keys',
  );
  const clock = options.clock ?? Date.now;
  const windows = new Map<string, WindowState>();

  return {
    consume(key) {
      const now = clock();
      let state = windows.get(key);
      if (state === undefined || state.resetsAt <= now) {
        if (state === undefined) makeRoom(windows, now, maximumTrackedKeys);
        state = { attempts: 0, resetsAt: now + windowMs };
        windows.set(key, state);
      }
      if (state.attempts >= maximumAttempts) {
        return { allowed: false, retryAfterMs: Math.max(1, state.resetsAt - now) };
      }
      state.attempts += 1;
      return { allowed: true };
    },
  };
}

function makeRoom(
  windows: Map<string, WindowState>,
  now: number,
  maximumTrackedKeys: number,
): void {
  for (const [key, state] of windows) {
    if (state.resetsAt <= now) windows.delete(key);
  }
  while (windows.size >= maximumTrackedKeys) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) break;
    windows.delete(oldest);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
