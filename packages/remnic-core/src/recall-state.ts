import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { writeFileAtomically } from "./maintenance/atomic-file.js";
import type {
  IdentityInjectionMode,
  RecallPlanMode,
  RecallTierExplain,
} from "./types.js";

export interface LastRecallBudgetSummary {
  requestedTopK?: number;
  appliedTopK: number;
  recallBudgetChars: number;
  maxMemoryTokens: number;
  qmdFetchLimit?: number;
  qmdHybridFetchLimit?: number;
  finalContextChars?: number;
  truncated?: boolean;
  includedSections?: string[];
  omittedSections?: string[];
}

export interface LastRecallSnapshot {
  sessionKey: string;
  recordedAt: string;
  queryHash: string;
  queryLen: number;
  memoryIds: string[];
  namespace?: string;
  traceId?: string;
  plannerMode?: RecallPlanMode;
  requestedMode?: RecallPlanMode;
  source?: string;
  fallbackUsed?: boolean;
  sourcesUsed?: string[];
  budgetsApplied?: LastRecallBudgetSummary;
  latencyMs?: number;
  resultPaths?: string[];
  policyVersion?: string;
  identityInjectionMode?: IdentityInjectionMode | "none";
  identityInjectedChars?: number;
  identityInjectionTruncated?: boolean;
  /**
   * Collision-safe write nonce.  Random UUID set on every `record()`
   * call so the observation-mode direct-answer hook can detect stale
   * snapshots and avoid annotating a snapshot that a subsequent recall
   * already replaced (issue #518).
   */
  writeNonce?: string;
  /**
   * Optional tier-level explanation of how recall was served
   * (issue #518).  Populated by orchestrator call sites that can
   * identify a concrete tier; surfaces expose the block via
   * `engram query --explain`, the `?explain=1` HTTP flag, and the
   * `remnic_recall_explain` MCP tool.  Orthogonal to the existing
   * graph-path `recallExplain` operation.
   */
  tierExplain?: RecallTierExplain;
}

export interface GraphRecallExpandedEntry {
  path: string;
  score: number;
  namespace: string;
  seed: string;
  hopDepth: number;
  decayedWeight: number;
  graphType: "entity" | "time" | "causal";
  /**
   * Issue #681 PR 3/3 — confidence of the edge that produced this entry's
   * recorded provenance (strongest edge along the chosen entry path).
   * Range `[0, 1]`. Optional so persisted snapshots from older builds
   * round-trip through `clampGraphRecallExpandedEntries` without dropping.
   */
  edgeConfidence?: number;
}

export function clampGraphRecallExpandedEntries(
  entries: unknown,
  maxEntries: number = 64,
): GraphRecallExpandedEntry[] {
  const limit = Math.max(1, Math.floor(maxEntries));
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const graphType: "entity" | "time" | "causal" =
        item.graphType === "entity" || item.graphType === "time" || item.graphType === "causal"
          ? item.graphType
          : "entity";
      const out: GraphRecallExpandedEntry = {
        path: typeof item.path === "string" ? item.path : "",
        score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0,
        namespace: typeof item.namespace === "string" ? item.namespace : "",
        seed: typeof item.seed === "string" ? item.seed : "",
        hopDepth:
          typeof item.hopDepth === "number" && Number.isFinite(item.hopDepth)
            ? Math.max(0, Math.floor(item.hopDepth))
            : 0,
        decayedWeight:
          typeof item.decayedWeight === "number" && Number.isFinite(item.decayedWeight)
            ? Math.max(0, item.decayedWeight)
            : 0,
        graphType,
      };
      // Issue #681 PR 3/3: clamp `edgeConfidence` into [0, 1] when present.
      // Older snapshots without the field round-trip cleanly via the
      // optional shape; legacy callers always rendered as 1.0.
      if (
        typeof item.edgeConfidence === "number" &&
        Number.isFinite(item.edgeConfidence)
      ) {
        out.edgeConfidence = Math.min(1, Math.max(0, item.edgeConfidence));
      }
      return out;
    })
    .filter((item) => item.path.length > 0 && item.namespace.length > 0)
    .slice(0, limit);
}

