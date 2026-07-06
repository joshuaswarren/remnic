/**
 * Symbol-vector indexing (issue #1556 PR1 component).
 *
 * Reads source text from disk, builds canonical text, checks the cache
 * (skip re-embed when content_hash matches), embeds via the host provider,
 * and persists vectors to the `symbol_vectors` table.
 *
 * Rule 30/48: when `config.enabled` is false, this module returns a tagged
 * `{ ok: false, code: "semantic_disabled" }` WITHOUT reading source,
 * calling the provider, or writing a vector (gate-off parity test covers
 * this). The gate is checked at this single chokepoint — callers never
 * need to re-check.
 *
 * Rule 44: vectors are written only for symbols that persisted
 * successfully. The indexer reads nodes from the store (which only
 * contains persisted nodes), so a `parse_failed` file contributes zero
 * nodes and thus zero vectors.
 *
 * Rule 37: cache invalidation. When a symbol's canonical text changes,
 * its content_hash changes, the cached row no longer matches, and the
 * vector is re-embedded. The old vector is overwritten (ON CONFLICT
 * UPDATE). Any SIMILAR_TO edge derived from the old vector is recomputed
 * by the similarity pipeline on its next run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { HostEmbeddingProvider } from "@remnic/core/host-embedding-provider";
import { normalizeHostEmbeddingVector } from "@remnic/core/host-embedding-provider";

import type { GraphStore } from "../graph-store.js";
import { buildCanonicalTextAndHash } from "./canonical-text.js";
import type { SemanticConfig } from "./config.js";
import type { IndexVectorsResult, SemanticFailure } from "./types.js";

/**
 * Input to {@link indexSymbolVectors}. The store provides node metadata +
 * the vectors table; the provider embeds; repoRoot resolves file paths.
 */
export interface IndexVectorsInput {
  readonly store: GraphStore;
  readonly provider: HostEmbeddingProvider | undefined;
  readonly repoRoot: string;
  readonly config: SemanticConfig;
  /**
   * Optional abort signal forwarded to the provider. The indexer does not
   * impose its own timeout (the provider's embed() contract handles that).
   */
  readonly signal?: AbortSignal;
}

/**
 * The model id used for cache keying. Derives from the provider's `model`
 * (falling back to `id`) so a provider/model swap produces a distinct
 * cache namespace and does not overwrite the prior vectors.
 */
export function modelIdFor(provider: HostEmbeddingProvider): string {
  return provider.model ?? provider.id;
}

/**
 * Index symbol vectors for every persisted node in the store.
 *
 * Flow:
 *   1. Gate: if !config.enabled → tagged semantic_disabled (no work).
 *   2. Provider check: if no provider → tagged provider_unavailable.
 *   3. Read all nodes from the store (persisted only — rule 44).
 *   4. For each node (within maxSymbolsPerRun budget):
 *      a. Read source text from disk.
 *      b. Build canonical text + hash.
 *      c. Cache check: skip if cached row's content_hash matches.
 *      d. Embed via provider.
 *      e. Normalize (reject malformed → counted as skipped).
 *      f. Persist vector.
 *   5. Return counts.
 *
 * Budget order (rule 27): recently-changed symbols first. The store's
 * readNodesForSemantic returns nodes ordered by qualified_name; the
 * indexer applies the caller-supplied priority before slicing. When no
 * priority is given, all nodes are eligible (budget 0 = unlimited).
 */
export async function indexSymbolVectors(
  input: IndexVectorsInput,
): Promise<IndexVectorsResult | SemanticFailure> {
  const { store, provider, repoRoot, config, signal } = input;

  // Rule 30/48 + rule 39: single gate chokepoint.
  if (!config.enabled) {
    return { ok: false, code: "semantic_disabled" };
  }
  if (!provider) {
    return { ok: false, code: "provider_unavailable" };
  }

  const modelId = modelIdFor(provider);
  const nodes = store.readNodesForSemantic();
  const budget = config.maxSymbolsPerRun > 0 ? config.maxSymbolsPerRun : nodes.length;
  // rule 27: guard slice(-n) for n=0. budget is already ≥ 0 here, but
  // maxSymbolsPerRun=0 means unlimited (all nodes), not "zero nodes".
  const eligible = nodes.slice(0, budget);

  let embedded = 0;
  let cached = 0;
  let skipped = 0;

  for (const node of eligible) {
    if (signal?.aborted) break;
    // Read source text from disk.
    const absolutePath = path.resolve(repoRoot, node.filePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch {
      skipped += 1;
      continue;
    }
    const start = Math.max(0, node.startByte);
    const end = Math.min(bytes.length, node.endByte);
    if (start > end) {
      skipped += 1;
      continue;
    }
    const rawText = bytes.subarray(start, end).toString("utf8");

    // Canonical text + hash (rule 23/37). The embedded string MUST equal
    // the hashed string (rule 23 — one form everywhere).
    const { text: canonicalText, hash } = buildCanonicalTextAndHash({
      symbol: {
        kind: node.kind as never,
        name: node.qualifiedName.split(/[.#:]/).pop() ?? node.qualifiedName,
        qualifiedName: node.qualifiedName,
        span: { startByte: node.startByte, endByte: node.endByte },
      },
      rawText,
      maxBodyLines: config.canonicalBodyLines,
    });

    // Cache check: skip re-embed when content_hash matches.
    const cachedRow = store.readSymbolVector(node.nodeId, modelId);
    if (cachedRow && cachedRow.contentHash === hash) {
      cached += 1;
      continue;
    }

    // Embed the CANONICAL text (not the raw span) so the vector
    // corresponds to the content_hash that gates cache hits (rule 23).
    // This also respects canonicalBodyLines as a cost/privacy bound.
    let raw: ArrayLike<number> | null;
    try {
      raw = await provider.embed(canonicalText, {
        signal,
        inputType: "document",
      });
    } catch {
      // Stale vector cleanup (rule 37): if a prior vector exists with a
      // different content_hash and we cannot re-embed, delete the stale
      // row so semantic_query/cosine confirmation do not serve it.
      if (cachedRow && cachedRow.contentHash !== hash) {
        store.deleteSymbolVectors([node.nodeId]);
      }
      skipped += 1;
      continue;
    }
    const vec = normalizeHostEmbeddingVector(raw);
    if (!vec || vec.length === 0) {
      if (cachedRow && cachedRow.contentHash !== hash) {
        store.deleteSymbolVectors([node.nodeId]);
      }
      skipped += 1;
      continue;
    }
    const float32 = new Float32Array(vec);
    store.writeSymbolVector({
      nodeId: node.nodeId,
      modelId,
      contentHash: hash,
      dims: float32.length,
      vector: float32,
    });
    embedded += 1;
  }

  return { ok: true, embedded, cached, skipped };
}
