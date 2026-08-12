import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeBenchmarkReproManifestArtifactHash,
  type BenchmarkReproManifest,
} from "../repro-manifest.js";
import { captureBenchmarkExecutionProvenance, getRemnicVersion } from "../reporter.js";
import {
  countFactTokens,
  DecisionRuleSchema,
  decisionRuleAnalysisOptions,
  REPEATED_FAILURE_ANALYSIS_VERSION,
  stableStringify,
  timidityDesignOption,
} from "./repeated-failure-suite-shared.js";
import {
  H6_FROZEN_INVENTORY_HASH,
  H6_DECISION_RULE,
  generateH6BenchmarkDataset,
} from "./repo-gen/index.js";
import {
  registeredProfileBindingsMatch,
  requiresRegisteredEvidence,
  writeRepeatedFailurePaperArtifacts,
} from "./repeated-failure-report.js";
import { buildRepeatedFailureRowKey } from "./repeated-failure-store.js";
import { analyzeRepeatedFailureRows } from "./repeated-failure-stats.js";
import { computeAnalysisHarnessHash } from "./repeated-failure-suite-analysis.js";
import type {
  RepeatedFailureArm,
  RepeatedFailureEpisodeRow,
  RepeatedFailureRowIdentity,
} from "./repeated-failure-types.js";

const MODEL_HASH = "a".repeat(64);
const MODEL_DIGEST = "c".repeat(64);
const PILOT_MANIFEST_HASH = "d".repeat(64);
const PILOT_POWER_HASH = "e".repeat(64);
const TOKENS = {
  input: 100,
  output: 20,
  total: 120,
  cachedInput: 0,
  cacheWriteInput: 0,
  reasoningOutput: 0,
};

const TRACE_BYTES = "{}\n";
const TRACE_HASH = createHash("sha256").update(TRACE_BYTES).digest("hex");

test("registered profile bindings use the frozen profile count and execution identity", () => {
  const bindings = {
    modelProfileIds: ["qwen3-thinking-off", "qwen3-thinking-on"],
    modelProfileHashes: ["a".repeat(64), "b".repeat(64)],
    modelDigests: ["c".repeat(64), "d".repeat(64)],
    modelDriverKinds: ["ollama-chat", "ollama-chat"],
    modelTokenizerIdentities: ["qwen3-off-tokenizer", "qwen3-on-tokenizer"],
    modelTokenizerImplementations: ["nfkc-whitespace-v1", "nfkc-whitespace-v1"],
  } as const;
  assert.equal(registeredProfileBindingsMatch(bindings, 2), true);
  assert.equal(registeredProfileBindingsMatch(bindings, 1), false);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelProfileIds: [bindings.modelProfileIds[0], bindings.modelProfileIds[0]],
  }, 2), true);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelProfileHashes: [bindings.modelProfileHashes[0], bindings.modelProfileHashes[0]],
  }, 2), true);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelProfileIds: [bindings.modelProfileIds[0], bindings.modelProfileIds[0]],
    modelProfileHashes: [bindings.modelProfileHashes[0], bindings.modelProfileHashes[0]],
  }, 2), false);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelDigests: [bindings.modelDigests[0], bindings.modelDigests[0]],
  }, 2), false);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelDriverKinds: ["responses", "ollama-chat"],
  }, 2), false);
  assert.equal(registeredProfileBindingsMatch({
    ...bindings,
    modelTokenizerIdentities: ["qwen3-off-tokenizer", ""],
  }, 2), false);

  const oneProfile = {
    modelProfileIds: [bindings.modelProfileIds[0]],
    modelProfileHashes: [bindings.modelProfileHashes[0]],
    modelDigests: [bindings.modelDigests[0]],
    modelDriverKinds: [bindings.modelDriverKinds[0]],
    modelTokenizerIdentities: [bindings.modelTokenizerIdentities[0]],
    modelTokenizerImplementations: [bindings.modelTokenizerImplementations[0]],
  };
  assert.equal(registeredProfileBindingsMatch(oneProfile, 1), true);
});

