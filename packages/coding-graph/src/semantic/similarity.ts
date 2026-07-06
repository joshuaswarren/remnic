/**
 * SIMILAR_TO near-clone pipeline (issue #1556 PR2 component).
 *
 * Cheap-first, deterministic:
 *   1. MinHash/LSH candidate generation over normalized symbol bodies.
 *   2. Cosine confirmation by embedding ≥ threshold when vectors exist.
 *
 * Edges carry `provenance: "semantic"` + the similarity score as
 * confidence. No provider → MinHash-only edges carry a distinct lower
 * confidence band (documented), and the pipeline still runs (MinHash is
 * local and deterministic).
 *
 * Rule 35 spirit: the threshold boundary (≥ vs >) is decided ONCE here
 * (≥ threshold confirms) and documented. The boundary test pins it.
 *
 * Rule 38: the candidate set is a pure function of (seeds, inputs). Two
 * runs over the same fixture produce an identical edge set.
 */
import { readFileSync as fsReadFileSync } from "node:fs";
import path from "node:path";
const fs = { readFileSync: fsReadFileSync };
import type { GraphStore } from "../graph-store.js";
import type { EdgeIR } from "../graph-store.js";
import { buildCanonicalTextAndHash } from "./canonical-text.js";
import {
  MINHASH_ONLY_CONFIDENCE,
  SEMANTIC_PROVENANCE,
  SIMILAR_TO_EDGE_TYPE,
} from "./config.js";
import type { SemanticConfig } from "./config.js";
import { cosineSimilarity, createMinHasher, tokenizeForShingling, shingleSet } from "./minhash.js";
import type { SimilarEdge, SimilarToResult } from "./types.js";
import type { SemanticFailure } from "./types.js";
import { modelIdFor } from "./vectors.js";
import type { HostEmbeddingProvider } from "@remnic/core/host-embedding-provider";

/**
 * Input to {@link computeSimilarTo}.
 */
export interface SimilarToInput {
  readonly store: GraphStore;
  readonly provider: HostEmbeddingProvider | undefined;
  readonly config: SemanticConfig;
  /**
   * Repo root for reading source text from disk when bodies are not
   * supplied. Required when bodies is absent.
   */
  readonly repoRoot?: string;
  /**
   * Symbol bodies keyed by nodeId. The caller (the indexer or a
   * standalone pass) reads source text and builds canonical bodies. When
   * absent, the pipeline reads nodes from the store + disk itself.
   */
  readonly bodies?: ReadonlyMap<string, { readonly qualifiedName: string; readonly body: string }>;
  /**
   * Vectors keyed by nodeId (the persisted embedding). When absent, the
   * pipeline reads them from the store via readAllSymbolVectors.
   */
  readonly vectors?: ReadonlyMap<string, Float32Array>;
}

/**
 * The comparison operator for cosine confirmation. Decided ONCE (rule 35
 * spirit): `>= threshold`. A pair at EXACTLY the threshold confirms. The
 * boundary test asserts this.
 */
export const CONFIRM_OPERATOR = ">=" as const;

/**
 * Jaccard gate for MinHash-only SIMILAR_TO edges (no embedding provider).
 * Well below the cosine similarToThreshold (0.92) because token-Jaccard
 * for near-clone code is typically 0.3-0.8. 0.5 catches genuine
 * copy-paste with minor renames while rejecting structurally-similar
 * but logically-unrelated pairs.
 */
export const MINHASH_JACCARD_GATE = 0.5;

/**
 * Compute SIMILAR_TO edges.
 *
 * Returns the edges (for the caller to persist via store.upsertEdges) plus
 * counts. The caller persists; this function is pure over its inputs
 * (rule 38 — deterministic given seeds + bodies + vectors).
 *
 * When `config.enabled` is false → tagged semantic_disabled (no work, no
 * candidate generation — gate-off parity).
 */
