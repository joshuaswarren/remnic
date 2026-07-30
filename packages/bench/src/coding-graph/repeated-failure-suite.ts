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
import { verifyMatchingTrapAudit } from "./repeated-failure-trap-audit.js";
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FROZEN_DATASET_INVENTORY_HASH = H6_FROZEN_INVENTORY_HASH;
const FROZEN_SEEDS = Object.freeze([1, 2, 3, 4, 5]);
const REPEATED_FAILURE_ANALYSIS_VERSION = "h6-task-bootstrap-shuffle-holm-v1";
const FIXED_RECORDED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_CAPS: ControlledResponsesCaps = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 8,
  maxTotalTokens: 16_384,
  maxDurationMs: 120_000,
  requestTimeoutMs: 60_000,
});
const HISTORY_ACTION_SUMMARY = "Changed target code after inspecting api cache call class config contract data edge error event field file flow graph guard input job key link map node path queue rule scope state.";
const HISTORY_FAILURE_SUMMARY = "Offline check classified result TRAPPED while preserving branch build case command commit diff edit export hash import index intent module patch range repo schema script symbol.";
const HISTORY_SUCCESS_SUMMARY = "Offline check classified result FIXED while preserving branch build case command commit diff edit export hash import index intent module patch range repo schema script symbol.";
const HISTORY_FOLLOW_UP = "Inspect root cause and choose another strategy after checking artifact audit boundary context evidence invariant memory output policy record revision safety session source status.";
const PRIMARY_ARMS = REPEATED_FAILURE_ARMS;
const TIMIDITY_ARMS = Object.freeze(["NO_MEMORY", "PRE_ACTION_FAILURE"] as const);
const DEFAULT_TOOL_OUTPUT_CHARS = 16_384;
const MAX_INSPECT_FILES = 200;
const NEUTRAL_INSTRUCTION = "Inspect the codebase, identify the defect, and apply the appropriate code changes using the tools.";
export const PROMPT_CONTRACT = Object.freeze({
  version: "h6-repeated-failure-prompt-v1",
  repositoryFrame: "You are working in a generated offline repository. Use only the supplied tools.",
  noTrapInstruction: NEUTRAL_INSTRUCTION,
  trapInstruction: NEUTRAL_INSTRUCTION,
  recalledFactLabel: "Recalled episode-1 fact:",
});

const ArmManifestSchema = z.array(z.object({
  id: z.enum(REPEATED_FAILURE_ARMS),
  name: z.string().min(1),
  description: z.string().min(1),
}).strict()).length(REPEATED_FAILURE_ARMS.length);

const DecisionRuleSchema = z.object({
  version: z.literal(2),
  analysisPopulation: z.object({
    datasetVersion: z.literal(1),
    datasetInventoryHash: z.string().regex(SHA256_PATTERN).optional(),
    split: z.enum(["main", "pilot"]),
    pairingKey: z.array(z.string()).min(1),
    maximumPrimaryTaskCuts: z.literal(0),
  }).passthrough(),
  analysis: z.object({
    bootstrap: z.object({ draws: z.number().int().positive(), group: z.literal("task") }).passthrough(),
    shuffle: z.object({ draws: z.number().int().positive(), group: z.literal("task") }).passthrough(),
    alpha: z.number().positive().max(1),
    multiplicity: z.object({ method: z.literal("HOLM") }).passthrough(),
  }).passthrough(),
  factMatching: z.object({
    timing: z.object({ requireSameFactIds: z.literal(true), requireSameCitationHashes: z.literal(true) }).passthrough(),
    content: z.object({ tokenCountGap: z.object({
      maximumAbsolute: z.number().int().nonnegative(),
      maximumRelative: z.number().nonnegative(),
    }).passthrough() }).passthrough(),
  }).passthrough(),
  hypotheses: z.object({
    "H6-timing": z.object({
      baselineArm: z.literal("TURN_START_FAILURE"),
      candidateArm: z.literal("PRE_ACTION_FAILURE"),
      minimumRelativeRiskReduction: z.number().nonnegative(),
    }).passthrough(),
    "H6-content": z.object({
      baselineArm: z.literal("TURN_START_SUCCESS"),
      candidateArm: z.literal("TURN_START_FAILURE"),
    }).passthrough(),
  }).passthrough(),
  timidity: z.object({
    baselineArm: z.literal("NO_MEMORY"),
    candidateArm: z.literal("PRE_ACTION_FAILURE"),
    population: z.literal("main_no_trap_revisions"),
    passRateMargin: z.number().nonnegative(),
    stepsMargin: z.number().nonnegative(),
  }).passthrough(),
  completeness: z.object({
    primaryArmCount: z.literal(5),
    hostFaultRetriesAfterFirstTry: z.literal(2),
    rerunTaskResults: z.literal(false),
  }).passthrough(),
}).passthrough();

const ProfileInstructionsSchema = z.object({
  system: z.string().min(1).max(16_384),
  developer: z.string().min(1).max(16_384),
}).strict();
const ProfileTokenizerSchema = z.object({
  identity: z.string().min(1).max(256),
  implementation: z.literal("nfkc-whitespace-v1"),
}).strict();
const OpenAiModelProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(256),
  provider: z.literal("openai-responses"),
  model: z.string().min(1).max(256),
  endpoint: z.string().min(1).max(2048).optional(),
  instructions: ProfileInstructionsSchema,
  tokenizer: ProfileTokenizerSchema,
  contextWindowTokens: z.number().int().positive(),
  temperature: z.literal(0),
  maxOutputTokens: z.number().int().positive(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  seedCapability: z.object({
    kind: z.literal("request_parameter"),
    requestField: z.literal("seed"),
  }).strict().optional(),
}).strict();
const OllamaChatModelProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(256),
  provider: z.literal("ollama-chat"),
  model: z.string().min(1).max(256),
  endpoint: z.string().min(1).max(2048).optional(),
  instructions: ProfileInstructionsSchema,
  tokenizer: ProfileTokenizerSchema,
  contextWindowTokens: z.number().int().positive(),
  temperature: z.literal(0),
  maxOutputTokens: z.number().int().positive(),
  think: z.boolean().optional(),
  seedCapability: z.object({
    kind: z.literal("options_parameter"),
    requestField: z.literal("seed"),
  }).strict(),
}).strict();
const ModelProfileSchema = z.discriminatedUnion("provider", [
  OpenAiModelProfileSchema,
  OllamaChatModelProfileSchema,
]);

