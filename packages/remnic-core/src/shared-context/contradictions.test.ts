import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectContradictionPair,
  type SharedClaimItem,
} from "./contradictions.js";

test("detectContradictionPair returns same for identical ids", () => {
  const a: SharedClaimItem = { id: "item-1", claims: { host: "alpha" } };
  const b: SharedClaimItem = { id: "item-1", claims: { host: "beta" } };

  assert.deepEqual(detectContradictionPair(a, b), { kind: "same" });
});

test("detectContradictionPair returns conflict with the unequal overlapping keys", () => {
  const a: SharedClaimItem = {
    id: "item-1",
    claims: { tier: "high", host: "alpha", region: "us" },
  };
  const b: SharedClaimItem = {
    id: "item-2",
    claims: { tier: "high", host: "beta", owner: "ops" },
  };

  assert.deepEqual(detectContradictionPair(a, b), {
    kind: "conflict",
    keys: ["host"],
  });
});

test("detectContradictionPair returns none when overlap is absent or equal", () => {
  const disjoint: SharedClaimItem = { id: "item-1", claims: { host: "alpha" } };
  const other: SharedClaimItem = { id: "item-2", claims: { owner: "ops" } };
  const agreeing: SharedClaimItem = { id: "item-3", claims: { host: "alpha" } };

  assert.deepEqual(detectContradictionPair(disjoint, other), { kind: "none" });
  assert.deepEqual(detectContradictionPair(disjoint, agreeing), { kind: "none" });
});
