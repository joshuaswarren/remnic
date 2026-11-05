// Daemon-owned backlog scheduler: ONE bounded in-process loop that claims and
// drains ALL persisted extraction backlog — startup (existing claims + buffered
// sessions), new persisted work (ticks), retry-while-pending (backoff, no busy
// loops) — with bounded memory (counts only, never payload lists) and the
// queue's own concurrency as the in-flight bound.
//
// Claim authority: an existing claim (including an EMPTY ack tombstone) is
// authoritative over the live buffer's in-memory copy; a tombstoned key is
// never re-claimed or counted as work, and new ingress consumes the tombstone
// through the native save path before the key becomes a candidate again.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BacklogScheduler,
  type BacklogSchedulerDeps,
  type BacklogSchedulerOptions,
  wireBacklogScheduler,
} from "./orchestration/backlog-scheduler.js";
import type { DrainSessionOutcome } from "./orchestration/buffer-drain-runner.js";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { Orchestrator } from "./orchestrator.js";
import {
  cleanupDir,
  makeHarmonicLifecycleConfig,
  mkTempMemoryDir,
  singleFactResult,
  stubExtraction,
} from "./testing/orchestrator-lite.js";
import type { BufferTurn } from "./types.js";

interface StubState {
  /** Live pending counts per key, as the scheduler's bounded scan sees them. */
  counts: Map<string, { turns: number; retainedTurns: number }>;
  /** Keys the claim store already holds (including empty tombstones). */
  claimed: Set<string>;
  /** Pending turns per existing claim (0 = drained tombstone). */
  claimTurns: Map<string, number>;
  /** Keys the scheduler claimed via the native rename path. */
  claimedThisRun: Set<string>;
  /** Drain outcomes to hand back, in submission order. */
  outcomes: DrainSessionOutcome[];
  /** Settled drain submissions (key, outcome). */
  drained: { key: string; outcome: DrainSessionOutcome }[];
}

function makeDeps(state: StubState, queue: ExtractionQueueCoordinator): BacklogSchedulerDeps {
  return {
    queue,
    claims: {
      list: async () =>
        [...state.claimed].map((key) => ({
          key,
          turnCount: state.claimTurns.get(key) ?? 0,
          leased: false,
          leaseExpired: true,
        })),
      claimFromSessionFile: async (key) => {
        if (state.claimed.has(key) || state.claimedThisRun.has(key)) return "already_claimed";
        const turns = state.counts.get(key)?.turns ?? 0;
        if (turns === 0) return "empty";
        state.claimedThisRun.add(key);
        // The renamed claim holds the session's pending turns.
        state.claimed.add(key);
        state.claimTurns.set(key, turns);
        return "claimed";
      },
      isClaimed: (key) => state.claimed.has(key) || state.claimedThisRun.has(key),
      listPage: async (after, limit) => {
        // Contract: listPage returns claims with pending turns only.
        const names = [...state.claimed].filter((key) => (state.claimTurns.get(key) ?? 0) > 0).sort();
        const start = after === undefined ? 0 : names.findIndex((n) => n > after);
        const begin = start < 0 ? names.length : start;
        const out = names
          .slice(begin, begin + limit)
          .map((key) => ({ key, turnCount: state.claimTurns.get(key) ?? 0, leased: false, leaseExpired: true }));
        const consumed = begin + out.length;
        return { entries: out, nextCursor: consumed < names.length ? names[consumed] : undefined };
      },
    },
    liveBufferCounts: () => state.counts,
    lease: () => ({
      ownerId: "daemon-drain-test",
      pid: process.pid,
      host: "test",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs: 60_000,
    }),
    drainKey: async (key) => {
      const outcome = state.outcomes.shift() ?? emptyOutcome(key);
      state.drained.push({ key, outcome });
      // A drained claim is an empty tombstone: authoritative, no pending turns.
      if (outcome.status === "drained") state.claimTurns.set(key, 0);
      return outcome;
    },
  };
}

function emptyOutcome(key: string, overrides: Partial<DrainSessionOutcome> = {}): DrainSessionOutcome {
  return {
    key,
    status: "drained",
    turnsAtStart: 0,
    turnsRemaining: 0,
    persistedCount: 0,
    durableOutputCount: 0,
    ...overrides,
  };
}

