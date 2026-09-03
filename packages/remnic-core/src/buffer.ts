import { log } from "./logger.js";
import { throwIfAborted } from "./abort-error.js";
import { scanSignals } from "./signal.js";
import type { StorageManager } from "./storage.js";
import type {
  BufferEntryState,
  BufferState,
  BufferSurpriseEvent,
  BufferTurn,
  PluginConfig,
  SignalLevel,
} from "./types.js";
import { resolvePresentationCapabilities } from "./capabilities.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import type { ExtractionBufferSnapshot } from "./extraction-liveness.js";
import {
  bufferTurnArrayIsSuffixOfSnapshot,
  bufferTurnArraysEqual,
  bufferTurnsEqual,
  copyBufferTurn,
  describeError,
  liveTurnsFromExtractionSnapshot,
  matchingQueuedExtractionPrefixLength,
  probeWithTimeout,
} from "./buffer-turn-helpers.js";

export type TriggerDecision = "extract_now" | "extract_batch" | "keep_buffering";

export interface AddTurnOutcome {
  decision: TriggerDecision;
  extractionTurns?: BufferTurn[];
}

export interface RetainedTurnCleanupOptions {
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

/**
 * Optional surprise probe injected into `SmartBuffer`.
 *
 * Computes a D-MEM-style novelty score in `[0, 1]` for an incoming turn.
 * The buffer treats the probe as purely additive: if it is not provided, if
 * the feature flag is off, or if the probe throws/times out, the buffer
 * falls back to the existing signal/turn-count/time triggers unchanged.
 *
 * Callers are responsible for sampling recent memories and passing them
 * through the embedding pipeline — the buffer does not want to know about
 * storage, embeddings, or QMD.
 *
 * @param bufferKey Identifier for the active buffer (session/thread).
 * @param turn      The incoming turn whose novelty is being scored.
 * @param recentTurns Turns already buffered for this key (most recent first
 *                    is NOT guaranteed — treat as unordered corpus).
 * @returns A surprise score in `[0, 1]`, or `null` if no score could be
 *          produced (e.g. empty corpus, probe declined to embed).
 */
export interface BufferSurpriseProbe {
  scoreTurn(
    bufferKey: string,
    turn: BufferTurn,
    recentTurns: readonly BufferTurn[],
  ): Promise<number | null>;
}

const MAX_BUFFER_ENTRY_COUNT = 200;

/**
 * Upper bound on how long a debounced buffer save may be deferred under
 * sustained activity (issue #1909). Each new turn re-arms the trailing-edge
 * timer, so a steady stream of turns could otherwise push the save out
 * indefinitely and widen the crash-loss window without bound. Once a pending
 * save has been deferred this many debounce windows, the next scheduled save
 * forces an inline flush instead of re-arming.
 */
const BUFFER_SAVE_MAX_DEFER_MULTIPLIER = 5;

/**
 * Node's maximum 32-bit `setTimeout` delay (2^31-1 ms, ~24.8 days). A larger
 * value is overflow-clamped by Node to 1ms with a TimeoutOverflowWarning, so we
 * clamp defensively at every timer arm (issue #1909 review round 5) even though
 * parseConfig already caps `bufferSaveDebounceMs` — a directly-constructed config
 * could still exceed it.
 */
const MAX_SET_TIMEOUT_MS = 2_147_483_647;

/**
 * Minimal data carried on the serialized telemetry write chain
 * (issue #563 PR 3).
 *
 * We intentionally do NOT capture the full `BufferTurn` here: under
 * slow filesystem latency the chain can back up, and retaining
 * `turn.content` for every pending append causes memory pressure on
 * large conversations. Only the fields the ledger row actually needs
 * cross the chain boundary.
 */
interface SurpriseTelemetryQueueEntry {
  bufferKey: string;
  turnRole: "user" | "assistant";
  sessionKey: string | null;
  surpriseScore: number;
  triggered: boolean;
  turnCountInWindow: number;
  /**
   * ISO timestamp captured at the moment the turn was scored, NOT when
   * the ledger append eventually runs. Backpressure on the serialized
   * write chain could otherwise shift event timestamps away from the
   * real decision moment and distort the distribution report (p90
   * inflated, current-threshold row misidentified).
   */
  timestamp: string;
  /**
   * Threshold value in force when `triggered` was computed. Must be
   * snapshot here rather than read from `config` at emit time — a
   * concurrent config change between queue and write would otherwise
   * record `triggered=true` against a newer threshold the operator
   * never set, distorting precision/recall interpretation.
   */
  threshold: number;
}

interface AddTurnMutationResult {
  decision: TriggerDecision;
  signalLevel: SignalLevel;
  priorTurns: BufferTurn[];
  activeTurnsSnapshot: BufferTurn[];
  retainedTurnsSnapshot: BufferTurn[];
  turnCountInWindow: number;
}

export class SmartBuffer {
  private state: BufferState;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly surpriseProbe: BufferSurpriseProbe | null;
  private mutationChain: Promise<unknown> = Promise.resolve();
  /**
   * Serialized write chain for `BUFFER_SURPRISE` telemetry events.
   *
   * The telemetry path is fire-and-forget (`addTurn` does not await the
   * ledger append), but multiple concurrent appends would still settle
   * out of order under variable filesystem latency. The report path
   * assumes chronological ordering — it slices the tail of the ledger
   * and treats the most recent entry as the current threshold in force.
   * Chaining ensures each append only runs after the previous settles,
   * preserving wall-clock order.
   *
   * We include a `.catch` on every link so a rejected append does not
   * poison the chain (CLAUDE.md rule #40).
   */
  private surpriseTelemetryWriteChain: Promise<unknown> = Promise.resolve();

