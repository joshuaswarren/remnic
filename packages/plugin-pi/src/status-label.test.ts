import assert from "node:assert/strict";
import test from "node:test";

import { recheckOfflineUntilReachable } from "./status-label.js";

test("offline label re-probes with backoff and recovers exactly once", async () => {
  const sleeps: number[] = [];
  let probes = 0;
  let recovered = 0;
  await recheckOfflineUntilReachable(
    {
      probe: async () => (probes += 1) <= 2 ? "unreachable" : "ready",
      onRecovered: () => {
        recovered += 1;
      },
      isLive: () => true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(probes, 3);
  assert.equal(recovered, 1);
  assert.deepEqual(sleeps, [5000, 10000, 20000]);
});

test("re-probe stops when the session is gone and never recovers", async () => {
  let probes = 0;
  let recovered = 0;
  await recheckOfflineUntilReachable({
    probe: async () => {
      probes += 1;
      return "ready";
    },
    onRecovered: () => {
      recovered += 1;
    },
    isLive: () => false,
    sleep: async () => {},
  });
  assert.equal(probes, 0);
  assert.equal(recovered, 0);
});

test("probe errors count as unreachable and the backoff caps at max", async () => {
  const sleeps: number[] = [];
  let probes = 0;
  await recheckOfflineUntilReachable(
    {
      probe: async () => {
        probes += 1;
        if (probes < 5) throw new Error("daemon down");
        return "ready";
      },
      onRecovered: () => {},
      isLive: () => true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
    { initialDelayMs: 5000, maxDelayMs: 12000 },
  );
  assert.equal(probes, 5);
  assert.deepEqual(sleeps, [5000, 10000, 12000, 12000, 12000]);
});

test("'starting' keeps retrying without recovering", async () => {
  let probes = 0;
  let recovered = 0;
  await recheckOfflineUntilReachable({
    probe: async () => (probes += 1) <= 2 ? "starting" : "ready",
    onRecovered: () => {
      recovered += 1;
    },
    isLive: () => true,
    sleep: async () => {},
  });
  assert.equal(probes, 3);
  assert.equal(recovered, 1);
});

test("a throwing onRecovered is logged and does not reject the loop", async () => {
  const logged: unknown[] = [];
  await recheckOfflineUntilReachable({
    probe: async () => "ready",
    onRecovered: () => {
      throw new Error("label write failed");
    },
    isLive: () => true,
    sleep: async () => {},
    onError: (err) => {
      logged.push(err);
    },
  });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /label write failed/);
});

test("a rejecting sleep is logged and the loop stops", async () => {
  const logged: unknown[] = [];
  let probes = 0;
  await recheckOfflineUntilReachable({
    probe: async () => {
      probes += 1;
      return "ready";
    },
    onRecovered: () => {},
    isLive: () => true,
    sleep: async () => {
      throw new Error("timer failed");
    },
    onError: (err) => {
      logged.push(err);
    },
  });
  assert.equal(probes, 0);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /timer failed/);
});
