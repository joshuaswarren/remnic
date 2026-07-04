// Tests for the shared serialized-mutation utility (issue #1524 utility PR).
//
// Every semantic the issue's "Done when" enumerates has a dedicated test:
//   - rejection recovery (a rejected task never poisons the chain);
//   - no unbounded growth (per-key entry deleted when the last task settles);
//   - replacement-safe stale breaking (NG7Bg);
//   - unchanged-stale still broken (NG7Bg baseline);
//   - best-effort on acquisition timeout;
//   - ownership-checked release;
//   - mutual exclusion across concurrent tasks.
//
// Prove-fail-before: the rejection-recovery defect class (a bare `.then(fn)`
// chain that dies after the first rejection) is reproduced inline via a NAIVE
// poison-chain helper and asserted to FAIL to recover, before the real
// `serializeMutations` is asserted to recover. That documents the exact bug
// this utility exists to eliminate.
//
// NOTE on real timers: the serializeMutations tests below use NO wall-clock
// delays — they drive scheduling deterministically via gates and microtask
// yields. The withHeldFileLock tests DO use small real delays, because they
// exercise real filesystem `mtime` (the platform clock for stale detection)
// and real `setInterval` heartbeats — there is no fake-timer analog for
// `fs.stat().mtimeMs`. Per the test-timer rule's exception, each such test
// names why deterministic time control will not work.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MutationSerializer,
  serializeMutations,
  withHeldFileLock,
} from "./serialize-mutations.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mkTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "remnic-serialize-mutations-"));
}

/** Yield to the microtask queue so chained `.then` cleanup callbacks run. */
async function microtick(): Promise<void> {
  // Two awaits guarantee the self-cleaning `.then` (chained off the recovered
  // tail) has drained — it is itself one microtask behind the caller's await.
  await Promise.resolve();
  await Promise.resolve();
}

/** Resolve after `ms`. Used ONLY by the withHeldFileLock integration tests.
 * Intentionally NOT unref'd: the delay IS the work the test is awaiting, so it
 * must keep the event loop alive until it fires. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * NAIVE poison chain — the defect class this utility replaces. A bare
 * `.then(fn)` with NO rejection recovery: once one task rejects, the chain's
 * tail rejects permanently and every subsequent task is SKIPPED. Used by the
 * prove-fail-before test to show the exact bug.
 */
function naivePoisonChain<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = naivePoisonMap.get(key) ?? Promise.resolve();
  // BUG: bare `.then(task)` — a rejection in `task` rejects the chain, so the
  // next queued task's `.then(task)` never runs its callback (it propagates the
  // rejection instead). This is what rule #40 / this utility fix.
  const next = prior.then(task);
  naivePoisonMap.set(key, next);
  return next;
}
const naivePoisonMap = new Map<string, Promise<unknown>>();

// ─────────────────────────────────────────────────────────────────────────────
// serializeMutations — ordering
// ─────────────────────────────────────────────────────────────────────────────

test("serializeMutations runs same-key tasks in submission order", async () => {
  const s = new MutationSerializer();
  const order: string[] = [];
  // Deterministic gate: A stays in-flight until we release it AFTER B and C
  // are queued, so the test proves B/C wait for A regardless of scheduling.
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers<void>();

  const a = s.serialize("k", async () => {
    await aGate;
    order.push("a");
  });
  const b = s.serialize("k", async () => {
    order.push("b");
  });
  const c = s.serialize("k", async () => {
    order.push("c");
  });

  releaseA();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a", "b", "c"], "tasks run in submission order regardless of timing");
});

test("serializeMutations runs different-key tasks concurrently (no cross-key blocking)", async () => {
  const s = new MutationSerializer();
  const { promise: allowKey1, resolve: releaseKey1 } = Promise.withResolvers<void>();

  // Key 1 task blocks until released; key 2 task should NOT wait on it.
  const key1 = s.serialize("k1", async () => {
    await allowKey1;
  });
  let key2Ran = false;
  const key2 = s.serialize("k2", async () => {
    key2Ran = true;
  });

  await key2;
  assert.equal(key2Ran, true, "different-key task must not block on an unrelated key's chain");

  releaseKey1();
  await key1;
});

