/**
 * semantic_query — natural-language retrieval over the symbol graph
 * (issue #1556 PR3 component).
 *
 * Embed the query via the host provider / EmbeddingFallback
 * (`mode: "lookup"`), top-k symbols by cosine, hydrate each hit with
 * graph context (defining file, direct callers/callees).
 *
 * Rule 34 — degradation matrix. Provider missing / timeout / malformed
 * vector (`normalizeHostEmbeddingVector` returns null) → three distinct
 * `{ok:false}` codes, never an empty result masquerading as "no matches".
 * When the provider is available but returns zero hits, `ok:true` with
 * empty hits is the honest answer.
 */


import type { HostEmbeddingProvider } from "@remnic/core/host-embedding-provider";
import {
  EmbeddingProviderUnavailableError,
  EmbeddingTimeoutError,
} from "@remnic/core/embedding-fallback";
import { normalizeHostEmbeddingVector } from "@remnic/core/host-embedding-provider";

import type { GraphStore } from "../graph-store.js";
import type { SemanticConfig } from "./config.js";
import { cosineSimilarity } from "./minhash.js";
import { modelIdFor } from "./vectors.js";
import type { SemanticQueryHit, SemanticQueryOutcome } from "./types.js";

/**
 * Input to {@link semanticQuery}.
 */
export interface SemanticQueryInput {
  readonly store: GraphStore;
  readonly provider: HostEmbeddingProvider | undefined;
  readonly repoRoot: string;
  readonly config: SemanticConfig;
  readonly query: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/**
 * Default top-k for semantic_query.
 */
export const DEFAULT_SEMANTIC_QUERY_LIMIT = 10;

/**
 * Run a semantic query: embed → top-k → hydrate.
 *
 * Degradation matrix (rule 34):
 *   - !config.enabled              → { ok:false, code:"semantic_disabled" }
 *   - no provider                  → { ok:false, code:"provider_unavailable" }
 *   - provider throws timeout      → { ok:false, code:"provider_timeout" }
 *   - provider returns null/malformed → { ok:false, code:"malformed_vector" }
 *   - no vectors in table          → { ok:false, code:"no_vectors" }
 *   - ok but zero hits             → { ok:true, hits:[] }
 */
export async function semanticQuery(input: SemanticQueryInput): Promise<SemanticQueryOutcome> {
  const { store, provider, repoRoot, config, query, signal } = input;
  // Closed store is a distinct degradation (rule 34) — do not treat it as
  // an empty vectors table that returns 'no_vectors' (cursor Bugbot:
  // 'Closed store reports success').
  if (store.isClosed) {
    return { ok: false, code: "store_closed" };
  }
  if (!config.enabled) {
    return { ok: false, code: "semantic_disabled" };
  }
  if (query.length === 0) {
    return { ok: false, code: "invalid_query", message: "query must be non-empty" };
  }
  if (!provider) {
    return { ok: false, code: "provider_unavailable" };
  }

  // Embed the query (lookup mode — short timeout budget).
  let raw: ArrayLike<number> | null;
  try {
    raw = await provider.embed(query, { signal, inputType: "query" });
  } catch (error) {
    if (error instanceof EmbeddingTimeoutError) {
      return { ok: false, code: "provider_timeout" };
    }
    if (error instanceof EmbeddingProviderUnavailableError) {
      return { ok: false, code: "provider_unavailable" };
    }
    // Unknown provider error → treat as unavailable (the provider is broken).
    // Do NOT include the raw error message (may leak paths/stacks to clients).
    return { ok: false, code: "provider_unavailable" };
  }
  const queryVec = normalizeHostEmbeddingVector(raw);
  if (!queryVec || queryVec.length === 0) {
    return { ok: false, code: "malformed_vector" };
  }
  const queryF32 = new Float32Array(queryVec);

  // Brute-force cosine over all vectors for this model.
  const modelId = modelIdFor(provider);
  const rows = store.readAllSymbolVectors(modelId);
  if (rows.length === 0) {
    return { ok: false, code: "no_vectors" };
  }

  const limit = Math.max(1, input.limit ?? DEFAULT_SEMANTIC_QUERY_LIMIT);
  // Only score vectors whose dimensionality matches the query embedding.
  // cosineSimilarity compares over the SHORTER length, so a row from a
  // different model size would otherwise get a misleading partial-overlap
  // score and rank incorrectly instead of being excluded (cursor Bugbot:
  // 'Mismatched embedding lengths scored').
  const queryDims = queryF32.length;
  const scored = rows
    .filter((r) => r.dims === queryDims)
    .map((r) => ({
      nodeId: r.nodeId,
      qualifiedName: r.qualifiedName,
      filePath: r.filePath,
      kind: r.kind,
      dims: r.dims,
      score: cosineSimilarity(queryF32, r.vector),
    }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Hydrate each hit with graph context (callers/callees + snippet).
  const hits: SemanticQueryHit[] = [];
  for (const h of scored) {
    const neighbors = store.readNeighborsByNodeId(h.nodeId);
    let snippet = "";
    try {
      // Hydrate by the exact node id from the vector row, not the
      // qualified name — a name duplicated across files would otherwise
      // hit 'ambiguous_name' and leave the snippet empty even though the
      // vector row identified the precise node (chatgpt-codex-connector
      // P2: 'Hydrate snippets by node id as well').
      const snippetResult = await store.snippetFor({ nodeId: h.nodeId, repoRoot });
      if (snippetResult.ok) snippet = snippetResult.text;
    } catch {
      // snippetFor returns tagged failures, not throws — this is defensive.
    }
    hits.push({
      qualifiedName: h.qualifiedName,
      filePath: h.filePath,
      kind: h.kind,
      score: h.score,
      snippet,
      callers: neighbors.callers,
      callees: neighbors.callees,
    });
  }

  return { ok: true, hits };
}

/**
 * Read a short snippet (first ~20 lines) from a file for hydration. The
 * full source span is available via store.snippetFor; here we just want
 * enough context for the agent to orient.
 */