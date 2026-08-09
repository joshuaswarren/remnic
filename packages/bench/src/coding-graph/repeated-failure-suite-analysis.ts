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
} from "./repeated-failure-store.js";
import { verifyMatchingTrapAudit } from "./repeated-failure-trap-audit.js";
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
  buildFixtureToolDefinitions,
  FixtureToolHost,
  FixtureActionEvaluator,
  countFactTokens,
  decisionRuleAnalysisOptions,
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

export function assertCompleteRows(
  rows: readonly RepeatedFailureEpisodeRow[],
  plans: readonly PlannedRow[],
): void {
  const expectedKeys = plans.map((plan) => buildRepeatedFailureRowKey(plan.identity)).sort(compareCodePoints);
  const actualKeys = rows.map((row) => row.rowKey).sort(compareCodePoints);
  if (stableStringify(expectedKeys) !== stableStringify(actualKeys)) {
    throw new Error(`terminal row completeness failed: expected ${expectedKeys.length}, found ${actualKeys.length}`);
  }
  for (const row of rows) {
    if (!row.evidence || !row.isolation) {
      throw new Error(
        `terminal row lacks complete evidence: ${row.rowKey} (${row.status === "INVALID" ? row.invalidReason : row.finalState})`,
      );
    }
  }
}

export function assertDesignRowsPresent(
  rows: readonly RepeatedFailureEpisodeRow[],
  identities: readonly RepeatedFailureRowIdentity[],
): void {
  const expected = identities.map(buildRepeatedFailureRowKey).sort(compareCodePoints);
  const actual = rows.map((row) => row.rowKey).sort(compareCodePoints);
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error("episodes do not match the expected design");
  }
}

export function collectTaskRevisions(
  plans: readonly PlannedRow[],
): RepeatedFailureRunMetadata["taskRevisions"] {
  const revisions = new Map<string, RepeatedFailureRunMetadata["taskRevisions"][number]>();
  for (const plan of plans) {
    const key = `${plan.task.id}\u0000${plan.variant.variantId}`;
    revisions.set(key, {
      taskId: plan.task.id,
      variantId: plan.variant.variantId,
      cleanRevisionSha: plan.variant.cleanRevisionSha,
      trapRevisionSha: plan.variant.trapRevisionSha,
      rightRevisionSha: plan.variant.rightRevisionSha,
      noTrapRevisionSha: plan.variant.noTrapRevisionSha,
    });
  }
  return [...revisions.values()].sort(
    (left, right) => compareCodePoints(left.taskId, right.taskId)
      || compareCodePoints(left.variantId, right.variantId),
  );
}

export function buildToolLocks(
  plans: readonly PlannedRow[],
  maxToolOutputChars: number,
): RepeatedFailureRunMetadata["toolLocks"] {
  const schemaHashes = new Map<string, RepeatedFailureRunMetadata["toolLocks"]["taskToolSchemaHashes"][number]>();
  for (const plan of plans) {
    const key = `${plan.task.id}\u0000${plan.variant.variantId}`;
    if (schemaHashes.has(key)) continue;
    const tools = new FixtureToolHost(
      ".",
      plan.task,
      plan.variant,
      maxToolOutputChars,
      plan.noTrapControl,
    ).tools;
    schemaHashes.set(key, {
      taskId: plan.task.id,
      variantId: plan.variant.variantId,
      sha256: sha256(stableStringify(tools)),
    });
  }
  return {
    allowedTools: ["apply_strategy", "inspect_repo", "read_file", "run_check"],
    taskToolSchemaHashes: [...schemaHashes.values()].sort(
      (left, right) => compareCodePoints(left.taskId, right.taskId)
        || compareCodePoints(left.variantId, right.variantId),
    ),
  };
}

export async function resolvePackageRootFromModuleFile(
  moduleFile: string,
  packageName: string,
): Promise<string> {
  let candidate = path.dirname(await realpath(moduleFile));
  for (;;) {
    const packageJsonPath = path.join(candidate, "package.json");
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown };
      if (packageJson.name !== packageName) {
        throw new Error(`resolved module belongs to ${String(packageJson.name)}, not ${packageName}`);
      }
      return realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`unable to locate ${packageName} package root`);
    }
    candidate = parent;
  }
}

