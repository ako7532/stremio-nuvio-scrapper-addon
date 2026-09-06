import type { ProviderCredentials, UserConfiguration } from '../domain/configuration.js';

export type StoredConfiguration = {
  id: string;
  configuration: UserConfiguration;
  credentials: ProviderCredentials;
  createdAt: string;
  updatedAt: string;
};

export type ConfigurationStore = {
  get(id: string): Promise<StoredConfiguration | undefined>;
  save(value: StoredConfiguration): Promise<void>;
  delete(id: string): Promise<boolean>;
  close?(): void;
};
