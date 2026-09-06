import { parseEnvironment } from './infrastructure/environment.js';
import { buildServer } from './http/server.js';

const environment = parseEnvironment(process.env);
const server = buildServer({ logger: true });

try {
  await server.listen({ host: environment.HOST, port: environment.PORT });
} catch (error: unknown) {
  server.log.error(error);
  process.exitCode = 1;
}
