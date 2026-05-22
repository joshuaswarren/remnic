import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyntheticTarget,
  SYNTHETIC_MEMORIES,
  runExtractionAttack,
  createSeededRng,
} from "./index.js";
import { createMitigatedTarget } from "./mitigated-target.js";
import { runMitigatedBaseline } from "./baseline.js";

test("createMitigatedTarget returns empty hits when budget is exceeded", async () => {
  // Memories in namespace "other" so cross-namespace queries retrieve actual
  // hits. Same-namespace queries (namespace "default") return empty from the
  // synthetic target's namespace filter, which is fine — the test only needs
  // to verify budget accounting, not recall result content.
  const testMemories = [
    { id: "tm-1", content: "alpha beta gamma", category: "fact", tokens: ["alpha", "beta", "gamma"], namespace: "other" },
    { id: "tm-2", content: "delta epsilon zeta", category: "fact", tokens: ["delta", "epsilon", "zeta"], namespace: "other" },
  ];
  const rawTarget = createSyntheticTarget({
    memories: testMemories,
    disclosesMemoryIds: true,
  });

  const mitigated = createMitigatedTarget({
    target: rawTarget,
    budgetHardLimit: 3,
    budgetWindowMs: 60_000,
    principalNamespace: "default",
  });

  // Same-namespace queries should not count against the budget.
  for (let i = 0; i < 5; i++) {
    const hits = await mitigated.recall("test", { namespace: "default" });
    assert.ok(Array.isArray(hits), `same-ns query ${i} should return array`);
  }

  // Cross-namespace queries should exhaust the budget and still return hits
  // (the raw target returns matches from namespace "other").
  for (let i = 0; i < 3; i++) {
    const hits = await mitigated.recall("alpha", { namespace: "other" });
    assert.ok(Array.isArray(hits), `cross-ns query ${i} should return array`);
    assert.ok(hits.length > 0, `cross-ns query ${i} should return non-empty hits before budget exhausted`);
  }

  // 4th cross-namespace query should be denied (empty hits from budget).
  const denied = await mitigated.recall("delta", { namespace: "other" });
  assert.equal(denied.length, 0, "should return empty after budget exhausted");
});

test("createMitigatedTarget treats missing namespace as budget-eligible (fail-closed)", async () => {
  const rawTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    disclosesMemoryIds: true,
  });

  const mitigated = createMitigatedTarget({
    target: rawTarget,
    budgetHardLimit: 1,
    budgetWindowMs: 60_000,
    principalNamespace: "default",
  });

  // Query with a token that actually exists in SYNTHETIC_MEMORIES so the
  // first recall returns non-empty hits — proving the raw target works.
  const firstHit = await mitigated.recall("Alex");
  assert.ok(Array.isArray(firstHit), "first query should return array");
  assert.ok(firstHit.length > 0, "first query should return at least one hit");

  // Second query without namespace should be denied — budget exhausted.
  const denied = await mitigated.recall("Alex");
  assert.equal(denied.length, 0, "should return empty after budget exhausted with no namespace");
});

test("createMitigatedTarget expires budget entries at the window boundary", async () => {
  const rawTarget = createSyntheticTarget({
    memories: [
      { id: "tm-boundary", content: "alpha beta gamma", category: "fact", tokens: ["alpha"], namespace: "other" },
    ],
    disclosesMemoryIds: true,
  });

  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;

  try {
    const mitigated = createMitigatedTarget({
      target: rawTarget,
      budgetHardLimit: 1,
      budgetWindowMs: 1_000,
      principalNamespace: "default",
    });

    const first = await mitigated.recall("alpha", { namespace: "other" });
    assert.ok(first.length > 0, "first cross-namespace query should be allowed");

    now = 1_000;
    const second = await mitigated.recall("alpha", { namespace: "other" });
    assert.ok(second.length > 0, "query at exactly the budget window boundary should be allowed");
  } finally {
    Date.now = originalNow;
  }
});

test("runMitigatedBaseline returns mitigated rows", async () => {
  const rows = await runMitigatedBaseline();
  assert.ok(rows.length > 0, "should return at least one row");
  for (const row of rows) {
    assert.equal(row.mitigated, true);
    assert.ok(typeof row.asr === "number");
    assert.ok(row.asr >= 0 && row.asr <= 1);
  }
});

test("mitigated T3 ASR is lower than or equal to unmitigated (no-ACL) T3 ASR", async () => {
  const { SYNTHETIC_MEMORIES, OTHER_NAMESPACE_MEMORIES } = await import("./fixture.js");
  const { runBaseline } = await import("./baseline.js");

  // Run the mitigated scenario *without* the budget wrapper to get the
  // unmitigated comparison point. ACL disabled, attacker queries namespace
  // "victim" where ground truth lives, so unmitigated ASR is non-trivial.
  const unmitigatedRows = await runBaseline([{
    name: "T3-no-acl-unmitigated",
    attackerMode: "cross-namespace",
    attackerNamespace: "victim",
    queryBudget: 200,
    seed: 303,
    groundTruth: SYNTHETIC_MEMORIES,
    targetMemories: [...SYNTHETIC_MEMORIES, ...OTHER_NAMESPACE_MEMORIES],
    entities: [],
    enforceNamespaceAcl: false,
    disclosesMemoryIds: true,
  }]);
  const mitigatedRows = await runMitigatedBaseline();

  const unmitigated = unmitigatedRows[0];
  const mitigated = mitigatedRows[0];

  assert.ok(unmitigated, "unmitigated row should exist");
  assert.ok(mitigated, "mitigated row should exist");

  // The unmitigated path should have non-trivial ASR (the attacker can
  // actually retrieve victim memories when ACL is off and namespace matches).
  assert.ok(
    unmitigated.asr > 0,
    `unmitigated ASR should be > 0 (got ${(unmitigated.asr * 100).toFixed(1)}%) — fixture may be misconfigured`,
  );

  assert.ok(
    mitigated.asr <= unmitigated.asr + 0.01,
    `mitigated ASR (${(mitigated.asr * 100).toFixed(1)}%) should be <= unmitigated ASR (${(unmitigated.asr * 100).toFixed(1)}%)`,
  );
});

test("createMitigatedTarget rejects invalid budget parameters", () => {
  const rawTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    disclosesMemoryIds: true,
  });

  // NaN budgetHardLimit
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: NaN, principalNamespace: "default" }),
    /budgetHardLimit must be a positive integer/,
  );

  // Negative budgetHardLimit
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: -1, principalNamespace: "default" }),
    /budgetHardLimit must be a positive integer/,
  );

  // Zero budgetHardLimit
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: 0, principalNamespace: "default" }),
    /budgetHardLimit must be a positive integer/,
  );

  // Non-integer budgetHardLimit
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: 1.5, principalNamespace: "default" }),
    /budgetHardLimit must be a positive integer/,
  );

  // Zero budgetWindowMs
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: 5, budgetWindowMs: 0, principalNamespace: "default" }),
    /budgetWindowMs must be a positive finite number/,
  );

  // Negative budgetWindowMs
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: 5, budgetWindowMs: -100, principalNamespace: "default" }),
    /budgetWindowMs must be a positive finite number/,
  );

  // Empty principalNamespace
  assert.throws(
    () => createMitigatedTarget({ target: rawTarget, budgetHardLimit: 5, principalNamespace: "" }),
    /principalNamespace must be a non-empty string/,
  );
});
