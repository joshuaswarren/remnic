/**
 * Graph-based retrieval types (issue #559, PR 1 of 5).
 *
 * This module defines the forward-looking type contract for Remnic's
 * first-class retrieval graph (GAAMA / GAM inspired). It ships types
 * and a no-op `queryGraph()` stub only — no behavior, no I/O, and
 * no importers inside the codebase yet.
 *
 * Subsequent slices will land:
 *   - PR 2: Edge extraction from existing relationship facts + cross-memory
 *           entity references during indexing (writes `~/.remnic/graph.json`).
 *   - PR 3: Pure `personalizedPageRank()` implementation.
 *   - PR 4: Feature-flagged wiring into `retrieval.ts` behind
 *           `graphRetrievalEnabled` (default `false`).
 *   - PR 5: LoCoMo A/B bench harness + default flip decision.
 *
 * Keeping the node/edge type enums complete from PR 1 avoids type churn
 * when later slices add reflection/concept node synthesis or additional
 * edge semantics.
 */

// ---------------------------------------------------------------------------
// Node & edge type enums
// ---------------------------------------------------------------------------

/**
 * Kinds of nodes the retrieval graph can hold.
 *
 * - `memory`:     a stored memory file (the primary retrieval target).
 * - `entity`:     a named entity referenced by one or more memories.
 * - `episode`:    a temporally-bounded interaction or session grouping.
 * - `concept`:    an abstract topic / idea (forward-looking; synthesis
 *                 is out of scope for this issue, but the type is
 *                 defined here to keep later slices additive).
 * - `reflection`: an LLM-generated summary / meta-memory about other
 *                 nodes (also forward-looking, same rationale).
 */
export type NodeType =
  | "memory"
  | "entity"
  | "episode"
  | "concept"
  | "reflection";

/**
 * Kinds of edges the retrieval graph can hold.
 *
 * Edges are directed. `from` → `to` semantics:
 *
 * - `references`:    `from` contains an explicit reference to `to`
 *                    (e.g., a memory referencing another memory).
 * - `supersedes`:    `from` supersedes `to` (newer memory replaces older).
 * - `authored-by`:   `from` was authored by the entity in `to`.
 * - `mentions`:      `from` mentions the entity/concept in `to` without
 *                    a stronger relationship claim.
 * - `derived-from`:  `from` was derived from `to` (reflections,
 *                    consolidations, summaries).
 * - `temporal-next`: `from` immediately follows `to` in time (episodes).
 * - `related-to`:    generic weak relationship fallback for edges that
 *                    do not fit a stronger type.
 */
export type EdgeType =
  | "references"
  | "supersedes"
  | "authored-by"
  | "mentions"
  | "derived-from"
  | "temporal-next"
  | "related-to";

// ---------------------------------------------------------------------------
// Graph element shapes
// ---------------------------------------------------------------------------

/**
 * A single node in the retrieval graph.
 *
 * `id` is the caller-controlled stable identifier (typically a memory
 * file path, entity slug, or episode id). `weight` is an optional prior
 * importance score used as a starting bias during Personalized PageRank;
 * it is intentionally optional because most nodes default to uniform
 * priors.
 *
 * Named `RemnicGraphNode` (not `GraphNode`) to avoid colliding with the
 * unrelated `GraphEdge` in `graph.ts`, which models Multi-Graph Memory
 * (MAGMA/SYNAPSE) edges and is an incompatible shape.
 */
export interface RemnicGraphNode {
  id: string;
  type: NodeType;
  weight?: number;
}

/**
 * A directed edge between two nodes.
 *
 * `weight` is optional; when absent PPR implementations should treat
 * the edge as weight `1`. We keep weight optional rather than defaulting
 * at construction so producers can serialize a minimal edge shape.
 *
 * Named `RemnicGraphEdge` (not `GraphEdge`) to avoid colliding with the
 * unrelated `GraphEdge` in `graph.ts` (Multi-Graph Memory).
 */
export interface RemnicGraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;
}

/**
 * The retrieval graph itself.
 *
 * Nodes are held in a `Map<string, RemnicGraphNode>` keyed by `id` so
 * PPR lookups are O(1). Edges are kept as a flat array; adjacency
 * indexing is a PR-3 concern (PPR will likely build a transient
 * outgoing-adjacency map on demand).
 */