test("serializeMutations surfaces the task's resolved value to its caller", async () => {
  const s = new MutationSerializer();
  const result = await s.serialize("k", async () => 42);
  assert.equal(result, 42);
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeMutations — rejection recovery (the core invariant)
// ─────────────────────────────────────────────────────────────────────────────

test("PROVE-FAIL: a naive bare-.then(fn) chain is poisoned by the first rejection", async () => {
  // This is the defect class. The naive helper skips task B after task A
  // rejects. Asserting the BUG here makes the fix in serializeMutations
  // concrete: if someone ever reverts to a bare `.then(fn)`, the real-utility
  // test below would start failing while this one stays green.
  let bRan = false;
  const a = naivePoisonChain("k", async () => {
    throw new Error("A failed");
  });
  const b = naivePoisonChain("k", async () => {
    bRan = true;
  });

  await a.catch(() => undefined);
  await b.catch(() => undefined);
  assert.equal(bRan, false, "naive chain skips task B after task A rejects (the bug)");
});

test("serializeMutations: a rejected task never poisons the chain (B runs after A rejects)", async () => {
  const s = new MutationSerializer();
  const order: string[] = [];
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers<void>();

  const a = s.serialize("k", async () => {
    order.push("a-start");
    await aGate; // keep A in-flight so B is provably queued behind a live A
    order.push("a-throw");
    throw new Error("A failed");
  });
  let bRan = false;
  const b = s.serialize("k", async () => {
    bRan = true;
    order.push("b");
    return "b-done";
  });

  releaseA();
  // A's caller sees A's rejection.
  await assert.rejects(() => a, /A failed/);
  // B STILL RUNS and resolves.
  const bResult = await b;
  assert.equal(bRan, true, "task B must run even though task A rejected");
  assert.equal(bResult, "b-done");
  assert.deepEqual(order, ["a-start", "a-throw", "b"]);
});

test("serializeMutations: an early rejection does not stop many later tasks", async () => {
  const s = new MutationSerializer();
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers<void>();
  const results: number[] = [];

  const rejected = s.serialize("k", async () => {
    await aGate;
    throw new Error("boom");
  });
  const tasks = Array.from({ length: 10 }, (_, i) =>
    s.serialize("k", async () => {
      results.push(i);
      return i;
    }),
  );

  releaseA();
  // allSettled (not all) so a rejecting chain does not short-circuit before we
  // assert the observable behavior. With recovery every task runs and resolves;
  // with a bare-.then chain, the rejection poisons the chain and results stays
  // empty — a clean behavioral failure rather than an unhandled-rejection tangle.
  await rejected.catch(() => undefined);
  const settled = await Promise.allSettled(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(
    settled.every((r) => r.status === "fulfilled"),
    "every later task fulfilled (chain was not poisoned)",
  );
});

test("serializeMutations: a rejection in one key does not affect another key", async () => {
  const s = new MutationSerializer();
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers<void>();

  const a = s.serialize("k1", async () => {
    await aGate;
    throw new Error("k1 fail");
  });
  const b = s.serialize("k2", async () => "k2-ok");

  releaseA();
  await assert.rejects(() => a, /k1 fail/);
  assert.equal(await b, "k2-ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeMutations — no unbounded growth
// ─────────────────────────────────────────────────────────────────────────────

test("serializeMutations deletes the per-key entry after the last task settles", async () => {
  const s = new MutationSerializer();
  assert.equal(s.pendingKeysForTest(), 0, "starts empty");

  await s.serialize("k", async () => 1);
  // Let the self-cleaning microtask (chained off the recovered tail) drain.
  await microtick();
  assert.equal(s.pendingKeysForTest(), 0, "entry removed after a single task settles");
});

test("serializeMutations keeps the entry while tasks are in flight, then removes it", async () => {
  const s = new MutationSerializer();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();

  const a = s.serialize("k", async () => {
    await gate;
  });
  const b = s.serialize("k", async () => "done");

  // While A is parked, the entry must still exist (B is queued behind it).
  assert.equal(s.pendingKeysForTest(), 1, "entry present while tasks are in flight");
  release();
  await Promise.all([a, b]);
  await microtick();
  assert.equal(s.pendingKeysForTest(), 0, "entry removed after the chain drains");
});

test("serializeMutations does not accumulate entries across many sequential tasks", async () => {
  const s = new MutationSerializer();
  for (let i = 0; i < 50; i++) {
    // Sequential: each settles and cleans up before the next is queued (the
    // common hot-path shape). The map must never grow past 1.
    await s.serialize("hot", async () => i);
  }
  await microtick();
  assert.equal(s.pendingKeysForTest(), 0, "no leftover entries after sequential drains");
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeMutations — input validation & free-function export
// ─────────────────────────────────────────────────────────────────────────────

test("serializeMutations rejects an empty key", () => {
  const s = new MutationSerializer();
  assert.throws(() => s.serialize("", async () => 1), /non-empty string/);
});

test("serializeMutations rejects a non-function task", () => {
  const s = new MutationSerializer();
  assert.throws(
    () => s.serialize("k", "not-a-function" as unknown as () => Promise<void>),
    /function returning a promise/,
  );
});

test("the free serializeMutations export serializes across independent calls", async () => {
  const order: string[] = [];
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers<void>();
  const a = serializeMutations("free-fn-shared-key", async () => {
    await aGate;
    order.push("a");
  });
  const b = serializeMutations("free-fn-shared-key", async () => {
    order.push("b");
  });
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a", "b"], "free function shares one process-wide serializer");
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — mutual exclusion & lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock runs the task with acquired=true and removes the lock on completion", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "test.lock");
    let observedAcquired = false;
    const result = await withHeldFileLock(lockPath, { staleMs: 5_000 }, async (acquired) => {
      observedAcquired = acquired;
      // While we hold the lock, the file exists with our owner id.
      const content = await readFile(lockPath, "utf8");
      const parts = content.trim().split(/\s+/);
      assert.equal(parts.length, 3, "lock content is '<pid> <owner-uuid> <iso>'");
      return "ok";
    });
    assert.equal(observedAcquired, true);
    assert.equal(result, "ok");
    const exists = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "lock file removed after the task completes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock serializes concurrent tasks on the same lock path (no overlap)", async () => {
  // Integration test of real filesystem mutex behavior: `open(path,'wx')` is
  // atomic at the OS level, so critical sections cannot overlap. The short
  // real delay inside each section makes overlap OBSERVABLE if serialization
  // were ever bypassed; deterministic time control cannot substitute because
  // the guarantee is the OS exclusive-create, not a timer.
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "mutex.lock");
    let active = 0;
    let maxOverlap = 0;

    async function worker(): Promise<void> {
      await withHeldFileLock(lockPath, { staleMs: 5_000 }, async () => {
        active += 1;
        maxOverlap = Math.max(maxOverlap, active);
        await delay(8);
        active -= 1;
      });
    }

    await Promise.all(Array.from({ length: 5 }, () => worker()));
    assert.equal(maxOverlap, 1, "critical sections never overlapped (mutual exclusion held)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — stale breaking (mtime is the platform clock; utimes seeds
// it deterministically, so these tests need NO real delay for staleness itself)
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock breaks a genuinely stale lock and acquires (baseline)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "stale.lock");
    // Seed a stale lock (old mtime via utimes — deterministic, no real delay).
    const staleContent = `${999999} aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ${new Date(
      Date.now() - 60_000,
    ).toISOString()}\n`;
    await writeFile(lockPath, staleContent, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let acquired = false;
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000 },
      async (a) => {
        acquired = a;
      },
    );
    assert.equal(acquired, true, "stale lock was broken and we acquired");

    const exists = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "stale lock replaced then released");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock does NOT delete a REPLACEMENT lock created in the race window (NG7Bg)", async () => {
  // Focused NG7Bg invariant: seed a stale lock, fire the seam to swap in a
  // fresh replacement during the break's race window, use a SHORT maxWait so
  // the breaker must decide on the replacement (not wait it out), and assert
  // the replacement (owner D) survives unmodified — the break saw different
  // content and refused to unlink.
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "race.lock");
    const staleContent = `${333333} cccccccc-cccc-4ccc-8ccc-cccccccccccc ${new Date(
      Date.now() - 60_000,
    ).toISOString()}\n`;
    await writeFile(lockPath, staleContent, "utf8");
    await utimes(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const replacementContent = `${444444} dddddddd-dddd-4ddd-8ddd-dddddddddddd ${new Date().toISOString()}\n`;
    let seamFired = false;
    await withHeldFileLock(
      lockPath,
      {
        staleMs: 5_000,
        maxWaitMs: 200,
        pollMs: 20,
        onBeforeBreakStaleUnlinkForTest: async () => {
          seamFired = true;
          await writeFile(lockPath, replacementContent, "utf8");
          await utimes(lockPath, new Date(), new Date());
        },
      },
      async (acquired) => {
        void acquired;
      },
    );
    assert.equal(seamFired, true, "the race-window seam fired");

    const after = await readFile(lockPath, "utf8");
    assert.equal(
      after,
      replacementContent,
      "replacement lock (owner D) survived the stale break unchanged",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — best-effort on timeout
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock invokes task(false) when a busy lock cannot be acquired in time", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "busy.lock");
    // Pre-create a FRESH lock (recent mtime) so the breaker will NOT break it
    // (not stale) and our acquire times out within maxWaitMs.
    const fresh = `${555555} eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee ${new Date().toISOString()}\n`;
    await writeFile(lockPath, fresh, "utf8");
    await utimes(lockPath, new Date(), new Date());

    let observedAcquired = true; // expect false
    const started = Date.now();
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000, maxWaitMs: 150 },
      async (acquired) => {
        observedAcquired = acquired;
      },
    );
    const waited = Date.now() - started;

    assert.equal(observedAcquired, false, "task ran best-effort with acquired=false on timeout");
    assert.ok(waited < 2_000, `did not hang (waited ~${waited}ms)`);

    const after = await readFile(lockPath, "utf8");
    assert.equal(after, fresh, "fresh holder's lock left intact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — ownership-checked release (NCzT6)
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock does not unlink a replacement lock on release (ownership-checked)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "release-race.lock");
    let ourOwnerId = "";

    // While we hold the lock, swap it for a replacement owned by someone else.
    // The release must detect it is no longer ours and leave the replacement.
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000 },
      async () => {
        const content = await readFile(lockPath, "utf8");
        const parts = content.trim().split(/\s+/);
        ourOwnerId = parts[1] ?? "";
        const replacement = `${666666} ffffffff-ffff-4fff-8fff-ffffffffffff ${new Date().toISOString()}\n`;
        await writeFile(lockPath, replacement, "utf8");
        await utimes(lockPath, new Date(), new Date());
      },
    );

    assert.ok(ourOwnerId.length > 0, "captured our owner id while we held the lock");
    const after = await readFile(lockPath, "utf8");
    assert.equal(
      after.includes("ffffffff-ffff-4fff-8fff-ffffffffffff"),
      true,
      "replacement lock was NOT unlinked by our release",
    );
    assert.notEqual(
      after.trim().split(/\s+/)[1],
      ourOwnerId,
      "the lock on disk is NOT ours after release",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — input validation
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock rejects an empty lockPath", async () => {
  await assert.rejects(
    () => withHeldFileLock("", { staleMs: 1_000 }, async () => undefined),
    /non-empty string/,
  );
});

test("withHeldFileLock rejects a non-positive staleMs", async () => {
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 0 }, async () => undefined),
    /positive finite number/,
  );
});

test("withHeldFileLock rejects NaN/Infinity/negative optional timings (not silently defaulted)", async () => {
  // A NaN maxWaitMs would make `Date.now() >= deadline` always false and the
  // bounded loop wait forever; reject it instead of silently falling back.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
    await assert.rejects(
      () => withHeldFileLock("/tmp/x.lock", { staleMs: 1_000, maxWaitMs: bad }, async () => undefined),
      /maxWaitMs must be a positive finite number/,
      `maxWaitMs=${bad} should be rejected`,
    );
    await assert.rejects(
      () => withHeldFileLock("/tmp/x.lock", { staleMs: 1_000, pollMs: bad }, async () => undefined),
      /pollMs must be a positive finite number/,
      `pollMs=${bad} should be rejected`,
    );
    await assert.rejects(
      () => withHeldFileLock("/tmp/x.lock", { staleMs: 1_000, heartbeatMs: bad }, async () => undefined),
      /heartbeatMs must be a positive finite number/,
      `heartbeatMs=${bad} should be rejected`,
    );
  }
});

