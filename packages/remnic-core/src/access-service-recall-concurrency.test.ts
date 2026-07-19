import assert from "node:assert/strict";
import test from "node:test";

import {
  EngramAccessInputError,
  EngramAccessService,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
} from "./access-service.js";
import type { BudgetReservation } from "./cross-namespace-budget.js";

// Issue #1906 (+ review): the per-principal recall lock was a width-1 FIFO
// mutex held for the whole ~30s recall. Its replacement is a per-principal
// concurrency semaphore (recallMaxConcurrentPerPrincipal) plus query-level
// single-flight coalescing (recallSingleFlightEnabled). These tests exercise:
//   - concurrency (distinct recalls overlap; cap honored; queueWaitMs)
//   - single-flight (coalesce to one pipeline; exactly-once even at cap < N;
//     followers join without a slot)
//   - atomic budget admission (no over-admission; per-caller record; deny msg;
//     rollback on failure)
//   - flight abort semantics (own refcounted controller: leader abort keeps the
//     shared pipeline for followers; all-callers-abort cancels it; queued abort
//     immediate; no lane poisoning) and abort-listener cleanup.
//
// Coalescing is deterministic: the leader registers its flight synchronously in
// the same turn recall() sees the miss, so every later identical arrival joins
// by map lookup — no wall-clock waits.

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Yield past all pending microtasks (a single macrotask hop). Deterministic and
// count-free: lets a coalesced follower fully consume and reach its persistence
// await before the test observes its state.
function flushMacrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

// A recall response shaped only as this suite's stubs need it. Assigned via a
// named helper (not an inline cast into a member access): the pipeline is
// stubbed, so the real envelope shape is irrelevant — we only assert
// structuredClone independence of the `results` array.
function stubResponse(results: unknown[]): EngramAccessRecallResponse {
  return { results } as unknown as EngramAccessRecallResponse;
}

function readResults(response: EngramAccessRecallResponse): unknown[] {
  assert.ok(response && typeof response === "object" && "results" in response);
  const { results } = response as { results: unknown[] };
  return results;
}

type BudgetDecision = {
  allowed: boolean;
  reason?: string;
  count?: number;
  limit?: { hardLimit: number; windowMs: number; softLimit?: number };
  reservation?: BudgetReservation;
};

interface Harness {
  service: EngramAccessService;
  recallSemaphores: Map<string, unknown>;
  recallInFlight: Map<string, unknown>;
  /** Net live budget reservations (record minus release) under the default
   *  budget model — used to assert exact-entry rollback on failures. */
  liveBudget: () => number;
}

/**
 * Build an EngramAccessService whose recall pipeline is a stub. `pipeline` runs
 * once per leader execution (its call count == number of real pipeline runs).
 * When `crossNamespace` is set, executeRecall models the real atomic budget
 * admission: it RESERVES (budget.record, returning a token) BEFORE running the
 * pipeline and rolls back (budget.release(token)) if the pipeline fails —
 * exactly like access-recall-surface.executeRecall.
 */
function makeService(opts: {
  limit?: number;
  singleFlight?: boolean;
  pipeline: (request: EngramAccessRecallRequest) => Promise<EngramAccessRecallResponse>;
  crossNamespace?: boolean;
  budgetRecord?: (principal: string) => BudgetDecision;
  budgetRelease?: (reservation: BudgetReservation | undefined) => void;
  /** Fired by the default budget model each time a reservation is released —
   *  lets tests await release deterministically instead of polling microtasks. */
  onBudgetRelease?: () => void;
  /** Fired by the default budget model each time a reservation is recorded. */
  onBudgetRecord?: () => void;
}): Harness {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const recallSemaphores = new Map<string, unknown>();
  const recallInFlight = new Map<string, unknown>();
  // Default budget model: token-tracking so tests can assert exact-entry
  // rollback. Custom budgetRecord (deny/count tests) bypasses the live set.
  let reservationSeq = 0;
  const liveReservations = new Set<number>();
  const defaultRecord = (principal: string): BudgetDecision => {
    const id = ++reservationSeq;
    liveReservations.add(id);
    opts.onBudgetRecord?.();
    return { allowed: true, reservation: { principal, id } };
  };
  const defaultRelease = (reservation: BudgetReservation | undefined): void => {
    if (reservation) liveReservations.delete(reservation.id);
    opts.onBudgetRelease?.();
  };
  const budgetRecord = opts.budgetRecord ?? defaultRecord;
  const budgetRelease = opts.budgetRelease ?? defaultRelease;
  const host = service as unknown as {
    recallSemaphores: Map<string, unknown>;
    recallInFlight: Map<string, unknown>;
    orchestrator: { config: Record<string, unknown> };
    resolveRequestPrincipal: () => string;
    executeRecall: (
      request: EngramAccessRecallRequest,
    ) => Promise<{
      response: EngramAccessRecallResponse;
      budgetRecordPrincipal: string | null;
      reservation?: BudgetReservation;
    }>;
    budget: {
      record: (principal: string) => BudgetDecision;
      release: (reservation: BudgetReservation | undefined) => void;
    };
  };
  host.recallSemaphores = recallSemaphores;
  host.recallInFlight = recallInFlight;
  host.orchestrator = {
    config: {
      recallMaxConcurrentPerPrincipal: opts.limit ?? 4,
      recallSingleFlightEnabled: opts.singleFlight ?? true,
    },
  };
  host.resolveRequestPrincipal = () => "principal";
  host.budget = { record: budgetRecord, release: budgetRelease };
  host.executeRecall = async (request) => {
    let reserved: string | null = null;
    let reservation: BudgetReservation | undefined;
    if (opts.crossNamespace) {
      // Atomic admission reserve BEFORE the pipeline (#1906): a denied reserve
      // throws here, so the pipeline never runs (no over-admission).
      const decision = budgetRecord("principal");
      if (!decision.allowed) {
        throw new EngramAccessInputError(
          `recall denied: cross-namespace budget exceeded (${decision.count}/${decision.limit?.hardLimit} in ${decision.limit?.windowMs}ms window)`,
        );
      }
      reserved = "principal";
      reservation = decision.reservation;
    }
    try {
      const response = await opts.pipeline(request);
      return { response, budgetRecordPrincipal: reserved, reservation };
    } catch (err) {
      budgetRelease(reservation); // roll back the exact entry on pipeline failure
      throw err;
    }
  };
  return {
    service,
    recallSemaphores,
    recallInFlight,
    liveBudget: () => liveReservations.size,
  };
}

function abortRejects(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("distinct concurrent recalls for one principal overlap (not serialized)", async () => {
  let started = 0;
  const bothStarted = deferred<void>();
  const release = deferred<void>();
  const { service } = makeService({
    limit: 4,
    pipeline: async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return stubResponse([]);
    },
  });

  const a = service.recall({ query: "alpha" });
  const b = service.recall({ query: "beta" });

  // Both pipelines are in flight simultaneously — under the old width-1 lock
  // the second would not start until the first released.
  await bothStarted.promise;
  assert.equal(started, 2);

  release.resolve();
  await Promise.all([a, b]);
});

test("identical concurrent recalls coalesce to one pipeline; each caller gets its own response", async () => {
  let pipelineRuns = 0;
  const recordCalls: string[] = [];
  const { service, recallInFlight, recallSemaphores } = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([{ id: "m1" }]);
    },
    budgetRecord: (p) => {
      recordCalls.push(p);
      return { allowed: true };
    },
  });

  const req: EngramAccessRecallRequest = { query: "same", sessionKey: "s1" };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => service.recall({ ...req })),
  );

  assert.equal(pipelineRuns, 1, "the pipeline runs exactly once for 5 identical recalls");
  assert.equal(responses.length, 5);
  for (const r of responses) assert.ok(r);

  // Independent objects: mutating one caller's response must not affect others.
  readResults(responses[0]).push({ id: "mutated" });
  assert.equal(readResults(responses[1]).length, 1);

  // Budget recorded once per caller: leader reserved in executeRecall + 4
  // followers each record their own event in followRecallFlight.
  assert.equal(recordCalls.length, 5);

  // No leaks after all coalesced callers settle.
  assert.equal(recallInFlight.size, 0);
  assert.equal(recallSemaphores.size, 0);
});

