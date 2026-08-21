import {
  SCHEMA_TIER_FIXTURE,
  SCHEMA_TIER_SMOKE_FIXTURE,
  type SchemaTierName,
  type SchemaTierPage,
  type TemporalRetrievalCase,
} from "../../../fixtures/schema-tiers/index.js";

export interface RetrievalTemporalCase {
  id: string;
  title: string;
  tier: SchemaTierName;
  query: string;
  window: {
    start: string;
    end: string;
  };
  expectedPageIds: string[];
  pages: SchemaTierPage[];
}

export const RETRIEVAL_TEMPORAL_FIXTURE = buildFixture(SCHEMA_TIER_FIXTURE);
export const RETRIEVAL_TEMPORAL_SMOKE_FIXTURE = buildFixture(SCHEMA_TIER_SMOKE_FIXTURE);

function buildFixture(source: typeof SCHEMA_TIER_FIXTURE): RetrievalTemporalCase[] {
  const cases: RetrievalTemporalCase[] = [];

  for (const sample of source.temporalCases) {
    cases.push(buildCase(sample, "clean", source.clean.pages));
    cases.push(buildCase(sample, "dirty", source.dirty.pages));
  }

  return cases;
}

function buildCase(
  sample: TemporalRetrievalCase,
  tier: SchemaTierName,
  pages: SchemaTierPage[],
): RetrievalTemporalCase {
  return {
    id: `${tier}:${sample.id}`,
    title: `${sample.id} (${tier})`,
    tier,
    query: sample.query,
    window: { ...sample.window },
    expectedPageIds: [...sample.expectedPageIds],
    pages: pages.map((page) => ({
      ...page,
      aliases: [...page.aliases],
      frontmatter: {
        ...page.frontmatter,
        seeAlso: page.frontmatter.seeAlso ? [...page.frontmatter.seeAlso] : undefined,
        timeline: page.frontmatter.timeline ? [...page.frontmatter.timeline] : undefined,
      },
      seeAlso: [...page.seeAlso],
      timeline: [...page.timeline],
      dirtySignals: [...page.dirtySignals],
    })),
  };
}
