import type { SearchObserver } from '../application/search-observability.js';

export type StructuredLogger = {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
};

export function createSearchLogObserver(logger: StructuredLogger): SearchObserver {
  return (event) => {
    if (event.type === 'torbox-playback-stage') {
      if (event.outcome === 'failed') {
        logger.warn(event, 'torbox playback stage failed');
        return;
      }
      logger.info(event, 'safe playback debug');
      return;
    }
    if (event.type === 'torbox-precache-stage') {
      if (event.outcome === 'failed') {
        logger.warn(event, 'torbox precache stage failed');
        return;
      }
      logger.info(event, 'safe precache debug');
      return;
    }
    if (event.type === 'provider-error') {
      logger.warn(event, 'provider search failed');
      return;
    }
    if (event.type === 'search-error') {
      logger.warn(event, 'search phase failed');
      return;
    }
    logger.info(event, 'safe search debug');
  };
}
