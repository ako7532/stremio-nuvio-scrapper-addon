import { describe, expect, it, vi } from 'vitest';

import { createSearchLogObserver } from '../../src/infrastructure/search-logger.js';

describe('search logger', () => {
  it('logs only the typed safe observation fields', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const observe = createSearchLogObserver({ info, warn });

    observe({
      type: 'provider-error',
      provider: 'webshare',
      category: 'AuthenticationFailed',
      correlationId: 'request-1',
    });

    expect(warn).toHaveBeenCalledWith(
      {
        type: 'provider-error',
        provider: 'webshare',
        category: 'AuthenticationFailed',
        correlationId: 'request-1',
      },
      'provider search failed',
    );
    expect(info).not.toHaveBeenCalled();

    observe({
      type: 'provider-stage-complete',
      provider: 'sktorrent',
      stage: 'precise',
      queries: ['Mafstory S01E01'],
      durationMs: 123,
      rawResultCount: 0,
      failureCount: 0,
      correlationId: 'request-2',
    });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'provider-stage-complete',
        queries: ['Mafstory S01E01'],
      }),
      'safe search debug',
    );

    observe({
      type: 'torbox-playback-stage',
      stage: 'create-torrent',
      outcome: 'failed',
      durationMs: 321,
      category: 'invalid-response',
      statusCode: 422,
    });

    expect(warn).toHaveBeenCalledWith(
      {
        type: 'torbox-playback-stage',
        stage: 'create-torrent',
        outcome: 'failed',
        durationMs: 321,
        category: 'invalid-response',
        statusCode: 422,
      },
      'torbox playback stage failed',
    );

    observe({
      type: 'torbox-precache-stage',
      stage: 'create-torrent',
      outcome: 'complete',
      durationMs: 456,
      season: 17,
      episode: 2,
    });

    expect(info).toHaveBeenCalledWith(
      {
        type: 'torbox-precache-stage',
        stage: 'create-torrent',
        outcome: 'complete',
        durationMs: 456,
        season: 17,
        episode: 2,
      },
      'safe precache debug',
    );
  });
});
