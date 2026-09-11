import { z } from 'zod';

const addonBaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  return (
    (url.protocol === 'https:' || localHttp) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}, 'ADDON_BASE_URL must use HTTPS (or local HTTP) without credentials, query, or fragment');

const environmentSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(7_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  ADDON_BASE_URL: addonBaseUrlSchema.default('http://127.0.0.1:7000'),
  CONFIG_DATABASE_PATH: z.string().min(1).default('addon.sqlite'),
  CONFIG_ENCRYPTION_KEY: z.string().min(1).optional(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(input);
}
