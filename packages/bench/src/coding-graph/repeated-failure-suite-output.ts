import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import {
  type ActionIdentity,
  type ActionIntent,
  type ActionStrategyId,
  type CausalTrajectoryRecord,
  validateCausalTrajectoryRecord,
} from "@remnic/core/causal-trajectory";
import {
  PRE_ACTION_WARNING_VERSION,
  PreActionFailureGate,
  normalizeActionIntent,
} from "@remnic/core/coding/pre-action-gate";
import { z } from "zod";
import { aggregateTaskScores } from "../scorer.js";
import { captureBenchmarkExecutionProvenance, getRemnicVersion, writeBenchmarkResult } from "../reporter.js";
import { createSeededRandom } from "../seeded-random.js";
import {
  BENCHMARK_REPRO_MANIFEST_FILENAME,
  computeBenchmarkReproManifestArtifactHash,
  writeBenchmarkReproManifest,
  parseBenchmarkReproManifest,
  type BenchmarkReproManifest,
} from "../repro-manifest.js";
import type { BenchmarkMode, BenchmarkResult, ConfidenceInterval, TaskResult } from "../types.js";
import {
  H6BenchmarkDatasetSchema,
  H6_SUPPORT_ARTIFACT_PATHS,
  H6_FROZEN_INVENTORY_HASH,
  H6_FROZEN_SPLITS,
  BaseTaskSchema,
  TrapTaxonomyItemSchema,
  calculateJaccardSimilarity,
  tokenizeContent,
  computeH6InventoryHash,
  isSafeSyntheticPath,
  materializeTaskRepo,
  resolveCommittedH6FixtureDirectory,
  applyPatchAndCommit,
  type BaseTask,
  type H6BenchmarkDataset,
  type StrategyPatch,
  type SyntheticFile,
  type TaskVariant,
} from "./repo-gen/index.js";
import {
  createControlledResponsesAgentDriver,
  type ControlledGateDecision,
  type ControlledResponsesAgentDriverConfig,
  type ControlledResponsesCaps,
  type ControlledResponsesEpisodeResult,
  type ControlledResponsesToolDefinition,
  type RepeatedFailureActionEvaluator,
  type RepeatedFailureFinalRepoEvidence,
  type RepeatedFailureLocalToolHost,
  type RepeatedFailureToolExecutionResult,
} from "./repeated-failure-responses-driver.js";
import { firstRetryableHostFault, trimTrailingSlashes } from "./repeated-failure-driver-utils.js";
import {
  createRepeatedFailureOllamaChatDriver,
  validateOllamaChatEndpoint,
} from "./repeated-failure-ollama-chat-driver.js";
import {
  REPEATED_FAILURE_STATISTICS_DRAWS,
  analyzeRepeatedFailureRows,
  writeRepeatedFailureStatistics,
  type RepeatedFailureStatisticalAnalysis,
} from "./repeated-failure-stats.js";
import {
  RepeatedFailureRowStore,
  buildRepeatedFailureRowKey,
  parseRepeatedFailureEpisodeRow,
} from "./repeated-failure-store.js";
import {
  REPEATED_FAILURE_ARMS,
  type ReplayRepeatedFailureStatisticsOptions,
  type RepeatedFailureEpisodeDriver,
  type RepeatedFailureArm,
  type RepeatedFailureCliCommandResult,
  type RepeatedFailureEpisode,
  type RepeatedFailureEpisodeEvidence,
  type RepeatedFailureEpisodeRow,
  type RepeatedFailureExpectedDesign,
  type RepeatedFailureGateEvent,
  type RepeatedFailureIsolationIdentity,
  type RepeatedFailureProposedAction,
  type RepeatedFailureRowIdentity,
  type RepeatedFailureRunMetadata,
  type RepeatedFailureTokenUsage,
  type RunRepeatedFailureCliCommandInput,
  type RunRepeatedFailureSuiteOptions,
  type RunRepeatedFailureSuiteResult,
} from "./repeated-failure-types.js";

