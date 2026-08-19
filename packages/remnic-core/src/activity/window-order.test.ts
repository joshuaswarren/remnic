import assert from "node:assert/strict";
import test from "node:test";

import { assertHalfOpenWindow } from "./window-order.js";

test("ordered window is ok", () => {
  assert.deepEqual(assertHalfOpenWindow({ fromMs: 0, toMs: 1 }), { ok: true });
});

test("equal bounds are empty_window", () => {
  assert.deepEqual(assertHalfOpenWindow({ fromMs: 10, toMs: 10 }), {
    ok: false,
    error: "empty_window",
  });
});

test("inverted bounds are empty_window", () => {
  assert.deepEqual(assertHalfOpenWindow({ fromMs: 20, toMs: 10 }), {
    ok: false,
    error: "empty_window",
  });
});

test("NaN bounds throw", () => {
  assert.throws(() => assertHalfOpenWindow({ fromMs: Number.NaN, toMs: 1 }), /finite/);
  assert.throws(() => assertHalfOpenWindow({ fromMs: 0, toMs: Number.NaN }), /finite/);
});
