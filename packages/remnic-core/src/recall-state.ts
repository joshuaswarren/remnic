import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { log } from "./logger.js";
import { writeFileAtomically } from "./maintenance/atomic-file.js";
import { isErrnoCode } from "./utils/errno.js";
import { withHeldFileLock, type HeldFileLockOptions } from "./utils/serialize-mutations.js";
import { ensureContainedSpillDir, listContainedSpillFiles } from "./utils/path-containment.js";
import type { SearchDegradation } from "./search/port.js";
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
  recallNamespaces?: string[];
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
  /**
   * Backend degradations observed while serving this recall (issue #1536).
   * Present only when a search backend reported unavailable/loading/timeout
   * during the recall — distinguishing "no matches" from "backend could not
   * answer" (CLAUDE.md rule 34). Deliberately independent of `tierExplain`,
   * which is gated behind `recallDirectAnswerEnabled`.
   */
  backendDegradations?: SearchDegradation[];
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
/**
 * Stale-snapshot identity guard shared by the annotate methods (issue #518):
 * a writeNonce match wins outright; otherwise traceId (when expected) and
 * recordedAt are compared. Extracted so every annotation surface applies
 * identical guards (CLAUDE.md rule 22).
 */
function snapshotMatchesExpectedIdentity(
  current: LastRecallSnapshot,
  expected?: { writeNonce?: string; traceId?: string; recordedAt?: string },
): boolean {
  if (!expected) return true;
  if (typeof expected.writeNonce === "string" && expected.writeNonce.length > 0) {
    return current.writeNonce === expected.writeNonce;
  }
  const hasExpectedTraceId =
    typeof expected.traceId === "string" && expected.traceId.length > 0;
  if (hasExpectedTraceId) {
    return current.traceId === expected.traceId;
  }
  if (expected.recordedAt !== undefined) {
    return current.recordedAt === expected.recordedAt;
  }
  return true;
}

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

/**
 * Suffix marking an impression spill CLAIMED for commit but not yet deleted.
 * The crash-safe drain renames `<uuid>.jsonl` -> `<uuid>.jsonl.claimed` before
 * committing its rows, mirroring the lifecycle ledger's claim/commit protocol
 * (#2033).
 */
const CLAIMED_IMPRESSION_SPILL_SUFFIX = ".claimed";

/**
 * Outcome of {@link LastRecallStore.drainPendingImpressions}. Distinguishes a
 * completed drain (or nothing pending) from a DEFERRED drain that could not
 * acquire the rotation lock while spills remained, so the caller can tell the
 * data-safe cases apart from the one where an offline-sync snapshot would
 * silently omit recorded impressions (#2033).
 */
export interface DrainPendingImpressionsResult {
  /** Pending spill rows were folded into the synced active file this call. */
  folded: boolean;
  /**
   * Pending spill rows remain in the offline-sync-EXCLUDED pending queue
   * because the rotation lock could not be acquired within the budget. A
   * snapshot taken now would silently omit them (#2033): the caller MUST treat
   * the active file as INCOMPLETE and retry or abort the snapshot rather than
   * report success. `false` means the active file is complete — either the
   * spills were folded or nothing was pending.
   */
  pendingDeferred: boolean;
}

/**
 * Split a JSONL payload into whole rows, each keeping its trailing newline. A
 * final fragment without a trailing newline is returned as its own row so no
 * bytes are lost. Splits on newlines only — never parses — so malformed rows
 * survive byte-for-byte (#2033).
 */
