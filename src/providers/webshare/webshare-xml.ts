import * as cheerio from 'cheerio';
import { z } from 'zod';

import type {
  WebshareAvailability,
  WebshareFileInfo,
  WebshareSearchResult,
} from './webshare-types.js';
import { normalizeWebshareFileId, normalizeWebsharePlaybackUrl } from './webshare-urls.js';

export type WebshareApiErrorKind = 'api' | 'authentication' | 'malformed-response';

export class WebshareApiError extends Error {
  override readonly name = 'WebshareApiError';

  constructor(
    readonly kind: WebshareApiErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const nonNegativeInteger = z.coerce.number().int().nonnegative();
const positiveInteger = z.coerce.number().int().positive();
const flag = z.enum(['0', '1']).transform((value) => value === '1');

export const parseWebshareSearch = (xml: string): readonly WebshareSearchResult[] => {
  const $ = loadResponse(xml);
  assertSuccess($);
  parseField(nonNegativeInteger, requiredText($, 'response > total'), 'total');
  return $('response > file')
    .toArray()
    .map((element) => {
      const file = $(element);
      return {
        id: normalizeWebshareFileId(requiredChildText(file, 'ident')),
        name: requiredChildText(file, 'name'),
        type: requiredChildText(file, 'type').toLowerCase(),
        sizeBytes: parseField(positiveInteger, requiredChildText(file, 'size'), 'file size'),
        passwordProtected: parseField(flag, requiredChildText(file, 'password'), 'file password'),
      };
    });
};

export const parseWebshareFileInfo = (xml: string, id: string): WebshareFileInfo => {
  const $ = loadResponse(xml);
  assertSuccess($);
  return {
    id: normalizeWebshareFileId(id),
    name: requiredText($, 'response > name'),
    type: requiredText($, 'response > type').toLowerCase(),
    sizeBytes: parseField(positiveInteger, requiredText($, 'response > size'), 'file size'),
    available: parseField(flag, requiredText($, 'response > available'), 'availability'),
    passwordProtected: parseField(
      flag,
      requiredText($, 'response > password'),
      'password protection',
    ),
    removed: parseField(flag, requiredText($, 'response > removed'), 'removal state'),
    copyrighted: parseField(flag, requiredText($, 'response > copyrighted'), 'copyright state'),
  };
};

export const parseWebshareAvailability = (xml: string): WebshareAvailability => {
  const $ = loadResponse(xml);
  assertSuccess($);
  return {
    exists: parseField(flag, requiredText($, 'response > exists'), 'existence'),
    downloadable: parseField(flag, requiredText($, 'response > downloadable'), 'downloadability'),
  };
};

export const parseWebshareSalt = (xml: string): string => parseScalar(xml, 'salt', true);
export const parseWebshareToken = (xml: string): string => parseScalar(xml, 'token', true);
export const parseWebsharePlaybackLink = (xml: string): string =>
  normalizeWebsharePlaybackUrl(parseScalar(xml, 'link', false));

const parseScalar = (xml: string, field: string, authentication: boolean): string => {
  const $ = loadResponse(xml);
  assertSuccess($, authentication);
  return requiredText($, `response > ${field}`);
};

const loadResponse = (xml: string): cheerio.CheerioAPI => {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw malformed('Webshare XML declarations are not allowed');
  }
  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    if ($('response').length !== 1 || $.root().children('response').length !== 1) {
      throw malformed('Webshare response root is missing or duplicated');
    }
    return $;
  } catch (error) {
    if (error instanceof WebshareApiError) {
      throw error;
    }
    throw malformed('Webshare returned malformed XML');
  }
};

const assertSuccess = ($: cheerio.CheerioAPI, authentication = false): void => {
  const status = requiredText($, 'response > status');
  if (status === 'OK') {
    return;
  }
  const code = optionalText($, 'response > code');
  const message = optionalText($, 'response > message') ?? 'Webshare API request failed';
  throw new WebshareApiError(authentication ? 'authentication' : 'api', message, code);
};

const requiredText = ($: cheerio.CheerioAPI, selector: string): string => {
  const nodes = $(selector);
  if (nodes.length !== 1) {
    throw malformed(`Webshare response field ${selector} is missing or duplicated`);
  }
  const value = nodes.text().trim();
  if (value.length === 0) {
    throw malformed(`Webshare response field ${selector} is empty`);
  }
  return value;
};

const requiredChildText = (node: ReturnType<cheerio.CheerioAPI>, selector: string): string => {
  const child = node.children(selector);
  if (child.length !== 1 || child.text().trim().length === 0) {
    throw malformed(`Webshare file field ${selector} is missing, duplicated, or empty`);
  }
  return child.text().trim();
};

const optionalText = ($: cheerio.CheerioAPI, selector: string): string | undefined => {
  const value = $(selector).first().text().trim();
  return value.length === 0 ? undefined : value;
};

const parseField = <Output>(schema: z.ZodType<Output>, value: string, name: string): Output => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw malformed(`Webshare response field ${name} is invalid`);
  }
  return result.data;
};

const malformed = (message: string): WebshareApiError =>
  new WebshareApiError('malformed-response', message);
