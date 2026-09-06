import type { SearchObserver } from '../application/search-observability.js';

export type StructuredLogger = {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
};

export function createSearchLogObserver(logger: StructuredLogger): SearchObserver {
  return (event) => {
    if (event.type === 'provider-error') {
      logger.warn(event, 'provider search failed');
      return;
    }
    logger.info(event, 'search metric');
  };
}
