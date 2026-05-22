/**
 * Multi-Graph Memory (MAGMA/SYNAPSE-inspired, v8.2)
 *
 * Maintains three typed edge graphs:
 *   entity.jsonl  — memories sharing a named entity (entityRef)
 *   time.jsonl    — consecutive memories in the same thread/session
 *   causal.jsonl  — memories linked by causal language heuristics
 *
 * Stored under `<memoryDir>/state/graphs/`.
 * All writes are fail-open: errors are caught/logged, never thrown.
 */

import { mkdir, appendFile, readFile } from "node:fs/promises";
import * as path from "path";

import { readEdgeConfidence } from "./graph-edge-reinforcement.js";
import { emitGraphEvent } from "./graph-events.js";

export type GraphType = "entity" | "time" | "causal";

export interface GraphEdge {
  from: string; // relative memory path (e.g. "facts/2026-02-22/abc.md")
  to: string; // relative memory path
  type: GraphType;
  weight: number; // 1.0 default, decay applied during traversal
  label: string; // entity name, threadId, or matched causal phrase
  ts: string; // ISO timestamp of edge creation

  // Issue #681 — edge confidence + reinforcement (PR 1/3: schema + primitive only).
  // Both fields are optional so existing edges without confidence still validate.
  // Treat a missing `confidence` as 1.0 (legacy behavior) at read sites.
  // PR 2/3 wires the maintenance decay job; PR 3/3 weights PageRank traversal by confidence.
  confidence?: number; // [0, 1]; missing = 1.0
  lastReinforcedAt?: string; // ISO timestamp of most recent reinforcement
}

export interface GraphConfig {
  multiGraphMemoryEnabled: boolean;
  entityGraphEnabled: boolean;
  timeGraphEnabled: boolean;
  causalGraphEnabled: boolean;
  maxGraphTraversalSteps: number;
  graphActivationDecay: number;
  maxEntityGraphEdgesPerMemory: number;
  graphLateralInhibitionEnabled: boolean;
  graphLateralInhibitionBeta: number;
  graphLateralInhibitionTopM: number;
  /**
   * Issue #681 PR 3/3 — minimum edge confidence required for traversal.
   * Edges with confidence below this floor are pruned. Legacy edges
   * (no `confidence` field) are treated as 1.0 and always pass.
   * Range `[0, 1]`. Default 0.2.
   */
  graphTraversalConfidenceFloor: number;
  /**
   * Issue #681 PR 3/3 — number of PageRank-style refinement iterations
   * applied on top of BFS activation. Set to 0 to disable refinement
   * and return raw BFS scores. Default 8.
   */
  graphTraversalPageRankIterations: number;
}

/** Default minimum edge confidence required for traversal (issue #681 PR 3/3). */
export const DEFAULT_GRAPH_TRAVERSAL_CONFIDENCE_FLOOR = 0.2;
/** Default PageRank-style refinement iteration count (issue #681 PR 3/3). */
export const DEFAULT_GRAPH_TRAVERSAL_PAGERANK_ITERATIONS = 8;

// Causal signal phrases — order matters (most specific first)
export const CAUSAL_PHRASES = [
  "as a result",
  "led to",
  "because of",
  "therefore",
  "caused",
  "because",
];

export function graphsDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "graphs");
}

export function graphFilePath(memoryDir: string, type: GraphType): string {
  return path.join(graphsDir(memoryDir), `${type}.jsonl`);
}

export async function ensureGraphsDir(memoryDir: string): Promise<void> {
  await mkdir(graphsDir(memoryDir), { recursive: true });
}

// ---------------------------------------------------------------------------
// Per-graph-file write lock (gotcha #40 promise-chain pattern).
//
// Both the append path (`appendEdge`) and the rewrite path used by the
// decay maintenance job must serialize on the same lock keyed by the
// JSONL file path. Without this, an extraction can append a new edge
// between the decay job's read-snapshot and rewrite, silently dropping
// the appended edge during active traffic (issue #729 / Codex P1).
// ---------------------------------------------------------------------------
const graphWriteLocks = new Map<string, Promise<void>>();

