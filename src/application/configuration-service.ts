import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import type {
  CredentialProvider,
  ProviderCredentials,
  UserConfiguration,
} from '../domain/configuration.js';
import { rankingFactors } from '../domain/configuration.js';
import { dynamicRanges, resolutions, sourceTypes, videoCodecs } from '../domain/release.js';
import type { IndexerEndpointPolicy } from '../security/indexer-endpoint-policy.js';
import { ApplicationError } from './application-error.js';
import type { ConfigurationStore, StoredConfiguration } from './configuration-store.js';

const languagePreferencesSchema = z.strictObject({
  preferred: z.array(z.string().trim().min(2).max(16)).max(20),
  allowed: z.array(z.string().trim().min(2).max(16)).max(20),
  excluded: z.array(z.string().trim().min(2).max(16)).max(20),
});
const defaultIndexersConfiguration = {
  enabled: false,
  backend: 'prowlarr' as const,
  selectedIndexerIds: [] as string[],
};
const indexersConfigurationSchema = z.strictObject({
  enabled: z.boolean(),
  backend: z.enum(['prowlarr', 'jackett']),
  selectedIndexerIds: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z\d._-]+$/u),
    )
    .max(20),
});
const configurationSchema = z
  .strictObject({
    general: z.strictObject({ metadataLanguage: z.string().trim().min(2).max(16) }).optional(),
    providers: z.strictObject({
      sktorrent: z.strictObject({
        enabled: z.boolean(),
        playbackMode: z.enum(['direct-torrent', 'torbox-only']),
      }),
      webshare: z.strictObject({ enabled: z.boolean() }),
      indexers: indexersConfigurationSchema.default(defaultIndexersConfiguration),
    }),
    filters: z.strictObject({
      resolutions: z.array(z.enum(resolutions)).max(resolutions.length),
      sources: z.array(z.enum(sourceTypes)).max(sourceTypes.length),
      videoCodecs: z.array(z.enum(videoCodecs)).max(videoCodecs.length),
      dynamicRanges: z.array(z.enum(dynamicRanges)).max(dynamicRanges.length),
      minimumSizeBytes: z.number().int().nonnegative().optional(),
      maximumSizeBytes: z.number().int().positive().optional(),
      minimumSeeders: z.number().int().nonnegative().max(1_000_000),
      includeTerms: z.array(z.string().trim().min(1).max(100)).max(50),
      excludeTerms: z.array(z.string().trim().min(1).max(100)).max(50),
    }),
    languages: z.strictObject({
      mode: z.enum(['strict', 'fallback']),
      audio: languagePreferencesSchema,
      subtitles: languagePreferencesSchema,
    }),
    ranking: z.array(z.enum(rankingFactors)).min(1).max(rankingFactors.length),
    limits: z.strictObject({
      total: z.number().int().min(1).max(100),
      perResolution: z.partialRecord(z.enum(resolutions), z.number().int().nonnegative().max(100)),
    }),
    torbox: z.strictObject({
      showUncached: z.boolean(),
      precacheCount: z.number().int().min(0).max(10),
      precacheLimits: z
        .strictObject({
          minimumMatchScore: z.number().min(0).max(100).optional(),
          minimumSeeders: z.number().int().nonnegative().max(1_000_000).optional(),
          maximumTorrentSizeBytes: z.number().int().positive().optional(),
          maximumTotalSizeBytes: z.number().int().positive().optional(),
          allowedResolutions: z.array(z.enum(resolutions)).max(resolutions.length).optional(),
          preferredLanguagesOnly: z.boolean().optional(),
        })
        .optional(),
    }),
    display: z.strictObject({ mode: z.enum(['compact', 'detailed']) }),
    advanced: z
      .strictObject({
        providerTimeoutMs: z.number().int().min(1_000).max(60_000),
        safeDebug: z.boolean(),
      })
      .optional(),
  })
  .superRefine((configuration, context) => {
    if (new Set(configuration.ranking).size !== configuration.ranking.length) {
      context.addIssue({
        code: 'custom',
        message: 'Ranking factors must be unique',
        path: ['ranking'],
      });
    }
    if (
      new Set(configuration.providers.indexers.selectedIndexerIds).size !==
      configuration.providers.indexers.selectedIndexerIds.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Selected indexer IDs must be unique',
        path: ['providers', 'indexers', 'selectedIndexerIds'],
      });
    }
    if (
      configuration.filters.minimumSizeBytes !== undefined &&
      configuration.filters.maximumSizeBytes !== undefined &&
      configuration.filters.minimumSizeBytes > configuration.filters.maximumSizeBytes
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Minimum size must not exceed maximum size',
        path: ['filters', 'minimumSizeBytes'],
      });
    }
  });

