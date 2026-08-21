/**
 * Graph-edge decay maintenance job (issue #681 PR 2/3).
 *
 * For each edge in the on-disk JSONL graph stores
 * (`<memoryDir>/state/graphs/{entity,time,causal}.jsonl`) call
 * {@link decayEdgeConfidence} from PR 1/3 and write the decayed edge
 * back to disk via the temp+rename atomic-replace pattern (CLAUDE.md
 * gotcha #54: never delete-before-write).
 *
 * Emits a structured telemetry record per run that the doctor surface
 * (`remnic doctor`) and a tail of the maintenance ledger can consume.
 *
 * Pure-helper-style API (the function takes a `memoryDir` + opts and
 * returns a record); callers wire the cron / MCP tool / CLI surfaces.
 */

import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  decayEdgeConfidence,
  DEFAULT_DECAY_FLOOR,
  DEFAULT_DECAY_PER_WINDOW,
  DEFAULT_DECAY_WINDOW_MS,
  readEdgeConfidence,
  type DecayOptions,
} from "../graph-edge-reinforcement.js";
import {
  graphFilePath,
  graphsDir,
  readEdgesStrict,
  withGraphWriteLock,
  type GraphEdge,
  type GraphType,
} from "../graph.js";
import { isSafeRouteNamespace } from "../routing/engine.js";

/** Default visibility threshold for the "below visibility" telemetry counter. */
export const DEFAULT_VISIBILITY_THRESHOLD = 0.2;

const GRAPH_TYPES: readonly GraphType[] = ["entity", "time", "causal"] as const;

/** Per-edge-type breakdown emitted by {@link runGraphEdgeDecayMaintenance}. */
export interface GraphEdgeDecayPerTypeStats {
  type: GraphType;
  edgesTotal: number;
  edgesDecayed: number;
  edgesBelowVisibilityThreshold: number;
}

/** Top-decayed-entity entry (label + total confidence drop summed across edges). */
export interface GraphEdgeDecayTopEntity {
  label: string;
  totalDrop: number;
  edgeCount: number;
}

/**
 * Telemetry record emitted by every run of the decay job. Persisted to
 * `<memoryDir>/state/graph-edge-decay-status.json` for doctor consumption
 * and (optionally) appended to the maintenance ledger by callers.
 */
export interface GraphEdgeDecayTelemetry {
  ranAt: string;
  durationMs: number;
  edgesTotal: number;
  edgesDecayed: number;
  edgesBelowVisibilityThreshold: number;
  topDecayedEntities: GraphEdgeDecayTopEntity[];
  perType: GraphEdgeDecayPerTypeStats[];
  windowMs: number;
  perWindow: number;
  floor: number;
  visibilityThreshold: number;
}

export interface GraphEdgeDecayOptions extends DecayOptions {
  /** Confidence threshold below which an edge counts as "low visibility". */
  visibilityThreshold?: number;
  /** Override "now" for deterministic testing. Defaults to `new Date().toISOString()`. */
  now?: string;
  /** When `true`, do not write decayed edges back — just compute telemetry. */
  dryRun?: boolean;
}

/** Path of the latest-run status file. */
export function graphEdgeDecayStatusPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "graph-edge-decay-status.json");
}

