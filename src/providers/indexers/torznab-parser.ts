import * as cheerio from 'cheerio';

import type {
  IndexerSearchResult,
  TorznabCapabilities,
  TorznabSearchMode,
} from './indexer-types.js';
import { resolveV1TorrentIdentity, TorrentIdentityError } from './torrent-identity.js';

export class TorznabParserError extends Error {
  override readonly name = 'TorznabParserError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export type TorznabParserLimits = {
  maximumResponseBytes?: number;
  maximumItems?: number;
};

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_ITEMS = 100;
const MAXIMUM_TEXT_LENGTH = 2_048;
const MAXIMUM_REFERENCE_LENGTH = 4_096;

export const parseTorznabCapabilities = (
  xml: string,
  limits: TorznabParserLimits = {},
): TorznabCapabilities => {
  const $ = loadXml(xml, limits.maximumResponseBytes);
  const root = rootElement($, 'caps');
  const limitsElement = root.children('limits');
  if (limitsElement.length !== 1) throw malformed('Torznab limits are missing or duplicated');
  const maximum = positiveInteger(limitsElement.attr('max'), 'maximum result limit');
  const defaultLimit = positiveInteger(limitsElement.attr('default'), 'default result limit');
  if (defaultLimit > maximum) throw malformed('Torznab default limit exceeds maximum');

  const modes = {
    search: parseMode(root, 'search'),
    movie: parseMode(root, 'movie-search'),
    tvsearch: parseMode(root, 'tv-search'),
  } satisfies Record<TorznabSearchMode, TorznabCapabilities['modes'][TorznabSearchMode]>;
  const categories = root
    .find('categories category, categories subcat')
    .toArray()
    .map((element) => positiveInteger($(element).attr('id'), 'category ID'));
  return {
    limits: { maximum, default: defaultLimit },
    modes,
    categories: [...new Set(categories)],
  };
};

export const parseTorznabResults = (
  xml: string,
  context: { indexerId: string; indexerName: string; mediaType: 'movie' | 'series' },
  limits: TorznabParserLimits = {},
): readonly IndexerSearchResult[] => {
  const $ = loadXml(xml, limits.maximumResponseBytes);
  const rss = rootElement($, 'rss');
  const channels = rss.children('channel');
  if (channels.length !== 1) throw malformed('Torznab channel is missing or duplicated');
  const items = channels.children('item').toArray();
  const maximumItems = positiveLimit(limits.maximumItems ?? DEFAULT_MAXIMUM_ITEMS, 'item limit');
  if (items.length > maximumItems) throw malformed('Torznab response contains too many items');

  return items.map((element) => {
    const item = $(element);
    const releaseName = requiredChildText(item, 'title');
    const attributes = parseAttributes($, item);
    const declaredInfoHash = singleAttribute(attributes, 'infohash');
    const attributeMagnet = singleAttribute(attributes, 'magneturl');
    const enclosure = optionalChildAttribute(item, 'enclosure', 'url', MAXIMUM_REFERENCE_LENGTH);
    const link = optionalChildText(item, 'link', MAXIMUM_REFERENCE_LENGTH);
    const magnetUri = attributeMagnet ?? [enclosure, link].find(isMagnet);
    let infoHash: string | undefined;
    try {
      infoHash = resolveV1TorrentIdentity({
        ...(declaredInfoHash === undefined ? {} : { declaredInfoHash }),
        ...(magnetUri === undefined ? {} : { magnetUri }),
      })?.infoHash;
    } catch (error) {
      if (error instanceof TorrentIdentityError) {
        throw malformed(`Torznab torrent identity is ${error.kind}`, error);
      }
      throw error;
    }
    const acquisitionReference = firstNonMagnet(enclosure, link);
    const sizeText = singleAttribute(attributes, 'size') ?? optionalChildText(item, 'size');
    const seedersText = singleAttribute(attributes, 'seeders');
    const releaseGuid = optionalChildText(item, 'guid');
    const detailsUrl = optionalChildText(item, 'comments');
    return {
      indexerId: bounded(context.indexerId, 'indexer ID'),
      indexerName: bounded(context.indexerName, 'indexer name'),
      releaseName,
      mediaType: context.mediaType,
      ...(releaseGuid === undefined ? {} : { releaseGuid }),
      ...(detailsUrl === undefined ? {} : { detailsUrl }),
      ...(acquisitionReference === undefined ? {} : { acquisitionReference }),
      ...(infoHash === undefined ? {} : { infoHash }),
      ...(magnetUri === undefined ? {} : { magnetUri }),
      ...(sizeText === undefined ? {} : { sizeBytes: nonNegativeInteger(sizeText, 'size') }),
      ...(seedersText === undefined ? {} : { seeders: nonNegativeInteger(seedersText, 'seeders') }),
    };
  });
};