import {
  SHA256_PATTERN,
  FROZEN_DATASET_INVENTORY_HASH,
  FROZEN_SEEDS,
  REPEATED_FAILURE_ANALYSIS_VERSION,
  FIXED_RECORDED_AT,
  DEFAULT_CAPS,
  HISTORY_ACTION_SUMMARY,
  HISTORY_FAILURE_SUMMARY,
  HISTORY_SUCCESS_SUMMARY,
  HISTORY_FOLLOW_UP,
  PRIMARY_ARMS,
  TIMIDITY_ARMS,
  DEFAULT_TOOL_OUTPUT_CHARS,
  MAX_INSPECT_FILES,
  NEUTRAL_INSTRUCTION,
  PROMPT_CONTRACT,
  ArmManifestSchema,
  DecisionRuleSchema,
  ProfileInstructionsSchema,
  ProfileTokenizerSchema,
  OpenAiModelProfileSchema,
  OllamaChatModelProfileSchema,
  ModelProfileSchema,
  type RepeatedFailureModelProfile,
  type FixtureBundle,
  type HistoryTemplate,
  type FrozenHistory,
  type PlannedRow,
  type DesignArtifact,
  type CheckExecution,
  type NormalizedRunOptions,
  type RowExecutionOptions,
  type VerifiedPilotPower,
  type FactPairAuditPair,
  type FactPairAuditArtifact,
  type ParsedStrategyAction,
  buildFixtureToolDefinitions,
  FixtureToolHost,
  FixtureActionEvaluator,
  countFactTokens,
  runOfflineCheck,
  listRegularFiles,
  hashDirectory,
  containedRegularDirectory,
  containedRegularFile,
  containedPath,
  assertNoSymlinkComponents,
  identityFor,
  buildIsolation,
  noMatchGate,
  hostFaultResult,
  zeroTokens,
  finiteDuration,
  strictObject,
  failedTool,
  requiredString,
  boundedCode,
  sha256,
  stableStringify,
  canonicalize,
  readJson,
  publicError,
} from "./repeated-failure-suite-shared.js";
import {
  buildHistoryTemplate,
  freezeHistory,
  materializeArmMemory,
  renderFailureFact,
  renderSuccessFact,
  buildPrompt,
  turnStartFact,
  type TimingPayload,
  buildTimingPayload,
  auditFactPair,
  actionIdentityFor,
  pathShapeHash,
  actionShapeHash,
  armSemanticsAreValid,
  loadFixtureBundle,
  validateTaskManifest,
  normalizeRunOptions,
  writeFrozenRunArtifact,
  writeFinalRunArtifact,
  ensureDeviationsArtifact,
  assertSafeBenchmarkOutput,
  canonicalProspectivePath,
  isSameOrDescendant,
  pathExists,
  anyPathExists,
  assertResumeContract,
  parseRunMetadata,
  parseDesign,
  parseEpisodesJsonl,
  terminalEvidenceIsDurable,
} from "./repeated-failure-suite-execution.js";
import {
  assertCompleteRows,
  assertDesignRowsPresent,
  collectTaskRevisions,
  buildToolLocks,
  computeAnalysisHarnessHash,
  verifyResumeSourceIntegrity,
  verifyRunManifest,
  verifyPilotPower,
  parseComputedPilotPower,
  buildFactPairAudit,
  buildPowerArtifact,
  materializePowerExperiment,
  buildVerifiedPilotPowerArtifact,
} from "./repeated-failure-suite-analysis.js";

export interface TimingEvidenceSourceRow {
  row: RepeatedFailureEpisodeRow;
  timingPayload: Partial<TimingPayload> | null;
  turnStartFactHash: string | null;
  preActionFailureFactHash: string | null;
}

