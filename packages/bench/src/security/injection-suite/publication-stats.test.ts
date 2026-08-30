import assert from "node:assert/strict";
import test from "node:test";
import type { InjectionSuiteExpectedDesign } from "./freeze.js";
import {
  analyzeInjectionSuitePublicationRows,
  analyzeInjectionSuitePublicationUtility,
} from "./publication-stats.js";
import { defaultSuiteIdentity } from "./store.js";
import type {
  InjectionSuiteArm,
  InjectionSuiteEpisodeRow,
  InjectionSuiteFamily,
  InjectionSuiteRunMetadata,
} from "./types.js";
import { INJECTION_SUITE_FAMILIES } from "./types.js";

function metadata(expectedRows: number): InjectionSuiteRunMetadata {
  return {
    schemaVersion: 3,
    suiteVersion: "h5-injection-suite-v2",
    resumeContractHash: "a".repeat(64),
    modelProfileId: "model-a",
    seeds: [71],
    variantsPerFamily: 10,
    limit: null,
    expectedRows,
    executor: "openai-compat",
    model: "model-a",
    baseUrl: "https://example.test/v1",
    requestTimeoutMs: 1_000,
    stage: "base",
    runKind: "main",
    modelProfileHash: "b".repeat(64),
    modelDigest: "c".repeat(64),
    corpusManifestHash: "d".repeat(64),
    expectedDesignHash: "e".repeat(64),
    decisionRuleHash: "f".repeat(64),
    gitSha: "abc123",
    cleanTree: true,
  };
}

function row(
  family: InjectionSuiteFamily,
  arm: InjectionSuiteArm,
  index: number,
  outcome: "ATTACK_SUCCEEDED" | "BLOCKED" | "VOID",
): InjectionSuiteEpisodeRow {
  const identity = defaultSuiteIdentity({
    stage: "base",
    modelProfileId: "model-a",
    arm,
    family,
    variantId: `base-${family}-${String(index).padStart(3, "0")}`,
    seed: 71,
  });
  return {
    rowKey: `row-${family}-${arm}-${index}`,
    identity,
    attackSucceeded: outcome === "ATTACK_SUCCEEDED",
    canaryEmitted: outcome === "ATTACK_SUCCEEDED",
    quarantined: arm === "both" || arm === "quarantine",
    fenced: arm === "both" || arm === "fencing",
    evidence: {
      viable: true,
      outcome,
      stoppedAt: "complete",
      livenessCanaryEmitted: outcome !== "VOID",
      memories: [],
      preRenderSha256: `pre-${family}-${index}`,
      renderedRecallSha256: `render-${arm}-${index}`,
      recallTraceSha256: null,
      recalledChars: 1,
      responseSha256: `response-${arm}-${index}`,
      responseChars: 1,
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      model: "model-a",
      trace: [],
    },
  };
}

function fixture(): {
  rows: InjectionSuiteEpisodeRow[];
  design: InjectionSuiteExpectedDesign;
} {
  const rows: InjectionSuiteEpisodeRow[] = [];
  for (const family of INJECTION_SUITE_FAMILIES) {
    for (let index = 1; index <= 10; index += 1) {
      rows.push(row(family, "none", index, "ATTACK_SUCCEEDED"));
      rows.push(
        row(
          family,
          "fencing",
          index,
          index <= 5 ? "BLOCKED" : "ATTACK_SUCCEEDED",
        ),
      );
      rows.push(row(family, "both", index, "BLOCKED"));
    }
  }
  return {
    rows,
    design: {
      schemaVersion: 1,
      stage: "base",
      modelProfileHash: "b".repeat(64),
      rows: rows.map((entry, order) => ({
        order,
        rowKey: entry.rowKey,
        identity: entry.identity,
        templateId: `${entry.identity.family}-${String(Number(entry.identity.variantId.slice(-3))).padStart(2, "0")}`,
        scenarioSha256: "0".repeat(64),
      })),
    },
  };
}

test("publication analysis falsifies fencing without relabeling the H5 claim partial", () => {
  const { rows, design } = fixture();
  const analysis = analyzeInjectionSuitePublicationRows(
    rows,
    metadata(rows.length),
    design,
    { invalid: 0, duplicate: 0, missing: 0, unexpected: 0 },
    { draws: 500 },
  );
  assert.equal(analysis.fencingAlone, "FALSIFIED");
  assert.equal(analysis.layered, "SUPPORTED");
  assert.ok(analysis.families.every((family) => family.fencingGate === false));
  assert.ok(analysis.families.every((family) => family.layeredGate === true));
});

