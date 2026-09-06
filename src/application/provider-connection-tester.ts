import type { CredentialProvider, ProviderCredentials } from '../domain/configuration.js';
import { createSktorrentSource } from '../providers/sktorrent/sktorrent-source.js';
import { createTorboxApiClient } from '../providers/torbox/torbox-api-client.js';
import { createWebshareApiClient } from '../providers/webshare/webshare-api-client.js';
import { createWebshareCredentialService } from '../providers/webshare/webshare-credentials.js';
import { classifyApplicationError } from './application-error.js';

export type ProviderConnectionTester = (
  provider: CredentialProvider,
  credential: NonNullable<ProviderCredentials[CredentialProvider]>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<void>;

export const testProviderConnection: ProviderConnectionTester = async (
  provider,
  credential,
  timeoutMs,
  signal,
) => {
  try {
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
