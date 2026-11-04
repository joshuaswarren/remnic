/**
 * Claim-backed extraction-buffer drain (`remnic buffer drain` worker AND the
 * daemon's in-process backlog scheduler task body).
 *
 * The runner owns ONE claimed session at a time and drives it through the
 * SAME extraction pipeline the daemon uses — the same chunking
 * (`chunkExtractionWindow` + the model's input budget), the same retry /
 * provider-circuit semantics. It adds no extraction logic of its own.
 *
 * The difference is ownership: the claimed session's turns live in a drain
 * claim (a durable file), not in a live buffer. The runner wires a
 * claim-backed `SmartBuffer` into the extraction queue as the task's ISOLATED
 * execution context (no global buffer swap — the live buffer, foreground
 * observes and sibling claim drains keep their own state), and groups the
 * claim's turns by captured extraction scope so every group runs under its
 * exact namespace/principal/plan with CURRENT policy re-applied from the
 * turn's original coding binding. `dropFailedChunks: false`: a repeatedly
 * failing chunk stays in the claim as durable retryable backlog.
 */

import { BufferDrainClaims, type DrainLease } from "../storage/buffer-drain-claims.js";
import type { BufferStorage } from "../buffer-persistence.js";
import type { BufferEntryState, BufferState } from "../types.js";
import { SmartBuffer } from "../buffer.js";
import { hostname } from "node:os";
import { describeError, groupTurnsByExtractionScope } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { selfDeps } from "./self-deps.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./turn-ingestion.js";
import { ExtractionDrain } from "./extraction-drain.js";
import type { ExtractionRunResult } from "./extraction-run.js";
import type { Orchestrator } from "../orchestrator.js";

export type DrainSessionStatus = "drained" | "deferred" | "failed" | "skipped";

export interface DrainSessionOutcome {
  key: string;
  status: DrainSessionStatus;
  /** Turns the claim held when the drain started. */
  turnsAtStart: number;
  /** Turns still in the claim when the drain stopped. */
  turnsRemaining: number;
  /** Facts the extraction persisted during this run. */
  persistedCount: number;
  /** Durable outputs (memories + entities) the extraction wrote. */
  durableOutputCount: number;
  /** Why the session was skipped or deferred (machine-readable). */
  reason?: string;
  /**
   * Current-policy denials: scope groups whose authorization no longer holds.
   * Their turns STAY in the claim (pending, never drained) and are surfaced
   * here so operators see denied backlog instead of a silently-empty drain.
   */
  denied?: { reason: string; turns: number }[];
}

/** Extraction results that mean "current policy refuses this scope": the
 * turns are valid backlog whose captured scope is no longer writable. */
const DENIED_SCOPE_REASONS: ReadonlySet<string> = new Set([
  "pinned_namespace_unavailable",
  "namespace_write_revoked",
  "scope_profile_revoked",
]);

export interface BufferDrainRunnerOptions {
  /** Identity of this drainer; owns the lease it takes. */
  ownerId: string;
  /** Lease lifetime in ms. The heartbeat keeps it alive while draining. */
  leaseMs?: number;
  /** Cancels the run at the next chunk boundary. */
  signal?: AbortSignal;
  /** Progress callback (per session, and per claim transition). */
  onEvent?: (event: DrainRunnerEvent) => void;
}

/** A failed drain run: the reason a chunk or the session could not finish. */
export type DrainExtractionError = Error;

export type DrainRunnerEvent =
  | { type: "session_started"; key: string; turns: number }
  | { type: "session_finished"; key: string; outcome: DrainSessionOutcome };

const DEFAULT_LEASE_MS = 120_000;

/**
 * A `BufferStorage` view of one drain claim: the claim file IS the buffer.
 * Writes are the drain's progress (what is left to extract), so every
 * successfully extracted chunk is durably removed before the next one runs.
 */
