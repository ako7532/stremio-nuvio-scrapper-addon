import { createHmac } from 'node:crypto';

import { createConfigurationService } from './application/configuration-service.js';
import { createProductionIntegration } from './application/production-integration.js';
import type { SearchObserver } from './application/search-observability.js';
import { testProviderConnection } from './application/provider-connection-tester.js';
import { createCredentialCipher } from './infrastructure/credential-cipher.js';
import { parseEnvironment } from './infrastructure/environment.js';
import { installGracefulShutdown } from './infrastructure/graceful-shutdown.js';
import { createSearchLogObserver } from './infrastructure/search-logger.js';
import { createSqliteConfigurationStore } from './infrastructure/sqlite-configuration-store.js';
import { buildServer } from './http/server.js';
import { createIndexerEndpointPolicy } from './security/indexer-endpoint-policy.js';
import type { ServerIndexerConfiguration } from './providers/indexers/server-indexer-configuration.js';

const environment = parseEnvironment(process.env);
if (environment.CONFIG_ENCRYPTION_KEY === undefined) {
  throw new Error('CONFIG_ENCRYPTION_KEY is required');
}
const store = createSqliteConfigurationStore(
  environment.CONFIG_DATABASE_PATH,
  createCredentialCipher(environment.CONFIG_ENCRYPTION_KEY),
);
const indexers: ServerIndexerConfiguration[] = [];
if (environment.SCRAPE_PROWLARR && environment.PROWLARR_API_KEY !== undefined) {
  indexers.push({
    backend: 'prowlarr',
    endpoint: environment.PROWLARR_URL,
    apiKey: environment.PROWLARR_API_KEY,
    selectedIndexerIds: environment.PROWLARR_INDEXERS,
  });
}
if (environment.SCRAPE_JACKETT && environment.JACKETT_API_KEY !== undefined) {
  indexers.push({
    backend: 'jackett',
    endpoint: environment.JACKETT_URL,
    apiKey: environment.JACKETT_API_KEY,
    selectedIndexerIds: environment.JACKETT_INDEXERS,
  });
}
const indexerEndpointPolicy = createIndexerEndpointPolicy(
  indexers.map(({ endpoint }) => new URL(endpoint).origin),
);
const configurationService = createConfigurationService(store);
const playbackSecret = createHmac('sha256', environment.CONFIG_ENCRYPTION_KEY)
  .update('stremio-nuvio-addon/playback-token/v1')
  .digest();
const searchObserver: { current?: SearchObserver } = {};
const integration = createProductionIntegration({
  configurationService,
  baseUrl: environment.ADDON_BASE_URL,
  playbackSecret,
  observer: (event) => searchObserver.current?.(event),
  indexerEndpointPolicy,
  indexers,
});
const server = buildServer({
  logger: true,
  logLevel: environment.LOG_LEVEL,
  configurationService,
  searchStreamsForConfiguration: (configuration) =>
    integration.searchStreamsForConfiguration(configuration),
  torboxPlaybackResolver: integration.playbackResolver,
  invalidateConfigurationRuntime: (configId) => {
    integration.invalidate(configId);
  },
  providerConnectionTester: testProviderConnection,
  publicBaseUrl: environment.ADDON_BASE_URL,
  trustProxy: environment.TRUST_PROXY,
});
searchObserver.current = createSearchLogObserver(server.log);
server.addHook('onClose', () => store.close?.());
installGracefulShutdown(server, { timeoutMs: environment.SHUTDOWN_TIMEOUT_MS });

try {
  await server.listen({ host: environment.HOST, port: environment.PORT });
} catch {
  server.log.error({ category: 'StartupFailed' }, 'server startup failed');
  await server.close().catch(() => undefined);
  process.exitCode = 1;
}
