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
  const release = deferred<void>();
  const released = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: false, // direct path (runRecallDirect)
    crossNamespace: true,
    // The pipeline resolves (with a reservation) even though the caller aborted.
    pipeline: async () => {
      await release.promise;
      return stubResponse([]);
    },
    onBudgetRelease: () => released.resolve(),
  });

  const controller = new AbortController();
  const p = h.service.recall({ query: "same", abortSignal: controller.signal });
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

test("a keyed fast-path follower does not report success before the leader's put settles (round 7 #1)", async () => {
  const putGate = deferred<void>();
  const executeDone = deferred<void>();
  const h = makeService({
    limit: 0,
    singleFlight: true,
    crossNamespace: true,
    pipeline: async () => stubResponse([]),
  });
  // Simulate the keyed leader's handleIdempotentRead: run execute (which
  // registers the flight + consumes it), then a GATED idempotency.put.
  const host = h.service as unknown as {
    handleIdempotentRead: (options: {
      execute: () => Promise<EngramAccessRecallResponse>;
    }) => Promise<EngramAccessRecallResponse>;
  };
  host.handleIdempotentRead = async (options) => {
    const response = await options.execute();
    executeDone.resolve();
    await putGate.promise;
    return response;
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "k" });
  await executeDone.promise; // leader consumed; flight registered; parked on the put
  const follower = h.service.recall({ query: "same", idempotencyKey: "k" });

  // The follower has coalesced but must NOT report success before the put.
  const state = await Promise.race([
    follower.then(() => "settled", () => "settled"),
    Promise.resolve("pending"),
  ]);
  assert.equal(state, "pending", "follower awaits the leader's persistence");

  putGate.resolve();
  const [lr, fr] = await Promise.all([leader, follower]);
  assert.ok(lr);
  assert.ok(fr);
});

test("a keyed fast-path follower mirrors the leader on put failure: rejects and releases (round 7 #1)", async () => {
  const putGate = deferred<void>();
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
    // Run execute() (registers + consumes the flight), then simulate a FAILED
    // idempotency.put after the gate.
    await options.execute();
    executeDone.resolve();
    await putGate.promise;
    throw new Error("idempotency put failed");
  };

  const leader = h.service.recall({ query: "same", idempotencyKey: "k" });
  await executeDone.promise;
  const follower = h.service.recall({ query: "same", idempotencyKey: "k" });
  putGate.resolve();

  // The leader rejects on put failure (releasing its reservation); the follower
  // must behave IDENTICALLY — reject with the same error and release its own.
  await assert.rejects(leader, /idempotency put failed/);
  await assert.rejects(follower, /idempotency put failed/);
  assert.equal(h.liveBudget(), 0, "both leader and follower released their reservations on put failure");
});
