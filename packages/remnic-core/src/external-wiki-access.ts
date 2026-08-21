import { z } from "zod";

import { defineOperation } from "./access-boundary.js";
import {
  type ExternalWikiSearchInput,
  type ExternalWikiSearchResult,
  searchExternalWikis,
} from "./external-wiki-search.js";

const externalWikiSearchSchema = z
  .object({
    query: z.string().trim().min(1, "query is required").max(2_048),
    limit: z.number().int().min(1).max(20).optional(),
    wikiId: z.string().trim().min(1).max(256).optional(),
    maxCharsPerHit: z.number().int().min(1).max(8_000).optional(),
  })
  .strict();

export interface ExternalWikiSearchOutput {
  readonly result: ExternalWikiSearchResult;
}

export const externalWikiSearchOperation = defineOperation<ExternalWikiSearchInput, ExternalWikiSearchOutput>({
  name: "external_wiki_search",
  description: "Search configured external compiled-wiki roots and return cited snippets.",
  schema: externalWikiSearchSchema,
  fleetWide: true,
  handler: async (input, ctx) => ({
    result: await searchExternalWikis(ctx.service.configRef.externalWikis, input),
  }),
});
