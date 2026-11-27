import { abortError, isAbortError, raceAbort, throwIfAborted } from "./abort-error.js";
import { hashAccessIdempotencyPayload } from "./access-idempotency.js";
import {
  EngramAccessDeadlineExceededError,
  EngramAccessInputError,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
} from "./access-service.js";
import { clientDeadlineTimerMs, resolveClientDeadlineAtMs } from "./recall-qos.js";
import {
  composeMissingMemoryContext,
  composeRecallContext,
} from "./recall-context-composition.js";
import { DEFAULT_RECALL_DISCLOSURE, isRecallDisclosure } from "./types.js";
import {
  type BudgetDecision,
  type BudgetReservation,
  type CrossNamespaceBudget,
  toBudgetWarning,
} from "./cross-namespace-budget.js";

export { raceAbort } from "./abort-error.js";

interface PrincipalSemaphore {
  active: number;
  waiters: Array<{ take: () => void; drop: () => void }>;
}

export type RecallExecResult = {
  response: EngramAccessRecallResponse;
  budgetRecordPrincipal: string | null;
  reservation?: BudgetReservation;
};

interface RecallFlight {
  promise: Promise<RecallExecResult>;
  controller: AbortController;
  live: number;
  committed: boolean;
  onIdle?: () => void;
  persisted?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  };
}

export interface RecallCoordinatorHost {
  readonly recallSemaphores: Map<string, PrincipalSemaphore>;
  readonly recallInFlight: Map<string, RecallFlight>;
  readonly budget: Pick<CrossNamespaceBudget, "record" | "release">;
  readonly orchestrator: {
    readonly config: {
      readonly recallMaxConcurrentPerPrincipal: number;
      readonly defaultNamespace: string;
    };
  };
  executeRecall(request: EngramAccessRecallRequest): Promise<RecallExecResult>;
  handleIdempotentRead<T>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    execute: () => Promise<T>;
    afterStore?: (response: T) => Promise<void> | void;
  }): Promise<T>;
}

function acquireRecallSlot(
  host: RecallCoordinatorHost,
  key: string,
  limit: number,
  signal?: AbortSignal,
  deadlineAtMs?: number | null,
): Promise<{ release: () => void; waitedMs: number }> {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  // A deadline already past fails as a timeout, not a cancellation — checked
  // before any semaphore state is inserted so an expired request cannot leave
  // an idle entry behind (issue #3514 review).
  if (deadlineAtMs != null && deadlineAtMs <= Date.now()) {
    return Promise.reject(
      new EngramAccessDeadlineExceededError("recall deadline exceeded while queued"),
    );
  }
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
    sem.active++;
    return Promise.resolve({ release, waitedMs: 0 });
  }
  const startedWaiting = Date.now();
  return new Promise<{ release: () => void; waitedMs: number }>((resolve, reject) => {
    let deadlineHandle: NodeJS.Timeout | null = null;
    const removeWaiter = () => {
      const i = sem.waiters.indexOf(waiter);
      if (i >= 0) sem.waiters.splice(i, 1);
      if (deadlineHandle) clearTimeout(deadlineHandle);
      if (sem.active === 0 && sem.waiters.length === 0) {
        host.recallSemaphores.delete(key);
      }
    };
    const waiter = {
      take: () => {
        if (deadlineHandle) clearTimeout(deadlineHandle);
        signal?.removeEventListener("abort", waiter.drop);
        resolve({ release, waitedMs: Date.now() - startedWaiting });
      },
      drop: () => {
        removeWaiter();
        reject(abortError("operation aborted"));
      },
      // A client deadline expiring mid-queue degrades as a timeout, not
      // caller cancellation (#3514 review).
      expire: () => {
        removeWaiter();
        signal?.removeEventListener("abort", waiter.drop);
        reject(
          new EngramAccessDeadlineExceededError("recall deadline exceeded while queued"),
        );
      },
    };
    if (signal?.aborted) {
      waiter.drop();
      return;
    }
    signal?.addEventListener("abort", waiter.drop, { once: true });
    if (deadlineAtMs != null) {
      deadlineHandle = setTimeout(waiter.expire, clientDeadlineTimerMs(deadlineAtMs, startedWaiting));
    }
    sem.waiters.push(waiter);
  });
}

