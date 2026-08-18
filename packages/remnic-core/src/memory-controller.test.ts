import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryControllerCoordinator,
  chooseAction,
  computeEvidenceReportHash,
  controllerConfigHash,
  evaluateActiveGates,
  hashControllerState,
  type ActiveContextPlan,
  type MemoryControllerConfig,
  type MemoryControllerDeps,
  type MemoryControllerEvent,
  type MemoryControllerEvidence,
  type MemoryControllerExecutors,
  type MemoryControllerMode,
} from "./memory-controller.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function config(mode: MemoryControllerMode): MemoryControllerConfig {
  return {
    mode,
    reportVersion: "2345-v1",
    evidenceMaxAgeMs: 24 * 60 * 60 * 1000,
    minPairedSeeds: 2,
    shadowMinRecords: 3,
  };
}

function evidence(overrides?: {
  report?: Partial<MemoryControllerEvidence["report"]>;
  pairedSeed?: Partial<MemoryControllerEvidence["pairedSeed"]>;
}): MemoryControllerEvidence {
  const report = {
    status: "pass",
    version: "2345-v1",
    configHash: controllerConfigHash(config("active")),
    generatedAt: NOW.toISOString(),
    ...overrides?.report,
  } as MemoryControllerEvidence["report"];
  return {
    report: { ...report, reportHash: computeEvidenceReportHash(report) },
    pairedSeed: {
      status: "pass",
      seedCount: 3,
      generatedAt: NOW.toISOString(),
      ...overrides?.pairedSeed,
    },
  };
}

function echoReceipt(input: { decisionId: string }): { decisionId: string; ok: true } {
  return { decisionId: input.decisionId, ok: true };
}

function harness(options?: {
  mode?: MemoryControllerMode;
  evidenceOverride?: MemoryControllerEvidence | null;
  shadowRecords?: number;
  recordThrows?: boolean;
  executors?: MemoryControllerExecutors;
  adapterPlan?: ActiveContextPlan | null;
}) {
  const events: MemoryControllerEvent[] = [];
  const calls: string[] = [];
  let dispatched = false;
  const markDispatch =
    <T>(label: string) =>
    async (input: T & { decisionId: string }) => {
      calls.push(label);
      dispatched = true;
      return echoReceipt(input);
    };
  const deps: MemoryControllerDeps = {
    config: config(options?.mode ?? "active"),
    reportReader: {
      read: async () =>
        options?.evidenceOverride === undefined || options.evidenceOverride !== null
          ? (options?.evidenceOverride ?? evidence())
          : null,
    },
    recorder: {
      record: async (event) => {
        if (options?.recordThrows) throw new Error("recorder down");
        if (event.phase === "choice") {
          // Gate proof: the choice record must precede any dispatch.
          assert.ok(!dispatched, "choice event recorded after dispatch");
        }
        events.push(event);
      },
      countShadowRecords: async () => options?.shadowRecords ?? 10,
    },
    executors:
      options?.executors ??
      ({
        executePersistentMemory: markDispatch("persistent"),
        executeRecall: markDispatch("recall"),
        executeActiveContext: markDispatch("context"),
      } as MemoryControllerExecutors),
    activeContextAdapter:
      options?.adapterPlan === null
        ? undefined
        : {
            plan: () => options?.adapterPlan ?? { transform: "FILTER", messageIds: ["m1"], planId: "p1" },
          },
    telemetry: (event) => calls.push(`telemetry:${event.phase}`),
    clock: () => NOW,
  };
  return { deps, events, calls };
}

const RECALL_PROMPT = "what did we decide last time?";

test("off mode makes no choice, no read, no write, no call", async () => {
  const h = harness({ mode: "off" });
  const explode = async () => {
    throw new Error("touched in off mode");
  };
  h.deps.reportReader = { read: explode };
  h.deps.recorder = { record: explode, countShadowRecords: explode };
  h.deps.executors = { executeRecall: explode } as MemoryControllerExecutors;
  h.deps.policyRuntime = { loadRuntimeValues: explode };
  h.deps.readUtilityRuntime = explode;

  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });

  assert.equal(result.effectiveMode, "off");
  assert.equal(result.executed, false);
  assert.equal(result.recorded, false);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.calls, []);
});