test("exactly-once coalescing even when the concurrency cap is below the caller count", async () => {
  let pipelineRuns = 0;
  const release = deferred<void>();
  const { service, recallInFlight } = makeService({
    limit: 2, // cap 2 < 5 callers
    singleFlight: true,
    pipeline: async () => {
      pipelineRuns += 1;
      await release.promise;
      return stubResponse([]);
    },
  });

  const calls = Array.from({ length: 5 }, () => service.recall({ query: "same" }));
  // Followers join the synchronously-registered flight without taking a slot.
  release.resolve();
  const responses = await Promise.all(calls);

  assert.equal(pipelineRuns, 1, "cap < N must still coalesce to one pipeline run");
  assert.equal(responses.length, 5);
  assert.equal(recallInFlight.size, 0);
});

test("single-flight disabled runs the pipeline once per identical request", async () => {
  let pipelineRuns = 0;
  const { service } = makeService({
    limit: 0,
    singleFlight: false,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });

  await Promise.all(Array.from({ length: 5 }, () => service.recall({ query: "same" })));
  assert.equal(pipelineRuns, 5);
});

test("budget accounting stays per-caller under coalescing and preserves the deny message", async () => {
  let recordCount = 0;
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
    budgetRecord: () => {
      recordCount += 1;
      // First two callers allowed; the third crosses the hard limit.
      if (recordCount <= 2) return { allowed: true };
      return { allowed: false, count: 3, limit: { hardLimit: 2, windowMs: 60_000 } };
    },
  });

  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () => service.recall({ query: "same" })),
  );

  assert.equal(recordCount, 3, "budget.record is invoked once per coalesced caller");
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 2);
  const rejected = settled.filter(
    (s): s is PromiseRejectedResult => s.status === "rejected",
  );
  assert.equal(rejected.length, 1);
  const err = rejected[0].reason;
  assert.ok(err instanceof Error);
  assert.equal(
    err.message,
    "recall denied: cross-namespace budget exceeded (3/2 in 60000ms window)",
  );
});

test("budget hard-limit holds under N concurrent distinct recalls (no over-admission)", async () => {
  let pipelineRuns = 0;
  let recordCount = 0;
  const release = deferred<void>();
  const { service } = makeService({
    limit: 0, // unlimited concurrency: all N reach admission together
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      await release.promise;
      return stubResponse([]);
    },
    budgetRecord: () => {
      recordCount += 1;
      // hard limit 2: the 3rd+ reserve is denied AT ADMISSION, before its
      // pipeline can run.
      if (recordCount <= 2) return { allowed: true };
      return { allowed: false, count: 3, limit: { hardLimit: 2, windowMs: 60_000 } };
    },
  });

  // Distinct queries => 5 independent leaders, each reserves before its own
  // pipeline. Fire them, then release the two admitted pipelines.
  const calls = Array.from({ length: 5 }, (_, i) => service.recall({ query: `q${i}` }));
  // Let all 5 reach the reserve (each is a leader; reserves are synchronous
  // record() calls sequenced by the event loop).
  await Promise.resolve();
  await Promise.resolve();
  release.resolve();
  const settled = await Promise.allSettled(calls);

  assert.equal(pipelineRuns, 2, "only 2 pipelines run; the 3rd+ deny before running (no over-admission)");
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 2);
  assert.equal(settled.filter((s) => s.status === "rejected").length, 3);
});

test("a failed pipeline rolls back its budget reservation", async () => {
  let recordCount = 0;
  let releaseCount = 0;
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      throw new Error("pipeline boom");
    },
    budgetRecord: () => {
      recordCount += 1;
      return { allowed: true };
    },
    budgetRelease: () => {
      releaseCount += 1;
    },
  });

  await assert.rejects(service.recall({ query: "same" }), /pipeline boom/);
  assert.equal(recordCount, 1, "reserved once at admission");
  assert.equal(releaseCount, 1, "rolled back once on pipeline failure");
});

test("a queued recall rejects immediately on abort — before the holder releases", async () => {
  let pipelineRuns = 0;
  const leaderStarted = deferred<void>();
  const releaseLeader = deferred<void>();
  const { service, recallSemaphores } = makeService({
    limit: 1,
    pipeline: async (request) => {
      pipelineRuns += 1;
      if (request.query === "leader") {
        leaderStarted.resolve();
        await releaseLeader.promise;
      }
      return stubResponse([]);
    },
  });

  const leader = service.recall({ query: "leader" });
  await leaderStarted.promise;

  const controller = new AbortController();
  const queued = service.recall({ query: "queued", abortSignal: controller.signal });
  controller.abort();

  // Rejects on abort while the leader is still held (pipelineRuns stays 1).
  await assert.rejects(queued, (error: Error) => error.name === "AbortError");
  assert.equal(pipelineRuns, 1, "the aborted queued recall never started its pipeline");

  releaseLeader.resolve();
  await leader;
  assert.equal(recallSemaphores.size, 0, "semaphore self-cleans after settle");
});

test("an aborted queued recall does not poison the per-principal lane", async () => {
  let thirdRan = false;
  const leaderStarted = deferred<void>();
  const releaseLeader = deferred<void>();
  const { service } = makeService({
    limit: 1,
    pipeline: async (request) => {
      if (request.query === "leader") {
        leaderStarted.resolve();
        await releaseLeader.promise;
      } else if (request.query === "third") {
        thirdRan = true;
      }
      return stubResponse([]);
    },
  });

  const leader = service.recall({ query: "leader" });
  await leaderStarted.promise;

  const controller = new AbortController();
  const second = service.recall({ query: "second", abortSignal: controller.signal });
  const third = service.recall({ query: "third" });
  controller.abort();
  releaseLeader.resolve();

  await leader;
  await assert.rejects(second, (error: Error) => error.name === "AbortError");
  await third;
  assert.equal(thirdRan, true);
});

test("a leader abort does not reject still-connected followers (flight completes for them)", async () => {
  let pipelineRuns = 0;
  const started = deferred<void>();
  const release = deferred<void>();
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async () => {
      pipelineRuns += 1;
      started.resolve();
      await release.promise;
      return stubResponse([{ id: "shared" }]);
    },
  });

  const leaderController = new AbortController();
  const leader = service.recall({ query: "same", abortSignal: leaderController.signal });
  const follower = service.recall({ query: "same" }); // no signal
  await started.promise;

  // Leader disconnects mid-pipeline; the follower must still get the result.
  leaderController.abort();
  release.resolve();

  await assert.rejects(leader, (error: Error) => error.name === "AbortError");
  const result = await follower;
  assert.ok(result);
  assert.equal(pipelineRuns, 1, "the shared pipeline was not restarted for the follower");
});

