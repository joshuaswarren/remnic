/**
 * Web search enrichment provider stub (issue #365).
 *
 * A basic provider backed by web search. Since this is opt-in and we do not
 * want to hard-code an API key, the provider accepts an optional `searchFn`
 * injection point. When no search function is configured it returns empty
 * results, making it safe to register unconditionally.
 */

import type {
  EnrichmentCandidate,
  EnrichmentCostTier,
  EnrichmentProvider,
  EntityEnrichmentInput,
} from "./types.js";

export type WebSearchFn = (query: string) => Promise<string[]>;

export interface WebSearchProviderOptions {
  /**
   * Injected search function. Each returned string is treated as a raw
   * snippet. When `undefined` the provider returns empty results.
   */
  searchFn?: WebSearchFn;
}

export class WebSearchProvider implements EnrichmentProvider {
  readonly id = "web-search";
  readonly costTier: EnrichmentCostTier = "cheap";

  private readonly searchFn: WebSearchFn | undefined;

  constructor(options: WebSearchProviderOptions = {}) {
    this.searchFn = options.searchFn;
  }

  async isAvailable(): Promise<boolean> {
    return this.searchFn !== undefined;
  }

  async enrich(entity: EntityEnrichmentInput): Promise<EnrichmentCandidate[]> {
    if (!this.searchFn) return [];

    const query = `${entity.name} ${entity.type}`;
    const snippets = await this.searchFn(query);

    return snippets
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .map((snippet) => ({
        text: snippet.trim(),
        source: this.id,
        sourceUrl: undefined,
        confidence: 0.5,
        category: "fact" as const,
        tags: ["web-search"],
      }));
  }
}