export function assertCoreRepoRootMatch(expectedCoreRoot: string, resolvedCoreRoot: string): void {
  if (resolvedCoreRoot !== expectedCoreRoot) {
    throw new RepeatedFailurePreflightError(
      "CORE_REPO_DIR_MISMATCH",
      "Resolved H6 core modules do not belong to the same @remnic/core package instance",
    );
  }
}

export async function assertCoreRepoDirMatchesHarness(): Promise<void> {
  try {
    const expectedCoreRoot = await resolvePackageRootFromModuleFile(
      fileURLToPath(import.meta.resolve("@remnic/core")),
      "@remnic/core",
    );
    const resolvedCoreFiles = [
      fileURLToPath(import.meta.resolve("@remnic/core/maintenance/atomic-file")),
      fileURLToPath(import.meta.resolve("@remnic/core/causal-trajectory")),
      fileURLToPath(import.meta.resolve("@remnic/core/coding/pre-action-gate")),
    ];
    for (const resolvedCoreFile of resolvedCoreFiles) {
      const resolvedCoreRoot = await resolvePackageRootFromModuleFile(resolvedCoreFile, "@remnic/core");
      assertCoreRepoRootMatch(expectedCoreRoot, resolvedCoreRoot);
    }
  } catch (error) {
    if (error instanceof RepeatedFailurePreflightError) throw error;
    throw new RepeatedFailurePreflightError(
      "CORE_REPO_DIR_MISMATCH",
      `Unable to verify the @remnic/core package root: ${publicError(error)}`,
    );
  }
}

export async function computeAnalysisHarnessHash(): Promise<string> {
  await assertCoreRepoDirMatchesHarness();
  const moduleFile = fileURLToPath(import.meta.url);
  const sourceDir = path.dirname(moduleFile);
  const resolvedCorePreActionGate = fileURLToPath(
    import.meta.resolve("@remnic/core/coding/pre-action-gate"),
  );
  const sharedCorePaths = {
    coreAtomicFile: fileURLToPath(import.meta.resolve("@remnic/core/maintenance/atomic-file")),
    coreCausalTrajectory: fileURLToPath(import.meta.resolve("@remnic/core/causal-trajectory")),
    corePreActionGate: resolvedCorePreActionGate,
  };
  const codingGraphSourceFiles = await listRegularFiles(sourceDir, false);
  const codingGraphSourcePaths = Object.fromEntries(
    codingGraphSourceFiles
      .filter((sourcePath) => sourcePath.endsWith(".ts") && !sourcePath.endsWith(".test.ts"))
      .map((sourcePath) => [
        `codingGraph/${path.relative(sourceDir, sourcePath).split(path.sep).join("/")}`,
        sourcePath,
      ]),
  );
  const sourcePaths = path.basename(sourceDir) === "dist"
    ? {
        ...sharedCorePaths,
        benchBundle: moduleFile,
      }
    : {
        ...sharedCorePaths,
        ...codingGraphSourcePaths,
        reporter: path.resolve(sourceDir, "../reporter.ts"),
        reproManifest: path.resolve(sourceDir, "../repro-manifest.ts"),
        reproManifestSchema: path.resolve(sourceDir, "../repro-manifest-schema.ts"),
        scorer: path.resolve(sourceDir, "../scorer.ts"),
        seededRandom: path.resolve(sourceDir, "../seeded-random.ts"),
      };
  const sourceHashes = Object.fromEntries(await Promise.all(
    Object.entries(sourcePaths).map(async ([name, sourcePath]) => [
      name,
      sha256(await readFile(sourcePath)),
    ]),
  ));
  return sha256(stableStringify({
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    sourceHashes,
  }));
}

export async function verifyResumeSourceIntegrity(outputDir: string): Promise<void> {
  const manifestPath = path.join(outputDir, BENCHMARK_REPRO_MANIFEST_FILENAME);
  if (!await pathExists(manifestPath)) return;
  await verifyRunManifest(outputDir);
  throw new Error("resume run is finalized and immutable");
}

