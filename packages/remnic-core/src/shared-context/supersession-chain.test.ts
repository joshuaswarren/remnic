import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SUPERSESSION_DEPTH,
  resolveSupersessionHead,
  type SupersessionItem,
} from "./supersession-chain.js";

const link = (id: string, supersedes?: string): SupersessionItem =>
  supersedes === undefined ? { id } : { id, supersedes };

test("single item resolves to itself", () => {
  assert.deepEqual(resolveSupersessionHead({ items: [link("a")], startId: "a" }), {
    ok: true,
    headId: "a",
    chain: ["a"],
  });
});

test("3-link chain resolves to the newest head with the full chain", () => {
  const items = [link("a"), link("b", "a"), link("c", "b")];
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a" }), {
    ok: true,
    headId: "c",
    chain: ["a", "b", "c"],
  });
});

test("2-cycle returns cycle_detected without hanging", () => {
  const items = [link("a", "b"), link("b", "a")];
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a" }), {
    ok: false,
    error: "cycle_detected",
    chain: ["a", "b"],
  });
});

test("longer cycle is also detected", () => {
  // b supersedes a, c supersedes b, a supersedes c.
  const items = [link("a", "c"), link("b", "a"), link("c", "b")];
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a" }), {
    ok: false,
    error: "cycle_detected",
    chain: ["a", "b", "c"],
  });
});

test("depth_exceeded with a small maxDepth", () => {
  const items = [link("a"), link("b", "a"), link("c", "b"), link("d", "c")];
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a", maxDepth: 2 }), {
    ok: false,
    error: "depth_exceeded",
    chain: ["a", "b"],
  });
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a", maxDepth: 1 }), {
    ok: false,
    error: "depth_exceeded",
    chain: ["a"],
  });
  // A chain exactly maxDepth ids long still resolves.
  assert.deepEqual(resolveSupersessionHead({ items, startId: "b", maxDepth: 3 }), {
    ok: true,
    headId: "d",
    chain: ["b", "c", "d"],
  });
});

test("default depth is MAX_SUPERSESSION_DEPTH", () => {
  assert.equal(MAX_SUPERSESSION_DEPTH, 32);
  const items: SupersessionItem[] = [link("i0")];
  for (let i = 1; i <= 60; i++) items.push(link(`i${i}`, `i${i - 1}`));
  assert.deepEqual(resolveSupersessionHead({ items, startId: "i0" }), {
    ok: false,
    error: "depth_exceeded",
    chain: Array.from({ length: MAX_SUPERSESSION_DEPTH }, (_, i) => `i${i}`),
  });
});

test("unknown startId returns unknown_id with an empty chain", () => {
  assert.deepEqual(resolveSupersessionHead({ items: [link("a")], startId: "zzz" }), {
    ok: false,
    error: "unknown_id",
    chain: [],
  });
});

test("empty and whitespace-only startId return unknown_id", () => {
  const items = [link("a")];
  for (const startId of ["", "   "]) {
    assert.deepEqual(resolveSupersessionHead({ items, startId }), {
      ok: false,
      error: "unknown_id",
      chain: [],
    });
  }
});

test("startId is trimmed on the happy path", () => {
  const items = [link("a"), link("b", "a")];
  assert.deepEqual(resolveSupersessionHead({ items, startId: "  a  " }), {
    ok: true,
    headId: "b",
    chain: ["a", "b"],
  });
});

test("maxDepth 0, negative, and float throw RangeError naming maxDepth", () => {
  const items = [link("a")];
  for (const bad of [0, -1, -32, 2.5, Number.NaN]) {
    assert.throws(
      () => resolveSupersessionHead({ items, startId: "a", maxDepth: bad }),
      (err: unknown) =>
        err instanceof RangeError && /maxDepth/.test(String(err.message)),
    );
  }
});

test("fork resolves to the smallest successor id, stable across shuffles", () => {
  // Both b and c supersede a; b < c, so b wins even though c appears first.
  const ordered = [link("a"), link("c", "a"), link("b", "a"), link("d", "b")];
  const shuffled = [link("d", "b"), link("b", "a"), link("a"), link("c", "a")];
  const expected = { ok: true, headId: "d", chain: ["a", "b", "d"] };
  assert.deepEqual(resolveSupersessionHead({ items: ordered, startId: "a" }), expected);
  assert.deepEqual(resolveSupersessionHead({ items: shuffled, startId: "a" }), expected);
  // Same shuffled input twice: identical results.
  assert.deepEqual(resolveSupersessionHead({ items: shuffled, startId: "a" }), expected);
});

test("blank-id items are ignored", () => {
  const items: SupersessionItem[] = [
    link("a"),
    link("b", "a"),
    { id: "", supersedes: "b" },
    { id: "   ", supersedes: "b" },
    { supersedes: "b" } as unknown as SupersessionItem,
    link("z", "   "),
  ];
  // The blank-id items must not make themselves successors of b.
  assert.deepEqual(resolveSupersessionHead({ items, startId: "a" }), {
    ok: true,
    headId: "b",
    chain: ["a", "b"],
  });
  // z has a blank supersedes pointer: it supersedes nothing.
  assert.deepEqual(resolveSupersessionHead({ items, startId: "z" }), {
    ok: true,
    headId: "z",
    chain: ["z"],
  });
});

test("input is not mutated", () => {
  const items = [link("c", "b"), link("a"), link("b", "a")];
  const snapshot = structuredClone(items);
  resolveSupersessionHead({ items, startId: "a" });
  assert.deepEqual(items, snapshot);
});
