import assert from "node:assert/strict";
/**
 * mergeTurns identity comparison — issue: the claim-merge hot path
 * (buffer-drain-claims.ts `mergeIntoClaim`) deduped incoming turns with
 * `merged.some(isEqual)`: O(existing × incoming) per observe while a claim
 * only grows during a stalled drain. The identity comparison now goes
 * through a Set of identity keys built from the exact `bufferTurnsEqual`
 * fields, so the merge is O(n + m) with byte-identical merge semantics:
 * dedupe identical turns (including duplicates within `incoming`), append
 * genuinely-new turns in arrival order, existing entries always win.
 *
 * The identity key must be injective over `bufferTurnsEqual` equality
 * classes — including the undefined-vs-null distinctions on optional fields
 * (`providerThreadId`) and the plan-identity triple (#3251).
 */
import test from "node:test";

import { bufferTurnIdentityKey, bufferTurnsEqual, mergeBufferTurnsByIdentity } from "./buffer-turn-helpers.js";
import type { ScopeProfileLayerResolution } from "./namespaces/scope-profiles.js";
import type { BufferTurn } from "./types.js";

function turn(overrides: Partial<BufferTurn> & { content: string }): BufferTurn {
  return { role: "user", timestamp: "2026-11-01T00:00:00.000Z", ...overrides };
}

test("bufferTurnIdentityKey matches bufferTurnsEqual exactly (same key ⇔ equal)", () => {
  const base = turn({ content: "hello", sessionKey: "s1" });
  const same = turn({ content: "hello", sessionKey: "s1" });
  const different = [
    turn({ content: "hello", sessionKey: "s2" }),
    turn({ content: "world", sessionKey: "s1" }),
    turn({ content: "hello", sessionKey: "s1", role: "assistant" as const }),
    turn({ content: "hello", sessionKey: "s1", timestamp: "2026-11-02T00:00:00.000Z" }),
    turn({ content: "hello", sessionKey: "s1", providerThreadId: null }),
    turn({ content: "hello", sessionKey: "s1", providerThreadId: "t1" }),
    turn({ content: "hello", sessionKey: "s1", turnFingerprint: "fp" }),
    turn({ content: "hello", sessionKey: "s1", persistProcessedFingerprint: true }),
    turn({ content: "hello", sessionKey: "s1", persistProcessedFingerprint: false }),
    turn({ content: "hello", sessionKey: "s1", sourceConnector: "cli" }),
    turn({ content: "hello", sessionKey: "s1", originRole: "user" as const }),
    turn({ content: "hello", sessionKey: "s1", ambientCapture: true }),
    turn({ content: "hello", sessionKey: "s1", ambientCapture: false }),
    turn({ content: "hello", sessionKey: "s1", sourceValidAt: "2026-01-01T00:00:00.000Z" }),
    turn({ content: "hello", sessionKey: "s1", acceptedCapture: true }),
    turn({ content: "hello", sessionKey: "s1", acceptedCapture: false }),
    turn({ content: "hello", sessionKey: "s1", writeNamespaceOverride: "ns" }),
    turn({ content: "hello", sessionKey: "s1", principalOverride: "p1" }),
    turn({
      content: "hello",
      sessionKey: "s1",
      codingContext: { projectId: "proj", branch: "main", rootPath: "/r", defaultBranch: "main" },
    }),
    turn({
      content: "hello",
      sessionKey: "s1",
      codingContext: { projectId: "proj", branch: "dev", rootPath: "/r", defaultBranch: "main" },
    }),
  ];

  assert.equal(bufferTurnIdentityKey(base), bufferTurnIdentityKey(same));
  assert.equal(bufferTurnsEqual(base, same), true);
  for (const other of different) {
    assert.notEqual(
      bufferTurnIdentityKey(base),
      bufferTurnIdentityKey(other),
      `key must differ for ${JSON.stringify(other)}`
    );
    assert.equal(bufferTurnsEqual(base, other), false);
  }
});

test("bufferTurnIdentityKey: undefined and null providerThreadId are distinct classes", () => {
  const absent = turn({ content: "x" });
  const explicitNull = turn({ content: "x", providerThreadId: null });
  const present = turn({ content: "x", providerThreadId: "t" });
  const keys = new Set([
    bufferTurnIdentityKey(absent),
    bufferTurnIdentityKey(explicitNull),
    bufferTurnIdentityKey(present),
  ]);
  assert.equal(keys.size, 3);
  assert.equal(bufferTurnsEqual(absent, explicitNull), false);
  assert.equal(bufferTurnsEqual(absent, present), false);
});

