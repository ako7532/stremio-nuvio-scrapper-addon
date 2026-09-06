import { describe, expect, it } from 'vitest';

import { classifyApplicationError } from '../../src/application/application-error.js';
import { MetadataNotFoundError } from '../../src/metadata/metadata-resolver.js';
import { SktorrentHttpError } from '../../src/providers/sktorrent/sktorrent-http-client.js';
import { TorboxTransportError } from '../../src/providers/torbox/torbox-api-client.js';
import { WebshareApiError } from '../../src/providers/webshare/webshare-xml.js';

describe('application error classification', () => {
  it.each([
    [new SktorrentHttpError('timeout', 'internal timeout detail'), 'ProviderTimeout'],
    [
      new SktorrentHttpError('authentication-failed', 'internal authentication detail'),
      'AuthenticationFailed',
    ],
    [new WebshareApiError('authentication', 'private provider message'), 'AuthenticationFailed'],
    [new DOMException('internal timeout detail', 'TimeoutError'), 'ProviderTimeout'],
    [new MetadataNotFoundError({ type: 'movie', id: 'tt0111161' }), 'MediaNotFound'],
  ])('maps provider and metadata errors to %s', (error, expectedKind) => {
    const classified = classifyApplicationError(error);

    expect(classified?.kind).toBe(expectedKind);
    expect(classified?.cause).toBe(error);
  });

  it('preserves provider backoff without exposing the provider error', () => {
    const providerError = new TorboxTransportError('rate-limited', 'private provider message', {
      retryAfterMs: 12_500,
    });

    const classified = classifyApplicationError(providerError);

    expect(classified).toMatchObject({ kind: 'RateLimited', retryAfterMs: 12_500 });
    expect(classified?.message).toBe('RateLimited');
  });
});
