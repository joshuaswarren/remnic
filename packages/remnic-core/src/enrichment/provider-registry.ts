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

  get(id: string): EnrichmentProvider | undefined {
    return this.providers.get(id);
  }

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

  getForImportance(
    level: ImportanceLevel,
    config: EnrichmentPipelineConfig,
  ): EnrichmentProvider[] {
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
