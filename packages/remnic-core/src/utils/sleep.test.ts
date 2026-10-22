import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "./sleep.js";

test("sleep preserves delays, stays referenced, and settles only when its timer fires", async (t) => {
  let fire: () => void = () => assert.fail("timer was not scheduled");
  const delays: number[] = [];
  const unref = t.mock.fn();
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    delays.push(ms);
    fire = callback;
    return { unref };
  });
  const clear = t.mock.method(globalThis, "clearTimeout", () => {});

  for (const ms of [0, 10, 25, 100, 250, 1_000]) {
    let settled = false;
    const waiting = sleep(ms).then((value) => {
      settled = true;
      assert.equal(value, undefined);
    });
    await Promise.resolve();
    assert.equal(settled, false, "sleep must not resolve before its timer");
    fire();
    await waiting;
    assert.equal(settled, true);
  }

  assert.deepEqual(delays, [0, 10, 25, 100, 250, 1_000]);
  assert.equal(unref.mock.callCount(), 0, "awaited poll timers must keep the process alive");
  assert.equal(clear.mock.callCount(), 0, "the non-cancellable helper must not cancel its timers");
});