export type RepeatedFailureModelProfile = z.infer<typeof ModelProfileSchema>;
type FixtureBundle = {
  fixtureDir: string;
  dataset: H6BenchmarkDataset;
  decisionRule: z.infer<typeof DecisionRuleSchema>;
  decisionRuleBytes: string;
  suiteVersion: string;
};
type HistoryTemplate = {
  failureFact: string;
  successFact: string;
  failureActionIdentity: ActionIdentity;
  successActionIdentity: ActionIdentity;
  failureRepoHash: string;
  successRepoHash: string;
  baselineRepoHash: string;
  failurePathShapeHash: string;
  successPathShapeHash: string;
  failureActionShapeHash: string;
  successActionShapeHash: string;
};
type FrozenHistory = HistoryTemplate & {
  historyHash: string;
  failureFactId: string;
  failureCitationHash: string;
};
type PlannedRow = {
  identity: RepeatedFailureRowIdentity;
  task: BaseTask;
  variant: TaskVariant;
  files: readonly SyntheticFile[];
  noTrapControl: boolean;
};
type DesignArtifact = {
  schemaVersion: 1;
  runOrder: readonly {
    rowKey: string;
    analysis: "PRIMARY" | "TIMIDITY";
    identity: RepeatedFailureRowIdentity;
  }[];
  primary: RepeatedFailureExpectedDesign;
  timidity: RepeatedFailureExpectedDesign;
};
type CheckExecution = {
  state: RepeatedFailureFinalRepoEvidence["checkResult"];
  exitCode: number;
  outputHash: string;
};
type NormalizedRunOptions = {
  outputDir: string;
  drivers: readonly RepeatedFailureEpisodeDriver[];
  seeds: readonly number[];
  taskIds: readonly string[];
  variantIds: readonly string[];
  caps: ControlledResponsesCaps;
  maxHostRetries: 0 | 1 | 2;
  statisticsSeed: number;
  statisticsDraws: number;
  maxToolOutputChars: number;
  phase: "pilot" | "main" | "unspecified";
  clock: () => number;
  now: () => Date;
};
type RowExecutionOptions = Pick<
  NormalizedRunOptions,
  "outputDir" | "caps" | "maxHostRetries" | "maxToolOutputChars" | "clock"
>;
type VerifiedPilotPower = {
  runId: string;
  manifestArtifactHash: string;
  powerArtifactHash: string;
  artifact: Record<string, unknown>;
};
type FactPairAuditPair = {
  pairKey: string;
  taskId: string;
  variantId: string;
  seed: number;
  modelProfileId: string;
  modelProfileHash: string;
  tokenizerIdentity: string;
  tokenizerImplementation: "nfkc-whitespace-v1";
  historyHash: string;
  failureRepoHash: string;
  successRepoHash: string;
  failureActionFingerprint: string;
  successActionFingerprint: string;
  failurePathShapeHash: string;
  successPathShapeHash: string;
  failureActionShapeHash: string;
  successActionShapeHash: string;
  failureFactId: string;
  failureCitationHash: string;
  failureFactHash: string;
  successFactHash: string;
  failureFactCount: 1;
  successFactCount: 1;
  failureTokens: number;
  successTokens: number;
  tokenGap: number;
  relativeTokenGap: number;
  jaccard: number;
  status: "MATCHED" | "UNMATCHED";
};
type FactPairAuditArtifact = {
  schemaVersion: 1;
  minimumJaccard: 0.8;
  maximumTokenGap: 8;
  maximumRelativeTokenGap: 0.05;
  pairs: readonly FactPairAuditPair[];
};
type ParsedStrategyAction = {
  strategyId: string;
  patch: StrategyPatch;
  intent: ActionIntent;
  strategyCategory: ActionStrategyId;
};

function buildFixtureToolDefinitions(
  task: BaseTask,
  variant: TaskVariant,
): readonly ControlledResponsesToolDefinition[] {
  const identityProperties = {
    identityVersion: { type: "integer", enum: [1] },
    strategyId: { type: "string", enum: variant.strategyCandidates.map((candidate) => candidate.id) },
    actionType: { type: "string", enum: [task.normalizedActionIntent.actionType] },
    targetSymbol: { type: "string", enum: [task.normalizedActionIntent.targetSymbol] },
    filePath: { type: "string", enum: [task.normalizedActionIntent.filePath] },
    contextHash: { type: "string", enum: [task.normalizedActionIntent.contextHash] },
  };
  return Object.freeze([
    {
      name: "inspect_repo",
      description: "List bounded repository-relative files without changing the repository.",
      gateEligible: false,
      inputSchema: strictObject({ path: { type: "string" } }, ["path"]),
    },
    {
      name: "read_file",
      description: "Read one bounded repository-relative UTF-8 file without changing it.",
      gateEligible: false,
      inputSchema: strictObject({ path: { type: "string" } }, ["path"]),
    },
    {
      name: "apply_strategy",
      description: "Apply one versioned strategy whose full action identity is checked against the task manifest.",
      gateEligible: true,
      inputSchema: strictObject(identityProperties, Object.keys(identityProperties)),
    },
    {
      name: "run_check",
      description: "Run the frozen offline task check and return its objective state.",
      gateEligible: false,
      inputSchema: strictObject({}, []),
    },
  ]);
}

class FixtureToolHost implements RepeatedFailureLocalToolHost {
  readonly tools: readonly ControlledResponsesToolDefinition[];
  readonly badStrategyId: string;
  private readonly initialHashes: ReadonlyMap<string, string>;
  private badExecutions = 0;

  constructor(
    private readonly repoDir: string,
    private readonly task: BaseTask,
    private readonly variant: TaskVariant,
    private readonly maxOutputChars: number,
    private readonly noTrapControl: boolean,
  ) {
    this.badStrategyId = variant.badStrategyPatch.id;
    this.initialHashes = new Map(
      (noTrapControl ? variant.noTrapControlFiles : variant.files).map((file) => [file.path, sha256(file.content)]),
    );
    this.tools = buildFixtureToolDefinitions(task, variant);
  }

