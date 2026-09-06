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
  });
});
