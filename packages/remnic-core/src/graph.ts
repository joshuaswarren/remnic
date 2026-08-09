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

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { readEdgeConfidence } from "./graph-edge-reinforcement.js";
import { emitGraphEvent } from "./graph-events.js";
import type { GraphConstructionCapabilitySet } from "./capabilities.js";

export type GraphType = "entity" | "time" | "causal";

export interface ActivationPath {
  /** Node ids from the seed (inclusive) to the reached node (inclusive). */
  nodeIds: string[];
  /** Edge confidences, parallel to the hops in {@link nodeIds}. */
  edgeConfidences: number[];
  /** Graph types, parallel to the hops in {@link nodeIds}. */
  graphTypes: GraphType[];
}

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
  /**
   * Issue #1904 — incremental GraphIndex edge cache. When true (the default,
   * and the value when omitted), a single-writer edge append is pushed into the
   * warm edge cache in place (revalidated by file size for cross-process
   * coherence) instead of nulling the cache and paying a full 6 MB re-read +
   * parse on the next traversal. Set false to restore the pre-#1904
   * null-on-every-write behavior. Optional here (unlike the required
   * PluginConfig field parseConfig always sets) so GraphConfig can still be
   * constructed directly with a partial config; only an explicit `false` opts
   * out, so an omitted field keeps the incremental default.
   */
  graphEdgeCacheIncrementalEnabled?: boolean;
}

/** Default minimum edge confidence required for traversal (issue #681 PR 3/3). */
export const DEFAULT_GRAPH_TRAVERSAL_CONFIDENCE_FLOOR = 0.2;
/** Default PageRank-style refinement iteration count (issue #681 PR 3/3). */
export const DEFAULT_GRAPH_TRAVERSAL_PAGERANK_ITERATIONS = 8;

// Causal signal phrases — order matters (most specific first)
export const CAUSAL_PHRASES = ["as a result", "led to", "because of", "therefore", "caused", "because"];

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
      () => undefined
    )
  );
  return next;
}