export async function withRecallConcurrency<T>(
  host: RecallCoordinatorHost,
  principal: string,
  signal: AbortSignal | undefined,
  fn: (queueWaitMs: number) => Promise<T>,
  deadlineAtMs?: number | null,
): Promise<T> {
  const key = principal || "__anonymous__";
  const limit = host.orchestrator.config.recallMaxConcurrentPerPrincipal;
  throwIfAborted(signal);
  const { release, waitedMs } = await acquireRecallSlot(host, key, limit, signal, deadlineAtMs);
  try {
    throwIfAborted(signal);
    return await fn(waitedMs);
  } finally {
    release();
  }
}


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
    // coalesces onto the shared result (round 6 #1). The last consumer out
    // cancels the flight for ANY leave reason — settle, abort, or a
    // deadline-fired detach — with the same committed-keyed persistence guard
    // as the abort path: a shared pipeline nobody still consumes must not keep
    // a concurrency slot queued (#3514 review).
    if (flight.live === 0) {
      if (!flight.persisted || !flight.committed) flight.controller.abort();
      flight.onIdle?.();
    }
  };
}


/** Bound one consumer's flight wait by its OWN absolute deadline (#3514
 *  review). The shared pipeline belongs to every live consumer, so a firing
 *  deadline rejects ONLY this caller — detach drops the live refcount and the
 *  flight continues (or cancels at the last consumer via the flight
 *  controller, never because one consumer's deadline fired while others
 *  remain). A non-racing caller (committed keyed leader or keyed join) keeps
 *  awaiting once the flight is `committed`: its deadline abandons only a
 *  still-queued wait — the persistence contract outranks its own deadline
 *  mid-execution. */
function consumeWithinDeadline(
  flight: RecallFlight,
  request: EngramAccessRecallRequest,
  race: boolean,
): Promise<RecallExecResult> {
  const deadlineAtMs = resolveClientDeadlineAtMs(request.deadlineMs, Date.now());
  // Validate expiry BEFORE creating the abort race: a `settle` built then
  // discarded by this early return keeps its abort listener armed, and a later
  // caller abort would reject it unhandled (#3514 review).
  if (deadlineAtMs !== null && deadlineAtMs <= Date.now()) {
    return Promise.reject(
      new EngramAccessDeadlineExceededError("recall deadline exceeded while queued"),
    );
  }
  const settle = race
    ? raceAbort(flight.promise, request.abortSignal)
    : flight.promise;
  if (deadlineAtMs === null) return settle;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!race && flight.committed) return;
      reject(
        new EngramAccessDeadlineExceededError("recall deadline exceeded while queued"),
      );
    }, clientDeadlineTimerMs(deadlineAtMs, Date.now()));
    settle.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
      result = await consumeWithinDeadline(flight, request, race);
    } catch (err) {
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
    if (race && request.abortSignal?.aborted) {
      if (!recordBudget && result.reservation) {
        host.budget.release(result.reservation);
      }
      throwIfAborted(request.abortSignal);
    }
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
        response.budgetWarning = toBudgetWarning(ownDecision);
      }
      return { response, reservation };
    } catch (err) {
      host.budget.release(reservation);
      throw err;
    }
  } finally {
    detach();
  }
}

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
        const exec = host.executeRecall({ ...normalizedRequest, queueWaitMs });
        let result: RecallExecResult;
        try {
          result = await raceAbort(exec, request.abortSignal);
        } catch (err) {
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
          host.budget.release(result.reservation);
          throw err;
        }
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
    if (!request.idempotencyKey?.trim() && capturedReservation) {
      host.budget.release(capturedReservation);
    }
    throw err;
  }
  return response;
}

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
  flightPromise.catch(() => {});
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
      if (persisted) {
        persisted.promise.then(unregister, unregister);
      } else {
        unregister();
      }
    },
    ...(persisted ? { persisted } : {}),
  };
  host.recallInFlight.set(flightKey, flight);
  // The flight's own controller — not the leader's deadline — bounds the
  // queued slot wait (#3514 review): each consumer's deadline detaches ONLY
  // that consumer (consumeFlight), and the LAST consumer out aborts the
  // controller, so queued shared work stays eligible while any live consumer
  // still has budget instead of expiring on the leader's deadline alone.
  withRecallConcurrency(host, principalKey, controller.signal, async (queueWaitMs) => {
    flight.committed = true;
    return host.executeRecall({
      ...normalizedRequest,
      abortSignal: controller.signal,
      queueWaitMs,
    });
  }).then(settleExec, failExec);
  return flight;
}

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
  let ownedFlight: RecallFlight | undefined;
  let response: EngramAccessRecallResponse;
  try {
    response = await host.handleIdempotentRead({
      operation: "recall",
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      execute: async () => {
        const race = !keyed;
        const existing = host.recallInFlight.get(flightKey);
        if (existing && !existing.controller.signal.aborted) {
          throwIfAborted(request.abortSignal);
          const consumed = await consumeFlight(host, existing, normalizedRequest, true, race, true);
          capturedReservation = consumed.reservation;
          if (keyed) {
            if (existing.persisted) {
              await raceAbort(existing.persisted.promise, request.abortSignal);
            } else {
              throwIfAborted(request.abortSignal);
            }
          }
          return consumed.response;
        }
        throwIfAborted(request.abortSignal);
        const flight = createAndStartFlight(host, normalizedRequest, flightKey, principalKey, keyed);
        ownedFlight = flight;
        const consumed = await consumeFlight(host, flight, normalizedRequest, false, race, true);
        capturedReservation = consumed.reservation;
        return consumed.response;
      },
    });
  } catch (err) {
    if (capturedReservation) host.budget.release(capturedReservation);
    // A CALLER-LOCAL wait failure (this leader's own deadline or abort) means
    // the leader's put never ran — resolve the gate instead so a follower
    // proceeds on its OWN persistence outcome instead of inheriting the
    // leader's deadline while the shared flight still completes for it
    // (#3514 review). The gate must still settle either way: `persisted`
    // keeps the flight discoverable until it does (round 12 #2).
    if (isAbortError(err) || err instanceof EngramAccessDeadlineExceededError) {
      ownedFlight?.persisted?.resolve();
    } else {
      ownedFlight?.persisted?.reject(err);
    }
    throw err;
  }
  ownedFlight?.persisted?.resolve();
  try {
    throwIfAborted(request.abortSignal);
  } catch (err) {
    if (!keyed && capturedReservation) {
      host.budget.release(capturedReservation);
    }
    throw err;
  }
  return response;
}

