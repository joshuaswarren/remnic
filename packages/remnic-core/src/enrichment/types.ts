/**
 * Enrichment pipeline types (issue #365).
 *
 * Defines the provider interface, candidate shape, pipeline config,
 * and result types for the external enrichment subsystem.
 */

import type { ImportanceLevel, MemoryCategory } from "../types.js";

// ---------------------------------------------------------------------------
// Provider config & interface
// ---------------------------------------------------------------------------

export type EnrichmentCostTier = "free" | "cheap" | "expensive";

export interface EnrichmentProviderConfig {
  id: string;
  enabled: boolean;
  costTier: EnrichmentCostTier;
  rateLimit?: { maxPerMinute: number; maxPerDay: number };
}

export interface EnrichmentCandidate {
  text: string;
  source: string;
  sourceUrl?: string;
  confidence: number;
  category: MemoryCategory;
  tags?: string[];
}

export interface EnrichmentProvider {
  readonly id: string;
  readonly costTier: EnrichmentCostTier;
  enrich(entity: EntityEnrichmentInput): Promise<EnrichmentCandidate[]>;
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Entity enrichment input
// ---------------------------------------------------------------------------

export interface EntityEnrichmentInput {
  name: string;
  type: string;
  knownFacts: string[];
  importanceLevel: ImportanceLevel;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface EnrichmentResult {
  entityName: string;
  provider: string;
  candidatesFound: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  acceptedCandidates: EnrichmentCandidate[];
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Pipeline config
// ---------------------------------------------------------------------------

export interface EnrichmentPipelineConfig {
  enabled: boolean;
  providers: EnrichmentProviderConfig[];
  importanceThresholds: {
    critical: string[];
    high: string[];
    normal: string[];
    low: string[];
  };
  maxCandidatesPerEntity: number;
  autoEnrichOnCreate: boolean;
  scheduleIntervalMs: number;
}

/**
 * Build a default (disabled) pipeline config. Every consumer that needs a
 * config object should call this rather than duplicating the defaults.
 */
export function defaultEnrichmentPipelineConfig(): EnrichmentPipelineConfig {
  return {
    enabled: false,
    providers: [],
    importanceThresholds: {
      critical: [],
      high: [],
      normal: [],
      low: [],
    },
    maxCandidatesPerEntity: 20,
    autoEnrichOnCreate: false,
    scheduleIntervalMs: 3_600_000,
  };
}
