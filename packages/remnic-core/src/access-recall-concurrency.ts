/**
 * Per-principal recall concurrency + single-flight coalescing (issue #1906).
 *
 * Extracted from access-service.ts (structural ratchet #1520/#1995): the
 * machinery that replaced the former width-1 `withBudgetLock` recall
 * serialization with a per-principal concurrency semaphore plus query-level
 * single-flight coalescing and atomic cross-namespace budget admission.
 *
 * These are free functions taking a {@link RecallCoordinatorHost} (the
 * EngramAccessService instance) rather than methods, so the per-instance
 * semaphore/flight state and budget/idempotency/execute dependencies stay on
 * the service while the ~600 lines of coalescing logic live in their own
 * module. `raceAbort` and `attachFlightAbort` need no host (they operate on the
 * caller signal / flight object alone).
 */
import { abortError, throwIfAborted } from "./abort-error.js";
import { hashAccessIdempotencyPayload } from "./access-idempotency.js";
import {
  EngramAccessInputError,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
} from "./access-service.js";
import {
  type BudgetDecision,
  type BudgetReservation,
  type CrossNamespaceBudget,
  toBudgetWarning,
} from "./cross-namespace-budget.js";

/**
 * Per-principal recall concurrency slot (issue #1906). `active` counts
 * in-flight recalls holding a permit; `waiters` is the FIFO queue of callers
 * blocked on a permit. Process-local (per AGENTS.md multi-instance reality);
 * entries self-delete when idle so the map never grows unbounded.
 */
interface PrincipalSemaphore {
  active: number;
  waiters: Array<{ take: () => void; drop: () => void }>;
}

/** Result of one coalesced recall pipeline (issue #1906). */
export type RecallExecResult = {
  response: EngramAccessRecallResponse;
  budgetRecordPrincipal: string | null;
  /** The pipeline's own atomic budget reservation token, so a consumer that
   *  fails AFTER the pipeline (response clone, idempotency put) can release
   *  the exact entry (#1906 review round 3). */
  reservation?: BudgetReservation;
};

/**
 * A shared single-flight recall execution (issue #1906 review). Identical
 * concurrent recalls for one principal coalesce onto one `promise`. The flight
 * owns its OWN AbortController so a single caller disconnecting never cancels
 * the shared pipeline; `live` refcounts attached callers and the controller is
 * aborted only when EVERY attached caller has aborted.
 */
interface RecallFlight {
  promise: Promise<RecallExecResult>;
  controller: AbortController;
  live: number;
  /** Set true the instant the shared pipeline acquires its concurrency slot and
   *  begins executing. Before this, a KEYED flight whose only caller aborts must
   *  cancel (nothing has committed); after it, a keyed flight must persist
   *  regardless of caller disconnects (round 5 #1). Unkeyed flights ignore it —
   *  they carry no `persisted` gate and cancel whenever every caller leaves
   *  (round 14 #3). */
  committed: boolean;
  /** Called when the flight goes idle (no attached callers remain). Used to
   *  unregister the flight from `recallInFlight` only AFTER its consumers have
   *  finished — never on raw pipeline settle — so an identical arrival while a
   *  consumer is still finishing (e.g. a slow put) still coalesces (round 6 #1). */
  onIdle?: () => void;
  /** For KEYED flights only: settles when the leader's idempotency persistence
   *  (idempotency.put) completes — resolves on success, rejects with the put
   *  error on failure. The leader's consumeFlight detaches BEFORE its put runs,
   *  so `onIdle` awaits this gate before unregistering the flight — keeping it
   *  discoverable through the persistence window so an identical arrival during a
   *  slow put still coalesces instead of starting a second pipeline (round 12 #2,
   *  originally the round-7 #1 follower gate). */
  persisted?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  };
}

/**
 * The EngramAccessService surface these coordinator functions read/mutate. The
 * service passes `this` (via an unknown cast at the single call site) so the
 * per-instance state and dependencies stay owned by the service.
 */
