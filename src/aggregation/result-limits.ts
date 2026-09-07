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
  const maximumTotal = Math.min(limits.total, maximumTotalResults);
  if (maximumTotal === 0) return [];

  const selected = new Set<number>();
  const resolutionCounts: Partial<Record<Resolution, number>> = {};
  const providers = rankedResults
    .map(({ result }) => result.provider)
    .filter((provider, index, values) => values.indexOf(provider) === index);

  if (providers.length <= maximumTotal) {
    for (const provider of [...providers].reverse()) {
      const index = rankedResults.findIndex(
        (ranked, candidateIndex) =>
          !selected.has(candidateIndex) &&
          ranked.result.provider === provider &&
          canAdd(ranked, limits, resolutionCounts),
      );
      const candidate = rankedResults[index];
      if (index >= 0 && candidate !== undefined) add(index, candidate, selected, resolutionCounts);
    }
  }

  for (const [index, candidate] of rankedResults.entries()) {
    if (selected.size >= maximumTotal) break;
    if (selected.has(index) || !canAdd(candidate, limits, resolutionCounts)) continue;
    add(index, candidate, selected, resolutionCounts);
  }

  return rankedResults.filter((_, index) => selected.has(index));
}

function canAdd(
  candidate: RankedResult,
  limits: UserConfiguration['limits'],
  resolutionCounts: Readonly<Partial<Record<Resolution, number>>>,
): boolean {
  const resolution = candidate.result.parsed?.resolution ?? 'unknown';
  const maximum = limits.perResolution[resolution];
  return maximum === undefined || (resolutionCounts[resolution] ?? 0) < maximum;
}

function add(
  index: number,
  candidate: RankedResult,
  selected: Set<number>,
  resolutionCounts: Partial<Record<Resolution, number>>,
): void {
  selected.add(index);
  const resolution = candidate.result.parsed?.resolution ?? 'unknown';
  resolutionCounts[resolution] = (resolutionCounts[resolution] ?? 0) + 1;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
