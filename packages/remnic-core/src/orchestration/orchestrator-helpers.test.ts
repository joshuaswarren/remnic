import assert from "node:assert/strict";
import test from "node:test";

import {
  qmdStartupCollectionCheckWithTimeout,
  type SearchCollectionState,
} from "./orchestrator-helpers.js";
import {
  qmdStartupCollectionChecksWithTimeout,
  startupDiscoveryWithTimeout,
} from "./startup-collection-checks.js";

test("individual startup collection check aborts and returns unknown when it never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const neverSettles = new Promise<SearchCollectionState>(() => undefined);

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";

    const pending = qmdStartupCollectionCheckWithTimeout(
      neverSettles,
      controller,
      "default",
    );
    t.mock.timers.tick(1000);
    const state = await pending;

    assert.equal(state, "unknown");
    assert.equal(controller.signal.aborted, true);
  } finally {
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
  }
});

test("startup collection batch falls back to configured namespaces when checks never settle", async () => {
  const neverSettles = new Promise<{ namespace: string; state: SearchCollectionState }>(() => undefined);

  const states = await qmdStartupCollectionChecksWithTimeout(
    [neverSettles],
    ["default", "configured"],
    1,
  );

  assert.deepEqual(states, [
    { namespace: "default", state: "unknown" },
    { namespace: "configured", state: "unknown" },
  ]);
});

test("startup collection batch preserves settled collection states", async () => {
  const states = await qmdStartupCollectionChecksWithTimeout(
    [Promise.resolve({ namespace: "catalog-only", state: "present" as const })],
    ["default"],
    50,
  );

  assert.deepEqual(states, [{ namespace: "catalog-only", state: "present" }]);
});

test("startup collection batch preserves settled states when other checks time out", async () => {
  const neverSettles = new Promise<{ namespace: string; state: SearchCollectionState }>(() => undefined);
  const states = await qmdStartupCollectionChecksWithTimeout(
    [
      Promise.resolve({ namespace: "default", state: "missing" as const }),
      neverSettles,
    ],
    ["default", "dynamic"],
    1,
  );

  assert.deepEqual(states, [
    { namespace: "default", state: "missing" },
    { namespace: "dynamic", state: "unknown" },
  ]);
});

test("generic startup discovery falls back without assuming QMD namespaces", async () => {
  const discovery = await startupDiscoveryWithTimeout(
    () => new Promise<{ records: string[] }>(() => undefined),
    { records: ["configured"] },
    1,
  );

  assert.deepEqual(discovery, {
    value: { records: ["configured"] },
    complete: false,
  });
});

test("generic startup discovery preserves a complete dynamic namespace set", async () => {
  const discovery = await startupDiscoveryWithTimeout(
    async () => ["default", "catalog-only"],
    ["default"],
    50,
  );

  assert.deepEqual(discovery, {
    value: ["default", "catalog-only"],
    complete: true,
  });
});