test("one-profile registered phases require fact-pair and trap-audit evidence", () => {
  assert.equal(requiresRegisteredEvidence(true, "pilot", 1, 1), true);
  assert.equal(requiresRegisteredEvidence(true, "main", 1, 1), true);
  assert.equal(requiresRegisteredEvidence(true, "main", 2, 1), false);
  assert.equal(requiresRegisteredEvidence(false, "main", 1, 1), false);
  assert.equal(requiresRegisteredEvidence(true, "unspecified", 1, 1), false);
});

test("registered fact token counts preserve repeated normalized token occurrences", () => {
  assert.equal(countFactTokens("ＦＯＯ foo, BAR bar bar", {
    identity: "test-tokenizer",
    implementation: "nfkc-whitespace-v1",
  }), 5);
});

function row(
  taskId: string,
  arm: RepeatedFailureArm,
  repeatedFailure: boolean,
  taskPassed: boolean,
  steps: number,
  noTrap = false,
): RepeatedFailureEpisodeRow {
  const identity: RepeatedFailureRowIdentity = {
    suiteVersion: `h6-failure-gate-v1-${H6_FROZEN_INVENTORY_HASH}`,
    taskId,
    variantId: `${taskId}-v1${noTrap ? ":no-trap" : ""}`,
    modelProfileId: "model-a",
    modelProfileHash: MODEL_HASH,
    seed: 1,
    arm,
  };
  return {
    schemaVersion: 1,
    rowKey: buildRepeatedFailureRowKey(identity),
    identity,
    status: "VALID",
    finalState: noTrap ? "NO_TRAP" : taskPassed ? "FIXED" : "TRAPPED",
    durationMs: 10,
    tokens: TOKENS,
    tryCount: 1,
    evidence: {
      startRepoHash: "c".repeat(64),
      startMemoryHash: "d".repeat(64),
      historyHash: "e".repeat(64),
      askedActionHash: "f".repeat(64),
      traceArtifactPath: `traces/${taskId}-${arm}${noTrap ? "-no-trap" : ""}.json`,
      traceArtifactHash: TRACE_HASH,
      gate: { status: "NO_MATCH", fingerprintHash: "2".repeat(64) },
      actionExecuted: true,
      checkResult: taskPassed ? "PASS" : "FAIL",
      repeatedFailure,
      taskPassed,
      steps,
      warningCount: 0,
      falseWarningCount: 0,
      factPairAudit: noTrap ? "NOT_APPLICABLE" : "MATCHED",
      faults: [],
    },
    isolation: {
      repoId: `repo-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      memoryId: `memory-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      codingScopeId: `scope-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      codeGraphId: `graph-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      chatId: `chat-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      sessionId: `session-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
      cacheId: `cache-${taskId}-${arm}${noTrap ? "-no-trap" : ""}`,
    },
    repeatedFailure,
    taskPassed,
    steps,
    warningCount: 0,
    falseWarningCount: 0,
    factPairAudit: noTrap ? "NOT_APPLICABLE" : "MATCHED",
  };
}


