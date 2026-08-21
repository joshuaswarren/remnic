import type { EnrichmentCandidate, EntityEnrichmentInput } from "@remnic/core";
import type { EnrichmentPipelineConfig } from "@remnic/core";

export interface EnrichmentProviderFixture {
  id: string;
  enabled: boolean;
  costTier: "free" | "cheap" | "expensive";
  available?: boolean;
  candidates: EnrichmentCandidate[];
}

export interface EnrichmentFidelityCase {
  id: string;
  entity: EntityEnrichmentInput;
  providers: EnrichmentProviderFixture[];
  config: EnrichmentPipelineConfig;
  expectedAccepted: string[];
}

export const ENRICHMENT_FIDELITY_FIXTURE: EnrichmentFidelityCase[] = [
  {
    id: "high-importance-hit",
    entity: {
      name: "Remnic",
      type: "project",
      knownFacts: ["Remnic is a memory system"],
      importanceLevel: "high",
    },
    providers: [
      {
        id: "search",
        enabled: true,
        costTier: "cheap",
        candidates: [
          {
            text: "Remnic publishes benchmark results as JSON artifacts.",
            source: "search",
            confidence: 0.92,
            category: "fact",
          },
          {
            text: "Remnic uses markdown files for long-term memory storage.",
            source: "search",
            confidence: 0.88,
            category: "fact",
          },
        ],
      },
    ],
    config: {
      enabled: true,
      providers: [{ id: "search", enabled: true, costTier: "cheap" }],
      importanceThresholds: {
        critical: ["search"],
        high: ["search"],
        normal: ["search"],
        low: [],
      },
      maxCandidatesPerEntity: 5,
      autoEnrichOnCreate: false,
      scheduleIntervalMs: 3_600_000,
    },
    expectedAccepted: [
      "Remnic publishes benchmark results as JSON artifacts.",
      "Remnic uses markdown files for long-term memory storage.",
    ],
  },
  {
    id: "max-candidate-cap",
    entity: {
      name: "Bench UI",
      type: "package",
      knownFacts: ["Bench UI is optional"],
      importanceLevel: "normal",
    },
    providers: [
      {
        id: "web",
        enabled: true,
        costTier: "cheap",
        candidates: [
          {
            text: "Bench UI is a React and Vite package.",
            source: "web",
            confidence: 0.9,
            category: "fact",
          },
          {
            text: "Bench UI exports static HTML reports.",
            source: "web",
            confidence: 0.82,
            category: "fact",
          },
          {
            text: "Bench UI publishes a Remnic.ai JSON feed.",
            source: "web",
            confidence: 0.8,
            category: "fact",
          },
        ],
      },
    ],
    config: {
      enabled: true,
      providers: [{ id: "web", enabled: true, costTier: "cheap" }],
      importanceThresholds: {
        critical: ["web"],
        high: ["web"],
        normal: ["web"],
        low: [],
      },
      maxCandidatesPerEntity: 2,
      autoEnrichOnCreate: false,
      scheduleIntervalMs: 3_600_000,
    },
    expectedAccepted: [
      "Bench UI is a React and Vite package.",
      "Bench UI exports static HTML reports.",
    ],
  },
  {
    id: "low-importance-no-provider",
    entity: {
      name: "Scratch Note",
      type: "artifact",
      knownFacts: ["Temporary scratch data"],
      importanceLevel: "low",
    },
    providers: [
      {
        id: "web",
        enabled: true,
        costTier: "cheap",
        candidates: [
          {
            text: "This should never be accepted for a low-importance entity.",
            source: "web",
            confidence: 0.7,
            category: "fact",
          },
        ],
      },
    ],
    config: {
      enabled: true,
      providers: [{ id: "web", enabled: true, costTier: "cheap" }],
      importanceThresholds: {
        critical: ["web"],
        high: ["web"],
        normal: ["web"],
        low: [],
      },
      maxCandidatesPerEntity: 5,
      autoEnrichOnCreate: false,
      scheduleIntervalMs: 3_600_000,
    },
    expectedAccepted: [],
  },
  {
    id: "provider-unavailable",
    entity: {
      name: "Versioning",
      type: "feature",
      knownFacts: ["Versioning stores sidecar snapshots"],
      importanceLevel: "critical",
    },
    providers: [
      {
        id: "unavailable",
        enabled: true,
        costTier: "expensive",
        available: false,
        candidates: [
          {
            text: "Unavailable provider candidate",
            source: "unavailable",
            confidence: 0.6,
            category: "fact",
          },
        ],
      },
    ],
    config: {
      enabled: true,
      providers: [{ id: "unavailable", enabled: true, costTier: "expensive" }],
      importanceThresholds: {
        critical: ["unavailable"],
        high: ["unavailable"],
        normal: [],
        low: [],
      },
      maxCandidatesPerEntity: 5,
      autoEnrichOnCreate: false,
      scheduleIntervalMs: 3_600_000,
    },
    expectedAccepted: [],
  },
];

export const ENRICHMENT_FIDELITY_SMOKE_FIXTURE =
  ENRICHMENT_FIDELITY_FIXTURE.slice(0, 3);