type LastRecallState = Record<string, LastRecallSnapshot>;
type StateFileWriter = (filePath: string, content: string) => Promise<void>;

/**
 * Deep-copy a RecallTierExplain block.  Used by both the write path
 * (so caller mutation after `record()` cannot tear the persisted
 * snapshot) and the read path (so caller mutation after `get()` /
 * `getMostRecent()` cannot tear the in-memory store).
 *
 * Uses structuredClone so future additions to RecallTierExplain do
 * not silently share references through hand-enumerated fields —
 * matching the pattern used elsewhere in the codebase (e.g.,
 * qmd-recall-cache.ts).  The payload is pure JSON-shaped data, so
 * structuredClone is both safe and complete here.
 */
function cloneTierExplain(
  tierExplain: RecallTierExplain | undefined,
): RecallTierExplain | undefined {
  if (!tierExplain) return undefined;
  return structuredClone(tierExplain);
}

/**
 * Deep-copy a LastRecallSnapshot so callers that receive it cannot
 * mutate the store's internal state through mutable array/object
 * fields.  Same structuredClone rationale as cloneTierExplain above.
 */
function cloneLastRecallSnapshot(
  snapshot: LastRecallSnapshot | null,
): LastRecallSnapshot | null {
  if (!snapshot) return null;
  return structuredClone(snapshot);
}

export interface TierMigrationCycleSummary {
  trigger: "extraction" | "maintenance" | "manual";
  scanned: number;
  migrated: number;
  promoted: number;
  demoted: number;
  limit: number;
  dryRun: boolean;
  skipped?: string;
  errorCount?: number;
}

export interface TierMigrationStatusSnapshot {
  updatedAt: string;
  lastCycle: TierMigrationCycleSummary | null;
  totals: {
    cycles: number;
    scanned: number;
    migrated: number;
    promoted: number;
    demoted: number;
    errors: number;
  };
}

const DEFAULT_TIER_MIGRATION_STATUS: TierMigrationStatusSnapshot = {
  updatedAt: new Date(0).toISOString(),
  lastCycle: null,
  totals: {
    cycles: 0,
    scanned: 0,
    migrated: 0,
    promoted: 0,
    demoted: 0,
    errors: 0,
  },
};

export class LastRecallStore {
  private readonly statePath: string;
  private readonly impressionsPath: string;
  private readonly writeStateFile: StateFileWriter;
  private state: LastRecallState = {};
  private stateWriteChain: Promise<void> = Promise.resolve();

  constructor(memoryDir: string, options: { writeStateFile?: StateFileWriter } = {}) {
    this.statePath = path.join(memoryDir, "state", "last_recall.json");
    this.impressionsPath = path.join(memoryDir, "state", "recall_impressions.jsonl");
    this.writeStateFile =
      options.writeStateFile ??
      (async (filePath, content) => {
        await writeFileAtomically(filePath, content);
      });
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as LastRecallState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch {
      this.state = {};
    }
  }

  get(sessionKey: string): LastRecallSnapshot | null {
    // Defensive copy: callers must not be able to mutate internal state
    // by reaching into array/object fields on the returned snapshot.
    return cloneLastRecallSnapshot(this.state[sessionKey] ?? null);
  }

  getMostRecent(): LastRecallSnapshot | null {
    const snapshots = Object.values(this.state);
    if (snapshots.length === 0) return null;
    // Secondary key on sessionKey keeps the sort stable when two
    // snapshots share a recordedAt timestamp (CLAUDE.md rule 19).
    snapshots.sort((a, b) => {
      const byTime = b.recordedAt.localeCompare(a.recordedAt);
      if (byTime !== 0) return byTime;
      return a.sessionKey.localeCompare(b.sessionKey);
    });
    return cloneLastRecallSnapshot(snapshots[0] ?? null);
  }

