import type { MediaMetadata, MediaRequest } from '../domain/media.js';

export type MetadataResolutionContext = {
  signal: AbortSignal;
  correlationId: string;
};

export type MetadataResolver = {
  resolve(request: MediaRequest, context: MetadataResolutionContext): Promise<MediaMetadata>;
};

export type MetadataSource = {
  readonly name: string;
  lookup(
    request: MediaRequest,
    context: MetadataResolutionContext,
  ): Promise<MediaMetadata | undefined>;
};

export class MetadataNotFoundError extends Error {
  constructor(readonly request: MediaRequest) {
    super(`Metadata not found for ${request.id}`);
    this.name = 'MetadataNotFoundError';
  }
}

export class OrderedMetadataResolver implements MetadataResolver {
  constructor(private readonly sources: readonly MetadataSource[]) {}

  async resolve(request: MediaRequest, context: MetadataResolutionContext): Promise<MediaMetadata> {
    for (const source of this.sources) {
      context.signal.throwIfAborted();
      const metadata = await source.lookup(request, context);
      if (metadata !== undefined) {
        return metadata;
      }
    }

    throw new MetadataNotFoundError(request);
  }
}
