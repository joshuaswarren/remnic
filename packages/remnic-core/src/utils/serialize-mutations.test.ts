//
//
// NOTE on real timers: the serializeMutations tests below use NO wall-clock

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MutationSerializer,
  serializeMutations,
  withHeldFileLock,
} from "./serialize-mutations.js";

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function mkTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "remnic-serialize-mutations-"));
}

async function microtick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function naivePoisonChain<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = naivePoisonMap.get(key) ?? Promise.resolve();
  const next = prior.then(task);
  naivePoisonMap.set(key, next);
  return next;
}
const naivePoisonMap = new Map<string, Promise<unknown>>();

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

test("serializeMutations runs same-key tasks in submission order", async () => {
  const s = new MutationSerializer();
  const order: string[] = [];
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
// ─────────────────────────────────────────────────────────────────────────────

test("PROVE-FAIL: a naive bare-.then(fn) chain is poisoned by the first rejection", async () => {
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
  await assert.rejects(() => a, /A failed/);
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
// ─────────────────────────────────────────────────────────────────────────────

test("serializeMutations deletes the per-key entry after the last task settles", async () => {
  const s = new MutationSerializer();
  assert.equal(s.pendingKeysForTest(), 0, "starts empty");

  await s.serialize("k", async () => 1);
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

  assert.equal(s.pendingKeysForTest(), 1, "entry present while tasks are in flight");
  release();
  await Promise.all([a, b]);
  await microtick();
  assert.equal(s.pendingKeysForTest(), 0, "entry removed after the chain drains");
});

test("serializeMutations does not accumulate entries across many sequential tasks", async () => {
  const s = new MutationSerializer();
  for (let i = 0; i < 50; i++) {
    await s.serialize("hot", async () => i);
  }
  await microtick();
  assert.equal(s.pendingKeysForTest(), 0, "no leftover entries after sequential drains");
});

// ─────────────────────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock runs the task with acquired=true and removes the lock on completion", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "test.lock");
    let observedAcquired = false;
    const result = await withHeldFileLock(lockPath, { staleMs: 5_000 }, async (acquired) => {
      observedAcquired = acquired;
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
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock breaks a genuinely stale lock and acquires (baseline)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "stale.lock");
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
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock invokes task(false) when a busy lock cannot be acquired in time", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "busy.lock");
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
// ─────────────────────────────────────────────────────────────────────────────

test("withHeldFileLock does not unlink a replacement lock on release (ownership-checked)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "release-race.lock");
    let ourOwnerId = "";

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

test("release does NOT rename a replacement lock out of lockPath (pre-check, codex P2)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "release-precheck.lock");
    const replacementOwner = "replacement-deadbeef-0000-4000-8000-000000000001";
    const contenderOwner = "contender-cafebabe-0000-4000-8000-000000000002";
    let seamFired = false;

    await withHeldFileLock(
      lockPath,
      {
        staleMs: 5_000,
        onAfterReleaseRenameForTest: async () => {
          seamFired = true;
          const contender = `${888888} ${contenderOwner} ${new Date().toISOString()}\n`;
          await writeFile(lockPath, contender, "utf8");
          await utimes(lockPath, new Date(), new Date());
        },
      },
      async () => {
        const replacement = `${777777} ${replacementOwner} ${new Date().toISOString()}\n`;
        await writeFile(lockPath, replacement, "utf8");
        await utimes(lockPath, new Date(), new Date());
      },
    );

    assert.equal(seamFired, false, "pre-check returned before rename — seam never fired");

    const after = await readFile(lockPath, "utf8");
    assert.ok(
      after.includes(replacementOwner),
      "replacement lock remains at lockPath after our release",
    );

    const entries = await readdir(dir);
    const trashFiles = entries.filter((e) => e.includes(".releasing."));
    assert.deepEqual(
      trashFiles,
      [],
      "no release trash file created — replacement was never renamed out of lockPath",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
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

test("withHeldFileLock rejects timer-backed options above Node's setTimeout ceiling (codex P2)", async () => {
  const over = 3_000_000_000; // > 2^31 − 1 (2_147_483_647)
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 5_000, pollMs: over }, async () => undefined),
    /pollMs .* exceeds the .* ceiling/,
    "pollMs above the timer ceiling should be rejected",
  );
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 5_000, heartbeatMs: over }, async () => undefined),
    /heartbeatMs .* exceeds the .* ceiling/,
    "heartbeatMs above the timer ceiling should be rejected",
  );
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: 5_000, maxWaitMs: over }, async () => undefined),
    /maxWaitMs .* exceeds the .* ceiling/,
    "maxWaitMs above the timer ceiling should be rejected",
  );
});

