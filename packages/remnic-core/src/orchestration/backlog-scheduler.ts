/**
 * Daemon-owned extraction backlog scheduler.
 *
 * ONE bounded in-process loop that owns ALL persisted extraction backlog:
 * at startup (existing drain claims + buffered sessions), on every poll tick
 * (new persisted work), and by retrying keys that are still pending — with
 * bounded memory (per-key COUNTS only; candidate scans never retain turn
 * payloads) and bounded outstanding work (the extraction queue's own
 * maxConcurrency gates submissions, so live foreground work keeps its share
 * of the queue).
 *
 * Claim authority: an existing claim — including an EMPTY ack tombstone — is
 * authoritative over the live buffer's in-memory copy. A tombstoned key is
 * never re-claimed or counted as work; new ingress consumes the tombstone
 * through the native save handover, which is what makes the key a candidate
 * again. Claim creation is fenced: the key is reserved synchronously on the
 * extraction queue BEFORE the async claim decision, so a queued live task for
 * the same key cannot start past the claimed-session gate until the decision
 * settles; live capture continues via the native merge-into-claim protocol.
 *
 * Failed, deferred, or policy-denied outcomes keep their turns durable in the
 * claim and re-submit after backoff (exponential from `retryBaseMs` to
 * `retryMaxMs`, reset by progress; denials wait the full max) — never a busy
 * retry. `stop()` aborts in-flight drains at their chunk boundary and leaves
 * every claim retryable; a restarted daemon's scheduler adopts them.
 */

import { hostname } from "node:os";
import { log } from "../logger.js";
import type { Orchestrator } from "../orchestrator.js";
import type { BufferDrainClaims, DrainLease } from "../storage/buffer-drain-claims.js";
import { BufferDrainRunner } from "./buffer-drain-runner.js";
import type { DrainRunnerEvent, DrainSessionOutcome } from "./buffer-drain-runner.js";
import type { ExtractionQueueCoordinator } from "./extraction-queue-coordinator.js";

/** What the scheduler needs from its host (structurally satisfied by the
 *  orchestrator wiring); injectable so tests drive ticks deterministically. */
export interface BacklogSchedulerDeps {
  queue: Pick<ExtractionQueueCoordinator, "tryReserveKey" | "releaseKeyReservation" | "maxConcurrency">;
  claims: Pick<BufferDrainClaims, "list" | "listPage" | "claimFromSessionFile" | "isClaimed">;
  /** Live per-key pending counts (counts only — never turn payloads). May be
   *  async: hosts with a lazily-loaded buffer load it here (idempotent). */
  liveBufferCounts():
    | Map<string, { turns: number; retainedTurns: number }>
    | Promise<Map<string, { turns: number; retainedTurns: number }>>;
  /** A fresh lease for claims this scheduler takes. */
  lease(): DrainLease;
  /** Drain one key to quiescence (BufferDrainRunner.drainSession). */
  drainKey(
    key: string,
    options: { ownerId: string; signal: AbortSignal; onEvent?: (event: DrainRunnerEvent) => void }
  ): Promise<DrainSessionOutcome>;
  /** Test seam: monotonic-ish clock for backoff windows. */
  now?(): number;
}

export interface BacklogSchedulerOptions {
  ownerId?: string;
  /** Scan cadence in ms (startup + new-work + retry checks). */
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

export interface BacklogSchedulerCounters {
  /** Keys submitted to the drain (claimed or adopted) this process lifetime. */
  claimed: number;
  /** Outcomes with genuinely empty claims (durable outputs preceded ack). */
  processed: number;
  /** Sum of durable outputs (memories + entities) across processed drains. */
  durableOutputs: number;
  /** Re-submissions after a failed/deferred/denied outcome. */
  retried: number;
  denied: { keys: number; turns: number };
  failed: number;
}

export type BacklogKeyState = "inflight" | "backoff" | "denied";

export interface BacklogKeySnapshot {
  key: string;
  state: BacklogKeyState;
  turnsRemaining?: number;
  reason?: string;
}

export interface BacklogSchedulerSnapshot {
  counters: BacklogSchedulerCounters;
  inFlight: string[];
  reservedKeys: string[];
  keys: BacklogKeySnapshot[];
}

interface KeyState {
  state: BacklogKeyState;
  nextAttemptMs: number;
  /** Last observed remaining turns; progress resets the backoff exponent. */
  turnsRemaining: number;
  reason?: string;
  backoffExponent: number;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;

export class BacklogScheduler {
  private readonly deps: BacklogSchedulerDeps;
  private readonly options: Required<Omit<BacklogSchedulerOptions, "now">> & Pick<BacklogSchedulerOptions, "now">;
  private readonly keys = new Map<string, KeyState>();
  private readonly inFlight = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  private readonly reserved = new Set<string>();
  private readonly counters: BacklogSchedulerCounters = {
    claimed: 0,
    processed: 0,
    durableOutputs: 0,
    retried: 0,
    denied: { keys: 0, turns: 0 },
    failed: 0,
  };
  private claimCursor: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = true;