export interface RemnicGraph {
  nodes: Map<string, RemnicGraphNode>;
  edges: RemnicGraphEdge[];
}

// ---------------------------------------------------------------------------
// Query surface (stub)
// ---------------------------------------------------------------------------

/**
 * Options for `queryGraph()`.
 *
 * Defaults (applied when undefined):
 *   - `damping`:    0.85 (standard PageRank value — higher values make the
 *                   random walk follow edges longer before teleporting back
 *                   to the seed distribution).
 *   - `iterations`: 20 (power-iteration cap).
 *   - `tolerance`:  1e-6 (L1 convergence threshold; iteration stops early
 *                   when the L1 norm of the delta between successive
 *                   rank vectors falls below this).
 *   - `topK`:       unbounded — all nodes with positive score are returned,
 *                   ordered by descending score.
 */
export interface QueryGraphOptions {
  /** Number of top-ranked nodes to return. Defaults to unbounded. */
  topK?: number;
  /**
   * PPR damping factor in (0, 1). The probability of following an outgoing
   * edge at each step (vs. teleporting back to the seed distribution).
   * Defaults to 0.85.
   */
  damping?: number;
  /** Maximum PPR iterations before falling back to current rank vector. */
  iterations?: number;
  /** L1 convergence threshold. Defaults to 1e-6. */
  tolerance?: number;
  /**
   * Optional per-seed weights. Keys must appear in `seedIds` or (if empty)
   * in the graph. Values must be non-negative. Weights are normalized so
   * they sum to 1 before seeding. If omitted, seed mass is distributed
   * uniformly across `seedIds`.
   */
  seedWeights?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

/**
 * A scored node returned by `queryGraph()`.
 */
export interface RankedGraphNode {
  id: string;
  score: number;
}

/**
 * The shape returned by `queryGraph()`.
 */
export interface QueryGraphResult {
  rankedNodes: RankedGraphNode[];
  /** Number of power-iteration rounds actually executed. */
  iterations: number;
  /** L1 delta at the last iteration. */
  converged: boolean;
}

/** PPR damping factor default. */
export const DEFAULT_PPR_DAMPING = 0.85;
/** Power-iteration cap default. */
export const DEFAULT_PPR_ITERATIONS = 20;
/** L1 convergence threshold default. */
export const DEFAULT_PPR_TOLERANCE = 1e-6;

/**
 * Normalize a `seedWeights` option (Map or plain object) to a plain Map.
 * Silently drops non-finite / negative / non-numeric values. Returns an
 * empty map if the input is undefined.
 */
function normalizeSeedWeights(
  input: QueryGraphOptions["seedWeights"],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!input) return out;
  const entries: Iterable<[string, unknown]> =
    input instanceof Map
      ? input.entries()
      : Object.entries(input as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (typeof k !== "string" || !k) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    out.set(k, v);
  }
  return out;
}

/**
 * Build the seed probability vector.
 *
 * Strategy:
 *   1. If the caller supplied `seedWeights`, restrict to keys present in
 *      the graph, sum, and normalize.
 *   2. Otherwise, take the subset of `seedIds` present in the graph and
 *      assign each an equal 1/n share.
 *   3. If neither produces any in-graph mass, fall back to a uniform
 *      distribution over all graph nodes (matches standard PageRank).
 */
