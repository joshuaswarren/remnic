import assert from "node:assert/strict";
import test from "node:test";
import { drainPendingImpressionsForOfflineSync } from "./offline-sync-impression-drain.js";

test("retries deferred drains and succeeds when the lock is released", async () => {
  let calls = 0;
  await drainPendingImpressionsForOfflineSync(async () => {
    calls += 1;
    return { pendingDeferred: calls < 2 };
  });
  assert.equal(calls, 2);
});

test("retries a transient drain error before succeeding", async () => {
  let calls = 0;
  await drainPendingImpressionsForOfflineSync(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary lock failure");
    return { pendingDeferred: false };
  });
  assert.equal(calls, 2);
});

test("aborts after repeated deferrals instead of producing an incomplete snapshot", async () => {
  let calls = 0;
  await assert.rejects(
    drainPendingImpressionsForOfflineSync(async () => {
      calls += 1;
      return { pendingDeferred: true };
    }),
    /could not fold pending recall impressions after 3 attempts/,
  );
  assert.equal(calls, 3);
});