/** Write a JSONL file atomically using temp+rename (CLAUDE.md gotcha #54). */
async function writeJsonlAtomic(filePath: string, edges: GraphEdge[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = edges.length === 0 ? "" : edges.map((e) => JSON.stringify(e)).join("\n") + "\n";
  // Codex P2 / gotcha #54: write to temp then rename. Never rmSync(target)
  // before the rename succeeds; rename is atomic on the same filesystem.
  // Include pid + monotonic-ish suffix so concurrent runs cannot collide.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, body, "utf-8");
  await rename(tempPath, filePath);
}

/**
 * Run a single decay pass over every edge type.
 *
 * Idempotency: PR 1/3's `decayEdgeConfidence` advances `lastReinforcedAt`
 * by exactly the windows it just charged for, so a second run with the
 * same `now` (or any `now` inside the new grace window) is a no-op.
 *
 * Returns the telemetry record. The record is also persisted to
 * {@link graphEdgeDecayStatusPath} so doctor / CLI can read the last run
 * without re-scanning the graphs.
 */
export async function runGraphEdgeDecayMaintenance(
  memoryDir: string,
  options: GraphEdgeDecayOptions = {},
): Promise<GraphEdgeDecayTelemetry> {
  const startedAt = Date.now();
  const ranAt = options.now ?? new Date().toISOString();
  const windowMs = options.windowMs ?? DEFAULT_DECAY_WINDOW_MS;
  const perWindow = options.perWindow ?? DEFAULT_DECAY_PER_WINDOW;
  const floor = options.floor ?? DEFAULT_DECAY_FLOOR;
  const visibilityThreshold =
    typeof options.visibilityThreshold === "number" && Number.isFinite(options.visibilityThreshold)
      ? Math.max(0, Math.min(1, options.visibilityThreshold))
      : DEFAULT_VISIBILITY_THRESHOLD;
  const dryRun = options.dryRun === true;

  await mkdir(graphsDir(memoryDir), { recursive: true });

  const perType: GraphEdgeDecayPerTypeStats[] = [];
  // Aggregate per-label decay drops across ALL graph types so the
  // "top decayed entities" list reflects whichever label dominated
  // each edge (entity name, threadId, or causal phrase). Sorting by
  // total confidence drop highlights the edges decay actually moved
  // most in this pass.
  const dropByLabel = new Map<string, { totalDrop: number; edgeCount: number }>();

  let edgesTotal = 0;
  let edgesDecayed = 0;
  let edgesBelowVisibilityThreshold = 0;

  for (const type of GRAPH_TYPES) {
    const filePath = graphFilePath(memoryDir, type);

    // Hold the per-graph-file write lock across BOTH the read-snapshot
    // and the atomic rewrite so concurrent `appendEdge()` calls cannot
    // sneak in between (issue #729 / Codex P1, line 224). Without this
    // lock the snapshot rewrite would silently drop any edge appended
    // by extraction during the same window. Read failures other than
    // ENOENT are surfaced via `readEdgesStrict` so I/O outages cannot
    // be reported as "no edges to decay" (Codex P1, line 120).
    const {
      typeDecayed,
      typeBelow,
      typeTotal,
    } = await withGraphWriteLock(filePath, async () => {
      const edges = await readEdgesStrict(memoryDir, type);
      const updated: GraphEdge[] = new Array(edges.length);

      let localDecayed = 0;
      let localBelow = 0;
      let localChangedAny = false;

      for (let i = 0; i < edges.length; i += 1) {
        const edge = edges[i];
        const before = readEdgeConfidence(edge);
        const decayed = decayEdgeConfidence(edge, ranAt, { windowMs, perWindow, floor });
        const after = readEdgeConfidence(decayed);

        // Only count as "decayed" when the confidence actually dropped.
        // `decayEdgeConfidence` may return an unchanged copy (still inside
        // the grace window, or already at/below the floor) — those are
        // visited but not decayed.
        if (after < before) {
          localDecayed += 1;
          const drop = before - after;
          const label = typeof edge.label === "string" ? edge.label : "";
          // Skip empty labels in the top list — surfacing them produces
          // a meaningless "" entry that crowds the report.
          if (label.length > 0) {
            const prev = dropByLabel.get(label);
            if (prev) {
              prev.totalDrop += drop;
              prev.edgeCount += 1;
            } else {
              dropByLabel.set(label, { totalDrop: drop, edgeCount: 1 });
            }
          }
        }
        if (after < visibilityThreshold) {
          localBelow += 1;
        }
        updated[i] = decayed;
        // Detect any structural change (confidence OR lastReinforcedAt anchor advance)
        // so we only rewrite the JSONL when there's something to persist.
        if (
          decayed.confidence !== edge.confidence ||
          decayed.lastReinforcedAt !== edge.lastReinforcedAt
        ) {
          localChangedAny = true;
        }
      }

      if (!dryRun && localChangedAny && edges.length > 0) {
        await writeJsonlAtomic(filePath, updated);
      }

      return {
        typeDecayed: localDecayed,
        typeBelow: localBelow,
        typeTotal: edges.length,
      };
    });

    edgesDecayed += typeDecayed;
    edgesBelowVisibilityThreshold += typeBelow;
    edgesTotal += typeTotal;
    perType.push({
      type,
      edgesTotal: typeTotal,
      edgesDecayed: typeDecayed,
      edgesBelowVisibilityThreshold: typeBelow,
    });
  }

  // Stable secondary key on label keeps ordering deterministic when two
  // labels happen to have exactly the same totalDrop (gotcha #19).
  const topDecayedEntities: GraphEdgeDecayTopEntity[] = [...dropByLabel.entries()]
    .map(([label, agg]) => ({ label, totalDrop: agg.totalDrop, edgeCount: agg.edgeCount }))
    .sort((a, b) => {
      if (b.totalDrop !== a.totalDrop) return b.totalDrop - a.totalDrop;
      return a.label.localeCompare(b.label);
    })
    .slice(0, 5);

  const telemetry: GraphEdgeDecayTelemetry = {
    ranAt,
    durationMs: Date.now() - startedAt,
    edgesTotal,
    edgesDecayed,
    edgesBelowVisibilityThreshold,
    topDecayedEntities,
    perType,
    windowMs,
    perWindow,
    floor,
    visibilityThreshold,
  };

  if (!dryRun) {
    await persistTelemetry(memoryDir, telemetry);
  }

  return telemetry;
}

async function persistTelemetry(
  memoryDir: string,
  telemetry: GraphEdgeDecayTelemetry,
): Promise<void> {
  const statusPath = graphEdgeDecayStatusPath(memoryDir);
  await mkdir(path.dirname(statusPath), { recursive: true });
  const tempPath = `${statusPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  // Wrap I/O in try/catch (gotcha #13) — failing to persist telemetry must
  // not blow up the maintenance run; the in-memory record is still returned.
  try {
    await writeFile(tempPath, JSON.stringify(telemetry, null, 2) + "\n", "utf-8");
    await rename(tempPath, statusPath);
  } catch {
    // Best-effort: callers still receive the in-memory telemetry record.
  }
}

/** Read the last persisted decay-run telemetry, if any. */
export async function readGraphEdgeDecayStatus(
  memoryDir: string,
): Promise<GraphEdgeDecayTelemetry | null> {
  try {
    const raw = await readFile(graphEdgeDecayStatusPath(memoryDir), "utf-8");
    const parsed = JSON.parse(raw);
    // Validate the parsed payload is a plain object (gotcha #18: JSON.parse('null') is valid).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as GraphEdgeDecayTelemetry;
  } catch {
    return null;
  }
}

/**
 * Per-namespace telemetry record returned by
 * {@link runGraphEdgeDecayMaintenanceAcrossNamespaces}. Each entry
 * pairs the namespace name with its decay telemetry (or an error
 * string if that namespace's run failed). Allows operators to spot
 * I/O outages on a single namespace without masking the rest.
 */
export interface GraphEdgeDecayNamespaceResult {
  namespace: string;
  storageRoot: string;
  telemetry?: GraphEdgeDecayTelemetry;
  error?: string;
}

/**
 * Discover every namespace storage root that may contain graph files.
 *
 * Returns a list of `{ namespace, storageRoot }` entries:
 *   - The default namespace at `memoryDir` (always present).
 *   - Each subdirectory under `memoryDir/namespaces/` that passes
 *     `isSafeRouteNamespace`.
 *
 * Per gotcha #42: read paths must enumerate the same namespace layer
 * as write paths so non-default namespaces don't get skipped during
 * maintenance. Issue #729 / Codex P2.
 */
export async function discoverGraphNamespaceRoots(
  memoryDir: string,
  options: { namespacesEnabled: boolean; defaultNamespace: string },
): Promise<{ namespace: string; storageRoot: string }[]> {
  const seen = new Map<string, string>();
  // Default namespace always lives at memoryDir (NamespaceStorageRouter
  // falls back to memoryDir when memoryDir/namespaces/<default> does
  // not exist).
  seen.set(options.defaultNamespace, memoryDir);

  if (!options.namespacesEnabled) {
    return [...seen.entries()].map(([namespace, storageRoot]) => ({ namespace, storageRoot }));
  }

  const namespacesDir = path.join(memoryDir, "namespaces");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(namespacesDir, { withFileTypes: true });
  } catch {
    // No namespaces dir yet — only the default namespace exists.
    return [...seen.entries()].map(([namespace, storageRoot]) => ({ namespace, storageRoot }));
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeRouteNamespace(entry.name)) continue;
    const root = path.join(namespacesDir, entry.name);
    seen.set(entry.name, root);
  }

  return [...seen.entries()].map(([namespace, storageRoot]) => ({ namespace, storageRoot }));
}

/**
 * Run the decay maintenance pass against every namespace storage root.
 *
 * In namespaces-enabled deployments, non-default namespaces store
 * their graph JSONLs under `memoryDir/namespaces/<ns>/state/graphs/`,
 * so a single-root run only updates the default namespace and silently
 * skips the rest (issue #729 / Codex P2).
 *
 * Failures in one namespace do not block other namespaces; per-root
 * errors are surfaced in the `error` field of each result.
 */
export async function runGraphEdgeDecayMaintenanceAcrossNamespaces(
  memoryDir: string,
  options: GraphEdgeDecayOptions & {
    namespacesEnabled: boolean;
    defaultNamespace: string;
  },
): Promise<GraphEdgeDecayNamespaceResult[]> {
  const { namespacesEnabled, defaultNamespace, ...decayOptions } = options;
  const roots = await discoverGraphNamespaceRoots(memoryDir, {
    namespacesEnabled,
    defaultNamespace,
  });

  const results: GraphEdgeDecayNamespaceResult[] = [];
  for (const { namespace, storageRoot } of roots) {
    try {
      const telemetry = await runGraphEdgeDecayMaintenance(storageRoot, decayOptions);
      results.push({ namespace, storageRoot, telemetry });
    } catch (err) {
      results.push({
        namespace,
        storageRoot,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
