import { createConfigurationService } from './application/configuration-service.js';
import { testProviderConnection } from './application/provider-connection-tester.js';
import { createCredentialCipher } from './infrastructure/credential-cipher.js';
import { parseEnvironment } from './infrastructure/environment.js';
import { installGracefulShutdown } from './infrastructure/graceful-shutdown.js';
import { createSqliteConfigurationStore } from './infrastructure/sqlite-configuration-store.js';
import { buildServer } from './http/server.js';

const environment = parseEnvironment(process.env);
if (environment.CONFIG_ENCRYPTION_KEY === undefined) {
  throw new Error('CONFIG_ENCRYPTION_KEY is required');
}
const store = createSqliteConfigurationStore(
  environment.CONFIG_DATABASE_PATH,
  createCredentialCipher(environment.CONFIG_ENCRYPTION_KEY),
);
const server = buildServer({
  logger: true,
  logLevel: environment.LOG_LEVEL,
  configurationService: createConfigurationService(store),
  providerConnectionTester: testProviderConnection,
  publicBaseUrl: environment.ADDON_BASE_URL,
  trustProxy: environment.TRUST_PROXY,
});
server.addHook('onClose', () => store.close?.());
installGracefulShutdown(server, { timeoutMs: environment.SHUTDOWN_TIMEOUT_MS });

try {
  await server.listen({ host: environment.HOST, port: environment.PORT });
} catch {
  server.log.error({ category: 'StartupFailed' }, 'server startup failed');
  await server.close().catch(() => undefined);
  process.exitCode = 1;
}
