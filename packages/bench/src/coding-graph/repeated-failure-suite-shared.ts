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
  H6_DECISION_RULE,
  H6_FROZEN_INVENTORY_HASH,
  H6_FROZEN_SPLITS,
  BaseTaskSchema,
  TrapTaxonomyItemSchema,
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

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const FROZEN_DATASET_INVENTORY_HASH = H6_FROZEN_INVENTORY_HASH;
export const FROZEN_SEEDS = Object.freeze([1, 2, 3, 4, 5]);
export const REPEATED_FAILURE_ANALYSIS_VERSION = "h6-task-bootstrap-shuffle-holm-v1";
export const FIXED_RECORDED_AT = "2026-01-01T00:00:00.000Z";
export const DEFAULT_CAPS: ControlledResponsesCaps = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 8,
  maxTotalTokens: 20_480,
  maxDurationMs: 600_000,
  requestTimeoutMs: 180_000,
});
export const HISTORY_ACTION_SUMMARY = "Changed target code after inspecting api cache call class config contract data edge error event field file flow graph guard input job key link map node path queue rule scope state.";
export const HISTORY_FAILURE_SUMMARY = "Offline check classified result TRAPPED while preserving branch build case command commit diff edit export hash import index intent module patch range repo schema script symbol.";
export const HISTORY_SUCCESS_SUMMARY = "Offline check classified result FIXED while preserving branch build case command commit diff edit export hash import index intent module patch range repo schema script symbol.";
export const HISTORY_FOLLOW_UP = "Inspect root cause and choose another strategy after checking artifact audit boundary context evidence invariant memory output policy record revision safety session source status.";
export const PRIMARY_ARMS = REPEATED_FAILURE_ARMS;
export const TIMIDITY_ARMS = Object.freeze(["NO_MEMORY", "PRE_ACTION_FAILURE"] as const);
export const DEFAULT_TOOL_OUTPUT_CHARS = 16_384;
export const MAX_INSPECT_FILES = 200;
export const NEUTRAL_INSTRUCTION = "Inspect the codebase, identify the defect, and apply the appropriate code changes using the tools.";
export const PROMPT_CONTRACT = Object.freeze({
  version: "h6-repeated-failure-prompt-v1",
  repositoryFrame: "You are working in a generated offline repository. Use only the supplied tools.",
  noTrapInstruction: NEUTRAL_INSTRUCTION,
  trapInstruction: NEUTRAL_INSTRUCTION,
  recalledFactLabel: "Recalled episode-1 fact:",
});

export const ArmManifestSchema = z.array(z.object({
  id: z.enum(REPEATED_FAILURE_ARMS),
  name: z.string().min(1),
  description: z.string().min(1),
}).strict()).length(REPEATED_FAILURE_ARMS.length);

export const PreregistrationBindingSchema = z.object({
  path: z.literal(H6_DECISION_RULE.preregistration.path),
  sha256: z.literal(H6_DECISION_RULE.preregistration.sha256),
}).strict();

export const DecisionRuleSchema = z.object({
  version: z.literal(H6_DECISION_RULE.version),
  preregistration: PreregistrationBindingSchema,
  analysisPopulation: z.object({
    datasetVersion: z.literal(1),
    datasetInventoryHash: z.literal(H6_FROZEN_INVENTORY_HASH),
    split: z.enum(["main", "pilot"]),
    pairingKey: z.array(z.string()).min(1),
    modelProfileCount: z.union([z.literal(1), z.literal(2)]),
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
      minimumAbsoluteRepeatedFailureBenefit: z.number().nonnegative().max(1),
      requireRepeatedFailureBenefitIntervalLowerStrictlyAbove: z.number().min(0).max(1),
      requireHolmAdjustedPStrictlyBelow: z.number().positive().max(1),
    }).passthrough(),
    "H6-content": z.object({
      baselineArm: z.literal("TURN_START_SUCCESS"),
      candidateArm: z.literal("TURN_START_FAILURE"),
      requireRepeatedFailureBenefitIntervalLowerStrictlyAbove: z.number().min(0).max(1),
      requireTaskPassBenefitIntervalLowerStrictlyAbove: z.number().min(0).max(1),
      requireHolmAdjustedCompoundPStrictlyBelow: z.number().positive().max(1),
    }).passthrough(),
  }).passthrough(),
  trapAudit: z.object({
    minimumTrappedRate: z.number().min(0).max(1),
    minimumNonFixedRate: z.number().min(0).max(1),
    maximumInvalidRows: z.literal(0),
    requireCompleteRows: z.literal(true),
  }).strict(),
  timidity: z.object({
    baselineArm: z.literal("NO_MEMORY"),
    candidateArm: z.literal("PRE_ACTION_FAILURE"),
    population: z.literal("main_no_trap_revisions"),
    passRateMargin: z.number().nonnegative(),
    stepsMargin: z.number().nonnegative(),
  }).passthrough(),
  completeness: z.object({
    primaryArmCount: z.literal(5),
    hostFaultRetriesAfterFirstTry: z.literal(5),
    rerunTaskResults: z.literal(false),
  }).passthrough(),
}).passthrough();

