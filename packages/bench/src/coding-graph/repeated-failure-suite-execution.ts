import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandTildePath } from "@remnic/core";
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
  H6_DECISION_RULE,
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
  validateH6StateDefiningIndependence,
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
import { RepeatedFailurePreflightError } from "./repeated-failure-preflight.js";

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
  strategyDiffShape,
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

export async function buildHistoryTemplate(task: BaseTask, variant: TaskVariant): Promise<HistoryTemplate> {
  const failureRepo = await materializeTaskRepo([...variant.files]);
  const successRepo = await materializeTaskRepo([...variant.files]);
  try {
    const baselineRepoHash = await hashDirectory(failureRepo.dir, true);
    const failureActionIdentity = actionIdentityFor(task, failureRepo.dir, variant.badStrategyPatch.id);
    const successActionIdentity = actionIdentityFor(task, successRepo.dir, variant.goodStrategyPatch.id);
    const failureCommit = await applyPatchAndCommit(
      failureRepo.dir,
      variant.badStrategyPatch.files,
      "apply bad strategy patch",
    );
    const successCommit = await applyPatchAndCommit(
      successRepo.dir,
      variant.goodStrategyPatch.files,
      "apply good strategy patch",
    );
    if (failureCommit !== variant.trapRevisionSha || successCommit !== variant.rightRevisionSha) {
      throw new Error(`generated revision drift for ${variant.variantId}`);
    }
    const failureCheck = await runOfflineCheck(failureRepo.dir, task);
    const successCheck = await runOfflineCheck(successRepo.dir, task);
    if (failureCheck.state !== "TRAPPED" || successCheck.state !== "FIXED") {
      throw new Error(`episode history state audit failed for ${variant.variantId}`);
    }
    const failureFact = renderFailureFact();
    const successFact = renderSuccessFact();
    return {
      failureFact,
      successFact,
      failureActionIdentity,
      successActionIdentity,
      failureRepoHash: await hashDirectory(failureRepo.dir, true),
      successRepoHash: await hashDirectory(successRepo.dir, true),
      baselineRepoHash,
      failurePathShapeHash: pathShapeHash(task),
      successPathShapeHash: pathShapeHash(task),
      failureActionShapeHash: actionShapeHash(task),
      successActionShapeHash: actionShapeHash(task),
    };
  } finally {
    await Promise.all([failureRepo.cleanup(), successRepo.cleanup()]);
  }
}

export function freezeHistory(template: HistoryTemplate, identity: RepeatedFailureRowIdentity): FrozenHistory {
  const historyHash = sha256(stableStringify({
    taskId: identity.taskId,
    variantId: identity.variantId.replace(/:no-trap$/, ""),
    seed: identity.seed,
    modelProfileId: identity.modelProfileId,
    modelProfileHash: identity.modelProfileHash,
    template,
  }));
  const failureFactId = `h6-fact-v1-${historyHash}`;
  return {
    ...template,
    historyHash,
    failureFactId,
    failureCitationHash: sha256(stableStringify({
      factId: failureFactId,
      failureRepoHash: template.failureRepoHash,
      failureActionFingerprint: template.failureActionIdentity.fingerprint,
    })),
  };
}

