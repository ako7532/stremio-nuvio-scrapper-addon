import { describe, expect, it } from 'vitest';

import { createFixedWindowRateLimiter } from '../../src/infrastructure/fixed-window-rate-limiter.js';

describe('fixed-window rate limiter', () => {
  it('limits each key independently and reports when it may retry', () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter({
      maximumAttempts: 2,
      windowMs: 5_000,
      clock: () => now,
    });

    expect(limiter.consume('config-a')).toEqual({ allowed: true });
    expect(limiter.consume('config-a')).toEqual({ allowed: true });
    expect(limiter.consume('config-b')).toEqual({ allowed: true });
    expect(limiter.consume('config-a')).toEqual({ allowed: false, retryAfterMs: 5_000 });

    now = 6_000;
    expect(limiter.consume('config-a')).toEqual({ allowed: true });
  });

  it('keeps memory bounded when presented with many unique keys', () => {
    const limiter = createFixedWindowRateLimiter({
      maximumAttempts: 1,
      windowMs: 5_000,
      maximumTrackedKeys: 2,
      clock: () => 1_000,
    });

    expect(limiter.consume('first')).toEqual({ allowed: true });
    expect(limiter.consume('second')).toEqual({ allowed: true });
    expect(limiter.consume('third')).toEqual({ allowed: true });
    expect(limiter.consume('first')).toEqual({ allowed: true });
  });

  it('rejects unsafe limiter settings', () => {
    expect(() => createFixedWindowRateLimiter({ maximumAttempts: 0, windowMs: 1_000 })).toThrow(
      'maximum attempts must be a positive integer',
    );
  });
});
