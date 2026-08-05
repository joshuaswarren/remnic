import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { compareCodePoints } from "../codepoint-order.js";
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
import { firstRetryableHostFault } from "./repeated-failure-driver-utils.js";
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
  type RepeatedFailureRowClaim,
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
  type HistoryTemplate,
  type FrozenHistory,
  type PlannedRow,
  type CheckExecution,
  type RowExecutionOptions,
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
  writeFrozenRunArtifact,
  writeFinalRunArtifact,
  ensureDeviationsArtifact,
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
  verifyRunManifest,
  parseComputedPilotPower,
  buildFactPairAudit,
  buildPowerArtifact,
  materializePowerExperiment,
  buildVerifiedPilotPowerArtifact,
} from "./repeated-failure-suite-analysis.js";
import {
  buildRunAudit,
  projectConfidenceIntervals,
  projectBenchmarkResult,
  writeTrace,
  listSupplementalArtifacts,
  type ModelProfileExecutionContract,
  buildModelProfileExecutionContract,
  canonicalizeModelProfile,
  createRepeatedFailureProfileDriver,
  computeRepeatedFailureModelProfileHash,
  loadModelProfile,
  validateEndpoint,
} from "./repeated-failure-suite-output.js";
import { prepareRepeatedFailureSuite } from "./repeated-failure-suite-preparation.js";

export {
  buildDesign,
  buildPlans,
  resolvePackagedPreregistrationRoot,
  verifyPreregistrationBinding,
} from "./repeated-failure-suite-preparation.js";