test("shadow mode records the choice but calls no executor", async () => {
  const h = harness({ mode: "shadow" });
  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });

  assert.equal(result.effectiveMode, "shadow");
  assert.equal(result.recorded, true);
  assert.equal(result.executed, false);
  assert.deepEqual(h.calls, ["telemetry:choice"]);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].phase, "choice");
  assert.ok(h.events[0].stateHash.length > 0);
});

test("active mode with passing gates executes and links one id across events", async () => {
  const h = harness();
  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });

  assert.equal(result.effectiveMode, "active");
  assert.deepEqual(result.demotionReasons, []);
  assert.equal(result.choice.family, "recall");
  assert.ok(h.calls.includes("recall"));
  const ids = new Set(h.events.map((event) => event.decisionId));
  ids.add(result.decisionId);
  if (result.receipt) ids.add(result.receipt.decisionId);
  assert.equal(ids.size, 1, "one id joins each event");
  assert.equal(result.executed, true);
  const outcome = h.events.find((event) => event.phase === "outcome");
  assert.equal(outcome?.receipt?.decisionId, result.decisionId);
});

test("bad or old evidence forces shadow: report gates", async () => {
  const cases: { name: string; options: Parameters<typeof harness>[0] }[] = [
    { name: "no evidence", options: { evidenceOverride: null } },
    {
      name: "report not passing",
      options: { evidenceOverride: evidence({ report: { status: "fail" } }) },
    },
    {
      name: "version mismatch",
      options: { evidenceOverride: evidence({ report: { version: "2345-v0" } }) },
    },
    {
      name: "config unbound",
      options: {
        evidenceOverride: evidence({
          report: { configHash: controllerConfigHash({ ...config("active"), shadowMinRecords: 99 }) },
        }),
      },
    },
    {
      name: "report hash invalid",
      options: {
        evidenceOverride: {
          report: { ...evidence().report, reportHash: "0".repeat(64) },
          pairedSeed: evidence().pairedSeed,
        },
      },
    },
    {
      name: "report stale",
      options: { evidenceOverride: evidence({ report: { generatedAt: "2020-01-01T00:00:00.000Z" } }) },
    },
  ];
  for (const testCase of cases) {
    const h = harness(testCase.options);
    const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });
    assert.equal(result.effectiveMode, "shadow", testCase.name);
    assert.equal(result.executed, false, testCase.name);
    assert.ok(!h.calls.some((c) => c !== "telemetry:choice"), testCase.name);
  }
});

test("bad or old paired-seed evidence forces shadow", async () => {
  const pairedSeeds = [
    { status: "fail" as const, seedCount: 3, generatedAt: NOW.toISOString() },
    { status: "pass" as const, seedCount: 1, generatedAt: NOW.toISOString() },
    { status: "pass" as const, seedCount: 3, generatedAt: "2020-01-01T00:00:00.000Z" },
  ];
  for (const pairedSeed of pairedSeeds) {
    const h = harness({ evidenceOverride: evidence({ pairedSeed }) });
    const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });
    assert.equal(result.effectiveMode, "shadow", JSON.stringify(pairedSeed));
    assert.ok(result.demotionReasons.some((r) => r.startsWith("paired_seed")));
    assert.equal(result.executed, false);
  }
});

test("active promotion requires prior shadow records (shadow before active)", async () => {
  const h = harness({ shadowRecords: 1 });
  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });
  assert.equal(result.effectiveMode, "shadow");
  assert.ok(result.demotionReasons.includes("shadow_history_insufficient"));
  assert.equal(result.executed, false);
});

test("failed receipt forces shadow on the next run", async () => {
  const h = harness({
    executors: {
      executeRecall: async () => ({ decisionId: "wrong-id", ok: true }),
    },
  });
  const coordinator = new MemoryControllerCoordinator(h.deps);
  const first = await coordinator.run({ prompt: RECALL_PROMPT });
  assert.equal(first.executed, false, "mismatched receipt id is a bad receipt");
  assert.ok(h.events.find((event) => event.phase === "outcome")?.failureClass === "bad_receipt");

  const second = await coordinator.run({ prompt: RECALL_PROMPT });
  assert.equal(second.effectiveMode, "shadow");
  assert.ok(second.demotionReasons.includes("recent_receipt_failures"));
  assert.equal(second.executed, false);
});