export class ClaimBufferStorage implements BufferStorage {
  constructor(
    private readonly claims: BufferDrainClaims,
    private readonly key: string,
    private readonly ownerId: string,
    private readonly entry: BufferEntryState,
  ) {}

  async loadBuffer(): Promise<BufferState> {
    const entries: NonNullable<BufferState["entries"]> = Object.create(null);
    entries[this.key] = {
      turns: this.entry.turns,
      retainedTurns: this.entry.retainedTurns,
      lastExtractionAt: this.entry.lastExtractionAt,
      extractionCount: this.entry.extractionCount,
    };
    return {
      turns: this.entry.turns,
      lastExtractionAt: this.entry.lastExtractionAt,
      extractionCount: this.entry.extractionCount,
      entries,
    };
  }

  async saveBuffer(state: BufferState): Promise<void> {
    // Whole-state fallback (the claim covers one session): persist the entry.
    const entry = state.entries?.[this.key];
    await this.claims.writeEntry(this.key, this.ownerId, entry ?? { turns: [], lastExtractionAt: null, extractionCount: 0 }, this.entry);
  }

  async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
    await this.claims.writeEntry(key, this.ownerId, entry, key === this.key ? this.entry : undefined);
  }

  async deleteBufferSession(): Promise<void> {
    // The claim is removed by the ack path, never by a buffer eviction: the
    // drain decides when the session is finished.
  }
}

export class BufferDrainRunner {
  constructor(private readonly orchestrator: Orchestrator) {}

  /** The claim store of this orchestrator's memory root. */
  get claims(): BufferDrainClaims {
    return this.orchestrator.storage.bufferDrainClaims();
  }