  constructor(deps: BacklogSchedulerDeps, options: BacklogSchedulerOptions = {}) {
    this.deps = deps;
    this.options = {
      ownerId: options.ownerId ?? `daemon-drain-${process.pid}`,
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      retryMaxMs: options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      now: options.now,
    };
  }

  /** Idempotent. Starts the poll timer (unref'd) and runs an initial tick. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Idempotent. Stops the timer, aborts in-flight drains (their claims stay
   *  retryable) and waits for them to settle. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const aborts: Promise<void>[] = [];
    for (const entry of this.inFlight.values()) {
      entry.controller.abort(new Error("backlog scheduler stopping"));
      aborts.push(entry.settled);
    }
    await Promise.allSettled(aborts);
  }

  /** Bounded snapshot for ops/watchers: counters + per-key states + live sets. */
  snapshot(): BacklogSchedulerSnapshot {
    return {
      counters: {
        claimed: this.counters.claimed,
        processed: this.counters.processed,
        durableOutputs: this.counters.durableOutputs,
        retried: this.counters.retried,
        denied: { ...this.counters.denied },
        failed: this.counters.failed,
      },
      inFlight: [...this.inFlight.keys()],
      reservedKeys: [...this.reserved],
      keys: [...this.keys.entries()].map(([key, state]) => ({
        key,
        state: state.state,
        turnsRemaining: state.turnsRemaining,
        reason: state.reason,
      })),
    };
  }

  /** One scan+submit pass (tests drive this instead of the timer). Waits out
   *  any in-progress tick first so the pass always actually scans. */
  async tickForTest(): Promise<void> {
    // setImmediate: yields to the event loop so pending I/O (a slow first
    // scan) can finish; a microtask spin would starve it.
    while (this.ticking) await new Promise((resolve) => setImmediate(resolve));
    await this.tick();
  }