function buildSeedVector(
  graph: RemnicGraph,
  seedIds: readonly string[],
  options: QueryGraphOptions,
): Map<string, number> {
  const seed = new Map<string, number>();

  const explicitWeights = normalizeSeedWeights(options.seedWeights);
  if (explicitWeights.size > 0) {
    // Restrict weight keys to the declared seed set (or, if empty, to
    // graph nodes). Documented contract in `QueryGraphOptions.seedWeights`:
    // keys must appear in `seedIds` — unrelated / stale weight entries
    // must not silently override the requested personalization.
    const allowedKeys =
      seedIds.length > 0
        ? new Set(seedIds.filter((id) => typeof id === "string"))
        : null;
    let total = 0;
    for (const [id, w] of explicitWeights) {
      if (!graph.nodes.has(id)) continue;
      if (allowedKeys !== null && !allowedKeys.has(id)) continue;
      seed.set(id, (seed.get(id) ?? 0) + w);
      total += w;
    }
    if (total > 0) {
      for (const [id, v] of seed) seed.set(id, v / total);
      return seed;
    }
    seed.clear();
  }

  // Deduplicate before computing shares — `["a", "a", "b"]` must behave
  // identically to `["a", "b"]`. Computing `share` against a de-duped set
  // is the only way to guarantee that; renormalizing after the fact is
  // a no-op because the pre-dedup shares already sum to 1.
  const validSeeds = new Set<string>();
  for (const id of seedIds) {
    if (typeof id === "string" && graph.nodes.has(id)) validSeeds.add(id);
  }
  if (validSeeds.size > 0) {
    const share = 1 / validSeeds.size;
    for (const id of validSeeds) seed.set(id, share);
    return seed;
  }

  // Uniform fallback over all graph nodes.
  if (graph.nodes.size > 0) {
    const share = 1 / graph.nodes.size;
    for (const id of graph.nodes.keys()) seed.set(id, share);
  }
  return seed;
}

/**
 * Build an out-adjacency index with summed outgoing edge weights per source.
 *
 * Missing `weight` on an edge defaults to `1`. Edges referencing nodes that
 * are not in `graph.nodes` are skipped (dangling edges cannot propagate
 * mass). The returned `outSum` map lets the PPR loop divide once per source
 * instead of re-summing per iteration.
 */
function buildAdjacency(graph: RemnicGraph): {
  outgoing: Map<string, { to: string; weight: number }[]>;
  outSum: Map<string, number>;
} {
  const outgoing = new Map<string, { to: string; weight: number }[]>();
  const outSum = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
    const weight =
      typeof edge.weight === "number" && Number.isFinite(edge.weight) && edge.weight > 0
        ? edge.weight
        : 1;
    let bucket = outgoing.get(edge.from);
    if (!bucket) {
      bucket = [];
      outgoing.set(edge.from, bucket);
    }
    bucket.push({ to: edge.to, weight });
    outSum.set(edge.from, (outSum.get(edge.from) ?? 0) + weight);
  }
  return { outgoing, outSum };
}

/**
 * Personalized PageRank via power iteration.
 *
 * Pure function — no I/O. Deterministic given the same graph and options.
 *
 * Algorithm:
 *
 *   r_{t+1}(v) = (1 - d) * s(v)
 *              + d * Σ_{u → v} r_t(u) * w(u,v) / Σ_w w(u,·)
 *              + d * (dangling mass) * s(v)
 *
 * where:
 *   - `d` is the damping factor (default 0.85).
 *   - `s` is the seed vector (normalized personalization distribution).
 *   - dangling mass is the total rank on nodes with no outgoing edges,
 *     redistributed over the seed vector so probability mass is conserved.
 *
 * The loop stops early when `|r_{t+1} - r_t|_1 < tolerance` or after
 * `iterations` rounds, whichever comes first.
 *
 * Edge cases:
 *   - Empty graph → `{ rankedNodes: [], iterations: 0, converged: true }`.
 *   - Seed ids that are not in the graph are silently dropped.
 *   - If no in-graph seed mass remains (empty seed or all seeds missing),
 *     the uniform distribution over graph nodes is used — matching
 *     standard PageRank semantics.
 *   - `damping` is clamped to `[0, 1)` (a damping of exactly 1 would make
 *     the chain non-ergodic; damping of exactly 0 reduces to the seed
 *     distribution).
 *   - `topK <= 0` returns an empty ranked list (but the `iterations` and
 *     `converged` fields still reflect the actual computation).
 */