function turn(content: string, sessionKey: string, timestamp = "2026-11-01T00:00:00.000Z"): BufferTurn {
  return { role: "user", content, timestamp, sessionKey };
}

test("startup drains existing claims and newly buffered sessions within the queue's concurrency", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([
      ["live-1", { turns: 3, retainedTurns: 0 }],
      ["live-2", { turns: 1, retainedTurns: 2 }],
    ]),
    claimed: new Set(["existing-claim"]),
    claimTurns: new Map([["existing-claim", 5]]),
    claimedThisRun: new Set(),
    outcomes: [
      emptyOutcome("existing-claim", { turnsAtStart: 5 }),
      emptyOutcome("live-1", { turnsAtStart: 3 }),
      emptyOutcome("live-2", { turnsAtStart: 3 }),
    ],
    drained: [],
  };
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    // The first tick filled the concurrency bound; the next drains the rest.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.deepEqual(
      state.drained.map((d) => d.key).sort(),
      ["existing-claim", "live-1", "live-2"],
      "startup covers existing claims AND unclaimed buffered work"
    );
    assert.ok(
      state.claimedThisRun.has("live-1") && state.claimedThisRun.has("live-2"),
      "unclaimed work went through the native claim"
    );
    const snap = scheduler.snapshot();
    assert.equal(snap.counters.processed, 3);
    assert.equal(snap.counters.claimed, 3);
  } finally {
    await scheduler.stop();
  }
});

test("an empty ack tombstone is authoritative: no resubmit, no recount", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    // The live buffer still holds the OLD snapshot (no dirty save since the
    // drain acked) and the claim store holds the EMPTY tombstone.
    counts: new Map([["sess-a", { turns: 2, retainedTurns: 0 }]]),
    claimed: new Set(["sess-a"]),
    claimTurns: new Map([["sess-a", 0]]),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 0, "a tombstoned key is never resubmitted");
    assert.equal(scheduler.snapshot().counters.processed, 0);
    // No ingress: still nothing on the next tick.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 0);
  } finally {
    await scheduler.stop();
  }
});

test("new ingress consumes the tombstone and the key resumes draining", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["sess-a", { turns: 2, retainedTurns: 0 }]]),
    claimed: new Set(["sess-a"]),
    claimTurns: new Map([["sess-a", 0]]),
    claimedThisRun: new Set(),
    outcomes: [emptyOutcome("sess-a", { turnsAtStart: 1, durableOutputCount: 1 })],
    drained: [],
  };
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 0);

    // New ingress: the live owner's save consumed the tombstone (native
    // handover path), so the key is unclaimed again with genuinely new work.
    state.claimed.delete("sess-a");
    state.claimTurns.delete("sess-a");
    state.counts.set("sess-a", { turns: 1, retainedTurns: 0 });
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.deepEqual(
      state.drained.map((d) => d.key),
      ["sess-a"],
      "the key resumes and drains exactly once"
    );
    assert.equal(scheduler.snapshot().counters.processed, 1);
  } finally {
    await scheduler.stop();
  }
});

test("failed and denied outcomes back off instead of busy-retrying, and are surfaced", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["bad", { turns: 4, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [
      emptyOutcome("bad", { status: "failed", turnsRemaining: 4, reason: "provider down" }),
      emptyOutcome("bad", {
        status: "deferred",
        turnsRemaining: 1,
        reason: "pinned_namespace_unavailable",
        denied: [{ reason: "pinned_namespace_unavailable", turns: 3 }],
      }),
    ],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  // Frozen clock: backoff windows never elapse unless the test moves it.
  let nowMs = 1_000_000;
  const options: BacklogSchedulerOptions = {
    pollMs: 3_600_000,
    retryBaseMs: 60_000,
    retryMaxMs: 900_000,
    now: () => nowMs,
  };
  const scheduler = new BacklogScheduler(deps, options);
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    const snap1 = scheduler.snapshot();
    assert.equal(snap1.counters.failed, 1, "the failure is counted");
    assert.equal(snap1.keys.find((k) => k.key === "bad")?.state, "backoff");
    // Backoff: an immediate re-tick must NOT resubmit (no busy retry).
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 1, "no busy retry inside the backoff window");

    // Second submission (clock advanced past the backoff window) reports the
    // denial and flips the key state.
    nowMs = 2_000_000;
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    const snap2 = scheduler.snapshot();
    assert.deepEqual(snap2.counters.denied, { keys: 1, turns: 3 }, "denials are surfaced in counters");
    assert.equal(snap2.keys.find((k) => k.key === "bad")?.state, "denied");
    assert.equal(snap2.counters.processed, 0, "denied backlog is never counted processed");
    assert.deepEqual(snap2.keys.find((k) => k.key === "bad")?.reason, "pinned_namespace_unavailable");
  } finally {
    await scheduler.stop();
  }
});

