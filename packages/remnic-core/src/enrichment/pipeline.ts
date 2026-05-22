/**
 * Enrichment pipeline orchestrator (issue #365).
 *
 * For each entity, determines the importance tier, resolves the providers
 * to run, executes them in sequence (respecting rate limits), tags
 * candidates, and caps at `maxCandidatesPerEntity`.
 *
 * Accepted candidates are returned in each `EnrichmentResult` via the
 * `acceptedCandidates` field so that callers can persist them.
 */

import type { LoggerBackend } from "../logger.js";
import type { EnrichmentProviderRegistry } from "./provider-registry.js";
import type {
  EnrichmentCandidate,
  EnrichmentPipelineConfig,
  EnrichmentProvider,
  EnrichmentResult,
  EntityEnrichmentInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Rate-limit tracking
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  minuteCount: number;
  minuteReset: number;
  dayCount: number;
  dayReset: number;
}

const rateBuckets = new Map<string, RateLimitBucket>();

function isRateLimited(
  provider: EnrichmentProvider,
  config: EnrichmentPipelineConfig,
): boolean {
  const providerCfg = config.providers.find((p) => p.id === provider.id);
  if (!providerCfg?.rateLimit) return false;

  const now = Date.now();
  let bucket = rateBuckets.get(provider.id);
  if (!bucket) {
    bucket = {
      minuteCount: 0,
      minuteReset: now + 60_000,
      dayCount: 0,
      dayReset: now + 86_400_000,
    };
    rateBuckets.set(provider.id, bucket);
  }

  // Reset windows if expired
  if (now >= bucket.minuteReset) {
    bucket.minuteCount = 0;
    bucket.minuteReset = now + 60_000;
  }
  if (now >= bucket.dayReset) {
    bucket.dayCount = 0;
    bucket.dayReset = now + 86_400_000;
  }

  const { maxPerMinute, maxPerDay } = providerCfg.rateLimit;
  return bucket.minuteCount >= maxPerMinute || bucket.dayCount >= maxPerDay;
}

function recordCall(
  providerId: string,
): void {
  const bucket = rateBuckets.get(providerId);
  if (bucket) {
    bucket.minuteCount += 1;
    bucket.dayCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runEnrichmentPipeline(
  entities: EntityEnrichmentInput[],
  registry: EnrichmentProviderRegistry,
  config: EnrichmentPipelineConfig,
  log: LoggerBackend,
): Promise<EnrichmentResult[]> {
  if (!config.enabled) return [];
  if (entities.length === 0) return [];

  const results: EnrichmentResult[] = [];

  for (const entity of entities) {
    const providers = registry.getForImportance(entity.importanceLevel, config);
    const maxCandidates = config.maxCandidatesPerEntity;
    const hasPositiveCandidateBudget = maxCandidates > 0;
    let remainingCandidateBudget = hasPositiveCandidateBudget
      ? maxCandidates
      : Number.POSITIVE_INFINITY;

    for (const provider of providers) {
      if (hasPositiveCandidateBudget && remainingCandidateBudget <= 0) {
        break;
      }

      const start = Date.now();

      // Check availability
      let available: boolean;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }

      if (!available) {
        log.debug?.(
          `enrichment: skipping provider ${provider.id} for ${entity.name} — unavailable`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          acceptedCandidates: [],
          elapsed: Date.now() - start,
        });
        continue;
      }

      // Check rate limit
      if (isRateLimited(provider, config)) {
        log.debug?.(
          `enrichment: skipping provider ${provider.id} for ${entity.name} — rate limited`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          acceptedCandidates: [],
          elapsed: Date.now() - start,
        });
        continue;
      }

      // Run provider.
      // Count every attempt toward rate-limit buckets — including failures —
      // because the provider may have consumed external quota before throwing
      // (PR #425 review finding 2).
      let candidates: EnrichmentCandidate[];
      try {
        candidates = await provider.enrich(entity);
      } catch (err) {
        recordCall(provider.id);
        log.error?.(
          `enrichment: provider ${provider.id} failed for ${entity.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          acceptedCandidates: [],
          elapsed: Date.now() - start,
        });
        continue;
      }
      recordCall(provider.id);

      // Tag each candidate with provider id
      for (const candidate of candidates) {
        candidate.source = provider.id;
      }

      // Cap at maxCandidatesPerEntity across all providers for this entity.
      // 0 means "accept none"; undefined/negative means "no cap".
      let accepted: EnrichmentCandidate[];
      if (maxCandidates === 0) {
        accepted = [];
      } else if (hasPositiveCandidateBudget) {
        accepted = candidates.slice(0, remainingCandidateBudget);
        remainingCandidateBudget -= accepted.length;
      } else {
        accepted = candidates;
      }
      const rejected = candidates.length - accepted.length;

      results.push({
        entityName: entity.name,
        provider: provider.id,
        candidatesFound: candidates.length,
        candidatesAccepted: accepted.length,
        candidatesRejected: rejected,
        acceptedCandidates: accepted,
        elapsed: Date.now() - start,
      });
    }
  }

  return results;
}
