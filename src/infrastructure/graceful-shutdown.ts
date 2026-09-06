import type { FastifyInstance } from 'fastify';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export type ShutdownProcess = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): never;
};

export type GracefulShutdownOptions = {
  timeoutMs?: number;
  process?: ShutdownProcess;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function installGracefulShutdown(
  server: FastifyInstance,
  options: GracefulShutdownOptions = {},
): (signal: ShutdownSignal) => Promise<void> {
  const shutdownProcess = options.process ?? process;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let closing: Promise<void> | undefined;

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    closing ??= closeServer(server, shutdownProcess, signal, timeoutMs);
    return closing;
  };
  shutdownProcess.once('SIGINT', () => void shutdown('SIGINT'));
  shutdownProcess.once('SIGTERM', () => void shutdown('SIGTERM'));
  return shutdown;
}

async function closeServer(
  server: FastifyInstance,
  shutdownProcess: ShutdownProcess,
  signal: ShutdownSignal,
  timeoutMs: number,
): Promise<void> {
  server.log.info({ signal }, 'graceful shutdown started');
  const timeout = setTimeout(() => {
    server.log.error({ signal, category: 'ShutdownTimeout' }, 'graceful shutdown timed out');
    shutdownProcess.exit(1);
  }, timeoutMs);
  timeout.unref();
  try {
    await server.close();
    server.log.info({ signal }, 'graceful shutdown completed');
  } catch {
    server.log.error({ signal, category: 'ShutdownFailed' }, 'graceful shutdown failed');
    shutdownProcess.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('shutdown timeout must be a positive integer');
  }
  return value;
}