function splitJsonlRows(payload: string): string[] {
  const rows: string[] = [];
  let start = 0;
  for (let i = 0; i < payload.length; i += 1) {
    if (payload[i] === "\n") {
      rows.push(payload.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < payload.length) rows.push(payload.slice(start));
  return rows;
}

export class LastRecallStore {
  private readonly statePath: string;
  private readonly impressionsPath: string;
  private readonly writeStateFile: StateFileWriter;
  private readonly impressionsRotateBytes: number;
  private readonly impressionsRotateKeep: number;
  // Lock-acquisition timing for the cross-process impression rotation lock.
  // Only tests set this (small maxWaitMs) to force the acquisition-timeout
  // (`acquired=false`) branch deterministically; production uses the defaults.
  private readonly impressionsLockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">;
  private state: LastRecallState = {};
  private stateWriteChain: Promise<void> = Promise.resolve();
  // Serializes the rotate-then-append critical section so concurrent record()
  // calls never interleave rotation renames with each other's appends (#1910).
  private impressionsWriteChain: Promise<void> = Promise.resolve();

  constructor(
    memoryDir: string,
    options: {
      writeStateFile?: StateFileWriter;
      impressionsRotateBytes?: number;
      impressionsRotateKeep?: number;
      impressionsLockOptions?: Pick<HeldFileLockOptions, "maxWaitMs" | "pollMs">;
    } = {},
  ) {
    this.statePath = path.join(memoryDir, "state", "last_recall.json");
    this.impressionsPath = path.join(memoryDir, "state", "recall_impressions.jsonl");
    // 0 disables rotation (never coerced to a default); keep floors at 1.
    this.impressionsRotateBytes = Math.max(0, Math.floor(options.impressionsRotateBytes ?? 0));
    this.impressionsRotateKeep = Math.max(1, Math.floor(options.impressionsRotateKeep ?? 5));
    this.impressionsLockOptions = options.impressionsLockOptions;
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
    recallNamespaces?: string[];
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
    /**
     * Backend degradations observed while serving this recall (issue #1536).
     * Passed at record time so the published snapshot is born annotated —
     * a post-record annotation would leave a window where readers see the
     * snapshot without them (codex review on #1544).
     */
    backendDegradations?: SearchDegradation[];
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
      recallNamespaces: opts.recallNamespaces,
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
      backendDegradations:
        opts.backendDegradations && opts.backendDegradations.length > 0
          ? opts.backendDegradations
          : undefined,
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
      const line = JSON.stringify(snapshot) + "\n";
      // Chain onto the previous impression write so rotation + append run as one
      // serialized critical section — concurrent record() calls can never
      // interleave a rename with another call's append (#1910). `.catch` before
      // the link keeps a prior failure from poisoning the chain.
      const chained = this.impressionsWriteChain
        .catch(() => {})
        .then(() => this.appendImpressionSerialized(line));
      this.impressionsWriteChain = chained;
      try {
        await chained;
      } catch (err) {
        log.debug(`recall impressions append failed: ${err}`);
      }
    }
  }

  /**
   * Drain pending spills, rotate (best-effort, sized to the projected payload),
   * then append one impression line under ONE shared cross-process lock (#1910,
   * #2033). Both the archive-shift renames AND the append run inside the same
   * held lock so a peer process holding the lock can never rename the active
   * inode to `.1` between our open and write — which would land the impression in
   * a rotated archive that offline-sync excludes, silently dropping it from
   * active-state/sync consumers.
   *
   * On lock-acquisition timeout the impression is NEVER written to the active
   * file unlocked (#2033): a peer holding the lock is likely mid-rotation, so an
   * unlocked append can land in the inode it is about to rename to `.1` — the
   * exact silent-drop this lock prevents. Instead the row is spilled to a
   * durable node-local per-event file under `<impressions>.pending.d/` and
   * folded back into the active file by the next append that DOES hold the lock,
   * preserving durability without racing rotation. Rotation failure under the
   * held lock is logged and the append still runs. Callers invoke this only
   * through `impressionsWriteChain` so the sequence is serialized in-process.
   */
  private get impressionsPendingDir(): string {
    return `${this.impressionsPath}.pending.d`;
  }

  private async spillImpression(line: string): Promise<void> {
    await ensureContainedSpillDir(this.impressionsPendingDir);
    // Write to a temp name the drain's `.jsonl` lister ignores, then atomically
    // rename to the final `<uuid>.jsonl` (#2033). writeFile creates the path
    // before its bytes are durable, so writing straight to the final name lets a
    // concurrent lock holder's drain read/rename/delete a partial spill and
    // append malformed JSON — permanently losing that impression. The temp lives
    // in the SAME contained dir, so the rename is atomic and stays symlink-safe.
    const id = randomUUID();
    const tempPath = path.join(this.impressionsPendingDir, `${id}.jsonl.tmp`);
    const finalPath = path.join(this.impressionsPendingDir, `${id}.jsonl`);
    await writeFile(tempPath, line, "utf-8");
    await rename(tempPath, finalPath);
  }

  /**
   * Recover a claim a crashed drain left mid-flight (#2033): the crash-safe
   * drain renames `<uuid>.jsonl` -> `<uuid>.jsonl.claimed` BEFORE committing, so
   * a `.claimed` file with no matching commit is the ONLY durable copy of those
   * rows. Rename each orphan back to `<uuid>.jsonl` so it re-enters the normal
   * collect+claim+commit flow. MUST run under the held rotation lock, before
   * collecting. listContainedSpillFiles skips symlinked/escaping entries.
   */
  private async recoverOrphanedImpressionClaims(): Promise<void> {
    const orphans = await listContainedSpillFiles(
      this.impressionsPendingDir,
      `.jsonl${CLAIMED_IMPRESSION_SPILL_SUFFIX}`,
    );
    for (const claimedPath of orphans) {
      const original = claimedPath.slice(0, -CLAIMED_IMPRESSION_SPILL_SUFFIX.length);
      await rename(claimedPath, original).catch(() => undefined);
    }
  }

  /** Delete claimed spill files after their rows are durably committed (#2033). A
   *  delete that fails leaves an orphan the next drain recovers and re-commits —
   *  a writeNonce-collapsible duplicate, never a lost row. */
  private async finalizeImpressionClaims(claimedPaths: string[]): Promise<void> {
    for (const claimedPath of claimedPaths) {
      await unlink(claimedPath).catch(() => undefined);
    }
  }

  /** Roll a failed commit's claims back to unclaimed `<uuid>.jsonl` spills so the
   *  next lock holder's drain retries them (#2033). Best-effort: an un-renamable
   *  claim is instead recovered by the next drain's orphan sweep. */
  private async rollbackImpressionClaims(claimedPaths: string[]): Promise<void> {
    for (const claimedPath of claimedPaths) {
      const original = claimedPath.slice(0, -CLAIMED_IMPRESSION_SPILL_SUFFIX.length);
      await rename(claimedPath, original).catch(() => undefined);
    }
  }

  private async appendImpressionSerialized(line: string): Promise<void> {
    await mkdir(path.dirname(this.impressionsPath), { recursive: true });
    // Every active-file write goes under the shared cross-process rotation lock,
    // even when THIS writer's local rotation is disabled (`impressionsRotateBytes
    // <= 0`). A peer process with rotation enabled shares this lock and may
    // rename the active inode to `.1` at any moment, so an unlocked append could
    // land in an offline-sync-excluded archive and be silently dropped (#2033).
    // Only the local rotate DECISION is disabled — the bounded fold skips
    // rotation when this writer's limit is 0 — the lock itself is not.
    const lockPath = `${this.impressionsPath}.lock`;
    await withHeldFileLock(
      lockPath,
      { staleMs: 30_000, ...this.impressionsLockOptions },
      async (acquired) => {
        // withHeldFileLock falls back to task(false) when it cannot acquire the
        // lock within the budget. Do NOT append to the active file unlocked: a
        // peer holding the lock may be mid-rotation, so an unlocked append could
        // land in the inode it renames to `.1` (an offline-sync-excluded
        // archive), silently dropping the impression. Spill it to the durable
        // pending queue instead — the next lock holder folds it back in (#2033).
        if (!acquired) {
          log.debug("recall impressions rotation lock not acquired; spilling impression to the durable pending queue");
          await this.spillImpression(line);
          return;
        }
        await this.foldPendingImpressionsAndAppend(line);
      },
    );
  }

  /**
   * Fold any durable pending recall-impression spills into the synced active
   * `recall_impressions.jsonl` WITHOUT recording a new impression (#2033).
   *
   * The pending spill dir is offline-sync-excluded, so an impression that a
   * lock-timed-out `record()` spilled there is absent from an offline-sync
   * snapshot and lost if this node is discarded before the next `record()`
   * folds it back. Offline sync calls this before building a snapshot so a
   * recorded impression always reaches the remote. Fast no-op — no lock and no
   * dir/lock-file creation — when nothing is pending.
   *
   * Returns a {@link DrainPendingImpressionsResult}: `folded` is true when rows
   * were folded into the active file; `pendingDeferred` is true when the
   * rotation lock could NOT be acquired while spills remained, so the spills
   * are still in the offline-sync-EXCLUDED queue and a snapshot taken now would
   * silently drop them. The caller MUST NOT report a clean snapshot while
   * `pendingDeferred` is true — it either retries or aborts.
   */
  async drainPendingImpressions(): Promise<DrainPendingImpressionsResult> {
    let pendingCount = 0;
    try {
      pendingCount = (await readdir(this.impressionsPendingDir)).length;
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return { folded: false, pendingDeferred: false };
      throw err;
    }
    if (pendingCount === 0) return { folded: false, pendingDeferred: false };
    const lockPath = `${this.impressionsPath}.lock`;
    let folded = false;
    let acquiredLock = false;
    let spillsRemain = false;
    await withHeldFileLock(
      lockPath,
      { staleMs: 30_000, ...this.impressionsLockOptions },
      async (acquired) => {
        // A peer holds the lock (mid-rotation or mid-append). We MUST NOT touch
        // the active file unlocked (#2033), so the spills stay in the
        // offline-sync-EXCLUDED pending queue. Report the drain as DEFERRED
        // (pendingDeferred=true) so the caller does not build a snapshot that
        // silently omits them; the next lock holder — or a caller retry — folds
        // them in.
        if (!acquired) return;
        acquiredLock = true;
        folded = await this.foldPendingImpressionsAndAppend(null);
        // Even WITH the lock, a spill the fold could not claim or a `.claimed`
        // orphan a failed commit left behind keeps durable rows in the excluded
        // queue. Treat that as an incomplete drain so the caller retries/aborts
        // rather than snapshotting an active file that omits them (#2033).
        spillsRemain = await this.pendingSpillsRemain();
      },
    );
    return { folded, pendingDeferred: !acquiredLock || spillsRemain };
  }

  /**
   * Claim/commit fold of durable pending impression spills into the active file
   * under the held rotation lock (#2033). `line` is a new impression to append
   * after the drained rows, or null for a drain-only fold. Recovers any claim a
   * crash orphaned, reads each spill, CLAIMs it by renaming `<uuid>.jsonl` ->
   * `<uuid>.jsonl.claimed` BEFORE the commit, appends the claimed rows (plus
   * `line`), then FINALIZEs by deleting the claimed files. A crash between claim
   * and commit leaves the rows on disk as a `.claimed` orphan the next drain
   * recovers — the loss the old read-then-unlink ordering could not survive.
   * Each impression carries a unique writeNonce, so a crash-recovered re-commit
   * is a collapsible duplicate, never a lost row. listContainedSpillFiles
   * rejects symlinked/escaping entries before any read/rename; a spill that
   * cannot be claimed is skipped this pass. Returns true when the active file
   * was written. MUST run under the held rotation lock.
   */
  private async foldPendingImpressionsAndAppend(line: string | null): Promise<boolean> {
    await this.recoverOrphanedImpressionClaims();
    const spillFiles = await listContainedSpillFiles(this.impressionsPendingDir);
    const claimedRows: string[] = [];
    const claimedPaths: string[] = [];
    for (const filePath of spillFiles) {
      const content = await readFile(filePath, "utf-8");
      const claimedPath = `${filePath}${CLAIMED_IMPRESSION_SPILL_SUFFIX}`;
      try {
        await rename(filePath, claimedPath);
      } catch {
        continue; // could not claim → do not commit; a later drain retries it.
      }
      claimedRows.push(content.length === 0 || content.endsWith("\n") ? content : `${content}\n`);
      claimedPaths.push(claimedPath);
    }
    // Drain-only fold with nothing pending is a no-op — never write an empty row.
    if (claimedRows.length === 0 && line === null) return false;
    const payload = line === null ? claimedRows.join("") : `${claimedRows.join("")}${line}`;
    // Fold the drained payload in bounded segments so no active-file generation
    // exceeds recallImpressionsRotateBytes even when a single drain batch is far
    // larger than the cap (#2033): a single append of the whole payload would
    // leave the freshly rotated active file over the limit until the next
    // record(). Runs under this same held lock, so the rotation renames never
    // race a peer. A commit (append) failure rolls the claims back so the rows
    // retry on the next lock holder's drain instead of being lost.
    try {
      await this.appendImpressionRowsBounded(payload);
    } catch (err) {
      await this.rollbackImpressionClaims(claimedPaths);
      throw err;
    }
    // Commit is durable: delete the claimed files. A delete that fails leaves a
    // `.claimed` orphan the next drain recovers and re-commits — a
    // writeNonce-collapsible duplicate, never a lost row (#2033).
    await this.finalizeImpressionClaims(claimedPaths);
    return true;
  }

  /**
   * Append `payload` to the active impressions file, folding it in bounded
   * segments so no active-file generation exceeds `impressionsRotateBytes`
   * (#2033). Whole JSONL rows are grouped into segments that each keep the
   * active file within the cap; the archives shift (active -> .1, per keep
   * semantics) between segments. Rows are never split mid-line, so malformed
   * rows pass through byte-for-byte and a lone row larger than the cap is
   * written whole (splitting it would corrupt JSONL). Rotation disabled
   * (`impressionsRotateBytes <= 0`) collapses to a single append. A rotation
   * error is logged and the append still runs so a row is never lost; a genuine
   * append failure propagates so the caller rolls its claims back. MUST run
   * under the held rotation lock.
   */
  private async appendImpressionRowsBounded(payload: string): Promise<void> {
    const cap = this.impressionsRotateBytes;
    if (cap <= 0) {
      await appendFile(this.impressionsPath, payload, "utf-8");
      return;
    }
    let activeSize = 0;
    try {
      activeSize = (await stat(this.impressionsPath)).size;
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
    }
    let segment = "";
    let segmentBytes = 0;
    const flush = async (): Promise<void> => {
      if (segment.length === 0) return;
      await appendFile(this.impressionsPath, segment, "utf-8");
      activeSize += segmentBytes;
      segment = "";
      segmentBytes = 0;
    };
    for (const row of splitJsonlRows(payload)) {
      const rowBytes = Buffer.byteLength(row, "utf-8");
      // Adding this row would push the current active generation (already-written
      // bytes + pending segment) to/over the cap: flush the pending segment then
      // rotate so the row starts a fresh active file. Skip the rotate while the
      // active generation is still empty — a single oversized row cannot be split
      // without corrupting JSONL, so it is written whole.
      if (activeSize + segmentBytes > 0 && activeSize + segmentBytes + rowBytes >= cap) {
        await flush();
        try {
          await this.shiftImpressionArchives();
          activeSize = 0;
        } catch (err) {
          log.debug(`recall impressions rotation failed (append preserved): ${err}`);
        }
      }
      segment += row;
      segmentBytes += rowBytes;
    }
    await flush();
  }

  /**
   * True when any live `<uuid>.jsonl` spill or crash-orphaned
   * `<uuid>.jsonl.claimed` file remains in the offline-sync-EXCLUDED pending
   * queue (#2033). After a drain acquires the rotation lock, a spill the fold
   * could not claim (rename race / read-only dir) or a `.claimed` orphan a
   * failed commit left behind means durable rows are STILL excluded from a
   * snapshot — the drain must report itself INCOMPLETE so the caller retries or
   * aborts rather than snapshotting an active file that omits them.
   */
  private async pendingSpillsRemain(): Promise<boolean> {
    if ((await listContainedSpillFiles(this.impressionsPendingDir)).length > 0) return true;
    const claimed = await listContainedSpillFiles(
      this.impressionsPendingDir,
      `.jsonl${CLAIMED_IMPRESSION_SPILL_SUFFIX}`,
    );
    return claimed.length > 0;
  }

  /**
   * Shift `.1..N` archives down one slot and move the active file to `.1`,
   * dropping anything beyond `keep`. Callers invoke this only while holding the
   * cross-process rotation lock (issue #1910).
   */
  private async shiftImpressionArchives(): Promise<void> {
    const keep = this.impressionsRotateKeep;
    // Drop the archive that would fall off the end, then shift down: .(keep-1)
    // -> .keep, ..., .1 -> .2, active -> .1.
    try {
      await rm(`${this.impressionsPath}.${keep}`, { force: true });
    } catch {
      // best-effort cleanup of the oldest archive
    }
    for (let i = keep - 1; i >= 1; i -= 1) {
      try {
        await rename(`${this.impressionsPath}.${i}`, `${this.impressionsPath}.${i + 1}`);
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
    }
    try {
      await rename(this.impressionsPath, `${this.impressionsPath}.1`);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
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
    if (!snapshotMatchesExpectedIdentity(current, expected)) return;
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


/**
 * Per-session bounded history of recent recall memory-id sets, used ONLY by
 * handle resolution (issue #1582). Distinct from {@link LastRecallStore} —
 * that keeps ONE last snapshot per session; this keeps a small ring (depth N)
 * of the memory-id arrays a session has recalled, newest first, so a handle
 * cited in a later turn still resolves even after a newer recall displaced the
 * "last" snapshot.
 *
 * Deliberately lightweight: stores only `string[]` per entry (no full
 * snapshot), capped at `depth` per session and 50 sessions total (rule 27
 * slice/cap guards). Misses are acceptable and tagged at resolution time.
 */
export class RecallHandleHistoryStore {
  private readonly statePath: string;
  private readonly writeStateFile: StateFileWriter;
  private state: Record<string, Array<{ at: string; ids: string[] }>> = {};
  private writeChain: Promise<void> = Promise.resolve();
  private readonly maxDepth: number;

  constructor(memoryDir: string, options: { writeStateFile?: StateFileWriter; maxDepth?: number } = {}) {
    this.statePath = path.join(memoryDir, "state", "handle_history.json");
    this.writeStateFile =
      options.writeStateFile ??
      (async (filePath, content) => {
        await writeFileAtomically(filePath, content);
      });
    this.maxDepth =
      typeof options.maxDepth === "number" && Number.isFinite(options.maxDepth)
        ? Math.max(1, Math.min(50, Math.floor(options.maxDepth)))
        : 5;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.state = parsed as typeof this.state;
    } catch {
      this.state = {};
    }
  }

  /**
   * Record one recall's admitted memory ids for a session, newest first.
   * The ring is capped at {@link maxDepth}; older entries drop off the tail.
   */
  async record(sessionKey: string, memoryIds: readonly string[]): Promise<void> {
    if (!sessionKey) return;
    const ids = memoryIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    const entry = { at: new Date().toISOString(), ids };
    const prior = this.state[sessionKey] ?? [];
    const next = [entry, ...prior].slice(0, this.maxDepth);
    this.state[sessionKey] = next;
    this.capSessions();
    try {
      await this.flush();
    } catch (err) {
      log.debug(`recall handle history write failed: ${err}`);
    }
  }

  /**
   * Return the memory-id arrays for a session, newest first, capped at `depth`.
   * Empty array when the session has no recorded history.
   */
  recent(sessionKey: string, depth: number = this.maxDepth): Array<readonly string[]> {
    const entries = this.state[sessionKey];
    if (!entries || entries.length === 0) return [];
    const limit = Math.max(0, Math.min(depth, entries.length));
    return entries.slice(0, limit).map((e) => e.ids);
  }

  /** Test seam: drop all history (used by the corpus-scan hygiene test). */
  clearForTest(): void {
    this.state = {};
  }

  private capSessions(): void {
    const keys = Object.keys(this.state);
    if (keys.length <= 50) return;
    const ordered = keys
      .map((k) => ({ k, at: this.state[k]?.[0]?.at ?? "" }))
      .sort((a, b) => b.at.localeCompare(a.at));
    for (const doomed of ordered.slice(50)) {
      delete this.state[doomed.k];
    }
  }

  private flush(): Promise<void> {
    const run = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await this.writeStateFile(this.statePath, JSON.stringify(this.state, null, 2));
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }
}