export function computeSimilarTo(input: SimilarToInput): SimilarToResult | SemanticFailure {
  const { store, provider, config } = input;
  if (!config.enabled) {
    return { ok: false, code: "semantic_disabled" };
  }

  // Without pre-built bodies AND without a repoRoot, the only available
  // text is the qualified name, which MinHashes name similarity rather
  // than body similarity — real copy-paste clones with different names
  // are silently missed. Refuse to guess: require one of the two so the
  // pipeline always MinHashes actual symbol bodies (chatgpt-codex-
  // connector P2: 'Require source bodies before MinHashing').
  if (!input.bodies && !input.repoRoot) {
    return {
      ok: false,
      code: "repo_root_unset",
      message: "computeSimilarTo needs either 'bodies' or 'repoRoot' to read source text",
    };
  }
  const bodies = input.bodies ?? readBodiesFromStore(store, input.repoRoot);
  const modelId = provider ? modelIdFor(provider) : undefined;
  const vectors = input.vectors ?? (modelId ? readVectorsMap(store, modelId) : new Map<string, Float32Array>());

  // Pass 1: MinHash/LSH candidates.
  const hasher = createMinHasher();
  for (const [nodeId, entry] of bodies) {
    hasher.add({ nodeId, qualifiedName: entry.qualifiedName, body: entry.body });
  }
  const candidates = hasher.findCandidates();

  // Pass 2: cosine confirmation.
  const edges: SimilarEdge[] = [];
  let confirmed = 0;
  let minhashOnly = 0;
  for (const c of candidates) {
    const va = vectors.get(c.aNodeId);
    const vb = vectors.get(c.bNodeId);
    if (va && vb) {
      const cos = cosineSimilarity(va, vb);
      // rule 35: >= threshold confirms (decided once, here).
      if (cos >= config.similarToThreshold) {
        edges.push({
          srcQualifiedName: c.aQualifiedName,
          dstQualifiedName: c.bQualifiedName,
          confidence: cos,
          confirmed: true,
        });
        confirmed += 1;
      }
    } else {
      // MinHash-only: no vectors for one or both nodes. Distinct lower
      // confidence band (documented). Use a Jaccard gate well below the
      // cosine threshold — MinHash Jaccard for near-clones is typically
      // 0.3-0.8; the cosine 0.92 gate would suppress almost all MinHash
      // edges. The MINHASH_JACCARD_GATE is the documented floor for
      // local (no-provider) SIMILAR_TO edges.
      if (c.jaccard >= MINHASH_JACCARD_GATE) {
        edges.push({
          srcQualifiedName: c.aQualifiedName,
          dstQualifiedName: c.bQualifiedName,
          confidence: MINHASH_ONLY_CONFIDENCE,
          confirmed: false,
        });
        minhashOnly += 1;
      }
    }
  }

  // Stable sort: by confidence desc, then src qname, then dst qname.
  edges.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.srcQualifiedName !== b.srcQualifiedName) return a.srcQualifiedName < b.srcQualifiedName ? -1 : 1;
    return a.dstQualifiedName < b.dstQualifiedName ? -1 : a.dstQualifiedName > b.dstQualifiedName ? 1 : 0;
  });

  return { ok: true, edges, candidates: candidates.length, confirmed, minhashOnly };
}

/**
 * Convert SimilarEdge[] to the store's EdgeIR[] for persistence via
 * upsertEdges. Provenance is always "semantic"; type is SIMILAR_TO.
 */
export function similarEdgesToEdgeIR(edges: readonly SimilarEdge[]): EdgeIR[] {
  return edges.map((e) => ({
    srcQualifiedName: e.srcQualifiedName,
    dstQualifiedName: e.dstQualifiedName,
    type: SIMILAR_TO_EDGE_TYPE,
    confidence: e.confidence,
    provenance: SEMANTIC_PROVENANCE,
  }));
}

/**
 * Read canonical bodies for every persisted node from the store + disk.
 * Used when the caller does not supply pre-built bodies. Returns a map
 * keyed by nodeId with the canonical body text (the MinHash input).
 *
 * Note: this reads from disk synchronously per node, so callers that
 * already have bodies in memory should pass them via `input.bodies`.
 */
function readBodiesFromStore(store: GraphStore, repoRoot?: string): Map<string, { readonly qualifiedName: string; readonly body: string }> {
  const out = new Map<string, { readonly qualifiedName: string; readonly body: string }>();
  for (const node of store.readNodesForSemantic()) {
    let rawText = "";
    if (repoRoot) {
      try {
        const abs = path.resolve(repoRoot, node.filePath);
        const bytes = fs.readFileSync(abs);
        const start = Math.max(0, node.startByte);
        const end = Math.min(bytes.length, node.endByte);
        if (start <= end) rawText = bytes.subarray(start, end).toString("utf8");
      } catch {
        // File not readable — body stays empty, symbol is skipped by MinHasher.
      }
    } else {
      // No repoRoot — fall back to qualified name tokens so the pipeline
      // still runs (useful for tests that supply bodies explicitly).
      rawText = node.qualifiedName;
    }
    const { text } = buildCanonicalTextAndHash({
      symbol: {
        kind: node.kind as never,
        name: node.qualifiedName.split(/[.#:]/).pop() ?? node.qualifiedName,
        qualifiedName: node.qualifiedName,
        span: { startByte: node.startByte, endByte: node.endByte },
      },
      rawText,
      maxBodyLines: 0,
    });
    out.set(node.nodeId, { qualifiedName: node.qualifiedName, body: text });
  }
  return out;
}

/**
 * Read the vectors table into a nodeId → Float32Array map for cosine
 * confirmation. Uses the model id derived from the provider.
 */
function readVectorsMap(store: GraphStore, modelId: string): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (const row of store.readAllSymbolVectors(modelId)) {
    out.set(row.nodeId, row.vector);
  }
  return out;
}

/**
 * Estimate Jaccard similarity between two bodies directly (no LSH). Used
 * by the hard-negative test to assert two bodies are NOT similar.
 */
export function estimateJaccard(bodyA: string, bodyB: string): number {
  const sa = shingleSet(tokenizeForShingling(bodyA));
  const sb = shingleSet(tokenizeForShingling(bodyB));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}