export function buildTimingEvidenceAudit(
  pairs: readonly FactPairAuditPair[],
  timingRows: readonly TimingEvidenceSourceRow[],
) {
  const rows = pairs.map((pair) => {
    const pairedRows = timingRows.filter((candidate) =>
      candidate.row.identity.taskId === pair.taskId
      && candidate.row.identity.variantId === pair.variantId
      && candidate.row.identity.seed === pair.seed
      && candidate.row.identity.modelProfileId === pair.modelProfileId
      && candidate.row.identity.modelProfileHash === pair.modelProfileHash
      && candidate.row.evidence?.historyHash === pair.historyHash
    );
    const turnStart = pairedRows.find(
      (candidate) => candidate.row.identity.arm === "TURN_START_FAILURE",
    );
    const preAction = pairedRows.find(
      (candidate) => candidate.row.identity.arm === "PRE_ACTION_FAILURE",
    );
    const baseline = turnStart?.timingPayload;
    const candidate = preAction?.timingPayload;
    const baselinePresent = turnStart !== undefined && baseline?.frame === "TURN_START";
    const injected = preAction?.row.evidence?.gate.status === "MATCH_WARN";
    const registeredFieldsMatch = baseline?.factId === pair.failureFactId
      && candidate?.factId === pair.failureFactId
      && baseline.citationHash === pair.failureCitationHash
      && candidate.citationHash === pair.failureCitationHash
      && baseline.factCount === 1
      && candidate.factCount === 1
      && typeof baseline.renderedTokenCount === "number"
      && Number.isSafeInteger(baseline.renderedTokenCount)
      && baseline.renderedTokenCount >= 0
      && baseline.renderedTokenCount === candidate.renderedTokenCount;
    const matches = pairedRows.length === 2
      && baselinePresent
      && injected
      && candidate?.frame === "PRE_ACTION"
      && turnStart.turnStartFactHash === pair.failureFactHash
      && preAction?.preActionFailureFactHash === pair.failureFactHash
      && registeredFieldsMatch;
    const status = !baselinePresent
      ? "MISMATCH"
      : !injected
        ? "UNINJECTED"
        : matches
          ? "MATCHED"
          : "MISMATCH";
    return {
      pairKey: pair.pairKey,
      turnStartRowKey: turnStart?.row.rowKey ?? null,
      preActionRowKey: preAction?.row.rowKey ?? null,
      baseline,
      candidate,
      expectedFactId: pair.failureFactId,
      expectedCitationHash: pair.failureCitationHash,
      expectedFactCount: 1,
      injected,
      status,
      matches: status === "UNINJECTED" ? null : matches,
    };
  });
  return {
    rows,
    injectedPairCount: rows.filter((row) => row.injected).length,
    uninjectedPairCount: rows.filter((row) => row.status === "UNINJECTED").length,
    allMatched: rows.every((row) => row.status !== "MISMATCH"),
  };
}