export const ProfileInstructionsSchema = z.object({
  system: z.string().min(1).max(16_384),
  developer: z.string().min(1).max(16_384),
}).strict();
export const ProfileTokenizerSchema = z.object({
  identity: z.string().min(1).max(256),
  implementation: z.literal("nfkc-whitespace-v1"),
}).strict();
export const OpenAiModelProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(256),
  provider: z.literal("openai-responses"),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1).max(256),
  endpoint: z.string().min(1).max(2048).optional(),
  instructions: ProfileInstructionsSchema,
  tokenizer: ProfileTokenizerSchema,
  contextWindowTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  temperature: z.literal(0),
  maxOutputTokens: z.number().int().positive(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  seedCapability: z.object({
    kind: z.literal("request_parameter"),
    requestField: z.literal("seed"),
  }).strict().optional(),
}).strict();
export const OllamaChatModelProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(256),
  provider: z.literal("ollama-chat"),
  model: z.string().min(1).max(256),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  endpoint: z.string().min(1).max(2048).optional(),
  instructions: ProfileInstructionsSchema,
  tokenizer: ProfileTokenizerSchema,
  contextWindowTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  temperature: z.literal(0),
  maxOutputTokens: z.number().int().positive(),
  think: z.boolean().optional(),
  seedCapability: z.object({
    kind: z.literal("options_parameter"),
    requestField: z.literal("seed"),
  }).strict(),
}).strict();
export const ModelProfileSchema = z.discriminatedUnion("provider", [
  OpenAiModelProfileSchema,
  OllamaChatModelProfileSchema,
]);

export type RepeatedFailureModelProfile = z.infer<typeof ModelProfileSchema>;
export type FixtureBundle = {
  fixtureDir: string;
  dataset: H6BenchmarkDataset;
  decisionRule: z.infer<typeof DecisionRuleSchema>;
  decisionRuleBytes: string;
  suiteVersion: string;
};
export type HistoryTemplate = {
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
export type FrozenHistory = HistoryTemplate & {
  historyHash: string;
  failureFactId: string;
  failureCitationHash: string;
};
export type PlannedRow = {
  identity: RepeatedFailureRowIdentity;
  task: BaseTask;
  variant: TaskVariant;
  files: readonly SyntheticFile[];
  noTrapControl: boolean;
};
export type DesignArtifact = {
  schemaVersion: 1;
  runOrder: readonly {
    rowKey: string;
    analysis: "PRIMARY" | "TIMIDITY";
    identity: RepeatedFailureRowIdentity;
  }[];
  primary: RepeatedFailureExpectedDesign;
  timidity: RepeatedFailureExpectedDesign;
};
export type CheckExecution = {
  state: RepeatedFailureFinalRepoEvidence["checkResult"];
  exitCode: number;
  outputHash: string;
};
export type NormalizedRunOptions = {
  outputDir: string;
  drivers: readonly RepeatedFailureEpisodeDriver[];
  seeds: readonly number[];
  taskIds: readonly string[];
  variantIds: readonly string[];
  caps: ControlledResponsesCaps;
  maxHostRetries: 0 | 1 | 2 | 3 | 4 | 5;
  statisticsSeed: number;
  statisticsDraws: number;
  maxToolOutputChars: number;
  phase: "pilot" | "main" | "unspecified";
  clock: () => number;
  now: () => Date;
};
export type RowExecutionOptions = Pick<
  NormalizedRunOptions,
  "outputDir" | "caps" | "maxHostRetries" | "maxToolOutputChars" | "clock"
>;
export type VerifiedPilotPower = {
  runId: string;
  manifestArtifactHash: string;
  powerArtifactHash: string;
  artifact: Record<string, unknown>;
  profileBindings: readonly {
    id: string;
    hash: string;
    modelDigest: string;
    driverKind: "responses" | "ollama-chat" | "deterministic-fake" | "unknown";
    tokenizerIdentity: string;
    tokenizerImplementation: "nfkc-whitespace-v1";
  }[];
  trapAuditReceipts: RepeatedFailureRunMetadata["trapAuditReceipts"];
  runOrder: RepeatedFailureRunMetadata["runOrder"];
  expectedDesignHash: string;
  episodesHash: string;
};
export type FactPairAuditPair = {
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
export type FactPairAuditArtifact = {
  schemaVersion: 1;
  minimumJaccard: 0.8;
  maximumTokenGap: 8;
  maximumRelativeTokenGap: 0.05;
  pairs: readonly FactPairAuditPair[];
};
export type ParsedStrategyAction = {
  strategyId: string;
  patch: StrategyPatch;
  intent: ActionIntent;
  strategyCategory: ActionStrategyId;
};

export function buildFixtureToolDefinitions(
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

export function strategyDiffShape(task: BaseTask, candidateId?: string): string {
  const candidate = candidateId ?? "bad";
  return `h6-v1:${task.normalizedActionIntent.actionType}:${candidate}:${task.normalizedActionIntent.contextHash.slice(0, 16)}`;
}

export class FixtureToolHost implements RepeatedFailureLocalToolHost {
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
          changedFiles: parsed.patch.files.map((file) => file.path).sort(compareCodePoints),
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
      changedFiles: [...new Set(changedFiles)].sort(compareCodePoints),
    };
  }

  repeatedBadStrategy(): boolean {
    return this.badExecutions > 0;
  }
}

export class FixtureActionEvaluator implements RepeatedFailureActionEvaluator {
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

export function countFactTokens(
  value: string,
  tokenizer: RepeatedFailureEpisodeDriver["tokenizer"],
): number {
  if (tokenizer.implementation !== "nfkc-whitespace-v1") {
    throw new Error(`unsupported registered tokenizer implementation: ${String(tokenizer.implementation)}`);
  }
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .length;
}

function nodePermissionFlag(): "--experimental-permission" | "--permission" {
  const [majorText, minorText] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`unsupported Node version: ${process.versions.node}`);
  }
  return major > 22 || (major === 22 && minor >= 13)
    ? "--permission"
    : "--experimental-permission";
}