/**
 * Run `fn` while holding the write lock for the given graph JSONL file.
 *
 * The lock is keyed by absolute file path so concurrent writes to
 * different graph types proceed independently. The chain recovers from
 * rejection (gotcha #40) so a single I/O failure does not poison all
 * future writers, but the original error is still surfaced to the
 * caller of `withGraphWriteLock`.
 */
export function withGraphWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = graphWriteLocks.get(filePath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  graphWriteLocks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export async function appendEdge(memoryDir: string, edge: GraphEdge): Promise<void> {
  await ensureGraphsDir(memoryDir);
  const filePath = graphFilePath(memoryDir, edge.type);
  const line = JSON.stringify(edge) + "\n";
  await withGraphWriteLock(filePath, async () => {
    await appendFile(filePath, line, "utf8");
  });
  // Emit edge-added event for SSE subscribers (issue #691 PR 5/5).
  // Fail-open: emitGraphEvent catches listener errors so a bad SSE client
  // can never surface into the extraction pipeline.
  emitGraphEvent(memoryDir, "edge-added", {
    source: edge.from,
    target: edge.to,
    kind: edge.type,
    weight: edge.weight,
    label: edge.label,
    confidence: typeof edge.confidence === "number" ? edge.confidence : 1.0,
  });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function parseEdgesJsonl(raw: string, expectedType: GraphType): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isValidGraphEdge(parsed, expectedType)) {
        edges.push(parsed);
      }
    } catch {
      // skip corrupt lines — fail-open for partial JSONL recovery
    }
  }
  return edges;
}

/**
 * Read all edges of a given type from the JSONL file.
 * Returns [] if the file doesn't exist or any read error occurs (fail-open).
 *
 * Production traversal callers (recall/PageRank) depend on this fail-open
 * posture so a temporarily missing or unreadable graph file never blocks
 * a recall. Maintenance jobs that need to distinguish ENOENT from real
 * I/O failures must use {@link readEdgesStrict} instead.
 */
export async function readEdges(memoryDir: string, type: GraphType): Promise<GraphEdge[]> {
  const filePath = graphFilePath(memoryDir, type);
  try {
    const raw = await readFile(filePath, "utf8");
    return parseEdgesJsonl(raw, type);
  } catch {
    return [];
  }
}

/**
 * Same as {@link readEdges} but only swallows `ENOENT`; all other read
 * errors (`EACCES`, `EIO`, …) are propagated. Used by the graph-edge
 * decay maintenance job so I/O outages surface as a failed run instead
 * of being silently reported as "no edges to decay" (issue #729 /
 * Codex P1, line 120).
 */
