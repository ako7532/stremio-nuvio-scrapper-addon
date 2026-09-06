import type { UserConfiguration } from '../domain/configuration.js';
import type { RankedResult, Resolution } from '../domain/release.js';

export const maximumTotalResults = 100;

export function limitResults(
  rankedResults: readonly RankedResult[],
  limits: UserConfiguration['limits'],
): readonly RankedResult[] {
  assertNonNegativeInteger(limits.total, 'total result limit');
  for (const maximum of Object.values(limits.perResolution)) {
    assertNonNegativeInteger(maximum, 'per-resolution result limit');
  }
  const resolutionCounts: Partial<Record<Resolution, number>> = {};
  const limited = rankedResults.filter(({ result }) => {
    const resolution = result.parsed?.resolution ?? 'unknown';
    const maximum = limits.perResolution[resolution];
    const count = resolutionCounts[resolution] ?? 0;
    if (maximum !== undefined && count >= maximum) return false;
    resolutionCounts[resolution] = count + 1;
    return true;
  });

  return limited.slice(0, Math.min(limits.total, maximumTotalResults));
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