test("the shared pipeline is cancelled only when every attached caller aborts", async () => {
  let pipelineCancelled = false;
  const started = deferred<void>();
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async (request) => {
      started.resolve();
      const flightSignal = request.abortSignal;
      assert.ok(flightSignal, "the shared pipeline runs on the flight's own signal");
      try {
        // Honor the flight's own abort signal (not any single caller's).
        await abortRejects(flightSignal);
        return stubResponse([]);
      } catch {
        pipelineCancelled = true;
        throw Object.assign(new Error("operation aborted"), { name: "AbortError" });
      }
    },
  });

  const cA = new AbortController();
  const cB = new AbortController();
  const a = service.recall({ query: "same", abortSignal: cA.signal });
  const b = service.recall({ query: "same", abortSignal: cB.signal });
  await started.promise;

  cA.abort(); // one caller aborts — pipeline must keep running
  await Promise.resolve();
  assert.equal(pipelineCancelled, false, "one caller aborting must not cancel the shared pipeline");

  cB.abort(); // last caller aborts — now cancel the flight
  await assert.rejects(a, (error: Error) => error.name === "AbortError");
  await assert.rejects(b, (error: Error) => error.name === "AbortError");
  assert.equal(pipelineCancelled, true, "flight cancelled once all attached callers aborted");
});

test("abort listeners on a caller's signal return to baseline after the recall settles", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let liveAbortListeners = 0;
  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);
  // Count only "abort" listeners that are explicitly removed (the recall path
  // never fires abort here, so raceAbort's .finally and attachFlightAbort's
  // detach must remove every listener they added).
  type AddArgs = Parameters<typeof signal.addEventListener>;
  type RemoveArgs = Parameters<typeof signal.removeEventListener>;
  const patched = signal as unknown as {
    addEventListener: (...args: AddArgs) => void;
    removeEventListener: (...args: RemoveArgs) => void;
  };
  patched.addEventListener = (...args: AddArgs) => {
    if (args[0] === "abort") liveAbortListeners += 1;
    origAdd(...args);
  };
  patched.removeEventListener = (...args: RemoveArgs) => {
    if (args[0] === "abort") liveAbortListeners -= 1;
    origRemove(...args);
  };

  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async () => stubResponse([]),
  });

  await service.recall({ query: "same", abortSignal: signal });
  assert.equal(liveAbortListeners, 0, "every abort listener added during the recall was removed");
});

async function measurePeakConcurrency(limit: number): Promise<number> {
  let active = 0;
  let peak = 0;
  let startedCount = 0;
  const expectedStart = limit === 0 ? 3 : Math.min(limit, 3);
  const reachedExpected = deferred<void>();
  const gates: Array<() => void> = [];
  const { service } = makeService({
    limit,
    singleFlight: false, // distinct queries anyway; keep coalescing out of the way
    pipeline: async () => {
      active += 1;
      peak = Math.max(peak, active);
      startedCount += 1;
      if (startedCount === expectedStart) reachedExpected.resolve();
      const gate = deferred<void>();
      gates.push(gate.resolve);
      await gate.promise;
      active -= 1;
      return stubResponse([]);
    },
  });

  const calls = [
    service.recall({ query: "q1" }),
    service.recall({ query: "q2" }),
    service.recall({ query: "q3" }),
  ];

  // Wait on a real signal: exactly `expectedStart` recalls have entered the
  // pipeline together. The semaphore holds any surplus in its FIFO queue, so
  // peak concurrency is already captured at this instant.
  await reachedExpected.promise;
  const capturedPeak = peak;

  // Drain to completion: resolve gates as they appear until all three calls
  // settle. Bounded by call completion, not by wall-clock time.
  const all = Promise.all(calls);
  let settled = false;
  void all.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    while (gates.length > 0) {
      const next = gates.shift();
      if (next) next();
    }
    await Promise.resolve();
  }
  await all;
  return capturedPeak;
}

test("semaphore honors recallMaxConcurrentPerPrincipal (cap = 2, 1, unlimited)", async () => {
  assert.equal(await measurePeakConcurrency(2), 2, "limit=2 caps peak concurrency at 2");
  assert.equal(await measurePeakConcurrency(1), 1, "limit=1 restores exact serialization");
  assert.equal(await measurePeakConcurrency(0), 3, "limit=0 (unlimited) runs all 3 at once");
});

test("queueWaitMs is threaded to the pipeline: 0 when a slot is free, >0 when queued", async () => {
  // Drive Date.now deterministically so the queued recall records a positive
  // wait without depending on wall-clock timing.
  const realNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock;
  try {
    const seen: Array<number | undefined> = [];
    const leaderStarted = deferred<void>();
    const releaseLeader = deferred<void>();
    const { service } = makeService({
      limit: 1,
      singleFlight: false,
      pipeline: async (request) => {
        seen.push(request.queueWaitMs);
        if (request.query === "leader") {
          leaderStarted.resolve();
          await releaseLeader.promise;
        }
        return stubResponse([]);
      },
    });

    const leader = service.recall({ query: "leader" });
    await leaderStarted.promise;
    // Queued recall captures startedWaiting = 1000 now, then blocks on the slot.
    const queued = service.recall({ query: "queued" });
    // Advance the clock while it waits, then release the holder.
    clock = 1_050;
    releaseLeader.resolve();
    await Promise.all([leader, queued]);

    assert.equal(seen.length, 2);
    assert.equal(seen[0], 0, "leader acquired its slot immediately (queueWaitMs 0)");
    assert.equal(seen[1], 50, "queued recall accrued a measurable queue wait");
  } finally {
    Date.now = realNow;
  }
});

test("leader failure does not poison followers permanently — a later identical recall succeeds", async () => {
  let pipelineRuns = 0;
  const { service, recallInFlight, recallSemaphores } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async () => {
      pipelineRuns += 1;
      if (pipelineRuns === 1) throw new Error("leader boom");
      return stubResponse([]);
    },
  });

  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () => service.recall({ query: "same" })),
  );
  assert.equal(
    settled.every((s) => s.status === "rejected"),
    true,
    "all coalesced callers see the leader failure",
  );

  // The in-flight entry must be cleared so a fresh identical recall re-executes.
  assert.equal(recallInFlight.size, 0, "failed leader does not leave a poisoned entry");
  const recovered = await service.recall({ query: "same" });
  assert.ok(recovered);
  assert.equal(pipelineRuns, 2, "the recovery recall ran a fresh pipeline");
  assert.equal(recallInFlight.size, 0);
  assert.equal(recallSemaphores.size, 0);
});

test("a leader aborted while the flight is queued for a slot still completes for a live follower", async () => {
  let sameRuns = 0;
  const occStarted = deferred<void>();
  const occGate = deferred<void>();
  const { service, recallInFlight } = makeService({
    limit: 1, // one slot: the occupier holds it while the "same" flight queues
    singleFlight: true,
    pipeline: async (request) => {
      if (request.query === "occupier") {
        occStarted.resolve();
        await occGate.promise;
        return stubResponse([]);
      }
      sameRuns += 1;
      return stubResponse([{ id: "shared" }]);
    },
  });

  // Occupy the only slot.
  const occupier = service.recall({ query: "occupier" });
  await occStarted.promise;
  const baselineFlights = recallInFlight.size;

  // Leader for "same": registers a flight whose pipeline QUEUES for the slot.
  const leaderController = new AbortController();
  const leader = service.recall({ query: "same", abortSignal: leaderController.signal });
  // Deterministically wait (microtask spins, no wall clock) for the leader to
  // register its flight.
  for (let i = 0; i < 50 && recallInFlight.size <= baselineFlights; i++) {
    await Promise.resolve();
  }
  assert.ok(recallInFlight.size > baselineFlights, "leader registered its flight");

  // Follower joins the queued flight (no slot).
  const follower = service.recall({ query: "same" });
  await Promise.resolve();

  // Leader disconnects WHILE the flight is still queued for a slot.
  leaderController.abort();
  await assert.rejects(leader, (error: Error) => error.name === "AbortError");
  assert.equal(sameRuns, 0, "the queued pipeline has not run yet");

  // Free the slot: the flight (still wanted by the follower) now runs.
  occGate.resolve();
  const result = await follower;
  assert.ok(result);
  assert.equal(sameRuns, 1, "the shared pipeline ran once for the surviving follower");
  await occupier;
});

