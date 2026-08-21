import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeededRng,
  createSyntheticTarget,
  OTHER_NAMESPACE_MEMORIES,
  runExtractionAttack,
  SYNTHETIC_MEMORIES,
} from "./index.ts";
import type { ExtractionAttackTarget } from "./index.ts";

const TEST_DEADLINE_MS = 20_000;

function deadline(): number {
  return Date.now() + TEST_DEADLINE_MS;
}

test("same-namespace attacker runs end-to-end and returns an ASR number", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan", "Priya Shah", "Aurora", "Helios"],
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "same-namespace",
    queryBudget: 80,
    rng: createSeededRng(1),
    captureTimeline: true,
    deadlineMs: deadline(),
  });

  assert.equal(typeof result.asr, "number", "asr must be a number");
  assert.ok(
    result.asr >= 0 && result.asr <= 1,
    `asr must be in [0, 1] (got ${result.asr})`,
  );
  assert.ok(
    result.queriesIssued <= 80,
    `queriesIssued (${result.queriesIssued}) must not exceed budget`,
  );
  assert.equal(result.attackerMode, "same-namespace");
  assert.ok(
    result.timeline.length === result.queriesIssued,
    "captured timeline length must equal queries issued",
  );
  assert.ok(
    result.recovered.length + result.missed.length === SYNTHETIC_MEMORIES.length,
    "recovered + missed must cover ground truth",
  );
  assert.ok(
    result.asr > 0,
    `same-namespace attacker should recover at least one memory (asr=${result.asr})`,
  );
});

test("zero-knowledge attacker has strictly lower ASR than same-namespace attacker", async () => {
  const zkTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    // Zero-knowledge attacker has no side-channel access.
    entities: [],
  });
  const snTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan", "Priya Shah", "Aurora", "Helios"],
  });

  const commonArgs = {
    groundTruth: SYNTHETIC_MEMORIES,
    queryBudget: 60,
    deadlineMs: deadline(),
  };

  const zkResult = await runExtractionAttack({
    ...commonArgs,
    target: zkTarget,
    attackerMode: "zero-knowledge",
    rng: createSeededRng(42),
  });
  const snResult = await runExtractionAttack({
    ...commonArgs,
    target: snTarget,
    attackerMode: "same-namespace",
    rng: createSeededRng(42),
  });

  assert.ok(
    zkResult.asr < snResult.asr,
    `zero-knowledge ASR (${zkResult.asr}) must be strictly lower than same-namespace ASR (${snResult.asr})`,
  );
});

test("deterministic RNG produces reproducible results across runs", async () => {
  const buildTarget = () =>
    createSyntheticTarget({
      memories: SYNTHETIC_MEMORIES,
      entities: ["Alex Morgan", "Aurora"],
    });

  const runOnce = async () =>
    runExtractionAttack({
      target: buildTarget(),
      groundTruth: SYNTHETIC_MEMORIES,
      attackerMode: "same-namespace",
      queryBudget: 40,
      rng: createSeededRng(7),
      captureTimeline: true,
      deadlineMs: deadline(),
    });

  const a = await runOnce();
  const b = await runOnce();

  assert.equal(a.asr, b.asr, "asr should be identical under a fixed seed");
  assert.equal(a.queriesIssued, b.queriesIssued, "queries issued should match");
  assert.equal(a.recovered.length, b.recovered.length, "recovered count should match");
  const aQueries = a.timeline.map((t) => t.query);
  const bQueries = b.timeline.map((t) => t.query);
  assert.deepEqual(aQueries, bQueries, "query sequence must be deterministic");
});

test("cross-namespace attacker is blocked when namespace ACL is enforced", async () => {
  // Target has memories in the victim namespace AND a separate one, but the
  // attacker only holds a token for 'other'. The target enforces the ACL.
  const combined = [...SYNTHETIC_MEMORIES, ...OTHER_NAMESPACE_MEMORIES];
  const target = createSyntheticTarget({
    memories: combined,
    entities: [],
    enforceNamespaceAcl: true,
    allowedNamespace: "other",
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES, // attacker is trying to leak VICTIM memories
    attackerMode: "cross-namespace",
    queryBudget: 50,
    rng: createSeededRng(9),
    deadlineMs: deadline(),
  });

  // The threat model §6.1 says ACLs should make direct T3 attacks fail;
  // any recovery here would indicate the harness itself is leaking by
  // mistake.
  assert.equal(
    result.asr,
    0,
    `cross-namespace attacker should recover 0 victim memories when ACLs hold (got ${result.asr})`,
  );
});

test("harness respects query budget", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan"],
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "same-namespace",
    queryBudget: 5,
    rng: createSeededRng(3),
    deadlineMs: deadline(),
  });

  assert.ok(
    result.queriesIssued <= 5,
    `queriesIssued (${result.queriesIssued}) must not exceed budget=5`,
  );
});

test("harness returns empty recovery when target raises on every query", async () => {
  const target: ExtractionAttackTarget = {
    async recall() {
      throw new Error("denied");
    },
  };

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "zero-knowledge",
    queryBudget: 10,
    rng: createSeededRng(11),
    deadlineMs: deadline(),
  });

  assert.equal(result.asr, 0, "no hits means 0 ASR");
  assert.equal(result.recovered.length, 0);
  assert.equal(result.missed.length, SYNTHETIC_MEMORIES.length);
});

