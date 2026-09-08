import { describe, expect, it, vi } from 'vitest';

import { readBoundedResponseBody } from '../../../src/providers/indexers/bounded-response-body.js';

describe('bounded Indexers response body', () => {
  it('cancels a chunked response as soon as the configured limit is crossed', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });

    await expect(
      readBoundedResponseBody(
        new Response(body),
        10,
        'Fixture response',
        (message) => new TypeError(message),
      ),
    ).rejects.toThrow('Fixture response is too large');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('combines bounded chunks and enforces a non-empty body', async () => {
    await expect(
      readBoundedResponseBody(
        new Response(Uint8Array.from([1, 2, 3])),
        3,
        'Fixture response',
        (message) => new TypeError(message),
        true,
      ),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    await expect(
      readBoundedResponseBody(
        new Response(null),
        3,
        'Fixture response',
        (message) => new TypeError(message),
        true,
      ),
    ).rejects.toThrow('Fixture response has an invalid size');
  });
});
