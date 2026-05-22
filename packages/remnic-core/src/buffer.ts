import { log } from "./logger.js";
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

export type TriggerDecision = "extract_now" | "extract_batch" | "keep_buffering";

export interface AddTurnOutcome {
  decision: TriggerDecision;
  extractionTurns?: BufferTurn[];
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
  turnSnapshot: BufferTurn;
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
    const removable = keys
      .filter((key) => key !== "default" && !retainKeys.includes(key))
      .filter((key) => (entries[key]?.turns.length ?? 0) === 0)
      .sort((left, right) => {
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
      });

    const removableCount = Math.max(0, keys.length - MAX_BUFFER_ENTRY_COUNT);
    for (const key of removable.slice(0, removableCount)) {
      delete entries[key];
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
      this.config.bufferSurpriseTriggerEnabled &&
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
          const currentTurns = await this.getExtractionTurnsIfTurnSnapshotStillCurrent(
            bufferKey,
            mutation.turnSnapshot,
          );
          if (currentTurns) {
            log.debug(
              `buffer[${bufferKey}]: surprise=${surprise.toFixed(3)} > threshold=${this.config.bufferSurpriseThreshold} → extract_now`,
            );
            decision = "extract_now";
            triggered = true;
            extractionTurns = currentTurns;
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
    return extractionTurns ? { decision, extractionTurns } : { decision };
  }

  private async recordTurnUnlocked(bufferKey: string, turn: BufferTurn): Promise<AddTurnMutationResult> {
    await this.loadUnlocked();
    const entry = this.entryFor(bufferKey);
    const priorTurns = entry.turns.slice();
    entry.turns.push(turn);
    const turnSnapshot = copyBufferTurn(turn);
    if (bufferKey === "default") {
      this.state.turns = entry.turns;
    }

    const signal = scanSignals(turn.content, this.config.highSignalPatterns);
    const decision = this.evaluate(entry, signal.level);
    const turnCountInWindow = entry.turns.length;

    this.pruneEntries([bufferKey]);
    await this.saveUnlocked();
    return {
      decision,
      signalLevel: signal.level,
      priorTurns,
      turnSnapshot,
      turnCountInWindow,
    };
  }

  private async getExtractionTurnsIfTurnSnapshotStillCurrent(
    bufferKey: string,
    turnSnapshot: BufferTurn,
  ): Promise<BufferTurn[] | null> {
    return this.enqueueMutation(async () => {
      await this.loadUnlocked();
      const entry = this.peekEntry(bufferKey);
      if (!entry) return null;
      const stillCurrent = entry.turns.some((turn) =>
        bufferTurnsEqual(turn, turnSnapshot),
      );
      if (!stillCurrent) return null;
      const retained = entry.retainedTurns ?? [];
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

  async findBufferKeyForSession(sessionKey: string): Promise<string | null> {
    const bufferKeys = await this.findBufferKeysForSession(sessionKey);
    return bufferKeys[0] ?? null;
  }

  async findBufferKeysForSession(sessionKey: string): Promise<string[]> {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return [];
    await this.mutationChain.catch(() => {});
    await this.load();

    const matches: string[] = [];
    const directEntry = this.peekEntry(sessionKey);
    if ((directEntry?.turns.length ?? 0) > 0) {
      matches.push(sessionKey);
    }

    const entries = this.state.entries ?? {};
    for (const [bufferKey, entry] of Object.entries(entries)) {
      if (
        !matches.includes(bufferKey) &&
        entry.turns.some(
          (turn) =>
            typeof turn.sessionKey === "string" && turn.sessionKey === sessionKey,
        )
      ) {
        matches.push(bufferKey);
      }
    }

    return matches;
  }

  async clearAfterExtraction(
    bufferKey = "default",
    extractedTurns?: readonly BufferTurn[],
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.loadUnlocked();
      const entry = this.entryFor(bufferKey);
      if (Array.isArray(extractedTurns)) {
        const liveExtractedTurns = liveTurnsFromExtractionSnapshot(
          entry,
          extractedTurns,
        );
        let clearedLiveTurns = false;
        if (liveExtractedTurns.length > 0) {
          const matchedCount = matchingQueuedExtractionPrefixLength(
            entry.turns,
            liveExtractedTurns,
          );
          if (matchedCount > 0) {
            entry.turns = entry.turns.slice(matchedCount);
            clearedLiveTurns = true;
          } else {
            log.debug(
              `buffer[${bufferKey}]: extraction clear skipped because live turns changed before clear`,
            );
          }
        }
        if (!clearedLiveTurns) {
          await this.saveUnlocked();
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
      await this.saveUnlocked();
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

/**
 * Render an arbitrary thrown value as a short string for debug logging.
 *
 * JavaScript permits throwing *any* value (`throw null`,
 * `Promise.reject("x")`, `throw { reason: "timeout" }`) — not just
 * `Error` instances. The defensive catch blocks in `SmartBuffer` must
 * never themselves throw while trying to log the failure, or they
 * would defeat the whole point of isolating the surprise path from the
 * core extraction decision.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function copyBufferTurn(turn: BufferTurn): BufferTurn {
  const copy: BufferTurn = {
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
  };
  if (typeof turn.sessionKey === "string") copy.sessionKey = turn.sessionKey;
  if (typeof turn.logicalSessionKey === "string") {
    copy.logicalSessionKey = turn.logicalSessionKey;
  }
  if (
    turn.providerThreadId === null ||
    typeof turn.providerThreadId === "string"
  ) {
    copy.providerThreadId = turn.providerThreadId;
  }
  if (typeof turn.turnFingerprint === "string") {
    copy.turnFingerprint = turn.turnFingerprint;
  }
  if (typeof turn.persistProcessedFingerprint === "boolean") {
    copy.persistProcessedFingerprint = turn.persistProcessedFingerprint;
  }
  return copy;
}

function bufferTurnsEqual(left: BufferTurn | undefined, right: BufferTurn): boolean {
  if (!left) return false;
  return (
    left.role === right.role &&
    left.content === right.content &&
    left.timestamp === right.timestamp &&
    left.sessionKey === right.sessionKey &&
    left.logicalSessionKey === right.logicalSessionKey &&
    left.providerThreadId === right.providerThreadId &&
    left.turnFingerprint === right.turnFingerprint &&
    left.persistProcessedFingerprint === right.persistProcessedFingerprint
  );
}

function liveTurnsFromExtractionSnapshot(
  entry: BufferEntryState,
  extractedTurns: readonly BufferTurn[],
): readonly BufferTurn[] {
  const retainedTurns = entry.retainedTurns ?? [];
  if (
    retainedTurns.length > 0 &&
    extractedTurns.length >= retainedTurns.length &&
    retainedTurns.every((turn, index) =>
      bufferTurnsEqual(extractedTurns[index], turn),
    )
  ) {
    const withoutRetainedPrefix = extractedTurns.slice(retainedTurns.length);
    if (
      withoutRetainedPrefix.length > 0 &&
      matchingPrefixLength(entry.turns, withoutRetainedPrefix) > 0
    ) {
      return withoutRetainedPrefix;
    }
  }
  return extractedTurns;
}

function matchingPrefixLength(
  liveTurns: readonly BufferTurn[],
  extractedTurns: readonly BufferTurn[],
): number {
  let index = 0;
  while (
    index < liveTurns.length &&
    index < extractedTurns.length &&
    bufferTurnsEqual(liveTurns[index], extractedTurns[index])
  ) {
    index += 1;
  }
  return index;
}

function matchingQueuedExtractionPrefixLength(
  liveTurns: readonly BufferTurn[],
  extractedTurns: readonly BufferTurn[],
): number {
  let bestMatchedCount = 0;
  for (let start = 0; start < extractedTurns.length; start += 1) {
    const matchedCount = matchingPrefixLength(
      liveTurns,
      extractedTurns.slice(start),
    );
    if (matchedCount > bestMatchedCount) {
      bestMatchedCount = matchedCount;
      if (bestMatchedCount === liveTurns.length) break;
    }
  }
  return bestMatchedCount;
}

/**
 * Sentinel error class for the probe timeout path. Catching it via
 * `instanceof` lets the buffer's surprise helper distinguish a timeout
 * from a probe rejection (which could carry operational context the
 * operator wants to see).
 */
class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`probe exceeded ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Race `inflight` against a timeout clock. Resolves with `inflight`'s
 * value if it settles first, otherwise rejects with `ProbeTimeoutError`.
 * The timer is cleared in both branches so a fast-resolving probe does
 * not leak a handle that would keep the Node event loop alive.
 */
function probeWithTimeout<T>(
  inflight: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
    // `.unref()` so the timer does not hold the event loop open if the
    // caller decides the probe result is no longer interesting.
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
  });
  return Promise.race([inflight, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