const RUN_SOURCE_ARTIFACTS = [
  "audit.json",
  "decision-rule.json",
  "deviations.jsonl",
  "episodes.jsonl",
  "expected-design.json",
  "fact-pair-audit.json",
  "power.json",
  "run.json",
  "statistics.json",
] as const;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeTestRunManifest(runDir: string, tracePaths: readonly string[]): Promise<void> {
  const resultPath = "result.json";
  try {
    await readFile(path.join(runDir, resultPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path.join(runDir, resultPath), "{}\n");
  }
  const supplementalPaths = [...RUN_SOURCE_ARTIFACTS, ...tracePaths].sort();
  const supplementalArtifacts = await Promise.all(supplementalPaths.map(async (relativePath) => {
    const bytes = await readFile(path.join(runDir, relativePath));
    return { path: relativePath, sha256: digest(bytes), sizeBytes: bytes.length };
  }));
  const resultBytes = await readFile(path.join(runDir, resultPath));
  const episodeBytes = await readFile(path.join(runDir, "episodes.jsonl"), "utf8");
  const taskCount = episodeBytes.split("\n").filter((line) => line.length > 0).length;
  const metadata = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as {
    runId: string;
    mode: "full" | "quick";
    modelProfileIds: string[];
    modelProfileHashes: string[];
    statisticsSeed: number;
    gitSha: string;
    gitDirty: boolean;
    gitDirtyEntryCount: number;
    seeds: number[];
  };
  const runtimeProfiles = metadata.modelProfileIds.map(
    (id, index) => `${id}@${metadata.modelProfileHashes[index] ?? ""}`,
  );
  const withoutHash: Omit<BenchmarkReproManifest, "artifactHash"> = {
    schemaVersion: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    run: {
      id: metadata.runId,
      mode: metadata.mode,
      selectedBenchmarks: ["h6-repeated-failure"],
      runtimeProfiles,
      selectedWorkItems: runtimeProfiles.map((runtimeProfile) => ({
        benchmark: "h6-repeated-failure",
        runtimeProfile,
      })),
      seed: metadata.statisticsSeed,
    },
    git: {
      commit: metadata.gitSha,
      shortCommit: metadata.gitSha.slice(0, 12),
      dirty: metadata.gitDirty,
      dirtyEntryCount: metadata.gitDirtyEntryCount,
    },
    command: { cwd: ".", argv: [], envKeys: [] },
    environment: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    configFiles: [],
    datasets: [],
    results: [{
      path: resultPath,
      sha256: digest(resultBytes),
      sizeBytes: resultBytes.length,
      resultId: metadata.runId,
      benchmark: "h6-repeated-failure",
      mode: metadata.mode,
      gitSha: metadata.gitSha,
      runCount: 1,
      seeds: metadata.seeds,
      taskCount,
      configHash: "test",
      judge: null,
    }],
    supplementalArtifacts,
  };
  const manifest = {
    ...withoutHash,
    artifactHash: computeBenchmarkReproManifestArtifactHash(withoutHash),
  };
  await writeFile(path.join(runDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("paper artifacts are generated deterministically from frozen run outputs", async (context) => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "h6-paper-"));
  try {
    const dataset = await generateH6BenchmarkDataset();
    const taskId = "h6-task-07";
    const taskIds = [taskId];
    const rows = [
      row(taskId, "NO_MEMORY", true, false, 4),
      row(taskId, "TURN_START_SUCCESS", true, false, 4),
      row(taskId, "TURN_START_FAILURE", true, false, 4),
      row(taskId, "PRE_ACTION_FAILURE", false, true, 3),
      row(taskId, "BOTH", false, true, 3),
      row(taskId, "NO_MEMORY", false, true, 2, true),
      row(taskId, "PRE_ACTION_FAILURE", false, true, 2, true),
    ];
    const decisionRuleBytes = `${JSON.stringify(H6_DECISION_RULE, null, 2)}\n`;
    const decisionRule = DecisionRuleSchema.parse(H6_DECISION_RULE);
    const preregistrationHash = decisionRule.preregistration.sha256;
    const decisionRuleHash = digest(decisionRuleBytes);
    const runOrder = rows.map((entry) => ({
      rowKey: entry.rowKey,
      analysis: entry.identity.variantId.endsWith(":no-trap") ? "TIMIDITY" as const : "PRIMARY" as const,
      identity: entry.identity,
    }));
    const design = {
      schemaVersion: 1 as const,
      runOrder,
      primary: { rows: rows.filter((entry) => !entry.identity.variantId.endsWith(":no-trap"))
        .map((entry) => entry.identity) },
      timidity: { rows: rows.filter((entry) => entry.identity.variantId.endsWith(":no-trap"))
        .map((entry) => entry.identity) },
    };
    const statistics = analyzeRepeatedFailureRows(rows, {
      expectedDesign: design.primary,
      ...timidityDesignOption(decisionRule, design.timidity),
      seed: 17,
      draws: decisionRule.analysis.bootstrap.draws,
      ...decisionRuleAnalysisOptions(decisionRule),
    });
    const harnessVersion = await getRemnicVersion();
    const harnessSourceHash = await computeAnalysisHarnessHash();
    const provenance = captureBenchmarkExecutionProvenance();
    const provenanceHash = digest(stableStringify({
      analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
      harnessVersion,
      harnessSourceHash,
      gitSha: provenance.gitSha,
      gitDirty: provenance.gitDirty,
      gitDirtyEntryCount: provenance.gitDirtyEntryCount,
    }));
    const expectedDesignHash = digest(stableStringify(design));
    const tracePaths = rows.map((entry) => entry.evidence?.traceArtifactPath ?? "");
    await Promise.all(tracePaths.map(async (tracePath) => {
      await mkdir(path.dirname(path.join(runDir, tracePath)), { recursive: true });
      await writeFile(path.join(runDir, tracePath), TRACE_BYTES);
    }));
    const runMetadata = {
      schemaVersion: 1,
      runId: "h6-test-run",
      suiteVersion: rows[0]?.identity.suiteVersion ?? "missing-suite-version",
      datasetInventoryHash: dataset.inventoryHash,
      resumeContractHash: "4".repeat(64),
      expectedDesignHash,
      decisionRuleHash,
      preregistrationPath: decisionRule.preregistration.path,
      preregistrationHash,
      analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
      harnessVersion,
      harnessSourceHash,
      provenanceHash,
      gitSha: provenance.gitSha,
      gitDirty: provenance.gitDirty,
      gitDirtyEntryCount: provenance.gitDirtyEntryCount,
      phase: "main",
      pilotEvidence: {
        runId: "pilot-run",
        manifestArtifactHash: PILOT_MANIFEST_HASH,
        powerArtifactHash: PILOT_POWER_HASH,
      },
      mode: "full",
      arms: ["NO_MEMORY", "TURN_START_SUCCESS", "TURN_START_FAILURE", "PRE_ACTION_FAILURE", "BOTH"],
      modelProfileIds: ["model-a"],
      modelProfileHashes: [MODEL_HASH],
      modelDigests: [MODEL_DIGEST],
      modelDriverKinds: ["responses"],
      modelTokenizerIdentities: ["test-tokenizer"],
      modelTokenizerImplementations: ["nfkc-whitespace-v1"],
      trapAuditReceipts: [],
      seeds: [1],
      splitTaskIds: taskIds,
      taskRevisions: [{
        taskId,
        variantId: `${taskId}-v1`,
        cleanRevisionSha: "1".repeat(40),
        trapRevisionSha: "2".repeat(40),
        rightRevisionSha: "3".repeat(40),
        noTrapRevisionSha: "4".repeat(40),
      }],
      caps: {
        maxTurns: 8,
        maxToolCalls: 16,
        maxTotalTokens: 10_000,
        maxDurationMs: 60_000,
        requestTimeoutMs: 30_000,
        maxToolOutputChars: 4_096,
      },
      toolLocks: {
        allowedTools: ["inspect"],
        taskToolSchemaHashes: [{ taskId, variantId: `${taskId}-v1`, sha256: "5".repeat(64) }],
      },
      sandboxFlags: {
        networkDisabled: true,
        isolatedRepoPerArm: true,
        isolatedMemoryPerArm: true,
        isolatedSessionPerArm: true,
        rejectSymlinks: true,
      },
      retryRule: {
        hostApiFaultRetriesAfterFirstTry: 2,
        rerunTaskResults: false,
        retainAllTries: true,
      },
      runOrder,
      expectedRowCount: rows.length,
      statisticsSeed: 17,
      statisticsDraws: decisionRule.analysis.bootstrap.draws,
    };
    await Promise.all([
      writeFile(path.join(runDir, "episodes.jsonl"), `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
      writeFile(path.join(runDir, "statistics.json"), `${JSON.stringify(statistics, null, 2)}\n`),
      writeFile(path.join(runDir, "decision-rule.json"), decisionRuleBytes),
      writeFile(path.join(runDir, "deviations.jsonl"), ""),
      writeFile(path.join(runDir, "expected-design.json"), `${JSON.stringify(design, null, 2)}\n`),
      writeFile(path.join(runDir, "fact-pair-audit.json"), `${JSON.stringify({
        schemaVersion: 1,
        pairs: [{ status: "MATCHED" }],
      }, null, 2)}\n`),
      writeFile(path.join(runDir, "power.json"), `${JSON.stringify({
        schemaVersion: 1,
        status: "VERIFIED_PILOT",
        phase: "main",
        pilotRunId: "pilot-run",
        pilotManifestArtifactHash: PILOT_MANIFEST_HASH,
        pilotPowerArtifactHash: PILOT_POWER_HASH,
      }, null, 2)}\n`),
      writeFile(path.join(runDir, "run.json"), `${JSON.stringify(runMetadata, null, 2)}\n`),
      writeFile(path.join(runDir, "audit.json"), `${JSON.stringify({
        schemaVersion: 1,
        runContract: {
          datasetInventoryHash: dataset.inventoryHash,
          preregistrationPath: decisionRule.preregistration.path,
          decisionRuleHash,
          preregistrationHash,
          analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
          harnessVersion,
          harnessSourceHash,
          provenanceHash,
          modelProfiles: [{
            id: "model-a",
            hash: MODEL_HASH,
            modelDigest: MODEL_DIGEST,
            tokenizerIdentity: "test-tokenizer",
            tokenizerImplementation: "nfkc-whitespace-v1",
          }],
          trapAudit: decisionRule.trapAudit,
        },
        dataset: {
          inventoryHash: dataset.inventoryHash,
          taskCount: 30,
          variantCount: 90,
          splitCounts: { dev: 6, pilot: 6, main: 18 },
          supportArtifactsMatch: true,
        },
        expectedDesign: { expectedRows: rows.length, terminalRows: rows.length, exactRowSet: true },
        factPairs: { pairCount: 1, allMatched: true },
        isolation: { allUnique: true, primaryStartHashesMatchWithinCells: true },
        timingEvidence: { allMatched: true },
        fakeAgentContract: { status: "NOT_APPLICABLE", deterministicDriverCount: 0 },
        modelProfiles: [{
          id: "model-a",
          hash: MODEL_HASH,
          modelDigest: MODEL_DIGEST,
          tokenizerIdentity: "test-tokenizer",
          tokenizerImplementation: "nfkc-whitespace-v1",
          driverKind: "responses",
        }],
        noTrap: { expectedRows: 2, observedRows: 2, allPassed: true },
        deviations: { count: 0, none: true },
        traces: { expectedCount: rows.length, durableCount: rows.length, allDurable: true },
        cuts: { primary: [], timidity: [] },
        decision: statistics.studyDecision,
      }, null, 2)}\n`),
    ]);
    await writeTestRunManifest(runDir, tracePaths);

    const first = await writeRepeatedFailurePaperArtifacts({ runDir, dataset });
    const firstBytes = await Promise.all(first.artifactPaths.map((artifactPath) => readFile(artifactPath)));
    const firstModificationTimes = await Promise.all(first.artifactPaths.map(async (artifactPath) =>
      (await stat(artifactPath, { bigint: true })).mtimeNs
    ));
    const second = await writeRepeatedFailurePaperArtifacts({ runDir, dataset });
    const secondBytes = await Promise.all(second.artifactPaths.map((artifactPath) => readFile(artifactPath)));
    const secondModificationTimes = await Promise.all(second.artifactPaths.map(async (artifactPath) =>
      (await stat(artifactPath, { bigint: true })).mtimeNs
    ));

    assert.deepEqual(firstBytes, secondBytes);
    assert.deepEqual(firstModificationTimes, secondModificationTimes);
    assert.deepEqual((await readdir(path.join(runDir, "paper"))).sort(), [
      "claim-eligibility.json",
      "figures",
      "report-manifest.json",
      "report.md",
      "tables",
    ]);
    const report = await readFile(path.join(runDir, "paper", "report.md"), "utf8");
    assert.match(report, /^# H6 failure-gate experiment report/m);
    assert.match(report, new RegExp(`Raw study decision \\| ${statistics.studyDecision}`));
    assert.match(report, /Confirmatory claim status \| INELIGIBLE/);
    assert.match(report, /h6-task-07/);
    assert.match(report, /misleading-error-message/);
    assert.match(report, /All task means, intervals, and tests use task groups as the statistical unit\./);
    assert.doesNotMatch(report, new RegExp(runDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const eligibility = JSON.parse(
      await readFile(path.join(runDir, "paper", "claim-eligibility.json"), "utf8"),
    ) as { status: string; reasons: string[] };
    assert.deepEqual(eligibility, {
      status: "INELIGIBLE",
      reasons: ["REGISTERED_CONTRACT_MISMATCH", "INCOMPLETE_ROW_SET"],
    });

    const armTable = await readFile(path.join(runDir, "paper", "tables", "arm-outcomes.csv"), "utf8");
    assert.match(armTable, /model-a,[a-f0-9]{64},PRE_ACTION_FAILURE,2,0,0\.000000,1\.000000,2\.500000/);
    const effects = await readFile(path.join(runDir, "paper", "tables", "effects.csv"), "utf8");
    assert.match(effects, /TIMING,TURN_START_FAILURE,PRE_ACTION_FAILURE,1,CONFIRMATORY/);
    const cuts = await readFile(path.join(runDir, "paper", "tables", "task-cuts.csv"), "utf8");
    assert.equal(cuts, "hypothesis,taskId,reasons\n");

    for (const figure of ["arm-outcomes.svg", "effects.svg"]) {
      const svg = await readFile(path.join(runDir, "paper", "figures", figure), "utf8");
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.doesNotMatch(svg, /<script|javascript:/i);
    }
    const manifest = JSON.parse(
      await readFile(path.join(runDir, "paper", "report-manifest.json"), "utf8"),
    ) as {
      claimEligibility: { status: string; reasons: string[] };
      sourceArtifacts: Record<string, string>;
      generatedArtifacts: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.sourceArtifacts), [
      "MANIFEST.json",
      "audit.json",
      "decision-rule.json",
      "deviations.jsonl",
      "episodes.jsonl",
      "expected-design.json",
      "fact-pair-audit.json",
      "power.json",
      "run.json",
      "statistics.json",
    ]);
    assert.deepEqual(manifest.claimEligibility, eligibility);
    assert.equal(Object.keys(manifest.generatedArtifacts).length, 8);

    const auditBytes = await readFile(path.join(runDir, "audit.json"), "utf8");
    await context.test("tampered source artifacts are rejected before rendering", async () => {
      await writeFile(path.join(runDir, "audit.json"), `${auditBytes} `);
      await assert.rejects(
        () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
        /manifest supplemental artifact hash mismatch: audit\.json/,
      );
      await writeFile(path.join(runDir, "audit.json"), auditBytes);
    });

    await context.test("symlinked source artifact leaves are rejected before reading", async () => {
      const externalDir = await mkdtemp(path.join(os.tmpdir(), "h6-source-leaf-external-"));
      const externalAudit = path.join(externalDir, "audit.json");
      const auditPath = path.join(runDir, "audit.json");
      try {
        await writeFile(externalAudit, auditBytes);
        await rm(auditPath);
        await symlink(externalAudit, auditPath, "file");
        await assert.rejects(
          () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
          /symbolic link path is not allowed|artifact leaf must be a regular file/,
        );
      } finally {
        await rm(auditPath, { force: true });
        await writeFile(auditPath, auditBytes);
        await rm(externalDir, { recursive: true, force: true });
      }
    });

    await context.test("changed paper bytes are never overwritten", async () => {
      await writeFile(path.join(runDir, "paper", "report.md"), "forged report\n");
      await assert.rejects(
        () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
        /refuses to overwrite changed paper artifact/,
      );
      await rm(path.join(runDir, "paper"), { recursive: true, force: true });
    });

    await context.test("symlinked paper artifact leaves are rejected even when bytes are unchanged", async () => {
      const externalDir = await mkdtemp(path.join(os.tmpdir(), "h6-paper-leaf-external-"));
      const reportPath = path.join(runDir, "paper", "report.md");
      const externalReport = path.join(externalDir, "report.md");
      try {
        await writeRepeatedFailurePaperArtifacts({ runDir, dataset });
        await writeFile(externalReport, await readFile(reportPath));
        await rm(reportPath);
        await symlink(externalReport, reportPath, "file");
        await assert.rejects(
          () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
          /artifact leaf must be a regular file/,
        );
      } finally {
        await rm(path.join(runDir, "paper"), { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    });

    await context.test("symlinked paper directories are rejected before artifact writes", async () => {
      const externalDir = await mkdtemp(path.join(os.tmpdir(), "h6-paper-external-"));
      try {
        await symlink(externalDir, path.join(runDir, "paper"), "dir");
        await assert.rejects(
          () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
          /symbolic link path is not allowed/,
        );
        assert.deepEqual(await readdir(externalDir), []);
      } finally {
        await rm(path.join(runDir, "paper"), { recursive: true, force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    });

    await context.test("a forged audit model digest is ineligible", async () => {
      const forgedAudit = JSON.parse(auditBytes) as {
        modelProfiles: Array<{ modelDigest: string }>;
      };
      forgedAudit.modelProfiles[0]!.modelDigest = "d".repeat(64);
      await writeFile(path.join(runDir, "audit.json"), `${JSON.stringify(forgedAudit, null, 2)}\n`);
      await writeTestRunManifest(runDir, tracePaths);
      await writeRepeatedFailurePaperArtifacts({ runDir, dataset });
      const ineligible = JSON.parse(
        await readFile(path.join(runDir, "paper", "claim-eligibility.json"), "utf8"),
      ) as { status: string; reasons: string[] };
      assert.ok(ineligible.reasons.includes("MODEL_IDENTITY_MISMATCH"));
      await rm(path.join(runDir, "paper"), { recursive: true, force: true });
    });

    await context.test("a forged fake-driver pass artifact is ineligible", async () => {
      const fakeAudit = JSON.parse(auditBytes) as {
        fakeAgentContract: { status: string; deterministicDriverCount: number };
        modelProfiles: Array<{
          id: string;
          hash: string;
          modelDigest: string;
          tokenizerIdentity: string;
          tokenizerImplementation: string;
          driverKind: string;
        }>;
      };
      fakeAudit.fakeAgentContract.status = "NOT_APPLICABLE";
      fakeAudit.fakeAgentContract.deterministicDriverCount = 0;
      fakeAudit.modelProfiles = [{
        id: "model-a",
        hash: MODEL_HASH,
        modelDigest: MODEL_DIGEST,
        tokenizerIdentity: "test-tokenizer",
        tokenizerImplementation: "nfkc-whitespace-v1",
        driverKind: "deterministic-fake",
      }];
      await writeFile(path.join(runDir, "audit.json"), `${JSON.stringify(fakeAudit, null, 2)}\n`);
      await writeTestRunManifest(runDir, tracePaths);
      await writeRepeatedFailurePaperArtifacts({ runDir, dataset });
      const ineligible = JSON.parse(
        await readFile(path.join(runDir, "paper", "claim-eligibility.json"), "utf8"),
      ) as { status: string; reasons: string[] };
      assert.equal(ineligible.status, "INELIGIBLE");
      assert.ok(ineligible.reasons.includes("FAKE_DRIVER"));
    });

    await context.test("stale preregistration metadata is rejected", async () => {
      await rm(path.join(runDir, "paper"), { recursive: true, force: true });
      const staleRun = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as Record<string, unknown>;
      staleRun.preregistrationHash = "9".repeat(64);
      await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(staleRun, null, 2)}\n`);
      await writeTestRunManifest(runDir, tracePaths);
      await assert.rejects(
        () => writeRepeatedFailurePaperArtifacts({ runDir, dataset }),
        /preregistration does not match run metadata/,
      );
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