export async function runRepeatedFailureSuite(
  options: RunRepeatedFailureSuiteOptions,
): Promise<RunRepeatedFailureSuiteResult> {
  const {
    bundle,
    configuration,
    provenance,
    harnessVersion,
    harnessSourceHash,
    verifiedTrapAudits,
    pilotPower,
    plans,
    design,
  } = await prepareRepeatedFailureSuite(options);
  const templates = new Map<string, HistoryTemplate>();
  const expectedDesignHash = sha256(stableStringify(design));
  const decisionRuleHash = sha256(bundle.decisionRuleBytes);
  const taskRevisions = collectTaskRevisions(plans);
  const toolLocks = buildToolLocks(plans, configuration.maxToolOutputChars);
  const provenanceHash = sha256(stableStringify({
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    harnessVersion,
    harnessSourceHash,
    gitSha: provenance.gitSha,
    gitDirty: provenance.gitDirty,
    gitDirtyEntryCount: provenance.gitDirtyEntryCount,
  }));
  const pilotEvidence = pilotPower ? {
    runId: pilotPower.runId,
    manifestArtifactHash: pilotPower.manifestArtifactHash,
    powerArtifactHash: pilotPower.powerArtifactHash,
  } : undefined;
  const trapAuditReceipts = verifiedTrapAudits.map((artifact) => {
    const driver = configuration.drivers.find(
      (candidate) =>
        candidate.modelProfileId === artifact.modelProfileId
        && candidate.modelProfileHash === artifact.modelProfileHash
        && candidate.modelDigest === artifact.modelDigest,
    );
    if (!driver) throw new Error("verified trap audit has no matching model driver");
    return {
      path: `trap-audit-${artifact.artifactHash}.json`,
      artifactHash: artifact.artifactHash,
      modelProfileId: artifact.modelProfileId,
      modelProfileHash: artifact.modelProfileHash,
      modelDigest: artifact.modelDigest,
      tokenizerIdentity: driver.tokenizer.identity,
      tokenizerImplementation: driver.tokenizer.implementation,
    };
  });
  const resumeContractHash = sha256(stableStringify({
    suiteVersion: bundle.suiteVersion,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    expectedDesignHash,
    decisionRuleHash,
    preregistrationPath: bundle.decisionRule.preregistration.path,
    preregistrationHash: bundle.decisionRule.preregistration.sha256,
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    harnessVersion,
    harnessSourceHash,
    provenanceHash,
    mode: options.mode,
    arms: PRIMARY_ARMS,
    modelProfiles: configuration.drivers.map((driver) => ({
      id: driver.modelProfileId,
      hash: driver.modelProfileHash,
      modelDigest: driver.modelDigest,
      driverKind: driver.driverKind ?? "unknown",
      tokenizerIdentity: driver.tokenizer.identity,
      tokenizerImplementation: driver.tokenizer.implementation,
    })),
    seeds: configuration.seeds,
    splitTaskIds: configuration.taskIds,
    runOrder: design.runOrder,
    caps: configuration.caps,
    maxHostRetries: configuration.maxHostRetries,
    maxToolOutputChars: configuration.maxToolOutputChars,
    statisticsSeed: configuration.statisticsSeed,
    statisticsDraws: configuration.statisticsDraws,
    phase: configuration.phase,
    taskRevisions,
    toolLocks,
    pilotEvidence,
    trapAuditReceipts,
  }));
  const runId = options.runId ?? `h6-${resumeContractHash.slice(0, 24)}`;
  const metadata: RepeatedFailureRunMetadata = {
    schemaVersion: 1,
    runId,
    suiteVersion: bundle.suiteVersion,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    resumeContractHash,
    expectedDesignHash,
    decisionRuleHash,
    preregistrationPath: bundle.decisionRule.preregistration.path,
    preregistrationHash: bundle.decisionRule.preregistration.sha256,
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    harnessVersion,
    harnessSourceHash,
    provenanceHash,
    gitSha: provenance.gitSha,
    gitDirty: provenance.gitDirty,
    gitDirtyEntryCount: provenance.gitDirtyEntryCount,
    phase: configuration.phase,
    ...(pilotEvidence ? { pilotEvidence } : {}),
    mode: options.mode,
    arms: PRIMARY_ARMS,
    modelProfileIds: configuration.drivers.map((driver) => driver.modelProfileId),
    modelProfileHashes: configuration.drivers.map((driver) => driver.modelProfileHash),
    modelDigests: configuration.drivers.map((driver) => driver.modelDigest),
    modelDriverKinds: configuration.drivers.map((driver) => driver.driverKind ?? "unknown"),
    modelTokenizerIdentities: configuration.drivers.map((driver) => driver.tokenizer.identity),
    modelTokenizerImplementations: configuration.drivers.map((driver) => driver.tokenizer.implementation),
    trapAuditReceipts,
    seeds: configuration.seeds,
    splitTaskIds: configuration.taskIds,
    taskRevisions,
    caps: { ...configuration.caps, maxToolOutputChars: configuration.maxToolOutputChars },
    toolLocks,
    sandboxFlags: {
      networkDisabled: true,
      isolatedRepoPerArm: true,
      isolatedMemoryPerArm: true,
      isolatedSessionPerArm: true,
      rejectSymlinks: true,
    },
    retryRule: {
      hostApiFaultRetriesAfterFirstTry: configuration.maxHostRetries,
      rerunTaskResults: false,
      retainAllTries: true,
    },
    runOrder: design.runOrder,
    expectedRowCount: plans.length,
    statisticsSeed: configuration.statisticsSeed,
    statisticsDraws: configuration.statisticsDraws,
  };
  await mkdir(configuration.outputDir, { recursive: true });
  await assertResumeContract(configuration.outputDir, metadata, options.resume === true);
  const runMetadataPath = path.join(configuration.outputDir, "run.json");
  await writeFrozenRunArtifact(
    runMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    options.resume === true,
  );
  for (const [index, receipt] of trapAuditReceipts.entries()) {
    await writeFrozenRunArtifact(
      path.join(configuration.outputDir, receipt.path),
      `${JSON.stringify(verifiedTrapAudits[index], null, 2)}\n`,
      options.resume === true,
    );
  }
  const expectedDesignPath = path.join(configuration.outputDir, "expected-design.json");
  await writeFrozenRunArtifact(
    expectedDesignPath,
    `${JSON.stringify(design, null, 2)}\n`,
    options.resume === true,
  );
  const decisionRulePath = path.join(configuration.outputDir, "decision-rule.json");
  await writeFrozenRunArtifact(decisionRulePath, bundle.decisionRuleBytes, options.resume === true);
  const deviationsPath = path.join(configuration.outputDir, "deviations.jsonl");
  await ensureDeviationsArtifact(deviationsPath, options.resume === true);
  const store = new RepeatedFailureRowStore(configuration.outputDir);
  let completed = 0;
  let resumed = 0;

  for (const plan of plans) {
    const driver = configuration.drivers.find(
      (candidate) => candidate.modelProfileId === plan.identity.modelProfileId
        && candidate.modelProfileHash === plan.identity.modelProfileHash,
    );
    if (!driver) throw new Error(`Missing driver for ${plan.identity.modelProfileId}`);
    const existing = await store.load(plan.identity);
    if (existing.kind !== "MISSING") {
      if (options.resume !== true) throw new Error(`Repeated-failure row already exists: ${plan.identity.taskId}`);
      if (existing.kind === "MALFORMED") {
        throw new Error(`Malformed repeated-failure checkpoint: ${existing.error.message}`, {
          cause: existing.error,
        });
      }
      if (existing.kind === "VALID") {
        await store.verifyAttemptTraceArtifacts(existing.checkpoint);
        if (existing.checkpoint.terminal) {
          if (await terminalEvidenceIsDurable(configuration.outputDir, existing.checkpoint.terminal)) {
            resumed += 1;
            continue;
          }
          throw new Error(`terminal trace artifact is missing or drifted: ${existing.checkpoint.rowKey}`);
        }
      }
    }
    const templateKey = `${plan.task.id}\u0000${plan.variant.variantId}`;
    let template = templates.get(templateKey);
    if (!template) {
      template = await buildHistoryTemplate(plan.task, plan.variant);
      templates.set(templateKey, template);
    }
    await executePlannedRow(
      plan,
      driver,
      freezeHistory(template, plan.identity),
      store,
      configuration,
    );
    completed += 1;
  }

  await store.awaitClaimsReleased();
  const rows = await store.compileRows();
  assertCompleteRows(rows, plans);
  const episodesPath = await store.writeEpisodesJsonl();
  for (const plan of plans) {
    const templateKey = `${plan.task.id}\u0000${plan.variant.variantId}`;
    if (!templates.has(templateKey)) {
      templates.set(templateKey, await buildHistoryTemplate(plan.task, plan.variant));
    }
  }
  const factPairAudit = await buildFactPairAudit(plans, templates, configuration.drivers);
  const factPairAuditPath = path.join(configuration.outputDir, "fact-pair-audit.json");
  await writeFinalRunArtifact(
    factPairAuditPath,
    `${JSON.stringify(factPairAudit, null, 2)}\n`,
    options.resume === true,
  );
  const analysis = analyzeRepeatedFailureRows(rows, {
    expectedDesign: design.primary,
    timidityDesign: design.timidity,
    seed: configuration.statisticsSeed,
    draws: configuration.statisticsDraws,
    alpha: bundle.decisionRule.analysis.alpha,
    timingMinimumRrr: bundle.decisionRule.hypotheses["H6-timing"].minimumRelativeRiskReduction,
    timingMinimumAbsoluteBenefit:
      bundle.decisionRule.hypotheses["H6-timing"].minimumAbsoluteRepeatedFailureBenefit,
    timingMinimumBenefitIntervalLower:
      bundle.decisionRule.hypotheses["H6-timing"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
    contentMinimumRepeatedFailureBenefitIntervalLower:
      bundle.decisionRule.hypotheses["H6-content"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
    contentMinimumTaskPassBenefitIntervalLower:
      bundle.decisionRule.hypotheses["H6-content"].requireTaskPassBenefitIntervalLowerStrictlyAbove,
    timidityPassMargin: bundle.decisionRule.timidity.passRateMargin,
    timidityStepsMargin: bundle.decisionRule.timidity.stepsMargin,
  });
  const statisticsPath = await writeRepeatedFailureStatistics(configuration.outputDir, analysis);
  const episodesHash = sha256(await readFile(episodesPath));
  const expectedDesignArtifactHash = sha256(await readFile(expectedDesignPath));
  const primaryCuts = analysis.cuts.filter(
    (cut) => cut.hypothesis === "TIMING" || cut.hypothesis === "CONTENT",
  );
  const powerArtifact = primaryCuts.length > 0
    ? {
        schemaVersion: 1,
        status: "NOT_ESTIMABLE",
        phase: configuration.phase,
        reason: "primary task cuts make the confirmatory run not estimable",
        cuts: primaryCuts,
        source: {
          episodesHash,
          expectedDesignHash: expectedDesignArtifactHash,
          decisionRuleHash,
        },
        ...(pilotPower ? {
          pilotRunId: pilotPower.runId,
          pilotManifestArtifactHash: pilotPower.manifestArtifactHash,
          pilotPowerArtifactHash: pilotPower.powerArtifactHash,
        } : {}),
      }
    : pilotPower
      ? buildVerifiedPilotPowerArtifact(pilotPower)
      : buildPowerArtifact(
          rows,
          configuration,
          options.mode,
          analysis,
          bundle.decisionRule,
          {
            episodesHash,
            expectedDesignHash: expectedDesignArtifactHash,
            decisionRuleHash,
          },
        );
  const powerPath = path.join(configuration.outputDir, "power.json");
  await writeFinalRunArtifact(
    powerPath,
    `${JSON.stringify(powerArtifact, null, 2)}\n`,
    options.resume === true,
  );
  const auditPath = path.join(configuration.outputDir, "audit.json");
  const audit = {
    ...await buildRunAudit({
      bundle,
      rows,
      design,
      metadata,
      analysis,
      factPairs: factPairAudit,
      outputDir: configuration.outputDir,
      drivers: configuration.drivers,
    }),
    decision: analysis.studyDecision,
  };
  await writeFinalRunArtifact(
    auditPath,
    `${JSON.stringify(audit, null, 2)}\n`,
    options.resume === true,
  );
  const result = await projectBenchmarkResult(
    rows,
    metadata,
    analysis,
    configuration.now,
    provenance.gitDirtyEntryCount,
  );
  const resultPath = await writeBenchmarkResult(result, configuration.outputDir);
  const manifestPath = await writeBenchmarkReproManifest(configuration.outputDir, {
    resultPaths: [resultPath],
    runId,
    selectedBenchmarks: ["h6-repeated-failure"],
    runtimeProfiles: configuration.drivers.map(
      (driver) => `${driver.modelProfileId}@${driver.modelProfileHash}`,
    ),
    selectedWorkItems: configuration.drivers.map((driver) => ({
      benchmark: "h6-repeated-failure",
      runtimeProfile: `${driver.modelProfileId}@${driver.modelProfileHash}`,
    })),
    mode: options.mode,
    seed: configuration.statisticsSeed,
    command: { cwd: ".", argv: [] },
    supplementalArtifactPaths: await listSupplementalArtifacts(configuration.outputDir, resultPath),
    publicSafe: true,
    generatedAt: result.meta.timestamp,
  });
  return {
    result,
    resultPath,
    episodesPath,
    statisticsPath,
    runMetadataPath,
    expectedDesignPath,
    factPairAuditPath,
    powerPath,
    auditPath,
    deviationsPath,
    decisionRulePath,
    manifestPath,
    completed,
    resumed,
    invalid: rows.filter((row) => row.status === "INVALID").length,
  };
}

export async function replayRepeatedFailureStatistics(
  options: ReplayRepeatedFailureStatisticsOptions,
): Promise<RepeatedFailureCliCommandResult> {
  try {
    const runDir = path.resolve(options.runDir);
    await verifyRunManifest(runDir);
    const metadata = parseRunMetadata(JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")));
    const harnessVersion = await getRemnicVersion();
    const harnessSourceHash = await computeAnalysisHarnessHash();
    const provenance = captureBenchmarkExecutionProvenance();
    const provenanceHash = sha256(stableStringify({
      analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
      harnessVersion,
      harnessSourceHash,
      gitSha: provenance.gitSha,
      gitDirty: provenance.gitDirty,
      gitDirtyEntryCount: provenance.gitDirtyEntryCount,
    }));
    if (
      metadata.phase !== "unspecified"
      && (metadata.modelDigests.length !== 2 || new Set(metadata.modelDigests).size !== 2)
    ) {
      throw new Error("registered H6 replay requires two distinct served model digests");
    }
    if (
      metadata.analysisVersion !== REPEATED_FAILURE_ANALYSIS_VERSION
      || metadata.harnessVersion !== harnessVersion
      || metadata.harnessSourceHash !== harnessSourceHash
      || metadata.provenanceHash !== provenanceHash
    ) {
      throw new Error("analysis or harness provenance drifted since execution");
    }
    const decisionRuleBytes = await readFile(path.join(runDir, "decision-rule.json"), "utf8");
    if (sha256(decisionRuleBytes) !== metadata.decisionRuleHash) {
      throw new Error("frozen decision-rule hash does not match run metadata");
    }
    const decisionRule = DecisionRuleSchema.parse(JSON.parse(decisionRuleBytes));
    if (
      decisionRule.analysis.bootstrap.draws !== metadata.statisticsDraws
      || decisionRule.analysis.shuffle.draws !== metadata.statisticsDraws
    ) {
      throw new Error("frozen decision-rule analysis draws do not match run metadata");
    }
    const design = parseDesign(JSON.parse(await readFile(path.join(runDir, "expected-design.json"), "utf8")));
    if (sha256(stableStringify(design)) !== metadata.expectedDesignHash) {
      throw new Error("design hash does not match run metadata");
    }
    const rows = parseEpisodesJsonl(await readFile(path.join(runDir, "episodes.jsonl"), "utf8"));
    assertDesignRowsPresent(rows, [...design.primary.rows, ...design.timidity.rows]);
    const analysis = analyzeRepeatedFailureRows(rows, {
      expectedDesign: design.primary,
      timidityDesign: design.timidity,
      seed: metadata.statisticsSeed,
      draws: metadata.statisticsDraws,
      alpha: decisionRule.analysis.alpha,
      timingMinimumRrr: decisionRule.hypotheses["H6-timing"].minimumRelativeRiskReduction,
      timingMinimumAbsoluteBenefit:
        decisionRule.hypotheses["H6-timing"].minimumAbsoluteRepeatedFailureBenefit,
      timingMinimumBenefitIntervalLower:
        decisionRule.hypotheses["H6-timing"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
      contentMinimumRepeatedFailureBenefitIntervalLower:
        decisionRule.hypotheses["H6-content"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
      contentMinimumTaskPassBenefitIntervalLower:
        decisionRule.hypotheses["H6-content"].requireTaskPassBenefitIntervalLowerStrictlyAbove,
      timidityPassMargin: decisionRule.timidity.passRateMargin,
      timidityStepsMargin: decisionRule.timidity.stepsMargin,
    });
    const replayedBytes = `${JSON.stringify(analysis, null, 2)}\n`;
    const frozenBytes = await readFile(path.join(runDir, "statistics.json"), "utf8");
    if (frozenBytes !== replayedBytes) {
      throw new Error("frozen statistics do not match deterministic replay");
    }
    return {
      exitCode: 0,
      output: JSON.stringify({ statisticsPath: "statistics.json", rows: rows.length, modelCalls: 0 }),
    };
  } catch (error) {
    return { exitCode: 1, output: publicError(error) };
  }
}

export async function runRepeatedFailureCliCommand(
  input: RunRepeatedFailureCliCommandInput,
): Promise<RepeatedFailureCliCommandResult> {
  try {
    if (input.seedCount !== FROZEN_SEEDS.length) {
      throw new Error("registered pilot and main phases require exactly five frozen seeds");
    }
    if (input.profilePaths.length < 1 || input.profilePaths.length > 2) {
      throw new Error("registered pilot and main phases require one or two immutable model profiles");
    }
    const bundle = await loadFixtureBundle(input.fixtureDir);
    const caps: ControlledResponsesCaps = {
      ...DEFAULT_CAPS,
      ...(input.maxSteps !== undefined ? { maxTurns: input.maxSteps } : {}),
      ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
      ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
      ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    };
    const maxToolOutputChars = input.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
    const executionContract = buildModelProfileExecutionContract(
      bundle,
      caps,
      maxToolOutputChars,
    );
    const profiles = await Promise.all(
      input.profilePaths.map((profilePath) => loadModelProfile(profilePath, executionContract)),
    );
    const apiKey = process.env.OPENAI_API_KEY;
    if (
      profiles.some((entry) => (
        entry.profile.provider === "openai-responses" && entry.profile.endpoint === undefined
      ))
      && !apiKey
    ) {
      throw new Error("OPENAI_API_KEY is required for the official Responses endpoint");
    }
    const drivers = profiles.map(({ profile }) =>
      createRepeatedFailureProfileDriver(profile, executionContract, apiKey)
    );
    const run = await runRepeatedFailureSuite({
      outputDir: input.resumeRunDir ?? input.outputDir,
      fixtureDir: input.fixtureDir,
      drivers,
      seeds: Array.from({ length: input.seedCount }, (_, index) => index + 1),
      mode: "full",
      phase: input.phase,
      ...(input.pilotRunDir ? { pilotRunDir: input.pilotRunDir } : {}),
      taskIds: bundle.dataset.splits[input.phase],
      resume: input.resumeRunDir !== undefined,
      statisticsDraws: input.statisticsDraws,
      statisticsSeed: input.statisticsSeed,
      maxToolOutputChars,
      caps,
    });
    return {
      exitCode: 0,
      output: JSON.stringify({
        runId: run.result.meta.runId,
        resultPath: path.basename(run.resultPath),
        manifestPath: path.basename(run.manifestPath),
        completed: run.completed,
        resumed: run.resumed,
        invalid: run.invalid,
      }),
    };
  } catch (error) {
    return { exitCode: 1, output: publicError(error) };
  }
}

export async function executePlannedRow(
  plan: PlannedRow,
  driver: RepeatedFailureEpisodeDriver,
  history: FrozenHistory,
  store: RepeatedFailureRowStore,
  configuration: RowExecutionOptions,
): Promise<void> {
  const claim = await store.claimRow(plan.identity);
  try {
    await executeClaimedPlannedRow(plan, driver, history, store, configuration, claim);
  } finally {
    await store.releaseClaim(claim);
  }
}

async function executeClaimedPlannedRow(
  plan: PlannedRow,
  driver: RepeatedFailureEpisodeDriver,
  history: FrozenHistory,
  store: RepeatedFailureRowStore,
  configuration: RowExecutionOptions,
  claim: RepeatedFailureRowClaim,
): Promise<void> {
  const rowKey = buildRepeatedFailureRowKey(plan.identity);
  const isolation = buildIsolation(rowKey);
  const loaded = await store.load(plan.identity);
  if (loaded.kind === "MALFORMED") throw loaded.error;
  if (loaded.kind === "VALID") {
    await store.verifyAttemptTraceArtifacts(loaded.checkpoint);
  }
  if (loaded.kind === "VALID" && loaded.checkpoint.terminal) {
    throw new Error(`Repeated-failure row ${rowKey} is already terminal`);
  }
  const firstAttemptIndex = loaded.kind === "VALID" ? loaded.checkpoint.tries.length : 0;
  for (
    let attemptIndex = firstAttemptIndex;
    attemptIndex <= configuration.maxHostRetries;
    attemptIndex += 1
  ) {
    const attempt = (attemptIndex + 1) as 1 | 2 | 3 | 4 | 5 | 6;
    const materialized = await materializeTaskRepo([...plan.files]);
    const memoryDir = await mkdtemp(path.join(tmpdir(), "h6-memory-"));
    try {
      const startRepoHash = await hashDirectory(materialized.dir, true);
      const expectedStartRevision = plan.noTrapControl
        ? plan.variant.noTrapRevisionSha
        : plan.variant.cleanRevisionSha;
      await materializeArmMemory(
        plan,
        history,
        materialized.dir,
        memoryDir,
        isolation.codingScopeId,
        rowKey,
      );
      const startMemoryHash = await hashDirectory(memoryDir, false);
      const host = new FixtureToolHost(
        materialized.dir,
        plan.task,
        plan.variant,
        configuration.maxToolOutputChars,
        plan.noTrapControl,
      );
      const evaluator = new FixtureActionEvaluator(
        plan.identity.arm === "PRE_ACTION_FAILURE" || plan.identity.arm === "BOTH",
        host,
        materialized.dir,
        memoryDir,
        isolation.codingScopeId,
        isolation.sessionId,
        history.failureFact,
      );
      const factPairAudit = auditFactPair(history, driver.tokenizer);
      const preflightInvalidReason = materialized.commitSha !== expectedStartRevision
        ? "START_DRIFT"
        : factPairAudit === "UNMATCHED"
          ? "UNMATCHED_FACTS"
          : undefined;
      if (preflightInvalidReason) {
        const trace = await writeTrace(configuration.outputDir, rowKey, attempt, {
          schemaVersion: 1,
          identity: plan.identity,
          preflightInvalidReason,
          startRepoHash,
          expectedStartRevision,
          startMemoryHash,
          historyHash: history.historyHash,
        });
        const evidence = baseEvidence({
          startRepoHash,
          startMemoryHash,
          history,
          trace,
          factPairAudit,
          finalState: "INDETERMINATE",
          gate: noMatchGate({ callId: "preflight", tool: "none", arguments: {} }),
          faults: [preflightInvalidReason],
        });
        await store.commitTry(claim, {
          attempt,
          durationMs: 0,
          tokens: zeroTokens(),
          outcome: {
            kind: "TASK_RESULT",
            episode: {
              status: "INVALID",
              finalState: "INVALID",
              invalidReason: preflightInvalidReason,
              evidence,
              isolation,
            },
          },
        });
        return;
      }

      const startedAt = configuration.clock();
      let result: ControlledResponsesEpisodeResult;
      try {
        result = await driver.runEpisode({
          identity: plan.identity,
          prompt: buildPrompt(plan, history, driver.developerInstructions),
          caps: configuration.caps,
          toolHost: host,
          evaluator,
        });
      } catch (error) {
        result = hostFaultResult(error);
      }
      const durationMs = finiteDuration(configuration.clock() - startedAt);
      const hostApiFault = firstRetryableHostFault(result);
      if (hostApiFault) {
        const fault = hostApiFault;
        const retriesExhausted = attemptIndex >= configuration.maxHostRetries;
        const terminalRepoEvidence = await host.captureFinalEvidence();
        const trace = await writeTrace(configuration.outputDir, rowKey, attempt, {
          schemaVersion: 1,
          identity: plan.identity,
          hostFault: fault,
          result,
          finalRepoEvidence: terminalRepoEvidence,
          usage: result.usage,
        });
        const terminalEvidence = terminalRepoEvidence
          ? baseEvidence({
              startRepoHash,
              startMemoryHash,
              history,
              trace,
              factPairAudit,
              finalState: terminalRepoEvidence.checkResult,
              gate: noMatchGate({ callId: "none", tool: "none", arguments: {} }),
              taskPassed: false,
              faults: [fault.code],
            })
          : undefined;
        await store.commitTry(claim, {
          attempt,
          durationMs,
          tokens: result.usage,
          outcome: {
            kind: "HOST_API_FAULT",
            code: fault.code,
            messageHash: fault.messageHash,
            traceArtifactPath: trace.path,
            traceArtifactHash: trace.hash,
            ...(terminalEvidence ? { evidence: terminalEvidence, isolation } : {}),
          },
        });
        // Commit first so the exhausting attempt is durably auditable, then
        // pause. A resumed run replays from the next attempt with full history
        // instead of silently losing the fault that stopped the suite.
        if (retriesExhausted) {
          throw new Error(
            `Host API fault retries exhausted on row ${rowKey}. Pausing run so the endpoint can be recovered. Fix the endpoint and use --run to resume.`,
          );
        }
        continue;
      }
      const finalRepoEvidence = result.finalRepoEvidence ?? await host.captureFinalEvidence();
      const recalledFact = turnStartFact(plan.identity.arm, history);
      const preActionFailurePresented = result.gateEvents.some(
        (event) => event.status === "MATCH_WARN" && event.warningHash === sha256(history.failureFact),
      );
      const timingPayload = plan.identity.arm === "TURN_START_FAILURE"
        ? buildTimingPayload(history, driver, "TURN_START")
        : plan.identity.arm === "PRE_ACTION_FAILURE" && preActionFailurePresented
          ? buildTimingPayload(history, driver, "PRE_ACTION")
          : null;
      const trace = await writeTrace(configuration.outputDir, rowKey, attempt, {
        schemaVersion: 1,
        identity: plan.identity,
        result,
        finalRepoEvidence,
        armAudit: {
          noTrapControl: plan.noTrapControl,
          timingPayload,
          turnStartFactHash: recalledFact ? sha256(recalledFact) : null,
          failureFactHash: sha256(history.failureFact),
          preActionFailureFactHash: preActionFailurePresented
            ? sha256(history.failureFact)
            : null,
          successFactHash: sha256(history.successFact),
          badStrategyExecuted: host.repeatedBadStrategy(),
        },
      });
      const episode = classifyEpisode({
        plan,
        history,
        result,
        finalRepoEvidence,
        startRepoHash,
        startMemoryHash,
        trace,
        isolation,
        host,
        factPairAudit,
      });
      await store.commitTry(claim, {
        attempt,
        durationMs,
        tokens: result.usage,
        outcome: { kind: "TASK_RESULT", episode },
      });
      return;
    } finally {
      await Promise.all([
        materialized.cleanup(),
        rm(memoryDir, { recursive: true, force: true }),
      ]);
    }
  }
  throw new Error("host retry loop ended without a terminal row");
}

export function classifyEpisode(input: {
  plan: PlannedRow;
  history: FrozenHistory;
  result: ControlledResponsesEpisodeResult;
  finalRepoEvidence: RepeatedFailureFinalRepoEvidence;
  startRepoHash: string;
  startMemoryHash: string;
  trace: { path: string; hash: string };
  isolation: RepeatedFailureIsolationIdentity;
  host: FixtureToolHost;
  factPairAudit: "MATCHED" | "UNMATCHED";
}): RepeatedFailureEpisode {
  const rawGate = input.result.gate
    ?? input.result.gateEvents.at(-1)
    ?? noMatchGate({ callId: "none", tool: "none", arguments: {} });
  const gate: RepeatedFailureGateEvent = {
    status: rawGate.status,
    fingerprintHash: rawGate.fingerprintHash,
    warningHash: rawGate.warningHash,
    faultCode: rawGate.faultCode,
  };
  const finalState = input.finalRepoEvidence.checkResult;
  const warnings = input.result.gateEvents.filter((event) => event.status === "MATCH_WARN");
  const gateFailOpen = input.result.gateEvents.some(
    (event) => event.status === "ERROR_FAIL_OPEN",
  ) || gate.status === "ERROR_FAIL_OPEN";
  const capExceeded = input.result.invalidReason === "CAP_EXCEEDED";
  const evidence = baseEvidence({
    startRepoHash: input.startRepoHash,
    startMemoryHash: input.startMemoryHash,
    history: input.history,
    trace: input.trace,
    factPairAudit: input.factPairAudit,
    finalState,
    gate,
    askedActionHash: input.result.originalFingerprint ?? input.result.tools[0]?.fingerprint,
    actionExecuted: input.result.tools.length > 0,
    repeatedFailure: finalState === "TRAPPED" && input.host.repeatedBadStrategy(),
    steps: input.result.responses.length,
    warningCount: warnings.length,
    falseWarningCount: input.plan.noTrapControl ? warnings.length : 0,
    ...(capExceeded ? { taskPassed: false } : {}),
    faults: input.result.faults.map((fault) => fault.code),
  });
  if (gateFailOpen || input.result.invalidReason === "ABORTED") {
    return {
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: "WAIT_RULE_FAULT",
      evidence,
      isolation: input.isolation,
    };
  }
  if (finalState === "INDETERMINATE") {
    return {
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: "VAGUE_CHECK",
      evidence,
      isolation: input.isolation,
    };
  }
  if (!armSemanticsAreValid(input.plan.identity.arm, input.result, input.history.failureFact)) {
    return {
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: "MIXED_ARM_STATE",
      evidence,
      isolation: input.isolation,
    };
  }
  if (capExceeded) {
    return { status: "VALID", finalState, evidence, isolation: input.isolation };
  }
  if (input.result.status === "INVALID") {
    return {
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: "TRACE_GAP",
      evidence,
      isolation: input.isolation,
    };
  }
  return { status: "VALID", finalState, evidence, isolation: input.isolation };
}
export async function runEpisodeForAudit(input: {
  identity: RepeatedFailureRowIdentity;
  rowKey: string;
  task: BaseTask;
  variant: TaskVariant;
  driver: RepeatedFailureEpisodeDriver;
  store: RepeatedFailureRowStore;
  caps?: Partial<ControlledResponsesCaps>;
  maxHostRetries?: 0 | 1 | 2 | 3 | 4 | 5;
  maxToolOutputChars?: number;
}): Promise<RepeatedFailureEpisodeRow> {
  if (input.rowKey !== buildRepeatedFailureRowKey(input.identity)) {
    throw new Error("audit row key does not match identity");
  }
  const noTrapControl = input.identity.variantId.endsWith(":no-trap");
  const plan: PlannedRow = {
    identity: input.identity,
    task: input.task,
    variant: input.variant,
    files: noTrapControl ? input.variant.noTrapControlFiles : input.variant.files,
    noTrapControl,
  };
  const template = await buildHistoryTemplate(input.task, input.variant);
  await executePlannedRow(
    plan,
    input.driver,
    freezeHistory(template, input.identity),
    input.store,
    {
      outputDir: input.store.outputDir,
      caps: { ...DEFAULT_CAPS, ...(input.caps ?? {}) },
      maxHostRetries: input.maxHostRetries ?? 5,
      maxToolOutputChars: input.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS,
      clock: () => Date.now(),
    },
  );
  const row = await input.store.loadTerminalForResume(input.identity);
  if (!row?.evidence || !row.isolation) {
    throw new Error(`audit row lacks terminal evidence: ${input.rowKey}`);
  }
  return row;
}

export function baseEvidence(input: {
  startRepoHash: string;
  startMemoryHash: string;
  history: FrozenHistory;
  trace: { path: string; hash: string };
  factPairAudit: "MATCHED" | "UNMATCHED";
  finalState: RepeatedFailureFinalRepoEvidence["checkResult"];
  gate: RepeatedFailureGateEvent;
  askedActionHash?: string;
  actionExecuted?: boolean;
  repeatedFailure?: boolean;
  steps?: number;
  warningCount?: number;
  falseWarningCount?: number;
  taskPassed?: boolean;
  faults: readonly string[];
}): RepeatedFailureEpisodeEvidence {
  return {
    startRepoHash: input.startRepoHash,
    startMemoryHash: input.startMemoryHash,
    historyHash: input.history.historyHash,
    askedActionHash: input.askedActionHash ?? sha256("no-action"),
    traceArtifactPath: input.trace.path,
    traceArtifactHash: input.trace.hash,
    gate: input.gate,
    actionExecuted: input.actionExecuted ?? false,
    checkResult: input.finalState === "FIXED" || input.finalState === "NO_TRAP"
      ? "PASS"
      : input.finalState === "INDETERMINATE"
        ? "INDETERMINATE"
        : "FAIL",
    repeatedFailure: input.repeatedFailure ?? false,
    taskPassed: input.taskPassed ?? (input.finalState === "FIXED" || input.finalState === "NO_TRAP"),
    steps: input.steps ?? 0,
    warningCount: input.warningCount ?? 0,
    falseWarningCount: input.falseWarningCount ?? 0,
    factPairAudit: input.factPairAudit,
    faults: input.faults,
  };
}