test("a response clone failure on a successful pipeline releases the reservation (flight path, round 3 #1)", async () => {
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    // A function in the response is not structuredClone-able => clone throws
    // AFTER the pipeline (and its reserve) succeeded.
    pipeline: async () => stubResponse([() => {}]),
  });
  await assert.rejects(h.service.recall({ query: "same" }));
  assert.equal(h.liveBudget(), 0, "clone failure released the admission reservation");
});

test("a response clone failure on a successful pipeline releases the reservation (direct path, round 3 #1)", async () => {
  const h = makeService({
    limit: 0,
    singleFlight: false,
    crossNamespace: true,
    pipeline: async () => stubResponse([() => {}]),
  });
  await assert.rejects(h.service.recall({ query: "same" }));
  assert.equal(h.liveBudget(), 0, "clone failure released the admission reservation");
});

test("a new caller after all callers abort runs a fresh pipeline (does not join the cancelled flight, round 3 #2)", async () => {
  let sameRuns = 0;
  const firstStarted = deferred<void>();
  const { service, recallInFlight } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async (request) => {
      sameRuns += 1;
      const myRun = sameRuns;
      if (myRun === 1) {
        // The first (to-be-cancelled) run blocks on the flight's own signal.
        firstStarted.resolve();
        const flightSignal = request.abortSignal;
        assert.ok(flightSignal);
        await abortRejects(flightSignal);
        throw Object.assign(new Error("operation aborted"), { name: "AbortError" });
      }
      return stubResponse([{ run: myRun }]);
    },
  });

  const cA = new AbortController();
  const cB = new AbortController();
  const a = service.recall({ query: "same", abortSignal: cA.signal });
  const b = service.recall({ query: "same", abortSignal: cB.signal });
  await firstStarted.promise;

  // Every attached caller aborts => the flight is cancelled AND unregistered.
  cA.abort();
  cB.abort();
  assert.equal(recallInFlight.size, 0, "cancelled flight unregisters immediately");

  // A new caller arriving now must lead a FRESH pipeline, not inherit the
  // cancelled flight's AbortError.
  const fresh = service.recall({ query: "same" });
  await assert.rejects(a, (error: Error) => error.name === "AbortError");
  await assert.rejects(b, (error: Error) => error.name === "AbortError");
  const result = await fresh;
  assert.ok(result);
  assert.equal(sameRuns, 2, "the new caller ran a second, fresh pipeline");
  assert.equal(recallInFlight.size, 0);
});

test("an idempotency put failure after the leader reserves releases the reservation (round 3 #3)", async () => {
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
  });
  // Simulate handleIdempotentRead's store put failing AFTER execute() (and thus
  // the leader's budget reserve) succeeded.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    await options.execute();
    throw new Error("idempotency put failed");
  };

  await assert.rejects(
    h.service.recall({ query: "same", idempotencyKey: "put-fail" }),
    /idempotency put failed/,
  );
  assert.equal(h.liveBudget(), 0, "the leader's reservation was released on put failure");
});

test("an idempotency put failure after a direct-path reserve releases the reservation (round 4 #1)", async () => {
  const h = makeService({
    limit: 0,
    singleFlight: false, // direct path (runRecallDirect)
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
  });
  // Simulate handleIdempotentRead's store put failing AFTER execute() (and thus
  // the reserve) succeeded.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    await options.execute();
    throw new Error("idempotency put failed");
  };

  await assert.rejects(
    h.service.recall({ query: "same", idempotencyKey: "put-fail-direct" }),
    /idempotency put failed/,
  );
  assert.equal(h.liveBudget(), 0, "the direct-path reservation was released on put failure");
});

test("a coalesced follower's response carries its OWN soft-limit warning, not the leader's (round 4 #2)", async () => {
  let count = 0;
  const release = deferred<void>();
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      await release.promise;
      return stubResponse([]);
    },
    // soft=1: count 1 => under soft (no warning), count 2 => over soft (warning).
    budgetRecord: () => {
      count += 1;
      const reason = count > 1 ? "warn-over-soft" : "allowed-under-soft";
      return {
        allowed: true,
        reason,
        count,
        limit: { hardLimit: 10, softLimit: 1, windowMs: 60_000 },
        reservation: { principal: "principal", id: count },
      };
    },
  });

  const leader = service.recall({ query: "same" });
  const follower = service.recall({ query: "same" });
  await Promise.resolve();
  release.resolve();
  const [leaderResp, followerResp] = await Promise.all([leader, follower]);

  // Leader reserved count 1 (under soft) — its stub response has no warning.
  assert.equal(leaderResp.budgetWarning, undefined, "leader (count 1) carries no warning");
  // Follower recorded count 2 (over soft) — it must see ITS OWN warning, not the
  // leader's absent one.
  assert.ok(followerResp.budgetWarning, "follower (count 2) carries its own warning");
  assert.equal(followerResp.budgetWarning?.reason, "warn-over-soft");
  assert.equal(followerResp.budgetWarning?.count, 2);
});

test("single-flight off: a caller abort while the underlying pipeline still resolves does not leak budget (round 5 #2)", async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const released = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: false, // direct path (runRecallDirect)
    crossNamespace: true,
    // The pipeline resolves (with a reservation) even though the caller aborted.
    pipeline: async () => {
      started.resolve();
      await release.promise;
      return stubResponse([]);
    },
    onBudgetRelease: () => released.resolve(),
  });

  const controller = new AbortController();
  const p = h.service.recall({ query: "same", abortSignal: controller.signal });
  // Let the pipeline actually START (reserve budget) before aborting: the
  // post-slot-grant abort re-check (round 14 #2) short-circuits an abort that
  // lands BEFORE execution, so this round-5 #2 orphan-release path is only
  // reachable once the pipeline is in flight.
  await started.promise;
  controller.abort();
  await assert.rejects(p, (error: Error) => error.name === "AbortError");

  // The underlying recall still resolves with a reservation nobody observed; the
  // orphan-release fires the release hook deterministically.
  release.resolve();
  await released.promise;
  assert.equal(h.liveBudget(), 0, "the orphaned reservation from the cancelled recall was released");
});

test("the flight stays registered until its consumers finish (cleanup on idle, not pipeline settle) (round 6 #1)", async () => {
  let pipelineRuns = 0;
  const gate = deferred<void>();
  const { service, recallInFlight } = makeService({
    limit: 0,
    singleFlight: true,
    pipeline: async () => {
      pipelineRuns += 1;
      await gate.promise;
      return stubResponse([]);
    },
  });

  const leader = service.recall({ query: "same" });
  // The leader registers its flight synchronously within recall() (before its
  // first await), so it is present immediately.
  assert.equal(recallInFlight.size, 1, "flight registered while the leader is attached");

  // A joiner arrives and coalesces onto the live flight.
  const joiner = service.recall({ query: "same" });
  gate.resolve();
  await Promise.all([leader, joiner]);
  assert.equal(pipelineRuns, 1, "joiner coalesced onto the shared pipeline");
  // Only after ALL consumers finished is the flight unregistered.
  assert.equal(recallInFlight.size, 0, "flight unregistered once idle");
});