test("rejects invalid budget and invalid entropy threshold", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
  });

  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 0,
      }),
    /queryBudget/,
  );

  // Non-integer and NaN budgets must also be rejected, not silently floored.
  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 0.2,
      }),
    /queryBudget/,
  );
  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: Number.NaN,
      }),
    /queryBudget/,
  );

  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 5,
        entropyThreshold: 2,
      }),
    /entropyThreshold/,
  );
});

test("duplicate-recovery credit cannot unlock two memories from identical content", async () => {
  // Two memories share 3/5 tokens so a single leaked sentence can clear the
  // default 50% overlap threshold against both. Without the creditedContent
  // dedupe the fallback matcher credits BOTH, inflating ASR.
  const memA = {
    id: "mem-dup-a",
    content: "Alex Morgan leads Aurora engineering.",
    category: "entity" as const,
    namespace: "victim",
    tokens: ["alex", "morgan", "aurora", "lead", "engineering"],
  };
  const memB = {
    id: "mem-dup-b",
    content: "Alex Morgan owns Aurora deployments.",
    category: "entity" as const,
    namespace: "victim",
    tokens: ["alex", "morgan", "aurora", "owns", "deployments"],
  };
  const leakedSentence = "alex morgan aurora"; // 3/5 against both.

  const target: ExtractionAttackTarget = {
    async recall() {
      return [{ content: leakedSentence, namespace: "victim" }];
    },
  };

  const result = await runExtractionAttack({
    target,
    groundTruth: [memA, memB],
    attackerMode: "zero-knowledge",
    queryBudget: 20,
    rng: createSeededRng(17),
    deadlineMs: deadline(),
  });

  assert.ok(
    result.recovered.length <= 1,
    `identical leaked content must not unlock multiple memories (recovered=${result.recovered.length})`,
  );
});

test("topK is validated as a positive finite integer", async () => {
  const target = createSyntheticTarget({ memories: SYNTHETIC_MEMORIES });
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () =>
        runExtractionAttack({
          target,
          groundTruth: SYNTHETIC_MEMORIES,
          attackerMode: "zero-knowledge",
          queryBudget: 5,
          topK: bad as number,
        }),
      /topK/,
      `should reject topK=${bad}`,
    );
  }
});

test("backendErrorCount counts thrown recalls but the loop continues by default", async () => {
  const target: ExtractionAttackTarget = {
    async recall() {
      throw new Error("backend down");
    },
  };
  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "zero-knowledge",
    queryBudget: 4,
    rng: createSeededRng(11),
    deadlineMs: deadline(),
  });
  assert.equal(result.queriesIssued, 4);
  assert.equal(result.backendErrorCount, 4);
  assert.equal(result.asr, 0);
});

test("failOnBackendError rethrows on the first target.recall failure", async () => {
  const target: ExtractionAttackTarget = {
    async recall() {
      throw new Error("backend outage");
    },
  };
  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 10,
        rng: createSeededRng(11),
        failOnBackendError: true,
        deadlineMs: deadline(),
      }),
    /backend outage/,
  );
});

test("duplicated tokens in SeededMemory.tokens are deduplicated before scoring", async () => {
  // Memory with duplicate tokens. Without dedupe, a hit containing only
  // one of those tokens would clear the threshold via inflated denominator.
  const memory = {
    id: "mem-dup-tokens",
    content: "Alpha alpha beta.",
    category: "fact" as const,
    namespace: "victim",
    tokens: ["alpha", "alpha", "beta"],
  };
  // Hit content contains "alpha" but not "beta". Overlap against the
  // dedup'd tokens = 1/2 = 50%. With the default 50% threshold it is
  // right at the boundary; set recoveryTokenOverlap to 0.6 so an inflated
  // 2/3 from duplicated numerators would have falsely cleared.
  const target: ExtractionAttackTarget = {
    async recall() {
      return [{ content: "alpha", namespace: "victim" }];
    },
  };
  const result = await runExtractionAttack({
    target,
    groundTruth: [memory],
    attackerMode: "zero-knowledge",
    queryBudget: 5,
    recoveryTokenOverlap: 0.6,
    rng: createSeededRng(77),
    deadlineMs: deadline(),
  });
  assert.equal(
    result.asr,
    0,
    `duplicated tokens must not inflate ASR (got ${result.asr})`,
  );
});

test("cross-namespace hit content cannot credit a victim-namespace memory", async () => {
  // A hit whose namespace differs from a ground-truth memory's namespace
  // must not be credited as a recovery of that memory, even when the
  // tokens overlap at threshold. Prevents ASR inflation in runs that
  // mix namespaces and masks whether the ACL is actually working.
  const victimMemory = {
    id: "mem-victim-ns",
    content: "Alex Morgan leads Aurora engineering.",
    category: "entity" as const,
    namespace: "victim",
    tokens: ["alex", "morgan", "aurora", "lead", "engineering"],
  };

  const target: ExtractionAttackTarget = {
    async recall() {
      // Simulated buggy backend that returns cross-namespace content.
      return [
        {
          content: "Alex Morgan leads Aurora engineering.",
          namespace: "other",
        },
      ];
    },
  };

  const result = await runExtractionAttack({
    target,
    groundTruth: [victimMemory],
    attackerMode: "cross-namespace",
    queryBudget: 20,
    rng: createSeededRng(31),
    deadlineMs: deadline(),
  });

  assert.equal(
    result.asr,
    0,
    `namespace-mismatched hits must not inflate ASR (got ${result.asr})`,
  );
});