export async function readEdgesStrict(memoryDir: string, type: GraphType): Promise<GraphEdge[]> {
  const filePath = graphFilePath(memoryDir, type);
  try {
    const raw = await readFile(filePath, "utf8");
    return parseEdgesJsonl(raw, type);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Read edges from all enabled graph types.
 */
export async function readAllEdges(
  memoryDir: string,
  config: Pick<GraphConfig, "entityGraphEnabled" | "timeGraphEnabled" | "causalGraphEnabled">,
): Promise<GraphEdge[]> {
  const parts: GraphEdge[][] = await Promise.all([
    config.entityGraphEnabled ? readEdges(memoryDir, "entity") : Promise.resolve([]),
    config.timeGraphEnabled ? readEdges(memoryDir, "time") : Promise.resolve([]),
    config.causalGraphEnabled ? readEdges(memoryDir, "causal") : Promise.resolve([]),
  ]);
  return parts.flat();
}

export interface GraphHealthFileStats {
  type: GraphType;
  filePath: string;
  exists: boolean;
  totalLines: number;
  validEdges: number;
  corruptLines: number;
  uniqueNodes: number;
}

export interface GraphHealthReport {
  generatedAt: string;
  enabledTypes: GraphType[];
  totals: {
    totalLines: number;
    validEdges: number;
    corruptLines: number;
    uniqueNodes: number;
  };
  files: GraphHealthFileStats[];
  repairGuidance?: string[];
}

function isValidGraphEdge(raw: unknown, expectedType: GraphType): raw is GraphEdge {
  if (!raw || typeof raw !== "object") return false;
  const edge = raw as Record<string, unknown>;
  return (
    edge.type === expectedType &&
    typeof edge.from === "string" && edge.from.length > 0 &&
    typeof edge.to === "string" && edge.to.length > 0 &&
    typeof edge.weight === "number" && Number.isFinite(edge.weight) &&
    typeof edge.label === "string" &&
    typeof edge.ts === "string"
  );
}

export async function analyzeGraphHealth(
  memoryDir: string,
  options?: {
    entityGraphEnabled?: boolean;
    timeGraphEnabled?: boolean;
    causalGraphEnabled?: boolean;
    includeRepairGuidance?: boolean;
  },
): Promise<GraphHealthReport> {
  const enabledTypes: GraphType[] = [];
  if (options?.entityGraphEnabled !== false) enabledTypes.push("entity");
  if (options?.timeGraphEnabled !== false) enabledTypes.push("time");
  if (options?.causalGraphEnabled !== false) enabledTypes.push("causal");

  const files: GraphHealthFileStats[] = [];
  const globalNodes = new Set<string>();

  for (const type of enabledTypes) {
    const filePath = graphFilePath(memoryDir, type);
    let exists = true;
    let totalLines = 0;
    let validEdges = 0;
    let corruptLines = 0;
    const nodes = new Set<string>();

    try {
      const raw = await readFile(filePath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        totalLines += 1;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!isValidGraphEdge(parsed, type)) {
            corruptLines += 1;
            continue;
          }
          validEdges += 1;
          nodes.add(parsed.from);
          nodes.add(parsed.to);
          globalNodes.add(parsed.from);
          globalNodes.add(parsed.to);
        } catch {
          corruptLines += 1;
        }
      }
    } catch {
      exists = false;
    }

    files.push({
      type,
      filePath,
      exists,
      totalLines,
      validEdges,
      corruptLines,
      uniqueNodes: nodes.size,
    });
  }

  const totals = files.reduce(
    (acc, item) => {
      acc.totalLines += item.totalLines;
      acc.validEdges += item.validEdges;
      acc.corruptLines += item.corruptLines;
      return acc;
    },
    {
      totalLines: 0,
      validEdges: 0,
      corruptLines: 0,
      uniqueNodes: globalNodes.size,
    },
  );
  totals.uniqueNodes = globalNodes.size;

  const report: GraphHealthReport = {
    generatedAt: new Date().toISOString(),
    enabledTypes,
    totals,
    files,
  };

  if (options?.includeRepairGuidance === true) {
    const guidance: string[] = [];
    if (totals.corruptLines > 0) {
      guidance.push("Corrupt graph lines detected: back up memory/state/graphs, then rebuild graphs from clean memory replay/extraction runs.");
    }
    if (totals.validEdges === 0) {
      guidance.push("No valid edges detected yet: run normal extraction traffic (or replay ingestion) to seed graph files.");
    }
    if (guidance.length > 0) report.repairGuidance = guidance;
  }

  return report;
}

/**
 * Detect causal signal phrases in text. Returns the first matched phrase, or null.
 */
export function detectCausalPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of CAUSAL_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * GraphIndex — builds and updates the three memory graphs.
 *
 * Usage (orchestrator):
 *   this.graphIndex = new GraphIndex(config.memoryDir, config);
 *
 *   // After each memory write:
 *   await this.graphIndex.onMemoryWritten(memoryPath, frontmatter, threadId, recentInThread);
 */
export class GraphIndex {
  private readonly memoryDir: string;
  private readonly cfg: GraphConfig;

  // Cache for readAllEdges() result.  With 30k+ entity edges (6 MB JSONL) the
  // file read + JSON parse takes 2-4 s per call.  This instance-level cache
  // eliminates that overhead on every spreadingActivation() call; it is
  // invalidated (set to null) in onMemoryWritten() so new edges appear promptly.
  private edgeCache: { allEdges: GraphEdge[]; loadedAt: number } | null = null;
  private static readonly EDGE_CACHE_TTL_MS = 300_000; // 5 minutes