test("the in-flight bound is the queue's own maxConcurrency", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([
      ["k1", { turns: 1, retainedTurns: 0 }],
      ["k2", { turns: 1, retainedTurns: 0 }],
      ["k3", { turns: 1, retainedTurns: 0 }],
    ]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const enteredWaiters = new Map<string, Promise<void>>();
  const enteredResolve = new Map<string, () => void>();
  const whenEntered = (key: string): Promise<void> => {
    const existing = enteredWaiters.get(key);
    if (existing) return existing;
    const { promise, resolve } = Promise.withResolvers<void>();
    enteredWaiters.set(key, promise);
    enteredResolve.set(key, resolve);
    return promise;
  };
  const markEntered = (key: string): void => {
    whenEntered(key);
    enteredResolve.get(key)?.();
  };
  const scheduler = new BacklogScheduler(
    {
      ...deps,
      drainKey: async (key) => {
        started.push(key);
        markEntered(key);
        await new Promise<void>((resolve) => gates.set(key, resolve));
        const outcome = emptyOutcome(key);
        state.drained.push({ key, outcome });
        // A drained claim tombstones (no pending turns left to list).
        state.claimTurns.set(key, 0);
        return outcome;
      },
    },
    { pollMs: 3_600_000 }
  );
  scheduler.start();
  try {
    // start()'s initial tick submits up to the bound; drainKey entry is the
    // deterministic signal (no wall-clock waits).
    await whenEntered("k1");
    await whenEntered("k2");
    assert.equal(started.length, 2, "only maxConcurrency submissions are outstanding");
    assert.deepEqual(scheduler.snapshot().inFlight.sort(), ["k1", "k2"]);
    gates.get("k1")?.();
    // Settle k1's SLOT (k2 is still gated and excluded), then the freed slot
    // lets the next candidate submit.
    await scheduler.settleForTest("k2");
    await scheduler.tickForTest();
    await whenEntered("k3");
    assert.equal(started.length, 3, "a settled slot lets the next candidate submit");
    gates.get("k2")?.();
    gates.get("k3")?.();
    await scheduler.settleForTest();
  } finally {
    await scheduler.stop();
  }
});