test("void-as-failure sensitivity can overturn an otherwise perfect layered rate", () => {
  const { rows, design } = fixture();
  for (const entry of rows) {
    if (
      entry.identity.arm === "both" &&
      Number(entry.identity.variantId.slice(-3)) <= 5
    ) {
      entry.evidence!.outcome = "VOID";
    }
  }
  const analysis = analyzeInjectionSuitePublicationRows(
    rows,
    metadata(rows.length),
    design,
    { invalid: 0, duplicate: 0, missing: 0, unexpected: 0 },
    { draws: 500 },
  );
  const minja = analysis.families.find((family) => family.family === "minja")!;
  assert.equal(minja.layered.primary.rate, 1);
  assert.equal(minja.layered.voidAsFailure.rate, 0.5);
  assert.equal(minja.layeredGate, false);
  assert.equal(analysis.layered, "REJECTED");
});

test("utility analysis clusters repeated seeds by item and reports benchmarks separately", () => {
  const observations = ["locomo", "drift-gen"].flatMap((benchmark) =>
    ["a", "b"].flatMap((itemId) =>
      [1, 2].flatMap((seed) => [
        { benchmark, itemId, seed, arm: "none" as const, score: 1 },
        {
          benchmark,
          itemId,
          seed,
          arm: "fencing" as const,
          score: benchmark === "locomo" ? 1 : 0,
        },
      ]),
    ),
  );
  const analysis = analyzeInjectionSuitePublicationUtility(observations, {
    draws: 200,
  });
  assert.equal(analysis.benchmarks.length, 2);
  assert.ok(analysis.benchmarks.every((benchmark) => benchmark.clusters === 2));
  assert.equal(
    analysis.benchmarks.find((benchmark) => benchmark.benchmark === "locomo")
      ?.relativeDelta,
    0,
  );
  assert.equal(
    analysis.benchmarks.find((benchmark) => benchmark.benchmark === "drift-gen")
      ?.relativeDelta,
    -1,
  );
});

test("publication analysis reports every registered defense comparator", () => {
  const { rows: legacyRows } = fixture();
  const rows = legacyRows.flatMap((entry) => {
    if (entry.identity.arm === "fencing") {
      const copy = structuredClone(entry);
      copy.identity.arm = "source-authenticated-fencing";
      copy.rowKey = copy.rowKey.replace(
        "-fencing-",
        "-source-authenticated-fencing-",
      );
      return [copy];
    }
    if (entry.identity.arm === "both") {
      const copy = structuredClone(entry);
      copy.identity.arm = "layered-fence-quarantine";
      copy.rowKey = copy.rowKey.replace("-both-", "-layered-fence-quarantine-");
      return [copy];
    }
    const index = Number(entry.identity.variantId.slice(-3));
    return [
      entry,
      row(entry.identity.family, "structured-boundary", index, "BLOCKED"),
      row(entry.identity.family, "spotlighting-marking", index, "BLOCKED"),
      row(entry.identity.family, "control-data-isolation", index, "BLOCKED"),
    ];
  });
  const design: InjectionSuiteExpectedDesign = {
    schemaVersion: 1,
    stage: "base",
    modelProfileHash: "b".repeat(64),
    rows: rows.map((entry, order) => ({
      order,
      rowKey: entry.rowKey,
      identity: entry.identity,
      templateId: `${entry.identity.family}-${entry.identity.variantId.slice(-3)}`,
      scenarioSha256: "0".repeat(64),
    })),
  };
  const analysis = analyzeInjectionSuitePublicationRows(
    rows,
    metadata(rows.length),
    design,
    { invalid: 0, duplicate: 0, missing: 0, unexpected: 0 },
    { draws: 100 },
  );
  assert.ok(
    analysis.families.every((family) => family.defenseComparators.length === 5),
  );
  assert.ok(
    analysis.families.every((family) =>
      family.defenseComparators.every(
        (comparator) => comparator.block.primary.rate !== null,
      ),
    ),
  );
});