  constructor(memoryDir: string, cfg: GraphConfig) {
    this.memoryDir = memoryDir;
    this.cfg = cfg;
  }

  /** Clear the edge cache so the next spreadingActivation() re-reads from disk.
   *  Call after any code path that appends edges outside of onMemoryWritten(). */
  invalidateEdgeCache(): void {
    this.edgeCache = null;
  }

  private async loadEdgesCached(): Promise<GraphEdge[]> {
    if (
      this.edgeCache &&
      Date.now() - this.edgeCache.loadedAt < GraphIndex.EDGE_CACHE_TTL_MS
    ) {
      return this.edgeCache.allEdges;
    }
    const allEdges = await readAllEdges(this.memoryDir, {
      entityGraphEnabled: this.cfg.entityGraphEnabled,
      timeGraphEnabled: this.cfg.timeGraphEnabled,
      causalGraphEnabled: this.cfg.causalGraphEnabled,
    });
    this.edgeCache = { allEdges, loadedAt: Date.now() };
    return allEdges;
  }

  /**
   * Called after a memory is written to disk.
   *
   * @param memoryPath - relative path from memoryDir (e.g. "facts/2026-02-22/abc.md")
   * @param entityRef  - entityRef frontmatter field (if any)
   * @param content    - full memory text (for causal detection)
   * @param created    - ISO timestamp of this memory
   * @param threadId   - current thread ID (for time graph)
   * @param recentInThread - paths of the N most-recent memories in this thread (for time graph)
   * @param entitySiblings - paths of other memories that share the same entityRef (for entity graph)
   */
  async onMemoryWritten(opts: {
    memoryPath: string;
    entityRef?: string;
    content: string;
    created: string;
    threadId?: string;
    recentInThread?: string[];
    entitySiblings?: string[];
    causalPredecessor?: string;
  }): Promise<void> {
    if (!this.cfg.multiGraphMemoryEnabled) return;
    const ts = new Date().toISOString();

    try {
      // Entity graph
      if (this.cfg.entityGraphEnabled && opts.entityRef && opts.entitySiblings?.length) {
        const siblings = opts.entitySiblings.slice(0, this.cfg.maxEntityGraphEdgesPerMemory);
        for (const sibling of siblings) {
          await appendEdge(this.memoryDir, {
            from: opts.memoryPath,
            to: sibling,
            type: "entity",
            weight: 1.0,
            label: opts.entityRef,
            ts,
          });
        }
      }

      // Time graph — link to most recent memory in same thread
      if (this.cfg.timeGraphEnabled && opts.threadId && opts.recentInThread?.length) {
        const predecessor = opts.recentInThread[opts.recentInThread.length - 1];
        if (predecessor && predecessor !== opts.memoryPath) {
          await appendEdge(this.memoryDir, {
            from: predecessor,
            to: opts.memoryPath,
            type: "time",
            weight: 1.0,
            label: opts.threadId,
            ts,
          });
        }
      }

      // Causal graph
      if (this.cfg.causalGraphEnabled && opts.causalPredecessor) {
        const phrase = detectCausalPhrase(opts.content);
        if (phrase) {
          await appendEdge(this.memoryDir, {
            from: opts.causalPredecessor,
            to: opts.memoryPath,
            type: "causal",
            weight: 1.0,
            label: phrase,
            ts,
          });
        }
      }
    } catch (err) {
      // Fail-open: graph write errors must never surface to caller
      const { log } = await import("./logger.js");
      log.warn(`[graph] onMemoryWritten error: ${err}`);
    } finally {
      // Invalidate edge cache so spreadingActivation() picks up new edges.
      // In `finally` so the cache is cleared even on partial write failure.
      this.edgeCache = null;
    }
  }

