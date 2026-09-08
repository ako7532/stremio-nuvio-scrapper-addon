import type { CredentialProvider, ProviderCredentials } from '../domain/configuration.js';
import { createTmdbClient } from '../metadata/tmdb-client.js';
import { createSktorrentSource } from '../providers/sktorrent/sktorrent-source.js';
import { createTorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import { createWebshareApiClient } from '../providers/webshare/webshare-api-client.js';
import { createWebshareCredentialService } from '../providers/webshare/webshare-credentials.js';
import { isEligiblePublicTorrentIndexer } from '../providers/indexers/indexer-backend.js';
import { createJackettBackend } from '../providers/indexers/jackett-backend.js';
import { createProwlarrBackend } from '../providers/indexers/prowlarr-backend.js';
import type { IndexerEndpointPolicy } from '../security/indexer-endpoint-policy.js';
import { ApplicationError, classifyApplicationError } from './application-error.js';

export type ProviderConnectionTester = (
  provider: CredentialProvider,
  credential: NonNullable<ProviderCredentials[CredentialProvider]>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<void>;

export type PublicIndexerConnectionStatus = {
  id: string;
  name: string;
  status: 'available' | 'capabilities-unavailable';
  capabilities?: { movie: boolean; series: boolean; generic: boolean };
};

export type IndexerConnectionDiscovery = (
  backend: 'prowlarr' | 'jackett',
  credential: NonNullable<ProviderCredentials['indexers']>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<readonly PublicIndexerConnectionStatus[]>;

export const createIndexerConnectionDiscovery = (options: {
  endpointPolicy: IndexerEndpointPolicy;
}): IndexerConnectionDiscovery => {
  return async (backendType, credential, timeoutMs, signal) => {
    try {
      options.endpointPolicy.assertAllowed(credential.endpoint);
    } catch (error) {
      throw new ApplicationError('InvalidConfiguration', { cause: error });
    }
    try {
      const backend =
        backendType === 'prowlarr'
          ? createProwlarrBackend({
              baseUrl: credential.endpoint,
              apiKey: credential.apiKey,
              timeoutMs,
            })
          : createJackettBackend({
              baseUrl: credential.endpoint,
              apiKey: credential.apiKey,
              timeoutMs,
            });
      const context = signal === undefined ? {} : { signal };
      const discovered = (await backend.discover(context))
        .filter(isEligiblePublicTorrentIndexer)
        .slice(0, 20);
      const statuses: PublicIndexerConnectionStatus[] = [];
      for (let offset = 0; offset < discovered.length; offset += 3) {
        const batch = discovered.slice(offset, offset + 3);
        const settled = await Promise.allSettled(
          batch.map(async (indexer): Promise<PublicIndexerConnectionStatus> => {
            const capabilities = await backend.capabilities(indexer.backendId, context);
            return {
              id: indexer.backendId,
              name: indexer.name,
              status: 'available',
              capabilities: {
                movie: capabilities.modes.movie.available,
                series: capabilities.modes.tvsearch.available,
                generic: capabilities.modes.search.available,
              },
            };
          }),
        );
        for (let index = 0; index < settled.length; index += 1) {
          const result = settled[index];
          const indexer = batch[index];
          if (result?.status === 'fulfilled') statuses.push(result.value);
          else if (indexer !== undefined) {
            statuses.push({
              id: indexer.backendId,
              name: indexer.name,
              status: 'capabilities-unavailable',
            });
          }
        }
      }
      return statuses;
    } catch (error) {
      signal?.throwIfAborted();
      throw classifyApplicationError(error, 'ProviderUnavailable');
    }
  };
};

export const testProviderConnection: ProviderConnectionTester = async (
  provider,
  credential,
  timeoutMs,
  signal,
) => {
  try {
    if (provider === 'tmdb' && 'accessToken' in credential) {
      await createTmdbClient({
        accessToken: credential.accessToken,
        timeoutMs,
      }).validateAuthentication(signal);
      return;
    }
    if (provider === 'torbox' && 'apiKey' in credential) {
      await createTorboxApiClient({ apiKey: credential.apiKey, timeoutMs }).validateAuthentication(
        signal,
      );
      return;
    }
    if (provider === 'webshare' && 'username' in credential) {
      const api = createWebshareApiClient({ timeoutMs });
      await createWebshareCredentialService(api, credential).getSessionToken(signal);
      return;
    }
    if (provider === 'sktorrent' && 'username' in credential) {
      const source = createSktorrentSource(credential, { timeoutMs });
      if (source.validateAuthentication === undefined) {
        throw new TypeError('SKTorrent authentication test is unavailable');
      }
      await source.validateAuthentication(signal);
      return;
    }
    throw new TypeError('Credential does not match provider');
  } catch (error) {
    signal?.throwIfAborted();
    throw classifyApplicationError(error, 'ProviderUnavailable');
  }
};