test("round 6 #2 (direct path): abort between the result and the final check releases the reservation", async () => {
  const hookGate = deferred<void>();
  const executeDone = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: false,
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
  });
  // Inject a controllable async step AFTER execute() (models the real gap
  // between the produced result and the final abort check).
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    executeDone.resolve();
    await hookGate.promise;
    return response;
  };

  const controller = new AbortController();
  const p = h.service.recall({ query: "same", abortSignal: controller.signal });
  // execute() completed (pipeline done, reservation captured); now parked.
  await executeDone.promise;
  assert.equal(h.liveBudget(), 1, "reservation held while the result is in hand");
  // Abort lands in the gap, then the parked step completes.
  controller.abort();
  hookGate.resolve();
  await assert.rejects(p, (error: Error) => error.name === "AbortError");
  assert.equal(h.liveBudget(), 0, "the completed-but-undelivered recall released its reservation");
});

test("round 6 #2 (flight path): abort between the result and the final check releases the reservation", async () => {
  const hookGate = deferred<void>();
  const executeDone = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    executeDone.resolve();
    await hookGate.promise;
    return response;
  };

  const controller = new AbortController();
  const p = h.service.recall({ query: "same", abortSignal: controller.signal });
  await executeDone.promise;
  assert.equal(h.liveBudget(), 1, "reservation held while the result is in hand");
  controller.abort();
  hookGate.resolve();
  await assert.rejects(p, (error: Error) => error.name === "AbortError");
  assert.equal(h.liveBudget(), 0, "the completed-but-undelivered recall released its reservation");
});

test("an unkeyed cross-namespace follower that disconnects after reserving releases its reservation (round 8 #1)", async () => {
  const gate = deferred<void>();
  const controller = new AbortController();
  let records = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      await gate.promise;
      return stubResponse([]);
    },
    // record #1 = leader's pipeline reserve, record #2 = the follower's own
    // per-caller reserve — abort the follower the instant it reserves so the
    // disconnect lands after the reserve but before delivery.
    onBudgetRecord: () => {
      records += 1;
      if (records === 2) controller.abort();
    },
  });

  const leader = h.service.recall({ query: "same" });
  const follower = h.service.recall({ query: "same", abortSignal: controller.signal });
  gate.resolve();

  const leaderResp = await leader;
  assert.ok(leaderResp, "the leader delivered");
  await assert.rejects(follower, (error: Error) => error.name === "AbortError");
  assert.equal(
    h.liveBudget(),
    1,
    "the follower's post-consume reservation was released; only the leader's delivered one stands",
  );
});

test("a keyed leader whose signal is already aborted at admission rejects without starting a pipeline or reserving budget (round 9)", async () => {
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  // A keyed leader on a cache MISS runs execute() (the admission path under test).
  // Stub handleIdempotentRead to that miss path (the harness has no real store).
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => options.execute();
  const controller = new AbortController();
  controller.abort(); // client disconnected BEFORE admission

  await assert.rejects(
    h.service.recall({ query: "gone", idempotencyKey: "k", abortSignal: controller.signal }),
    (error: Error) => error.name === "AbortError",
  );
  // Drain any deferred work so a stray pipeline/reserve would surface.
  await flushMacrotasks();

  assert.equal(pipelineRuns, 0, "no pipeline ran for a caller that left before admission");
  assert.equal(h.liveBudget(), 0, "no cross-namespace budget event was reserved");
});

test("a keyed caller aborted at admission does NOT join a live coalesced flight — records no budget (round 10 #1)", async () => {
  const pipelineGate = deferred<void>();
  let recordCount = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      await pipelineGate.promise;
      return stubResponse([]);
    },
    onBudgetRecord: () => {
      recordCount += 1;
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
    createAndStartFlight: (
      normalizedRequest: EngramAccessRecallRequest,
      flightKey: string,
      principalKey: string,
      keyed: boolean,
    ) => unknown;
    consumeFlight: (
      flight: unknown,
      request: EngramAccessRecallRequest,
      recordBudget: boolean,
      race: boolean,
    ) => Promise<{ response: EngramAccessRecallResponse; reservation: unknown }>;
    leadRecallFlight: (
      request: EngramAccessRecallRequest,
      normalizedRequest: EngramAccessRecallRequest,
      requestFingerprint: unknown,
      flightKey: string,
      principalKey: string,
    ) => Promise<EngramAccessRecallResponse>;
  };
  // A keyed leader on a cache MISS runs execute() (the harness has no real store).
  host.handleIdempotentRead = async (options) => options.execute();

  const flightKey = "principal\u0000same";
  const req = { query: "same", idempotencyKey: "k" } as EngramAccessRecallRequest;
  // A LIVE coalesced flight kept registered by a real consumer.
  const flight = host.createAndStartFlight(req, flightKey, "principal", true);
  const liveConsumer = host.consumeFlight(flight, req, false, false);

  // A keyed caller whose signal is ALREADY aborted reaches leadRecallFlight and
  // finds the existing flight. It must reject at admission WITHOUT joining — a
  // keyed join is non-racing (race=false), so it would record its OWN budget
  // event (and run a keyed put) before the late abort check.
  const controller = new AbortController();
  controller.abort();
  const abortedReq = {
    query: "same",
    idempotencyKey: "k",
    abortSignal: controller.signal,
  } as EngramAccessRecallRequest;
  const aborted = host.leadRecallFlight(abortedReq, abortedReq, {}, flightKey, "principal");
  pipelineGate.resolve();
  await assert.rejects(aborted, (error: Error) => error.name === "AbortError");

  const consumed = await liveConsumer;
  assert.ok(consumed.response, "the live flight still completed for its other consumer");
  // Exactly ONE budget event: the shared pipeline's reserve. The aborted caller
  // joined nothing (with the bug it records a SECOND, keyed event that survives).
  assert.equal(recordCount, 1, "the aborted caller recorded no budget of its own");
  assert.equal(h.liveBudget(), 1, "only the shared pipeline's reservation is live");
});

test("a response's budgetWarning never carries the internal reservation token / principal id (round 10 #2)", async () => {
  let count = 0;
  const release = deferred<void>();
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      await release.promise;
      return stubResponse([]);
    },
    // soft=1: count 1 => under soft (no warning), count 2 => over soft (warning).
    // The reservation carries a distinctive principal id that must NOT leak.
    budgetRecord: () => {
      count += 1;
      const reason = count > 1 ? "warn-over-soft" : "allowed-under-soft";
      return {
        allowed: true,
        reason,
        count,
        limit: { hardLimit: 10, softLimit: 1, windowMs: 60_000 },
        reservation: { principal: "tenant-secret-42", id: count },
      };
    },
  });

  const leader = service.recall({ query: "same" });
  const follower = service.recall({ query: "same" });
  await Promise.resolve();
  release.resolve();
  const [, followerResp] = await Promise.all([leader, follower]);

  assert.ok(followerResp.budgetWarning, "follower (count 2) carries its own soft-limit warning");
  assert.equal(
    (followerResp.budgetWarning as { reservation?: unknown }).reservation,
    undefined,
    "the server-only reservation rollback token must not ride along on the response",
  );
  const serialized = JSON.stringify(followerResp.budgetWarning);
  assert.ok(
    !serialized.includes("tenant-secret-42"),
    "the principal id must not leak into the serialized warning",
  );
  assert.ok(
    !serialized.includes("reservation"),
    "no reservation field in the serialized warning",
  );
});

test("identical recalls with DISTINCT idempotency keys coalesce onto one pipeline (round 11)", async () => {
  const gate = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      await gate.promise;
      return stubResponse([]);
    },
  });
  // The leader (miss path) runs execute() so it registers its flight
  // synchronously; the follower's fast-path then finds it. The follower joins
  // via followRecallFlight and never touches handleIdempotentRead.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => options.execute();

  // Same recall WORK (query + options), DISTINCT per-request idempotency keys —
  // a common transport-retry pattern. They must share ONE pipeline + slot.
  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  const follower = h.service.recall({ query: "same", idempotencyKey: "key-B" });
  gate.resolve();
  const [leaderResp, followerResp] = await Promise.all([leader, follower]);

  assert.ok(leaderResp);
  assert.ok(followerResp);
  assert.equal(
    pipelineRuns,
    1,
    "distinct-key identical recalls coalesced onto ONE pipeline (idempotencyKey is not in the flight key)",
  );
});

