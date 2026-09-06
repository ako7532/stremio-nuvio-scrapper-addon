import { DatabaseSync } from 'node:sqlite';

import type { ConfigurationStore } from '../application/configuration-store.js';
import type { UserConfiguration } from '../domain/configuration.js';
import type { CredentialCipher } from './credential-cipher.js';

type ConfigurationRow = {
  id: string;
  configuration_json: string;
  encrypted_credentials: string;
  created_at: string;
  updated_at: string;
};

export function createSqliteConfigurationStore(
  filename: string,
  cipher: CredentialCipher,
): ConfigurationStore {
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE IF NOT EXISTS configurations (
      id TEXT PRIMARY KEY,
      configuration_json TEXT NOT NULL,
      encrypted_credentials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  const getStatement = database.prepare(`
    SELECT id, configuration_json, encrypted_credentials, created_at, updated_at
    FROM configurations WHERE id = ?
  `);
  const saveStatement = database.prepare(`
    INSERT INTO configurations (id, configuration_json, encrypted_credentials, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      configuration_json = excluded.configuration_json,
      encrypted_credentials = excluded.encrypted_credentials,
      updated_at = excluded.updated_at
  `);
  const deleteStatement = database.prepare('DELETE FROM configurations WHERE id = ?');

  return {
    get(id) {
      const row = getStatement.get(id) as ConfigurationRow | undefined;
      if (row === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        id: row.id,
        configuration: JSON.parse(row.configuration_json) as UserConfiguration,
        credentials: cipher.decrypt(row.encrypted_credentials),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    },
    save(value) {
      saveStatement.run(
        value.id,
        JSON.stringify(value.configuration),
        cipher.encrypt(value.credentials),
        value.createdAt,
        value.updatedAt,
      );
      return Promise.resolve();
    },
    delete(id) {
      return Promise.resolve(deleteStatement.run(id).changes > 0);
    },
    close() {
      database.close();
    },
  };
}
