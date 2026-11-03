/**
 * Out-of-process extraction-buffer drain (`remnic buffer drain`).
 *
 * The runner owns ONE claimed session at a time and drives it through the
 * SAME extraction pipeline the daemon uses — the same chunking
 * (`chunkExtractionWindow` + the model's input budget), the same retry /
 * provider-circuit semantics, the same dropped-chunk side-file recovery. It
 * adds no extraction logic of its own.
 *
 * The difference is ownership: the claimed session's turns live in a drain
 * claim (a durable file), not in a live buffer. So the runner wires a
 * claim-backed `SmartBuffer` into the extraction queue instead of the live
 * one. Every chunk that extracts successfully is removed from the claim
 * immediately, which makes the drain resumable: a kill at any instant
 * leaves the un-extracted turns in the claim, and the next run continues
 * from there.
 *
 * Concurrency lives in the CLI (worker processes, one session each at a
 * time): the in-process extraction queue is serial by design, so a single
 * runner never runs two sessions' extractions at once.
 */

import type { BufferStorage } from "../buffer-persistence.js";
import { BufferDrainClaims, type DrainLease } from "../storage/buffer-drain-claims.js";
import type { BufferEntryState, BufferState } from "../types.js";
import { hostname } from "node:os";
import { log } from "../logger.js";
import { selfDeps } from "./self-deps.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./turn-ingestion.js";
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
}

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

export type DrainRunnerEvent =
  | { type: "session_started"; key: string; turns: number }
  | { type: "session_finished"; key: string; outcome: DrainSessionOutcome };

const DEFAULT_LEASE_MS = 120_000;

/**
 * A `BufferStorage` view of one drain claim: the claim file IS the buffer.
 * Writes are the drain's progress (what is left to extract), so every
 * successfully extracted chunk is durably removed before the next one runs.
 */
class ClaimBufferStorage implements BufferStorage {
  constructor(
    private readonly claims: BufferDrainClaims,
    private readonly key: string,
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
    await this.claims.writeEntry(this.key, entry ?? { turns: [], lastExtractionAt: null, extractionCount: 0 });
  }

  async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
    await this.claims.writeEntry(key, entry);
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
    // The swap covers the whole extraction (its clear path reads the live
    // buffer), so progress lands in the claim, not in a session file.
    const claimStorage = new ClaimBufferStorage(claims, key, claim.entry);
    const coordinator = new TurnIngestionCoordinator(selfDeps<TurnIngestionDeps>(this.orchestrator));

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
      void claims.heartbeat(key, options.ownerId, leaseMs).then((state) => {
        if (state === "lost") abort.abort(new Error(`buffer drain: lease lost for session ${key}`));
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();

    const settledResult = await this.orchestrator.withBufferStorage(claimStorage, async () => {
      const swapTurns = this.orchestrator.buffer.getTurns(key);
      const { promise, resolve } = Promise.withResolvers<{ error?: unknown; result?: ExtractionRunResult }>();
      let settled = false;
      void coordinator
        .queueBufferedExtraction(swapTurns, "trigger_mode", {
          bufferKey: key,
          clearBufferAfterExtraction: true,
          // The drain owns this session's content: the daemon's own dedupe
          // gate must not skip it, and the thresholds do not apply to a
          // backlog.
          skipDedupeCheck: true,
          skipCharThreshold: true,
          skipUserTurnThreshold: true,
          abortSignal: signal,
          onTaskSettled: (error, result) => {
            if (settled) return;
            settled = true;
            resolve({ error, result });
          },
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          resolve({ error });
        });
      return await promise;
    });
    clearInterval(heartbeat);
    const remaining = await claims.load(key);
    const turnsRemaining = remaining
      ? remaining.entry.turns.length + (remaining.entry.retainedTurns?.length ?? 0)
      : 0;
    const result = settledResult.result;
    const persistedCount = result?.persistedCount ?? 0;
    const durableOutputCount = result?.durableOutputCount ?? 0;

    let status: DrainSessionStatus;
    let reason: string | undefined;
    if (turnsRemaining === 0) {
      // Everything extracted (or dropped with a recovery side-file): the
      // claim is finished and the session file is gone for good.
      await claims.ack(key, options.ownerId);
      status = "drained";
    } else if (settledResult.error) {
      // A failed run keeps the remaining turns for the next attempt.
      await claims.releaseLease(key, options.ownerId);
      status = "failed";
      reason = settledResult.error instanceof Error ? settledResult.error.message : String(settledResult.error);
    } else {
      // Deferred: provider breaker / backoff / a chunk still pending. The
      // content stays claimed and the next run resumes it.
      await claims.releaseLease(key, options.ownerId);
      status = "deferred";
      reason = result?.reason ?? "deferred";
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
      ...(reason ? { reason } : {}),
    };
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