export async function materializeArmMemory(
  plan: PlannedRow,
  history: FrozenHistory,
  repoDir: string,
  memoryDir: string,
  projectId: string,
  rowKey: string,
): Promise<void> {
  if (plan.identity.arm === "NO_MEMORY") return;
  const success = plan.identity.arm === "TURN_START_SUCCESS";
  const actionIdentity = success
    ? history.successActionIdentity
    : actionIdentityFor(plan.task, repoDir, plan.variant.badStrategyPatch.id);
  const record = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: success
      ? `h6-success-v1-${history.historyHash}`
      : history.failureFactId,
    recordedAt: FIXED_RECORDED_AT,
    sessionKey: `episode-1-${history.historyHash.slice(0, 24)}`,
    goal: "Fix the synthetic offline coding task",
    actionSummary: HISTORY_ACTION_SUMMARY,
    observationSummary: success ? HISTORY_SUCCESS_SUMMARY : HISTORY_FAILURE_SUMMARY,
    outcomeKind: success ? "success" : "failure",
    outcomeSummary: success ? HISTORY_SUCCESS_SUMMARY : HISTORY_FAILURE_SUMMARY,
    followUpSummary: HISTORY_FOLLOW_UP,
    codingContext: { projectId },
    actionIdentity,
  } satisfies CausalTrajectoryRecord);
  const root = path.join(memoryDir, "state", "causal-trajectories");
  const trajectories = path.join(root, "trajectories", "2026-01-01");
  await mkdir(trajectories, { recursive: true });
  await writeFileAtomically(
    path.join(trajectories, `${record.trajectoryId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  await writeFileAtomically(path.join(root, "revision.json"), `${JSON.stringify({
    revisionToken: `rev-h6-${sha256(stableStringify(record)).slice(0, 32)}`,
    updatedAt: FIXED_RECORDED_AT,
  }, null, 2)}\n`);
}
export function renderFailureFact(): string {
  return `[PreActionFailureGate ${PRE_ACTION_WARNING_VERSION}] A similar action failed before. Prior act: "${HISTORY_ACTION_SUMMARY}". Failure: "${HISTORY_FAILURE_SUMMARY}". Next safe check: "${HISTORY_FOLLOW_UP}".`;
}

export function renderSuccessFact(): string {
  return `[PreActionFailureGate ${PRE_ACTION_WARNING_VERSION}] A similar action worked before. Prior act: "${HISTORY_ACTION_SUMMARY}". Success: "${HISTORY_SUCCESS_SUMMARY}". Next safe check: "${HISTORY_FOLLOW_UP}".`;
}

export function buildPrompt(
  plan: PlannedRow,
  history: FrozenHistory,
  developerInstructions: string,
): string {
  const taskInstruction = plan.files.find((file) => file.path === "TASK.md")?.content ?? plan.task.title;
  const fact = turnStartFact(plan.identity.arm, history);
  return [
    PROMPT_CONTRACT.repositoryFrame,
    developerInstructions,
    taskInstruction,
    plan.noTrapControl
      ? PROMPT_CONTRACT.noTrapInstruction
      : PROMPT_CONTRACT.trapInstruction,
    `Versioned action identity fields: ${JSON.stringify({
      identityVersion: 1,
      actionType: plan.task.normalizedActionIntent.actionType,
      targetSymbol: plan.task.normalizedActionIntent.targetSymbol,
      filePath: plan.task.normalizedActionIntent.filePath,
      contextHash: plan.task.normalizedActionIntent.contextHash,
    })}`,
    `Available strategies: ${JSON.stringify(plan.variant.strategyCandidates.map((candidate) => ({
      id: candidate.id,
      description: candidate.description,
    })))}`,
    ...(fact ? [`${PROMPT_CONTRACT.recalledFactLabel}\n${fact}`] : []),
  ].join("\n\n");
}

export function turnStartFact(arm: RepeatedFailureArm, history: FrozenHistory): string | undefined {
  if (arm === "TURN_START_FAILURE" || arm === "BOTH") return history.failureFact;
  if (arm === "TURN_START_SUCCESS") return history.successFact;
  return undefined;
}

export type TimingPayload = {
  frame: "TURN_START" | "PRE_ACTION";
  factId: string;
  citationHash: string;
  factCount: 1;
  renderedTokenCount: number;
};

export function buildTimingPayload(
  history: FrozenHistory,
  driver: RepeatedFailureEpisodeDriver,
  frame: TimingPayload["frame"],
): TimingPayload {
  return {
    frame,
    factId: history.failureFactId,
    citationHash: history.failureCitationHash,
    factCount: 1,
    renderedTokenCount: countFactTokens(history.failureFact, driver.tokenizer),
  };
}

export function auditFactPair(
  history: FrozenHistory,
  tokenizer: RepeatedFailureEpisodeDriver["tokenizer"],
): "MATCHED" | "UNMATCHED" {
  const failureTokens = countFactTokens(history.failureFact, tokenizer);
  const successTokens = countFactTokens(history.successFact, tokenizer);
  const tokenGap = Math.abs(failureTokens - successTokens);
  const relativeGap = tokenGap / Math.max(failureTokens, successTokens, 1);
  return history.failurePathShapeHash === history.successPathShapeHash
    && history.failureActionShapeHash === history.successActionShapeHash
    && tokenGap <= 8
    && relativeGap <= 0.05
    && calculateJaccardSimilarity(history.failureFact, history.successFact) >= 0.8
    ? "MATCHED"
    : "UNMATCHED";
}
export function actionIdentityFor(task: BaseTask, rootPath: string, candidateId?: string): ActionIdentity {
  const normalized = normalizeActionIntent({
    kind: "edit",
    filePath: task.normalizedActionIntent.filePath,
    editKind: "update",
    symbol: task.normalizedActionIntent.targetSymbol,
    diffShape: strategyDiffShape(task, candidateId),
  }, "CHANGE_IMPLEMENTATION", {
    projectId: "h6-history-project",
    rootPath,
    branch: "main",
    defaultBranch: "main",
  });
  return {
    fingerprintVersion: 1,
    fingerprint: normalized.fingerprint,
    strategyId: "CHANGE_IMPLEMENTATION",
  };
}


export function pathShapeHash(task: BaseTask): string {
  const shape = task.normalizedActionIntent.filePath
    .normalize("NFKC")
    .split("/")
    .map((segment) => segment.replace(/[\p{L}\p{N}]+/gu, "{name}"))
    .join("/");
  return sha256(shape);
}

export function actionShapeHash(task: BaseTask): string {
  return sha256(stableStringify({
    kind: "edit",
    editKind: "update",
    actionType: task.normalizedActionIntent.actionType,
    targetSymbol: task.normalizedActionIntent.targetSymbol,
    filePathShapeHash: pathShapeHash(task),
  }));
}

export function armSemanticsAreValid(
  arm: RepeatedFailureArm,
  result: ControlledResponsesEpisodeResult,
  failureFact: string,
): boolean {
  const warnings = result.gateEvents.filter((event) => event.status === "MATCH_WARN");
  if (arm === "NO_MEMORY" || arm === "TURN_START_FAILURE" || arm === "TURN_START_SUCCESS") {
    return warnings.length === 0;
  }
  return warnings.length === 0
    || (warnings.length === 1 && warnings.some((warning) => warning.warningHash === sha256(failureFact)));
}

export async function loadFixtureBundle(fixtureDir?: string): Promise<FixtureBundle> {
  const root = fixtureDir
    ? path.resolve(fixtureDir)
    : await resolveCommittedH6FixtureDirectory();
  const [datasetRaw, armsRaw, taxonomyRaw, decisionRuleBytes] = await Promise.all([
    readJson(path.join(root, "dataset.json")),
    readJson(path.join(root, "arms", "arms.json")),
    readJson(path.join(root, "trap-taxonomy.json")),
    readFile(path.join(root, "decision-rule.json"), "utf8"),
  ]);
  const decisionRaw = JSON.parse(decisionRuleBytes);
  const dataset = H6BenchmarkDatasetSchema.parse(datasetRaw);
  const arms = ArmManifestSchema.parse(armsRaw);
  const taxonomy = z.array(TrapTaxonomyItemSchema).length(6).parse(taxonomyRaw);
  const decisionRule = DecisionRuleSchema.parse(decisionRaw);
  const corpusValidation = validateH6StateDefiningIndependence(dataset);
  if (corpusValidation.issues.length > 0) {
    const issueCodes = [...new Set(corpusValidation.issues.map((issue) => issue.code))].sort(compareCodePoints);
    throw new RepeatedFailurePreflightError(
      "CORPUS_INVALID",
      `H6 corpus validation failed: ${issueCodes.join(",")}`,
    );
  }
  const { inventoryHash, ...withoutHash } = dataset;
  if (computeH6InventoryHash(withoutHash) !== inventoryHash) {
    throw new Error("dataset inventory hash is invalid");
  }
  if (inventoryHash !== H6_FROZEN_INVENTORY_HASH) {
    throw new Error("registered H6 execution requires the frozen dataset inventory");
  }
  for (const split of ["dev", "pilot", "main"] as const) {
    if (stableStringify(dataset.splits[split]) !== stableStringify(H6_FROZEN_SPLITS[split])) {
      throw new Error(`fixture ${split} split does not match the frozen preregistration`);
    }
  }
  for (const task of dataset.tasks) {
    if (!dataset.splits[task.split].includes(task.id)) {
      throw new Error(`task ${task.id} split field does not match frozen split membership`);
    }
  }
  if (stableStringify(taxonomy) !== stableStringify(dataset.taxonomy)) {
    throw new Error("taxonomy manifest drifted from dataset");
  }
  for (const artifactPath of H6_SUPPORT_ARTIFACT_PATHS) {
    const artifactBytes = await readFile(path.join(root, artifactPath));
    if (sha256(artifactBytes) !== dataset.supportArtifactHashes[artifactPath]) {
      throw new Error(`support artifact hash mismatch: ${artifactPath}`);
    }
  }
  if (decisionRule.analysisPopulation.datasetInventoryHash !== inventoryHash) {
    throw new Error("decision rule targets a different dataset inventory");
  }
  if (arms.some((entry, index) => entry.id !== REPEATED_FAILURE_ARMS[index])) {
    throw new Error("arm manifest does not match the frozen five-arm order");
  }
  return {
    fixtureDir: root,
    dataset,
    decisionRuleBytes,
    decisionRule,
    suiteVersion: `h6-failure-gate-v1-${inventoryHash}`,
  };
}


export async function validateTaskManifest(fixtureDir: string, task: BaseTask): Promise<void> {
  const manifest = BaseTaskSchema.parse(
    await readJson(path.join(fixtureDir, "tasks", task.id, "task.json")),
  );
  if (stableStringify(manifest) !== stableStringify(task)) {
    throw new Error(`task manifest drifted from dataset: ${task.id}`);
  }
}

export function normalizeRunOptions(
  options: RunRepeatedFailureSuiteOptions,
  bundle: FixtureBundle,
): NormalizedRunOptions {
  const drivers = [...options.drivers].sort(
    (left, right) => compareCodePoints(left.modelProfileId, right.modelProfileId)
      || compareCodePoints(left.modelProfileHash, right.modelProfileHash),
  );
  if (drivers.length === 0) throw new Error("at least one repeated-failure driver is required");
  for (const driver of drivers) {
    if (
      !driver.modelProfileId
      || !SHA256_PATTERN.test(driver.modelProfileHash)
      || !SHA256_PATTERN.test(driver.modelDigest)
    ) {
      throw new Error(
        "every driver requires modelProfileId, modelProfileHash, and modelDigest with lowercase SHA-256 hashes",
      );
    }
  }
  const driverKeys = drivers.map(
    (driver) => `${driver.modelProfileId}\u0000${driver.modelProfileHash}`,
  );
  if (new Set(driverKeys).size !== drivers.length) throw new Error("duplicate model profile identity");
  const seeds = [...new Set(options.seeds)].sort((left, right) => left - right);
  if (
    seeds.length === 0
    || seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
  ) throw new Error("seeds must be unique integers in [0, 2^32 - 1]");
  const caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) };
  for (
    const key of [
      "maxTurns",
      "maxToolCalls",
      "maxTotalTokens",
      "maxDurationMs",
      "requestTimeoutMs",
    ] as const
  ) {
    if (!Number.isSafeInteger(caps[key]) || caps[key] <= 0) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  const maxHostRetries = options.maxHostRetries ?? 5;
  const statisticsSeed = options.statisticsSeed ?? bundle.dataset.seed;
  const statisticsDraws = options.statisticsDraws ?? REPEATED_FAILURE_STATISTICS_DRAWS;
  if (
    !Number.isSafeInteger(statisticsSeed)
    || statisticsSeed < 0
    || statisticsSeed > 0xffffffff
  ) throw new Error("statisticsSeed must be an integer in [0, 2^32 - 1]");
  if (!Number.isSafeInteger(statisticsDraws) || statisticsDraws <= 0) {
    throw new Error("statisticsDraws must be positive");
  }
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  if (
    !Number.isSafeInteger(maxToolOutputChars)
    || maxToolOutputChars <= 0
    || maxToolOutputChars > 65_536
  ) throw new Error("maxToolOutputChars must be in [1, 65536]");
  const phase = options.phase ?? "unspecified";
  const registeredTaskIds = phase === "unspecified"
    ? [...new Set(options.taskIds ?? [])].sort(compareCodePoints)
    : [...new Set(options.taskIds ?? bundle.dataset.splits[phase])].sort(compareCodePoints);
  const registeredVariantIds = phase === "unspecified"
    ? [...new Set(options.variantIds ?? [])].sort(compareCodePoints)
    : [...new Set(options.variantIds ?? bundle.dataset.tasks
      .filter((task) => bundle.dataset.splits[phase].includes(task.id))
      .flatMap((task) => task.variants.map((variant) => variant.variantId)))].sort(compareCodePoints);
  if (phase !== "unspecified") {
    if (bundle.dataset.inventoryHash !== FROZEN_DATASET_INVENTORY_HASH) {
      throw new Error("registered H6 execution requires the frozen dataset inventory");
    }
    if (options.mode !== "full") throw new Error("registered H6 execution requires full mode");
    if (drivers.length < 1 || drivers.length > 2) throw new Error("registered H6 execution requires one or two immutable model profiles");
    if (new Set(drivers.map((driver) => driver.modelDigest)).size !== drivers.length) {
      throw new Error("registered H6 execution requires distinct served model digests");
    }
    if (stableStringify(seeds) !== stableStringify(FROZEN_SEEDS)) {
      throw new Error("registered H6 execution requires the exact frozen seeds [1,2,3,4,5]");
    }
    if (
      stableStringify(registeredTaskIds)
      !== stableStringify([...bundle.dataset.splits[phase]].sort(compareCodePoints))
    ) {
      throw new Error(`registered H6 ${phase} execution requires exact frozen split membership`);
    }
    const expectedVariantIds = bundle.dataset.tasks
      .filter((task) => bundle.dataset.splits[phase].includes(task.id))
      .flatMap((task) => task.variants.map((variant) => variant.variantId))
      .sort(compareCodePoints);
    if (stableStringify(registeredVariantIds) !== stableStringify(expectedVariantIds)) {
      throw new Error(`registered H6 ${phase} execution requires every frozen task variant`);
    }
    if (stableStringify(caps) !== stableStringify(DEFAULT_CAPS) || maxToolOutputChars !== DEFAULT_TOOL_OUTPUT_CHARS) {
      throw new Error("registered H6 execution requires the frozen response caps");
    }
    if (maxHostRetries !== 5) throw new Error("registered H6 execution requires the frozen retry rule");
    if (statisticsSeed !== bundle.dataset.seed) {
      throw new Error("registered H6 execution requires the frozen statistics seed");
    }
    if (
      statisticsDraws !== REPEATED_FAILURE_STATISTICS_DRAWS
      || bundle.decisionRule.analysis.bootstrap.draws !== REPEATED_FAILURE_STATISTICS_DRAWS
      || bundle.decisionRule.analysis.shuffle.draws !== REPEATED_FAILURE_STATISTICS_DRAWS
    ) {
      throw new Error("registered H6 execution requires exactly 10000 bootstrap, shuffle, and power draws");
    }
  }
  const taskIds = registeredTaskIds;
  const variantIds = registeredVariantIds;
  if (phase === "main" && !options.pilotRunDir) {
    throw new Error("main execution requires a verified pilot run");
  }
  return {
    outputDir: path.resolve(options.outputDir),
    drivers,

    seeds,
    taskIds,
    variantIds,
    caps,
    maxHostRetries,
    statisticsSeed,
    statisticsDraws,
    maxToolOutputChars,
    phase,
    clock: options.clock ?? Date.now,
    now: options.now ?? (() => new Date()),
  };
}

export async function writeFrozenRunArtifact(
  filePath: string,
  content: string,
  resume: boolean,
): Promise<void> {
  if (!resume) {
    await writeFileAtomically(filePath, content);
    return;
  }
  let existing: string;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    throw new Error("resume run is missing a frozen artifact");
  }
  if (existing !== content) throw new Error("resume run frozen artifact drifted");
}

export async function writeFinalRunArtifact(
  filePath: string,
  content: string,
  resume: boolean,
): Promise<void> {
  if (resume && await pathExists(filePath)) {
    if (await readFile(filePath, "utf8") !== content) {
      throw new Error("resume run final artifact drifted");
    }
    return;
  }
  await writeFileAtomically(filePath, content);
}

export async function ensureDeviationsArtifact(filePath: string, resume: boolean): Promise<void> {
  if (!resume) {
    await writeFileAtomically(filePath, "");
    return;
  }
  let content: string;
  try {
    const status = await lstat(filePath);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("invalid deviations artifact");
    content = await readFile(filePath, "utf8");
  } catch {
    throw new Error("resume run is missing deviations.jsonl");
  }
  for (const line of content.split("\n").filter(Boolean)) {
    const deviation = JSON.parse(line) as unknown;
    if (!deviation || typeof deviation !== "object" || Array.isArray(deviation)) {
      throw new Error("resume run has malformed deviations.jsonl");
    }
  }
}

export async function assertSafeBenchmarkOutput(outputDir: string, resume: boolean): Promise<void> {
  const refusal = "refusing benchmark output inside a Remnic memory store";
  let canonicalOutput: string;
  try {
    canonicalOutput = await canonicalProspectivePath(outputDir);
    for (const variable of ["REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR"] as const) {
      const configured = process.env[variable]?.trim();
      if (!configured) continue;
      const memoryRoot = await canonicalProspectivePath(path.resolve(expandTildePath(configured)));
      if (isSameOrDescendant(canonicalOutput, memoryRoot)) throw new Error(refusal);
    }
    let candidate = canonicalOutput;
    while (true) {
      if (
        await pathExists(path.join(candidate, "profile.md"))
        && await anyPathExists([
          path.join(candidate, "facts"),
          path.join(candidate, "entities"),
          path.join(candidate, "state"),
        ])
      ) throw new Error(refusal);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  } catch (error) {
    if (error instanceof Error && error.message === refusal) throw error;
    throw new Error(refusal);
  }

  let outputStatus: Stats;
  try {
    outputStatus = await lstat(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (resume) throw new Error("resume requires existing H6 run metadata");
      return;
    }
    throw new Error(resume
      ? "resume requires existing H6 run metadata"
      : "fresh benchmark output directory must be absent or empty");
  }
  if (!outputStatus.isDirectory() || outputStatus.isSymbolicLink()) {
    throw new Error(resume
      ? "resume requires existing H6 run metadata"
      : "fresh benchmark output directory must be absent or empty");
  }
  if (!resume) {
    if ((await readdir(outputDir)).length !== 0) {
      throw new Error("fresh benchmark output directory must be absent or empty");
    }
    return;
  }
  try {
    const metadata = parseRunMetadata(JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")));
    if (!metadata.suiteVersion.startsWith("h6-failure-gate-v1-")) {
      throw new Error("not an H6 run");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("resume requires existing H6 run metadata");
    }
    throw error;
  }
}

export async function canonicalProspectivePath(value: string): Promise<string> {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function anyPathExists(values: readonly string[]): Promise<boolean> {
  for (const value of values) {
    if (await pathExists(value)) return true;
  }
  return false;
}

export async function assertResumeContract(
  outputDir: string,
  metadata: RepeatedFailureRunMetadata,
  resume: boolean,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(outputDir, "run.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (resume) throw new Error("resume run is missing run.json");
      return;
    }
    throw error;
  }
  if (!resume) throw new Error("output directory already contains a run contract");
  const existing = parseRunMetadata(JSON.parse(raw));
  if (
    existing.resumeContractHash !== metadata.resumeContractHash
    || existing.expectedDesignHash !== metadata.expectedDesignHash
  ) throw new Error("resume run contract is incompatible with requested design");
}

export function parseRunMetadata(value: unknown): RepeatedFailureRunMetadata {
  const identity = z.object({
    suiteVersion: z.string().min(1),
    taskId: z.string().min(1),
    variantId: z.string().min(1),
    modelProfileId: z.string().min(1),
    modelProfileHash: z.string().regex(SHA256_PATTERN),
    seed: z.number().int().nonnegative().max(0xffffffff),
    arm: z.enum(REPEATED_FAILURE_ARMS),
  }).strict();
  return z.object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    suiteVersion: z.string().min(1),
    datasetInventoryHash: z.literal(H6_FROZEN_INVENTORY_HASH),
    resumeContractHash: z.string().regex(SHA256_PATTERN),
    expectedDesignHash: z.string().regex(SHA256_PATTERN),
    decisionRuleHash: z.string().regex(SHA256_PATTERN),
    preregistrationPath: z.literal(H6_DECISION_RULE.preregistration.path),
    preregistrationHash: z.literal(H6_DECISION_RULE.preregistration.sha256),
    analysisVersion: z.string().min(1),
    harnessVersion: z.string().min(1),
    harnessSourceHash: z.string().regex(SHA256_PATTERN),
    provenanceHash: z.string().regex(SHA256_PATTERN),
    gitSha: z.string(),
    gitDirty: z.boolean(),
    gitDirtyEntryCount: z.number().int().nonnegative(),
    phase: z.enum(["pilot", "main", "unspecified"]),
    pilotEvidence: z.object({
      runId: z.string().min(1),
      manifestArtifactHash: z.string().regex(SHA256_PATTERN),
      powerArtifactHash: z.string().regex(SHA256_PATTERN),
    }).strict().optional(),
    mode: z.enum(["quick", "full"]),
    arms: z.array(z.enum(REPEATED_FAILURE_ARMS)).length(5),
    modelProfileIds: z.array(z.string().min(1)).min(1),
    modelProfileHashes: z.array(z.string().regex(SHA256_PATTERN)).min(1),
    modelDigests: z.array(z.string().regex(SHA256_PATTERN)).min(1),
    modelDriverKinds: z.array(z.enum(["responses", "ollama-chat", "deterministic-fake", "unknown"])).min(1),
    modelTokenizerIdentities: z.array(z.string().min(1)).min(1),
    modelTokenizerImplementations: z.array(z.literal("nfkc-whitespace-v1")).min(1),
    trapAuditReceipts: z.array(z.object({
      path: z.string().min(1),
      artifactHash: z.string().regex(SHA256_PATTERN),
      modelProfileId: z.string().min(1),
      modelProfileHash: z.string().regex(SHA256_PATTERN),
      modelDigest: z.string().regex(SHA256_PATTERN),
      tokenizerIdentity: z.string().min(1),
      tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
    }).strict()),
    seeds: z.array(z.number().int().nonnegative().max(0xffffffff)).min(1),
    splitTaskIds: z.array(z.string().min(1)).min(1),
    taskRevisions: z.array(z.object({
      taskId: z.string().min(1),
      variantId: z.string().min(1),
      cleanRevisionSha: z.string().length(40),
      trapRevisionSha: z.string().length(40),
      rightRevisionSha: z.string().length(40),
      noTrapRevisionSha: z.string().length(40),
    }).strict()).min(1),
    caps: z.object({
      maxTurns: z.number().int().positive(),
      maxToolCalls: z.number().int().positive(),
      maxTotalTokens: z.number().int().positive(),
      maxDurationMs: z.number().int().positive(),
      requestTimeoutMs: z.number().int().positive(),
      maxToolOutputChars: z.number().int().positive(),
    }).strict(),
    toolLocks: z.object({
      allowedTools: z.array(z.string().min(1)).min(1),
      taskToolSchemaHashes: z.array(z.object({
        taskId: z.string().min(1),
        variantId: z.string().min(1),
        sha256: z.string().regex(SHA256_PATTERN),
      }).strict()).min(1),
    }).strict(),
    sandboxFlags: z.object({
      networkDisabled: z.literal(true),
      isolatedRepoPerArm: z.literal(true),
      isolatedMemoryPerArm: z.literal(true),
      isolatedSessionPerArm: z.literal(true),
      rejectSymlinks: z.literal(true),
    }).strict(),
    retryRule: z.object({
      hostApiFaultRetriesAfterFirstTry: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
      rerunTaskResults: z.literal(false),
      retainAllTries: z.literal(true),
    }).strict(),
    runOrder: z.array(z.object({
      rowKey: z.string().min(1),
      analysis: z.enum(["PRIMARY", "TIMIDITY"]),
      identity,
    }).strict()).min(1),
    expectedRowCount: z.number().int().positive(),
    statisticsSeed: z.number().int().nonnegative().max(0xffffffff),
    statisticsDraws: z.number().int().positive(),
  }).strict().superRefine((metadata, context) => {
    const profileCount = metadata.modelProfileIds.length;
    for (
      const field of [
        "modelProfileHashes",
        "modelDigests",
        "modelDriverKinds",
        "modelTokenizerIdentities",
        "modelTokenizerImplementations",
      ] as const
    ) {
      if (metadata[field].length !== profileCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "model identity arrays must have the same length",
        });
      }
    }
    if (metadata.phase === "main" && metadata.pilotEvidence === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pilotEvidence"],
        message: "main H6 metadata requires verified pilot evidence",
      });
    }
  }).parse(value);
}

export function parseDesign(value: unknown): DesignArtifact {
  const identity = z.object({
    suiteVersion: z.string().min(1),
    taskId: z.string().min(1),
    variantId: z.string().min(1),
    modelProfileId: z.string().min(1),
    modelProfileHash: z.string().regex(SHA256_PATTERN),
    seed: z.number().int().nonnegative().max(0xffffffff),
    arm: z.enum(REPEATED_FAILURE_ARMS),
  }).strict();
  const parsed = z.object({
    schemaVersion: z.literal(1),
    runOrder: z.array(z.object({
      rowKey: z.string().min(1),
      analysis: z.enum(["PRIMARY", "TIMIDITY"]),
      identity,
    }).strict()),
    primary: z.object({ rows: z.array(identity) }).strict(),
    timidity: z.object({ rows: z.array(identity) }).strict(),
  }).strict().parse(value);
  if (parsed.runOrder.some(
    (row) => row.rowKey !== buildRepeatedFailureRowKey(row.identity)
      || row.analysis !== (row.identity.variantId.endsWith(":no-trap") ? "TIMIDITY" : "PRIMARY"),
  )) throw new Error("expected design run order is invalid");
  if (parsed.timidity.rows.some(
    (row) => !row.variantId.endsWith(":no-trap")
      || !TIMIDITY_ARMS.includes(row.arm as typeof TIMIDITY_ARMS[number]),
  )) throw new Error("timidity design must contain only no-trap control pairs");
  return parsed;
}

export function parseEpisodesJsonl(raw: string): RepeatedFailureEpisodeRow[] {
  if (!raw.endsWith("\n")) throw new Error("episodes JSONL must end with a newline");
  const rows = raw.split("\n").filter(Boolean)
    .map((line) => parseRepeatedFailureEpisodeRow(JSON.parse(line)));
  for (const row of rows) {
    if (
      row.schemaVersion !== 1
      || buildRepeatedFailureRowKey(row.identity) !== row.rowKey
      || !row.evidence
      || !SHA256_PATTERN.test(row.evidence.traceArtifactHash)
    ) throw new Error("episodes JSONL contains an invalid or incomplete row");
  }
  return rows;
}

export async function terminalEvidenceIsDurable(
  outputDir: string,
  row: RepeatedFailureEpisodeRow,
): Promise<boolean> {
  if (!row.evidence) return false;
  try {
    return sha256(await readFile(containedPath(outputDir, row.evidence.traceArtifactPath)))
      === row.evidence.traceArtifactHash;
  } catch {
    return false;
  }
}
