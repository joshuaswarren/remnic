import assert from "node:assert/strict";
import test from "node:test";

import { MS_PER_DAY } from "./privacy.js";
import { filterPrivacyWindow } from "./privacy-window.js";

function item(capturedAtMs: number, id = capturedAtMs) {
  return { id, capturedAtMs };
}

test("window is half-open [fromMs, toMs)", () => {
  const fromMs = 1_000;
  const toMs = 2_000;
  const kept = filterPrivacyWindow(
    [item(fromMs - 1), item(fromMs), item(toMs - 1), item(toMs)],
    { fromMs, toMs, retainDays: 0 },
  );
  assert.deepEqual(
    kept.map((entry) => entry.capturedAtMs),
    [fromMs, toMs - 1],
  );
});

test("retainDays 0 keeps all ages inside the window", () => {
  const toMs = 400 * MS_PER_DAY;
  const old = item(toMs - 390 * MS_PER_DAY, 1);
  const kept = filterPrivacyWindow([old], { fromMs: 0, toMs, retainDays: 0 });
  assert.deepEqual(kept, [old]);
});

test("retainDays N drops older than N days before toMs", () => {
  const toMs = 10 * MS_PER_DAY;
  const fromMs = 0;
  const cutoff = toMs - 3 * MS_PER_DAY;
  const kept = filterPrivacyWindow(
    [item(cutoff - 1, 1), item(cutoff, 2), item(cutoff + 1, 3), item(toMs - 1, 4)],
    { fromMs, toMs, retainDays: 3 },
  );
  assert.deepEqual(
    kept.map((entry) => entry.id),
    [3, 4],
  );
});

test("empty items or inverted window return []", () => {
  assert.deepEqual(filterPrivacyWindow([], { fromMs: 0, toMs: 10, retainDays: 0 }), []);
  assert.deepEqual(filterPrivacyWindow([item(5)], { fromMs: 10, toMs: 10, retainDays: 0 }), []);
  assert.deepEqual(filterPrivacyWindow([item(5)], { fromMs: 10, toMs: 0, retainDays: 0 }), []);
});
