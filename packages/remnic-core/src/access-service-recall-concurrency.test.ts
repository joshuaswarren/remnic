import assert from "node:assert/strict";
import test from "node:test";

import {
  EngramAccessService,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
} from "./access-service.js";

// Issue #1906 — the per-principal recall lock was a width-1 FIFO mutex held
// for the whole ~30s recall. These tests exercise the replacement: a
// per-principal concurrency semaphore (recallMaxConcurrentPerPrincipal) plus
// query-level single-flight coalescing (recallSingleFlightEnabled).
//
// Coalescing here is deterministic without wall-clock waits: identical recalls
// acquire their slot synchronously, and the leader registers its in-flight
// promise in the same microtask before any follower checks the map, so all
// followers join one execution purely by microtask ordering.

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

// A recall response shaped only as this suite's stubs need it. Assigned to a
// named const with an explicit reason so the cast is not smuggled inline into a
// member access (the pipeline is stubbed; the real envelope shape is irrelevant
// here — we only assert structuredClone independence of the `results` array).
function stubResponse(results: unknown[]): EngramAccessRecallResponse {
  return { results } as unknown as EngramAccessRecallResponse;
}

function readResults(response: EngramAccessRecallResponse): unknown[] {
  assert.ok(response && typeof response === "object" && "results" in response);
  const { results } = response as { results: unknown[] };
  return results;
}

type ExecuteResult = {
  response: EngramAccessRecallResponse;
  budgetRecordPrincipal: string | null;
};

type BudgetDecision = {
  allowed: boolean;
  count?: number;
  limit?: { hardLimit: number; windowMs: number };
};

interface Harness {
  service: EngramAccessService;
  recallSemaphores: Map<string, unknown>;
  recallInFlight: Map<string, unknown>;
}

function makeService(opts: {
  limit?: number;
  singleFlight?: boolean;
  executeRecall: (request: EngramAccessRecallRequest) => Promise<ExecuteResult>;
  budgetRecord?: (principal: string) => BudgetDecision;
}): Harness {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const recallSemaphores = new Map<string, unknown>();
  const recallInFlight = new Map<string, unknown>();
  const host = service as unknown as {
    recallSemaphores: Map<string, unknown>;
    recallInFlight: Map<string, unknown>;
    orchestrator: { config: Record<string, unknown> };
    resolveRequestPrincipal: () => string;
    executeRecall: (request: EngramAccessRecallRequest) => Promise<ExecuteResult>;
    budget: { record: (principal: string) => BudgetDecision };
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
  host.executeRecall = opts.executeRecall;
  host.budget = {
    record: opts.budgetRecord ?? (() => ({ allowed: true })),
  };
  return { service, recallSemaphores, recallInFlight };
}

test("distinct concurrent recalls for one principal overlap (not serialized)", async () => {
  let started = 0;
  const bothStarted = deferred<void>();
  const release = deferred<void>();
  const { service } = makeService({
    limit: 4,
    executeRecall: async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return { response: stubResponse([]), budgetRecordPrincipal: null };
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

test("identical concurrent recalls coalesce to one execution; each caller gets its own response", async () => {
  let invocations = 0;
  const recordCalls: string[] = [];
  const { service, recallInFlight, recallSemaphores } = makeService({
    limit: 0, // unlimited so all N are in flight together and coalesce
    singleFlight: true,
    executeRecall: async () => {
      invocations += 1;
      return {
        response: stubResponse([{ id: "m1" }]),
        budgetRecordPrincipal: "principal",
      };
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

  assert.equal(invocations, 1, "the pipeline runs exactly once for 5 identical recalls");
  assert.equal(responses.length, 5);
  for (const r of responses) assert.ok(r);

  // Independent objects: mutating one caller's response must not affect others.
  readResults(responses[0]).push({ id: "mutated" });
  assert.equal(readResults(responses[1]).length, 1);

  // Budget record runs once per caller (N times for N coalesced callers).
  assert.deepEqual(recordCalls, [
    "principal",
    "principal",
    "principal",
    "principal",
    "principal",
  ]);

  // No leaks after all coalesced callers settle.
  assert.equal(recallInFlight.size, 0);
  assert.equal(recallSemaphores.size, 0);
});

test("single-flight disabled runs the pipeline once per identical request", async () => {
  let invocations = 0;
  const { service } = makeService({
    limit: 0,
    singleFlight: false,
    executeRecall: async () => {
      invocations += 1;
      return { response: stubResponse([]), budgetRecordPrincipal: null };
    },
  });

  await Promise.all(Array.from({ length: 5 }, () => service.recall({ query: "same" })));
  assert.equal(invocations, 5);
});

test("budget accounting stays per-caller under coalescing and preserves the deny message", async () => {
  let recordCount = 0;
  const { service } = makeService({
    limit: 0,
    singleFlight: true,
    executeRecall: async () => ({
      response: stubResponse([]),
      budgetRecordPrincipal: "principal",
    }),
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

test("a queued recall rejects immediately on abort — before the holder releases", async () => {
  let invocations = 0;
  const leaderStarted = deferred<void>();
  const releaseLeader = deferred<void>();
  const { service, recallSemaphores } = makeService({
    limit: 1,
    executeRecall: async () => {
      invocations += 1;
      leaderStarted.resolve();
      await releaseLeader.promise;
      return { response: stubResponse([]), budgetRecordPrincipal: null };
    },
  });

  const leader = service.recall({ query: "leader" });
  await leaderStarted.promise;

  const controller = new AbortController();
  const queued = service.recall({ query: "queued", abortSignal: controller.signal });
  controller.abort();

  // Rejects on abort while the leader is still held (invocations stays 1).
  await assert.rejects(queued, (error: Error) => error.name === "AbortError");
  assert.equal(invocations, 1, "the aborted queued recall never started its pipeline");

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
    executeRecall: async (request) => {
      if (request.query === "leader") {
        leaderStarted.resolve();
        await releaseLeader.promise;
      } else if (request.query === "third") {
        thirdRan = true;
      }
      return { response: stubResponse([]), budgetRecordPrincipal: null };
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
    executeRecall: async () => {
      active += 1;
      peak = Math.max(peak, active);
      startedCount += 1;
      if (startedCount === expectedStart) reachedExpected.resolve();
      const gate = deferred<void>();
      gates.push(gate.resolve);
      await gate.promise;
      active -= 1;
      return { response: stubResponse([]), budgetRecordPrincipal: null };
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

  // Drain to completion: resolve every gate as it appears (each release frees a
  // slot for the next queued recall) until all three calls settle. Bounded by
  // call completion, not by wall-clock time.
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

test("queueWaitMs is threaded to the pipeline: ~0 when a slot is free, >0 when queued", async () => {
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
      executeRecall: async (request) => {
        seen.push(request.queueWaitMs);
        if (request.query === "leader") {
          leaderStarted.resolve();
          await releaseLeader.promise;
        }
        return { response: stubResponse([]), budgetRecordPrincipal: null };
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
  let invocations = 0;
  const { service, recallInFlight, recallSemaphores } = makeService({
    limit: 0,
    singleFlight: true,
    executeRecall: async () => {
      invocations += 1;
      if (invocations === 1) throw new Error("leader boom");
      return { response: stubResponse([]), budgetRecordPrincipal: null };
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
  assert.equal(invocations, 2, "the recovery recall ran a fresh pipeline");
  assert.equal(recallInFlight.size, 0);
  assert.equal(recallSemaphores.size, 0);
});
