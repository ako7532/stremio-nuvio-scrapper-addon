import { describe, expect, it, vi } from 'vitest';

import type { MovieRequest } from '../../src/domain/media.js';
import {
  MetadataNotFoundError,
  OrderedMetadataResolver,
  type MetadataResolutionContext,
  type MetadataSource,
} from '../../src/metadata/metadata-resolver.js';

const request: MovieRequest = { type: 'movie', id: 'tt0111161' };

function context(signal: AbortSignal = new AbortController().signal): MetadataResolutionContext {
  return { signal, correlationId: 'test-request' };
}

describe('OrderedMetadataResolver', () => {
  it('uses the first source that resolves metadata', async () => {
    const miss: MetadataSource = { name: 'miss', lookup: vi.fn().mockResolvedValue(undefined) };
    const metadata = {
      ...request,
      originalTitle: 'The Shawshank Redemption',
      alternativeTitles: [],
      year: 1994,
    } as const;
    const hit: MetadataSource = { name: 'hit', lookup: vi.fn().mockResolvedValue(metadata) };
    const unusedLookup = vi.fn();
    const unused: MetadataSource = { name: 'unused', lookup: unusedLookup };

    await expect(
      new OrderedMetadataResolver([miss, hit, unused]).resolve(request, context()),
    ).resolves.toBe(metadata);
    expect(unusedLookup).not.toHaveBeenCalled();
  });

  it('reports a typed not-found error when every source misses', async () => {
    const source: MetadataSource = { name: 'miss', lookup: vi.fn().mockResolvedValue(undefined) };

    await expect(
      new OrderedMetadataResolver([source]).resolve(request, context()),
    ).rejects.toBeInstanceOf(MetadataNotFoundError);
  });

  it('does not call a source after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = vi.fn();
    const source: MetadataSource = { name: 'source', lookup };

    await expect(
      new OrderedMetadataResolver([source]).resolve(request, context(controller.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