  /**
   * Drain one claimed session. The caller owns the lease (it may have taken
   * it already); this method verifies ownership before touching content.
   */
  async drainSession(key: string, options: BufferDrainRunnerOptions): Promise<DrainSessionOutcome> {
    const claims = this.claims;
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const lease: DrainLease = {
      ownerId: options.ownerId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs,
    };
    const claim = await claims.load(key);
    if (!claim) {
      return { key, status: "skipped", turnsAtStart: 0, turnsRemaining: 0, persistedCount: 0, durableOutputCount: 0, reason: "not_claimed" };
    }
    const turnsAtStart = claim.entry.turns.length + (claim.entry.retainedTurns?.length ?? 0);
    options.onEvent?.({ type: "session_started", key, turns: turnsAtStart });

    // Take the lease unless this drainer already holds it.
    const held = await claims.adopt(key, lease);
    if (held === "busy") {
      const outcome: DrainSessionOutcome = {
        key,
        status: "skipped",
        turnsAtStart,
        turnsRemaining: turnsAtStart,
        persistedCount: 0,
        durableOutputCount: 0,
        reason: "claimed_by_another_drain",
      };
      options.onEvent?.({ type: "session_finished", key, outcome });
      return outcome;
    }

    // The claim is the buffer for this run: every successful chunk is
    // removed from it, so a kill leaves exactly the un-extracted turns.
    // The claim buffer is bound PER TASK (execution context below) — the
    // live buffer and every other drain task keep their own state, so two
    // claim drains or a foreground observe can interleave safely.
    const claimBuffer = new SmartBuffer(this.orchestrator.config, new ClaimBufferStorage(claims, key, options.ownerId, claim.entry));
    await claimBuffer.load();
    const isolatedRun = this.orchestrator.extractionRunCoordinatorForBuffer(claimBuffer);
    const coordinator = new TurnIngestionCoordinator(selfDeps<TurnIngestionDeps>(this.orchestrator));
    const ingestionDeps = selfDeps<TurnIngestionDeps>(this.orchestrator);
    const config = this.orchestrator.config;
    // No-drop: a repeatedly failing chunk stays in the claim as durable
    // retryable backlog — never side-filed, never counted as processed.
    const executionDrain = new ExtractionDrain(
      {
        config: {
          extractionMinUserTurns: config.extractionMinUserTurns,
          extractionMinChars: config.extractionMinChars,
          extractionMaxTurnChars: config.extractionMaxTurnChars,
          extractionChunkDropAfterFailures: config.extractionChunkDropAfterFailures,
        },
        extractionWindowBudgetChars: () => ingestionDeps.extractionWindowBudgetChars?.() ?? Number.POSITIVE_INFINITY,
        runExtraction: (turns, runOptions) => isolatedRun.runExtraction(turns, runOptions),
        getStorage: () => ingestionDeps.getStorage(),
        buffer: claimBuffer,
      },
      { dropFailedChunks: false },
    );

    // The claim's turns (retained first, like the live buffer's order).
    const turns = [...(claim.entry.retainedTurns ?? []), ...claim.entry.turns];
    if (turns.length === 0) {
      await claims.ack(key, options.ownerId);
      const outcome: DrainSessionOutcome = {
        key,
        status: "drained",
        turnsAtStart,
        turnsRemaining: 0,
        persistedCount: 0,
        durableOutputCount: 0,
      };
      options.onEvent?.({ type: "session_finished", key, outcome });
      return outcome;
    }

    // Keep the lease alive while a long extraction runs; a lost lease means
    // another drainer took the claim, so this run must stop instead of
    // writing progress into a claim it no longer owns.
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const heartbeat = setInterval(() => {
      void claims
        .heartbeat(key, options.ownerId, leaseMs)
        .then((state) => {
          if (state === "lost") abort.abort(new Error(`buffer drain: lease lost for session ${key}`));
        })
        .catch((err: Error) => {
          // A heartbeat that cannot be renewed is a lease that cannot be
          // held: another drainer may adopt the claim, so stop this run
          // cleanly at the next chunk boundary (the next run resumes it).
          abort.abort(new Error(`buffer drain: lease heartbeat failed for session ${key}: ${describeError(err)}`));
        });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();

    // Exact captured-scope grouping: each scope group keeps its own
    // namespace/principal/plan pins, and the shared extraction boundary
    // re-applies CURRENT authorization from the turn's ORIGINAL coding
    // binding before any write. Groups run sequentially (FIFO per key —
    // the queue's same-key exclusion would serialize them anyway); a
    // denied group never blocks or clears the other groups.
    const groupOutcomes: { turns: number; result?: ExtractionRunResult }[] = [];
    let groupError: DrainExtractionError | undefined;
    for (const group of groupTurnsByExtractionScope(turns)) {
      if (signal.aborted) break;
      const { promise, resolve } = Promise.withResolvers<{ error?: unknown; result?: ExtractionRunResult }>();
      let done = false;
      const settle = (error?: unknown, result?: ExtractionRunResult): void => {
        if (done) return;
        done = true;
        resolve({ error, result });
      };
      void coordinator
        .queueBufferedExtraction(group.turns, "trigger_mode", {
          bufferKey: key,
          clearBufferAfterExtraction: true,
          clearMatchingTurns: true,
          skipDedupeCheck: true,
          skipCharThreshold: true,
          skipUserTurnThreshold: true,
          abortSignal: signal,
          writeNamespaceOverride: group.writeNamespaceOverride,
          principalOverride: group.principalOverride,
          scopeProfileWritePlan: group.scopeProfileWritePlan ?? null,
          execution: { buffer: claimBuffer, drain: executionDrain },
          onTaskSettled: settle,
        })
        .catch((error: DrainExtractionError) => settle(error));
      const settled = await promise;
      if (settled.error !== undefined) {
        groupError = settled.error as DrainExtractionError;
        break;
      }
      groupOutcomes.push({ turns: group.turns.length, result: settled.result });
    }
    clearInterval(heartbeat);
    const remaining = await claims.load(key);
    const turnsRemaining = remaining
      ? remaining.entry.turns.length + (remaining.entry.retainedTurns?.length ?? 0)
      : 0;
    const persistedCount = groupOutcomes.reduce((sum, entry) => sum + (entry.result?.persistedCount ?? 0), 0);
    const durableOutputCount = groupOutcomes.reduce((sum, entry) => sum + (entry.result?.durableOutputCount ?? 0), 0);
    // Denied scope groups: policy refusals leave their turns pending (the
    // group result's turns were NOT cleared), aggregated per reason so a
    // drain is never reported complete while denied backlog remains.
    const denied = new Map<string, number>();
    for (const entry of groupOutcomes) {
      if (entry.result?.status !== "skipped" || !DENIED_SCOPE_REASONS.has(entry.result.reason ?? "")) continue;
      denied.set(entry.result.reason!, (denied.get(entry.result.reason!) ?? 0) + entry.turns);
    }

    let status: DrainSessionStatus;
    let reason: string | undefined;
    if (turnsRemaining === 0) {
      // Everything extracted: the claim is finished and the session file is
      // gone for good. (Durable outputs preceded the claim clear, so an ack
      // never references unprocessed content.)
      await claims.ack(key, options.ownerId);
      status = "drained";
    } else if (groupError) {
      // A failed run keeps the remaining turns for the next attempt.
      await claims.releaseLease(key, options.ownerId);
      status = "failed";
      reason = describeError(groupError);
    } else {
      // Deferred: provider breaker / backoff / a denied or still-pending
      // group. The content stays claimed and the next run resumes it.
      await claims.releaseLease(key, options.ownerId);
      status = "deferred";
      const deniedReason = groupOutcomes.find((entry) => entry.result?.reason !== undefined && DENIED_SCOPE_REASONS.has(entry.result.reason!))?.result?.reason;
      let lastReason: string | undefined;
      for (let index = groupOutcomes.length - 1; index >= 0; index -= 1) {
        const entryReason = groupOutcomes[index]?.result?.reason;
        if (entryReason !== undefined) {
          lastReason = entryReason;
          break;
        }
      }
      reason = deniedReason ?? lastReason ?? "deferred";
    }
    log.info(
      `buffer drain: session ${key} ${status} (${turnsRemaining} turn(s) remaining)`,
    );
    const outcome: DrainSessionOutcome = {
      key,
      status,
      turnsAtStart,
      turnsRemaining,
      persistedCount,
      durableOutputCount,
    };
    if (denied.size > 0) outcome.denied = [...denied].map(([deniedReason, turns]) => ({ reason: deniedReason, turns }));
    if (reason !== undefined) outcome.reason = reason;
    options.onEvent?.({ type: "session_finished", key, outcome });
    return outcome;
  }

  /** Claim a session file for the drain. Returns false when it is not claimable. */
  async claim(key: string, ownerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    const lease: DrainLease = {
      ownerId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs,
    };
    return (await this.claims.claimFromSessionFile(key, lease)) === "claimed";
  }

  /** Sessions with buffered turns, claimed or not (CLI scan). */
  async scan(): Promise<{ key: string; turns: number; claimed: boolean }[]> {
    const sessions = await this.orchestrator.storage.loadBuffer();
    const entries = sessions.entries ?? {};
    const out: { key: string; turns: number; claimed: boolean }[] = [];
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(entries)) {
      seen.add(key);
      const claim = this.claims.isClaimed(key) ? await this.claims.load(key) : null;
      const turns = claim
        ? claim.entry.turns.length + (claim.entry.retainedTurns?.length ?? 0)
        : entry.turns.length + (entry.retainedTurns?.length ?? 0);
      out.push({ key, turns, claimed: claim !== null });
    }
    // Claims the buffer state no longer lists (drained by an earlier run
    // whose claim file outlived its session file).
    for (const listed of await this.claims.list()) {
      if (seen.has(listed.key)) continue;
      out.push({ key: listed.key, turns: listed.turnCount, claimed: true });
    }
    return out;
  }
}
