import {
  SCHEMA_TIER_FIXTURE,
  SCHEMA_TIER_SMOKE_FIXTURE,
  type PersonalizationRetrievalCase,
  type SchemaTierName,
  type SchemaTierPage,
} from "../../../fixtures/schema-tiers/index.js";

export interface RetrievalPersonalizationCase {
  id: string;
  title: string;
  tier: SchemaTierName;
  query: string;
  expectedPageIds: string[];
  expectedNamespace: string;
  expectedOwner: string;
  pages: SchemaTierPage[];
}

function buildCases(
  sourceCases: PersonalizationRetrievalCase[],
  cleanPages: SchemaTierPage[],
  dirtyPages: SchemaTierPage[],
): RetrievalPersonalizationCase[] {
  return sourceCases.flatMap((sample) => [
    {
      id: `clean:${sample.id}`,
      title: `[clean] ${sample.query}`,
      tier: "clean" as const,
      query: sample.query,
      expectedPageIds: [...sample.expectedPageIds],
      expectedNamespace: sample.expectedNamespace,
      expectedOwner: sample.expectedOwner,
      pages: cleanPages,
    },
    {
      id: `dirty:${sample.id}`,
      title: `[dirty] ${sample.query}`,
      tier: "dirty" as const,
      query: sample.query,
      expectedPageIds: [...sample.expectedPageIds],
      expectedNamespace: sample.expectedNamespace,
      expectedOwner: sample.expectedOwner,
      pages: dirtyPages,
    },
  ]);
}

export const RETRIEVAL_PERSONALIZATION_FIXTURE = buildCases(
  SCHEMA_TIER_FIXTURE.personalizationCases,
  SCHEMA_TIER_FIXTURE.clean.pages,
  SCHEMA_TIER_FIXTURE.dirty.pages,
);

export const RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE = buildCases(
  SCHEMA_TIER_SMOKE_FIXTURE.personalizationCases,
  SCHEMA_TIER_SMOKE_FIXTURE.clean.pages,
  SCHEMA_TIER_SMOKE_FIXTURE.dirty.pages,
);

export function selectRetrievalPersonalizationCases(
  mode: "quick" | "full",
  limit?: number,
): RetrievalPersonalizationCase[] {
  const fixture = mode === "quick"
    ? SCHEMA_TIER_SMOKE_FIXTURE
    : SCHEMA_TIER_FIXTURE;
  const sourceCases = limit === undefined
    ? fixture.personalizationCases
    : fixture.personalizationCases.slice(0, limit);
  return buildCases(sourceCases, fixture.clean.pages, fixture.dirty.pages);
}