export async function buildRunAudit(input: {
  bundle: FixtureBundle;
  rows: readonly RepeatedFailureEpisodeRow[];
  design: DesignArtifact;
  metadata: RepeatedFailureRunMetadata;
  analysis: RepeatedFailureStatisticalAnalysis;
  factPairs: FactPairAuditArtifact;
  outputDir: string;
  drivers: readonly RepeatedFailureEpisodeDriver[];
}): Promise<Record<string, unknown>> {
  const expectedKeys = input.design.runOrder.map((row) => row.rowKey).sort();
  const actualKeys = input.rows.map((row) => row.rowKey).sort();
  const supportArtifacts = await Promise.all(H6_SUPPORT_ARTIFACT_PATHS.map(async (artifactPath) => {
    const actualHash = sha256(await readFile(path.join(input.bundle.fixtureDir, artifactPath)));
    const expectedHash = input.bundle.dataset.supportArtifactHashes[artifactPath];
    return { artifactPath, actualHash, expectedHash, matches: actualHash === expectedHash };
  }));
  const isolationIds = input.rows.flatMap((row) => row.isolation ? Object.values(row.isolation) : []);
  const traceDurability = await Promise.all(
    input.rows.map((row) => terminalEvidenceIsDurable(input.outputDir, row)),
  );
  const timingRows = await Promise.all(input.rows.filter(
    (row) => !row.identity.variantId.endsWith(":no-trap")
      && (row.identity.arm === "TURN_START_FAILURE" || row.identity.arm === "PRE_ACTION_FAILURE"),
  ).map(async (row) => {
    const trace = row.evidence
      ? JSON.parse(await readFile(containedPath(input.outputDir, row.evidence.traceArtifactPath), "utf8")) as {
        armAudit?: {
          timingPayload?: Partial<TimingPayload> | null;
          turnStartFactHash?: unknown;
          preActionFailureFactHash?: unknown;
        };
      }
      : {};
    return {
      row,
      timingPayload: trace.armAudit?.timingPayload ?? null,
      turnStartFactHash: typeof trace.armAudit?.turnStartFactHash === "string"
        ? trace.armAudit.turnStartFactHash
        : null,
      preActionFailureFactHash: typeof trace.armAudit?.preActionFailureFactHash === "string"
        ? trace.armAudit.preActionFailureFactHash
        : null,
    };
  }));
  const timingEvidence = buildTimingEvidenceAudit(input.factPairs.pairs, timingRows);
  const primaryCellHashes = new Map<string, Set<string>>();
  for (const row of input.rows.filter((candidate) => !candidate.identity.variantId.endsWith(":no-trap"))) {
    const cell = stableStringify({
      taskId: row.identity.taskId,
      variantId: row.identity.variantId,
      seed: row.identity.seed,
      modelProfileId: row.identity.modelProfileId,
      modelProfileHash: row.identity.modelProfileHash,
    });
    const hashes = primaryCellHashes.get(cell) ?? new Set<string>();
    if (row.evidence) hashes.add(row.evidence.startRepoHash);
    primaryCellHashes.set(cell, hashes);
  }
  const fakeRun = input.drivers.every((driver) => driver.driverKind === "deterministic-fake");
  const fakeContractPassed = input.rows.every((row) => row.status === "VALID")
    && input.rows.filter((row) => !row.identity.variantId.endsWith(":no-trap")
      && row.identity.arm === "NO_MEMORY").every((row) => row.finalState === "TRAPPED")
    && input.rows.filter((row) => row.identity.variantId.endsWith(":no-trap"))
      .every((row) => row.finalState === "NO_TRAP");
  const primaryCuts = input.analysis.cuts.filter(
    (cut) => cut.hypothesis === "TIMING" || cut.hypothesis === "CONTENT",
  );
  const timidityCuts = input.analysis.cuts.filter((cut) => cut.hypothesis === "TIMIDITY");
  const deviationLines = (await readFile(path.join(input.outputDir, "deviations.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  for (const line of deviationLines) {
    const deviation = JSON.parse(line) as unknown;
    if (!deviation || typeof deviation !== "object" || Array.isArray(deviation)) {
      throw new Error("deviations artifact contains a malformed entry");
    }
  }
  const expectedNoTrapKeys = new Set(input.design.timidity.rows.map(buildRepeatedFailureRowKey));
  const noTrapRows = input.rows.filter((row) => expectedNoTrapKeys.has(row.rowKey));
  const noTrapPassed = expectedNoTrapKeys.size > 0
    && noTrapRows.length === expectedNoTrapKeys.size
    && noTrapRows.every((row) =>
      row.status === "VALID"
      && row.finalState === "NO_TRAP"
      && row.taskPassed
    );
  return {
    schemaVersion: 1,
    runContract: {
      datasetInventoryHash: input.metadata.datasetInventoryHash,
      decisionRuleHash: input.metadata.decisionRuleHash,
      preregistrationHash: input.metadata.preregistrationHash,
      preregistrationPath: input.metadata.preregistrationPath,
      analysisVersion: input.metadata.analysisVersion,
      harnessVersion: input.metadata.harnessVersion,
      harnessSourceHash: input.metadata.harnessSourceHash,
      provenanceHash: input.metadata.provenanceHash,
      modelProfiles: input.metadata.modelProfileIds.map((id, index) => ({
        id,
        hash: input.metadata.modelProfileHashes[index],
        modelDigest: input.metadata.modelDigests[index],
        tokenizerIdentity: input.metadata.modelTokenizerIdentities[index],
        tokenizerImplementation: input.metadata.modelTokenizerImplementations[index],
      })),
      trapAudit: input.bundle.decisionRule.trapAudit,
    },
    dataset: {
      version: input.bundle.dataset.version,
      inventoryHash: input.bundle.dataset.inventoryHash,
      taskCount: input.bundle.dataset.tasks.length,
      variantCount: input.bundle.dataset.tasks.reduce((sum, task) => sum + task.variants.length, 0),
      splitCounts: Object.fromEntries(
        Object.entries(input.bundle.dataset.splits).map(([split, ids]) => [split, ids.length]),
      ),
      supportArtifacts,
      supportArtifactsMatch: supportArtifacts.every((artifact) => artifact.matches),
    },
    expectedDesign: {
      expectedRows: expectedKeys.length,
      terminalRows: actualKeys.length,
      exactRowSet: stableStringify(expectedKeys) === stableStringify(actualKeys),
    },
    factPairs: {
      pairCount: input.factPairs.pairs.length,
      allMatched: input.factPairs.pairs.every((pair) => pair.status === "MATCHED"),
    },
    isolation: {
      expectedIdentityCount: input.rows.length * 7,
      observedIdentityCount: isolationIds.length,
      uniqueIdentityCount: new Set(isolationIds).size,
      allUnique: isolationIds.length === input.rows.length * 7
        && new Set(isolationIds).size === input.rows.length * 7,
      primaryStartHashesMatchWithinCells: [...primaryCellHashes.values()].every((hashes) => hashes.size === 1),
    },
    timingEvidence,
    fakeAgentContract: {
      status: fakeRun ? (fakeContractPassed ? "PASS" : "FAIL") : "NOT_APPLICABLE",
      deterministicDriverCount: input.drivers.filter(
        (driver) => driver.driverKind === "deterministic-fake",
      ).length,
    },
    modelProfiles: input.drivers.map((driver) => ({
      id: driver.modelProfileId,
      hash: driver.modelProfileHash,
      modelDigest: driver.modelDigest,
      tokenizerIdentity: driver.tokenizer.identity,
      tokenizerImplementation: driver.tokenizer.implementation,
      driverKind: driver.driverKind ?? "unknown",
    })),
    noTrap: {
      expectedRows: expectedNoTrapKeys.size,
      observedRows: noTrapRows.length,
      allPassed: noTrapPassed,
    },
    deviations: {
      count: deviationLines.length,
      none: deviationLines.length === 0,
    },
    traces: {
      expectedCount: input.rows.length,
      durableCount: traceDurability.filter(Boolean).length,
      allDurable: traceDurability.length === input.rows.length && traceDurability.every(Boolean),
    },
    cuts: { primary: primaryCuts, timidity: timidityCuts },
  };
}

export function projectConfidenceIntervals(
  analysis: RepeatedFailureStatisticalAnalysis,
): Record<string, ConfidenceInterval> {
  const projected: Record<string, ConfidenceInterval> = {};
  const add = (
    key: string,
    interval: { lower: number | null; upper: number | null; level: number } | null,
  ): void => {
    if (!interval || interval.lower === null || interval.upper === null) return;
    projected[key] = {
      lower: interval.lower,
      upper: interval.upper,
      level: interval.level,
    };
  };
  add("timing_repeated_failure_benefit", analysis.timing.repeatedFailureBenefitInterval);
  add("timing_relative_risk_reduction", analysis.timing.relativeRiskReductionInterval);
  add("content_repeated_failure_benefit", analysis.content.repeatedFailureBenefitInterval);
  add("content_task_pass_benefit", analysis.content.taskPassBenefitInterval);
  return projected;
}

export async function projectBenchmarkResult(
  rows: readonly RepeatedFailureEpisodeRow[],
  metadata: RepeatedFailureRunMetadata,
  analysis: RepeatedFailureStatisticalAnalysis,
  now: () => Date,
  gitDirtyEntryCount: number,
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = rows.map((row) => {
    const scores: Record<string, number> = row.status === "VALID"
      ? {
          valid: 1,
          repeated_failure: row.repeatedFailure ? 1 : 0,
          task_pass: row.taskPassed ? 1 : 0,
          warning: (row.warningCount ?? 0) > 0 ? 1 : 0,
          false_warning: (row.falseWarningCount ?? 0) > 0 ? 1 : 0,
        }
      : { valid: 0 };
    return {
      taskId: row.rowKey,
      question: `${row.identity.taskId}/${row.identity.variantId}/${row.identity.arm}`,
      expected: row.identity.variantId.endsWith(":no-trap") ? "NO_TRAP" : "FIXED",
      actual: row.finalState,
      scores,
      latencyMs: row.durationMs,
      tokens: { input: row.tokens.input, output: row.tokens.output },
      details: {
        identity: row.identity,
        finalState: row.finalState,
        tryCount: row.tryCount,
        usage: { ...row.tokens },
        traceArtifactPath: row.evidence?.traceArtifactPath,
      },
    };
  });
  const tokenUsage = zeroTokens();
  for (const row of rows) {
    tokenUsage.input += row.tokens.input;
    tokenUsage.output += row.tokens.output;
    tokenUsage.total += row.tokens.total;
    tokenUsage.cachedInput += row.tokens.cachedInput;
    tokenUsage.cacheWriteInput += row.tokens.cacheWriteInput;
    tokenUsage.reasoningOutput += row.tokens.reasoningOutput;
  }
  if (Object.values(tokenUsage).some((value) => !Number.isSafeInteger(value))) {
    throw new Error("benchmark token totals exceed the safe integer range");
  }
  const totalLatencyMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
  return {
    meta: {
      id: metadata.runId,
      benchmark: "h6-repeated-failure",
      benchmarkTier: "remnic",
      version: metadata.suiteVersion,
      remnicVersion: await getRemnicVersion(),
      gitSha: metadata.gitSha,
      runId: metadata.runId,
      gitDirty: metadata.gitDirty,
      gitDirtyEntryCount,
      timestamp: now().toISOString(),
      mode: metadata.mode,
      runCount: 1,
      seeds: [...metadata.seeds],
      datasetHash: metadata.datasetInventoryHash,
      status: "complete",
    },
    config: {
      runtimeProfile: null,
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "controlled-responses-pre-action",
      remnicConfig: {},
      benchmarkOptions: {
        modelProfiles: metadata.modelProfileIds.map(
          (id, index) => ({
            id,
            hash: metadata.modelProfileHashes[index],
            modelDigest: metadata.modelDigests[index],
          }),
        ),
        resumeContractHash: metadata.resumeContractHash,
        expectedDesignHash: metadata.expectedDesignHash,
        statisticsArtifactPath: "statistics.json",
        statisticsSeed: analysis.seed,
        statisticsDraws: analysis.draws,
        statisticsAlpha: analysis.alpha,
        tokenUsage: { ...tokenUsage },
        decisions: analysis.decisions,
        studyDecision: analysis.studyDecision,
        taskCuts: analysis.cuts,
      },
    },
    cost: {
      totalTokens: tokenUsage.total,
      inputTokens: tokenUsage.input,
      outputTokens: tokenUsage.output,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: rows.length === 0 ? 0 : totalLatencyMs / rows.length,
      judgeModelCalls: 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
      statistics: {
        confidenceIntervals: projectConfidenceIntervals(analysis),
        bootstrapSamples: analysis.draws,
      },
    },
    environment: { os: process.platform, nodeVersion: process.version },
  };
}

export async function writeTrace(
  outputDir: string,
  rowKey: string,
  attempt: number,
  value: unknown,
): Promise<{ path: string; hash: string }> {
  const relative = `traces/${rowKey}/attempt-${attempt}.json`;
  const filePath = containedPath(outputDir, relative);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, serialized);
  return { path: relative, hash: sha256(serialized) };
}

export async function listSupplementalArtifacts(
  outputDir: string,
  resultPath: string,
): Promise<string[]> {
  const excluded = new Set([
    path.resolve(resultPath),
    path.resolve(outputDir, "MANIFEST.json"),
  ]);
  return (await listRegularFiles(outputDir, false))
    .filter((file) => !excluded.has(path.resolve(file)))
    .sort();
}

export interface ModelProfileExecutionContract {
  schemaVersion: 1;
  datasetInventoryHash: string;
  prompt: typeof PROMPT_CONTRACT;
  tools: readonly {
    taskId: string;
    variantId: string;
    definitions: readonly {
      type: "function";
      name: string;
      description: string;
      strict: true;
      parameters: Readonly<Record<string, unknown>>;
    }[];
  }[];
  tokenizerUse: "content-pair-counts-and-timing-rendered-counts";
  decodingAndContext: {
    caps: ControlledResponsesCaps;
    maxToolOutputChars: number;
    fingerprintVersion: 1;
    preActionWarningVersion: number;
  };
}

export function buildModelProfileExecutionContract(
  bundle: FixtureBundle,
  caps: ControlledResponsesCaps,
  maxToolOutputChars: number,
): ModelProfileExecutionContract {
  return {
    schemaVersion: 1,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    prompt: PROMPT_CONTRACT,
    tools: bundle.dataset.tasks.flatMap((task) => task.variants.map((variant) => ({
      taskId: task.id,
      variantId: variant.variantId,
      definitions: buildFixtureToolDefinitions(task, variant).map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        strict: true as const,
        parameters: tool.inputSchema,
      })),
    }))),
    tokenizerUse: "content-pair-counts-and-timing-rendered-counts",
    decodingAndContext: {
      caps,
      maxToolOutputChars,
      fingerprintVersion: 1,
      preActionWarningVersion: PRE_ACTION_WARNING_VERSION,
    },
  };
}