test("stop aborts in-flight drains; a fresh start resumes the still-claimed backlog", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["slow", { turns: 9, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  const observedSignals: AbortSignal[] = [];
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new BacklogScheduler(
    {
      ...deps,
      drainKey: async (key, options) => {
        observedSignals.push(options.signal);
        entered.resolve();
        await gate;
        return emptyOutcome(key, { status: "failed", turnsRemaining: 9, reason: "aborted" });
      },
    },
    { pollMs: 3_600_000 }
  );
  scheduler.start();
  await scheduler.tickForTest();
  await entered.promise;
  const stopping = scheduler.stop();
  release();
  await stopping;
  assert.equal(observedSignals[0]?.aborted, true, "stop aborts in-flight drains");
  assert.equal(scheduler.snapshot().inFlight.length, 0);
  // A fresh scheduler over the same (still-claimed) backlog resumes it.
  const second = new BacklogScheduler(
    {
      ...deps,
      drainKey: async (key) => {
        const outcome = emptyOutcome(key, { turnsAtStart: 9 });
        state.drained.push({ key, outcome });
        // A drained claim tombstones (no pending turns left to list).
        state.claimTurns.set(key, 0);
        return outcome;
      },
    },
    { pollMs: 3_600_000 }
  );
  second.start();
  try {
    await second.tickForTest();
    await second.settleForTest();
    assert.deepEqual(
      state.drained.map((d) => d.key),
      ["slow"],
      "a restart resumes the backlog"
    );
  } finally {
    await second.stop();
  }
});

// ── Real wiring: scheduler over a real orchestrator (native claim path) ────

test("a wired scheduler drains real backlog and resumes after tombstone-consuming ingress", async () => {
  const memoryDir = await mkTempMemoryDir("backlog-sched-wired");
  let orchestrator: Orchestrator | undefined;
  try {
    orchestrator = new Orchestrator(
      makeHarmonicLifecycleConfig(memoryDir, { extractionMinChars: 0, extractionMinUserTurns: 1 })
    );
    const calls = stubExtraction(orchestrator, (turns) => singleFactResult(`fact for ${turns[0]?.content ?? "empty"}`));
    const scheduler = wireBacklogScheduler(orchestrator, { pollMs: 3_600_000 });
    try {
      await orchestrator.buffer.addTurn("wired-1", turn("wired one", "wired-1"));
      await orchestrator.buffer.addTurn("wired-2", turn("wired two", "wired-2"));
      await orchestrator.buffer.save();

      scheduler.start();
      // Concurrency 1: tick/settle until both sessions drained (bounded loop,
      // each iteration an await — no wall-clock waits).
      for (let attempt = 0; attempt < 4 && scheduler.snapshot().counters.processed < 2; attempt += 1) {
        await scheduler.tickForTest();
        await scheduler.settleForTest();
      }
      assert.equal(scheduler.snapshot().counters.processed, 2, "both persisted sessions drained");
      assert.equal(calls.length, 2);
      // The native claim path: session files gone, empty tombstones remain.
      const liveFiles = await orchestrator.storage.loadBuffer();
      assert.equal(liveFiles.entries?.["wired-1"]?.turns.length ?? 0, 0, "the drained session file is consumed");
      const claims = orchestrator.storage.bufferDrainClaims();
      const listed = await claims.list();
      assert.deepEqual(listed.map((l) => l.turnCount).sort(), [0, 0], "both claims are empty tombstones");

      // New ingress: the live save consumes the tombstone natively; the
      // scheduler resumes the key and drains exactly the new turn.
      await orchestrator.buffer.addTurn("wired-1", turn("wired three", "wired-1", "2026-11-01T00:05:00.000Z"));
      await orchestrator.buffer.save();
      for (let attempt = 0; attempt < 4 && scheduler.snapshot().counters.processed < 3; attempt += 1) {
        await scheduler.tickForTest();
        await scheduler.settleForTest();
      }
      assert.equal(scheduler.snapshot().counters.processed, 3, "ingress after the tombstone resumes draining");
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls[2]?.map((t) => t.content),
        ["wired three"],
        "only the genuinely new turn extracts — drained turns never resurrect"
      );
    } finally {
      await scheduler.stop();
    }
  } finally {
    await orchestrator?.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

test("a claim decision unsettled mid-rename keeps the key reserved until it settles", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["racy", { turns: 2, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const decisionSettled = Promise.withResolvers<void>();
  const liveRuns: string[] = [];
  const scheduler = new BacklogScheduler(
    {
      ...deps,
      claims: {
        ...deps.claims,
        // Pause the claim decision AFTER the synchronous reservation.
        claimFromSessionFile: async (key) => {
          await claimGate;
          state.claimedThisRun.add(key);
          decisionSettled.resolve();
          return "claimed";
        },
      },
      drainKey: async (key) => {
        liveRuns.push(`drain:${key}`);
        const outcome = emptyOutcome(key, { turnsAtStart: 2 });
        state.drained.push({ key, outcome });
        return outcome;
      },
    },
    { pollMs: 3_600_000 }
  );
  scheduler.start();
  try {
    await scheduler.tickForTest();
    // The decision is unsettled: the reservation is held and visible.
    assert.deepEqual(scheduler.snapshot().reservedKeys, ["racy"]);
    // A live task enqueued for the same key cannot start past the gate while
    // the reservation is held (selection skips reserved keys — proven in the
    // queue suite; here the fence is observable through the live stub too).
    assert.equal(
      queue.enqueue(
        async () => {
          liveRuns.push("live:racy");
        },
        { key: "racy" }
      ),
      true
    );
    assert.equal(liveRuns.length, 0, "no live or drain work runs before the decision settles");
    // The decision settles: reservation released, drain runs; the live task
    // (a real pipeline's gate self-skips claimed keys) settles before it.
    releaseClaim();
    await decisionSettled.promise;
    await scheduler.settleForTest();
    assert.equal(state.claimedThisRun.has("racy"), true, "the claim decision completed");
    assert.ok(liveRuns.includes("drain:racy"), "the drain ran after the decision");
    assert.deepEqual(scheduler.snapshot().reservedKeys, [], "the reservation was released with the decision");
  } finally {
    releaseClaim();
    await scheduler.stop();
  }
});

test("stop during a pending discovery submit: no drain runs, restart handles it", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["late", { turns: 1, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const entered = Promise.withResolvers<void>();
  const scheduler = new BacklogScheduler(
    {
      ...deps,
      claims: {
        ...deps.claims,
        list: async () => {
          await listGate;
          return deps.claims.list();
        },
      },
      drainKey: async (key) => {
        entered.resolve();
        state.drained.push({ key, outcome: emptyOutcome(key) });
        return emptyOutcome(key);
      },
    },
    { pollMs: 3_600_000 }
  );
  scheduler.start();
  const stopping = scheduler.stop();
  releaseList();
  await stopping;
  await Promise.race([entered.promise, new Promise((r) => setTimeout(r, 0))]);
  assert.equal(state.drained.length, 0, "no drain may run after stop, even when discovery was pending");
  assert.equal(scheduler.snapshot().inFlight.length, 0);
  void entered;
});

test("a discovery failure must not reject into the detached tick; the next poll retries", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["live-1", { turns: 1, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [emptyOutcome("live-1", { turnsAtStart: 1 })],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  let failures = 0;
  deps.claims.listPage = async () => {
    failures += 1;
    if (failures === 1) throw Object.assign(new Error("EACCES: claims dir"), { code: "EACCES" });
    return { entries: [] };
  };
  const scheduler = new BacklogScheduler(deps, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    // start() detaches the first tick: a discovery failure must be caught and
    // logged, never surface as an unhandled rejection that kills the server.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    // The scheduler is still alive: the next poll discovers and drains.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 1, "the scheduler recovers on the next poll");
  } finally {
    await scheduler.stop();
  }
});

test("a thrown drain leaves the claim intact, counts failed, and backs off", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["throwing-1", { turns: 2, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  deps.drainKey = async (key) => {
    state.drained.push({ key, outcome: emptyOutcome(key) });
    throw new Error("provider exploded");
  };
  const scheduler = new BacklogScheduler(deps, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 1, "the drain attempt ran");
    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.counters.failed, 1, "a thrown drain counts failed");
    const keyState = snapshot.keys.find((entry) => entry.key === "throwing-1");
    assert.equal(keyState?.state, "backoff", "the key backs off for a later attempt");
    assert.equal(state.claimTurns.get("throwing-1"), 2, "the claim content is intact in the store");
  } finally {
    await scheduler.stop();
  }
});

test("a deferred outcome without a denial report backs off but never counts denied", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["deferred-1", { turns: 1, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [
      {
        key: "deferred-1",
        status: "deferred",
        turnsAtStart: 1,
        turnsRemaining: 1,
        persistedCount: 0,
        durableOutputCount: 0,
        reason: "provider_circuit_open",
      },
    ],
    drained: [],
  };
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    const snapshot = scheduler.snapshot();
    const keyState = snapshot.keys.find((entry) => entry.key === "deferred-1");
    assert.equal(keyState?.state, "backoff", "a provider deferral is a backoff, not a denial");
    assert.deepEqual(snapshot.counters.denied, { keys: 0, turns: 0 }, "no denied turns without a denial report");
    assert.equal(snapshot.counters.failed, 0);
  } finally {
    await scheduler.stop();
  }
});

test("a claim creation failure is caught: failed counter, backoff, no crash", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["enospc-1", { turns: 1, retainedTurns: 0 }]]),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = makeDeps(state, queue);
  deps.claims.claimFromSessionFile = async () => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  const scheduler = new BacklogScheduler(deps, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    // The detached submission must swallow the claim failure: no unhandled
    // rejection, the scheduler stays alive.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.counters.failed, 1, "the claim failure counts failed");
    const keyState = snapshot.keys.find((entry) => entry.key === "enospc-1");
    assert.equal(keyState?.state, "backoff", "the key backs off for a later attempt");
    assert.equal(state.drained.length, 0, "nothing drained without a claim");
  } finally {
    await scheduler.stop();
  }
});

test("a zero concurrency limit disables submissions (the documented '0 disables' contract)", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const state: StubState = {
    counts: new Map([["live-1", { turns: 1, retainedTurns: 0 }]]),
    claimed: new Set(["live-1"]),
    claimTurns: new Map([["live-1", 1]]),
    claimedThisRun: new Set(),
    outcomes: [emptyOutcome("live-1", { turnsAtStart: 1 })],
    drained: [],
  };
  // A queue that reports a zero limit: the scheduler must submit nothing
  // rather than treat the limit as "one slot".
  Object.defineProperty(queue, "maxConcurrency", { get: () => 0 });
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.equal(state.drained.length, 0, "a zero limit submits nothing");
    assert.equal(state.outcomes.length, 1, "the pending outcome is untouched");
  } finally {
    await scheduler.stop();
  }
});