  /**
   * Spreading activation BFS (SYNAPSE-inspired).
   *
   * Starting from `seeds`, traverse the combined graph for up to `maxSteps` hops.
   * Each candidate gets an activation score = edge.weight × edgeConfidence × decay^hop.
   *
   * Issue #681 PR 3/3 — confidence-aware traversal:
   *   - Each edge's `weight` is multiplied by its `confidence` (legacy edges
   *     missing `confidence` are treated as 1.0, preserving prior behavior).
   *   - Edges with `confidence < graphTraversalConfidenceFloor` are pruned and
   *     contribute neither activation nor downstream neighbors.
   *   - When `graphTraversalPageRankIterations > 0`, an additional PageRank-
   *     style refinement pass redistributes activation along confidence-weighted
   *     edges, sharpening the ranking among multi-hop candidates.
   *   - Per-result provenance includes the highest-confidence edge that landed
   *     on each candidate, so the X-ray surface can attribute pruning and
   *     ranking decisions back to specific edges.
   *
   * @param seeds    - initial memory paths to expand from (e.g. QMD top results)
   * @param maxSteps - max BFS hops (from config: maxGraphTraversalSteps)
   * @returns Array of {path, score, edgeConfidence, ...} sorted descending, not including seed paths
   */
  async spreadingActivation(
    seeds: string[],
    maxSteps?: number,
    opts?: {
      /**
       * Issue #681 — when `true`, bypasses the configured
       * `graphTraversalConfidenceFloor` and includes low-confidence
       * edges in traversal.  Equivalent to forcing the floor to `0`.
       * Default `false` (floor from config is applied).
       */
      includeLowConfidence?: boolean;
    },
  ): Promise<Array<{
    path: string;
    score: number;
    seed: string;
    hopDepth: number;
    decayedWeight: number;
    graphType: "entity" | "time" | "causal";
    /**
     * Confidence of the edge that produced this candidate's recorded
     * provenance (the strongest edge along the chosen entry path).
     * In `[0, 1]`. Legacy edges without `confidence` surface as 1.0.
     */
    edgeConfidence: number;
  }>> {
    if (!this.cfg.multiGraphMemoryEnabled) return [];
    const steps = maxSteps ?? this.cfg.maxGraphTraversalSteps;
    const decay = this.cfg.graphActivationDecay;
    // When `includeLowConfidence` is set, use floor=0 so all edges
    // participate in traversal regardless of their decay state.
    // Otherwise clamp the configured floor into [0, 1] so misconfiguration
    // cannot (a) admit edges with negative confidence or (b) reject every
    // edge.
    const floor = opts?.includeLowConfidence === true
      ? 0
      : clampConfidenceFloor(this.cfg.graphTraversalConfidenceFloor);
    const iterations = clampPageRankIterations(
      this.cfg.graphTraversalPageRankIterations,
    );

    try {
      const allEdges = await this.loadEdgesCached();

      // Build adjacency index: from → edges, to → edges (bidirectional for entity/time, directional for causal).
      // Edges below the confidence floor are pruned at index time so neither
      // direct activation nor downstream BFS expansion can re-introduce them.
      const adj = new Map<string, GraphEdge[]>();
      for (const edge of allEdges) {
        const conf = readEdgeConfidence(edge);
        if (conf < floor) continue;
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        adj.get(edge.from)!.push(edge);
        // Entity and time edges are bidirectional
        if (edge.type !== "causal") {
          if (!adj.has(edge.to)) adj.set(edge.to, []);
          adj.get(edge.to)!.push({ ...edge, from: edge.to, to: edge.from });
        }
      }

      const seedSet = new Set(seeds);
      const scores = new Map<string, number>(); // candidate path → accumulated activation score
      const provenance = new Map<
        string,
        {
          seed: string;
          hopDepth: number;
          decayedWeight: number;
          graphType: "entity" | "time" | "causal";
          edgeConfidence: number;
        }
      >();
      const visited = new Set<string>(seeds);

      // BFS queue: [nodePath, hop, seedPath]
      const queue: Array<[string, number, string]> = seeds.map((s) => [s, 0, s]);

      while (queue.length > 0) {
        const [node, hop, sourceSeed] = queue.shift()!;
        if (hop >= steps) continue;

        const edges = adj.get(node) ?? [];
        for (const edge of edges) {
          const neighbor = edge.to === node ? edge.from : edge.to;
          const conf = readEdgeConfidence(edge);
          // Defense in depth: the adjacency build already drops sub-floor
          // edges, but if a synthesized reverse edge ever bypassed that
          // path, this guard keeps spreading activation honest.
          if (conf < floor) continue;
          const score = edge.weight * conf * Math.pow(decay, hop + 1);

          if (!seedSet.has(neighbor)) {
            const existing = scores.get(neighbor) ?? 0;
            scores.set(neighbor, existing + score);

            const prev = provenance.get(neighbor);
            if (
              !prev ||
              hop + 1 < prev.hopDepth ||
              (hop + 1 === prev.hopDepth && score > prev.decayedWeight)
            ) {
              provenance.set(neighbor, {
                seed: sourceSeed,
                hopDepth: hop + 1,
                decayedWeight: score,
                graphType: edge.type,
                edgeConfidence: conf,
              });
            }
          }

          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([neighbor, hop + 1, sourceSeed]);
          }
        }
      }

      // Issue #681 PR 3/3 — optional PageRank-style refinement.
      // Redistributes a node's accumulated activation along its outgoing
      // edges, weighted by edge confidence. Damping is fixed at the
      // canonical 0.85 so the ranking stays comparable across queries;
      // the `iterations` knob bounds compute, not behavior shape.
      if (iterations > 0 && scores.size > 1) {
        applyPageRankRefinement(scores, adj, {
          iterations,
          floor,
          damping: 0.85,
        });
      }

      // Apply lateral inhibition if enabled (Synapse-inspired competitive suppression)
      if (this.cfg.graphLateralInhibitionEnabled && scores.size > 1) {
        const inhibited = applyLateralInhibition(scores, {
          beta: this.cfg.graphLateralInhibitionBeta,
          topM: this.cfg.graphLateralInhibitionTopM,
        });
        for (const [k, v] of inhibited) {
          scores.set(k, v);
        }
      }

      return Array.from(scores.entries())
        .map(([p, score]) => ({
          path: p,
          score,
          seed: provenance.get(p)?.seed ?? "",
          hopDepth: provenance.get(p)?.hopDepth ?? 0,
          decayedWeight: provenance.get(p)?.decayedWeight ?? 0,
          graphType: provenance.get(p)?.graphType ?? "entity",
          edgeConfidence: provenance.get(p)?.edgeConfidence ?? 1,
        }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      const { log } = await import("./logger.js");
      log.warn(`[graph] spreadingActivation error: ${err}`);
      return [];
    }
  }
}

/**
 * Clamp `graphTraversalConfidenceFloor` into the legal range `[0, 1]`.
 * Non-finite or non-numeric values fall back to the documented default
 * so misconfiguration cannot silently disable the floor or reject every edge.
 *
 * Exported for tests; call sites in `spreadingActivation` use it to make
 * the contract explicit at every boundary.
 */
export function clampConfidenceFloor(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_GRAPH_TRAVERSAL_CONFIDENCE_FLOOR;
  }
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Clamp `graphTraversalPageRankIterations` into a non-negative integer.
 * Negative or non-finite values fall back to 0 (disable refinement) so
 * misconfiguration cannot stall recall in an unbounded loop.
 */
export function clampPageRankIterations(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * PageRank-style refinement on top of the BFS activation map.
 *
 * Each iteration redistributes a fraction of every node's score along
 * its outgoing edges, scaled by edge confidence. Confidence below
 * `floor` is filtered out before redistribution, mirroring the BFS
 * pruning rule. Mutates `scores` in place.
 *
 * Exported for tests; in production, call sites pass the same adjacency
 * map already used by BFS so behavior stays consistent.
 */
export function applyPageRankRefinement(
  scores: Map<string, number>,
  adj: Map<string, GraphEdge[]>,
  opts: { iterations: number; floor: number; damping: number },
): void {
  const { iterations, floor, damping } = opts;
  if (iterations <= 0 || scores.size === 0) return;
  const safeDamping = Math.min(1, Math.max(0, damping));

  // Pre-compute confidence-weighted out-edge totals for normalization.
  // Done once per refinement, not per iteration, since adjacency is
  // immutable inside the loop.
  //
  // Codex P1 (#735): the denominator MUST be computed over the same
  // eligible-neighbor set the iteration redistributes into — i.e.
  // edges whose neighbor is in `scores`. Counting edges-to-seeds (or
  // edges-to-unseen-nodes) in the denominator while dropping their
  // flow during iteration leaks `safeDamping × score` every pass and
  // collapses leaf candidates' scores instead of just re-ranking them.
  const eligible = (edge: GraphEdge, fromNode: string): boolean => {
    if (readEdgeConfidence(edge) < floor) return false;
    const neighbor = edge.to === fromNode ? edge.from : edge.to;
    return scores.has(neighbor);
  };
  const outboundTotal = new Map<string, number>();
  for (const [node, edges] of adj.entries()) {
    if (!scores.has(node)) continue; // only candidate nodes redistribute
    let sum = 0;
    for (const edge of edges) {
      if (!eligible(edge, node)) continue;
      sum += readEdgeConfidence(edge) * edge.weight;
    }
    if (sum > 0) outboundTotal.set(node, sum);
  }

  for (let i = 0; i < iterations; i += 1) {
    const next = new Map<string, number>();
    // Teleport / damping floor: every node retains `(1 - damping) * score`
    // of its current activation so dangling nodes do not bleed to zero.
    for (const [node, score] of scores) {
      next.set(node, (1 - safeDamping) * score);
    }
    for (const [node, score] of scores) {
      const outEdges = adj.get(node);
      const total = outboundTotal.get(node);
      // Dangling-node fallback: when a candidate has zero eligible
      // outflow (no in-scores neighbors above the floor), the
      // `safeDamping × score` portion would otherwise evaporate. Keep
      // it on `node` so total mass is conserved and the score reflects
      // the candidate's standing rather than its in-degree topology.
      if (!outEdges || outEdges.length === 0 || !total || total <= 0) {
        next.set(node, (next.get(node) ?? 0) + safeDamping * score);
        continue;
      }
      for (const edge of outEdges) {
        if (!eligible(edge, node)) continue;
        const conf = readEdgeConfidence(edge);
        const neighbor = edge.to === node ? edge.from : edge.to;
        const flow = safeDamping * score * ((conf * edge.weight) / total);
        next.set(neighbor, (next.get(neighbor) ?? 0) + flow);
      }
    }
    for (const [node, score] of next) {
      scores.set(node, score);
    }
  }
}

/**
 * Lateral inhibition (Synapse-inspired).
 *
 * For each node, the top-M higher-activation competitors exert inhibition
 * proportional to their activation difference. Output is clamped to [0, ∞).
 *
 * No sigmoid is applied here — downstream `normalizeGraphActivationScore`
 * already applies x/(1+x) soft squash, so adding a sigmoid would double-
 * normalize and cap graph influence at ~50%.
 *
 * Formula: u_hat_i = max(0, u_i - beta * sum_{k in top-M where u_k > u_i}(u_k - u_i))
 *
 * When beta=0 or topM=0, returns original scores unchanged (no-op).
 */
export function applyLateralInhibition(
  scores: Map<string, number>,
  opts: { beta: number; topM: number },
): Map<string, number> {
  const { beta, topM } = opts;
  if (beta === 0 || topM === 0) return new Map(scores);

  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const topCompetitors = sorted.slice(0, topM);

  const result = new Map<string, number>();
  for (const [node, u] of scores) {
    let inhibition = 0;
    for (const [, uK] of topCompetitors) {
      if (uK > u) {
        inhibition += uK - u;
      }
    }
    result.set(node, Math.max(0, u - beta * inhibition));
  }

  return result;
}