  /**
   * Debounced buffer-save state (issue #1909). Steady-state buffering used to
   * serialize + rewrite the whole multi-session buffer on EVERY turn. We now
   * coalesce those writes onto a trailing-edge timer; correctness boundaries
   * (extraction trigger, extraction clear, shutdown) still force an immediate
   * flush. `bufferSaveDebounceMs: 0` restores save-every-turn exactly.
   */
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSave = false;
  /** Wall-clock ms when the currently-pending save was first scheduled (issue
   * #1909). Null when nothing is pending. Used to bound deferral under sustained
   * activity (see BUFFER_SAVE_MAX_DEFER_MULTIPLIER). */
  private firstPendingAtMs: number | null = null;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: StorageManager,
    surpriseProbe: BufferSurpriseProbe | null = null,
  ) {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
    this.surpriseProbe = surpriseProbe;
  }

  private enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.catch(() => {}).then(op);
    this.mutationChain = run.catch(() => {});
    return run;
  }

  private entryFor(key: string): BufferEntryState {
    if (!this.state.entries) {
      this.state.entries = Object.create(null) as NonNullable<BufferState["entries"]>;
    }
    const entries = this.state.entries as NonNullable<BufferState["entries"]>;
    if (Object.hasOwn(entries, key)) {
      const stored = entries[key];
      // Guard against corrupted state/buffer.json — if the stored entry
      // is not a valid object shape, discard it and recreate.
      if (stored && typeof stored === "object" && Array.isArray(stored.turns)) {
        return stored;
      }
      // Corrupted — fall through to recreate.
    }
    const created: BufferEntryState = {
      turns: [],
      lastExtractionAt: null,
      extractionCount: 0,
    };
    entries[key] = created;
    return created;
  }

  private peekEntry(key: string): BufferEntryState | null {
    const existing = this.state.entries?.[key];
    if (existing) return existing;
    if (key !== "default") return null;
    return {
      turns: Array.isArray(this.state.turns) ? this.state.turns : [],
      lastExtractionAt: this.state.lastExtractionAt ?? null,
      extractionCount:
        typeof this.state.extractionCount === "number" ? this.state.extractionCount : 0,
    };
  }

  private normalizeState(state: BufferState): BufferState {
    const entries = Object.assign(
      Object.create(null),
      state.entries ?? {},
    ) as NonNullable<BufferState["entries"]>;
    if (!entries.default) {
      entries.default = {
        turns: Array.isArray(state.turns) ? [...state.turns] : [],
        lastExtractionAt: state.lastExtractionAt ?? null,
        extractionCount:
          typeof state.extractionCount === "number" ? state.extractionCount : 0,
      };
    }
    return {
      turns: entries.default.turns,
      lastExtractionAt: entries.default.lastExtractionAt,
      extractionCount: entries.default.extractionCount,
      entries,
    };
  }

  private entryActivityAt(entry: BufferEntryState): number {
    const lastTurnAt = entry.turns.reduce((latest, turn) => {
      const parsed = Date.parse(turn.timestamp);
      return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
    }, -1);
    const lastExtractionAt =
      typeof entry.lastExtractionAt === "string"
        ? Date.parse(entry.lastExtractionAt)
        : Number.NaN;
    return Math.max(
      lastTurnAt,
      Number.isFinite(lastExtractionAt) ? lastExtractionAt : -1,
    );
  }

  private pruneEntries(retainKeys: string[]): void {
    const entries = this.state.entries;
    if (!entries) return;
    const keys = Object.keys(entries);
    if (keys.length <= MAX_BUFFER_ENTRY_COUNT) return;

    const insertionOrder = new Map(keys.map((key, index) => [key, index]));
    const byOldestActivity = (left: string, right: string): number => {
      const leftAt = this.entryActivityAt(entries[left] ?? {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      });
      const rightAt = this.entryActivityAt(entries[right] ?? {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      });
      if (leftAt !== rightAt) return leftAt - rightAt;
      return (insertionOrder.get(left) ?? 0) - (insertionOrder.get(right) ?? 0);
    };
    const candidates = keys.filter((key) => key !== "default" && !retainKeys.includes(key));
    const emptyRemovable = candidates
      .filter((key) => (entries[key]?.turns.length ?? 0) === 0)
      .sort(byOldestActivity);

    const removableCount = Math.max(0, keys.length - MAX_BUFFER_ENTRY_COUNT);
    let evicted = emptyRemovable.slice(0, removableCount);
    if (evicted.length < removableCount) {
      // Retained failed extractions (#1908 retry retention) keep their turns in
      // the buffer, so empty entries alone may not bring the map back under the
      // cap during a provider outage. The cap is the documented bound — evict
      // the oldest NON-empty sessions too rather than growing unboundedly
      // (codex review).
      const nonEmptyRemovable = candidates
        .filter((key) => (entries[key]?.turns.length ?? 0) > 0)
        .sort(byOldestActivity);
      evicted = evicted.concat(nonEmptyRemovable.slice(0, removableCount - evicted.length));
    }
    for (const key of evicted) {
      delete entries[key];
    }
    if (evicted.length > 0) {
      // Loud degradation (extraction hot-loop hardening, Step 7): during a
      // prolonged provider outage the breaker holds extraction off and buffered
      // sessions accumulate. Eviction of the oldest empty session entries past
      // MAX_BUFFER_ENTRY_COUNT is bounded and expected, but must be observable —
      // not silent — so operators can see buffer pressure.
      log.warn(
        `buffer: pruned ${evicted.length} oldest session entr${evicted.length === 1 ? "y" : "ies"} ` +
          `past MAX_BUFFER_ENTRY_COUNT=${MAX_BUFFER_ENTRY_COUNT}; buffered turn data for those sessions was dropped`,
      );
    }
  }

  private async loadUnlocked(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.storage.loadBuffer()
        .then((state) => {
          this.state = this.normalizeState(state);
          this.loaded = true;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  async load(): Promise<void> {
    await this.enqueueMutation(async () => this.loadUnlocked());
  }

  /** Snapshot of buffered, not-yet-extracted work across sessions (#2151): session count,
   * pending-turn total, oldest buffered turn. Counts retained (#562) + active turns per entry. */
  async getBufferSnapshot(): Promise<ExtractionBufferSnapshot> {
    await this.load();
    let bufferedSessionCount = 0;
    let pendingTurnCount = 0;
    let oldestMs = Number.POSITIVE_INFINITY;
    let oldestTurnTimestamp: string | null = null;
    const consider = (turns: BufferTurn[] | undefined): void => {
      if (!Array.isArray(turns) || turns.length === 0) return;
      bufferedSessionCount += 1;
      pendingTurnCount += turns.length;
      const first = turns[0]?.timestamp;
      const parsed = typeof first === "string" ? Date.parse(first) : Number.NaN;
      if (Number.isFinite(parsed) && parsed < oldestMs) {
        oldestMs = parsed;
        oldestTurnTimestamp = first ?? null;
      }
    };
    const entries = this.state.entries;
    if (entries) {
      // Retained turns (deferred #562) are pending too - count with active (oldest-first), like getTurns().
      for (const entry of Object.values(entries)) consider([...(entry?.retainedTurns ?? []), ...(entry?.turns ?? [])]);
    } else {
      consider(this.state.turns);
    }
    return { bufferedSessionCount, pendingTurnCount, oldestTurnTimestamp };
  }

  /**
   * Reset the buffer to an empty, usable state.
   * Called when the persisted buffer file is corrupt and load() fails,
   * so the buffer can still accept new turns for the rest of the session.
   */
  resetToEmpty(): void {
    this.state = { turns: [], lastExtractionAt: null, extractionCount: 0 };
    this.loaded = true;
  }

  private async saveUnlocked(): Promise<void> {
    await this.storage.saveBuffer(this.state);
  }

  async save(): Promise<void> {
    await this.enqueueMutation(async () => this.saveUnlocked());
  }

  /**
   * Schedule a coalesced, TRUE trailing-edge buffer save (issue #1909). Only
   * used for the debounced (`bufferSaveDebounceMs > 0`) steady-state buffering
   * path; the debounce-off and correctness-boundary paths save inline within the
   * mutation (see `recordTurnUnlocked`). Each call re-arms the timer from now so
   * the write lands one full window after the LAST turn, not the first. To keep
   * sustained activity from deferring the save without bound (which would widen
   * the crash-loss window), once a pending save has been deferred
   * BUFFER_SAVE_MAX_DEFER_MULTIPLIER windows it is flushed inline instead of
   * re-armed. Runs inside the record mutation, so the inline save is awaited.
   */
  private async scheduleSave(): Promise<void> {
    const ms = Math.min(this.config.bufferSaveDebounceMs, MAX_SET_TIMEOUT_MS);
    const now = Date.now();
    this.pendingSave = true;
    if (this.firstPendingAtMs === null) this.firstPendingAtMs = now;
    if (now - this.firstPendingAtMs >= ms * BUFFER_SAVE_MAX_DEFER_MULTIPLIER) {
      // Staleness cap hit: persist now rather than deferring further. Drop the
      // armed timer, attempt the write, and only mark clean on success — a
      // failure keeps the save pending + re-arms so shutdown/the next timer
      // retries (issue #1909 review round 2), never diverging memory from disk.
      clearTimeout(this.saveTimer ?? undefined);
      this.saveTimer = null;
      try {
        await this.saveUnlocked();
        this.pendingSave = false;
        this.firstPendingAtMs = null;
      } catch (err) {
        log.warn(`buffer.scheduleSave: staleness-cap save failed, keeping it pending: ${describeError(err)}`);
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.flushPendingSave();
        }, ms);
        this.saveTimer.unref?.();
      }
      return;
    }
    // True trailing edge: drop any armed timer and re-arm from now.
    clearTimeout(this.saveTimer ?? undefined);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushPendingSave();
    }, ms);
    this.saveTimer.unref?.();
  }

  /** Cancel any armed debounced save without persisting. */
  private cancelScheduledSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingSave = false;
    this.firstPendingAtMs = null;
  }

  /**
   * Persist the current in-memory buffer state inline, keeping the global
   * pending-save state armed until the write SUCCEEDS (issue #1909). On failure
   * the save stays pending and — when debounced — a background retry timer is
   * (re-)armed before the error propagates, so a graceful shutdown flush and the
   * next timer tick both retry. A failed post-mutation save therefore can never
   * silently drop buffered turns, including turns from OTHER sessions that were
   * only in the debounced pending state. The pending flag is cleared (and any
   * armed timer dropped) only after a durable write.
   */
  private async saveNowRetainingPendingOnFailure(context: string): Promise<void> {
    this.pendingSave = true;
    if (this.firstPendingAtMs === null) this.firstPendingAtMs = Date.now();
    try {
      await this.saveUnlocked();
    } catch (err) {
      log.warn(
        `buffer.${context}: inline save failed, keeping it pending for retry: ${describeError(err)}`,
      );
      const ms = Math.min(this.config.bufferSaveDebounceMs, MAX_SET_TIMEOUT_MS);
      if (ms > 0 && !this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.flushPendingSave();
        }, ms);
        this.saveTimer.unref?.();
      }
      throw err;
    }
    this.cancelScheduledSave();
  }

  /**
   * Force any pending debounced save to land now (issue #1909). Idempotent and
   * safe to call from outside a mutation (timer tick, shutdown/dispose, or the
   * surprise-promotion path in `addTurnWithOutcome`). Do NOT `await` this from
   * inside a mutation — it enqueues its own mutation and would deadlock the
   * serializer.
   *
   * `throwOnFailure` (review round 7 finding 5): when set, a failed write is
   * rethrown AFTER the keep-pending + re-arm bookkeeping, so the surprise
   * extraction boundary gets the same durability guarantee as the built-in
   * extract triggers (which propagate saveUnlocked failures) instead of
   * proceeding to extract_now on a non-durable triggering turn. Default false
   * keeps the fail-open behavior for the timer/shutdown callers.
   */
  async flushPendingSave(opts?: { throwOnFailure?: boolean }): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.pendingSave) return;
    try {
      await this.enqueueMutation(async () => {
        // Re-check under the serializer: a concurrent flush may have already
        // persisted this pending save. Skip the redundant write (no phantom
        // writes).
        if (!this.pendingSave) return;
        await this.saveUnlocked();
        // Clear the pending flag INSIDE the same serialized mutation as the
        // write (issue #1909 review). Clearing it after the enqueue await
        // resolved raced an addTurn interleaving between the write and the
        // clear: that turn's scheduleSave re-armed pendingSave + a timer, then
        // this clear wiped it and the debounced flush was lost. Atomic
        // write+clear means any addTurn runs wholly before (its turn is in the
        // write) or wholly after (its pendingSave survives and its timer
        // persists it).
        this.pendingSave = false;
        this.firstPendingAtMs = null;
      });
    } catch (err) {
      // The write failed: memory and disk diverge (issue #1909 review round 2).
      // Keep the save PENDING (do NOT clear pendingSave/firstPendingAtMs) so a
      // graceful shutdown flush and the re-armed timer both retry it — clearing
      // the flag here would drop the buffered turns permanently. Re-arm a
      // background retry when debounced.
      log.warn(`buffer.flushPendingSave: save failed, keeping it pending for retry: ${describeError(err)}`);
      const ms = Math.min(this.config.bufferSaveDebounceMs, MAX_SET_TIMEOUT_MS);
      if (ms > 0 && !this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.flushPendingSave();
        }, ms);
        this.saveTimer.unref?.();
      }
      // Surprise-extraction boundary needs the durability guarantee — surface
      // the failure so the caller does not proceed with a non-durable flush.
      if (opts?.throwOnFailure) throw err;
      return; // fail-open for timer/shutdown callers
    }
  }

  async addTurn(bufferKey: string, turn: BufferTurn): Promise<TriggerDecision> {
    return (await this.addTurnWithOutcome(bufferKey, turn)).decision;
  }

  async addTurnWithOutcome(
    bufferKey: string,
    turn: BufferTurn,
  ): Promise<AddTurnOutcome> {
    const mutation = await this.enqueueMutation(() => this.recordTurnUnlocked(bufferKey, turn));
    let decision = mutation.decision;
    let extractionTurns: BufferTurn[] | undefined;

    // Surprise-gated flush (issue #563). Additive only: if the probe is
    // disabled, unavailable, or the score is below threshold, the decision
    // from the existing trigger logic stands. The probe only ever *promotes*
    // `keep_buffering` → `extract_now`; it never suppresses an existing
    // flush. This preserves the invariant that enabling surprise cannot
    // *reduce* extraction frequency.
    if (
      decision === "keep_buffering" &&
      resolvePresentationCapabilities(this.config).bufferSurpriseTrigger &&
      this.surpriseProbe !== null &&
      // Matching the existing "smart" branch: surprise is a lower-tier
      // novelty signal that should not second-guess a high-signal hit
      // (which already flushes) or fight `every_n` / `time_based` modes.
      this.config.triggerMode === "smart" &&
      mutation.signalLevel !== "high"
    ) {
      const surprise = await this.computeSurpriseSafe(bufferKey, turn, mutation.priorTurns);
      if (surprise !== null) {
        const shouldPromote = surprise > this.config.bufferSurpriseThreshold;
        let triggered = false;
        if (shouldPromote) {
          const currentTurns = await this.getExtractionTurnsIfBufferSnapshotStillCurrent(
            bufferKey,
            mutation.activeTurnsSnapshot,
            mutation.retainedTurnsSnapshot,
          );
          if (currentTurns) {
            log.debug(
              `buffer[${bufferKey}]: surprise=${surprise.toFixed(3)} > threshold=${this.config.bufferSurpriseThreshold} → extract_now`,
            );
            decision = "extract_now";
            triggered = true;
            extractionTurns = currentTurns;
            // Issue #1909 (review): the record mutation for a `keep_buffering`
            // turn only SCHEDULED a debounced save. Surprise now promotes it to
            // extract_now AFTER that mutation, so force the buffer durable before
            // the caller runs extraction — otherwise state/buffer.json lags the
            // extracted turns by up to the debounce window on a crash. Safe to
            // await here: we are outside the record mutation (deadlock-free).
            // throwOnFailure (round 7 finding 5): match the built-in extract
            // triggers — a failed durability write must NOT silently proceed to
            // extract_now on a non-durable turn.
            await this.flushPendingSave({ throwOnFailure: true });
          } else {
            log.debug(
              `buffer[${bufferKey}]: surprise=${surprise.toFixed(3)} ignored because buffer changed before probe resolved`,
            );
          }
        }
        // Emit telemetry on every scored turn — both triggering and
        // non-triggering — so operators can fit the threshold to real
        // traffic distributions. Fire-and-forget: `addTurn` does NOT
        // await the ledger append, so slow/contended filesystems cannot
        // add JSONL-append latency to every `processTurn`. But we DO
        // serialize writes through a promise chain so concurrent
        // appends settle in wall-clock order — the report path assumes
        // chronological tail rows and reads the most recent as the
        // "current" threshold.
        //
        // Project only the fields we need into the queue entry rather
        // than capturing the full `BufferTurn` — under slow filesystem
        // latency the chain can back up, and we must not retain the
        // (potentially large) `turn.content` string for every pending
        // append.
        this.queueSurpriseTelemetryWrite({
          bufferKey,
          turnRole: turn.role,
          sessionKey:
            typeof turn.sessionKey === "string" ? turn.sessionKey : null,
          surpriseScore: surprise,
          triggered,
          turnCountInWindow: mutation.turnCountInWindow,
          // Stamp at decision time so backpressure on the write chain
          // does not shift the event's apparent moment away from when
          // the turn was actually scored.
          timestamp: new Date().toISOString(),
          // Snapshot the threshold used to compute `triggered` so a
          // concurrent config mutation cannot retroactively change
          // what the ledger row claims the decision was against.
          threshold: this.config.bufferSurpriseThreshold,
        });
      }
    }

    log.debug(
      `buffer[${bufferKey}]: ${mutation.turnCountInWindow} turns, signal=${mutation.signalLevel}, decision=${decision}`,
    );
    if (decision !== "keep_buffering" && extractionTurns === undefined) {
      extractionTurns = [
        ...mutation.retainedTurnsSnapshot,
        ...mutation.activeTurnsSnapshot,
      ];
    }
    return extractionTurns ? { decision, extractionTurns } : { decision };
  }

  private async recordTurnUnlocked(bufferKey: string, turn: BufferTurn): Promise<AddTurnMutationResult> {
    await this.loadUnlocked();
    const entry = this.entryFor(bufferKey);
    const priorTurns = entry.turns.slice();
    entry.turns.push(turn);
    const activeTurnsSnapshot = entry.turns.map(copyBufferTurn);
    const retainedTurnsSnapshot = (entry.retainedTurns ?? []).map(copyBufferTurn);
    if (bufferKey === "default") {
      this.state.turns = entry.turns;
    }

    const signal = scanSignals(turn.content, this.config.highSignalPatterns);
    const decision = this.evaluate(entry, signal.level);
    const turnCountInWindow = entry.turns.length;

    this.pruneEntries([bufferKey]);
    if (decision === "keep_buffering" && this.config.bufferSaveDebounceMs > 0) {
      // Steady-state buffering: coalesce the whole-state serialize onto a
      // trailing-edge timer (issue #1909) instead of rewriting per turn.
      await this.scheduleSave();
    } else {
      // Persist immediately within this mutation (awaited) when either:
      //  - the turn triggered extraction (the buffer must be durable), or
      //  - debounce is disabled (bufferSaveDebounceMs <= 0), which reproduces
      //    the legacy save-every-turn behavior byte-for-byte.
      // Round 8 thread 4: the write is attempted BEFORE the pending state is
      // cleared, and a failed write leaves it pending (+ a re-armed timer) for
      // shutdown/timer retry instead of dropping the in-memory turns.
      await this.saveNowRetainingPendingOnFailure("recordTurn");
    }
    return {
      decision,
      signalLevel: signal.level,
      priorTurns,
      activeTurnsSnapshot,
      retainedTurnsSnapshot,
      turnCountInWindow,
    };
  }

  private async getExtractionTurnsIfBufferSnapshotStillCurrent(
    bufferKey: string,
    activeTurnsSnapshot: readonly BufferTurn[],
    retainedTurnsSnapshot: readonly BufferTurn[],
  ): Promise<BufferTurn[] | null> {
    return this.enqueueMutation(async () => {
      await this.loadUnlocked();
      const entry = this.peekEntry(bufferKey);
      if (!entry) return null;
      const retained = entry.retainedTurns ?? [];
      const stillCurrent =
        bufferTurnArrayIsSuffixOfSnapshot(entry.turns, activeTurnsSnapshot) &&
        bufferTurnArraysEqual(retained, retainedTurnsSnapshot);
      if (!stillCurrent) return null;
      return [...retained, ...entry.turns];
    });
  }

  /**
   * Enqueue a telemetry append on the serialized write chain.
   *
   * The chain is a classic `writeChain = writeChain.then(fn).catch(...)`
   * — each link waits for the previous to settle before its append
   * starts, so out-of-order chronology cannot happen even under
   * variable filesystem latency. We always attach `.catch` so one
   * rejection does not poison the chain for the rest of the session
   * (CLAUDE.md rule #40). The error is logged through
   * `emitSurpriseEventSafe` itself, which swallows its own rejections.
   *
   * Public surface is deliberately narrow — only `addTurn` should call
   * this, so the surprise telemetry path stays centralized.
   */
  private queueSurpriseTelemetryWrite(params: SurpriseTelemetryQueueEntry): void {
    this.surpriseTelemetryWriteChain = this.surpriseTelemetryWriteChain
      .then(() => this.emitSurpriseEventSafe(params))
      .catch(() => {
        // `emitSurpriseEventSafe` already handles the logging. We
        // swallow here only so one failure does not break the chain
        // for future writes.
      });
  }

  /**
   * Append a single `BUFFER_SURPRISE` telemetry row (issue #563 PR 3).
   *
   * Deliberately swallows write errors: the buffer must never fail to
   * record a turn because the observation ledger is read-only, out of
   * disk, or otherwise unhappy. The log line at debug lets operators
   * confirm the path fired without polluting the error channel.
   */
  private async emitSurpriseEventSafe(
    params: SurpriseTelemetryQueueEntry,
  ): Promise<void> {
    const storage = this.storage as StorageManager & {
      appendBufferSurpriseEvents?: (
        events: BufferSurpriseEvent[],
      ) => Promise<number>;
    };
    if (typeof storage.appendBufferSurpriseEvents !== "function") {
      // Older StorageManager / test double without the telemetry sink.
      // Silently skip — core path is still covered by the log line above.
      return;
    }
    const event: BufferSurpriseEvent = {
      event: "BUFFER_SURPRISE",
      // Use the decision-time stamp captured when the event was
      // queued, NOT `Date.now()` here — backpressure on the write
      // chain could otherwise shift timestamps into the future relative
      // to when the turn was scored.
      timestamp: params.timestamp,
      bufferKey: params.bufferKey,
      sessionKey: params.sessionKey,
      turnRole: params.turnRole,
      surpriseScore: params.surpriseScore,
      // Use the snapshotted threshold from the queue entry, not the
      // live config — see `SurpriseTelemetryQueueEntry.threshold`
      // doc for the rationale.
      threshold: params.threshold,
      triggeredFlush: params.triggered,
      turnCountInWindow: params.turnCountInWindow,
    };
    try {
      await storage.appendBufferSurpriseEvents([event]);
    } catch (err) {
      // Same guard as `computeSurpriseSafe`: non-Error rejections must
      // not crash the telemetry helper, which would defeat the whole
      // point of isolating the ledger write from the hot path.
      log.debug(
        `buffer[${params.bufferKey}]: surprise telemetry write failed, continuing: ${describeError(err)}`,
      );
    }
  }

  /**
   * Invoke the injected surprise probe defensively. Any error (probe throws,
   * embedder unavailable, timeout) is swallowed and logged at debug: the
   * surprise path must never crash the happy-path trigger evaluation. A
   * `null` return indicates "no score available, fall through to existing
   * triggers".
   */
  private async computeSurpriseSafe(
    bufferKey: string,
    turn: BufferTurn,
    priorTurns: readonly BufferTurn[],
  ): Promise<number | null> {
    if (!this.surpriseProbe) return null;
    try {
      // Hard timeout around the probe so a hung embedder cannot stall
      // `addTurn()` before `save()`. A slow probe would otherwise
      // prevent the just-appended turn from ever being persisted. The
      // timeout is a soft bound — we race it against the probe, take
      // whichever settles first, and treat the timeout as
      // "probe unavailable, fall through" rather than an error that
      // surfaces to the caller.
      const score = await probeWithTimeout(
        this.surpriseProbe.scoreTurn(bufferKey, turn, priorTurns),
        this.config.bufferSurpriseProbeTimeoutMs,
      );
      if (score === null) return null;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        log.debug(
          `buffer[${bufferKey}]: surprise probe returned non-finite score (${String(score)}), ignoring`,
        );
        return null;
      }
      // Defensive clamp: formula lives in buffer-surprise.ts, but we never
      // want a misbehaving probe to inject an out-of-range value into the
      // threshold comparison.
      if (score < 0) return 0;
      if (score > 1) return 1;
      return score;
    } catch (err) {
      // `err` may be any thrown value — `throw null` and
      // `Promise.reject("x")` are both legal. Accessing `.message` on a
      // non-Error would itself throw and defeat the failure-isolation
      // contract, so describe the value safely.
      log.debug(
        `buffer[${bufferKey}]: surprise probe failed, falling back to existing triggers: ${describeError(err)}`,
      );
      return null;
    }
  }

  private evaluate(entry: BufferEntryState, signalLevel: SignalLevel): TriggerDecision {
    if (this.config.triggerMode === "smart") {
      if (signalLevel === "high") return "extract_now";

      if (entry.turns.length >= this.config.bufferMaxTurns) {
        return "extract_batch";
      }

      if (entry.lastExtractionAt) {
        const elapsed =
          Date.now() - new Date(entry.lastExtractionAt).getTime();
        if (elapsed >= this.config.bufferMaxMinutes * 60_000) {
          return "extract_batch";
        }
      }

      return "keep_buffering";
    }

    if (this.config.triggerMode === "every_n") {
      return entry.turns.length >= this.config.bufferMaxTurns
        ? "extract_batch"
        : "keep_buffering";
    }

    if (this.config.triggerMode === "time_based") {
      if (!entry.lastExtractionAt) {
        return entry.turns.length >= this.config.bufferMaxTurns
          ? "extract_batch"
          : "keep_buffering";
      }
      const elapsed =
        Date.now() - new Date(entry.lastExtractionAt).getTime();
      return elapsed >= this.config.bufferMaxMinutes * 60_000
        ? "extract_batch"
        : "keep_buffering";
    }

    return "keep_buffering";
  }

  getTurns(bufferKey = "default"): BufferTurn[] {
    const entry = this.peekEntry(bufferKey);
    if (!entry) return [];
    const retained = entry.retainedTurns ?? [];
    // Retained turns (from a previous defer verdict, issue #562 PR 2) are
    // prepended so the chronological order — oldest context first — is
    // preserved for the next extraction pass.
    return [...retained, ...entry.turns];
  }

  /**
   * Retain a subset of the current turns across `clearAfterExtraction` so a
   * future extraction pass sees the context behind a deferred candidate
   * (issue #562, PR 2). Callers pass the turns that were seen during the
   * current extraction; the buffer keeps the tail (latest `max` turns) as
   * the retention window. Passing an empty array or `max <= 0` clears the
   * retention slot instead.
   */
  async retainDeferredTurns(
    bufferKey: string,
    turns: BufferTurn[],
    max = 10,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.loadUnlocked();
      const entry = this.entryFor(bufferKey);
      if (!Array.isArray(turns) || turns.length === 0 || max <= 0) {
        delete entry.retainedTurns;
      } else {
        // Guard `slice(-max)` against `max === 0` (CLAUDE.md gotcha 27):
        // `slice(-0)` equals `slice(0)` and would return ALL entries. We
        // already early-return above when max <= 0.
        const tail = turns.slice(-max);
        // Copy explicit fields only — never spread an external object into a
        // plain object because spread preserves any own `__proto__` /
        // `constructor` keys that may have arrived via JSON deserialization
        // of untrusted input (CodeQL js/prototype-polluting-assignment).
        entry.retainedTurns = tail.map<BufferTurn>((t) => {
          const copy: BufferTurn = {
            role: t.role,
            content: typeof t.content === "string" ? t.content : "",
            timestamp:
              typeof t.timestamp === "string"
                ? t.timestamp
                : new Date().toISOString(),
          };
          if (typeof t.sessionKey === "string") copy.sessionKey = t.sessionKey;
          if (typeof t.sessionOwnerPrincipal === "string") {
            copy.sessionOwnerPrincipal = t.sessionOwnerPrincipal;
          }
          if (typeof t.logicalSessionKey === "string") {
            copy.logicalSessionKey = t.logicalSessionKey;
          }
          if (
            t.providerThreadId === null ||
            typeof t.providerThreadId === "string"
          ) {
            copy.providerThreadId = t.providerThreadId;
          }
          if (typeof t.turnFingerprint === "string") {
            copy.turnFingerprint = t.turnFingerprint;
          }
          if (typeof t.persistProcessedFingerprint === "boolean") {
            copy.persistProcessedFingerprint = t.persistProcessedFingerprint;
          }
          if (typeof t.sourceConnector === "string") copy.sourceConnector = t.sourceConnector;
          if (t.originRole === "user" || t.originRole === "assistant" || t.originRole === "tool") {
            copy.originRole = t.originRole;
          }
          return copy;
        });
      }
      await this.saveUnlocked();
    });
  }


  /**
   * Return the current retention window (issue #562, PR 2). Primarily for
   * tests and diagnostics.
   */
  getRetainedDeferredTurns(bufferKey = "default"): BufferTurn[] {
    const entry = this.peekEntry(bufferKey);
    return entry?.retainedTurns ? [...entry.retainedTurns] : [];
  }

  /**
   * Clear deferred retention copies for a force-flushed session. Normal
   * extraction preserves these copies so a deferred candidate can be retried;
   * an explicit force flush is the caller's request to drain that context.
   */
  async clearRetainedTurnsForSession(
    sessionKey: string,
    ownerPrincipal?: string,
    options: RetainedTurnCleanupOptions = {},
  ): Promise<void> {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    const normalizedOwnerPrincipal =
      typeof ownerPrincipal === "string" && ownerPrincipal.trim().length > 0
        ? ownerPrincipal.trim()
        : undefined;
    const assertLifecycle = (): void => {
      throwIfAborted(options.abortSignal, "extraction force-flush aborted");
      if (typeof options.deadlineMs === "number" && Date.now() >= options.deadlineMs) {
        throw new ExtractionDeadlineError("retained_turn_cleanup");
      }
    };
    assertLifecycle();
    await this.enqueueMutation(async () => {
      assertLifecycle();
      const hadPendingSave = this.pendingSave;
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.loadUnlocked();
      assertLifecycle();
      const bufferKeys = this.matchingSessionBufferKeysUnlocked(sessionKey);
      if (bufferKeys.length === 0) {
        if (hadPendingSave) {
          assertLifecycle();
          await this.saveNowRetainingPendingOnFailure("clearRetainedTurnsForSession");
        }
        return;
      }
      let changed = false;
      const belongsToOwner = (turn: BufferTurn): boolean => {
        if (turn.sessionKey !== sessionKey) return false;
        if (normalizedOwnerPrincipal === undefined) return true;
        if (turn.sessionOwnerPrincipal === normalizedOwnerPrincipal) return true;
        return (
          turn.sessionOwnerPrincipal === undefined &&
          resolvePrincipal(turn.sessionKey, this.config) === normalizedOwnerPrincipal
        );
      };
      for (const bufferKey of bufferKeys) {
        const entry = this.entryFor(bufferKey);
        const retainedTurns = entry.retainedTurns ?? [];
        const remainingTurns = retainedTurns.filter((turn) => !belongsToOwner(turn));
        if (remainingTurns.length === retainedTurns.length) continue;
        changed = true;
        if (remainingTurns.length > 0) entry.retainedTurns = remainingTurns;
        else delete entry.retainedTurns;
        if (bufferKey === "default") this.state.turns = entry.turns;
      }
      if (changed || hadPendingSave) {
        assertLifecycle();
        await this.saveNowRetainingPendingOnFailure("clearRetainedTurnsForSession");
      }
      assertLifecycle();
    });
  }

  async findBufferKeyForSession(sessionKey: string): Promise<string | null> {
    const bufferKeys = await this.findBufferKeysForSession(sessionKey);
    return bufferKeys[0] ?? null;
  }

  private matchingSessionBufferKeysUnlocked(sessionKey: string): string[] {
    const matches: string[] = [];
    const hasSessionTurns = (entry: BufferEntryState | null | undefined): boolean =>
      [...(entry?.turns ?? []), ...(entry?.retainedTurns ?? [])].some(
        (turn) => typeof turn.sessionKey === "string" && turn.sessionKey === sessionKey,
      );
    const directEntry = this.peekEntry(sessionKey);
    if (hasSessionTurns(directEntry)) {
      matches.push(sessionKey);
    }

    const entries = this.state.entries ?? {};
    for (const [bufferKey, entry] of Object.entries(entries)) {
      if (!matches.includes(bufferKey) && hasSessionTurns(entry)) {
        matches.push(bufferKey);
      }
    }

    return matches;
  }

  async findBufferKeysForSession(sessionKey: string): Promise<string[]> {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return [];
    await this.mutationChain.catch(() => {});
    await this.load();
    return this.matchingSessionBufferKeysUnlocked(sessionKey);
  }

  async clearAfterExtraction(
    bufferKey = "default",
    extractedTurns?: readonly BufferTurn[],
    options?: { allowNonPrefix?: boolean },
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      // Drop any armed debounce TIMER so it cannot fire mid-mutation and race
      // our post-clear write, but KEEP the pending-save state (issue #1909
      // review round 13): the post-clear save below can fail, and clearing the
      // pending flag here would strand buffered turns — including turns from
      // OTHER sessions that only ever entered the debounced pending state — with
      // nothing left to retry them. saveNowRetainingPendingOnFailure clears the
      // pending state only after a durable write, or re-arms it on failure.
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.loadUnlocked();
      const entry = this.entryFor(bufferKey);
      if (Array.isArray(extractedTurns)) {
        const liveExtractedTurns = liveTurnsFromExtractionSnapshot(
          entry,
          extractedTurns,
        );
        let clearedLiveTurns = false;
        if (liveExtractedTurns.length > 0) {
          if (options?.allowNonPrefix === true) {
            const remainingTurns = [...entry.turns];
            for (const extractedTurn of liveExtractedTurns) {
              const matchingIndex = remainingTurns.findIndex((liveTurn) =>
                bufferTurnsEqual(liveTurn, extractedTurn),
              );
              if (matchingIndex >= 0) {
                remainingTurns.splice(matchingIndex, 1);
                clearedLiveTurns = true;
              }
            }
            if (clearedLiveTurns) entry.turns = remainingTurns;
          } else {
            const matchedCount = matchingQueuedExtractionPrefixLength(
              entry.turns,
              liveExtractedTurns,
            );
            if (matchedCount > 0) {
              entry.turns = entry.turns.slice(matchedCount);
              clearedLiveTurns = true;
            }
          }
          if (!clearedLiveTurns) {
            log.debug(
              `buffer[${bufferKey}]: extraction clear skipped because live turns changed before clear`,
            );
          }
        }
        if (!clearedLiveTurns) {
          await this.saveNowRetainingPendingOnFailure("clearAfterExtraction");
          return;
        }
      } else {
        entry.turns = [];
      }
      entry.lastExtractionAt = new Date().toISOString();
      entry.extractionCount += 1;
      if (bufferKey === "default") {
        this.state.turns = entry.turns;
        this.state.lastExtractionAt = entry.lastExtractionAt;
        this.state.extractionCount = entry.extractionCount;
      }
      this.pruneEntries([bufferKey]);
      await this.saveNowRetainingPendingOnFailure("clearAfterExtraction");
    });
  }

  getExtractionCount(bufferKey = "default"): number {
    return this.peekEntry(bufferKey)?.extractionCount ?? 0;
  }

  /**
   * Await any pending `BUFFER_SURPRISE` telemetry writes.
   *
   * The telemetry path is fire-and-forget from the hot path's point of
   * view, but tests and before-exit hooks sometimes need to make sure
   * the ledger has been flushed before they assert on its contents or
   * close the process. This method resolves once the current chain
   * head has settled; new writes scheduled after this call return a
   * separate, later settlement.
   *
   * Never throws — the chain already catches its own rejections.
   */
  async flushSurpriseTelemetry(): Promise<void> {
    await this.surpriseTelemetryWriteChain;
  }
}