export function canonicalizeModelProfile(input: unknown): RepeatedFailureModelProfile {
  const profile = ModelProfileSchema.parse(input);
  if (profile.provider === "ollama-chat") {
    return { ...profile, endpoint: validateOllamaChatEndpoint(profile.endpoint) };
  }
  return {
    ...profile,
    ...(profile.endpoint ? { endpoint: validateEndpoint(profile.endpoint) } : {}),
  };
}

export function bindProfileRequestTimeout(
  driver: RepeatedFailureEpisodeDriver,
  requestTimeoutMs: number,
): RepeatedFailureEpisodeDriver {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be a positive safe integer");
  }
  return Object.freeze({
    ...driver,
    ...(driver.preflight ? { preflight: () => driver.preflight!() } : {}),
    runEpisode: (request: Parameters<RepeatedFailureEpisodeDriver["runEpisode"]>[0]) => driver.runEpisode({
      ...request,
      caps: { ...request.caps, requestTimeoutMs },
    }),
  });
}

const registeredProfileDrivers = new WeakMap<object, string>();

export function isRegisteredProfileDriver(
  driver: RepeatedFailureEpisodeDriver,
  executionContract: ModelProfileExecutionContract,
): boolean {
  return registeredProfileDrivers.get(driver) === sha256(stableStringify(executionContract));
}

