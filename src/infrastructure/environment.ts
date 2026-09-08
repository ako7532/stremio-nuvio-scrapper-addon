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

const booleanFlagSchema = z
  .enum(['true', 'false', 'True', 'False'])
  .default('false')
  .transform((value) => value.toLowerCase() === 'true');

const optionalServerSecretSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(1_024).optional(),
);

const indexerEndpointSchema = z
  .url()
  .max(2_048)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Indexer endpoint must use HTTP or HTTPS',
  })
  .refine((value) => {
    const endpoint = new URL(value);
    return (
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.search === '' &&
      endpoint.hash === ''
    );
  }, 'Indexer endpoint must not contain credentials, a query, or a fragment');

const indexerIdsSchema = z
  .string()
  .default('[]')
  .transform((value, context) => {
    try {
      return z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z\d._-]+$/u),
        )
        .max(20)
        .refine((ids) => new Set(ids).size === ids.length, 'Indexer IDs must be unique')
        .parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({ code: 'custom', message: 'Indexer IDs must be a JSON string array' });
      return z.NEVER;
    }
  });

const environmentSchema = z
  .object({
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(7_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    ADDON_BASE_URL: addonBaseUrlSchema.default('http://127.0.0.1:7000'),
    CONFIG_DATABASE_PATH: z.string().min(1).default('addon.sqlite'),
    CONFIG_ENCRYPTION_KEY: z.string().min(1).optional(),
    SCRAPE_PROWLARR: booleanFlagSchema,
    PROWLARR_URL: indexerEndpointSchema.default('http://127.0.0.1:9696'),
    PROWLARR_API_KEY: optionalServerSecretSchema,
    PROWLARR_INDEXERS: indexerIdsSchema,
    SCRAPE_JACKETT: booleanFlagSchema,
    JACKETT_URL: indexerEndpointSchema.default('http://127.0.0.1:9117'),
    JACKETT_API_KEY: optionalServerSecretSchema,
    JACKETT_INDEXERS: indexerIdsSchema,
  })
  .superRefine((environment, context) => {
    if (environment.SCRAPE_PROWLARR && environment.PROWLARR_API_KEY === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['PROWLARR_API_KEY'],
        message: 'PROWLARR_API_KEY is required when SCRAPE_PROWLARR is enabled',
      });
    }
    if (environment.SCRAPE_JACKETT && environment.JACKETT_API_KEY === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['JACKETT_API_KEY'],
        message: 'JACKETT_API_KEY is required when SCRAPE_JACKETT is enabled',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(input);
}