export async function runOfflineCheck(repoDir: string, task: BaseTask): Promise<CheckExecution> {
  if (task.checkCommand !== "node test/check.js") {
    throw new Error("task check command is not the frozen offline check");
  }
  if (process.platform !== "linux") {
    throw new Error("frozen offline checks require Linux user and network namespaces");
  }
  const result = await executeOfflineCheckFile(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--net",
      process.execPath,
      nodePermissionFlag(),
      `--allow-fs-read=${repoDir}`,
      "test/check.js",
    ],
    repoDir,
  );
  const state: CheckExecution["state"] = result.exitCode === 0
    ? "FIXED"
    : result.exitCode === 2
      ? "TRAPPED"
      : result.exitCode === 1
        ? "UNFIXED"
        : "INDETERMINATE";
  return { state, exitCode: result.exitCode, outputHash: sha256(result.output) };
}

function executeOfflineCheckFile(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ exitCode: number; output: string }>();
  execFile(command, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
    env: {
      CI: "1",
      LANG: "C",
      LC_ALL: "C",
      NODE_NO_WARNINGS: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    },
  }, (error, stdout, stderr) => {
    const errorCode = (error as unknown as { code?: unknown } | null)?.code;
    const exitCode = typeof errorCode === "number" ? errorCode : error ? 255 : 0;
    resolve({ exitCode, output: `${stdout}${stderr}`.slice(0, 65_536) });
  });
  return promise;
}

export async function listRegularFiles(root: string, excludeGit: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
    if (excludeGit && entry.name === ".git") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("artifact trees cannot contain symbolic links");
    if (entry.isDirectory()) files.push(...await listRegularFiles(fullPath, excludeGit));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort(compareCodePoints);
}

export async function hashDirectory(root: string, excludeGit: boolean): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of await listRegularFiles(root, excludeGit)) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    hash.update(relative).update("\0").update(await readFile(filePath)).update("\0");
  }
  return hash.digest("hex");
}


export async function containedRegularDirectory(root: string, relative: string): Promise<string> {
  const target = containedPath(root, relative || ".");
  await assertNoSymlinkComponents(root, target);
  if (!(await lstat(target)).isDirectory()) throw new Error("requested path is not a directory");
  return target;
}

export async function containedRegularFile(root: string, relative: string): Promise<string> {
  const target = containedPath(root, relative);
  await assertNoSymlinkComponents(root, target);
  if (!(await lstat(target)).isFile()) throw new Error("requested path is not a regular file");
  return target;
}

export function containedPath(root: string, relative: string): string {
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

export async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
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

export function identityFor(
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

export function buildIsolation(rowKey: string): RepeatedFailureIsolationIdentity {
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

export function noMatchGate(action: RepeatedFailureProposedAction): RepeatedFailureGateEvent {
  return {
    status: "NO_MATCH",
    fingerprintHash: sha256(stableStringify({ tool: action.tool, arguments: action.arguments })),
  };
}

export function hostFaultResult(error: unknown): ControlledResponsesEpisodeResult {
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


export function zeroTokens(): RepeatedFailureTokenUsage {
  return {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  };
}

export function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function strictObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

export function failedTool(error: unknown): RepeatedFailureToolExecutionResult {
  return {
    status: "failed",
    output: { code: boundedCode(error instanceof Error ? error.message : String(error)) },
  };
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function boundedCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, "_").slice(0, 128);
  return normalized || "UNKNOWN";
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /(?:\/home\/[^\s/]+|\/Users\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/gu,
    "$HOME",
  );
}
