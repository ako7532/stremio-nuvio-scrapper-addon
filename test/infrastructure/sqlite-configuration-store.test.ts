import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { createConfigurationService } from '../../src/application/configuration-service.js';
import type { StoredConfiguration } from '../../src/application/configuration-store.js';
import { defaultConfiguration } from '../../src/domain/configuration-defaults.js';
import { createCredentialCipher } from '../../src/infrastructure/credential-cipher.js';
import { createSqliteConfigurationStore } from '../../src/infrastructure/sqlite-configuration-store.js';

describe('SQLite configuration store', () => {
  it('persists settings while encrypting provider credentials at rest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'czsk-config-test-'));
    const filename = join(directory, 'config.sqlite');
    const cipher = createCredentialCipher(randomBytes(32).toString('base64'));
    const store = createSqliteConfigurationStore(filename, cipher);
    const value: StoredConfiguration = {
      id: 'opaque-configuration-id-fixture',
      configuration: defaultConfiguration(),
      credentials: {
        torbox: { apiKey: 'database-private-key' },
        indexers: {
          endpoint: 'https://indexers.internal.invalid/base',
          apiKey: 'database-indexers-private-key',
        },
      },
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    };

    await store.save(value);

    await expect(store.get(value.id)).resolves.toEqual(value);
    store.close?.();
    const database = new DatabaseSync(filename, { readOnly: true });
    const row = database
      .prepare('SELECT configuration_json, encrypted_credentials FROM configurations WHERE id = ?')
      .get(value.id) as { configuration_json: string; encrypted_credentials: string };
    expect(row.configuration_json).not.toContain('database-private-key');
    expect(row.encrypted_credentials).not.toContain('database-private-key');
    expect(row.configuration_json).not.toContain('indexers.internal.invalid');
    expect(row.encrypted_credentials).not.toContain('indexers.internal.invalid');
    expect(row.encrypted_credentials).not.toContain('database-indexers-private-key');
    expect(row.encrypted_credentials).toMatch(/^v1\./u);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('normalizes a legacy SQLite configuration without rewriting the stored row', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'czsk-legacy-config-test-'));
    const filename = join(directory, 'config.sqlite');
    const cipher = createCredentialCipher(randomBytes(32).toString('base64'));
    const store = createSqliteConfigurationStore(filename, cipher);
    const configuration = defaultConfiguration();
    delete configuration.providers.indexers;
    const legacy: StoredConfiguration = {
      id: 'legacy-sqlite-configuration-fixture',
      configuration,
      credentials: {},
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    };
    await store.save(legacy);

    await expect(createConfigurationService(store).getStored(legacy.id)).resolves.toMatchObject({
      configuration: {
        providers: {
          indexers: { enabled: false, backend: 'prowlarr', selectedIndexerIds: [] },
        },
      },
    });

    store.close?.();
    const database = new DatabaseSync(filename, { readOnly: true });
    const row = database
      .prepare('SELECT configuration_json FROM configurations WHERE id = ?')
      .get(legacy.id) as { configuration_json: string };
    expect(row.configuration_json).not.toContain('indexers');
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