export function createRepeatedFailureProfileDriver(
  profile: RepeatedFailureModelProfile,
  executionContract: ModelProfileExecutionContract,
  apiKey?: string,
): RepeatedFailureEpisodeDriver {
  profile = canonicalizeModelProfile(profile);
  const hash = computeRepeatedFailureModelProfileHash(profile, executionContract);
  if (profile.provider === "ollama-chat") {
    const driver = bindProfileRequestTimeout(createRepeatedFailureOllamaChatDriver({
      model: profile.model,
      modelProfileId: profile.id,
      modelProfileHash: hash,
      modelDigest: profile.modelDigest,
      developerInstructions: [
        `System instruction:\n${profile.instructions.system}`,
        `Developer instruction:\n${profile.instructions.developer}`,
      ].join("\n\n"),
      endpoint: validateOllamaChatEndpoint(profile.endpoint),
      requestTimeoutMs: profile.requestTimeoutMs,
      seedCapability: profile.seedCapability,
      tokenizer: Object.freeze({ ...profile.tokenizer }),
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      contextWindowTokens: profile.contextWindowTokens,
      ...(profile.think === undefined ? {} : { think: profile.think }),
    }), profile.requestTimeoutMs);
    registeredProfileDrivers.set(driver, sha256(stableStringify(executionContract)));
    return driver;
  }
  const driver = bindProfileRequestTimeout(createControlledResponsesAgentDriver({
    model: profile.model,
    modelProfileId: profile.id,
    modelProfileHash: hash,
    modelDigest: profile.modelDigest,
    developerInstructions: profile.instructions.developer,
    tokenizer: Object.freeze({ ...profile.tokenizer }),
    apiKey,
    instructions: profile.instructions.system,
    ...(profile.endpoint ? { baseUrl: validateEndpoint(profile.endpoint) } : {}),
    ...(profile.seedCapability ? { seedCapability: profile.seedCapability } : {}),
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  } satisfies ControlledResponsesAgentDriverConfig), profile.requestTimeoutMs);
  registeredProfileDrivers.set(driver, sha256(stableStringify(executionContract)));
  return driver;
}