/** The degraded response for a recall whose deadline expired at admission,
 *  while queued for a slot, or while consuming a shared flight (#3514
 *  review): retrieval never started, so the result carries the missing-note
 *  composition and a machine-readable `retrievalFailure` — never an empty
 *  response indistinguishable from "no matches". */
function degradedDeadlineRecallResponse(
  host: RecallCoordinatorHost,
  request: EngramAccessRecallRequest,
): EngramAccessRecallResponse {
  if (
    request.disclosure !== undefined &&
    request.disclosure !== null &&
    !isRecallDisclosure(request.disclosure)
  ) {
    throw new EngramAccessInputError(
      `disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
    );
  }
  const composition = composeMissingMemoryContext({ detail: "timeout" });
  return {
    query: request.query,
    sessionKey: request.sessionKey,
    namespace: request.namespace?.trim() || host.orchestrator.config.defaultNamespace,
    context: composeRecallContext(composition),
    contextComposition: composition,
    retrievalFailure: { reason: "backend_unavailable", detail: "timeout" },
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: request.disclosure ?? DEFAULT_RECALL_DISCLOSURE,
  };
}

export async function coordinateRecall(
  host: RecallCoordinatorHost,
  request: EngramAccessRecallRequest,
  normalizedRequest: EngramAccessRecallRequest,
  requestFingerprint: Omit<EngramAccessRecallRequest, "abortSignal" | "deadlineMs">,
  principalKey: string,
  singleFlight: boolean,
): Promise<EngramAccessRecallResponse> {
  try {
  if (!singleFlight) {
    // No coalescing: per-request execution under a concurrency slot. The
    // resolved absolute deadline also bounds the queue wait itself (#3514
    // review) so a saturated semaphore cannot hold a recall past expiry.
    return await withRecallConcurrency(
      host,
      principalKey,
      request.abortSignal,
      (queueWaitMs) =>
        runRecallDirect(host, request, normalizedRequest, requestFingerprint, queueWaitMs),
      resolveClientDeadlineAtMs(normalizedRequest.deadlineMs, Date.now()),
    );
  }

  const { idempotencyKey: _flightKeyOmitIdemKey, ...flightFingerprint } = requestFingerprint;
  const flightKey = `${principalKey}\u0000${hashAccessIdempotencyPayload({
    operation: "recall",
    request: flightFingerprint,
  })}`;
  const keyed = !!request.idempotencyKey?.trim();
  const existing = host.recallInFlight.get(flightKey);
  if (!keyed && existing && !existing.controller.signal.aborted) {
    throwIfAborted(request.abortSignal);
    return await followRecallFlight(host, existing, normalizedRequest);
  }
  return await leadRecallFlight(
    host,
    request,
    normalizedRequest,
    requestFingerprint,
    flightKey,
    principalKey,
  );
  } catch (err) {
    // A deadline expiry at admission, in the queue, or on a shared-flight wait
    // becomes the degraded recall response rather than a rejection (#3514
    // review): caller cancellation stays an AbortError rejection, and every
    // other failure propagates unchanged.
    if (err instanceof EngramAccessDeadlineExceededError) {
      return degradedDeadlineRecallResponse(host, normalizedRequest);
    }
    throw err;
  }
}