export async function appendEdge(memoryDir: string, edge: GraphEdge): Promise<void> {
  await ensureGraphsDir(memoryDir);
  const filePath = graphFilePath(memoryDir, edge.type);
  const line = `${JSON.stringify(edge)}\n`;
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
  graphCaps: Pick<GraphConstructionCapabilitySet, "entityGraph" | "timeGraph" | "causalGraph">,
): Promise<GraphEdge[]> {
  const parts: GraphEdge[][] = await Promise.all([
    graphCaps.entityGraph ? readEdges(memoryDir, "entity") : Promise.resolve([]),
    graphCaps.timeGraph ? readEdges(memoryDir, "time") : Promise.resolve([]),
    graphCaps.causalGraph ? readEdges(memoryDir, "causal") : Promise.resolve([]),
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
    typeof edge.from === "string" &&
    edge.from.length > 0 &&
    typeof edge.to === "string" &&
    edge.to.length > 0 &&
    typeof edge.weight === "number" &&
    Number.isFinite(edge.weight) &&
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
  }
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
    }
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
      guidance.push(
        "Corrupt graph lines detected: back up memory/state/graphs, then rebuild graphs from clean memory replay/extraction runs."
      );
    }
    if (totals.validEdges === 0) {
      guidance.push(
        "No valid edges detected yet: run normal extraction traffic (or replay ingestion) to seed graph files."
      );
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
/**
 * Identity of one graph JSONL file used to validate the incremental edge cache
 * (issue #1904). An absent file (ENOENT) is recorded as the all-zero sentinel
 * `{ size: 0, mtimeMs: 0, ino: 0 }` so a later peer creation (ino becomes
 * non-zero) is detected as a change.
 */
interface GraphFileMeta {
  size: number;
  mtimeMs: number;
  ino: number;
}

interface ActivationPredecessor {
  prev: string;
  edgeConfidence: number;
  graphType: GraphType;
}


function reconstructActivationPath(
  seed: string,
  candidate: string,
  predecessors: Map<string, ActivationPredecessor>,
  maxSteps: number,
): ActivationPath | null {
  const nodeIds = [candidate];
  const edgeConfidences: number[] = [];
  const graphTypes: GraphType[] = [];
  let current = candidate;
  const stepCap = Number.isFinite(maxSteps)
    ? Math.max(0, Math.ceil(maxSteps))
    : predecessors.size + 1;
  for (let step = 0; step < stepCap && current !== seed; step += 1) {
    const predecessor = predecessors.get(`${seed}\0${current}`);
    if (!predecessor) return null;
    nodeIds.push(predecessor.prev);
    edgeConfidences.push(predecessor.edgeConfidence);
    graphTypes.push(predecessor.graphType);
    current = predecessor.prev;
  }

  if (current !== seed) return null;
  nodeIds.reverse();
  edgeConfidences.reverse();
  graphTypes.reverse();
  if (edgeConfidences.length !== nodeIds.length - 1 || graphTypes.length !== nodeIds.length - 1) {
    return null;
  }
  return { nodeIds, edgeConfidences, graphTypes };
}

export class GraphIndex {
  private readonly memoryDir: string;
  private readonly cfg: GraphConfig;

  // Cache for readAllEdges() result.  With 30k+ entity edges (6 MB JSONL) the
  // file read + JSON parse takes 2-4 s per call.  This instance-level cache
  // eliminates that overhead on every spreadingActivation() call; it is
  // invalidated (set to null) in onMemoryWritten() so new edges appear promptly.
  private edgeCache: {
    allEdges: GraphEdge[];
    loadedAt: number;
    // Per-file identity of each enabled graph file observed at load (issue
    // #1904). An incremental push is trusted only when every file's identity is
    // explained entirely by OUR own append: size grows by exactly the bytes we
    // appended and the inode is unchanged (a local append keeps the inode; an
    // external atomic temp+rename rewrite — e.g. the edge-decay job — changes
    // it). Untouched files must match size AND mtime AND inode exactly. This
    // closes the size-only holes Codex flagged: a peer append racing cache
    // construction, and an equal-length atomic rewrite (e.g. confidence
    // 0.9->0.8) that preserves byte length. Any divergence forces a full reload.
    meta: Partial<Record<GraphType, GraphFileMeta>>;
  } | null = null;
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
    if (this.edgeCache && Date.now() - this.edgeCache.loadedAt < GraphIndex.EDGE_CACHE_TTL_MS) {
      return this.edgeCache.allEdges;
    }
    // Consistent snapshot (issue #1904, Codex): capture file identity BEFORE and
    // AFTER reading edges and retry if it changed, so `allEdges` and the recorded
    // `meta` baseline reflect the SAME on-disk state. Without this a peer append
    // landing mid-read would leave the cache holding edges that exclude the peer
    // edge while the baseline already counts its bytes — a later local append
    // would then pass the size-delta check and silently omit the peer edge.
    let allEdges: GraphEdge[] = [];
    let meta = await this.readEnabledGraphFileMeta();
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = meta;
      allEdges = await readAllEdges(this.memoryDir, {
        entityGraph: this.cfg.entityGraphEnabled,
        timeGraph: this.cfg.timeGraphEnabled,
        causalGraph: this.cfg.causalGraphEnabled,
      });
      meta = await this.readEnabledGraphFileMeta();
      if (this.graphFileMetaEqual(before, meta)) {
        stable = true;
        break;
      }
      // A write landed during the read; the just-captured `meta` is the new
      // baseline for the next attempt's before-snapshot.
    }
    if (stable) {
      this.edgeCache = { allEdges, loadedAt: Date.now(), meta };
    } else {
      // Contended: a peer kept writing across every attempt, so the final
      // allEdges/meta pair is not guaranteed consistent. Serve THIS read's edges
      // (best effort) but do NOT poison the cache — leave it null so the next
      // call re-reads, instead of installing a baseline that could hide a peer
      // edge for the TTL (Codex).
      this.edgeCache = null;
    }
    return allEdges;
  }

  /**
   * Identity ({ size, mtimeMs, ino }) of each ENABLED graph file (issue #1904).
   * Missing files (ENOENT) and any stat error map to the all-zero sentinel so
   * the baseline is fail-open: a later revalidation sees a mismatch (or a peer
   * creation flipping ino from 0 to non-zero) and forces a full reload rather
   * than trusting a stale incremental push.
   */
  private async readEnabledGraphFileMeta(): Promise<Partial<Record<GraphType, GraphFileMeta>>> {
    const enabled: GraphType[] = [];
    if (this.cfg.entityGraphEnabled) enabled.push("entity");
    if (this.cfg.timeGraphEnabled) enabled.push("time");
    if (this.cfg.causalGraphEnabled) enabled.push("causal");
    const meta: Partial<Record<GraphType, GraphFileMeta>> = {};
    for (const type of enabled) {
      try {
        const st = await stat(graphFilePath(this.memoryDir, type));
        meta[type] = { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) };
      } catch {
        meta[type] = { size: 0, mtimeMs: 0, ino: 0 };
      }
    }
    return meta;
  }

  /** True iff both metadata maps carry identical identity for every key. */
  private graphFileMetaEqual(
    a: Partial<Record<GraphType, GraphFileMeta>>,
    b: Partial<Record<GraphType, GraphFileMeta>>,
  ): boolean {
    const types: GraphType[] = ["entity", "time", "causal"];
    for (const type of types) {
      const x = a[type];
      const y = b[type];
      if (!x && !y) continue;
      if (!x || !y) return false;
      if (x.size !== y.size || x.mtimeMs !== y.mtimeMs || x.ino !== y.ino) return false;
    }
    return true;
  }

  /**
   * Re-stat every graph file whose identity the cache just committed and return
   * false if any has moved since (issue #1904, Codex). Closes the validation→
   * in-place-push TOCTOU window: a peer process (concurrent CLI / daemon /
   * decay job) can append between edgeFilesUnchangedExceptOurAppends()'s final
   * stat and the allEdges.push(...). Without this re-check the cache would be
   * accepted with identity predating the peer write and miss the peer edge for
   * the TTL. A residual infinitesimal window (peer writes during this re-stat)
   * remains and is TTL-bounded.
   */
  private async edgeCacheIdentityUnchangedSinceCommit(): Promise<boolean> {
    if (!this.edgeCache) return false;
    for (const type of Object.keys(this.edgeCache.meta) as GraphType[]) {
      const committed = this.edgeCache.meta[type];
      if (!committed) continue;
      let cur: GraphFileMeta;
      try {
        const st = await stat(graphFilePath(this.memoryDir, type));
        cur = { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          cur = { size: 0, mtimeMs: 0, ino: 0 };
        } else {
          return false;
        }
      }
      if (
        cur.size !== committed.size ||
        cur.mtimeMs !== committed.mtimeMs ||
        cur.ino !== committed.ino
      ) {
        return false;
      }
    }
    return true;
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
    /**
     * Optional frozen gate overrides (from GraphConstructionCapabilitySet).
     * When provided, these take precedence over `this.cfg` so the caller's
     * operation-scoped snapshot is the single source of truth (#1566).
     */
    graphCapsOverride?: {
      entityGraph: boolean;
      timeGraph: boolean;
      causalGraph: boolean;
      multiGraphMemory: boolean;
    };
  }): Promise<void> {
    const g = opts.graphCapsOverride;
    const multiGraphOn = g ? g.multiGraphMemory : this.cfg.multiGraphMemoryEnabled;
    if (!multiGraphOn) return;
    const entityOn = g ? g.entityGraph : this.cfg.entityGraphEnabled;
    const timeOn = g ? g.timeGraph : this.cfg.timeGraphEnabled;
    const causalOn = g ? g.causalGraph : this.cfg.causalGraphEnabled;
    const ts = new Date().toISOString();
    // Collect the edges appended this call so a coherent single-writer push can
    // extend the warm edge cache in place instead of nulling it (issue #1904).
    const appended: GraphEdge[] = [];

    try {
      // Entity graph
      if (entityOn && opts.entityRef && opts.entitySiblings?.length) {
        const siblings = opts.entitySiblings.slice(0, this.cfg.maxEntityGraphEdgesPerMemory);
        for (const sibling of siblings) {
          const edge: GraphEdge = {
            from: opts.memoryPath,
            to: sibling,
            type: "entity",
            weight: 1.0,
            label: opts.entityRef,
            ts,
          };
          appended.push(edge);
          await appendEdge(this.memoryDir, edge);
        }
      }

      // Time graph — link to most recent memory in same thread
      if (timeOn && opts.threadId && opts.recentInThread?.length) {
        const predecessor = opts.recentInThread[opts.recentInThread.length - 1];
        if (predecessor && predecessor !== opts.memoryPath) {
          const edge: GraphEdge = {
            from: predecessor,
            to: opts.memoryPath,
            type: "time",
            weight: 1.0,
            label: opts.threadId,
            ts,
          };
          appended.push(edge);
          await appendEdge(this.memoryDir, edge);
        }
      }

      // Causal graph
      if (causalOn && opts.causalPredecessor) {
        const phrase = detectCausalPhrase(opts.content);
        if (phrase) {
          const edge: GraphEdge = {
            from: opts.causalPredecessor,
            to: opts.memoryPath,
            type: "causal",
            weight: 1.0,
            label: phrase,
            ts,
          };
          appended.push(edge);
          await appendEdge(this.memoryDir, edge);
        }
      }
    } catch (err) {
      // Fail-open: graph write errors must never surface to caller
      const { log } = await import("./logger.js");
      log.warn(`[graph] onMemoryWritten error: ${err}`);
    } finally {
      // Edge-cache coherence (issue #1904). Legacy behavior nulled the cache on
      // every write, paying a 2-4 s full re-read + parse on the next traversal.
      if (!this.edgeCache || Date.now() - this.edgeCache.loadedAt >= GraphIndex.EDGE_CACHE_TTL_MS) {
        // Nothing warm, or the entry is past its 5-min TTL backstop — reload.
        this.edgeCache = null;
      } else if (this.cfg.graphEdgeCacheIncrementalEnabled === false) {
        // Rollback lever: restore the pre-#1904 null-on-every-write behavior.
        this.edgeCache = null;
      } else {
        // Trust an in-place push ONLY when WE are the sole writer since load:
        // every enabled graph file's on-disk size must equal our baseline plus
        // exactly the bytes we appended to it. A divergence means a peer process
        // (backup daemon / CLI / decay job) also wrote — force a full reload for
        // cross-process coherence. Any stat error fails open to a full reload.
        try {
          if (await this.edgeFilesUnchangedExceptOurAppends(appended)) {
            if (appended.length > 0) {
              this.edgeCache.allEdges.push(...appended);
              // Close the validation→push TOCTOU window (#1904, Codex): a peer
              // process can append between the validation stat above and this
              // in-place push. Re-verify every committed identity; if any file
              // moved, the cache would miss the peer edge for the TTL, so null
              // it and let the next traversal reload. (Skipped when this call
              // pushed nothing — no new window was opened, and the validation
              // already confirmed no peer wrote.)
              if (this.edgeCache && !(await this.edgeCacheIdentityUnchangedSinceCommit())) {
                this.edgeCache = null;
              }
            }
          } else {
            this.edgeCache = null;
          }
        } catch {
          this.edgeCache = null;
        }
      }
    }
  }

  /**
   * Cross-process coherence check for the incremental edge cache (issue #1904).
   *
   * Returns true iff every ENABLED graph file's current identity is explained
   * ENTIRELY by THIS call's own append — no other process wrote to any graph
   * file since load. Per file:
   *   - inode must be unchanged. A local append (`appendFile`) keeps the inode;
   *     an external atomic temp+rename rewrite (e.g. the edge-decay job) changes
   *     it, so an inode change — even one that preserves byte length, such as
   *     decaying confidence 0.9->0.8 — forces a reload (Codex).
   *   - a file WE appended to (delta > 0): size must equal baseline + our exact
   *     appended bytes. If it was absent at load (sentinel ino 0), our append
   *     created it, so we accept size === delta and adopt the new identity.
   *   - a file we did NOT touch (delta 0): size AND mtime must be unchanged, so
   *     an in-place equal-length rewrite (mtime bump) or a peer append (size
   *     bump) both force a reload.
   * On success it commits the new identity baseline so the next append
   * revalidates against post-this-write truth. Fail-open: an unreadable file
   * (non-ENOENT) returns false, forcing a full reload.
   */
  private async edgeFilesUnchangedExceptOurAppends(appended: GraphEdge[]): Promise<boolean> {
    if (!this.edgeCache) return false;
    const expectedDelta: Partial<Record<GraphType, number>> = {};
    for (const edge of appended) {
      const bytes = Buffer.byteLength(`${JSON.stringify(edge)}\n`, "utf8");
      expectedDelta[edge.type] = (expectedDelta[edge.type] ?? 0) + bytes;
    }
    const enabled: GraphType[] = [];
    if (this.cfg.entityGraphEnabled) enabled.push("entity");
    if (this.cfg.timeGraphEnabled) enabled.push("time");
    if (this.cfg.causalGraphEnabled) enabled.push("causal");
    const observed: Partial<Record<GraphType, GraphFileMeta>> = {};
    for (const type of enabled) {
      let cur: GraphFileMeta;
      try {
        const st = await stat(graphFilePath(this.memoryDir, type));
        cur = { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) };
      } catch (err) {
        // An absent graph file (ENOENT) is the normal partially-populated state
        // (e.g. entity edges written before any causal edge): treat it as the
        // all-zero sentinel so the incremental cache stays warm. Only a genuine
        // stat failure forces a full reload (#1904, Codex).
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          cur = { size: 0, mtimeMs: 0, ino: 0 };
        } else {
          return false;
        }
      }
      const base = this.edgeCache.meta[type] ?? { size: 0, mtimeMs: 0, ino: 0 };
      const delta = expectedDelta[type] ?? 0;
      if (delta > 0) {
        if (base.ino === 0) {
          // File was absent at load; our append created it. Accept iff its whole
          // size is exactly our appended bytes (nothing else wrote it).
          if (cur.ino === 0 || cur.size !== delta) return false;
        } else {
          // Existing file: our append keeps the inode and grows size by exactly
          // our bytes. An atomic rewrite (ino change) or a peer append (size
          // mismatch) both fail here.
          if (cur.ino !== base.ino || cur.size !== base.size + delta) return false;
        }
      } else {
        // Untouched file: identity must be byte-for-byte unchanged.
        if (cur.ino !== base.ino || cur.size !== base.size || cur.mtimeMs !== base.mtimeMs) {
          return false;
        }
      }
      observed[type] = cur;
    }
    this.edgeCache.meta = observed;
    return true;
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
      /** Record one shortest seed-to-candidate path in each result. */
      recordPaths?: boolean;
      /** Absolute deadline in ms-since-epoch for post-retrieval assembly. */
      deadlineAtMs?: number;
    }
  ): Promise<
    Array<{
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
      activationPath?: ActivationPath | null;
    }>
  > {
    if (!this.cfg.multiGraphMemoryEnabled) return [];
    const steps = maxSteps ?? this.cfg.maxGraphTraversalSteps;
    const decay = this.cfg.graphActivationDecay;
    // When `includeLowConfidence` is set, use floor=0 so all edges
    // participate in traversal regardless of their decay state.
    // Otherwise clamp the configured floor into [0, 1] so misconfiguration
    // cannot (a) admit edges with negative confidence or (b) reject every
    // edge.
    const floor =
      opts?.includeLowConfidence === true ? 0 : clampConfidenceFloor(this.cfg.graphTraversalConfidenceFloor);
    const iterations = clampPageRankIterations(this.cfg.graphTraversalPageRankIterations);
    const recordPaths = opts?.recordPaths === true;
    const deadlineAtMs = opts?.deadlineAtMs;
    const deadlineExpired = (): boolean =>
      typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs;

    try {
      if (deadlineExpired()) return [];
      const allEdges = await this.loadEdgesCached();
      if (deadlineExpired()) return [];

      // Build adjacency index: from → edges, to → edges (bidirectional for entity/time, directional for causal).
      // Edges below the confidence floor are pruned at index time so neither
      // direct activation nor downstream BFS expansion can re-introduce them.
      const adj = new Map<string, GraphEdge[]>();
      for (let i = 0; i < allEdges.length; i += 1) {
        if ((i & 1023) === 0 && deadlineExpired()) return [];
        const edge = allEdges[i];
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
      let frontier = new Map<string, { node: string; seed: string; activation: number }>();
      const reachedBySeed = new Map<string, Set<string>>();
      const predecessors = recordPaths ? new Map<string, ActivationPredecessor>() : null;
      for (const seed of seeds) {
        frontier.set(`${seed}\0${seed}`, { node: seed, seed, activation: 1 });
        reachedBySeed.set(seed, new Set([seed]));
      }
      const finalizeScores = () => {
        const results = Array.from(scores.entries())
          .map(([p, score]) => ({
            path: p,
            score,
            seed: provenance.get(p)?.seed ?? "",
            hopDepth: provenance.get(p)?.hopDepth ?? 0,
            decayedWeight: provenance.get(p)?.decayedWeight ?? 0,
            graphType: provenance.get(p)?.graphType ?? "entity",
            edgeConfidence: provenance.get(p)?.edgeConfidence ?? 1,
          }))
          .sort((a, b) => {
            const scoreDelta = b.score - a.score;
            if (scoreDelta !== 0 || !recordPaths) return scoreDelta;
            return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
          });
        if (!recordPaths || !predecessors) return results;
        return results.map((result) => {
          const seed = provenance.get(result.path)?.seed;
          return {
            ...result,
            activationPath:
              seed === undefined ? null : reconstructActivationPath(seed, result.path, predecessors, steps),
          };
        });
      };

      for (let hop = 0; hop < steps && frontier.size > 0; hop++) {
        if (deadlineExpired()) return finalizeScores();
        const nextFrontier = new Map<string, { node: string; seed: string; activation: number }>();

        for (const { node, seed: sourceSeed, activation } of frontier.values()) {
          const edges = adj.get(node) ?? [];
          for (let i = 0; i < edges.length; i += 1) {
            if ((i & 1023) === 0 && deadlineExpired()) return finalizeScores();
            const edge = edges[i];
            const neighbor = edge.to === node ? edge.from : edge.to;
            const conf = readEdgeConfidence(edge);
            // Defense in depth: the adjacency build already drops sub-floor
            // edges, but if a synthesized reverse edge ever bypassed that
            // path, this guard keeps spreading activation honest.
            if (conf < floor) continue;
            const score = activation * edge.weight * conf * decay;
            const reachedForSeed = reachedBySeed.get(sourceSeed);
            if (reachedForSeed?.has(neighbor)) {
              continue;
            }
            if (recordPaths && predecessors && !seedSet.has(neighbor)) {
              const key = `${sourceSeed}\0${neighbor}`;
              if (!predecessors.has(key)) {
                predecessors.set(key, {
                  prev: node,
                  edgeConfidence: conf,
                  graphType: edge.type,
                });
              }
            }

            if (!seedSet.has(neighbor)) {
              const existing = scores.get(neighbor) ?? 0;
              scores.set(neighbor, existing + score);

              const prev = provenance.get(neighbor);
              if (!prev || hop + 1 < prev.hopDepth || (hop + 1 === prev.hopDepth && score > prev.decayedWeight)) {
                provenance.set(neighbor, {
                  seed: sourceSeed,
                  hopDepth: hop + 1,
                  decayedWeight: score,
                  graphType: edge.type,
                  edgeConfidence: conf,
                });
              }

              if (hop + 1 < steps) {
                const frontierKey = `${sourceSeed}\0${neighbor}`;
                const existingFrontier = nextFrontier.get(frontierKey);
                if (existingFrontier) {
                  existingFrontier.activation += score;
                } else {
                  nextFrontier.set(frontierKey, {
                    node: neighbor,
                    seed: sourceSeed,
                    activation: score,
                  });
                }
              }
            }
          }
        }

        for (const { node, seed } of nextFrontier.values()) {
          reachedBySeed.get(seed)?.add(node);
        }
        frontier = nextFrontier;
      }

      // Issue #681 PR 3/3 — optional PageRank-style refinement.
      // Redistributes a node's accumulated activation along its outgoing
      // edges, weighted by edge confidence. Damping is fixed at the
      // canonical 0.85 so the ranking stays comparable across queries;
      // the `iterations` knob bounds compute, not behavior shape.
      if (!deadlineExpired() && iterations > 0 && scores.size > 1) {
        applyPageRankRefinement(scores, adj, {
          iterations,
          floor,
          damping: 0.85,
          deadlineAtMs,
        });
      }

      // Apply lateral inhibition if enabled (Synapse-inspired competitive suppression)
      if (deadlineExpired()) return finalizeScores();
      if (this.cfg.graphLateralInhibitionEnabled && scores.size > 1) {
        const inhibited = applyLateralInhibition(scores, {
          beta: this.cfg.graphLateralInhibitionBeta,
          topM: this.cfg.graphLateralInhibitionTopM,
        });
        for (const [k, v] of inhibited) {
          scores.set(k, v);
        }
      }

      return finalizeScores();
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
  opts: { iterations: number; floor: number; damping: number; deadlineAtMs?: number }
): void {
  const { iterations, floor, damping, deadlineAtMs } = opts;
  if (iterations <= 0 || scores.size === 0) return;
  const safeDamping = Math.min(1, Math.max(0, damping));
  const deadlineExpired = (): boolean =>
    typeof deadlineAtMs === "number" && Date.now() >= deadlineAtMs;

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
    if (deadlineExpired()) return;
    if (!scores.has(node)) continue; // only candidate nodes redistribute
    let sum = 0;
    for (const edge of edges) {
      if (!eligible(edge, node)) continue;
      sum += readEdgeConfidence(edge) * edge.weight;
    }
    if (sum > 0) outboundTotal.set(node, sum);
  }

  for (let i = 0; i < iterations; i += 1) {
    if (deadlineExpired()) return;
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
      for (let edgeIndex = 0; edgeIndex < outEdges.length; edgeIndex += 1) {
        if ((edgeIndex & 1023) === 0 && deadlineExpired()) return;
        const edge = outEdges[edgeIndex];
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
  opts: { beta: number; topM: number }
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