  parseAction(action: RepeatedFailureProposedAction): ParsedStrategyAction | undefined {
    if (action.tool !== "apply_strategy") return undefined;
    const args = action.arguments;
    if (
      args.identityVersion !== 1 ||
      args.actionType !== this.task.normalizedActionIntent.actionType ||
      args.targetSymbol !== this.task.normalizedActionIntent.targetSymbol ||
      args.filePath !== this.task.normalizedActionIntent.filePath ||
      args.contextHash !== this.task.normalizedActionIntent.contextHash ||
      typeof args.strategyId !== "string"
    ) return undefined;
    const patch = args.strategyId === this.variant.badStrategyPatch.id
      ? this.variant.badStrategyPatch
      : args.strategyId === this.variant.goodStrategyPatch.id
        ? this.variant.goodStrategyPatch
        : undefined;
    if (!patch) return undefined;
    return {
      strategyId: args.strategyId,
      patch,
      strategyCategory: "CHANGE_IMPLEMENTATION",
      intent: {
        kind: "edit",
        filePath: this.task.normalizedActionIntent.filePath,
        editKind: "update",
        symbol: this.task.normalizedActionIntent.targetSymbol,
        diffShape: strategyDiffShape(this.task, args.strategyId),
      },
    };
  }

  async execute(action: RepeatedFailureProposedAction): Promise<RepeatedFailureToolExecutionResult> {
    if (action.tool === "inspect_repo") {
      try {
        const requested = typeof action.arguments.path === "string" ? action.arguments.path : "";
        const root = await containedRegularDirectory(this.repoDir, requested);
        const allFiles = (await listRegularFiles(root, false))
          .map((file) => path.relative(this.repoDir, file).split(path.sep).join("/"));
        const files = allFiles.slice(0, MAX_INSPECT_FILES);
        return { status: "completed", output: { files, truncated: allFiles.length > files.length } };
      } catch (error) {
        return failedTool(error);
      }
    }
    if (action.tool === "read_file") {
      try {
        const requested = requiredString(action.arguments.path, "path");
        const content = await readFile(await containedRegularFile(this.repoDir, requested), "utf8");
        return { status: "completed", output: {
          path: requested,
          content: content.slice(0, this.maxOutputChars),
          truncated: content.length > this.maxOutputChars,
        } };
      } catch (error) {
        return failedTool(error);
      }
    }
    if (action.tool === "apply_strategy") {
      const parsed = this.parseAction(action);
      if (!parsed) return { status: "failed", output: { code: "ACTION_IDENTITY_MISMATCH" } };
      try {
        for (const file of parsed.patch.files) {
          if (!isSafeSyntheticPath(file.path)) throw new Error("unsafe patch path");
          const filePath = containedPath(this.repoDir, file.path);
          await assertNoSymlinkComponents(this.repoDir, filePath);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, file.content, { encoding: "utf8", mode: file.isExecutable ? 0o755 : 0o644 });
        }
        if (parsed.strategyId === this.badStrategyId) this.badExecutions += 1;
        return { status: "completed", output: {
          applied: true,
          identityVersion: 1,
          strategyId: parsed.strategyId,
          changedFiles: parsed.patch.files.map((file) => file.path).sort(),
        } };
      } catch (error) {
        return failedTool(error);
      }
    }
    if (action.tool === "run_check") {
      return { status: "completed", output: await runOfflineCheck(this.repoDir, this.task) };
    }
    return { status: "failed", output: { code: "UNKNOWN_TOOL" } };
  }

  async captureFinalEvidence(): Promise<RepeatedFailureFinalRepoEvidence> {
    const check = await runOfflineCheck(this.repoDir, this.task);
    const currentFiles = await listRegularFiles(this.repoDir, true);
    const currentPaths = new Set<string>();
    const changedFiles: string[] = [];
    for (const filePath of currentFiles) {
      const relative = path.relative(this.repoDir, filePath).split(path.sep).join("/");
      currentPaths.add(relative);
      if (this.initialHashes.get(relative) !== sha256(await readFile(filePath))) changedFiles.push(relative);
    }
    for (const initialPath of this.initialHashes.keys()) {
      if (!currentPaths.has(initialPath)) changedFiles.push(initialPath);
    }
    return {
      repoHash: await hashDirectory(this.repoDir, true),
      checkResult: this.noTrapControl && check.state === "FIXED" ? "NO_TRAP" : check.state,
      changedFiles: [...new Set(changedFiles)].sort(),
    };
  }

  repeatedBadStrategy(): boolean {
    return this.badExecutions > 0;
  }
}

class FixtureActionEvaluator implements RepeatedFailureActionEvaluator {
  private readonly gate = new PreActionFailureGate({ timeoutMs: 5_000 });

  constructor(
    private readonly enabled: boolean,
    private readonly host: FixtureToolHost,
    private readonly repoDir: string,
    private readonly memoryDir: string,
    private readonly projectId: string,
    private readonly sessionKey: string,
    private readonly failureFact: string,
  ) {}

  async evaluate(action: RepeatedFailureProposedAction, context: { signal: AbortSignal }): Promise<ControlledGateDecision> {
    const parsed = this.host.parseAction(action);
    if (!parsed) return noMatchGate(action);
    const normalized = normalizeActionIntent(parsed.intent, parsed.strategyCategory, {
      projectId: this.projectId,
      rootPath: this.repoDir,
      branch: "main",
      defaultBranch: "main",
    });
    if (!this.enabled || parsed.strategyId !== this.host.badStrategyId) {
      return { status: "NO_MATCH", fingerprintHash: sha256(normalized.fingerprint) };
    }
    const result = await this.gate.evaluate({
      sessionKey: this.sessionKey,
      strategyId: parsed.strategyCategory,
      intent: parsed.intent,
      codingContext: {
        projectId: this.projectId,
        rootPath: this.repoDir,
        branch: "main",
        defaultBranch: "main",
      },
      memoryDir: this.memoryDir,
      signal: context.signal,
    });
    return {
      status: result.status,
      fingerprintHash: sha256(result.fingerprint ?? normalized.fingerprint),
      ...(result.status === "ERROR_FAIL_OPEN"
        && result.reason
        && /timed out|deadline exceeded/i.test(result.reason)
        ? { waitExpired: true }
        : {}),
      ...(result.advisoryText
        ? {
            advisoryText: result.advisoryText,
            warningHash: sha256(
              result.advisoryText.includes(this.failureFact) ? this.failureFact : result.advisoryText,
            ),
          }
        : {}),
      ...(result.reason ? { faultCode: boundedCode(result.reason) } : {}),
    };
  }
}