test("a discovery failure after the page cursor moved restores the cursor so the page is re-listed", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const claimKeys: string[] = [];
  for (let i = 1; i <= 17; i += 1) claimKeys.push("claim-" + String(i).padStart(2, "0"));
  const state: StubState = {
    counts: new Map(claimKeys.map((key) => [key, { turns: 1, retainedTurns: 0 }])),
    claimed: new Set(claimKeys),
    claimTurns: new Map(claimKeys.map((key) => [key, 1])),
    claimedThisRun: new Set(),
    outcomes: claimKeys.map((key) => emptyOutcome(key, { turnsAtStart: 1 })),
    drained: [],
  };
  const deps = makeDeps(state, queue);
  let failLiveCounts = true;
  deps.liveBufferCounts = () => {
    // The page is already listed when this read fails — the cursor moved.
    if (failLiveCounts) {
      failLiveCounts = false;
      throw new Error("EIO: buffer counts");
    }
    return state.counts;
  };
  const scheduler = new BacklogScheduler(deps, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    // start() detaches the first tick: it lists the page (cursor moves) and
    // then the live-count read fails.
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    // The cursor was restored, so the SAME page is listed again and its
    // claims drain — otherwise they wait for the cursor to wrap.
    assert.equal(state.drained.length, 1, "the re-listed page is submitted on the next tick");
    assert.equal(state.drained[0]?.key, claimKeys[0], "the first claim of the page drains first");
  } finally {
    await scheduler.stop();
  }
});