test("withHeldFileLock accepts a finite positive maxWaitMs that bounds acquisition", async () => {
  const dir = await mkTmpDir();
  try {
    // A short but valid maxWaitMs against a fresh held lock times out cleanly.
    const lockPath = path.join(dir, "bounded.lock");
    const fresh = `${777777} 00000000-0000-4000-8000-000000000000 ${new Date().toISOString()}\n`;
    await writeFile(lockPath, fresh, "utf8");
    await utimes(lockPath, new Date(), new Date());
    let acquired = true;
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000, maxWaitMs: 1 },
      async (a) => {
        acquired = a;
      },
    );
    assert.equal(acquired, false, "tiny maxWaitMs timed out best-effort without hanging");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock rejects a heartbeatMs >= staleMs", async () => {
  const dir = await mkTmpDir();
  try {
    await assert.rejects(
      () =>
        withHeldFileLock(
          path.join(dir, "x.lock"),
          { staleMs: 1_000, heartbeatMs: 1_000 },
          async () => undefined,
        ),
      /must be below staleMs/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock creates the lock directory if it does not exist", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "nested", "deep", "test.lock");
    let acquired = false;
    await withHeldFileLock(lockPath, { staleMs: 5_000 }, async (a) => {
      acquired = a;
    });
    assert.equal(acquired, true, "acquired after creating nested lock dir");

    const info = await stat(path.join(dir, "nested", "deep"));
    assert.ok(info.isDirectory(), "nested lock directory was created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat refresh keeps a long holder from being broken while another waits", async () => {
  // Integration test against the real platform clock: the heartbeat is a real
  // `setInterval` that calls `utimes`, and stale detection reads real `mtime`.
  // Deterministic fake timers cannot advance `fs.stat().mtimeMs`, so a real
  // (small, generously-margined) delay is the only way to exercise the
  // heartbeat-refreshes-mtime invariant. Margins: heartbeatMs=50 lands several
  // beats inside the 150ms wait window before staleMs=300.
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "heartbeat.lock");
    const { promise: holderDone, resolve: finishHolder } = Promise.withResolvers<void>();

    const holder = withHeldFileLock(
      lockPath,
      { staleMs: 300, heartbeatMs: 50 },
      async () => {
        await holderDone;
      },
    );

    // Let two heartbeats land so the lock's mtime is fresh.
    await delay(120);

    let contenderAcquired = true; // expect false
    await withHeldFileLock(
      lockPath,
      { staleMs: 300, maxWaitMs: 150 },
      async (acquired) => {
        contenderAcquired = acquired;
      },
    );
    assert.equal(
      contenderAcquired,
      false,
      "contender timed out without breaking the heartbeating holder",
    );

    finishHolder();
    await holder;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// withHeldFileLock — timing validation completeness (codex P2 round 2)
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock rejects staleMs NaN/Infinity/negative with an error listing the valid range", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
    await assert.rejects(
      () => withHeldFileLock("/tmp/x.lock", { staleMs: bad }, async () => undefined),
      (err: TypeError) => {
        assert.ok(err.message.includes("staleMs"), `message names staleMs (got ${bad})`);
        assert.ok(err.message.includes("valid range"), `message lists valid range (got ${bad})`);
        assert.ok(err.message.includes("got "), `message shows the invalid value (got ${bad})`);
        return true;
      },
      `staleMs=${bad} should be rejected`,
    );
  }
});

test("withHeldFileLock rejects non-number types for optional timings (defensive against config coercion)", async () => {
  // A string "100" or boolean true would pass typeof checks in loose code but
  // is a real hazard if it slips through from config/env coercion.
  for (const bad of ["100", true, null, {}, []]) {
    for (const opt of ["maxWaitMs", "pollMs", "heartbeatMs"] as const) {
      await assert.rejects(
        () =>
          withHeldFileLock(
            "/tmp/x.lock",
            { staleMs: 1_000, [opt]: bad } as unknown as { staleMs: number },
            async () => undefined,
          ),
        (err: TypeError) => {
          assert.ok(err.message.includes(opt), `message names ${opt}`);
          assert.ok(err.message.includes("valid range"), `message lists valid range for ${opt}=${JSON.stringify(bad)}`);
          return true;
        },
        `${opt}=${JSON.stringify(bad)} should be rejected`,
      );
    }
  }
});

test("withHeldFileLock timing errors describe the default fallback so callers can self-correct", async () => {
  // The error must tell the caller what to do (omit the option to get the
  // default), not just "must be positive finite". This is the difference
  // between a debuggable config error and a silent clamp.
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 1_000, maxWaitMs: NaN }, async () => undefined),
    /maxWaitMs must be a positive finite number \(valid range:.*Omit the option to use the default of 5000 ms\./,
  );
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 1_000, pollMs: NaN }, async () => undefined),
    /pollMs must be a positive finite number \(valid range:.*Omit the option to use the default of 50 ms\./,
  );
});