  /**
   * Persist last-recall snapshot and append an impression log entry.
   * Does not store raw query text; uses a stable hash for correlation.
   */
  async record(opts: {
    sessionKey: string;
    query: string;
    memoryIds: string[];
    namespace?: string;
    traceId?: string;
    plannerMode?: RecallPlanMode;
    requestedMode?: RecallPlanMode;
    source?: string;
    fallbackUsed?: boolean;
    sourcesUsed?: string[];
    budgetsApplied?: LastRecallBudgetSummary;
    latencyMs?: number;
    resultPaths?: string[];
    policyVersion?: string;
    appendImpression?: boolean;
    identityInjection?: {
      mode: IdentityInjectionMode | "none";
      injectedChars: number;
      truncated: boolean;
    };
    /**
     * Per-tier explain annotation (issue #518).  When supplied, the
     * snapshot carries it so downstream surfaces (CLI / HTTP / MCP)
     * can render which retrieval tier served the query.
     */
    tierExplain?: RecallTierExplain;
  }): Promise<void> {
    const now = new Date().toISOString();
    const queryHash = createHash("sha256").update(opts.query).digest("hex");

    // Build the snapshot from opts, then deep-copy it via
    // cloneLastRecallSnapshot so caller arrays/objects passed in
    // `opts` cannot retain a live reference to the persisted state
    // and tear it after record() returns.
    const liveSnapshot: LastRecallSnapshot = {
      sessionKey: opts.sessionKey,
      recordedAt: now,
      queryHash,
      writeNonce: randomUUID(),
      queryLen: opts.query.length,
      memoryIds: opts.memoryIds,
      namespace: opts.namespace,
      traceId: opts.traceId,
      plannerMode: opts.plannerMode,
      requestedMode: opts.requestedMode,
      source: opts.source,
      fallbackUsed: opts.fallbackUsed,
      sourcesUsed: opts.sourcesUsed,
      budgetsApplied: opts.budgetsApplied,
      latencyMs: opts.latencyMs,
      resultPaths: opts.resultPaths,
      policyVersion: opts.policyVersion,
      identityInjectionMode: opts.identityInjection?.mode,
      identityInjectedChars: opts.identityInjection?.injectedChars,
      identityInjectionTruncated: opts.identityInjection?.truncated,
      tierExplain: opts.tierExplain,
    };
    // `cloneLastRecallSnapshot` handles `null` but that never applies
    // at this call site — the non-null assertion keeps the type
    // checker honest.
    const snapshot = cloneLastRecallSnapshot(liveSnapshot)!;

    this.state[opts.sessionKey] = snapshot;

    // Keep the state bounded; the impression log is append-only.
    const keys = Object.keys(this.state);
    if (keys.length > 50) {
      const ordered = keys
        .map((k) => ({ k, at: this.state[k]?.recordedAt ?? "" }))
        .sort((a, b) => b.at.localeCompare(a.at));
      for (const doomed of ordered.slice(50)) {
        delete this.state[doomed.k];
      }
    }

    try {
      await this.flushState();
    } catch (err) {
      log.debug(`last recall store write failed: ${err}`);
    }

    if (opts.appendImpression !== false) {
      try {
        await mkdir(path.dirname(this.impressionsPath), { recursive: true });
        await appendFile(this.impressionsPath, JSON.stringify(snapshot) + "\n", "utf-8");
      } catch (err) {
        log.debug(`recall impressions append failed: ${err}`);
      }
    }
  }

  /**
   * Attach a RecallTierExplain block to the existing snapshot for a
   * session without rewriting the entire snapshot.  Used by the
   * post-recall direct-answer annotation path (issue #518 slice 3c):
   * recallInternal records the snapshot first, then the orchestrator
   * fires the direct-answer tier in observation mode and annotates
   * the stored snapshot with whichever tier served the query.
   *
   * No-op when no snapshot exists for the given session; callers do
   * not need to guard on existence.
   */
  async annotateTierExplain(
    sessionKey: string,
    tierExplain: RecallTierExplain,
    expected?: { writeNonce?: string; traceId?: string; recordedAt?: string },
  ): Promise<void> {
    const current = this.state[sessionKey];
    if (!current) return;
    if (expected) {
      if (
        typeof expected.writeNonce === "string" &&
        expected.writeNonce.length > 0
      ) {
        if (current.writeNonce !== expected.writeNonce) return;
      } else {
        const hasExpectedTraceId =
          typeof expected.traceId === "string" && expected.traceId.length > 0;
        const traceIdMatches =
          hasExpectedTraceId && current.traceId === expected.traceId;
        const recordedAtMatches =
          expected.recordedAt !== undefined &&
          current.recordedAt === expected.recordedAt;
        if (hasExpectedTraceId) {
          if (!traceIdMatches) return;
        } else if (expected.recordedAt !== undefined && !recordedAtMatches) {
          return;
        }
      }
    }
    this.state[sessionKey] = {
      ...current,
      tierExplain: cloneTierExplain(tierExplain),
    };
    try {
      await this.flushState();
    } catch (err) {
      log.debug(`last recall tier-explain annotate failed: ${err}`);
    }
  }