export async function verifyRunManifest(runDir: string): Promise<BenchmarkReproManifest> {
  const manifestPath = await containedRegularFile(runDir, BENCHMARK_REPRO_MANIFEST_FILENAME);
  const manifest = parseBenchmarkReproManifest(JSON.parse(
    await readFile(manifestPath, "utf8"),
  ));
  const { artifactHash, ...withoutHash } = manifest;
  if (computeBenchmarkReproManifestArtifactHash(withoutHash) !== artifactHash) {
    throw new Error("MANIFEST artifact hash mismatch");
  }
  const requiredSupplemental = [
    "audit.json",
    "decision-rule.json",
    "deviations.jsonl",
    "episodes.jsonl",
    "expected-design.json",
    "fact-pair-audit.json",
    "power.json",
    "run.json",
    "statistics.json",
  ];
  const listedSupplemental = new Set(
    (manifest.supplementalArtifacts ?? []).map((artifact) => artifact.path),
  );
  if (
    manifest.results.length === 0
    || requiredSupplemental.some((artifact) => !listedSupplemental.has(artifact))
  ) {
    throw new Error("MANIFEST is missing a required H6 artifact hash");
  }
  for (const artifact of manifest.supplementalArtifacts ?? []) {
    const bytes = await readFile(await containedRegularFile(runDir, artifact.path));
    if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`manifest supplemental artifact hash mismatch: ${artifact.path}`);
    }
  }
  for (const result of manifest.results) {
    const bytes = await readFile(await containedRegularFile(runDir, result.path));
    if (bytes.length !== result.sizeBytes || sha256(bytes) !== result.sha256) {
      throw new Error(`manifest result artifact hash mismatch: ${result.path}`);
    }
  }
  return manifest;
}
function expectedRegisteredRunOrder(
  bundle: FixtureBundle,
  taskIds: readonly string[],
  drivers: NormalizedRunOptions["drivers"],
  seeds: readonly number[],
): RepeatedFailureRunMetadata["runOrder"] {
  const tasks = bundle.dataset.tasks
    .filter((task) => taskIds.includes(task.id))
    .sort((left, right) => compareCodePoints(left.id, right.id));
  const order: RepeatedFailureRunMetadata["runOrder"][number][] = [];
  for (const task of tasks) {
    for (const variant of [...task.variants].sort(
      (left, right) => compareCodePoints(left.variantId, right.variantId),
    )) {
      for (const seed of seeds) {
        for (const driver of drivers) {
          for (const arm of PRIMARY_ARMS) {
            const identity = identityFor(
              bundle.suiteVersion,
              task.id,
              variant.variantId,
              driver,
              seed,
              arm,
            );
            order.push({
              rowKey: buildRepeatedFailureRowKey(identity),
              analysis: "PRIMARY",
              identity,
            });
          }
          for (const arm of TIMIDITY_ARMS) {
            const identity = identityFor(
              bundle.suiteVersion,
              task.id,
              `${variant.variantId}:no-trap`,
              driver,
              seed,
              arm,
            );
            order.push({
              rowKey: buildRepeatedFailureRowKey(identity),
              analysis: "TIMIDITY",
              identity,
            });
          }
        }
      }
    }
  }
  return order;
}