test("executor error or missing executor records a failure class and demotes next run", async () => {
  const h = harness({
    executors: {
      executeRecall: async () => Promise.reject(new Error("boom")),
    },
  });
  const coordinator = new MemoryControllerCoordinator(h.deps);
  const failed = await coordinator.run({ prompt: RECALL_PROMPT });
  assert.equal(failed.executed, false);
  assert.equal(h.events.find((event) => event.phase === "outcome")?.failureClass, "executor_error");
  const next = await coordinator.run({ prompt: RECALL_PROMPT });
  assert.equal(next.effectiveMode, "shadow");

  const h2 = harness({ executors: {} });
  const missing = await new MemoryControllerCoordinator(h2.deps).run({ prompt: RECALL_PROMPT });
  assert.equal(missing.executed, false);
  assert.equal(h2.events.find((event) => event.phase === "outcome")?.failureClass, "no_executor");
});

test("bad scores fail closed to no_op", () => {
  const { choice, scores } = chooseAction({
    state: {
      prompt: RECALL_PROMPT,
      persistentMemoryCandidate: {
        action: "store_note",
        eligibility: {
          confidence: Number.NaN,
          lifecycleState: "active",
          importance: 0.5,
          source: "extraction",
        },
      },
    },
  });
  assert.deepEqual(choice, { family: "no_op" });
  assert.ok(Number.isNaN(scores.persistent_memory));
});

test("discard stays review-only in active mode", async () => {
  const h = harness();
  const result = await new MemoryControllerCoordinator(h.deps).run({
    prompt: "ok",
    persistentMemoryCandidate: {
      action: "discard",
      eligibility: {
        confidence: 0.9,
        lifecycleState: "active",
        importance: 0.1,
        source: "extraction",
      },
    },
  });
  assert.equal(result.choice.family, "persistent_memory");
  assert.equal(result.choice.action, "discard");
  assert.equal(result.reviewOnly, true);
  assert.equal(result.executed, false);
  assert.deepEqual(h.calls, ["telemetry:choice", "telemetry:outcome"]);
  assert.equal(h.events.find((event) => event.phase === "outcome")?.reviewOnly, true);
});

test("record failure stops work before dispatch", async () => {
  const h = harness({ recordThrows: true });
  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });
  assert.equal(result.recorded, false);
  assert.equal(result.executed, false);
  assert.ok(result.demotionReasons.includes("record_failed"));
  assert.deepEqual(h.calls, []);
});

test("one hash names each state", () => {
  assert.equal(hashControllerState({ prompt: "same" }), hashControllerState({ prompt: "same" }));
  assert.notEqual(hashControllerState({ prompt: "same" }), hashControllerState({ prompt: "other" }));
});

test("no counterfactual lift is claimed in events or results", async () => {
  const h = harness();
  const result = await new MemoryControllerCoordinator(h.deps).run({ prompt: RECALL_PROMPT });
  const banned = /lift|counterfactual/i;
  for (const event of h.events) {
    for (const key of Object.keys(event)) assert.ok(!banned.test(key), `event key ${key}`);
  }
  for (const key of Object.keys(result)) assert.ok(!banned.test(key), `result key ${key}`);
});

test("evaluateActiveGates returns empty only when all gates pass", async () => {
  const passing = await evaluateActiveGates({
    config: config("active"),
    reportReader: { read: async () => evidence() },
    recorder: { record: async () => {}, countShadowRecords: async () => 5 },
    consecutiveReceiptFailures: 0,
    now: NOW,
  });
  assert.deepEqual(passing, []);
  const noReader = await evaluateActiveGates({
    config: config("active"),
    consecutiveReceiptFailures: 0,
    now: NOW,
  });
  assert.deepEqual(noReader, ["no_report_reader"]);
});