test("withHeldFileLock rejects a derived heartbeatMs that exceeds the timer ceiling", async () => {
  const hugeStale = 7_000_000_000; // floor(/3) = 2_333_333_333 > 2_147_483_647
  await assert.rejects(
    () => withHeldFileLock("/tmp/x.lock", { staleMs: hugeStale }, async () => undefined),
    /derived heartbeatMs .* exceeds Node's setTimeout ceiling/,
    "derived heartbeatMs above the timer ceiling should be rejected",
  );
});

test("withHeldFileLock accepts a finite positive maxWaitMs that bounds acquisition", async () => {
  const dir = await mkTmpDir();
  try {
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

test("acquire caps the poll sleep to the remaining maxWaitMs budget (codex P2)", async () => {
  // When pollMs > remaining budget, the sleep must be capped so acquisition
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "large-poll.lock");
    const fresh = `${888888} 11111111-1111-4000-8000-111111111111 ${new Date().toISOString()}\n`;
    await writeFile(lockPath, fresh, "utf8");
    await utimes(lockPath, new Date(), new Date());

    const maxWaitMs = 200;
    const pollMs = 60_000; // would block ~60s without the cap
    const start = Date.now();
    let observedAcquired = true; // expect false
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000, maxWaitMs, pollMs },
      async (acquired) => {
        observedAcquired = acquired;
      },
    );
    const elapsed = Date.now() - start;
    assert.equal(observedAcquired, false, "timed out without acquiring");
    assert.ok(
      elapsed < 5_000,
      `acquire respected the maxWaitMs budget despite large pollMs (elapsed=${elapsed}ms; expected < 5000ms)`,
    );
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
  const dir = await mkTmpDir();
  try {
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const lockPath = path.join(blocker, "nested.lock");

    let acquired = true; // expect false
    let failure: "timeout" | "error" | undefined;
    let ran = false;
    await withHeldFileLock(
      lockPath,
      { staleMs: 5_000, maxWaitMs: 50 },
      async (a, lock) => {
        acquired = a;
        failure = lock.failure;
        ran = true;
      },
    );
    assert.equal(ran, true, "task ran despite lock-dir setup failure");
    assert.equal(acquired, false, "task ran best-effort (acquired=false) without the lock");
    assert.equal(failure, "error", "lock setup failures must be distinguishable from contention timeouts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withHeldFileLock swallows a throwing onLockWarning hook (never crashes the guarded op)", async () => {
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
    assert.ok(warnings >= 0, "did not crash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat does NOT refresh a REPLACEMENT lock's mtime (ownership check, codex P2)", async () => {
  //
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "replaced.lock");
    const { promise: holderDone, resolve: finishHolder } = Promise.withResolvers<void>();

    const holder = withHeldFileLock(
      lockPath,
      { staleMs: 60_000, heartbeatMs: 30 },
      async () => {
        await holderDone;
      },
    );

    await delay(80);

    const replacement = `${999999} deadbeef-0000-4000-8000-000000000000 ${new Date().toISOString()}\n`;
    const replacementTime = new Date(Date.now() - 5_000); // 5s ago
    await writeFile(lockPath, replacement, "utf8");
    await utimes(lockPath, replacementTime, replacementTime);

    await delay(150);

    const info = await stat(lockPath);
    const ageAfterHeartbeats = Date.now() - info.mtimeMs;
    assert.ok(
      ageAfterHeartbeats > 4_000,
      `replacement lock mtime was NOT refreshed by stale heartbeat (age=${ageAfterHeartbeats}ms; expected >4000ms)`,
    );

    finishHolder();
    await holder;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("held-lock controller.refresh() re-stamps the mtime and reports still-held (#1910/#2033)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "refresh-held.lock");
    let held: boolean | undefined;
    let bumped = false;
    await withHeldFileLock(
      lockPath,
      { staleMs: 60_000, heartbeatMs: 30_000 },
      async (acquired, lock) => {
        assert.equal(acquired, true, "test holder acquires the lock");
        const before = (await stat(lockPath)).mtimeMs;
        await delay(50); // let the clock advance so a bump is observable
        held = await lock.refresh();
        bumped = (await stat(lockPath)).mtimeMs > before;
      },
    );
    assert.equal(held, true, "refresh reports the lock still held");
    assert.ok(bumped, "refresh re-stamped the lock mtime");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("held-lock controller.refresh() reports LOST and never stamps a peer replacement lock (#1910/#2033)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "refresh-lost.lock");
    let held: boolean | undefined;
    let ageAfter = 0;
    await withHeldFileLock(
      lockPath,
      { staleMs: 60_000, heartbeatMs: 30_000 },
      async (acquired, lock) => {
        assert.equal(acquired, true, "test holder acquires the lock");
        const replacement = `999999 deadbeef-0000-4000-8000-000000000000 ${new Date().toISOString()}\n`;
        const old = new Date(Date.now() - 5_000);
        await writeFile(lockPath, replacement, "utf8");
        await utimes(lockPath, old, old);
        held = await lock.refresh();
        ageAfter = Date.now() - (await stat(lockPath)).mtimeMs;
      },
    );
    assert.equal(held, false, "refresh reports the lock lost to a peer replacement");
    assert.ok(
      ageAfter > 4_000,
      `replacement lock mtime NOT bumped by refresh (age=${ageAfter}ms; expected >4000ms)`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("held-lock controller.refresh() reports LOST when the mtime bump fails (#2033)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "refresh-utimes-fail.lock");
    let held: boolean | undefined;
    let warned = false;
    await withHeldFileLock(
      lockPath,
      {
        staleMs: 60_000,
        heartbeatMs: 30_000,
        onLockWarning: () => { warned = true; },
        onBeforeRefreshUtimesForTest: async () => { await rm(lockPath, { force: true }); },
      },
      async (acquired, lock) => {
        assert.equal(acquired, true, "test holder acquires the lock");
        held = await lock.refresh();
      },
    );
    assert.equal(held, false, "refresh reports LOST when the mtime bump throws");
    assert.equal(warned, true, "the bump failure is surfaced via the warning hook");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("held-lock controller.refresh() reports LOST when a peer replaces the lock between the check and the bump (#2033)", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "refresh-replaced-midbump.lock");
    let held: boolean | undefined;
    const replacement = `999999 deadbeef-0000-4000-8000-000000000000 ${new Date().toISOString()}\n`;
    await withHeldFileLock(
      lockPath,
      {
        staleMs: 60_000,
        heartbeatMs: 30_000,
        onBeforeRefreshUtimesForTest: async () => { await writeFile(lockPath, replacement, "utf8"); },
      },
      async (acquired, lock) => {
        assert.equal(acquired, true, "test holder acquires the lock");
        held = await lock.refresh();
      },
    );
    assert.equal(held, false, "refresh reports LOST when a peer replaces the lock mid-bump");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("breakStaleLock uses atomic rename so a replacement lock is never unlinked by a second contender", async () => {
  //
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "race.lock");
    const staleOwner = "stale-aaaa-bbbb-cccc-dddd00000001";
    const staleTime = new Date(Date.now() - 10_000);
    await writeFile(lockPath, `${111111} ${staleOwner} ${staleTime.toISOString()}\n`, "utf8");
    await utimes(lockPath, staleTime, staleTime);

    let acquired = false;
    const result = await withHeldFileLock(
      lockPath,
      { staleMs: 1_000 },
      async (a) => {
        acquired = a;
        return "ok";
      },
    );
    assert.equal(acquired, true, "acquired after breaking the stale lock");
    assert.equal(result, "ok");

    await assert.rejects(() => stat(lockPath), /ENOENT/);

    const entries = await readdir(dir);
    const trashFiles = entries.filter((f) => f.includes(".breaking."));
    assert.equal(trashFiles.length, 0, `no trash files left behind (found: ${trashFiles.join(", ")})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("breakStaleLock restores a replacement lock if the rename accidentally moves it", async () => {
  const dir = await mkTmpDir();
  try {
    const lockPath = path.join(dir, "restore.lock");
    const staleOwner = "stale-aaaa-bbbb-cccc-dddd00000002";
    const staleTime = new Date(Date.now() - 10_000);
    const staleContent = `${222222} ${staleOwner} ${staleTime.toISOString()}\n`;
    await writeFile(lockPath, staleContent, "utf8");
    await utimes(lockPath, staleTime, staleTime);

    const freshOwner = "fresh-eeee-ffff-gggg-hhhh00000003";
    const replacementContent = `${333333} ${freshOwner} ${new Date().toISOString()}\n`;
    let result: string | undefined;
    await withHeldFileLock(
      lockPath,
      {
        staleMs: 1_000,
        onBeforeBreakStaleUnlinkForTest: () => {
          return writeFile(lockPath, replacementContent, "utf8").then(() =>
            utimes(lockPath, new Date(), new Date()),
          );
        },
      },
      async (a) => {
        result = a ? "acquired" : "best-effort";
      },
    );

    //
    const entries = await readdir(dir);
    const trashFiles = entries.filter((f) => f.includes(".breaking."));
    assert.equal(trashFiles.length, 0, `no trash files left behind (found: ${trashFiles.join(", ")})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