export async function verifyPilotPower(
  pilotRunDir: string | undefined,
  bundle: FixtureBundle,
  configuration: NormalizedRunOptions,
  harnessVersion: string,
  harnessSourceHash: string,
): Promise<VerifiedPilotPower> {
  if (!pilotRunDir) throw new Error("main execution requires a verified pilot run");
  const runDir = path.resolve(pilotRunDir);
  const manifest = await verifyRunManifest(runDir);
  const metadata = parseRunMetadata(
    JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")),
  );
  const expectedProfiles = configuration.drivers.map(
    (driver) => [
      driver.modelProfileId,
      driver.modelProfileHash,
      driver.modelDigest,
      driver.driverKind ?? "unknown",
      driver.tokenizer.identity,
      driver.tokenizer.implementation,
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const pilotProfiles = metadata.modelProfileIds.map(
    (id, index) => [
      id,
      metadata.modelProfileHashes[index] ?? "",
      metadata.modelDigests[index] ?? "",
      metadata.modelDriverKinds[index] ?? "",
      metadata.modelTokenizerIdentities[index] ?? "",
      metadata.modelTokenizerImplementations[index] ?? "",
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const supplementalByPath = new Map(
    (manifest.supplementalArtifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const trapAuditsMatch = metadata.trapAuditReceipts.length === configuration.drivers.length
    && new Set(metadata.trapAuditReceipts.map((receipt) => receipt.path)).size
      === metadata.trapAuditReceipts.length
    && (await Promise.all(configuration.drivers.map(async (driver) => {
      const receipts = metadata.trapAuditReceipts.filter(
        (receipt) =>
          receipt.modelProfileId === driver.modelProfileId
          && receipt.modelProfileHash === driver.modelProfileHash
          && receipt.modelDigest === driver.modelDigest
          && receipt.tokenizerIdentity === driver.tokenizer.identity
          && receipt.tokenizerImplementation === driver.tokenizer.implementation,
      );
      if (receipts.length !== 1) return false;
      const receipt = receipts[0]!;
      if (!supplementalByPath.has(receipt.path)) return false;
      const parsed = JSON.parse(
        await readFile(await containedRegularFile(runDir, receipt.path), "utf8"),
      ) as unknown;
      const verified = await verifyMatchingTrapAudit(
        {
          id: driver.modelProfileId,
          hash: driver.modelProfileHash,
          modelDigest: driver.modelDigest,
        },
        bundle.dataset.inventoryHash,
        harnessSourceHash,
        {
          hash: sha256(bundle.decisionRuleBytes),
          trapAudit: bundle.decisionRule.trapAudit,
        },
        [runDir],
      );
      return verified.artifactHash === receipt.artifactHash
        && stableStringify(parsed) === stableStringify(verified);
    }))).every(Boolean);
  const pilotProvenanceHash = sha256(stableStringify({
    analysisVersion: metadata.analysisVersion,
    harnessVersion: metadata.harnessVersion,
    harnessSourceHash: metadata.harnessSourceHash,
    gitSha: metadata.gitSha,
    gitDirty: metadata.gitDirty,
    gitDirtyEntryCount: metadata.gitDirtyEntryCount,
  }));
  if (
    metadata.phase !== "pilot"
    || metadata.mode !== "full"
    || metadata.datasetInventoryHash !== FROZEN_DATASET_INVENTORY_HASH
    || metadata.datasetInventoryHash !== bundle.dataset.inventoryHash
    || metadata.decisionRuleHash !== sha256(bundle.decisionRuleBytes)
    || metadata.analysisVersion !== REPEATED_FAILURE_ANALYSIS_VERSION
    || metadata.harnessVersion !== harnessVersion
    || metadata.harnessSourceHash !== harnessSourceHash
    || metadata.provenanceHash !== pilotProvenanceHash
    || metadata.statisticsSeed !== bundle.dataset.seed
    || metadata.statisticsDraws !== REPEATED_FAILURE_STATISTICS_DRAWS
    || stableStringify(metadata.seeds) !== stableStringify(FROZEN_SEEDS)
    || stableStringify(metadata.splitTaskIds)
      !== stableStringify([...bundle.dataset.splits.pilot].sort(compareCodePoints))
    || !trapAuditsMatch
    || stableStringify(pilotProfiles) !== stableStringify(expectedProfiles)
    || stableStringify(metadata.caps) !== stableStringify({
      ...DEFAULT_CAPS,
      maxToolOutputChars: DEFAULT_TOOL_OUTPUT_CHARS,
    })
    || metadata.retryRule.hostApiFaultRetriesAfterFirstTry !== 5
    || metadata.retryRule.rerunTaskResults
    || !metadata.retryRule.retainAllTries
  ) {
    throw new Error("pilot run does not match the frozen main power contract");
  }
  const designBytes = await readFile(path.join(runDir, "expected-design.json"), "utf8");
  const design = parseDesign(JSON.parse(designBytes));
  if (sha256(stableStringify(design)) !== metadata.expectedDesignHash) {
    throw new Error("pilot expected-design hash mismatch");
  }
  const frozenPilotRunOrder = expectedRegisteredRunOrder(
    bundle,
    bundle.dataset.splits.pilot,
    configuration.drivers,
    FROZEN_SEEDS,
  );
  if (
    stableStringify(metadata.runOrder) !== stableStringify(design.runOrder)
    || stableStringify(metadata.runOrder) !== stableStringify(frozenPilotRunOrder)
  ) {
    throw new Error("pilot run order does not match the frozen deterministic schedule");
  }
  const episodeBytes = await readFile(path.join(runDir, "episodes.jsonl"), "utf8");
  const rows = parseEpisodesJsonl(episodeBytes);
  assertDesignRowsPresent(rows, [...design.primary.rows, ...design.timidity.rows]);
  const powerBytes = await readFile(path.join(runDir, "power.json"), "utf8");
  const power = parseComputedPilotPower(JSON.parse(powerBytes));
  const replayedAnalysis = analyzeRepeatedFailureRows(rows, {
    expectedDesign: design.primary,
    timidityDesign: design.timidity,
    seed: metadata.statisticsSeed,
    draws: metadata.statisticsDraws,
    ...decisionRuleAnalysisOptions(bundle.decisionRule),
  });
  const replayedPower = buildPowerArtifact(
    rows,
    {
      ...configuration,
      phase: "pilot",
      taskIds: [...metadata.splitTaskIds],
      seeds: [...metadata.seeds],
      statisticsSeed: metadata.statisticsSeed,
      statisticsDraws: metadata.statisticsDraws,
    },
    "full",
    replayedAnalysis,
    bundle.decisionRule,
    {
      episodesHash: sha256(episodeBytes),
      expectedDesignHash: sha256(designBytes),
      decisionRuleHash: metadata.decisionRuleHash,
    },
  );
  if (stableStringify(power.raw) !== stableStringify(replayedPower)) {
    throw new Error("pilot power does not match deterministic replay");
  }
  if (
    power.draws !== REPEATED_FAILURE_STATISTICS_DRAWS
    || power.analysisDraws !== REPEATED_FAILURE_STATISTICS_DRAWS
    || power.analysisVersion !== REPEATED_FAILURE_ANALYSIS_VERSION
    || power.sourceEpisodesHash !== sha256(episodeBytes)
    || power.sourceDesignHash !== sha256(designBytes)
    || power.decisionRuleHash !== metadata.decisionRuleHash
    || power.timingPower < 0.8
    // H6-content is excluded from this gate by preregistration Amendment 3: its
    // task-pass condition is unsatisfiable at every audited configuration, so
    // gating on it would block the study on a test the design cannot run.
    // Content power is still computed and reported in power.json.
    || power.timidityPower < 0.8
  ) {
    throw new Error("pilot power is absent, underpowered, or does not match immutable pilot rows");
  }
  return {
    runId: metadata.runId,
    manifestArtifactHash: manifest.artifactHash,
    powerArtifactHash: sha256(stableStringify(power.raw)),
    artifact: power.raw,
    profileBindings: metadata.modelProfileIds.map((id, index) => ({
      id,
      hash: metadata.modelProfileHashes[index]!,
      modelDigest: metadata.modelDigests[index]!,
      driverKind: metadata.modelDriverKinds[index]!,
      tokenizerIdentity: metadata.modelTokenizerIdentities[index]!,
      tokenizerImplementation: metadata.modelTokenizerImplementations[index]!,
    })).sort((left, right) => compareCodePoints(
      stableStringify(left),
      stableStringify(right),
    )),
    trapAuditReceipts: [...metadata.trapAuditReceipts].sort(
      (left, right) => compareCodePoints(stableStringify(left), stableStringify(right)),
    ),
    runOrder: metadata.runOrder,
    expectedDesignHash: sha256(designBytes),
    episodesHash: sha256(episodeBytes),
  };
}

export function parseComputedPilotPower(value: unknown): {
  raw: Record<string, unknown>;
  draws: number;
  analysisDraws: number;
  analysisVersion: string;
  sourceEpisodesHash: string;
  sourceDesignHash: string;
  decisionRuleHash: string;
  timingPower: number;
  contentPower: number;
  timidityPower: number;
} {
  const parsed = z.object({
    schemaVersion: z.literal(1),
    status: z.literal("COMPUTED"),
    phase: z.literal("pilot"),
    method: z.object({
      analysisVersion: z.string().min(1),
      simulation: z.literal("task-group bootstrap experiments"),
      decisionProcedure: z.literal("grouped bootstrap + paired shuffle + Holm"),
    }).passthrough(),
    seed: z.number().int().nonnegative().max(0xffffffff),
    draws: z.number().int().positive(),
    analysisDraws: z.number().int().positive(),
    source: z.object({
      episodesHash: z.string().regex(SHA256_PATTERN),
      expectedDesignHash: z.string().regex(SHA256_PATTERN),
      decisionRuleHash: z.string().regex(SHA256_PATTERN),
    }).strict(),
    simulations: z.object({
      timing: z.object({ power: z.number().min(0).max(1) }).passthrough(),
      content: z.object({ power: z.number().min(0).max(1) }).passthrough(),
      timidity: z.object({ power: z.number().min(0).max(1) }).passthrough(),
    }).strict(),
  }).passthrough().parse(value);
  return {
    raw: parsed,
    draws: parsed.draws,
    analysisDraws: parsed.analysisDraws,
    analysisVersion: parsed.method.analysisVersion,
    sourceEpisodesHash: parsed.source.episodesHash,
    sourceDesignHash: parsed.source.expectedDesignHash,
    decisionRuleHash: parsed.source.decisionRuleHash,
    timingPower: parsed.simulations.timing.power,
    contentPower: parsed.simulations.content.power,
    timidityPower: parsed.simulations.timidity.power,
  };
}

export async function buildFactPairAudit(
  plans: readonly PlannedRow[],
  templates: Map<string, HistoryTemplate>,
  drivers: readonly RepeatedFailureEpisodeDriver[],
): Promise<FactPairAuditArtifact> {
  const tokenizerByProfile = new Map(drivers.map((driver) => [
    `${driver.modelProfileId}\u0000${driver.modelProfileHash}`,
    driver.tokenizer,
  ]));
  const seen = new Set<string>();
  const pairs: FactPairAuditPair[] = [];
  for (const plan of plans) {
    if (plan.noTrapControl) continue;
    const pairIdentity = {
      taskId: plan.identity.taskId,
      variantId: plan.identity.variantId,
      seed: plan.identity.seed,
      modelProfileId: plan.identity.modelProfileId,
      modelProfileHash: plan.identity.modelProfileHash,
    };
    const pairKey = stableStringify(pairIdentity);
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const tokenizer = tokenizerByProfile.get(
      `${plan.identity.modelProfileId}\u0000${plan.identity.modelProfileHash}`,
    );
    if (!tokenizer) throw new Error(`missing tokenizer for ${plan.identity.modelProfileId}`);
    const templateKey = `${plan.task.id}\u0000${plan.variant.variantId}`;
    let template = templates.get(templateKey);
    if (!template) {
      template = await buildHistoryTemplate(plan.task, plan.variant);
      templates.set(templateKey, template);
    }
    const history = freezeHistory(template, plan.identity);
    const failureTokens = countFactTokens(history.failureFact, tokenizer);
    const successTokens = countFactTokens(history.successFact, tokenizer);
    const tokenGap = Math.abs(failureTokens - successTokens);
    const relativeTokenGap = tokenGap / Math.max(failureTokens, successTokens, 1);
    const jaccard = calculateJaccardSimilarity(history.failureFact, history.successFact);
    pairs.push({
      pairKey: sha256(pairKey),
      ...pairIdentity,
      tokenizerIdentity: tokenizer.identity,
      tokenizerImplementation: tokenizer.implementation,
      historyHash: history.historyHash,
      failureRepoHash: history.failureRepoHash,
      successRepoHash: history.successRepoHash,
      failureActionFingerprint: history.failureActionIdentity.fingerprint,
      successActionFingerprint: history.successActionIdentity.fingerprint,
      failurePathShapeHash: history.failurePathShapeHash,
      successPathShapeHash: history.successPathShapeHash,
      failureActionShapeHash: history.failureActionShapeHash,
      successActionShapeHash: history.successActionShapeHash,
      failureFactId: history.failureFactId,
      failureCitationHash: history.failureCitationHash,
      failureFactHash: sha256(history.failureFact),
      successFactHash: sha256(history.successFact),
      failureFactCount: 1,
      successFactCount: 1,
      failureTokens,
      successTokens,
      tokenGap,
      relativeTokenGap,
      jaccard,
      status: auditFactPair(history, tokenizer),
    });
  }
  return {
    schemaVersion: 1,
    minimumJaccard: 0.8,
    maximumTokenGap: 8,
    maximumRelativeTokenGap: 0.05,
    pairs,
  };
}

export function buildPowerArtifact(
  rows: readonly RepeatedFailureEpisodeRow[],
  configuration: NormalizedRunOptions,
  mode: BenchmarkMode,
  analysis: RepeatedFailureStatisticalAnalysis,
  decisionRule: FixtureBundle["decisionRule"],
  source: {
    episodesHash: string;
    expectedDesignHash: string;
    decisionRuleHash: string;
  },
): Record<string, unknown> {
  if (configuration.phase === "unspecified" && mode !== "full") {
    return {
      schemaVersion: 1,
      status: "NOT_RUN",
      phase: "unspecified",
      reason: "quick programmatic run is not a registered pilot power population",
      seed: configuration.statisticsSeed,
      draws: configuration.statisticsDraws,
      source,
    };
  }
  const taskGroups = new Map<string, RepeatedFailureEpisodeRow[]>();
  for (const row of rows) {
    const group = taskGroups.get(row.identity.taskId) ?? [];
    group.push(row);
    taskGroups.set(row.identity.taskId, group);
  }
  const primaryCuts = analysis.cuts.filter(
    (cut) => cut.hypothesis === "TIMING" || cut.hypothesis === "CONTENT",
  );
  if (
    configuration.phase !== "pilot"
    || primaryCuts.length > 0
    || analysis.timidity.equivalent === null
    || taskGroups.size !== configuration.taskIds.length
  ) {
    return {
      schemaVersion: 1,
      status: "NOT_ESTIMABLE",
      phase: configuration.phase,
      reason: "pilot task groups are incomplete or cut by the registered analysis",
      seed: configuration.statisticsSeed,
      draws: configuration.statisticsDraws,
      analysisDraws: configuration.statisticsDraws,
      source,
      cuts: analysis.cuts,
      taskCount: taskGroups.size,
    };
  }
  const groups = [...taskGroups.entries()].sort(
    ([left], [right]) => compareCodePoints(left, right),
  );
  const random = createSeededRandom((configuration.statisticsSeed ^ 0x6a09e667) >>> 0);
  const cached = new Map<string, RepeatedFailureStatisticalAnalysis>();
  let timingSupported = 0;
  let contentSupported = 0;
  let timidityEquivalent = 0;
  const mainTaskCount = H6_FROZEN_SPLITS.main.length;
  for (let draw = 0; draw < configuration.statisticsDraws; draw += 1) {
    const sampled = Array.from({ length: mainTaskCount }, () => {
      const group = groups[Math.floor(random() * groups.length)];
      if (!group) throw new Error("power simulation sampled an empty task population");
      return group;
    }).sort(([left], [right]) => compareCodePoints(left, right));
    const cacheKey = sampled.map(([taskId]) => taskId).join("\u0000");
    let simulated = cached.get(cacheKey);
    if (!simulated) {
      const experiment = materializePowerExperiment(sampled);
      simulated = analyzeRepeatedFailureRows(experiment.rows, {
        expectedDesign: experiment.primary,
        timidityDesign: experiment.timidity,
        seed: (
          configuration.statisticsSeed
          ^ (Number.parseInt(sha256(cacheKey).slice(0, 8), 16) >>> 0)
        ) >>> 0,
        draws: configuration.statisticsDraws,
        ...decisionRuleAnalysisOptions(decisionRule),
      });
      cached.set(cacheKey, simulated);
    }
    if (simulated.decisions.timing === "SUPPORTED") timingSupported += 1;
    if (simulated.decisions.content === "SUPPORTED") contentSupported += 1;
    if (simulated.timidity.equivalent === true) timidityEquivalent += 1;
  }
  const draws = configuration.statisticsDraws;
  return {
    schemaVersion: 1,
    status: "COMPUTED",
    phase: "pilot",
    method: {
      analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
      simulation: "task-group bootstrap experiments",
      decisionProcedure: "grouped bootstrap + paired shuffle + Holm",
      primaryInterval: "paired task bootstrap 95%",
      primaryPValue: "one-sided paired task shuffle with plus-one correction",
      multiplicity: "Holm family of timing and content compound p",
      timidityInterval: "paired task bootstrap 90%",
      unit: "task",
    },
    seed: configuration.statisticsSeed,
    draws,
    analysisDraws: configuration.statisticsDraws,
    source,
    inputs: {
      taskCount: groups.length,
      simulatedTaskCount: mainTaskCount,
      rowCount: rows.length,
      uniqueResampledExperiments: cached.size,
      timingTargetRelativeRiskReduction:
        decisionRule.hypotheses["H6-timing"].minimumRelativeRiskReduction,
      timidityPassRateMargin: decisionRule.timidity.passRateMargin,
      timidityStepsMargin: decisionRule.timidity.stepsMargin,
      timidityGatePassRate: decisionRule.timidity.gatePassRate,
    },
    simulations: {
      timing: {
        supportedDraws: timingSupported,
        power: timingSupported / draws,
        requiredPower: 0.8,
      },
      content: {
        supportedDraws: contentSupported,
        power: contentSupported / draws,
        requiredPower: 0.8,
      },
      timidity: {
        equivalentDraws: timidityEquivalent,
        power: timidityEquivalent / draws,
        requiredPower: 0.8,
      },
    },
  };
}

export function materializePowerExperiment(
  sampled: readonly [string, RepeatedFailureEpisodeRow[]][],
): {
  rows: RepeatedFailureEpisodeRow[];
  primary: RepeatedFailureExpectedDesign;
  timidity: RepeatedFailureExpectedDesign;
} {
  const rows = sampled.flatMap(([, group], slot) => group.map((row) => {
    const identity = {
      ...row.identity,
      taskId: `power-task-${String(slot + 1).padStart(2, "0")}`,
    };
    return {
      ...row,
      rowKey: `power-row-${sha256(stableStringify(identity))}`,
      identity,
    };
  }));
  return {
    rows,
    primary: {
      rows: rows.filter((row) => !row.identity.variantId.endsWith(":no-trap"))
        .map((row) => row.identity),
    },
    timidity: {
      rows: rows.filter((row) => row.identity.variantId.endsWith(":no-trap"))
        .map((row) => row.identity),
    },
  };
}


export function buildVerifiedPilotPowerArtifact(pilot: VerifiedPilotPower): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "VERIFIED_PILOT",
    phase: "main",
    requiredPower: 0.8,
    pilotRunId: pilot.runId,
    pilotManifestArtifactHash: pilot.manifestArtifactHash,
    pilotPowerArtifactHash: pilot.powerArtifactHash,
    pilot: pilot.artifact,
    pilotProfileBindings: pilot.profileBindings,
    pilotTrapAuditReceipts: pilot.trapAuditReceipts,
    pilotRunOrder: pilot.runOrder,
    pilotExpectedDesignHash: pilot.expectedDesignHash,
    pilotEpisodesHash: pilot.episodesHash,
  };
}
