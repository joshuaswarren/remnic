import assert from "node:assert/strict";
import test from "node:test";

import { startEventLoopLagMonitor, type LagSample } from "./event-loop-lag.js";

function harness(samples: LagSample[]) {
  const warnings: string[] = [];
  let tick: (() => void) | undefined;
  const stop = startEventLoopLagMonitor({
    intervalMs: 30_000,
    warnP99Ms: 250,
    warnMaxMs: 1_000,
    sample: () => samples.shift() ?? { p99Ms: 0, maxMs: 0 },
    warn: (m) => warnings.push(m),
    schedule: (fn) => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
  });
  return { warnings, tick: () => tick?.(), stop, armed: () => tick !== undefined };
}

test("stays silent while the loop is healthy", () => {
  const h = harness([{ p99Ms: 20, maxMs: 80 }]);
  h.tick();
  assert.deepEqual(h.warnings, []);
});

test("warns with p99 and max when the loop stalls", () => {
  const h = harness([{ p99Ms: 400, maxMs: 2_300 }]);
  h.tick();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!, /event loop lag/);
  assert.match(h.warnings[0]!, /p99=400ms/);
  assert.match(h.warnings[0]!, /max=2300ms/);
});

test("a single long block warns even when p99 is low", () => {
  const h = harness([{ p99Ms: 10, maxMs: 1_500 }]);
  h.tick();
  assert.equal(h.warnings.length, 1);
});

test("stop disarms the timer", () => {
  const h = harness([]);
  assert.equal(h.armed(), true);
  h.stop();
  assert.equal(h.armed(), false);
});

test("aborting the signal stops the monitor, and an already-aborted signal never arms it", () => {
  let armed = false;
  const schedule = () => {
    armed = true;
    return () => {
      armed = false;
    };
  };
  const live = new AbortController();
  startEventLoopLagMonitor({ sample: () => ({ p99Ms: 0, maxMs: 0 }), schedule, signal: live.signal });
  assert.equal(armed, true);
  live.abort();
  assert.equal(armed, false);

  const done = new AbortController();
  done.abort();
  startEventLoopLagMonitor({ sample: () => ({ p99Ms: 0, maxMs: 0 }), schedule, signal: done.signal });
  assert.equal(armed, false);
});
