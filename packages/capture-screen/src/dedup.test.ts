import assert from "node:assert/strict";
import { test } from "node:test";

import { DedupCache } from "./dedup.js";
import { simhash } from "./simhash.js";

const A = simhash("window content one two three four five six seven eight nine ten");
const A_NEAR = simhash("window content one two three four five six seven eight nine XYZ"); // 1-word edit → small
const B = simhash("completely unrelated payload about compilers linkers and assembly directives everywhere");

const t0 = Date.parse("2026-07-20T10:00:00.000Z");
const sec = (n: number) => t0 + n * 1000;

test("first snapshot of a window always stores", () => {
  const cache = new DedupCache(10, 60);
  assert.equal(cache.shouldStore("App", "Win", A, t0), true);
});

test("a near-identical snapshot within TTL is deduped (distance <= threshold)", () => {
  const cache = new DedupCache(10, 60);
  cache.shouldStore("App", "Win", A, t0);
  assert.equal(cache.shouldStore("App", "Win", A, sec(5)), false, "exact repeat");
  assert.equal(cache.shouldStore("App", "Win", A_NEAR, sec(10)), false, "near-duplicate");
});

test("a sufficiently different snapshot stores even within TTL", () => {
  const cache = new DedupCache(10, 60);
  cache.shouldStore("App", "Win", A, t0);
  assert.equal(cache.shouldStore("App", "Win", B, sec(5)), true);
});

test("TTL elapsed forces a refresh even for identical content", () => {
  const cache = new DedupCache(10, 60);
  cache.shouldStore("App", "Win", A, t0);
  assert.equal(cache.shouldStore("App", "Win", A, sec(59)), false, "before TTL");
  assert.equal(cache.shouldStore("App", "Win", A, sec(60)), true, "at TTL boundary");
});

test("distinct windows never dedup against each other", () => {
  const cache = new DedupCache(10, 60);
  assert.equal(cache.shouldStore("App", "Win1", A, t0), true);
  assert.equal(cache.shouldStore("App", "Win2", A, sec(1)), true, "same hash, different window");
  assert.equal(cache.shouldStore("Other", "Win1", A, sec(1)), true, "same window title, different app");
});

test("100 near-identical scroll states collapse to a handful of stored rows", () => {
  const cache = new DedupCache(10, 60);
  let stored = 0;
  for (let i = 0; i < 100; i++) {
    // A static reader window: the same visible text on every frame (pure scroll
    // captures the same content), one second apart. Only the TTL should refresh.
    const h = simhash("a long document whose visible text does not change while the user scrolls slowly");
    if (cache.shouldStore("Reader", "Doc", h, sec(i))) stored += 1;
  }
  assert.ok(stored <= 5, `expected <= 5 stored, got ${stored}`);
});

test("seed primes the last fingerprint so a restart does not re-store", () => {
  const cache = new DedupCache(10, 60);
  cache.seed("App", "Win", A, t0);
  assert.equal(cache.shouldStore("App", "Win", A, sec(5)), false);
});
