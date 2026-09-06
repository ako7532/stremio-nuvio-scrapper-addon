import { describe, expect, it, vi } from 'vitest';

import {
  installGracefulShutdown,
  type ShutdownProcess,
} from '../../src/infrastructure/graceful-shutdown.js';

describe('graceful shutdown', () => {
  it('registers both signals and closes exactly once', async () => {
    const listeners = new Map<string, () => void>();
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn(() => {
      throw new Error('unexpected forced exit');
    });
    const shutdownProcess: ShutdownProcess = {
      once(signal, listener) {
        listeners.set(signal, listener);
      },
      exit,
    };
    const server = {
      close,
      log: { info: vi.fn(), error: vi.fn() },
    } as never;
    const shutdown = installGracefulShutdown(server, { process: shutdownProcess });

    listeners.get('SIGTERM')?.();
    await shutdown('SIGINT');

    expect(listeners.has('SIGINT')).toBe(true);
    expect(listeners.has('SIGTERM')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