test("claims past the concurrency bound are re-listed on the next tick, in page order", async () => {
  const queue = new ExtractionQueueCoordinator(1);
  const claimKeys: string[] = [];
  for (let i = 1; i <= 17; i += 1) claimKeys.push("claim-" + String(i).padStart(2, "0"));
  const state: StubState = {
    counts: new Map(claimKeys.map((key) => [key, { turns: 1, retainedTurns: 0 }])),
    claimed: new Set(),
    claimTurns: new Map(),
    claimedThisRun: new Set(),
    outcomes: claimKeys.map((key) => emptyOutcome(key, { turnsAtStart: 1 })),
    drained: [],
  };
  const scheduler = new BacklogScheduler(makeDeps(state, queue), { pollMs: 3_600_000 });
  scheduler.start();
  try {
    // Two ticks with concurrency 1: page order must be preserved — the
    // first two claims drain, one per tick, in claim order.
    for (let tick = 1; tick <= 2; tick += 1) {
      await scheduler.tickForTest();
      await scheduler.settleForTest();
    }
    const drainedKeys = state.drained.map((entry) => entry.key);
    assert.deepEqual(drainedKeys.slice(0, 2), [claimKeys[0], claimKeys[1]], "page-order fairness: claims 1 then 2 drain before claim 17");
    for (let tick = 3; tick <= 20; tick += 1) {
      await scheduler.tickForTest();
      await scheduler.settleForTest();
    }
    assert.equal(new Set(state.drained.map((entry) => entry.key)).size, 17, "every claim drains exactly once");
  } finally {
    await scheduler.stop();
  }
});

