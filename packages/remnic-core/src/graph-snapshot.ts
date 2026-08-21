/**
 * Graph snapshot — read-only view of the multi-graph memory adjacency
 * (issue #691 PR 2/5).
 *
 * Composes the JSONL edge store from `graph.ts` with optional node-metadata
 * loading so HTTP / MCP / future CLI surfaces can return a consistent
 * `{ nodes, edges, generatedAt }` shape suitable for the admin pane scaffold
 * shipped in PR 1/5.
 *
 * All inputs are validated and clamped at this layer so the access surface
 * (which is responsible for HTTP/MCP-flavored errors) can keep the wiring
 * thin.  The module is pure async I/O — no global state, no caches.
 */

import type { GraphEdge, GraphType } from "./graph.js";
import { readAllEdges } from "./graph.js";
import { readEdgeConfidence } from "./graph-edge-reinforcement.js";
import * as path from "path";

/** Default `limit` when the caller omits it. */
export const GRAPH_SNAPSHOT_DEFAULT_LIMIT = 500;

/** Hard upper bound on `limit` to keep responses sized for the admin pane. */
export const GRAPH_SNAPSHOT_MAX_LIMIT = 5000;

/** Categories accepted by the `categories` filter; matches `MemoryFile.frontmatter.category`. */
export type GraphSnapshotCategory = string;

export interface GraphSnapshotNode {
  /** Stable identifier — relative memory path (matches `GraphEdge.from` / `to`). */
  id: string;
  /** Short human label.  Falls back to the basename when no metadata is available. */
  label: string;
  /** Memory category (e.g. `fact`, `decision`, `entity`).  `"unknown"` when metadata is missing. */
  kind: string;
  /** Aggregate edge confidence touching this node, used for sizing in the admin pane. */
  score: number;
  /** Most recent edge timestamp (ISO) touching this node — best-effort recency signal. */
  lastUpdated: string | null;
}

export interface GraphSnapshotEdge {
  source: string;
  target: string;
  kind: GraphType;
  /** Edge confidence in [0, 1]; legacy edges without confidence return 1.0. */
  confidence: number;
}

export interface GraphSnapshotResponse {
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
  generatedAt: string;
}

export interface GraphSnapshotRequest {
  /** Max number of edges to include (after filtering).  Default 500, max 5000. */
  limit?: number;
  /** Inclusive lower bound on edge `ts` (ISO string).  Edges older than this are dropped. */
  since?: string;
  /** When set, restrict the snapshot to the focus node and its direct neighbors. */
  focusNodeId?: string;
  /**
   * Optional category allow-list.  Edges are kept only when both endpoints
   * resolve to nodes whose category falls in this set; nodes are kept only
   * when their category matches.  When omitted, no category filter is applied.
   */
  categories?: GraphSnapshotCategory[];
}

/**
 * Loader contract: given a relative memory path, return `{ category, label,
 * updated }` or `null` when the memory cannot be resolved.  Implementations
 * typically wrap `StorageManager.readMemoryByPath`; the snapshot module stays
 * agnostic so tests can pass a synchronous in-memory map.
 */
export type GraphSnapshotNodeLoader = (
  relPath: string,
) => Promise<GraphSnapshotNodeMetadata | null>;

export interface GraphSnapshotNodeMetadata {
  /** Memory category, e.g. `fact` / `decision` / `entity`. */
  category: string;
  /** Display label — usually the memory id or the entity name. */
  label: string;
  /** ISO `updated` timestamp from frontmatter, when available. */
  updated?: string;
}

/**
 * Coerce a caller-supplied limit into the `[1, GRAPH_SNAPSHOT_MAX_LIMIT]` range.
 *
 * - `undefined` / `null` → `GRAPH_SNAPSHOT_DEFAULT_LIMIT`.
 * - non-finite or non-integer → throws `Error` (callers translate to 400).
 * - `<= 0` → throws.
 * - `> GRAPH_SNAPSHOT_MAX_LIMIT` → clamped to the max (no error — admin
 *   panel callers send liberal limits).
 */
export function normalizeGraphSnapshotLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return GRAPH_SNAPSHOT_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error("graphSnapshot: limit must be a positive integer");
  }
  if (raw <= 0) {
    throw new Error("graphSnapshot: limit must be a positive integer");
  }
  if (raw > GRAPH_SNAPSHOT_MAX_LIMIT) return GRAPH_SNAPSHOT_MAX_LIMIT;
  return raw;
}

/**
 * Validate and parse an ISO timestamp into a millisecond epoch.  Throws
 * when the input cannot be parsed; callers translate to a 400.  `undefined`
 * input yields `undefined`.
 */
export function parseGraphSnapshotSince(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error("graphSnapshot: since must be a parseable ISO timestamp");
  }
  return ms;
}

/**
 * Build a `GraphSnapshotResponse` from the raw edge JSONL on disk plus an
 * optional node-metadata loader.
 *
 * The function is split into pure subroutines so HTTP / MCP / tests can
 * exercise the same logic without spinning up a full `StorageManager`.
 */
export async function buildGraphSnapshot(opts: {
  memoryDir: string;
  graphConfig: {
    entityGraph: boolean;
    timeGraph: boolean;
    causalGraph: boolean;
  };
  request: GraphSnapshotRequest;
  loadNode: GraphSnapshotNodeLoader;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}): Promise<GraphSnapshotResponse> {
  const limit = normalizeGraphSnapshotLimit(opts.request.limit);
  const sinceMs = parseGraphSnapshotSince(opts.request.since);
  const focusNodeId = opts.request.focusNodeId?.trim();
  const categoryFilter = normalizeCategoryFilter(opts.request.categories);

  const allEdges = await readAllEdges(opts.memoryDir, opts.graphConfig);

  // Time-window filter (CLAUDE.md rule 35 — half-open `[since, +∞)`; equality
  // is treated as inclusive because callers expect a single-point pin to
  // surface edges stamped exactly at that instant).
  const timeFiltered = sinceMs === undefined
    ? allEdges
    : allEdges.filter((edge) => {
        const ts = Date.parse(edge.ts);
        return Number.isFinite(ts) && ts >= sinceMs;
      });

  // Focus-node neighborhood filter — restrict to edges incident on the node.
  const focusFiltered = focusNodeId
    ? timeFiltered.filter((edge) => edge.from === focusNodeId || edge.to === focusNodeId)
    : timeFiltered;

  // Sort newest-first so the limit window keeps the most recent edges.  `ts`
  // is an ISO string, so a string comparison agrees with chronological order
  // for any well-formed timestamp; we still parse to avoid surprising
  // ordering when timezones drift, falling back to lexicographic compare on
  // tie / parse failure for stable ordering (CLAUDE.md rule 19).
  const sortedEdges = [...focusFiltered].sort((a, b) => {
    const aMs = Date.parse(a.ts);
    const bMs = Date.parse(b.ts);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return bMs - aMs;
    }
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    // Stable secondary key: from/to/type so identical-ts edges have a
    // deterministic order across runs.
    const aKey = `${a.from}|${a.to}|${a.type}`;
    const bKey = `${b.from}|${b.to}|${b.type}`;
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
  });

  // Streaming category + limit pass.  Metadata is loaded lazily per
  // endpoint with a memoization cache (`metadata`) so we never re-read the
  // same memory file twice, never read more than `2 × limit` files, and
  // never silently drop matching edges because a static cap fired before
  // the category filter saw them — the bug Cursor flagged on PR #734
  // when the pre-limit edge set referenced more than `2 × MAX_LIMIT`
  // unique nodes.
  const metadata = new Map<string, GraphSnapshotNodeMetadata | null>();
  const trimmedEdges: GraphEdge[] = [];

  const ensureMetadata = async (relPath: string): Promise<GraphSnapshotNodeMetadata | null> => {
    if (metadata.has(relPath)) return metadata.get(relPath) ?? null;
    let resolved: GraphSnapshotNodeMetadata | null = null;
    try {
      resolved = await opts.loadNode(relPath);
    } catch {
      // Loader errors are best-effort — leave the path absent so it
      // falls through to the basename label / "unknown" category.
      resolved = null;
    }
    metadata.set(relPath, resolved);
    return resolved;
  };

  for (const edge of sortedEdges) {
    if (trimmedEdges.length >= limit) break;
    if (categoryFilter !== null) {
      const fromMeta = await ensureMetadata(edge.from);
      const toMeta = await ensureMetadata(edge.to);
      if (!fromMeta || !toMeta) continue;
      if (
        !categoryFilter.has(fromMeta.category)
        || !categoryFilter.has(toMeta.category)
      ) {
        continue;
      }
    } else {
      // Even without a category filter we still want labels / kinds for
      // the surfaced nodes, so warm the metadata cache for this edge.
      // The cache is bounded by `2 × limit` because we stop iterating
      // once `trimmedEdges` reaches `limit`.
      await ensureMetadata(edge.from);
      await ensureMetadata(edge.to);
    }
    trimmedEdges.push(edge);
  }

  const resolvedMetadata = new Map<string, GraphSnapshotNodeMetadata>();
  for (const [key, value] of metadata) {
    if (value) resolvedMetadata.set(key, value);
  }

  const nodes = buildNodeIndex(trimmedEdges, resolvedMetadata);
  const edges: GraphSnapshotEdge[] = trimmedEdges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    kind: edge.type,
    confidence: readEdgeConfidence(edge),
  }));

  const generatedAt = (opts.now ? opts.now() : new Date()).toISOString();
  return { nodes, edges, generatedAt };
}

