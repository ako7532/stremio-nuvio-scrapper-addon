import * as cheerio from 'cheerio';

import type { IndexerDiscoveryResult } from './indexer-types.js';
import { parseTorznabCapabilities } from './torznab-parser.js';

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_INDEXERS = 100;

export const parseJackettDiscovery = (
  xml: string,
  limits: { maximumResponseBytes?: number; maximumIndexers?: number } = {},
): readonly IndexerDiscoveryResult[] => {
  const maximumResponseBytes = positiveLimit(
    limits.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
    'response size limit',
  );
  if (Buffer.byteLength(xml, 'utf8') > maximumResponseBytes)
    throw malformed('response is too large');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw malformed('declarations are not allowed');

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch (error) {
    throw malformed('response is malformed', error);
  }
  const roots = $.root().children('indexers');
  if (roots.length !== 1 || $.root().children().length !== 1) {
    throw malformed('indexers root is missing or duplicated');
  }
  const elements = roots.children('indexer').toArray();
  const maximumIndexers = positiveLimit(
    limits.maximumIndexers ?? DEFAULT_MAXIMUM_INDEXERS,
    'indexer limit',
  );
  if (elements.length > maximumIndexers) throw malformed('response contains too many indexers');

  return elements.map((element) => {
    const node = $(element);
    const backendId = requiredBounded(node.attr('id'), 'indexer ID', 100);
    const name = requiredChild(node, 'title', 200);
    const configured = requiredBounded(node.attr('configured'), 'configured flag', 10);
    if (!/^(true|false)$/iu.test(configured)) throw malformed('configured flag is invalid');
    const privacy = parsePrivacy(requiredChild(node, 'type', 50));
    const capsElements = node.children('caps');
    if (capsElements.length !== 1) throw malformed('capabilities are missing or duplicated');
    const capabilities = parseTorznabCapabilities($.xml(capsElements[0]), {
      maximumResponseBytes,
    });
    return {
      backendId,
      name,
      enabled: configured.toLowerCase() === 'true',
      supportsSearch: Object.values(capabilities.modes).some((mode) => mode.available),
      protocol: 'torrent' as const,
      privacy,
    };
  });
};

const parsePrivacy = (value: string): IndexerDiscoveryResult['privacy'] => {
  switch (value.trim().toLowerCase()) {
    case 'public':
      return 'public';
    case 'semi-private':
    case 'semiprivate':
      return 'semi-private';
    case 'private':
      return 'private';
    default:
      return 'unknown';
  }
};

const requiredChild = (
  node: ReturnType<cheerio.CheerioAPI>,
  selector: string,
  maximumLength: number,
): string => {
  const children = node.children(selector);
  if (children.length !== 1) throw malformed(`${selector} is missing or duplicated`);
  return requiredBounded(children.text(), selector, maximumLength);
};

const requiredBounded = (
  value: string | undefined,
  name: string,
  maximumLength: number,
): string => {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0 || normalized.length > maximumLength) {
    throw malformed(`${name} is invalid`);
  }
  return normalized;
};

const positiveLimit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};

const malformed = (message: string, cause?: unknown): Error =>
  new Error(`Jackett discovery ${message}`, cause === undefined ? undefined : { cause });