const parseMode = (
  root: ReturnType<cheerio.CheerioAPI>,
  elementName: string,
): TorznabCapabilities['modes'][TorznabSearchMode] => {
  const elements = root.children('searching').children(elementName);
  if (elements.length > 1) throw malformed(`Torznab ${elementName} capability is duplicated`);
  if (elements.length === 0) return { available: false, supportedParameters: [] };
  const available = elements.attr('available')?.trim().toLowerCase() === 'yes';
  const supportedParameters = (elements.attr('supportedParams') ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z][a-z\d]*$/u.test(value));
  return { available, supportedParameters: [...new Set(supportedParameters)] };
};

const loadXml = (xml: string, maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES) => {
  const maximum = positiveLimit(maximumResponseBytes, 'response size limit');
  if (Buffer.byteLength(xml, 'utf8') > maximum) throw malformed('Torznab response is too large');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw malformed('Torznab declarations are not allowed');
  try {
    return cheerio.load(xml, { xmlMode: true });
  } catch (error) {
    throw malformed('Torznab returned malformed XML', error);
  }
};

const rootElement = ($: cheerio.CheerioAPI, name: string) => {
  const roots = $.root().children(name);
  if (roots.length !== 1 || $.root().children().length !== 1) {
    throw malformed(`Torznab ${name} root is missing or duplicated`);
  }
  return roots;
};

const parseAttributes = (
  $: cheerio.CheerioAPI,
  item: ReturnType<cheerio.CheerioAPI>,
): ReadonlyMap<string, readonly string[]> => {
  const attributes = new Map<string, string[]>();
  for (const element of item.children().toArray()) {
    const name =
      'name' in element && typeof element.name === 'string' ? element.name.toLowerCase() : '';
    if (name !== 'torznab:attr' && name !== 'newznab:attr') continue;
    const node = $(element);
    const attributeName = node.attr('name')?.trim().toLowerCase();
    const value = node.attr('value')?.trim();
    if (
      attributeName === undefined ||
      attributeName.length === 0 ||
      value === undefined ||
      value.length === 0
    )
      continue;
    if (attributeName.length > 100 || value.length > MAXIMUM_TEXT_LENGTH) {
      throw malformed('Torznab attribute exceeds its limit');
    }
    const existing = attributes.get(attributeName) ?? [];
    existing.push(value);
    attributes.set(attributeName, existing);
  }
  return attributes;
};

const singleAttribute = (
  attributes: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | undefined => {
  const values = attributes.get(name);
  if (values === undefined) return undefined;
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw malformed(`Torznab ${name} attribute conflicts`);
  return unique[0];
};

const requiredChildText = (node: ReturnType<cheerio.CheerioAPI>, selector: string): string => {
  const value = optionalChildText(node, selector);
  if (value === undefined) throw malformed(`Torznab ${selector} is missing`);
  return value;
};

const optionalChildText = (
  node: ReturnType<cheerio.CheerioAPI>,
  selector: string,
  maximumLength = MAXIMUM_TEXT_LENGTH,
): string | undefined => {
  const children = node.children(selector);
  if (children.length > 1) throw malformed(`Torznab ${selector} is duplicated`);
  if (children.length === 0) return undefined;
  const value = children.text().trim();
  return value.length === 0 ? undefined : bounded(value, selector, maximumLength);
};

const optionalChildAttribute = (
  node: ReturnType<cheerio.CheerioAPI>,
  selector: string,
  attribute: string,
  maximumLength = MAXIMUM_TEXT_LENGTH,
): string | undefined => {
  const children = node.children(selector);
  if (children.length > 1) throw malformed(`Torznab ${selector} is duplicated`);
  const value = children.attr(attribute)?.trim();
  return value === undefined || value.length === 0
    ? undefined
    : bounded(value, selector, maximumLength);
};

const bounded = (value: string, name: string, maximumLength = MAXIMUM_TEXT_LENGTH): string => {
  if (value.length > maximumLength) throw malformed(`Torznab ${name} exceeds its limit`);
  return value;
};

const isMagnet = (value: string | undefined): value is string =>
  value?.toLowerCase().startsWith('magnet:?') === true;

const firstNonMagnet = (...values: readonly (string | undefined)[]): string | undefined => {
  for (const value of values) {
    if (value !== undefined && !isMagnet(value)) return value;
  }
  return undefined;
};

const positiveInteger = (value: string | undefined, name: string): number => {
  if (value === undefined || !/^\d+$/u.test(value)) throw malformed(`Torznab ${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw malformed(`Torznab ${name} is invalid`);
  return parsed;
};

const nonNegativeInteger = (value: string, name: string): number => {
  if (!/^\d+$/u.test(value)) throw malformed(`Torznab ${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw malformed(`Torznab ${name} is invalid`);
  return parsed;
};

const positiveLimit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
};

const malformed = (message: string, cause?: unknown): TorznabParserError =>
  new TorznabParserError(message, cause === undefined ? undefined : { cause });