  /** Await the settle (slot release) of everything currently in flight,
   *  optionally excluding one still-gated key (tests). */
  async settleForTest(exclude?: string): Promise<void> {
    for (;;) {
      const pending = [...this.inFlight.entries()].filter(([key]) => key !== exclude).map(([, entry]) => entry.settled);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      // stop() may land while discovery's I/O is pending: re-check before
      // submitting anything, and again per candidate.
      // A discovery failure (EACCES/EIO on the claims dir) must not reject
      // into a detached timer callback: it would be an unhandled rejection
      // that terminates the server. Log, skip this pass, retry next poll.
      let candidates: { key: string; needsClaim: boolean }[];
      try {
        candidates = await this.discoverCandidates();
      } catch (err) {
        log.warn(
          `backlog drain: discovery failed; retrying next poll: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      if (this.stopped) return;
      this.submitCandidates(candidates);
    } finally {
      this.ticking = false;
    }
  }

  /** Bounded discovery: ONE page of existing claims with pending turns */
  private async discoverCandidates(): Promise<{ key: string; needsClaim: boolean }[]> {
    const out: { key: string; needsClaim: boolean }[] = [];
    const seen = new Set<string>();
    const pageLimit = Math.max(this.deps.queue.maxConcurrency * 4, 16);
    const page = await this.deps.claims.listPage(this.claimCursor, pageLimit);
    for (const listed of page.entries) {
      if (listed.turnCount <= 0) continue;
      seen.add(listed.key);
      out.push({ key: listed.key, needsClaim: false });
    }
    this.claimCursor = page.nextCursor;
    for (const [key, counts] of await this.deps.liveBufferCounts()) {
      if (counts.turns + counts.retainedTurns <= 0) continue;
      if (seen.has(key) || this.deps.claims.isClaimed(key)) continue;
      seen.add(key);
      out.push({ key, needsClaim: true });
    }
    return out;
  }

  /** Submit discovery candidates within the queue's concurrency bound. */
  private submitCandidates(candidates: { key: string; needsClaim: boolean }[]): void {
    for (const candidate of candidates) {
      if (!this.candidateEligible(candidate)) continue;
      // Fence the claim decision: reserve the key synchronously BEFORE the
      // async rename so no queued task for it can pass the claimed gate in
      // the meantime. Release happens when the decision settles.
      if (candidate.needsClaim) {
        if (!this.deps.queue.tryReserveKey(candidate.key)) continue;
        this.reserved.add(candidate.key);
      }
      void this.submit(candidate.key, candidate.needsClaim);
    }
  }

  /** inFlight is the authority for "already submitted" — key state only
   *  exists once an outcome landed (backoff/denied gating below). */
  private candidateEligible(candidate: { key: string; needsClaim: boolean }): boolean {
    if (this.stopped || this.inFlight.size >= this.deps.queue.maxConcurrency) return false;
    if (this.inFlight.has(candidate.key)) return false;
    const state = this.keys.get(candidate.key);
    return !(state && this.now() < state.nextAttemptMs);
  }

  /** Claim (when needed), then drain one key; the reservation spans the async
   *  claim decision, the queue entry carries the key afterwards. */
  private async submit(key: string, needsClaim: boolean): Promise<void> {
    const controller = new AbortController();
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    this.inFlight.set(key, { controller, settled });
    try {
      if (!(await this.claimForSubmit(key, needsClaim))) return;
      // Stopped between the claim decision and the task: leave the claim
      // with its lease (it expires; the next start adopts) — never drain.
      if (this.stopped) return;
      await this.drainClaimedKey(key, controller.signal);
    } catch (err) {
      // Claim/drain failures are scheduler-level: the claim content is
      // untouched — count failed and back off (never an unhandled rejection
      // in the detached submission).
      this.counters.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // SAFETY: a thrown non-Error (incl. null) carries no retry hint; the
      // optional chain reads the hint off Error throws only.
      this.setBackoff(key, (err as { turnsRemaining?: number } | null | undefined)?.turnsRemaining ?? 0, message);
      log.warn(`backlog drain: ${key} submission failed: ${message}`);
    } finally {
      this.inFlight.delete(key);
      this.reserved.delete(key);
      this.deps.queue.releaseKeyReservation(key);
      settle();
    }
  }

  /** after all — the key goes quiet without a task. "claimed": ours. */
  private async claimForSubmit(key: string, needsClaim: boolean): Promise<boolean> {
    if (!needsClaim) return true;
    try {
      const outcome = await this.deps.claims.claimFromSessionFile(key, this.deps.lease());
      if (outcome === "empty") {
        this.keys.delete(key);
        return false;
      }
      return true;
    } finally {
      this.reserved.delete(key);
      this.deps.queue.releaseKeyReservation(key);
    }
  }

  /** Drain one claimed key. drainKey reports failures as outcomes; a thrown
   *  error still means the claim content is intact — count it failed and
   *  back off. */
  private async drainClaimedKey(key: string, signal: AbortSignal): Promise<void> {
    this.counters.claimed += 1;
    try {
      const outcome = await this.deps.drainKey(key, {
        ownerId: this.options.ownerId,
        signal,
      });
      this.applyOutcome(key, outcome);
    } catch (err) {
      this.counters.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // SAFETY: a thrown non-Error (incl. null) carries no retry hint; the
      // optional chain reads the hint off Error throws only.
      this.setBackoff(key, (err as { turnsRemaining?: number } | null | undefined)?.turnsRemaining ?? 0, message);
      log.warn(`backlog drain: ${key} threw: ${message}`);
    }
  }

  private applyOutcome(key: string, outcome: DrainSessionOutcome): void {
    const deniedTurns = outcome.denied?.reduce((sum, entry) => sum + entry.turns, 0) ?? 0;
    const previous = this.keys.get(key);
    const progressed = outcome.turnsRemaining < (previous?.turnsRemaining ?? Number.POSITIVE_INFINITY);
    if (outcome.status === "drained") {
      // The claim is now an empty tombstone: authoritative, nothing pending.
      // New ingress consumes it via the native save path and re-candidates.
      this.keys.delete(key);
      this.counters.processed += 1;
      this.counters.durableOutputs += outcome.durableOutputCount;
      log.info(
        `backlog drain: ${key} drained (${outcome.turnsAtStart} turn(s), ${outcome.durableOutputCount} durable output(s))`
      );
      return;
    }
    this.recordNonDrainedCounters(previous, outcome, deniedTurns);
    const denied = deniedTurns > 0 && outcome.turnsRemaining > 0;
    this.keys.set(key, this.nextKeyState(previous, outcome, denied, progressed));
    log.info(
      `backlog drain: ${key} ${outcome.status} (${outcome.turnsRemaining} turn(s) remaining` +
        `${denied ? `, denied: ${deniedTurns}` : ""}${outcome.reason ? `, ${outcome.reason}` : ""})`
    );
  }

  /** Denied backlog counters for a non-drained outcome. */
  private recordNonDrainedCounters(
    previous: KeyState | undefined,
    outcome: DrainSessionOutcome,
    deniedTurns: number
  ): void {
    if (deniedTurns > 0) {
      this.counters.denied.keys += 1;
      this.counters.denied.turns += deniedTurns;
    }
    if (outcome.status === "failed") this.counters.failed += 1;
    else if (previous !== undefined && (previous.state === "backoff" || previous.state === "denied"))
      this.counters.retried += 1;
  }

  /** The post-drain key state: denial waits the full max window (its content
   *  is valid but currently unauthorized); progress resets the exponent. */
  private nextKeyState(
    previous: KeyState | undefined,
    outcome: DrainSessionOutcome,
    denied: boolean,
    progressed: boolean
  ): KeyState {
    return {
      state: denied ? "denied" : "backoff",
      nextAttemptMs: this.now() + this.backoffMs(previous, progressed && !denied),
      turnsRemaining: outcome.turnsRemaining,
      reason: outcome.reason,
      backoffExponent: this.nextBackoffExponent(denied, progressed, previous),
    };
  }

  private nextBackoffExponent(denied: boolean, progressed: boolean, previous: KeyState | undefined): number {
    return denied || !progressed ? (previous?.backoffExponent ?? 0) + 1 : 0;
  }

  private backoffMs(previous: KeyState | undefined, progressed: boolean): number {
    if (previous?.state === "denied") return this.options.retryMaxMs;
    const exponent = progressed ? 0 : (previous?.backoffExponent ?? 0) + 1;
    return Math.min(this.options.retryBaseMs * 2 ** exponent, this.options.retryMaxMs);
  }

  private setBackoff(key: string, turnsRemaining: number, reason: string): void {
    const previous = this.keys.get(key);
    this.keys.set(key, {
      state: "backoff",
      nextAttemptMs: this.now() + this.backoffMs(previous, false),
      turnsRemaining,
      reason,
      backoffExponent: (previous?.backoffExponent ?? 0) + 1,
    });
  }
}

/** Lease lifetime for claims the scheduler takes (matches the runner default). */
const SCHEDULER_LEASE_MS = 120_000;

/** Wire the scheduler to an orchestrator's own queue, claim store, live buffer
 *  counts and drain runner — the daemon's single ownership point. */
export function wireBacklogScheduler(
  orchestrator: Orchestrator,
  options: BacklogSchedulerOptions = {}
): BacklogScheduler {
  const ownerId = options.ownerId ?? `daemon-drain-${process.pid}`;
  const runner = new BufferDrainRunner(orchestrator);
  return new BacklogScheduler(
    {
      queue: orchestrator.extractionQueueCoordinator,
      claims: orchestrator.storage.bufferDrainClaims(),
      liveBufferCounts: async () => {
        // The daemon's buffer may be lazy: ensure the persisted state is in
        // memory before counting (load is guarded/idempotent).
        await orchestrator.buffer.load();
        return orchestrator.buffer.entryCounts();
      },
      lease: () => {
        const now = new Date().toISOString();
        return {
          ownerId,
          pid: process.pid,
          host: hostname(),
          acquiredAt: now,
          heartbeatAt: now,
          leaseMs: SCHEDULER_LEASE_MS,
        };
      },
      drainKey: (key, drainOptions) => runner.drainSession(key, drainOptions),
    },
    { ...options, ownerId }
  );
}