export interface RecallCoordinatorHost {
  readonly recallSemaphores: Map<string, PrincipalSemaphore>;
  readonly recallInFlight: Map<string, RecallFlight>;
  readonly budget: Pick<CrossNamespaceBudget, "record" | "release">;
  readonly orchestrator: { readonly config: { readonly recallMaxConcurrentPerPrincipal: number } };
  executeRecall(request: EngramAccessRecallRequest): Promise<RecallExecResult>;
  handleIdempotentRead<T>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    execute: () => Promise<T>;
    afterStore?: (response: T) => Promise<void> | void;
  }): Promise<T>;
}

/**
 * Acquire a recall slot for `key` (issue #1906). Resolves with a release
 * fn; rejects with an AbortError if `signal` fires while queued. A `limit`
 * of `0` (or any non-positive/non-finite value, which cannot occur after
 * config parse) means "unlimited". Waiters are served FIFO; an aborted
 * waiter leaves the queue immediately and never holds a permit. Empty
 * entries self-delete so the map never grows unbounded (the 2026-07-10
 * unbounded-state-file lesson: every structure has a delete path).
 */
function acquireRecallSlot(
  host: RecallCoordinatorHost,
  key: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ release: () => void; waitedMs: number }> {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  const sem = host.recallSemaphores.get(key) ?? { active: 0, waiters: [] };
  host.recallSemaphores.set(key, sem);
  const release = () => {
    sem.active--;
    const next = sem.waiters.shift();
    if (next) {
      sem.active++;
      next.take();
    }
    if (sem.active === 0 && sem.waiters.length === 0) {
      host.recallSemaphores.delete(key);
    }
  };
  if (sem.active < cap) {
    // Slot free — acquired immediately, NO queue wait. (Measuring wall-clock
    // here would count event-loop scheduling jitter under load and wrongly
    // report a positive queueWaitMs for an uncontended recall.)
    sem.active++;
    return Promise.resolve({ release, waitedMs: 0 });
  }
  // Contended — measure the real time spent blocked for a slot.
  const startedWaiting = Date.now();
  return new Promise<{ release: () => void; waitedMs: number }>((resolve, reject) => {
    const waiter = {
      take: () => {
        signal?.removeEventListener("abort", waiter.drop);
        resolve({ release, waitedMs: Date.now() - startedWaiting });
      },
      drop: () => {
        const i = sem.waiters.indexOf(waiter);
        if (i >= 0) sem.waiters.splice(i, 1);
        if (sem.active === 0 && sem.waiters.length === 0) {
          host.recallSemaphores.delete(key);
        }
        reject(abortError("operation aborted"));
      },
    };
    if (signal?.aborted) {
      waiter.drop();
      return;
    }
    signal?.addEventListener("abort", waiter.drop, { once: true });
    sem.waiters.push(waiter);
  });
}

/**
 * Runs `fn` under a per-principal recall slot, passing the measured queue
 * wait (ms) — 0 for an uncontended acquire, the real blocked time when the
 * cap was reached — so it can be folded additively into recall-timings.
 * Replaces the former width-1 `withBudgetLock` FIFO serialization (issue
 * #1906): budget accounting stays correct because peek/record are synchronous
 * (see cross-namespace-budget.ts). Release always runs in `finally`.
 */
export async function withRecallConcurrency<T>(
  host: RecallCoordinatorHost,
  principal: string,
  signal: AbortSignal | undefined,
  fn: (queueWaitMs: number) => Promise<T>,
): Promise<T> {
  const key = principal || "__anonymous__";
  const limit = host.orchestrator.config.recallMaxConcurrentPerPrincipal;
  throwIfAborted(signal);
  const { release, waitedMs } = await acquireRecallSlot(host, key, limit, signal);
  try {
    // The signal may have fired while queued: `take()` already removed the
    // abort listener when granting this slot, so re-check before entering `fn`.
    // Without this, a caller (or flight controller) that aborted just after
    // admission would still start the recall pipeline and reserve/run work
    // until a later rollback; the `finally` below releases the slot instead
    // (round 14 #2).
    throwIfAborted(signal);
    return await fn(waitedMs);
  } finally {
    release();
  }
}