test("bufferTurnIdentityKey: null and undefined scope plan share the empty identity (#3251)", () => {
  const noPlan = turn({ content: "x" });
  const nullPlan = turn({ content: "x", scopeProfileWritePlan: null });
  assert.equal(bufferTurnIdentityKey(noPlan), bufferTurnIdentityKey(nullPlan));
  assert.equal(bufferTurnsEqual(noPlan, nullPlan), true);
});

test("mergeBufferTurnsByIdentity appends genuinely-new turns in arrival order", () => {
  const existing = [turn({ content: "a" }), turn({ content: "b" })];
  const incoming = [turn({ content: "c" }), turn({ content: "d" })];
  const merged = mergeBufferTurnsByIdentity(existing, incoming);
  assert.deepEqual(
    merged.map((t) => t.content),
    ["a", "b", "c", "d"]
  );
});

test("mergeBufferTurnsByIdentity dedupes turns identical to an existing entry", () => {
  const existing = [turn({ content: "a" }), turn({ content: "b" })];
  const incoming = [turn({ content: "b" }), turn({ content: "c" })];
  const merged = mergeBufferTurnsByIdentity(existing, incoming);
  assert.deepEqual(
    merged.map((t) => t.content),
    ["a", "b", "c"]
  );
  // The kept entry is the EXISTING object, not the incoming copy.
  assert.equal(merged[1], existing[1]);
});

test("mergeBufferTurnsByIdentity dedupes duplicates within incoming (first wins)", () => {
  const existing: BufferTurn[] = [];
  const first = turn({ content: "dup" });
  const second = turn({ content: "dup" });
  const merged = mergeBufferTurnsByIdentity(existing, [first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0], first);
});

test("mergeBufferTurnsByIdentity keeps existing entries verbatim, duplicates included", () => {
  const dupA = turn({ content: "a" });
  const dupB = turn({ content: "a" });
  const existing = [dupA, dupB];
  const merged = mergeBufferTurnsByIdentity(existing, [turn({ content: "a" }), turn({ content: "b" })]);
  assert.equal(merged.length, 3, "existing duplicates are preserved; incoming duplicate dropped");
  assert.equal(merged[0], dupA);
  assert.equal(merged[1], dupB);
  assert.equal(merged[2].content, "b");
});

test("mergeBufferTurnsByIdentity keeps existing order and does not mutate inputs", () => {
  const existing = [turn({ content: "b" }), turn({ content: "a" })];
  const incoming = [turn({ content: "a" }), turn({ content: "c" })];
  const merged = mergeBufferTurnsByIdentity(existing, incoming);
  assert.deepEqual(
    merged.map((t) => t.content),
    ["b", "a", "c"]
  );
  assert.equal(existing.length, 2);
  assert.deepEqual(
    existing.map((t) => t.content),
    ["b", "a"]
  );
});

// Identity fields only: scopeProfilePlanIdentity reads profileId, writeLayer
// and writeNamespace; the remaining members are inert for identity tests.
function pinnedPlan(namespace: string): NonNullable<BufferTurn["scopeProfileWritePlan"]> {
  const layer: ScopeProfileLayerResolution = {
    id: "userProject",
    kind: "user-project",
    namespace,
    readable: true,
    writable: true,
    promotable: false,
    reason: "identity-test layer",
  };
  return {
    profileId: "p",
    profile: {
      readOrder: ["userProject"],
      writeDefault: "userProject",
      promotionTargets: [],
      autoPromote: { enabled: false, targets: [], categories: [], minConfidenceTier: "speculative" },
    },
    baseNamespace: namespace,
    writeLayer: "userProject",
    writeNamespace: namespace,
    readNamespaces: [namespace],
    layers: [layer],
    promotionTargets: [],
    warnings: [],
  };
}

test("mergeBufferTurnsByIdentity stays consistent with bufferTurnsEqual on scope-pinned turns", () => {
  const pinned = turn({
    content: "cap",
    acceptedCapture: true,
    writeNamespaceOverride: "ns-a",
    scopeProfileWritePlan: pinnedPlan("ns-a"),
  });
  const samePinned = turn({
    content: "cap",
    acceptedCapture: true,
    writeNamespaceOverride: "ns-a",
    scopeProfileWritePlan: pinnedPlan("ns-a"),
  });
  const otherPinned = turn({
    content: "cap",
    acceptedCapture: true,
    writeNamespaceOverride: "ns-b",
    scopeProfileWritePlan: pinnedPlan("ns-b"),
  });
  assert.equal(bufferTurnsEqual(pinned, samePinned), true);
  assert.equal(bufferTurnsEqual(pinned, otherPinned), false);
  const merged = mergeBufferTurnsByIdentity([pinned], [samePinned, otherPinned]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], pinned);
  assert.equal(merged[1], otherPinned);
});
