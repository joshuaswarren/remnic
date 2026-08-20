import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS,
  assertIdInNavigationWindow,
  type NavigationSnapshot,
} from "./recall-navigate-window.js";

const snap = (...servedIds: string[]): NavigationSnapshot => ({ servedIds });
const malformed = (value: unknown): NavigationSnapshot => value as NavigationSnapshot;

test("default window is 3 snapshots", () => {
  assert.equal(DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS, 3);
});

test("id in the newest snapshot is ok", () => {
  assert.deepEqual(
    assertIdInNavigationWindow({ snapshots: [snap("fact-1"), snap("fact-2")], memoryId: "fact-1" }),
    { ok: true, memoryId: "fact-1" },
  );
});

test("id in the 3rd snapshot is ok at the default window", () => {
  const snapshots = [snap("fact-a"), snap("fact-b"), snap("fact-c"), snap("fact-d")];
  assert.deepEqual(assertIdInNavigationWindow({ snapshots, memoryId: "fact-c" }), {
    ok: true,
    memoryId: "fact-c",
  });
});

test("id only in a 4th snapshot is not_served", () => {
  const snapshots = [snap("fact-a"), snap("fact-b"), snap("fact-c"), snap("fact-d")];
  assert.deepEqual(assertIdInNavigationWindow({ snapshots, memoryId: "fact-d" }), {
    ok: false,
    error: "not_served",
  });
});

test("windowSnapshots 1 rejects an id from the 2nd snapshot", () => {
  const snapshots = [snap("fact-a"), snap("fact-b")];
  assert.deepEqual(
    assertIdInNavigationWindow({ snapshots, memoryId: "fact-b", windowSnapshots: 1 }),
    { ok: false, error: "not_served" },
  );
});

test("windowSnapshots 0, negative, fractional, NaN, Infinity throw", () => {
  const snapshots = [snap("fact-a")];
  for (const windowSnapshots of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertIdInNavigationWindow({ snapshots, memoryId: "fact-a", windowSnapshots }),
      { name: "RangeError", message: /windowSnapshots/ },
    );
  }
});

test("non-string and whitespace ids are empty_id, never not_served", () => {
  const snapshots = [snap("fact-a")];
  for (const memoryId of [null, undefined, 42, {}, "", "   ", "\t\n"]) {
    assert.deepEqual(assertIdInNavigationWindow({ snapshots, memoryId }), {
      ok: false,
      error: "empty_id",
    });
  }
});

test("padded id matches after trim", () => {
  const snapshots = [snap("fact-1")];
  assert.deepEqual(assertIdInNavigationWindow({ snapshots, memoryId: "  fact-1 \t" }), {
    ok: true,
    memoryId: "fact-1",
  });
});

test("case-different id is not_served", () => {
  const snapshots = [snap("Fact-1")];
  assert.deepEqual(assertIdInNavigationWindow({ snapshots, memoryId: "fact-1" }), {
    ok: false,
    error: "not_served",
  });
});

test("empty snapshots list is not_served", () => {
  assert.deepEqual(assertIdInNavigationWindow({ snapshots: [], memoryId: "fact-1" }), {
    ok: false,
    error: "not_served",
  });
});

test("malformed snapshot consumes its window slot without throwing", () => {
  // Missing servedIds on the newest snapshot: it still burns the only
  // window slot, so the id served by the 2nd snapshot stays not_served.
  assert.doesNotThrow(() => {
    assert.deepEqual(
      assertIdInNavigationWindow({
        snapshots: [malformed({}), malformed({ servedIds: "fact-1" })],
        memoryId: "fact-1",
        windowSnapshots: 1,
      }),
      { ok: false, error: "not_served" },
    );
  });
});