// ── Provider-breaker churn guard ────────────────────────────────────────────
//
// While the shared provider breaker is OPEN inside its cooldown, a full
// submission reads the claim, rebuilds the buffer/coordinator and re-renders
// chunks before the breaker fails the attempt fast — pure heap pressure per
// poll. The scheduler must skip submission entirely; when the window lapses,
// submissions resume and the breaker's own half-open probe keeps recovery
// automatic.

function breakerInstrumentedDeps(
  state: StubState,
  queue: ExtractionQueueCoordinator,
): BacklogSchedulerDeps & { claimReads(): number } {
  const deps = makeDeps(state, queue);
  const originalClaim = deps.claims.claimFromSessionFile;
  let claimReads = 0;
  deps.claims.claimFromSessionFile = async (key, lease) => {
    claimReads += 1;
    return originalClaim(key, lease);
  };
  return { ...deps, claimReads: () => claimReads };
}

test("an open provider breaker suppresses submission: no drain, no claim read", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["live-open", { turns: 4, retainedTurns: 0 }]]),
    claimed: new Set(["pending-claim"]),
    claimTurns: new Map([["pending-claim", 7]]),
    claimedThisRun: new Set(),
    outcomes: [],
    drained: [],
  };
  const deps = breakerInstrumentedDeps(state, queue);
  const originalListPage = deps.claims.listPage;
  let listPageCalls = 0;
  deps.claims.listPage = async (...args) => {
    listPageCalls += 1;
    return originalListPage(...args);
  };
  const scheduler = new BacklogScheduler({
    ...deps,
    breakerSnapshot: () => ({
      state: "open",
      openUntilMs: Date.now() + 300_000,
      consecutiveFailures: 5,
      lastReason: "provider 400s",
    }),
  }, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    for (let tick = 1; tick <= 2; tick += 1) {
      await scheduler.tickForTest();
      await scheduler.settleForTest();
    }
    assert.equal(state.drained.length, 0, "no attempt is built while the breaker is open");
    assert.equal(deps.claimReads(), 0, "no claim is read while the breaker is open");
    assert.equal(listPageCalls, 0, "claim discovery I/O is skipped while the breaker is open");
    assert.equal(scheduler.snapshot().counters.claimed, 0);
  } finally {
    await scheduler.stop();
  }
});

test("a lapsed breaker window resumes submission and drains the backlog", async () => {
  const queue = new ExtractionQueueCoordinator(2);
  const state: StubState = {
    counts: new Map([["live-open", { turns: 4, retainedTurns: 0 }]]),
    claimed: new Set(["pending-claim"]),
    claimTurns: new Map([["pending-claim", 7]]),
    claimedThisRun: new Set(),
    outcomes: [
      emptyOutcome("pending-claim", { turnsAtStart: 7 }),
      emptyOutcome("live-open", { turnsAtStart: 4 }),
    ],
    drained: [],
  };
  const deps = breakerInstrumentedDeps(state, queue);
  // Window already lapsed: the next submission IS the half-open probe path.
  const scheduler = new BacklogScheduler({
    ...deps,
    breakerSnapshot: () => ({
      state: "open",
      openUntilMs: Date.now() - 1,
      consecutiveFailures: 5,
      lastReason: "provider 400s",
    }),
  }, { pollMs: 3_600_000 });
  scheduler.start();
  try {
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    await scheduler.tickForTest();
    await scheduler.settleForTest();
    assert.deepEqual(
      state.drained.map((entry) => entry.key).sort(),
      ["live-open", "pending-claim"],
      "a lapsed window lets submissions (the probe path) through"
    );
  } finally {
    await scheduler.stop();
  }
});