/**
 * Race `p` against `signal` (issue #1906). A single-flight caller waits on
 * the shared flight promise but must be able to leave on its own abort. The
 * abort listener is removed as soon as the race settles (either `p` won or
 * the abort fired) so a settled-first promise never leaks a listener on a
 * long-lived signal.
 *
 * Pre-check the signal BEFORE building the race: an already-aborted signal
 * must win even when `p` is already fulfilled. `Promise.race` settles from
 * already-resolved members in array order, so a fulfilled `p` (index 0) would
 * otherwise beat the synchronously-rejected abort racer (index 1) and let an
 * aborted caller proceed into its own persistence + budget accounting before
 * the next abort check runs (round 15 #1).
 */
export function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError("operation aborted"));
  let onAbort: (() => void) | undefined;
  const racer = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([p, racer]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Attach a caller to a single-flight recall (issue #1906 review). Increments
 * the flight refcount and (when `cancelOnAbort`) wires the caller's abort so
 * the SHARED pipeline is cancelled when every attached caller has aborted —
 * EXCEPT a KEYED flight that has already committed to execution, which must
 * persist regardless of caller disconnects (round 5 #1). A caller attached
 * with `cancelOnAbort=false` still holds a refcount slot (keeping the flight
 * alive) but never cancels it. Returns a `detach` to call when the caller
 * settles.
 */
function attachFlightAbort(
  flight: RecallFlight,
  signal: AbortSignal | undefined,
  cancelOnAbort: boolean,
): () => void {
  flight.live += 1;
  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    flight.live -= 1;
    if (flight.live === 0) {
      // A KEYED flight that already began executing must persist even though
      // its last caller left (round 5 #1); cancel only a flight that has not
      // committed (still queued for a slot) or has nothing to persist —
      // unkeyed, no `persisted` gate (round 14 #3).
      if (!flight.persisted || !flight.committed) flight.controller.abort();
      flight.onIdle?.();
    }
  };
  if (cancelOnAbort && signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return () => {
    if (settled) return;
    settled = true;
    flight.live -= 1;
    if (cancelOnAbort && signal) signal.removeEventListener("abort", onAbort);
    // Unregister only once the LAST consumer finishes, so a joiner arriving
    // while a consumer is still settling (slow put / hooked consume) still
    // coalesces onto the shared result (round 6 #1).
    if (flight.live === 0) flight.onIdle?.();
  };
}

/** Consume a shared recall flight for one caller (issue #1906 review). When
 *  `race` is true the caller leaves early on its own abort; when false (a
 *  committed idempotency-keyed leader) it awaits the flight to completion so
 *  persistence survives its disconnect (round 5 #1). `cancelOnAbort` (default
 *  `race`) decides whether this caller's abort counts toward cancelling the
 *  shared pipeline: a keyed leader awaits the flight (race=false) yet still
 *  wires its abort so that, while the flight is only QUEUED and no other caller
 *  is attached, its disconnect cancels the not-yet-committed pipeline (round
 *  14 #3). Records this caller's OWN cross-namespace budget event (coalesced
 *  callers), clones the response inside the rollback scope, and returns the
 *  reservation this caller owns so an outer failure can release the exact
 *  entry. If the caller leaves before observing the result, the pipeline
 *  reservation it owns is released once the flight resolves so a cancelled
 *  recall never leaks quota (round 5 #2). */
export async function consumeFlight(
  host: RecallCoordinatorHost,
  flight: RecallFlight,
  request: EngramAccessRecallRequest,
  recordBudget: boolean,
  race: boolean,
  cancelOnAbort: boolean = race,
): Promise<{ response: EngramAccessRecallResponse; reservation: BudgetReservation | undefined }> {
  const detach = attachFlightAbort(flight, request.abortSignal, cancelOnAbort);
  try {
    let result: RecallExecResult;
    try {
      result = race
        ? await raceAbort(flight.promise, request.abortSignal)
        : await flight.promise;
    } catch (err) {
      // This caller left before observing the result. If it OWNS the
      // pipeline's reservation (recordBudget=false) and the flight still
      // resolves with one, release it so a cancelled recall does not leak
      // quota (round 5 #2). A rejected flight already rolled back inside
      // executeRecall, so the resolve handler simply never fires.
      if (!recordBudget) {
        flight.promise.then(
          (settled) => {
            if (settled.reservation) host.budget.release(settled.reservation);
          },
          () => {},
        );
      }
      throw err;
    }
    // A committed (race=false) caller applies its own abort later (after
    // persistence); a racing caller re-checks here. If the abort landed in the
    // gap AFTER the result resolved, release the pipeline reservation this
    // caller owns (recordBudget=false) rather than leak it (round 6 #2).
    if (race && request.abortSignal?.aborted) {
      if (!recordBudget && result.reservation) {
        host.budget.release(result.reservation);
      }
      throwIfAborted(request.abortSignal);
    }
    // A caller that ran the pipeline inherits its reservation token; a
    // coalesced caller records its OWN cross-namespace event below.
    let reservation = recordBudget ? undefined : result.reservation;
    let ownDecision: BudgetDecision | undefined;
    if (recordBudget && result.budgetRecordPrincipal) {
      const decision = host.budget.record(result.budgetRecordPrincipal);
      if (!decision.allowed) {
        throw new EngramAccessInputError(
          `recall denied: cross-namespace budget exceeded (${decision.count}/${decision.limit.hardLimit} in ${decision.limit.windowMs}ms window)`,
        );
      }
      reservation = decision.reservation;
      ownDecision = decision;
    }
    try {
      const response = structuredClone(result.response);
      if (ownDecision) {
        // The clone carries the LEADER's budgetWarning; replace it with THIS
        // coalesced caller's OWN soft-limit decision so the caller whose event
        // actually crossed the soft limit sees its own warning (round 4 #2).
        // `toBudgetWarning` strips the server-only `reservation` token so the
        // principal id never reaches the response / cache (round 10 #2).
        response.budgetWarning = toBudgetWarning(ownDecision);
      }
      return { response, reservation };
    } catch (err) {
      // Clone threw on a successful pipeline — release the admission entry
      // rather than leak it (round 3 #1).
      host.budget.release(reservation);
      throw err;
    }
  } finally {
    detach();
  }
}

/** UNKEYED follower path (issue #1906 review): join an already-registered
 *  flight WITHOUT taking a concurrency slot. Only unkeyed callers reach here —
 *  keyed callers enter the idempotency guard first (round 12 #1) and coalesce
 *  via leadRecallFlight's existing-join instead. Mirrors the leaders' final
 *  post-consume abort guard: a caller that disconnected after its per-caller
 *  reservation was recorded but before delivery releases it rather than leaking
 *  quota (round 8 #1). */
async function followRecallFlight(
  host: RecallCoordinatorHost,
  flight: RecallFlight,
  request: EngramAccessRecallRequest,
): Promise<EngramAccessRecallResponse> {
  const consumed = await consumeFlight(host, flight, request, true, true);
  try {
    throwIfAborted(request.abortSignal);
  } catch (err) {
    host.budget.release(consumed.reservation);
    throw err;
  }
  return consumed.response;
}

/** Non-coalesced recall (single-flight disabled): per-request execution
 *  under a concurrency slot, the caller's own signal driving its pipeline. */
async function runRecallDirect(
  host: RecallCoordinatorHost,
  request: EngramAccessRecallRequest,
  normalizedRequest: EngramAccessRecallRequest,
  requestFingerprint: unknown,
  queueWaitMs: number,
): Promise<EngramAccessRecallResponse> {
  let capturedReservation: BudgetReservation | undefined;
  let response: EngramAccessRecallResponse;
  try {
    response = await host.handleIdempotentRead({
      operation: "recall",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      execute: async () => {
        // Create + await the pipeline inside the closure so its rejection is
        // observed immediately (no unhandled-rejection window across the
        // idempotency-lock await). The caller's own signal drives this
        // non-coalesced pipeline.
        const exec = host.executeRecall({ ...normalizedRequest, queueWaitMs });
        let result: RecallExecResult;
        try {
          result = await raceAbort(exec, request.abortSignal);
        } catch (err) {
          // Caller left (abort) before observing the result. If exec still
          // resolves with a reservation, release it so the cancelled recall
          // does not leak quota (round 5 #2). A rejected exec already rolled
          // back inside executeRecall.
          exec.then(
            (settled) => {
              if (settled.reservation) host.budget.release(settled.reservation);
            },
            () => {},
          );
          throw err;
        }
        let cloned: EngramAccessRecallResponse;
        try {
          cloned = structuredClone(result.response);
        } catch (err) {
          // Clone threw on a successful pipeline — release now (round 3 #1);
          // leave capturedReservation unset so the outer catch is a no-op.
          host.budget.release(result.reservation);
          throw err;
        }
        // Clone succeeded — the outer catch owns rollback if a later step
        // (idempotency put) fails (round 4 #1).
        capturedReservation = result.reservation;
        return cloned;
      },
    });
  } catch (err) {
    if (capturedReservation) host.budget.release(capturedReservation);
    throw err;
  }
  try {
    throwIfAborted(request.abortSignal);
  } catch (err) {
    // Abort landed after the result was produced but before delivery. For a
    // NON-persisted (unkeyed) recall the completed result is discarded and
    // will not be replayed, so release its reservation rather than leak quota
    // (round 6 #2). A keyed recall persisted its result (a retry replays it),
    // so its budget event legitimately stands (round 5 #1).
    if (!request.idempotencyKey?.trim() && capturedReservation) {
      host.budget.release(capturedReservation);
    }
    throw err;
  }
  return response;
}

/** Register a single-flight and start its ONE shared pipeline in the
 *  background (issue #1906 review). The pipeline runs under a concurrency
 *  slot tied to the FLIGHT'S own abort controller (#3) — so a caller
 *  disconnecting (even while the flight is still queued for a slot) never
 *  cancels it while other callers still want the result. The flight
 *  unregisters via `onIdle` when its LAST consumer finishes (round 6 #1) or
 *  when every caller has aborted (round 3 #2) — NOT on raw pipeline settle,
 *  so a joiner arriving while a consumer is still finishing still coalesces. */
export function createAndStartFlight(
  host: RecallCoordinatorHost,
  normalizedRequest: EngramAccessRecallRequest,
  flightKey: string,
  principalKey: string,
  keyed: boolean,
): RecallFlight {
  const controller = new AbortController();
  let settleExec!: (result: RecallExecResult) => void;
  let failExec!: (reason: unknown) => void;
  const flightPromise = new Promise<RecallExecResult>((resolve, reject) => {
    settleExec = resolve;
    failExec = reject;
  });
  // Consumers attach their own handlers; keep Node quiet if none do yet.
  flightPromise.catch(() => {});
  // KEYED flights carry a persistence gate that fast-path followers await so
  // they never report success before the leader's idempotency.put settled
  // (round 7 #1).
  let persisted: RecallFlight["persisted"];
  if (keyed) {
    let resolvePersist!: () => void;
    let rejectPersist!: (reason: unknown) => void;
    const persistPromise = new Promise<void>((resolve, reject) => {
      resolvePersist = resolve;
      rejectPersist = reject;
    });
    persistPromise.catch(() => {});
    persisted = { promise: persistPromise, resolve: resolvePersist, reject: rejectPersist };
  }
  const flight: RecallFlight = {
    promise: flightPromise,
    controller,
    live: 0,
    committed: false,
    onIdle: () => {
      const unregister = () => {
        if (host.recallInFlight.get(flightKey) === flight) {
          host.recallInFlight.delete(flightKey);
        }
      };
      // A KEYED leader's consumeFlight detaches (live -> 0) BEFORE
      // handleIdempotentRead runs idempotency.put, so unregistering on detach
      // would drop the flight DURING the persistence window — an identical
      // arrival then finds no flight and starts a second pipeline + reserve.
      // Keep the flight discoverable until `persisted` settles so arrivals
      // during a slow put still coalesce onto the one pipeline (round 12 #2).
      // Unkeyed flights have no put: unregister immediately.
      if (persisted) {
        persisted.promise.then(unregister, unregister);
      } else {
        unregister();
      }
    },
    ...(persisted ? { persisted } : {}),
  };
  host.recallInFlight.set(flightKey, flight);
  withRecallConcurrency(host, principalKey, controller.signal, async (queueWaitMs) => {
    // A slot was granted and the abort re-check in withRecallConcurrency passed
    // — the pipeline is now committing to execution. Past this point a keyed
    // flight persists even if its callers disconnect (round 5 #1); before it,
    // attachFlightAbort cancels a keyed flight whose only caller aborts while
    // still queued (round 14 #3).
    flight.committed = true;
    return host.executeRecall({
      ...normalizedRequest,
      abortSignal: controller.signal,
      queueWaitMs,
    });
  }).then(settleExec, failExec);
  return flight;
}

/** Leader path (issue #1906 review): consult the idempotency guard FIRST so an
 *  idempotent REPLAY returns the stored response WITHOUT starting a pipeline,
 *  flight, or budget reserve (#1/#2). On a miss, coalesce onto a LIVE
 *  race-registered flight if one exists, else start the one shared pipeline
 *  and consume it as the leader. A failure after the reserve (e.g. idempotency
 *  put) releases this caller's exact reservation (round 3 #3). */
export async function leadRecallFlight(
  host: RecallCoordinatorHost,
  request: EngramAccessRecallRequest,
  normalizedRequest: EngramAccessRecallRequest,
  requestFingerprint: unknown,
  flightKey: string,
  principalKey: string,
): Promise<EngramAccessRecallResponse> {
  const keyed = !!request.idempotencyKey?.trim();
  let capturedReservation: BudgetReservation | undefined;
  // The flight THIS call created (leader) and thus owns persistence for — used
  // to settle its `persisted` gate so keyed fast-path followers learn the
  // put outcome (round 7 #1).
  let ownedFlight: RecallFlight | undefined;
  let response: EngramAccessRecallResponse;
  try {
    response = await host.handleIdempotentRead({
      operation: "recall",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      execute: async () => {
        // A keyed request commits (race=false): the leader awaits the flight
        // to completion so idempotency.put persists even if the leader itself
        // disconnects (round 5 #1). A non-keyed request races its own signal
        // and may leave early (nothing to persist).
        const race = !keyed;
        const existing = host.recallInFlight.get(flightKey);
        if (existing && !existing.controller.signal.aborted) {
          // A LIVE identical flight registered between our fast-path miss and
          // the idempotency guard — join it and record our own event. But a
          // caller that already disconnected must NOT join: a keyed join is
          // non-racing (race=false), so it would record its own cross-namespace
          // budget event and run idempotency.put before the late abort check.
          // Reject at admission instead; the existing flight continues for its
          // other live consumers (round 10 #1).
          throwIfAborted(request.abortSignal);
          // `cancelOnAbort=true` (not the race=false default): a keyed
          // existing-join follower is non-racing (it awaits the shared flight
          // to completion), but its abort must still be COUNTED in the flight's
          // live refcount while the flight is only QUEUED. Otherwise, at
          // recallMaxConcurrentPerPrincipal=1, if the leader disconnects
          // (live 2 -> 1) and this follower then disconnects, live would stay 1
          // and the flight would execute + reserve + persist with no caller
          // connected. Counting drops live to 0, and attachFlightAbort's
          // committed guard (!persisted || !committed) cancels the queued flight
          // while leaving a committed keyed flight to persist (round 15 #2).
          const consumed = await consumeFlight(host, existing, request, true, race, true);
          capturedReservation = consumed.reservation;
          // A KEYED follower that coalesced onto the leader's flight must
          // inherit the leader's persistence outcome before reporting success.
          // The shared pipeline settling is NOT the leader's idempotency.put:
          // the leader detaches (consumeFlight) BEFORE its put, so without this
          // await a keyed follower could return success (and run its OWN
          // idempotency.put), keeping its cross-namespace reservation, while the
          // leader's put later FAILS — a phantom success that a same-key retry
          // would then diverge from. Await the joined flight's `persisted` gate
          // so a keyed join resolves only after the leader's put succeeds and
          // REJECTS (releasing this caller's reservation via the outer catch,
          // and skipping its own put) with the leader's exact error when the
          // put fails — identical to the leader's put-failure behavior (round
          // 13 #1). Race this persistence wait with the follower's OWN abort
          // signal (round 14 #1/#4): a keyed follower whose HTTP/MCP client
          // disconnects while the leader's put is still pending must receive
          // its own AbortError PROMPTLY rather than block until the put settles
          // (and, on put failure, get the store error instead of AbortError).
          // The follower already detached from the flight inside consumeFlight
          // (its non-racing await ran to the shared settle), so bailing here
          // never decrements the leader's refcount or cancels its controller —
          // the leader's persistence continues for the flight's other
          // consumers. On abort the outer catch releases ONLY this follower's
          // reservation. Unkeyed joins (race=true) keep existing behavior: they
          // consumed the shared result and never depend on another caller's
          // persistence, so they never block on `persisted`.
          if (keyed) {
            if (existing.persisted) {
              await raceAbort(existing.persisted.promise, request.abortSignal);
            } else {
              // The joined flight was started by an UNKEYED leader, so it
              // carries no `persisted` gate. The non-racing consume (race=false
              // for a keyed caller) never observed this follower's abort, so a
              // keyed follower that disconnected while the shared pipeline was
              // still running would otherwise return success here and let
              // handleIdempotentRead persist its key + keep its recorded
              // cross-namespace budget event. Recheck the abort before
              // returning so it rejects with AbortError instead: the outer
              // catch releases this follower's reservation and execute()
              // throwing skips its own idempotency.put — matching the
              // keyed-follower-on-keyed-leader persistence path (round 16 #1).
              throwIfAborted(request.abortSignal);
            }
          }
          return consumed.response;
        }
        // No LIVE flight to join. If the caller already disconnected before we
        // committed any work, reject at admission — creating the flight starts
        // the pipeline (queue + execute + persist) and reserves a cross-namespace
        // budget event. For a keyed leader `race` is false, so without this the
        // caller would burn a full recall + budget event before the final
        // post-consume abort check rejects, even though it left before admission
        // and no follower is here to keep the flight alive. The old width-1
        // budget lock rejected before starting work; preserve that (#1906 r9).
        throwIfAborted(request.abortSignal);
        const flight = createAndStartFlight(host, normalizedRequest, flightKey, principalKey, keyed);
        ownedFlight = flight;
        // The leader's own budget event is reserved inside the pipeline, so it
        // must NOT record again here. `cancelOnAbort=true` even for a keyed
        // leader (race=false): while the flight is only QUEUED for a slot and
        // this is its sole caller, the leader's disconnect cancels the
        // not-yet-committed pipeline (attachFlightAbort's committed guard keeps
        // a post-commit keyed flight persisting, and any additional live caller
        // keeps live > 0 so the shared flight survives) (round 14 #3).
        const consumed = await consumeFlight(host, flight, request, false, race, true);
        capturedReservation = consumed.reservation;
        return consumed.response;
      },
    });
  } catch (err) {
    // A failure AFTER the caller reserved (idempotency put, or any post-
    // execute step in handleIdempotentRead) releases the exact reservation.
    // If execute() rejected before reserving — leader abort mid-pipeline, or
    // a pipeline failure already rolled back inside executeRecall/consumeFlight
    // — capturedReservation is undefined, so this is a no-op (round 3 #3).
    if (capturedReservation) host.budget.release(capturedReservation);
    // Tell keyed followers coalescing via the existing-join (they await this
    // flight's `persisted` gate) that persistence failed so they behave
    // identically to this leader (release + reject) — no phantom success
    // (round 7 #1; keyed followers moved to the existing-join in round 12 #1).
    ownedFlight?.persisted?.reject(err);
    throw err;
  }
  // Leader persisted successfully — resolve the gate so keyed followers
  // awaiting the put return success.
  ownedFlight?.persisted?.resolve();
  try {
    throwIfAborted(request.abortSignal);
  } catch (err) {
    // Abort landed after consumption but before delivery. A NON-persisted
    // (unkeyed) recall's completed result is discarded (no replay), so release
    // its reservation rather than leak quota (round 6 #2); a keyed recall
    // persisted its result, so its budget event legitimately stands (round 5 #1).
    if (!keyed && capturedReservation) {
      host.budget.release(capturedReservation);
    }
    throw err;
  }
  return response;
}

/**
 * Top-level recall coordination (issue #1906): dispatch a validated recall to
 * either the non-coalesced per-request path (single-flight disabled) or the
 * single-flight leader/follower coalescing path. `singleFlight` is resolved by
 * the caller through the shared access-setup capability projection so the
 * config flag is read only in capabilities.ts (#1523 scattered-gate ratchet).
 */
export function coordinateRecall(
  host: RecallCoordinatorHost,
  request: EngramAccessRecallRequest,
  normalizedRequest: EngramAccessRecallRequest,
  requestFingerprint: Omit<EngramAccessRecallRequest, "abortSignal">,
  principalKey: string,
  singleFlight: boolean,
): Promise<EngramAccessRecallResponse> {
  if (!singleFlight) {
    // No coalescing: per-request execution under a concurrency slot.
    return withRecallConcurrency(
      host,
      principalKey,
      request.abortSignal,
      (queueWaitMs) =>
        runRecallDirect(host, request, normalizedRequest, requestFingerprint, queueWaitMs),
    );
  }

  // The flight key represents the recall WORK — the query + options that shape
  // the result — NOT the persistence key. `idempotencyKey` only selects an
  // idempotency-store slot; it never changes the computed result. Excluding it
  // lets identical recalls that arrive with DISTINCT per-request idempotency
  // keys (a common transport-retry pattern) coalesce onto ONE pipeline + slot
  // instead of each key spawning its own (round 11). Contract: EVERY keyed
  // caller enters the idempotency guard first (round 12 #1) and persists the
  // shared result under ITS OWN key, so a same-key retry always replays from
  // the store; distinct keys on identical work still coalesce onto one pipeline.
  const { idempotencyKey: _flightKeyOmitIdemKey, ...flightFingerprint } = requestFingerprint;
  const flightKey = `${principalKey}\u0000${hashAccessIdempotencyPayload({
    operation: "recall",
    request: flightFingerprint,
  })}`;
  // UNKEYED follower fast-path (#1906 review #2): join an in-flight identical
  // recall WITHOUT acquiring a concurrency slot. Because the leader registers
  // its flight synchronously (below, before any await), every later identical
  // arrival coalesces here — even when the concurrency cap is below the number
  // of concurrent callers. Followers never wait for, or consume, a slot.
  //
  // KEYED callers must NOT take this fast-path: they enter the idempotency
  // guard FIRST (leadRecallFlight -> handleIdempotentRead) so a stored response
  // REPLAYS and a reused key with a different payload raises a CONFLICT, instead
  // of silently joining the flight and skipping the store check (round 12 #1).
  // On a store MISS a keyed caller still coalesces onto a live flight via
  // leadRecallFlight's existing-join, then persists under its own key.
  const keyed = !!request.idempotencyKey?.trim();
  const existing = host.recallInFlight.get(flightKey);
  // Skip a flight already cancelled (all its callers aborted) — it will
  // reject with AbortError; lead a fresh flight instead (round 3 #2).
  if (!keyed && existing && !existing.controller.signal.aborted) {
    // A caller that already disconnected must NOT join a live flight: joining
    // records its own cross-namespace budget event before the late abort check.
    // Reject at admission; the existing flight continues for its other live
    // consumers (round 10 #1).
    throwIfAborted(request.abortSignal);
    return followRecallFlight(host, existing, request);
  }
  // We are the leader: leadRecallFlight registers the flight synchronously in
  // this same turn, then acquires a slot to run the one shared pipeline.
  return leadRecallFlight(
    host,
    request,
    normalizedRequest,
    requestFingerprint,
    flightKey,
    principalKey,
  );
}