test("an identical arrival during a keyed leader's slow idempotency.put coalesces onto the one pipeline (round 12 #2)", async () => {
  const putGate = deferred<void>();
  const executeDone = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  // Only the KEYED leader enters handleIdempotentRead; gate its put so the flight
  // sits in the persistence window (leader consumed + detached, put pending).
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    executeDone.resolve();
    await putGate.promise; // SLOW put
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "leader" });
  await executeDone.promise; // leader detached; flight kept alive by the persisted gate

  // An identical UNKEYED arrival during the put window must find the still-
  // registered flight and coalesce onto it (not start a second pipeline).
  const arrival = h.service.recall({ query: "same" });
  await flushMacrotasks();
  putGate.resolve();

  const [leaderResp, arrivalResp] = await Promise.all([leader, arrival]);
  assert.ok(leaderResp);
  assert.ok(arrivalResp);
  assert.equal(
    pipelineRuns,
    1,
    "the arrival coalesced onto the leader's pipeline through the slow persistence window",
  );
});

test("a KEYED distinct-key arrival during a keyed leader's slow idempotency.put coalesces via the existing-join (round 12 #2, keyed follower)", async () => {
  // Companion to the round 12 #2 unkeyed-arrival test: the codex finding was
  // specifically about a KEYED caller routing through leadRecallFlight's
  // existing-join during the leader's persistence window. A keyed follower must
  // still find the registered flight and coalesce onto the one pipeline.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  // Both callers are keyed, so both enter handleIdempotentRead. The stub runs
  // execute() (store MISS for every distinct key), then gates the leader in its
  // put so the flight sits in the persistence window while the second key
  // arrives. `race`=false for keyed callers, so a coalescing follower awaits the
  // (already-resolved) pipeline immediately.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    leaderExecuted.resolve();
    await putGate.promise; // SLOW put for whichever caller is inside
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise; // leader detached; flight kept alive by persisted gate

  // A DISTINCT idempotency key for the SAME work arrives during the put window.
  // It shares the flight key (idempotencyKey is excluded from it), so it must
  // coalesce onto the still-registered flight rather than start a new pipeline.
  const follower = h.service.recall({ query: "same", idempotencyKey: "key-B" });
  await flushMacrotasks();
  putGate.resolve();

  const [leaderResp, followerResp] = await Promise.all([leader, follower]);
  assert.ok(leaderResp);
  assert.ok(followerResp);
  assert.equal(
    pipelineRuns,
    1,
    "the keyed distinct-key follower coalesced onto the leader's pipeline through the persistence window",
  );
});

test("an identical arrival during a keyed leader's FAILING idempotency.put still coalesces onto one pipeline; only the leader rejects (round 12 #2, put failure)", async () => {
  // The flight must stay registered through the persistence window regardless of
  // the put OUTCOME. A slow put that ultimately FAILS must not (a) start a second
  // pipeline for an arrival during the window, nor (b) fail that arrival: an
  // unkeyed follower consumed the shared result and never depends on the leader's
  // put. The leader's put failure is isolated to the leader.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  const putError = new Error("idempotency store write failed");
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    leaderExecuted.resolve();
    await putGate.promise; // SLOW put
    throw putError; // ...that ultimately FAILS
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "leader" });
  await leaderExecuted.promise; // leader detached; flight kept alive by persisted gate

  // An identical UNKEYED arrival during the FAILING put window coalesces onto the
  // still-registered flight and succeeds from the shared result before the put
  // fails — it never awaits the leader's persistence (round 12: followRecallFlight
  // is unkeyed-only and does not gate on `persisted`).
  const arrival = h.service.recall({ query: "same" });
  const arrivalResp = await arrival;
  assert.ok(arrivalResp, "the arrival coalesced and succeeded independent of the leader's put");

  putGate.resolve();
  await assert.rejects(leader, (err: unknown) => err === putError);
  assert.equal(
    pipelineRuns,
    1,
    "the arrival coalesced onto the one pipeline through the FAILING persistence window",
  );
  // The failed keyed leader released its reservation; the surviving follower
  // recorded its own event, so exactly one live reservation remains.
  assert.equal(h.liveBudget(), 1, "leader's reservation released on put failure; follower's stands");
});

test("a keyed follower coalescing via the existing-join awaits the leader's persisted gate before succeeding (round 13 #1, success)", async () => {
  // Finding 1: a keyed caller that coalesces onto a live flight through
  // leadRecallFlight's existing-join must not report success (nor run its OWN
  // idempotency.put) before the LEADER's put settled. It awaits the joined
  // flight's persisted gate; on the leader's put SUCCESS it then returns.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  // Both callers are keyed and enter handleIdempotentRead (store MISS for each
  // distinct key). Only the LEADER (key-A) holds a slow put; the follower's
  // execute() parks on the leader's persisted gate, so it never reaches its own
  // put until the leader's put resolves.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    if (options.idempotencyKey === "key-A") {
      leaderExecuted.resolve();
      await putGate.promise; // leader's slow put
    }
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise; // leader consumed + detached; flight in the put window

  let followerSettled = false;
  const follower = h.service
    .recall({ query: "same", idempotencyKey: "key-B" })
    .then((r) => {
      followerSettled = true;
      return r;
    });
  await flushMacrotasks();

  assert.equal(pipelineRuns, 1, "the keyed follower coalesced onto the one pipeline");
  assert.equal(
    followerSettled,
    false,
    "the keyed follower is pending on the leader's persisted gate, not yet successful",
  );

  putGate.resolve();
  const [leaderResp, followerResp] = await Promise.all([leader, follower]);
  assert.ok(leaderResp);
  assert.ok(followerResp);
  assert.equal(pipelineRuns, 1, "still exactly one pipeline");
  assert.equal(
    h.liveBudget(),
    2,
    "both keyed reservations stand on success (leader's pipeline reserve + follower's own event)",
  );
});

test("a keyed follower coalescing via the existing-join inherits the leader's put FAILURE (round 13 #1, failure)", async () => {
  // Finding 1: when the leader's idempotency.put FAILS, a keyed follower that
  // joined its flight must reject with the SAME error and release its own
  // reservation — never a phantom success that a same-key retry would diverge
  // from.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  const putError = new Error("idempotency store write failed");
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    // The follower (key-B) never returns from execute(): it rejects on the
    // leader's persisted gate, so control never reaches its own put.
    const response = await options.execute();
    if (options.idempotencyKey === "key-A") {
      leaderExecuted.resolve();
      await putGate.promise; // leader's slow put...
      throw putError; // ...that FAILS
    }
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise; // leader in the put window

  const follower = h.service.recall({ query: "same", idempotencyKey: "key-B" });
  await flushMacrotasks(); // the follower parks on the leader's persisted gate

  // Attach the rejection handlers BEFORE resolving so the follower's inherited
  // rejection is never momentarily unhandled.
  const leaderRej = assert.rejects(leader, (err: unknown) => err === putError);
  const followerRej = assert.rejects(follower, (err: unknown) => err === putError);
  putGate.resolve();
  await leaderRej;
  await followerRej;

  assert.equal(pipelineRuns, 1, "the follower coalesced onto the one pipeline");
  assert.equal(
    h.liveBudget(),
    0,
    "both reservations released: the leader's on put failure and the follower's on the inherited failure",
  );
});