export function queryGraph(
  graph: RemnicGraph,
  seedIds: readonly string[],
  options: QueryGraphOptions = {},
): QueryGraphResult {
  const n = graph.nodes.size;
  if (n === 0) {
    return { rankedNodes: [], iterations: 0, converged: true };
  }

  // Clamp options.
  let damping = typeof options.damping === "number" ? options.damping : DEFAULT_PPR_DAMPING;
  if (!Number.isFinite(damping) || damping < 0) damping = 0;
  if (damping >= 1) damping = 1 - 1e-9;

  let maxIter = typeof options.iterations === "number" ? Math.floor(options.iterations) : DEFAULT_PPR_ITERATIONS;
  if (!Number.isFinite(maxIter) || maxIter < 0) maxIter = 0;

  let tolerance = typeof options.tolerance === "number" ? options.tolerance : DEFAULT_PPR_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) tolerance = 0;

  const seed = buildSeedVector(graph, seedIds, options);

  // Apply `RemnicGraphNode.weight` as a starting-rank prior — BUT only
  // when the caller did not supply explicit `seedWeights`. Explicit
  // caller-supplied weights must not be silently re-biased by node
  // priors (would double-count and contradict the documented contract
  // for `seedWeights`). When no explicit weights are given, multiply
  // each seed entry by its node weight (defaulting missing / non-
  // positive / non-finite weights to 1) and renormalize.
  const hasExplicitWeights =
    options.seedWeights !== undefined && options.seedWeights !== null;
  if (!hasExplicitWeights) {
    let priorTotal = 0;
    for (const [id, s] of seed) {
      const node = graph.nodes.get(id);
      const w =
        node !== undefined &&
        typeof node.weight === "number" &&
        Number.isFinite(node.weight) &&
        node.weight > 0
          ? node.weight
          : 1;
      const biased = s * w;
      seed.set(id, biased);
      priorTotal += biased;
    }
    if (priorTotal > 0) {
      for (const [id, s] of seed) seed.set(id, s / priorTotal);
    }
  }

  const { outgoing, outSum } = buildAdjacency(graph);

  // Initialize rank vector = seed.
  let rank = new Map<string, number>();
  for (const id of graph.nodes.keys()) rank.set(id, seed.get(id) ?? 0);
  // If the seed vector is empty (e.g. graph has no nodes matching seeds
  // AND the uniform fallback was somehow empty — shouldn't happen when
  // n > 0, but defensively): return empty ranking.
  let seedTotal = 0;
  for (const v of seed.values()) seedTotal += v;
  if (seedTotal === 0) {
    return { rankedNodes: [], iterations: 0, converged: true };
  }

  let converged = false;
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const next = new Map<string, number>();

    // Sum of rank on dangling nodes (no outgoing edges) — redistribute
    // proportional to the seed vector to conserve probability mass.
    let danglingMass = 0;
    for (const [id, r] of rank) {
      if ((outSum.get(id) ?? 0) === 0) danglingMass += r;
    }

    // Teleport contribution: (1 - d) * s(v) + d * danglingMass * s(v).
    const teleportScale = 1 - damping + damping * danglingMass;
    for (const [id, s] of seed) {
      next.set(id, (next.get(id) ?? 0) + teleportScale * s);
    }

    // Edge contribution: d * r(u) * w(u,v) / Σ w(u,·).
    for (const [from, edges] of outgoing) {
      const r = rank.get(from) ?? 0;
      if (r === 0) continue;
      const total = outSum.get(from) ?? 0;
      if (total === 0) continue;
      const share = (damping * r) / total;
      for (const { to, weight } of edges) {
        next.set(to, (next.get(to) ?? 0) + share * weight);
      }
    }

    // Compute L1 delta.
    let delta = 0;
    for (const id of graph.nodes.keys()) {
      delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    }

    rank = next;
    if (delta < tolerance) {
      converged = true;
      iter += 1; // record that this iteration completed
      break;
    }
  }

  // Rank and trim.
  const ranked: RankedGraphNode[] = [];
  for (const [id, score] of rank) {
    if (score > 0) ranked.push({ id, score });
  }
  // Sort by descending score, ties broken by id for determinism.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const topK = options.topK;
  let trimmed: RankedGraphNode[];
  if (typeof topK === "number") {
    if (topK <= 0) {
      trimmed = [];
    } else if (topK < ranked.length) {
      trimmed = ranked.slice(0, topK);
    } else {
      trimmed = ranked;
    }
  } else {
    trimmed = ranked;
  }

  return { rankedNodes: trimmed, iterations: iter, converged };
}

// ---------------------------------------------------------------------------
// Type guards (useful for defensive construction from untyped JSON)
// ---------------------------------------------------------------------------

const NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "memory",
  "entity",
  "episode",
  "concept",
  "reflection",
]);

const EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  "references",
  "supersedes",
  "authored-by",
  "mentions",
  "derived-from",
  "temporal-next",
  "related-to",
]);

/** Returns true iff `value` is a valid `NodeType`. */
export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && NODE_TYPES.has(value as NodeType);
}

/** Returns true iff `value` is a valid `EdgeType`. */
export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === "string" && EDGE_TYPES.has(value as EdgeType);
}

// ---------------------------------------------------------------------------
// Edge extraction (issue #559, PR 2 of 5)
// ---------------------------------------------------------------------------

/**
 * Minimum fields the edge extractor reads from a memory record. Structural
 * typing is used so callers can pass any subset of `MemoryFrontmatter`
 * (including richer loaded memories) without a cast.
 *
 * All reference fields are optional — memories written before earlier slices
 * landed will simply contribute no edges for those dimensions.
 */
export interface MemoryEdgeSource {
  /** Stable identifier for the memory (typically the file path). */
  id: string;
  /** Older memory id this memory supersedes (1:1). */
  supersedes?: string;
  /** Parent memory ids this memory was derived from (lineage). */
  lineage?: string[];
  /**
   * Consolidation provenance — `"<memory-id>:<version-number>"` strings.
   * The memory-id portion before the last `:` is used as the edge target.
   */
  derived_from?: string[];
  /** Primary entity reference on the memory (e.g. `person:Jane Doe`). */
  entityRef?: string;
  /** Additional entity references (used by episodes and ledger records). */
  entityRefs?: string[];
  /** Raw memory body — scanned for inline `[Source: ...]` citation blocks. */
  content?: string;
}

/** Options controlling edge extraction. */
export interface ExtractGraphEdgesOptions {
  /**
   * When true, include edges whose `to` endpoint is not present in the
   * provided node index. Defaults to `false` — dangling edges are silently
   * skipped because PPR cannot propagate mass through a missing node.
   */
  includeDanglingEdges?: boolean;
}

/**
 * Regex that matches the `[Source: ...]` citation block emitted by
 * `source-attribution.ts`. Kept local (rather than importing) because the
 * extractor intentionally has no dependency on the citation module's mutable
 * template configuration — it only recognizes the default shape plus minor
 * whitespace / ordering variants.
 */
// Non-greedy quantifiers on classes like `[^\]\n]+?` can be polynomial on
// pathological inputs (CodeQL rule js/polynomial-redos). Using a greedy
// quantifier with a negated character class that also excludes `[` prevents
// nested-bracket inputs from forcing catastrophic backtracking, and the `\s*`
// after `Source:` is bounded by the terminal `]`.
const CITATION_REGEX = /\[Source:([^\]\n[]+)\]/gi;

/**
 * Parse `key=value` pairs out of a citation body. Whitespace-tolerant and
 * case-insensitive: keys are normalized to lowercase so callers can do
 * `fields.agent` without worrying about `[Source: Agent=...]` variants.
 */
function parseCitationFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawPart of body.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * Strip the trailing `:<version>` from a `derived_from` entry. Returns the
 * original string if no colon is present. We intentionally use `lastIndexOf`
 * because memory ids may themselves contain colons (e.g. entity-prefixed
 * ids), but the version suffix — when present — is always the final
 * `:<digits>` segment.
 */
function stripDerivedFromVersion(ref: string): string {
  const colon = ref.lastIndexOf(":");
  if (colon < 0) return ref;
  const tail = ref.slice(colon + 1);
  if (tail.length === 0) return ref.slice(0, colon);
  // Only strip when the tail is purely numeric; otherwise keep the full ref.
  if (/^\d+$/.test(tail)) return ref.slice(0, colon);
  return ref;
}