export async function runRepeatedFailureSuite(
  options: RunRepeatedFailureSuiteOptions,
): Promise<RunRepeatedFailureSuiteResult> {
  const bundle = await loadFixtureBundle(options.fixtureDir);
  const configuration = normalizeRunOptions(options, bundle);
  await assertSafeBenchmarkOutput(configuration.outputDir, options.resume === true);
  if (options.resume === true) await verifyResumeSourceIntegrity(configuration.outputDir);
  const provenance = captureBenchmarkExecutionProvenance();
  const harnessVersion = await getRemnicVersion();
  const harnessSourceHash = await computeAnalysisHarnessHash();
  if (configuration.phase === "pilot" || configuration.phase === "main") {
    for (const driver of configuration.drivers) {
      await verifyMatchingTrapAudit(
        { id: driver.modelProfileId, hash: driver.modelProfileHash },
        bundle.dataset.inventoryHash,
        harnessSourceHash,
        [
          configuration.outputDir,
          options.pilotRunDir ?? "",
          options.fixtureDir ?? "",
          path.join(path.dirname(configuration.outputDir), "h6-trap-audit"),
          path.resolve("h6-trap-audit"),
          path.resolve("."),
        ],
      );
    }
  }
  const pilotPower = configuration.phase === "main"
    ? await verifyPilotPower(
        options.pilotRunDir,
        bundle,
        configuration,
        harnessVersion,
        harnessSourceHash,
      )
    : undefined;
  const templates = new Map<string, HistoryTemplate>();
  const plans = await buildPlans(
    bundle,
    configuration.taskIds,
    configuration.variantIds,
    configuration.drivers,
    configuration.seeds,
  );
  const design = buildDesign(plans);
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
  const resumeContractHash = sha256(stableStringify({
    suiteVersion: bundle.suiteVersion,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    expectedDesignHash,
    decisionRuleHash,
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    harnessVersion,
    harnessSourceHash,
    provenanceHash,
    mode: options.mode,
    arms: PRIMARY_ARMS,
    modelProfiles: configuration.drivers.map((driver) => ({
      id: driver.modelProfileId,
      hash: driver.modelProfileHash,
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
      if (existing.kind === "VALID" && existing.checkpoint.terminal) {
        if (await terminalEvidenceIsDurable(configuration.outputDir, existing.checkpoint.terminal)) {
          resumed += 1;
          continue;
        }
        throw new Error(`terminal trace artifact is missing or drifted: ${existing.checkpoint.rowKey}`);
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
      timidityPassMargin: decisionRule.timidity.passRateMargin,
      timidityStepsMargin: decisionRule.timidity.stepsMargin,
    });
    await writeRepeatedFailureStatistics(runDir, analysis);
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
    if (input.profilePaths.length !== 2) {
      throw new Error("registered pilot and main phases require exactly two immutable model profiles");
    }
    const bundle = await loadFixtureBundle(input.fixtureDir);
    const caps: ControlledResponsesCaps = {
      ...DEFAULT_CAPS,
      ...(input.maxSteps !== undefined ? { maxTurns: input.maxSteps } : {}),
      ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
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
    const drivers = profiles.map(({ profile, hash }) =>
      createRepeatedFailureProfileDriver(profile, hash, apiKey)
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

async function executePlannedRow(
  plan: PlannedRow,
  driver: RepeatedFailureEpisodeDriver,
  history: FrozenHistory,
  store: RepeatedFailureRowStore,
  configuration: RowExecutionOptions,
): Promise<void> {
  const rowKey = buildRepeatedFailureRowKey(plan.identity);
  const isolation = buildIsolation(rowKey);
  const loaded = await store.load(plan.identity);
  if (loaded.kind === "MALFORMED") throw loaded.error;
  if (loaded.kind === "VALID" && loaded.checkpoint.terminal) {
    throw new Error(`Repeated-failure row ${rowKey} is already terminal`);
  }
  const firstAttemptIndex = loaded.kind === "VALID" ? loaded.checkpoint.tries.length : 0;
  for (
    let attemptIndex = firstAttemptIndex;
    attemptIndex <= configuration.maxHostRetries;
    attemptIndex += 1
  ) {
    const attempt = (attemptIndex + 1) as 1 | 2 | 3;
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
        await store.commitTry(plan.identity, {
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
        const terminalRepoEvidence = retriesExhausted
          ? await host.captureFinalEvidence()
          : undefined;
        const trace = await writeTrace(configuration.outputDir, rowKey, attempt, {
          schemaVersion: 1,
          identity: plan.identity,
          hostFault: fault,
          usage: result.usage,
          ...(terminalRepoEvidence ? { finalRepoEvidence: terminalRepoEvidence } : {}),
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
        await store.commitTry(plan.identity, {
          attempt,
          durationMs,
          tokens: result.usage,
          outcome: {
            kind: "HOST_API_FAULT",
            code: fault.code,
            messageHash: fault.messageHash,
            ...(retriesExhausted ? { exhausted: true } : {}),
            ...(terminalEvidence ? { evidence: terminalEvidence, isolation } : {}),
          },
        });
        if (!retriesExhausted) continue;
        return;
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
      await store.commitTry(plan.identity, {
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

function classifyEpisode(input: {
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
  const gateWaitExpired = input.result.gateEvents.some(
    (event) => event.faultCode === "GATE_WAIT_EXPIRED",
  ) || gate.faultCode === "GATE_WAIT_EXPIRED";
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
  if (gateWaitExpired || input.result.invalidReason === "ABORTED") {
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
  maxHostRetries?: 0 | 1 | 2;
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
      maxHostRetries: input.maxHostRetries ?? 2,
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

function baseEvidence(input: {
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

async function buildPlans(
  bundle: FixtureBundle,
  taskIds: readonly string[],
  variantIds: readonly string[],
  drivers: readonly RepeatedFailureEpisodeDriver[],
  seeds: readonly number[],
): Promise<PlannedRow[]> {
  const tasks = bundle.dataset.tasks
    .filter((task) => taskIds.length === 0 || taskIds.includes(task.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (tasks.length === 0) throw new Error("task selection is empty");
  const selectedVariants: Array<{ task: BaseTask; variant: TaskVariant }> = [];
  for (const task of tasks) {
    await validateTaskManifest(bundle.fixtureDir, task);
    for (const variant of [...task.variants].sort(
      (left, right) => left.variantId.localeCompare(right.variantId),
    )) {
      if (variantIds.length === 0 || variantIds.includes(variant.variantId)) {
        selectedVariants.push({ task, variant });
      }
    }
  }
  if (selectedVariants.length === 0) throw new Error("variant selection is empty");
  const plans: PlannedRow[] = [];
  for (const { task, variant } of selectedVariants) {
    for (const seed of seeds) {
      for (const driver of drivers) {
        for (const arm of PRIMARY_ARMS) {
          plans.push({
            identity: identityFor(bundle.suiteVersion, task.id, variant.variantId, driver, seed, arm),
            task,
            variant,
            files: variant.files,
            noTrapControl: false,
          });
        }
        for (const arm of TIMIDITY_ARMS) {
          plans.push({
            identity: identityFor(
              bundle.suiteVersion,
              task.id,
              `${variant.variantId}:no-trap`,
              driver,
              seed,
              arm,
            ),
            task,
            variant,
            files: variant.noTrapControlFiles,
            noTrapControl: true,
          });
        }
      }
    }
  }
  const keys = plans.map((plan) => buildRepeatedFailureRowKey(plan.identity));
  if (new Set(keys).size !== keys.length) throw new Error("row planning produced a key collision");
  return plans;
}

function buildDesign(plans: readonly PlannedRow[]): DesignArtifact {
  return {
    schemaVersion: 1,
    runOrder: plans.map((plan) => ({
      rowKey: buildRepeatedFailureRowKey(plan.identity),
      analysis: plan.noTrapControl ? "TIMIDITY" : "PRIMARY",
      identity: plan.identity,
    })),
    primary: { rows: plans.filter((plan) => !plan.noTrapControl).map((plan) => plan.identity) },
    timidity: { rows: plans.filter((plan) => plan.noTrapControl).map((plan) => plan.identity) },
  };
}

async function buildHistoryTemplate(task: BaseTask, variant: TaskVariant): Promise<HistoryTemplate> {
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

function freezeHistory(template: HistoryTemplate, identity: RepeatedFailureRowIdentity): FrozenHistory {
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

async function materializeArmMemory(
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
function renderFailureFact(): string {
  return `[PreActionFailureGate ${PRE_ACTION_WARNING_VERSION}] A similar action failed before. Prior act: "${HISTORY_ACTION_SUMMARY}". Failure: "${HISTORY_FAILURE_SUMMARY}". Next safe check: "${HISTORY_FOLLOW_UP}".`;
}

function renderSuccessFact(): string {
  return `[PreActionFailureGate ${PRE_ACTION_WARNING_VERSION}] A similar action worked before. Prior act: "${HISTORY_ACTION_SUMMARY}". Success: "${HISTORY_SUCCESS_SUMMARY}". Next safe check: "${HISTORY_FOLLOW_UP}".`;
}

function buildPrompt(
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

function turnStartFact(arm: RepeatedFailureArm, history: FrozenHistory): string | undefined {
  if (arm === "TURN_START_FAILURE" || arm === "BOTH") return history.failureFact;
  if (arm === "TURN_START_SUCCESS") return history.successFact;
  return undefined;
}

type TimingPayload = {
  frame: "TURN_START" | "PRE_ACTION";
  factId: string;
  citationHash: string;
  factCount: 1;
  renderedTokenCount: number;
};

function buildTimingPayload(
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

function auditFactPair(
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
function actionIdentityFor(task: BaseTask, rootPath: string, candidateId?: string): ActionIdentity {
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

function strategyDiffShape(task: BaseTask, candidateId?: string): string {
  const candidate = candidateId ?? "bad";
  return `h6-v1:${task.normalizedActionIntent.actionType}:${candidate}:${task.normalizedActionIntent.contextHash.slice(0, 16)}`;
}

function pathShapeHash(task: BaseTask): string {
  const shape = task.normalizedActionIntent.filePath
    .normalize("NFKC")
    .split("/")
    .map((segment) => segment.replace(/[\p{L}\p{N}]+/gu, "{name}"))
    .join("/");
  return sha256(shape);
}

function actionShapeHash(task: BaseTask): string {
  return sha256(stableStringify({
    kind: "edit",
    editKind: "update",
    actionType: task.normalizedActionIntent.actionType,
    targetSymbol: task.normalizedActionIntent.targetSymbol,
    filePathShapeHash: pathShapeHash(task),
  }));
}

function armSemanticsAreValid(
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
  if (
    decisionRule.analysisPopulation.datasetInventoryHash !== undefined
    && decisionRule.analysisPopulation.datasetInventoryHash !== inventoryHash
  ) throw new Error("decision rule targets a different dataset inventory");
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


async function validateTaskManifest(fixtureDir: string, task: BaseTask): Promise<void> {
  const manifest = BaseTaskSchema.parse(
    await readJson(path.join(fixtureDir, "tasks", task.id, "task.json")),
  );
  if (stableStringify(manifest) !== stableStringify(task)) {
    throw new Error(`task manifest drifted from dataset: ${task.id}`);
  }
}

function normalizeRunOptions(
  options: RunRepeatedFailureSuiteOptions,
  bundle: FixtureBundle,
): NormalizedRunOptions {
  const drivers = [...options.drivers].sort(
    (left, right) => left.modelProfileId.localeCompare(right.modelProfileId)
      || left.modelProfileHash.localeCompare(right.modelProfileHash),
  );
  if (drivers.length === 0) throw new Error("at least one repeated-failure driver is required");
  for (const driver of drivers) {
    if (!driver.modelProfileId || !SHA256_PATTERN.test(driver.modelProfileHash)) {
      throw new Error("every driver requires modelProfileId and a lowercase SHA-256 modelProfileHash");
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
  const maxHostRetries = options.maxHostRetries ?? 2;
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
    ? [...new Set(options.taskIds ?? [])].sort()
    : [...new Set(options.taskIds ?? bundle.dataset.splits[phase])].sort();
  const registeredVariantIds = phase === "unspecified"
    ? [...new Set(options.variantIds ?? [])].sort()
    : [...new Set(options.variantIds ?? bundle.dataset.tasks
      .filter((task) => bundle.dataset.splits[phase].includes(task.id))
      .flatMap((task) => task.variants.map((variant) => variant.variantId)))].sort();
  if (phase !== "unspecified") {
    if (bundle.dataset.inventoryHash !== FROZEN_DATASET_INVENTORY_HASH) {
      throw new Error("registered H6 execution requires the frozen dataset inventory");
    }
    if (options.mode !== "full") throw new Error("registered H6 execution requires full mode");
    if (drivers.length !== 2) throw new Error("registered H6 execution requires exactly two immutable model profiles");
    if (stableStringify(seeds) !== stableStringify(FROZEN_SEEDS)) {
      throw new Error("registered H6 execution requires the exact frozen seeds [1,2,3,4,5]");
    }
    if (stableStringify(registeredTaskIds) !== stableStringify([...bundle.dataset.splits[phase]].sort())) {
      throw new Error(`registered H6 ${phase} execution requires exact frozen split membership`);
    }
    const expectedVariantIds = bundle.dataset.tasks
      .filter((task) => bundle.dataset.splits[phase].includes(task.id))
      .flatMap((task) => task.variants.map((variant) => variant.variantId))
      .sort();
    if (stableStringify(registeredVariantIds) !== stableStringify(expectedVariantIds)) {
      throw new Error(`registered H6 ${phase} execution requires every frozen task variant`);
    }
    if (stableStringify(caps) !== stableStringify(DEFAULT_CAPS) || maxToolOutputChars !== DEFAULT_TOOL_OUTPUT_CHARS) {
      throw new Error("registered H6 execution requires the frozen response caps");
    }
    if (maxHostRetries !== 2) throw new Error("registered H6 execution requires the frozen retry rule");
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

async function writeFrozenRunArtifact(
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

async function writeFinalRunArtifact(
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

async function ensureDeviationsArtifact(filePath: string, resume: boolean): Promise<void> {
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

async function assertSafeBenchmarkOutput(outputDir: string, resume: boolean): Promise<void> {
  const refusal = "refusing benchmark output inside a Remnic memory store";
  let canonicalOutput: string;
  try {
    canonicalOutput = await canonicalProspectivePath(outputDir);
    for (const variable of ["REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR"] as const) {
      const configured = process.env[variable]?.trim();
      if (!configured) continue;
      const memoryRoot = await canonicalProspectivePath(path.resolve(configured));
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
  } catch {
    throw new Error("resume requires existing H6 run metadata");
  }
}

async function canonicalProspectivePath(value: string): Promise<string> {
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

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function anyPathExists(values: readonly string[]): Promise<boolean> {
  for (const value of values) {
    if (await pathExists(value)) return true;
  }
  return false;
}

async function assertResumeContract(
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

function parseRunMetadata(value: unknown): RepeatedFailureRunMetadata {
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
    datasetInventoryHash: z.string().regex(SHA256_PATTERN),
    resumeContractHash: z.string().regex(SHA256_PATTERN),
    expectedDesignHash: z.string().regex(SHA256_PATTERN),
    decisionRuleHash: z.string().regex(SHA256_PATTERN),
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
      hostApiFaultRetriesAfterFirstTry: z.union([z.literal(0), z.literal(1), z.literal(2)]),
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
  }).strict().parse(value);
}

function parseDesign(value: unknown): DesignArtifact {
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

function parseEpisodesJsonl(raw: string): RepeatedFailureEpisodeRow[] {
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

async function terminalEvidenceIsDurable(
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

function assertCompleteRows(
  rows: readonly RepeatedFailureEpisodeRow[],
  plans: readonly PlannedRow[],
): void {
  const expectedKeys = plans.map((plan) => buildRepeatedFailureRowKey(plan.identity)).sort();
  const actualKeys = rows.map((row) => row.rowKey).sort();
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

function assertDesignRowsPresent(
  rows: readonly RepeatedFailureEpisodeRow[],
  identities: readonly RepeatedFailureRowIdentity[],
): void {
  const expected = identities.map(buildRepeatedFailureRowKey).sort();
  const actual = rows.map((row) => row.rowKey).sort();
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error("episodes do not match the expected design");
  }
}

function collectTaskRevisions(
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
    (left, right) => left.taskId.localeCompare(right.taskId)
      || left.variantId.localeCompare(right.variantId),
  );
}

function buildToolLocks(
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
      (left, right) => left.taskId.localeCompare(right.taskId)
        || left.variantId.localeCompare(right.variantId),
    ),
  };
}

export async function computeAnalysisHarnessHash(): Promise<string> {
  const suitePath = fileURLToPath(import.meta.url);
  const sourceDir = path.dirname(suitePath);
  const extension = path.extname(suitePath);
  const coreSourceDir = path.resolve(sourceDir, "../../../remnic-core/src");
  const coreSourcePath = path.join(coreSourceDir, `coding/pre-action-gate${extension}`);
  const sourcePaths = await pathExists(coreSourcePath)
    ? {
        coreAtomicFile: path.join(coreSourceDir, `maintenance/atomic-file${extension}`),
        coreCausalTrajectory: path.join(coreSourceDir, `causal-trajectory${extension}`),
        corePreActionGate: coreSourcePath,
        driverUtils: path.join(sourceDir, `repeated-failure-driver-utils${extension}`),
        ollamaDriver: path.join(sourceDir, `repeated-failure-ollama-chat-driver${extension}`),
        reporter: path.resolve(sourceDir, `../reporter${extension}`),
        reproManifest: path.resolve(sourceDir, `../repro-manifest${extension}`),
        repoContracts: path.join(sourceDir, `repo-gen/contracts${extension}`),
        repoGenerator: path.join(sourceDir, `repo-gen/generator${extension}`),
        repoGeneratorIndex: path.join(sourceDir, `repo-gen/index${extension}`),
        repoGeneratorTypes: path.join(sourceDir, `repo-gen/types${extension}`),
        repoMaterializer: path.join(sourceDir, `repo-gen/materializer${extension}`),
        repoTrapTaxonomy: path.join(sourceDir, `repo-gen/trap-taxonomy${extension}`),
        repoValidator: path.join(sourceDir, `repo-gen/validator${extension}`),
        responsesDriver: path.join(sourceDir, `repeated-failure-responses-driver${extension}`),
        scorer: path.resolve(sourceDir, `../scorer${extension}`),
        seededRandom: path.resolve(sourceDir, `../seeded-random${extension}`),
        statistics: path.join(sourceDir, `repeated-failure-stats${extension}`),
        store: path.join(sourceDir, `repeated-failure-store${extension}`),
        suite: suitePath,
        trapAudit: path.join(sourceDir, `repeated-failure-trap-audit${extension}`),
        types: path.join(sourceDir, `repeated-failure-types${extension}`),
      }
    : {
        benchBundle: suitePath,
        corePreActionGate: fileURLToPath(
          import.meta.resolve("@remnic/core/coding/pre-action-gate"),
        ),
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

async function verifyResumeSourceIntegrity(outputDir: string): Promise<void> {
  const manifestPath = path.join(outputDir, BENCHMARK_REPRO_MANIFEST_FILENAME);
  if (!await pathExists(manifestPath)) return;
  await verifyRunManifest(outputDir);
  throw new Error("resume run is finalized and immutable");
}

async function verifyRunManifest(runDir: string): Promise<BenchmarkReproManifest> {
  const manifest = parseBenchmarkReproManifest(JSON.parse(
    await readFile(path.join(runDir, BENCHMARK_REPRO_MANIFEST_FILENAME), "utf8"),
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
    const bytes = await readFile(containedPath(runDir, artifact.path));
    if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`manifest supplemental artifact hash mismatch: ${artifact.path}`);
    }
  }
  for (const result of manifest.results) {
    const bytes = await readFile(containedPath(runDir, result.path));
    if (bytes.length !== result.sizeBytes || sha256(bytes) !== result.sha256) {
      throw new Error(`manifest result artifact hash mismatch: ${result.path}`);
    }
  }
  return manifest;
}

async function verifyPilotPower(
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
    (driver) => `${driver.modelProfileId}\u0000${driver.modelProfileHash}`,
  ).sort();
  const pilotProfiles = metadata.modelProfileIds.map(
    (id, index) => `${id}\u0000${metadata.modelProfileHashes[index] ?? ""}`,
  ).sort();
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
    || stableStringify(metadata.splitTaskIds) !== stableStringify([...bundle.dataset.splits.pilot].sort())
    || stableStringify(pilotProfiles) !== stableStringify(expectedProfiles)
    || stableStringify(metadata.caps) !== stableStringify({
      ...DEFAULT_CAPS,
      maxToolOutputChars: DEFAULT_TOOL_OUTPUT_CHARS,
    })
    || metadata.retryRule.hostApiFaultRetriesAfterFirstTry !== 2
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
  const episodeBytes = await readFile(path.join(runDir, "episodes.jsonl"), "utf8");
  const rows = parseEpisodesJsonl(episodeBytes);
  assertDesignRowsPresent(rows, [...design.primary.rows, ...design.timidity.rows]);
  const powerBytes = await readFile(path.join(runDir, "power.json"), "utf8");
  const power = parseComputedPilotPower(JSON.parse(powerBytes));
  if (
    power.draws !== REPEATED_FAILURE_STATISTICS_DRAWS
    || power.analysisDraws !== REPEATED_FAILURE_STATISTICS_DRAWS
    || power.analysisVersion !== REPEATED_FAILURE_ANALYSIS_VERSION
    || power.sourceEpisodesHash !== sha256(episodeBytes)
    || power.sourceDesignHash !== sha256(designBytes)
    || power.decisionRuleHash !== metadata.decisionRuleHash
    || power.timingPower < 0.8
    || power.contentPower < 0.8
    || power.timidityPower < 0.8
  ) {
    throw new Error("pilot power is absent, underpowered, or does not match immutable pilot rows");
  }
  return {
    runId: metadata.runId,
    manifestArtifactHash: manifest.artifactHash,
    powerArtifactHash: sha256(powerBytes),
    artifact: power.raw,
  };
}

function parseComputedPilotPower(value: unknown): {
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

async function buildFactPairAudit(
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

function buildPowerArtifact(
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
  const groups = [...taskGroups.entries()].sort(([left], [right]) => left.localeCompare(right));
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
    }).sort(([left], [right]) => left.localeCompare(right));
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
        alpha: decisionRule.analysis.alpha,
        timingMinimumRrr: decisionRule.hypotheses["H6-timing"].minimumRelativeRiskReduction,
        timidityPassMargin: decisionRule.timidity.passRateMargin,
        timidityStepsMargin: decisionRule.timidity.stepsMargin,
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

function materializePowerExperiment(
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


function buildVerifiedPilotPowerArtifact(pilot: VerifiedPilotPower): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "VERIFIED_PILOT",
    phase: "main",
    requiredPower: 0.8,
    pilotRunId: pilot.runId,
    pilotManifestArtifactHash: pilot.manifestArtifactHash,
    pilotPowerArtifactHash: pilot.powerArtifactHash,
    pilot: pilot.artifact,
  };
}

function countFactTokens(
  value: string,
  tokenizer: RepeatedFailureEpisodeDriver["tokenizer"],
): number {
  if (tokenizer.implementation !== "nfkc-whitespace-v1") {
    throw new Error(`unsupported registered tokenizer implementation: ${String(tokenizer.implementation)}`);
  }
  return tokenizeContent(value).size;
}

async function buildRunAudit(input: {
  bundle: FixtureBundle;
  rows: readonly RepeatedFailureEpisodeRow[];
  design: DesignArtifact;
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
  const timingEvidence = input.factPairs.pairs.map((pair) => {
    const rows = timingRows.filter((candidate) => candidate.row.evidence?.historyHash === pair.historyHash);
    const turnStart = rows.find((candidate) => candidate.row.identity.arm === "TURN_START_FAILURE");
    const preAction = rows.find((candidate) => candidate.row.identity.arm === "PRE_ACTION_FAILURE");
    const baseline = turnStart?.timingPayload;
    const candidate = preAction?.timingPayload;
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
    return {
      pairKey: pair.pairKey,
      turnStartRowKey: turnStart?.row.rowKey ?? null,
      preActionRowKey: preAction?.row.rowKey ?? null,
      baseline,
      candidate,
      expectedFactId: pair.failureFactId,
      expectedCitationHash: pair.failureCitationHash,
      expectedFactCount: 1,
      matches: rows.length === 2
        && baseline?.frame === "TURN_START"
        && candidate?.frame === "PRE_ACTION"
        && turnStart?.turnStartFactHash === pair.failureFactHash
        && preAction?.preActionFailureFactHash === pair.failureFactHash
        && registeredFieldsMatch,
    };
  });
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
  return {
    schemaVersion: 1,
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
    timingEvidence: {
      rows: timingEvidence,
      allMatched: timingEvidence.length > 0 && timingEvidence.every((row) => row.matches),
    },
    fakeAgentContract: {
      status: fakeRun ? (fakeContractPassed ? "PASS" : "FAIL") : "NOT_APPLICABLE",
      deterministicDriverCount: input.drivers.filter(
        (driver) => driver.driverKind === "deterministic-fake",
      ).length,
    },
    modelProfiles: input.drivers.map((driver) => ({
      id: driver.modelProfileId,
      hash: driver.modelProfileHash,
      driverKind: driver.driverKind ?? "unknown",
    })),
    traces: {
      expectedCount: input.rows.length,
      durableCount: traceDurability.filter(Boolean).length,
      allDurable: traceDurability.length === input.rows.length && traceDurability.every(Boolean),
    },
    cuts: { primary: primaryCuts, timidity: timidityCuts },
  };
}

function projectConfidenceIntervals(
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

async function projectBenchmarkResult(
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
          (id, index) => ({ id, hash: metadata.modelProfileHashes[index] }),
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

async function writeTrace(
  outputDir: string,
  rowKey: string,
  attempt: 1 | 2 | 3,
  value: unknown,
): Promise<{ path: string; hash: string }> {
  const relative = `traces/${rowKey}/attempt-${attempt}.json`;
  const filePath = containedPath(outputDir, relative);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, serialized);
  return { path: relative, hash: sha256(serialized) };
}

async function listSupplementalArtifacts(
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

interface ModelProfileExecutionContract {
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

function canonicalizeModelProfile(input: unknown): RepeatedFailureModelProfile {
  const profile = ModelProfileSchema.parse(input);
  if (profile.provider === "ollama-chat") {
    return { ...profile, endpoint: validateOllamaChatEndpoint(profile.endpoint) };
  }
  return {
    ...profile,
    ...(profile.endpoint ? { endpoint: validateEndpoint(profile.endpoint) } : {}),
  };
}

export function createRepeatedFailureProfileDriver(
  profile: RepeatedFailureModelProfile,
  hash: string,
  apiKey?: string,
): RepeatedFailureEpisodeDriver {
  if (profile.provider === "ollama-chat") {
    return createRepeatedFailureOllamaChatDriver({
      model: profile.model,
      modelProfileId: profile.id,
      modelProfileHash: hash,
      developerInstructions: [
        `System instruction:\n${profile.instructions.system}`,
        `Developer instruction:\n${profile.instructions.developer}`,
      ].join("\n\n"),
      endpoint: validateOllamaChatEndpoint(profile.endpoint),
      seedCapability: profile.seedCapability,
      tokenizer: Object.freeze({ ...profile.tokenizer }),
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      ...(profile.think === undefined ? {} : { think: profile.think }),
    });
  }
  return createControlledResponsesAgentDriver({
    model: profile.model,
    modelProfileId: profile.id,
    modelProfileHash: hash,
    developerInstructions: profile.instructions.developer,
    tokenizer: Object.freeze({ ...profile.tokenizer }),
    apiKey,
    instructions: profile.instructions.system,
    ...(profile.endpoint ? { baseUrl: validateEndpoint(profile.endpoint) } : {}),
    ...(profile.seedCapability ? { seedCapability: profile.seedCapability } : {}),
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  } satisfies ControlledResponsesAgentDriverConfig);
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

function validateEndpoint(value: string): string {
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
  return endpoint.toString().replace(/\/+$/, "");
}

async function runOfflineCheck(repoDir: string, task: BaseTask): Promise<CheckExecution> {
  if (task.checkCommand !== "node test/check.js") {
    throw new Error("task check command is not the frozen offline check");
  }
  const result = await executeFile(process.execPath, ["test/check.js"], repoDir);
  const state: CheckExecution["state"] = result.exitCode === 0
    ? "FIXED"
    : result.exitCode === 2
      ? "TRAPPED"
      : result.exitCode === 1
        ? "UNFIXED"
        : "INDETERMINATE";
  return { state, exitCode: result.exitCode, outputHash: sha256(result.output) };
}

function executeFile(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      const errorCode = (error as unknown as { code?: unknown } | null)?.code;
      const exitCode = typeof errorCode === "number" ? errorCode : error ? 255 : 0;
      resolve({ exitCode, output: `${stdout}${stderr}`.slice(0, 65_536) });
    });
  });
}

async function listRegularFiles(root: string, excludeGit: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (excludeGit && entry.name === ".git") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("artifact trees cannot contain symbolic links");
    if (entry.isDirectory()) files.push(...await listRegularFiles(fullPath, excludeGit));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

async function hashDirectory(root: string, excludeGit: boolean): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of await listRegularFiles(root, excludeGit)) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    hash.update(relative).update("\0").update(await readFile(filePath)).update("\0");
  }
  return hash.digest("hex");
}


async function containedRegularDirectory(root: string, relative: string): Promise<string> {
  const target = containedPath(root, relative || ".");
  await assertNoSymlinkComponents(root, target);
  if (!(await lstat(target)).isDirectory()) throw new Error("requested path is not a directory");
  return target;
}

async function containedRegularFile(root: string, relative: string): Promise<string> {
  const target = containedPath(root, relative);
  await assertNoSymlinkComponents(root, target);
  if (!(await lstat(target)).isFile()) throw new Error("requested path is not a regular file");
  return target;
}

function containedPath(root: string, relative: string): string {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\")) {
    throw new Error("path must be repository-relative");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("path escapes its root");
  }
  return resolved;
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symbolic link path is not allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function identityFor(
  suiteVersion: string,
  taskId: string,
  variantId: string,
  driver: RepeatedFailureEpisodeDriver,
  seed: number,
  arm: RepeatedFailureArm,
): RepeatedFailureRowIdentity {
  return {
    suiteVersion,
    taskId,
    variantId,
    modelProfileId: driver.modelProfileId,
    modelProfileHash: driver.modelProfileHash,
    seed,
    arm,
  };
}

function buildIsolation(rowKey: string): RepeatedFailureIsolationIdentity {
  const id = (kind: string) => `h6-id-v1-${sha256(`${rowKey}:${kind}`)}`;
  return {
    repoId: id("repo"),
    memoryId: id("memory"),
    codingScopeId: id("coding-scope"),
    codeGraphId: id("code-graph"),
    chatId: id("chat"),
    sessionId: id("session"),
    cacheId: id("cache"),
  };
}

function noMatchGate(action: RepeatedFailureProposedAction): RepeatedFailureGateEvent {
  return {
    status: "NO_MATCH",
    fingerprintHash: sha256(stableStringify({ tool: action.tool, arguments: action.arguments })),
  };
}

function hostFaultResult(error: unknown): ControlledResponsesEpisodeResult {
  const messageHash = sha256(error instanceof Error ? `${error.name}:${error.message}` : String(error));
  return {
    status: "INVALID",
    invalidReason: "FAULT",
    disposition: "NONE",
    outputTextHash: sha256(""),
    outputTextBytes: 0,
    gateEvents: [],
    responses: [],
    tools: [],
    usage: zeroTokens(),
    faults: [{ code: "HOST_API_EXCEPTION", stage: "transport", messageHash }],
  };
}


function zeroTokens(): RepeatedFailureTokenUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  };
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function strictObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

function failedTool(error: unknown): RepeatedFailureToolExecutionResult {
  return {
    status: "failed",
    output: { code: boundedCode(error instanceof Error ? error.message : String(error)) },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function boundedCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, "_").slice(0, 128);
  return normalized || "UNKNOWN";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /(?:\/home\/[^\s/]+|\/Users\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/gu,
    "$HOME",
  );
}