const sktorrentCredentialSchema = z.strictObject({
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1_024),
});
const webshareCredentialSchema = sktorrentCredentialSchema;
const torboxCredentialSchema = z.strictObject({ apiKey: z.string().trim().min(1).max(1_024) });
const tmdbCredentialSchema = z.strictObject({
  accessToken: z.string().trim().min(1).max(2_048),
});
const indexersCredentialSchema = z.strictObject({
  endpoint: z
    .url()
    .max(2_048)
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'Indexer endpoint must use HTTP or HTTPS',
    })
    .refine((value) => {
      const endpoint = new URL(value);
      return endpoint.username === '' && endpoint.password === '' && endpoint.hash === '';
    }, 'Indexer endpoint must not contain credentials or a fragment'),
  apiKey: z.string().trim().min(1).max(1_024),
});
const credentialChangesSchema = z.strictObject({
  tmdb: tmdbCredentialSchema.nullable().optional(),
  sktorrent: sktorrentCredentialSchema.nullable().optional(),
  webshare: webshareCredentialSchema.nullable().optional(),
  torbox: torboxCredentialSchema.nullable().optional(),
  indexers: indexersCredentialSchema.nullable().optional(),
});
const saveSchema = z.strictObject({
  configuration: configurationSchema,
  credentials: credentialChangesSchema.default({}),
});

export type CredentialStatus = { configured: boolean; masked?: string };
export type PublicConfiguration = {
  id: string;
  configuration: UserConfiguration;
  credentials: Record<CredentialProvider, CredentialStatus>;
  manifestUrl: string;
  createdAt: string;
  updatedAt: string;
};
export type ConfigurationService = {
  create(input: unknown, baseUrl: string): Promise<PublicConfiguration>;
  get(id: string, baseUrl: string): Promise<PublicConfiguration | undefined>;
  update(id: string, input: unknown, baseUrl: string): Promise<PublicConfiguration | undefined>;
  revoke(id: string): Promise<boolean>;
  getStored(id: string): Promise<StoredConfiguration | undefined>;
};

export function createConfigurationService(
  store: ConfigurationStore,
  options: { indexerEndpointPolicy?: IndexerEndpointPolicy } = {},
): ConfigurationService {
  return {
    async create(input, baseUrl) {
      const parsed = saveSchema.parse(input);
      const credentials = applyCredentialChanges({}, parsed.credentials);
      validateIndexerConfiguration(
        parsed.configuration as UserConfiguration,
        credentials,
        options.indexerEndpointPolicy,
      );
      const now = new Date().toISOString();
      const stored: StoredConfiguration = {
        id: randomBytes(24).toString('base64url'),
        configuration: parsed.configuration as UserConfiguration,
        credentials,
        createdAt: now,
        updatedAt: now,
      };
      await store.save(stored);
      return toPublic(stored, baseUrl);
    },
    async update(id, input, baseUrl) {
      const storedPrevious = await store.get(id);
      if (storedPrevious === undefined) return undefined;
      const previous = normalizeStoredConfiguration(storedPrevious);
      const parsed = saveSchema.parse(input);
      const credentials = applyCredentialChanges(previous.credentials, parsed.credentials);
      validateIndexerConfiguration(
        parsed.configuration as UserConfiguration,
        credentials,
        options.indexerEndpointPolicy,
      );
      const stored: StoredConfiguration = {
        ...previous,
        configuration: parsed.configuration as UserConfiguration,
        credentials,
        updatedAt: new Date().toISOString(),
      };
      await store.save(stored);
      return toPublic(stored, baseUrl);
    },
    get(id, baseUrl) {
      return store
        .get(id)
        .then((stored) =>
          stored === undefined
            ? undefined
            : toPublic(normalizeStoredConfiguration(stored), baseUrl),
        );
    },
    revoke(id) {
      return store.delete(id);
    },
    async getStored(id) {
      const stored = await store.get(id);
      return stored === undefined ? undefined : normalizeStoredConfiguration(stored);
    },
  };
}