function normalizeCategoryFilter(
  raw: GraphSnapshotCategory[] | undefined,
): Set<string> | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new Error("graphSnapshot: categories must be an array of strings");
  }
  const cleaned = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      throw new Error("graphSnapshot: categories must be an array of strings");
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) cleaned.add(trimmed);
  }
  // Empty allow-list → reject everything.  We surface this as a 400 because
  // the admin pane should never send `categories=` with no values.
  if (cleaned.size === 0) {
    throw new Error("graphSnapshot: categories must contain at least one non-empty value");
  }
  return cleaned;
}

function buildNodeIndex(
  edges: GraphEdge[],
  metadata: Map<string, GraphSnapshotNodeMetadata>,
): GraphSnapshotNode[] {
  type Aggregate = {
    score: number;
    lastUpdatedMs: number | null;
    lastUpdatedIso: string | null;
  };
  const aggregates = new Map<string, Aggregate>();

  function bump(id: string, edge: GraphEdge): void {
    const current = aggregates.get(id) ?? {
      score: 0,
      lastUpdatedMs: null,
      lastUpdatedIso: null,
    };
    current.score += readEdgeConfidence(edge);
    const ms = Date.parse(edge.ts);
    if (Number.isFinite(ms) && (current.lastUpdatedMs === null || ms > current.lastUpdatedMs)) {
      current.lastUpdatedMs = ms;
      current.lastUpdatedIso = edge.ts;
    }
    aggregates.set(id, current);
  }

  for (const edge of edges) {
    bump(edge.from, edge);
    bump(edge.to, edge);
  }

  // Stable order: descending score, then ascending id for determinism.
  const ids = Array.from(aggregates.keys()).sort((a, b) => {
    const aScore = aggregates.get(a)?.score ?? 0;
    const bScore = aggregates.get(b)?.score ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });

  return ids.map((id) => {
    const meta = metadata.get(id);
    const aggregate = aggregates.get(id);
    return {
      id,
      label: meta?.label ?? defaultLabelFromPath(id),
      kind: meta?.category ?? "unknown",
      score: Number((aggregate?.score ?? 0).toFixed(4)),
      lastUpdated: aggregate?.lastUpdatedIso ?? null,
    };
  });
}

function defaultLabelFromPath(relPath: string): string {
  const base = path.basename(relPath, path.extname(relPath));
  return base.length > 0 ? base : relPath;
}
