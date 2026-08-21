import assert from "node:assert/strict";
import test from "node:test";

import { refreshActivityIndex, type ActivityIndexRefresher } from "./reindex.js";

function refresher(overrides: Partial<ActivityIndexRefresher>, calls: string[]): ActivityIndexRefresher {
  return {
    async update() {
      calls.push("update");
    },
    ...overrides,
  };
}

test("refreshActivityIndex prefers the forced+strict collection refresh", async () => {
  const calls: string[] = [];
  const qmd = refresher(
    {
      async updateStrict() {
        calls.push("updateStrict");
      },
      async updateCollectionStrict(collection: string) {
        calls.push(`updateCollectionStrict:${collection}`);
      },
    },
    calls,
  );

  await refreshActivityIndex(qmd, "openclaw-engram");
  assert.deepEqual(calls, ["updateCollectionStrict:openclaw-engram"], "forces past the fail-open min-interval gate");
});

test("refreshActivityIndex falls back to updateStrict, then update", async () => {
  const strictCalls: string[] = [];
  await refreshActivityIndex(
    refresher(
      {
        async updateStrict() {
          strictCalls.push("updateStrict");
        },
      },
      strictCalls,
    ),
    "openclaw-engram",
  );
  assert.deepEqual(strictCalls, ["updateStrict"], "uses strict global refresh when no collection-strict path exists");

  const plainCalls: string[] = [];
  await refreshActivityIndex(refresher({}, plainCalls), "openclaw-engram");
  assert.deepEqual(plainCalls, ["update"], "falls back to plain update when no strict path exists");
});

test("refreshActivityIndex skips collection-strict for an empty collection name", async () => {
  const calls: string[] = [];
  await refreshActivityIndex(
    refresher(
      {
        async updateStrict() {
          calls.push("updateStrict");
        },
        async updateCollectionStrict(collection: string) {
          calls.push(`updateCollectionStrict:${collection}`);
        },
      },
      calls,
    ),
    "   ",
  );
  assert.deepEqual(calls, ["updateStrict"], "no collection -> strict global refresh, never a blank-collection call");
});

test("refreshActivityIndex propagates a strict-refresh failure (no fake success)", async () => {
  const calls: string[] = [];
  const qmd = refresher(
    {
      async updateCollectionStrict() {
        calls.push("updateCollectionStrict");
        throw new Error("QMD update skipped by per-collection failure backoff");
      },
    },
    calls,
  );
  await assert.rejects(refreshActivityIndex(qmd, "openclaw-engram"), /failure backoff/);
});

test("refreshActivityIndex forwards the abort signal to the backend refresh", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const qmd: ActivityIndexRefresher = {
    async update() {},
    async updateCollectionStrict(_collection, execution) {
      seenSignal = execution?.signal;
    },
  };
  await refreshActivityIndex(qmd, "openclaw-engram", controller.signal);
  assert.equal(seenSignal, controller.signal, "the tick's abort signal reaches the QMD refresh");
});