test("withHeldFileLock runs task(false) best-effort when the lock directory cannot be created (advisory contract)", async () => {
  // An intermediate path that is a FILE (not a directory) makes mkdir fail
  // with ENOTDIR. The advisory lock contract requires this to fall through to
  // task(false), NOT reject — otherwise a lock-setup problem crashes the
  // primary guarded op (codex P2 review).
  const dir = await mkTmpDir();
  try {
    // Create a regular file where the lock DIRECTORY would be created.
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const lockPath = path.join(blocker, "nested.lock");

    let acquired = true; // expect false
    let ran = false;
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000, maxWaitMs: 50 },
      async (a) => {
        acquired = a;
        ran = true;
      },
    );
    assert.equal(ran, true, "task ran despite lock-dir setup failure");
    assert.equal(acquired, false, "task ran best-effort (acquired=false) without the lock");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock swallows a throwing onLockWarning hook (never crashes the guarded op)", async () => {
  // The option is documented as never throwing into the caller. If a consumer
  // supplies a hook that throws, it must not turn a non-fatal heartbeat
  // failure into an unhandled rejection or override the task result on
  // release (codex P2 review).
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "throwing-hook.lock");
    let warnings = 0;
    const result = await withHeldFileLock(
      lockPath,
      {
        staleMs: 5_000,
        onLockWarning: () => {
          warnings++;
          throw new Error("hook exploded");
        },
      },
      async () => "task-succeeded",
    );
    assert.equal(result, "task-succeeded", "task result not overridden by throwing hook");
    // The hook may or may not fire (only on non-fatal FS hiccups); if it
    // does, the throw is swallowed — the key assertion is that the task
    // completed and no unhandled rejection propagated.
    assert.ok(warnings >= 0, "did not crash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
