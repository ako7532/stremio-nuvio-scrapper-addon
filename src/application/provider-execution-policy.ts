import type { SearchQuery } from '../domain/media.js';
import { createFixedWindowRateLimiter } from '../infrastructure/fixed-window-rate-limiter.js';
import { SktorrentHttpError } from '../providers/sktorrent/sktorrent-http-client.js';
import type { ProviderSearchContext, StreamProvider } from '../providers/provider.js';
import { WebshareTransportError } from '../providers/webshare/webshare-api-client.js';
import { ApplicationError, classifyApplicationError } from './application-error.js';

export type ProviderExecutionPolicyOptions = {
  maximumConcurrency?: number;
  maximumQueued?: number;
  maximumOperationsPerWindow?: number;
  operationWindowMs?: number;
  maximumAttempts?: number;
  retryDelayMs?: number;
  clock?: () => number;
};

const DEFAULT_MAXIMUM_CONCURRENCY = 2;
const DEFAULT_MAXIMUM_QUEUED = 100;
const DEFAULT_MAXIMUM_OPERATIONS = 120;
const DEFAULT_OPERATION_WINDOW_MS = 60_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

export function applyProviderExecutionPolicy(
  provider: StreamProvider,
  options: ProviderExecutionPolicyOptions = {},
): StreamProvider {
  const maximumConcurrency = positiveInteger(
    options.maximumConcurrency ?? DEFAULT_MAXIMUM_CONCURRENCY,
    'provider concurrency',
  );
  const maximumQueued = positiveInteger(
    options.maximumQueued ?? DEFAULT_MAXIMUM_QUEUED,
    'maximum queued provider operations',
  );
  const maximumAttempts = positiveInteger(
    options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS,
    'maximum provider attempts',
  );
  const retryDelayMs = nonNegativeInteger(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    'provider retry delay',
  );
  const limiter = createFixedWindowRateLimiter({
    maximumAttempts: options.maximumOperationsPerWindow ?? DEFAULT_MAXIMUM_OPERATIONS,
    windowMs: options.operationWindowMs ?? DEFAULT_OPERATION_WINDOW_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const semaphore = createSemaphore(maximumConcurrency, maximumQueued);

  return {
    name: provider.name,
    capabilities: provider.capabilities,
    search(query, context) {
      return semaphore.run(context.signal, () =>
        searchWithRetry(provider, query, context, limiter, maximumAttempts, retryDelayMs),
      );
    },
  };
}

async function searchWithRetry(
  provider: StreamProvider,
  query: SearchQuery,
  context: ProviderSearchContext,
  limiter: ReturnType<typeof createFixedWindowRateLimiter>,
  maximumAttempts: number,
  retryDelayMs: number,
) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    const decision = limiter.consume(provider.name);
    if (!decision.allowed) {
      throw new ApplicationError('RateLimited', { retryAfterMs: decision.retryAfterMs });
    }
    try {
      return await provider.search(query, context);
    } catch (error) {
      context.signal.throwIfAborted();
      if (attempt >= maximumAttempts || !isTransientProviderError(error)) {
        throw classifyApplicationError(error, 'ProviderUnavailable');
      }
      await abortableDelay(retryDelayMs, context.signal);
    }
  }
  throw new ApplicationError('ProviderUnavailable');
}

function isTransientProviderError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (error instanceof SktorrentHttpError) {
    return error.kind === 'timeout' || error.kind === 'unavailable';
  }
  if (error instanceof WebshareTransportError) {
    return error.kind === 'timeout' || error.kind === 'unavailable';
  }
  return error instanceof ApplicationError && error.kind === 'ProviderTimeout';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });

    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(abortError(signal));
    }
  });
}

type QueueEntry = {
  signal: AbortSignal;
  start: () => void;
  reject: (reason: unknown) => void;
};

function createSemaphore(maximumConcurrency: number, maximumQueued: number) {
  let active = 0;
  const queue: QueueEntry[] = [];

  const release = (): void => {
    active -= 1;
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) return;
      if (entry.signal.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }
      entry.start();
      return;
    }
  };

  return {
    async run<Value>(signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
      signal.throwIfAborted();
      if (active >= maximumConcurrency) {
        if (queue.length >= maximumQueued) throw new ApplicationError('RateLimited');
        await new Promise<void>((resolve, reject) => {
          const entry: QueueEntry = {
            signal,
            reject,
            start: () => {
              signal.removeEventListener('abort', onAbort);
              active += 1;
              resolve();
            },
          };
          const onAbort = (): void => {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            reject(abortError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          queue.push(entry);
        });
      } else {
        active += 1;
      }
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
