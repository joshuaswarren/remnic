export interface EntityConsolidationExpectation {
  canonicalName: string;
  timelineCount: number;
  structuredFactCount: number;
  stale: boolean;
  synthesis: string;
}

export type EntityConsolidationScenario =
  | "timeline-staleness"
  | "structured-merge"
  | "duplicate-dedupe";

export interface EntityConsolidationCase {
  id: string;
  title: string;
  scenario: EntityConsolidationScenario;
  entityName: string;
  entityType: string;
  expected: EntityConsolidationExpectation;
}

export const ENTITY_CONSOLIDATION_FIXTURE: EntityConsolidationCase[] = [
  {
    id: "timeline-staleness-after-new-fact",
    title: "Timeline evidence makes an older synthesis stale",
    scenario: "timeline-staleness",
    entityName: "Jane Doe",
    entityType: "person",
    expected: {
      canonicalName: "person-jane-doe",
      timelineCount: 2,
      structuredFactCount: 0,
      stale: true,
      synthesis: "Jane Doe leads the roadmap.",
    },
  },
  {
    id: "structured-section-merge",
    title: "Structured sections merge under the schema key and stale synthesis",
    scenario: "structured-merge",
    entityName: "Jane Doe",
    entityType: "person",
    expected: {
      canonicalName: "person-jane-doe",
      timelineCount: 0,
      structuredFactCount: 2,
      stale: true,
      synthesis: "Jane Doe prefers small, decisive teams.",
    },
  },
  {
    id: "duplicate-fact-dedupes",
    title: "Duplicate fact writes do not inflate the entity timeline",
    scenario: "duplicate-dedupe",
    entityName: "Project Atlas",
    entityType: "project",
    expected: {
      canonicalName: "project-project-atlas",
      timelineCount: 1,
      structuredFactCount: 0,
      stale: false,
      synthesis: "Project Atlas keeps weekly notes.",
    },
  },
];

export const ENTITY_CONSOLIDATION_SMOKE_FIXTURE = ENTITY_CONSOLIDATION_FIXTURE;
