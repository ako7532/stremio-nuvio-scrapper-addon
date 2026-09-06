import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../../src/application/application-error.js';
import { applyProviderExecutionPolicy } from '../../src/application/provider-execution-policy.js';
import { SktorrentHttpError } from '../../src/providers/sktorrent/sktorrent-http-client.js';
import type { StreamProvider } from '../../src/providers/provider.js';

const query = { type: 'movie' as const, value: 'Fixture', title: 'Fixture' };
const context = () => ({ signal: new AbortController().signal, correlationId: 'request-1' });

describe('provider execution policy', () => {
  it('retries only transient provider failures', async () => {
    const search = vi
      .fn<StreamProvider['search']>()
      .mockRejectedValueOnce(new SktorrentHttpError('timeout', 'timeout'))
      .mockResolvedValue([]);
    const provider = applyProviderExecutionPolicy(fixtureProvider(search), { retryDelayMs: 0 });

    await expect(provider.search(query, context())).resolves.toEqual([]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('does not retry authentication or malformed responses', async () => {
    const search = vi
      .fn<StreamProvider['search']>()
      .mockRejectedValue(new SktorrentHttpError('authentication-failed', 'private detail'));
    const provider = applyProviderExecutionPolicy(fixtureProvider(search), { retryDelayMs: 0 });

    await expect(provider.search(query, context())).rejects.toMatchObject({
      kind: 'AuthenticationFailed',
    });
    expect(search).toHaveBeenCalledOnce();
  });

  it('enforces a provider-operation budget with backoff', async () => {
    const search = vi.fn<StreamProvider['search']>().mockResolvedValue([]);
    const provider = applyProviderExecutionPolicy(fixtureProvider(search), {
      maximumOperationsPerWindow: 1,
      operationWindowMs: 5_000,
    });

    await provider.search(query, context());
    const limited = provider.search(query, context());

    await expect(limited).rejects.toBeInstanceOf(ApplicationError);
    await expect(limited).rejects.toMatchObject({ kind: 'RateLimited', retryAfterMs: 5_000 });
    expect(search).toHaveBeenCalledOnce();
  });

  it('bounds concurrent provider calls', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const search = vi.fn<StreamProvider['search']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve([]);
          });
        }),
    );
    const provider = applyProviderExecutionPolicy(fixtureProvider(search), {
      maximumConcurrency: 1,
    });

    const first = provider.search(query, context());
    const second = provider.search(query, context());
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    const releaseFirst = releases.shift();
    releaseFirst?.();
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    const releaseSecond = releases.shift();
    releaseSecond?.();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
  });

  it('rejects excess queued work without starting it', async () => {
    const releases: (() => void)[] = [];
    const search = vi.fn<StreamProvider['search']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => {
            resolve([]);
          });
        }),
    );
    const provider = applyProviderExecutionPolicy(fixtureProvider(search), {
      maximumConcurrency: 1,
      maximumQueued: 1,
    });

    const first = provider.search(query, context());
    const second = provider.search(query, context());
    await expect(provider.search(query, context())).rejects.toMatchObject({ kind: 'RateLimited' });
    const releaseFirst = releases.shift();
    releaseFirst?.();
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    const releaseSecond = releases.shift();
    releaseSecond?.();
    await Promise.all([first, second]);

    expect(search).toHaveBeenCalledTimes(2);
  });
});

function fixtureProvider(search: StreamProvider['search']): StreamProvider {
  return {
    name: 'sktorrent',
    capabilities: {
      search: true,
      source: 'torrent',
      requiresAuthentication: true,
      supportsDirectStreaming: false,
      supportsCacheLookup: false,
    },
    search,
  };
}