function validateIndexerConfiguration(
  configuration: UserConfiguration,
  credentials: ProviderCredentials,
  endpointPolicy: IndexerEndpointPolicy | undefined,
): void {
  const indexersCredential = credentials.indexers;
  if (indexersCredential !== undefined) {
    try {
      endpointPolicy?.assertAllowed(indexersCredential.endpoint);
      if (endpointPolicy === undefined) {
        throw new TypeError('Indexers endpoint policy is not configured');
      }
    } catch (error) {
      throw new ApplicationError('InvalidConfiguration', { cause: error });
    }
  }
  if (configuration.providers.indexers?.enabled !== true) return;
  if (
    configuration.providers.indexers.selectedIndexerIds.length === 0 ||
    indexersCredential === undefined ||
    credentials.torbox === undefined
  ) {
    throw new ApplicationError('InvalidConfiguration');
  }
}

function applyCredentialChanges(
  current: ProviderCredentials,
  changes: z.infer<typeof credentialChangesSchema>,
): ProviderCredentials {
  const next = { ...current };
  if (changes.tmdb === null) delete next.tmdb;
  else if (changes.tmdb !== undefined) next.tmdb = changes.tmdb;
  if (changes.sktorrent === null) delete next.sktorrent;
  else if (changes.sktorrent !== undefined) next.sktorrent = changes.sktorrent;
  if (changes.webshare === null) delete next.webshare;
  else if (changes.webshare !== undefined) next.webshare = changes.webshare;
  if (changes.torbox === null) delete next.torbox;
  else if (changes.torbox !== undefined) next.torbox = changes.torbox;
  if (changes.indexers === null) delete next.indexers;
  else if (changes.indexers !== undefined) next.indexers = changes.indexers;
  return next;
}

function normalizeStoredConfiguration(stored: StoredConfiguration): StoredConfiguration {
  return {
    ...stored,
    configuration: configurationSchema.parse(stored.configuration) as UserConfiguration,
  };
}

function toPublic(stored: StoredConfiguration, baseUrl: string): PublicConfiguration {
  const status = (provider: CredentialProvider): CredentialStatus => {
    const credential = stored.credentials[provider];
    if (credential === undefined) return { configured: false };
    const visible =
      'apiKey' in credential
        ? credential.apiKey.slice(-4)
        : 'accessToken' in credential
          ? credential.accessToken.slice(-4)
          : credential.username.slice(-4);
    return { configured: true, masked: `••••••••${visible}` };
  };
  return {
    id: stored.id,
    configuration: stored.configuration,
    credentials: {
      tmdb: status('tmdb'),
      sktorrent: status('sktorrent'),
      webshare: status('webshare'),
      torbox: status('torbox'),
      indexers:
        stored.credentials.indexers === undefined ? { configured: false } : { configured: true },
    },
    manifestUrl: new URL(
      `${encodeURIComponent(stored.id)}/manifest.json`,
      ensureTrailingSlash(baseUrl),
    ).toString(),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

export const parseConfigurationId = (value: string): string | undefined =>
  /^[A-Za-z\d_-]{32}$/u.test(value) ? value : undefined;
