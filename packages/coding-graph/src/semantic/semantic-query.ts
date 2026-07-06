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
import { readFile } from "node:fs/promises";
import path from "node:path";

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
      return { ok: false, code: "provider_timeout", message: String(error) };
    }
    if (error instanceof EmbeddingProviderUnavailableError) {
      return { ok: false, code: "provider_unavailable", message: String(error) };
    }
    // Unknown provider error → treat as unavailable (the provider is broken).
    return { ok: false, code: "provider_unavailable", message: error instanceof Error ? error.message : String(error) };
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
  const scored = rows
    .map((r) => ({
      nodeId: r.nodeId,
      qualifiedName: r.qualifiedName,
      filePath: r.filePath,
      dims: r.dims,
      score: cosineSimilarity(queryF32, r.vector),
    }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Hydrate each hit with graph context (callers/callees + snippet).
  const hits: SemanticQueryHit[] = [];
  for (const h of scored) {
    const neighbors = store.readNeighbors(h.qualifiedName);
    let snippet = "";
    try {
      const abs = path.resolve(repoRoot, h.filePath);
      snippet = await readSnippet(abs, 0, 0);
    } catch {
      snippet = "";
    }
    hits.push({
      qualifiedName: h.qualifiedName,
      filePath: h.filePath,
      kind: "",
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
async function readSnippet(absolutePath: string, startByte: number, endByte: number): Promise<string> {
  const bytes = await readFile(absolutePath);
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).slice(0, 20);
  return lines.join("\n");
}