/**
 * Extract retrieval-graph edges from a collection of memories.
 *
 * Pure function — no I/O, no config access, no time-based side effects.
 * Given the same inputs, always produces the same edges in the same order
 * so dedup downstream is deterministic.
 *
 * Source → target semantics by edge type:
 *
 *   - `supersedes`:    memory → older memory (from `supersedes` field).
 *   - `derived-from`:  memory → each parent in `lineage` OR `derived_from`.
 *   - `mentions`:      memory → each entity in `entityRef` / `entityRefs`.
 *   - `authored-by`:   memory → agent id parsed from inline `[Source: ...]`.
 *
 * `temporal-next`, `references`, `related-to`, and `concept` / `reflection`
 * node synthesis are deferred to later slices — they require either episode
 * sequencing or an abstraction synthesis pass that is out of scope for PR 2.
 *
 * @param memories     Memories to scan. Order is preserved; duplicates are
 *                     not deduped (the caller controls the input set).
 * @param options      Extraction knobs. See `ExtractGraphEdgesOptions`.
 * @returns            A `{ nodes, edges }` pair. `nodes` contains one
 *                     `memory` node per input memory plus one `entity` node
 *                     per distinct entity discovered across all mentions.
 *                     Edges reference ids in the returned node map unless
 *                     `includeDanglingEdges` is set.
 */