test("an unkeyed follower during a keyed leader's slow put succeeds WITHOUT awaiting the persisted gate (round 13 #1, unkeyed unchanged)", async () => {
  // Finding 1 scope guard: unkeyed followers keep existing behavior. They
  // consumed the shared result and never depend on another caller's
  // persistence, so they must return success while the leader's put is still
  // pending — never blocking on the persisted gate.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    if (options.idempotencyKey === "key-A") {
      leaderExecuted.resolve();
      await putGate.promise; // leader's put still pending while the arrival runs
    }
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise; // leader in the put window, flight registered

  // The UNKEYED arrival takes the fast-path follower and returns the shared
  // result while the leader's put is still pending.
  const arrivalResp = await h.service.recall({ query: "same" });
  assert.ok(arrivalResp, "the unkeyed follower succeeded before the leader's put settled");
  assert.equal(pipelineRuns, 1, "coalesced onto the one pipeline");

  putGate.resolve();
  await leader;
});

// ── round 14 review findings ────────────────────────────────────────────────

test("a recall aborted after its concurrency slot is granted rejects before the pipeline runs and releases the slot (round 14 #2)", async () => {
  // The queued waiter's abort listener is removed by `take()` the instant a slot
  // is granted. If the signal fires in the microtask gap between the grant and
  // the recall function running, withRecallConcurrency must re-check the signal
  // and release the slot instead of starting work for a disconnected caller.
  const h = makeService({
    limit: 1,
    singleFlight: false,
    pipeline: async () => stubResponse([]),
  });
  const host = h.service as unknown as {
    withRecallConcurrency: <T>(
      principal: string,
      signal: AbortSignal | undefined,
      fn: (queueWaitMs: number) => Promise<T>,
    ) => Promise<T>;
  };

  // Slot is free: acquireRecallSlot resolves synchronously, so the fn runs in a
  // microtask. Aborting right after the call lands in exactly that gap — after
  // the (synchronous) slot grant, before the fn continuation.
  const controller = new AbortController();
  let fnRan = false;
  const pending = host.withRecallConcurrency("principal", controller.signal, async () => {
    fnRan = true;
    return "ok";
  });
  controller.abort();

  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(fnRan, false, "the recall function never ran after the post-grant abort");
  assert.equal(
    h.recallSemaphores.size,
    0,
    "the granted slot was released so the semaphore did not leak",
  );
});