export function computeRepeatedFailureModelProfileHash(
  input: unknown,
  executionContract: unknown,
): string {
  const profile = canonicalizeModelProfile(input);
  return sha256(stableStringify({ profile, executionContract }));
}

export async function loadModelProfile(
  profilePath: string,
  executionContract: ModelProfileExecutionContract,
): Promise<{ profile: RepeatedFailureModelProfile; hash: string }> {
  const profile = canonicalizeModelProfile(
    JSON.parse(await readFile(path.resolve(profilePath), "utf8")),
  );
  if (
    profile.provider === "openai-responses"
    && profile.seedCapability
    && !profile.endpoint
  ) {
    throw new Error("seedCapability requires an explicit nonstandard Responses endpoint");
  }
  if (
    profile.contextWindowTokens < executionContract.decodingAndContext.caps.maxTotalTokens
    || profile.contextWindowTokens < profile.maxOutputTokens
  ) {
    throw new Error("profile contextWindowTokens cannot satisfy the frozen token caps");
  }
  return {
    profile,
    hash: computeRepeatedFailureModelProfileHash(profile, executionContract),
  };
}

export function validateEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("profile endpoint cannot contain credentials, query, or fragment");
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("profile endpoint must use HTTPS or loopback HTTP");
  }
  return trimTrailingSlashes(endpoint.toString());
}
