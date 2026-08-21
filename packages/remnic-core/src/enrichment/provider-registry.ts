/**
 * Enrichment provider registry (issue #365).
 *
 * Central registry for enrichment providers. Providers register themselves
 * at startup; the pipeline queries the registry to determine which providers
 * to run for a given importance tier.
 */

import type { ImportanceLevel } from "../types.js";
import type {
  EnrichmentPipelineConfig,
  EnrichmentProvider,
} from "./types.js";

export class EnrichmentProviderRegistry {
  private readonly providers = new Map<string, EnrichmentProvider>();

  /** Register a provider. Overwrites any existing provider with the same id. */
  register(provider: EnrichmentProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Look up a single provider by id. */
  get(id: string): EnrichmentProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Return all registered providers whose id appears in the config's
   * `providers` list with `enabled: true`.
   */
  listEnabled(config: EnrichmentPipelineConfig): EnrichmentProvider[] {
    const enabledIds = new Set(
      config.providers
        .filter((p) => p.enabled)
        .map((p) => p.id),
    );
    const result: EnrichmentProvider[] = [];
    for (const [id, provider] of this.providers.entries()) {
      if (enabledIds.has(id)) {
        result.push(provider);
      }
    }
    return result;
  }

  /**
   * Return providers that should run for a given importance level.
   * Providers are resolved from `config.importanceThresholds[level]` and
   * filtered to only those that are both registered and enabled.
   */
  getForImportance(
    level: ImportanceLevel,
    config: EnrichmentPipelineConfig,
  ): EnrichmentProvider[] {
    // "trivial" entities never get enrichment providers
    if (level === "trivial") return [];

    const thresholds = config.importanceThresholds;
    const providerIds: string[] =
      level === "critical"
        ? thresholds.critical
        : level === "high"
          ? thresholds.high
          : level === "normal"
            ? thresholds.normal
            : thresholds.low;

    const enabledIds = new Set(
      config.providers
        .filter((p) => p.enabled)
        .map((p) => p.id),
    );

    const result: EnrichmentProvider[] = [];
    for (const id of providerIds) {
      if (!enabledIds.has(id)) continue;
      const provider = this.providers.get(id);
      if (provider) {
        result.push(provider);
      }
    }
    return result;
  }
}