export function extractGraphEdges(
  memories: readonly MemoryEdgeSource[],
  options: ExtractGraphEdgesOptions = {},
): { nodes: Map<string, RemnicGraphNode>; edges: RemnicGraphEdge[] } {
  const includeDangling = options.includeDanglingEdges === true;

  const nodes = new Map<string, RemnicGraphNode>();
  const edges: RemnicGraphEdge[] = [];
  // Dedupe within this extraction pass. Key is `${from}\u0000${to}\u0000${type}`
  // — using a NUL separator avoids collisions with ids that contain `|`.
  const seenEdgeKeys = new Set<string>();

  const addNode = (id: string, type: NodeType) => {
    if (!nodes.has(id)) nodes.set(id, { id, type });
  };

  const addEdge = (from: string, to: string, type: EdgeType) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}\u0000${type}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    edges.push({ from, to, type });
  };

  // First pass — register every memory as a node so cross-references can
  // resolve regardless of input ordering.
  for (const memory of memories) {
    if (!memory?.id) continue;
    addNode(memory.id, "memory");
  }

  // Pre-scan every memory for entity / agent references so the
  // memory-target guard can reject ids that are "claimed" by entity
  // mentions in the same batch — regardless of iteration order.
  // Without this, with `includeDanglingEdges: true`, processing
  // `{supersedes: "shared"}` before `{entityRef: "shared"}` would
  // materialize a memory node for "shared" and then the later entity
  // mention would be silently dropped (and vice versa), producing
  // order-dependent output.
  const entityClaimed = new Set<string>();
  for (const memory of memories) {
    if (!memory?.id) continue;
    // Do not mark the memory's own id as entity-claimed just because it
    // carries an entityRef — the memory node takes precedence over its
    // own mention (which is impossible anyway; the edge would be a
    // self-loop and is dropped).
    if (typeof memory.entityRef === "string" && memory.entityRef) {
      if (memory.entityRef !== memory.id) entityClaimed.add(memory.entityRef);
    }
    if (Array.isArray(memory.entityRefs)) {
      for (const ref of memory.entityRefs) {
        if (typeof ref === "string" && ref && ref !== memory.id) {
          entityClaimed.add(ref);
        }
      }
    }
    if (typeof memory.content === "string" && memory.content.length > 0) {
      CITATION_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CITATION_REGEX.exec(memory.content)) !== null) {
        const body = match[1];
        if (!body) continue;
        const agent = parseCitationFields(body).agent;
        if (!agent) continue;
        const agentId = `agent:${agent}`;
        if (agentId !== memory.id) entityClaimed.add(agentId);
      }
    }
  }
  // Ids claimed by both roles (memory + entity) stay memory — an
  // explicit memory node with a given id always wins over an entity
  // mention of the same id in a different memory. Drop any memory ids
  // out of `entityClaimed` so the memory-target guard does not reject
  // cross-memory supersedes / lineage references to them.
  for (const memory of memories) {
    if (memory?.id) entityClaimed.delete(memory.id);
  }

  // Second pass — walk each memory's relationship fields.
  for (const memory of memories) {
    if (!memory?.id) continue;
    const from = memory.id;

    // `supersedes`, `lineage`, and `derived_from` edges must point at a
    // memory node specifically — never an entity / episode / concept /
    // reflection node that happens to share an id. The guard applies
    // regardless of `includeDanglingEdges`:
    //
    //   - If the target is already registered under a non-memory type,
    //     reject the edge (type mismatch).
    //   - If the target will be claimed by an entity mention in this
    //     batch (pre-scan above), reject the edge.
    //   - If the target is not yet known and is not entity-claimed,
    //     accept only when `includeDanglingEdges` is `true`. A new
    //     memory node is registered for the dangling reference.
    //   - If the target is already registered as a memory, accept.
    const canTargetMemory = (id: string): boolean => {
      const existing = nodes.get(id);
      if (existing !== undefined) return existing.type === "memory";
      if (entityClaimed.has(id)) return false;
      return includeDangling;
    };

    // supersedes: memory → older memory
    if (typeof memory.supersedes === "string" && memory.supersedes) {
      const to = memory.supersedes;
      if (canTargetMemory(to)) {
        if (!nodes.has(to)) addNode(to, "memory");
        addEdge(from, to, "supersedes");
      }
    }

    // lineage: memory → each parent memory
    if (Array.isArray(memory.lineage)) {
      for (const parent of memory.lineage) {
        if (typeof parent !== "string" || !parent) continue;
        if (!canTargetMemory(parent)) continue;
        if (!nodes.has(parent)) addNode(parent, "memory");
        addEdge(from, parent, "derived-from");
      }
    }

    // derived_from: memory → parent memory (strip `:<version>` suffix)
    if (Array.isArray(memory.derived_from)) {
      for (const raw of memory.derived_from) {
        if (typeof raw !== "string" || !raw) continue;
        const to = stripDerivedFromVersion(raw);
        if (!to) continue;
        if (!canTargetMemory(to)) continue;
        if (!nodes.has(to)) addNode(to, "memory");
        addEdge(from, to, "derived-from");
      }
    }

    // entityRef / entityRefs: memory → entity. The target must either be
    // absent (we register a new entity node) or already an entity node
    // (no type conflict). If the id is already a memory node, drop the
    // edge rather than mis-typing it — the extractor never mutates an
    // existing node's type.
    const entitySet = new Set<string>();
    if (typeof memory.entityRef === "string" && memory.entityRef) {
      entitySet.add(memory.entityRef);
    }
    if (Array.isArray(memory.entityRefs)) {
      for (const ref of memory.entityRefs) {
        if (typeof ref === "string" && ref) entitySet.add(ref);
      }
    }
    for (const ref of entitySet) {
      const existing = nodes.get(ref);
      if (existing !== undefined && existing.type !== "entity") continue;
      if (!existing) addNode(ref, "entity");
      addEdge(from, ref, "mentions");
    }

    // Inline [Source: agent=..., ...] citations → authored-by edge.
    // Same type-collision guard as the entity block above.
    if (typeof memory.content === "string" && memory.content.length > 0) {
      // Reset the regex's lastIndex on each memory since it is a global regex.
      CITATION_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CITATION_REGEX.exec(memory.content)) !== null) {
        const body = match[1];
        if (!body) continue;
        const fields = parseCitationFields(body);
        const agent = fields.agent;
        if (!agent) continue;
        const agentId = `agent:${agent}`;
        const existing = nodes.get(agentId);
        if (existing !== undefined && existing.type !== "entity") continue;
        if (!existing) addNode(agentId, "entity");
        addEdge(from, agentId, "authored-by");
      }
    }
  }

  return { nodes, edges };
}

/**
 * Build a `RemnicGraph` from a collection of memories by delegating to
 * `extractGraphEdges()`. Convenience wrapper so callers do not have to
 * re-wrap the `{ nodes, edges }` pair into the `RemnicGraph` interface.
 *
 * Pure function — no I/O. Persisting the graph (e.g. writing
 * `~/.remnic/graph.json`) is left to the caller; that decision belongs with
 * the maintenance / consolidation pass in PR 4, not the extractor.
 */
export function buildGraphFromMemories(
  memories: readonly MemoryEdgeSource[],
  options: ExtractGraphEdgesOptions = {},
): RemnicGraph {
  const { nodes, edges } = extractGraphEdges(memories, options);
  return { nodes, edges };
}