test("a queued keyed leader whose only caller aborts cancels before executing (round 14 #3)", async () => {
  // A keyed single-flight leader queued behind the concurrency cap runs its
  // pipeline on the FLIGHT controller with race=false, so its caller's abort was
  // previously never observed: the flight would still execute + reserve + persist
  // once a slot freed, even though its only caller had disconnected while queued.
  const holderGate = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 1,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async (request) => {
      pipelineRuns += 1;
      if (request.query === "holder") await holderGate.promise;
      return stubResponse([{ id: "m1" }]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => options.execute();

  // Occupy the single slot with an unrelated (different-work) recall.
  const holder = h.service.recall({ query: "holder" });
  await flushMacrotasks();

  // A keyed leader for DIFFERENT work registers its flight and queues for a slot.
  const controller = new AbortController();
  const leader = h.service.recall({
    query: "keyed",
    idempotencyKey: "k",
    abortSignal: controller.signal,
  });
  await flushMacrotasks();
  assert.equal(h.recallInFlight.size, 2, "both flights are registered while queued");

  // The keyed leader's only caller disconnects while its flight is still queued.
  controller.abort();
  await assert.rejects(leader, (error: Error) => error.name === "AbortError");

  // Free the slot; a still-alive queued flight would now execute + reserve.
  holderGate.resolve();
  await holder;
  await flushMacrotasks();

  assert.equal(pipelineRuns, 1, "only the holder ran — the cancelled queued keyed flight never executed");
  assert.equal(h.liveBudget(), 1, "the cancelled queued keyed flight reserved no budget (only the holder's stands)");
  assert.equal(h.recallInFlight.size, 0, "the cancelled keyed flight unregistered");
  assert.equal(h.recallSemaphores.size, 0, "the semaphore did not leak");
});

test("a queued keyed flight with an additional live caller survives its leader's abort (round 14 #3)", async () => {
  // Shared-flight semantics for ADDITIONAL callers: when a second caller has
  // joined, one caller's abort must not cancel the shared pipeline.
  const holderGate = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 1,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async (request) => {
      pipelineRuns += 1;
      if (request.query === "holder") await holderGate.promise;
      return stubResponse([{ id: "m1" }]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => options.execute();

  const holder = h.service.recall({ query: "holder" });
  await flushMacrotasks();

  // Leader (key-A) registers its keyed flight and queues behind the cap.
  const leaderCtl = new AbortController();
  const leader = h.service.recall({
    query: "same",
    idempotencyKey: "key-A",
    abortSignal: leaderCtl.signal,
  });
  await flushMacrotasks();
  // A second keyed caller (same work, distinct key) joins the queued flight.
  const follower = h.service.recall({ query: "same", idempotencyKey: "key-B" });
  await flushMacrotasks();

  // The leader disconnects; a keyed leader with race=false does NOT reject on
  // its own abort — it stays committed and the follower keeps the flight alive.
  leaderCtl.abort();

  // Free the slot; the shared flight must still run once for the follower.
  holderGate.resolve();
  await holder;
  const followerResp = await follower;
  // The leader still rejects with AbortError, but only AFTER the shared pipeline
  // completed and it persisted (round 5 #1 commit semantics preserved).
  await assert.rejects(leader, (error: Error) => error.name === "AbortError");

  assert.ok(followerResp, "the additional caller received the shared result");
  assert.equal(
    pipelineRuns,
    2,
    "holder + the one shared keyed pipeline — the leader's abort did not cancel it",
  );
});

test("a keyed follower joining via the existing-join returns its own AbortError promptly when it disconnects during the leader's put (round 14 #4)", async () => {
  // A keyed follower coalescing through leadRecallFlight's existing-join awaits
  // the leader's `persisted` gate. That await must RACE the follower's own abort
  // signal: a client that disconnects while the leader's put is pending must get
  // AbortError promptly — not block until the put settles.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  let pipelineRuns = 0;
  let leaderPersisted = false;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      return stubResponse([{ id: "m1" }]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    if (options.idempotencyKey === "key-A") {
      leaderExecuted.resolve();
      await putGate.promise; // leader's slow put
      leaderPersisted = true;
    }
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise; // leader consumed + detached; flight in the put window

  const followerCtl = new AbortController();
  const follower = h.service.recall({
    query: "same",
    idempotencyKey: "key-B",
    abortSignal: followerCtl.signal,
  });
  await flushMacrotasks(); // follower consumed the shared result; parked on the persisted gate

  // The follower's client disconnects while the leader's put is STILL pending.
  followerCtl.abort();
  await assert.rejects(
    follower,
    (error: Error) => error.name === "AbortError",
    "the keyed follower rejected with its own AbortError before the leader's put settled",
  );
  assert.equal(leaderPersisted, false, "the leader's put was still pending when the follower rejected");

  // The leader's persistence continues to completion despite the follower's abort.
  putGate.resolve();
  const leaderResp = await leader;
  assert.ok(leaderResp, "the leader still completed and persisted");
  assert.equal(leaderPersisted, true, "the leader's persistence continued after the follower aborted");
  assert.equal(pipelineRuns, 1, "one shared pipeline for both callers");
});

test("a keyed follower aborting during the leader's put releases ONLY its own reservation, leaving the leader's intact (round 14 #1)", async () => {
  // Companion to the promptness test: the abort must release exactly the
  // follower's OWN cross-namespace reservation and never touch the leader's,
  // whose event legitimately stands because it persisted.
  const putGate = deferred<void>();
  const leaderExecuted = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => stubResponse([{ id: "m1" }]),
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    if (options.idempotencyKey === "key-A") {
      leaderExecuted.resolve();
      await putGate.promise;
    }
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "key-A" });
  await leaderExecuted.promise;

  const followerCtl = new AbortController();
  const follower = h.service.recall({
    query: "same",
    idempotencyKey: "key-B",
    abortSignal: followerCtl.signal,
  });
  await flushMacrotasks();

  // Leader's reservation + follower's own event are both live in the window.
  assert.equal(h.liveBudget(), 2, "leader and follower each reserved their own event");

  followerCtl.abort();
  await assert.rejects(follower, (error: Error) => error.name === "AbortError");
  assert.equal(
    h.liveBudget(),
    1,
    "only the follower's reservation was released; the leader's stands",
  );

  putGate.resolve();
  await leader;
  assert.equal(h.liveBudget(), 1, "the leader's reservation remains after it persisted");
});

test("a queued keyed flight cancels once its leader AND its existing-join follower both abort (round 15 #2)", async () => {
  // A keyed leader queued behind the concurrency cap runs race=false; a keyed
  // existing-join follower is also non-racing. The follower's abort must still
  // be COUNTED in the flight's live refcount while the flight is only queued:
  // otherwise, when both callers disconnect before a slot frees, the leader's
  // abort drops live 2 -> 1 but the follower's is never counted, so the flight
  // executes + reserves + persists with no caller connected.
  const holderGate = deferred<void>();
  let pipelineRuns = 0;
  const h = makeService({
    limit: 1,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async (request) => {
      pipelineRuns += 1;
      if (request.query === "holder") await holderGate.promise;
      return stubResponse([{ id: "m1" }]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => options.execute();

  // Occupy the single slot with unrelated work.
  const holder = h.service.recall({ query: "holder" });
  await flushMacrotasks();

  // Leader (key-A) registers the keyed flight and queues behind the cap.
  const leaderCtl = new AbortController();
  const leader = h.service.recall({
    query: "same",
    idempotencyKey: "key-A",
    abortSignal: leaderCtl.signal,
  });
  await flushMacrotasks();
  // A second keyed caller (same work, distinct key) joins via the existing-join
  // and parks on the queued flight.
  const followerCtl = new AbortController();
  const follower = h.service.recall({
    query: "same",
    idempotencyKey: "key-B",
    abortSignal: followerCtl.signal,
  });
  await flushMacrotasks();
  assert.equal(h.recallInFlight.size, 2, "holder + the one shared keyed flight registered");

  // Both callers disconnect while the flight is still queued. Only when BOTH
  // are counted does live reach 0 and cancel the not-yet-committed flight.
  leaderCtl.abort();
  followerCtl.abort();
  await assert.rejects(leader, (error: Error) => error.name === "AbortError");
  await assert.rejects(follower, (error: Error) => error.name === "AbortError");

  // Free the slot; a still-alive queued flight would now execute + reserve.
  holderGate.resolve();
  await holder;
  await flushMacrotasks();

  assert.equal(pipelineRuns, 1, "only the holder ran — the fully-abandoned queued keyed flight never executed");
  assert.equal(h.liveBudget(), 1, "the cancelled queued keyed flight reserved no budget (only the holder's stands)");
  assert.equal(h.recallInFlight.size, 0, "the cancelled keyed flight unregistered");
  assert.equal(h.recallSemaphores.size, 0, "the semaphore did not leak");
});

test("raceAbort rejects for an already-aborted signal even when p is already fulfilled (round 15 #1)", async () => {
  // Promise.race settles already-resolved members in array order, so a fulfilled
  // p (index 0) would beat a synchronously-rejected abort racer (index 1). Without
  // a pre-check, a caller that aborted before raceAbort is called (e.g. the keyed
  // follower persistence wait) would proceed past the helper. raceAbort must
  // reject synchronously for an already-aborted signal.
  const { service } = makeService({ pipeline: async () => stubResponse([]) });
  const host = service as unknown as {
    raceAbort: <T>(p: Promise<T>, signal?: AbortSignal) => Promise<T>;
  };
  const raceAbort = host.raceAbort.bind(service);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    raceAbort(Promise.resolve("value"), aborted.signal),
    (error: Error) => error.name === "AbortError",
    "an already-aborted signal wins over an already-fulfilled p",
  );

  // The non-aborted branch is unchanged: p resolves through the race.
  const live = new AbortController();
  assert.equal(
    await raceAbort(Promise.resolve("value"), live.signal),
    "value",
    "a live signal lets the fulfilled p win the race",
  );
});

test("a keyed follower joining an UNKEYED leader's flight rejects with AbortError (releasing its budget, skipping its put) when it disconnects during the shared pipeline (round 16 #1)", async () => {
  // A keyed caller can coalesce onto a flight started by an UNKEYED leader
  // (the idempotencyKey is excluded from the flight key). That flight carries
  // NO `persisted` gate, so the keyed follower's existing-join could not await
  // it. Because a keyed join is non-racing (race=false), the follower's abort
  // is never observed during the shared-pipeline wait, so without a recheck the
  // follower would return success — persisting its idempotency key and keeping
  // its own cross-namespace budget event — even though its client disconnected.
  // The existing-join must recheck the abort before returning: the follower must
  // reject with AbortError, release its reservation, and never run its own put.
  const pipelineGate = deferred<void>();
  const leaderRunning = deferred<void>();
  let pipelineRuns = 0;
  let followerPutRan = false;
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => {
      pipelineRuns += 1;
      leaderRunning.resolve();
      await pipelineGate.promise; // keep the shared pipeline running while the follower joins + aborts
      return stubResponse([{ id: "m1" }]);
    },
  });
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      idempotencyKey?: string;
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    // Only a KEYED caller performs a put. With the fix, execute() throws for the
    // aborted keyed follower, so this line never runs for it.
    if (options.idempotencyKey) followerPutRan = true;
    return response;
  };

  // UNKEYED leader registers the flight and runs the one gated pipeline.
  const leader = h.service.recall({ query: "same" });
  await leaderRunning.promise;

  // KEYED follower coalesces onto the unkeyed leader's flight (no persisted gate)
  // and parks on the shared pipeline via a non-racing consume.
  const followerCtl = new AbortController();
  const follower = h.service.recall({
    query: "same",
    idempotencyKey: "key-B",
    abortSignal: followerCtl.signal,
  });
  await flushMacrotasks();
  // Only the leader's pipeline reservation is live yet: a non-racing keyed join
  // records its OWN event only AFTER the shared pipeline resolves, so the
  // follower has not recorded while the pipeline is still gated.
  assert.equal(h.liveBudget(), 1, "leader's pipeline reservation is live; the parked follower has not recorded yet");

  // The follower's client disconnects while the shared pipeline is still running.
  followerCtl.abort();
  pipelineGate.resolve();

  await assert.rejects(
    follower,
    (error: Error) => error.name === "AbortError",
    "the keyed follower on an unkeyed flight rejected with its own AbortError",
  );
  assert.equal(followerPutRan, false, "the aborted keyed follower never ran its own idempotency.put");

  const leaderResp = await leader;
  assert.ok(leaderResp, "the unkeyed leader still completed for its own connected client");
  assert.equal(pipelineRuns, 1, "both callers shared one pipeline");
  assert.equal(h.liveBudget(), 1, "the aborted follower's reservation was released; only the leader's stands");
});