  private flushState(): Promise<void> {
    const run = this.stateWriteChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await this.writeStateFile(this.statePath, JSON.stringify(this.state, null, 2));
    });
    this.stateWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class TierMigrationStatusStore {
  private readonly statePath: string;
  private state: TierMigrationStatusSnapshot = structuredClone(DEFAULT_TIER_MIGRATION_STATUS);

  constructor(memoryDir: string) {
    this.statePath = path.join(memoryDir, "state", "tier-migration-status.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TierMigrationStatusSnapshot> | null;
      if (!parsed || typeof parsed !== "object") {
        this.state = structuredClone(DEFAULT_TIER_MIGRATION_STATUS);
        return;
      }
      const totals = parsed.totals && typeof parsed.totals === "object"
        ? parsed.totals
        : DEFAULT_TIER_MIGRATION_STATUS.totals;
      this.state = {
        updatedAt:
          typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
            ? parsed.updatedAt
            : DEFAULT_TIER_MIGRATION_STATUS.updatedAt,
        lastCycle:
          parsed.lastCycle && typeof parsed.lastCycle === "object"
            ? (parsed.lastCycle as TierMigrationCycleSummary)
            : null,
        totals: {
          cycles: typeof totals.cycles === "number" && Number.isFinite(totals.cycles) ? totals.cycles : 0,
          scanned: typeof totals.scanned === "number" && Number.isFinite(totals.scanned) ? totals.scanned : 0,
          migrated: typeof totals.migrated === "number" && Number.isFinite(totals.migrated) ? totals.migrated : 0,
          promoted: typeof totals.promoted === "number" && Number.isFinite(totals.promoted) ? totals.promoted : 0,
          demoted: typeof totals.demoted === "number" && Number.isFinite(totals.demoted) ? totals.demoted : 0,
          errors: typeof totals.errors === "number" && Number.isFinite(totals.errors) ? totals.errors : 0,
        },
      };
    } catch {
      this.state = structuredClone(DEFAULT_TIER_MIGRATION_STATUS);
    }
  }

  get(): TierMigrationStatusSnapshot {
    return {
      updatedAt: this.state.updatedAt,
      lastCycle: this.state.lastCycle ? { ...this.state.lastCycle } : null,
      totals: { ...this.state.totals },
    };
  }

  async recordCycle(summary: TierMigrationCycleSummary): Promise<void> {
    const now = new Date().toISOString();
    const migratedDelta = summary.dryRun ? 0 : Math.max(0, summary.migrated);
    const promotedDelta = summary.dryRun ? 0 : Math.max(0, summary.promoted);
    const demotedDelta = summary.dryRun ? 0 : Math.max(0, summary.demoted);
    const next: TierMigrationStatusSnapshot = {
      updatedAt: now,
      lastCycle: { ...summary },
      totals: {
        cycles: this.state.totals.cycles + 1,
        scanned: this.state.totals.scanned + Math.max(0, summary.scanned),
        migrated: this.state.totals.migrated + migratedDelta,
        promoted: this.state.totals.promoted + promotedDelta,
        demoted: this.state.totals.demoted + demotedDelta,
        errors: this.state.totals.errors + Math.max(0, summary.errorCount ?? 0),
      },
    };
    this.state = next;
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(next, null, 2), "utf-8");
    } catch (err) {
      log.debug(`tier migration status write failed: ${err}`);
    }
  }
}
