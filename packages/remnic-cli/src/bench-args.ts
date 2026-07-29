import path from "node:path";
import type {
  BuiltInProvider,
  McpMemoryToolMapping,
  PublishedBenchmarkId,
} from "@remnic/bench";
import {
  collectBenchmarks,
  readBenchOptionValue,
  validateBenchFlags,
} from "./bench-flags.js";
import { expandTilde } from "./path-utils.js";
import {
  type BenchResearchArgs,
  parseBenchResearchArgs,
} from "./bench-args-research.js";

export type BenchAction =
  | "help"
  | "list"
  | "run"
  | "datasets"
  | "runs"
  | "compare"
  | "ui"
  | "results"
  | "baseline"
  | "export"
  | "providers"
  | "publish"
  | "published"
  | "judge-calibrate"
  | "check"
  | "report"
  | "attribute"
  | "drift-gen";

export type BenchBaselineAction = "save" | "list";
export type BenchDatasetAction = "download" | "status";
export type BenchExportFormat = "json" | "csv" | "html";
export type BenchProviderAction = "discover";
export type BenchPublishTarget = "remnic-ai";
export type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain" | "local-lab";
export type BenchModelSource = "plugin" | "gateway";
export type BenchRunAction = "list" | "show" | "delete";
export type AmaBenchJudgeProtocol = "default" | "recommended";
export type BenchCodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ParsedBenchArgs extends BenchResearchArgs {
  action: BenchAction;
  benchmarks: string[];
  quick: boolean;
  all: boolean;
  json: boolean;
  detail: boolean;
  adapter?: "remnic" | "mcp";
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpUrl?: string;
  mcpToolMap?: McpMemoryToolMapping;
  mcpDemo?: boolean;
  datasetDir?: string;
  resultsDir?: string;
  baselinesDir?: string;
  runtimeProfile?: BenchRuntimeProfile;
  matrixProfiles?: BenchRuntimeProfile[];
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: BenchModelSource;
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  systemApiKey?: string;
  systemCodexReasoningEffort?: BenchCodexReasoningEffort;
  systemResponderContextBudgetChars?: number;
  systemResponderPromptBudgetChars?: number;
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  judgeCodexReasoningEffort?: BenchCodexReasoningEffort;
  internalProvider?: BuiltInProvider;
  internalModel?: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalDisableThinking?: boolean;
  internalCodexReasoningEffort?: BenchCodexReasoningEffort;
  threshold?: number;
  baselineAction?: BenchBaselineAction;
  datasetAction?: BenchDatasetAction;
  providerAction?: BenchProviderAction;
  runAction?: BenchRunAction;
  format?: BenchExportFormat;
  output?: string;
  custom?: string;
  target?: BenchPublishTarget;
  requestTimeout?: number;
  localJudgeRequestTimeout?: number;
  frontierJudgeRequestTimeout?: number;
  calibrationDir?: string;
  calibrationLocalConfigSha256?: string;
  calibrationFrontierConfigSha256?: string;
  sourceResultId?: string;
  expectedAnswerSetSha256?: string;
  expectedQuestionIdListSha256?: string;
  taskIdsFile?: string;
  expectedTaskIdListSha256?: string;
  drainTimeout?: number;
  /** Max wall-clock time (ms) to keep retrying 429 rate-limit responses. */
  max429WaitMs?: number;
  /** Suppress thinking/reasoning tokens for thinking-capable models (Gemma 4, Qwen 3.5, DeepSeek). */
  disableThinking?: boolean;
  /** AMA-Bench-specific judge protocol. `recommended` uses binary accuracy scoring. */
  amaBenchJudgeProtocol?: AmaBenchJudgeProtocol;
  amaBenchCrossJudgeProvider?: BuiltInProvider;
  amaBenchCrossJudgeModel?: string;
  amaBenchCrossJudgeBaseUrl?: string;
  amaBenchCrossJudgeApiKey?: string;
  amaBenchCrossJudgeCodexReasoningEffort?: BenchCodexReasoningEffort;
  /** `bench published` — specific benchmark to run. */
  publishedName?: PublishedBenchmarkName;
  /** `bench published` — seed forwarded into the harness context. */
  publishedSeed?: number;
  /** `bench published` — item limit forwarded into the dataset loader. */
  publishedLimit?: number;
  /** `bench published` — scored trial cap forwarded into benchmark-specific options. */
  publishedTrialLimit?: number;
  /** `bench published` — max independent trials to execute at once when supported. */
  publishedTrialConcurrency?: number;
  /** `bench published` — max independent ingest sessions to summarize at once when supported. */
  publishedIngestConcurrency?: number;
  /** `bench published` — benchmark-specific task/ability filter for diagnostic runs. */
  publishedTaskFilter?: string;
  /** `bench run memcorrect-v1` — adapter mode ("remnic" | "prompt-only"). */
  memcorrectAdapter?: "remnic" | "prompt-only";
  /** `bench published` — published artifact output directory. */
  publishedOut?: string;
  /** `bench published` — dry-run: validate + load but do NOT call the model. */
  publishedDryRun?: boolean;
  /** Skip benchmarks that completed successfully in the previous run. */
  resume?: boolean;
  /** Only re-run benchmarks that failed in the previous run. */
  retryFailed?: boolean;
  /** Issue #1573 PR1: force-disable the content-keyed judge-result cache. */
  noJudgeCache?: boolean;
  /** Issue #1573 PR1: override the judge-result cache directory. */
  judgeCacheDir?: string;
  /**
   * Issue #1573 PR2: path to a local-lab manifest JSON file. Required when
   * `runtimeProfile` / `matrixProfiles` includes `"local-lab"`. On other
   * profiles it binds the judge to the manifest's normalized full config while
   * leaving the selected responder profile unchanged.
   */
  localLabManifestPath?: string;
  driftGenAction?: "generate" | "validate";
  driftGenDir?: string;
}

export interface BenchWorkItem {
  benchmarkId: string;
  runtimeProfile: BenchRuntimeProfile;
}

export interface PreviousBenchStatusEntry {
  id: string;
  status: string;
}

export function createBenchWorkItems(
  benchmarks: readonly string[],
  runtimeProfiles: readonly BenchRuntimeProfile[],
): BenchWorkItem[] {
  return benchmarks.flatMap((benchmarkId) =>
    runtimeProfiles.map((runtimeProfile) => ({ benchmarkId, runtimeProfile })),
  );
}

export function deriveRuntimeProfilesFromBenchWorkItems(
  workItems: readonly BenchWorkItem[],
): BenchRuntimeProfile[] {
  return [...new Set(workItems.map((item) => item.runtimeProfile))];
}

export function filterBenchWorkItemsForPreviousStatus(
  workItems: readonly BenchWorkItem[],
  previousEntries: readonly PreviousBenchStatusEntry[],
  mode: "resume" | "retry-failed",
): BenchWorkItem[] {
  const statusById = new Map(previousEntries.map((entry) => [entry.id, entry.status]));
  const hasMatrixWork = new Set(workItems.map((item) => item.benchmarkId)).size !== workItems.length;

  function statusFor(item: BenchWorkItem): string | undefined {
    const profileStatus = statusById.get(`${item.benchmarkId} [${item.runtimeProfile}]`);
    if (profileStatus !== undefined) return profileStatus;
    if (hasMatrixWork) {
      return mode === "retry-failed" ? statusById.get(item.benchmarkId) : undefined;
    }
    return statusById.get(item.benchmarkId);
  }

  return workItems.filter((item) => {
    const status = statusFor(item);
    if (mode === "retry-failed") {
      return status === "failed";
    }
    return status !== "complete";
  });
}

export const PUBLISHED_BENCHMARK_NAMES = Object.freeze([
  "ama-bench",
  "memory-arena",
  "amemgym",
  "longmemeval",
  "locomo",
  "beam",
  "personamem",
  "memoryagentbench",
  "membench",
] as const satisfies readonly PublishedBenchmarkId[]);
export type PublishedBenchmarkName = (typeof PUBLISHED_BENCHMARK_NAMES)[number];
type AssertTrue<T extends true> = T;
type MissingPublishedBenchmarkNames = Exclude<PublishedBenchmarkId, PublishedBenchmarkName>;
type ExtraPublishedBenchmarkNames = Exclude<PublishedBenchmarkName, PublishedBenchmarkId>;
type PublishedBenchmarkNamesMatchArtifactIds = AssertTrue<
  [MissingPublishedBenchmarkNames] extends [never]
    ? [ExtraPublishedBenchmarkNames] extends [never]
      ? true
      : false
    : false
>;
const publishedBenchmarkNamesMatchArtifactIds: PublishedBenchmarkNamesMatchArtifactIds = true;
void publishedBenchmarkNamesMatchArtifactIds;

function isBenchRuntimeProfile(value: string): value is BenchRuntimeProfile {
  return (
    value === "baseline" ||
    value === "real" ||
    value === "openclaw-chain" ||
    value === "local-lab"
  );
}

function parseBenchRuntimeProfile(
  value: string,
  flagName: "--runtime-profile" | "--matrix",
): BenchRuntimeProfile {
  if (isBenchRuntimeProfile(value)) {
    return value;
  }

  if (flagName === "--runtime-profile") {
    throw new Error(
      'ERROR: --runtime-profile must be "baseline", "real", "openclaw-chain", or "local-lab".',
    );
  }

  throw new Error(
    'ERROR: --matrix must contain only "baseline", "real", "openclaw-chain", or "local-lab".',
  );
}

/**
 * Shared allow-list for `--provider`, `--system-provider`, and
 * `--judge-provider`. Keeping these in lockstep is a CLAUDE.md rule 52
 * concern: if one flag accepts "local-llm" but another rejects it,
 * behavior becomes path-dependent. Issue #566 slice 5 added
 * "local-llm"; Codex CLI provider wiring added "codex-cli"; Claude CLI
 * provider wiring added "claude-cli". The single source of truth is here.
 */
const BENCH_PROVIDER_ALLOWED: readonly BuiltInProvider[] = Object.freeze([
  "openai",
  "anthropic",
  "ollama",
  "litellm",
  "local-llm",
  "codex-cli",
  "claude-cli",
]);

/**
 * `--internal-provider` allow-list. Deliberately narrower than
 * `BENCH_PROVIDER_ALLOWED`: it excludes "claude-cli". The internal
 * provider feeds Remnic's own gateway (`@remnic/core`), which only
 * special-cases `api === "codex-cli"` and `api === "anthropic-messages"` —
 * there is no `claude-cli` gateway integration, so selecting it here would
 * silently fall through to the generic/OpenAI-compatible gateway path
 * instead of actually invoking `claude -p`. `claude-cli` is only wired for
 * the bench responder/judge factory path (`--provider` / `--system-
 * provider` / `--judge-provider`), see providers/factory.ts. (PR #1735
 * review)
 */
const BENCH_INTERNAL_PROVIDER_ALLOWED: readonly BuiltInProvider[] = Object.freeze(
  BENCH_PROVIDER_ALLOWED.filter((provider) => provider !== "claude-cli"),
);

function isBuiltInProvider(value: string): value is BuiltInProvider {
  return (BENCH_PROVIDER_ALLOWED as readonly string[]).includes(value);
}

function isBuiltInInternalProvider(value: string): value is BuiltInProvider {
  return (BENCH_INTERNAL_PROVIDER_ALLOWED as readonly string[]).includes(value);
}

function parseBenchProvider(raw: string, flag: string): BuiltInProvider {
  if (!isBuiltInProvider(raw)) {
    throw new Error(
      `ERROR: ${flag} must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", "codex-cli", or "claude-cli".`,
    );
  }
  return raw;
}

function parseBenchInternalProvider(raw: string, flag: string): BuiltInProvider {
  if (!isBuiltInInternalProvider(raw)) {
    if (raw === "claude-cli") {
      throw new Error(
        `ERROR: ${flag} does not support "claude-cli" (no @remnic/core gateway wiring); ` +
          "use --provider, --system-provider, or --judge-provider instead.",
      );
    }
    throw new Error(
      `ERROR: ${flag} must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", or "codex-cli".`,
    );
  }
  return raw;
}

function parseCodexReasoningEffort(
  raw: string,
  flag: string,
): BenchCodexReasoningEffort {
  if (raw !== "low" && raw !== "medium" && raw !== "high" && raw !== "xhigh") {
    throw new Error(
      `ERROR: ${flag} must be "low", "medium", "high", or "xhigh".`,
    );
  }
  return raw;
}

const MCP_TOOL_OPERATIONS = new Set(["store", "recall", "correct", "reset"]);
const MCP_ARGUMENT_SEMANTICS = new Set([
  "namespace",
  "sessionId",
  "content",
  "role",
  "timestamp",
  "query",
  "limit",
]);

function parseMcpToolMapping(value: unknown): McpMemoryToolMapping {
  if (!isPlainObject(value)) throw new Error("expected a JSON object");
  for (const operation of Object.keys(value).sort()) {
    if (!MCP_TOOL_OPERATIONS.has(operation)) {
      throw new Error(`unknown operation ${operation}`);
    }
    const entry = value[operation];
    if (typeof entry === "string") {
      if (entry.trim().length === 0) throw new Error(`${operation} tool name must not be empty`);
      continue;
    }
    if (!isPlainObject(entry)) {
      throw new Error(`${operation} must be a tool-name string or mapping object`);
    }
    for (const field of Object.keys(entry).sort()) {
      if (field !== "name" && field !== "arguments" && field !== "resultPath") {
        throw new Error(`${operation} contains unknown field ${field}`);
      }
    }
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw new Error(`${operation}.name must be a non-empty string`);
    }
    if (entry.resultPath !== undefined) {
      if (typeof entry.resultPath !== "string" || !isSafeMcpResultPath(entry.resultPath)) {
        throw new Error(`${operation}.resultPath must be a non-empty safe dot path`);
      }
    }
    if (entry.arguments !== undefined) {
      if (!isPlainObject(entry.arguments)) {
        throw new Error(`${operation}.arguments must be an object`);
      }
      for (const semantic of Object.keys(entry.arguments).sort()) {
        if (!MCP_ARGUMENT_SEMANTICS.has(semantic)) {
          throw new Error(`${operation}.arguments contains unknown semantic ${semantic}`);
        }
        const argumentName = entry.arguments[semantic];
        if (typeof argumentName !== "string" || argumentName.trim().length === 0) {
          throw new Error(`${operation}.arguments.${semantic} must be a non-empty string`);
        }
      }
    }
  }
  return value as McpMemoryToolMapping;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeMcpResultPath(value: string): boolean {
  return value.split(".").every((segment) =>
    segment.length > 0 &&
    segment !== "__proto__" &&
    segment !== "prototype" &&
    segment !== "constructor" &&
    /^[A-Za-z0-9_-]+$/.test(segment)
  );
}


export function parseBenchActionArgs(argv: string[]): {
  action: BenchAction;
  args: string[];
} {
  const [first, ...rest] = argv;
  const action: BenchAction =
    first === "list" ||
    first === "run" ||
    first === "datasets" ||
    first === "runs" ||
    first === "compare" ||
    first === "ui" ||
    first === "results" ||
    first === "baseline" ||
    first === "export" ||
    first === "providers" ||
    first === "publish" ||
    first === "published" ||
    first === "judge-calibrate" ||
    first === "check" ||
    first === "report" ||
    first === "attribute" ||
    first === "drift-gen"
      ? first
      : first === undefined || first === "--help" || first === "-h"
        ? "help"
        : "run";

  return {
    action,
    args: action === "run" && action !== first ? argv : rest,
  };
}

export function parseBenchArgs(argv: string[]): ParsedBenchArgs {
  const { action, args } = parseBenchActionArgs(argv);
  if (args.includes("--help") || args.includes("-h")) {
    return {
      action: "help",
      benchmarks: [],
      quick: false,
      all: false,
      json: false,
      detail: false,
    };
  }
  const baselineAction =
    action === "baseline"
      ? args[0] === "save" || args[0] === "list"
        ? args[0]
        : undefined
      : undefined;
  const datasetAction =
    action === "datasets"
      ? args[0] === "download" || args[0] === "status"
        ? args[0]
        : undefined
      : undefined;
  const providerAction =
    action === "providers"
      ? args[0] === "discover"
        ? args[0]
        : undefined
      : undefined;
  const runAction =
    action === "runs"
      ? args[0] === "list" || args[0] === "show" || args[0] === "delete"
        ? args[0]
        : undefined
      : undefined;
  const driftGenAction =
    action === "drift-gen"
      ? args[0] === "validate"
        ? "validate"
        : args[0] === "generate"
          ? "generate"
          : args[0] !== undefined && !args[0].startsWith("-")
            ? undefined
            : "generate"
      : undefined;

  if (action === "baseline" && baselineAction === undefined) {
    throw new Error("ERROR: baseline requires a subcommand: save or list.");
  }
  if (action === "datasets" && datasetAction === undefined) {
    throw new Error("ERROR: datasets requires a subcommand: download or status.");
  }
  if (action === "providers" && providerAction === undefined) {
    throw new Error("ERROR: providers requires a subcommand: discover.");
  }
  if (action === "runs" && runAction === undefined) {
    throw new Error("ERROR: runs requires a subcommand: list, show, or delete.");
  }
  if (action === "drift-gen" && driftGenAction === undefined) {
    throw new Error('ERROR: drift-gen subcommand must be "generate" or "validate".');
  }
  validateBenchFlags(action, args);

  const driftGenPositionals =
    action === "drift-gen" && driftGenAction === "validate"
      ? collectBenchmarks(args.slice(1))
      : [];
  const driftGenDir = driftGenPositionals[0]
    ? path.resolve(expandTilde(driftGenPositionals[0]))
    : undefined;

  const benchmarkArgs =
    action === "baseline" ||
    action === "datasets" ||
    action === "providers" ||
    action === "runs" ||
    (action === "drift-gen" && (args[0] === "validate" || args[0] === "generate"))
      ? args.slice(1)
      : args;
  const benchmarks = collectBenchmarks(benchmarkArgs);
  // `--dataset` is an alias for `--dataset-dir`. `--dataset-dir` wins
  // if both are supplied.
  const datasetDir =
    readBenchOptionValue(args, "--dataset-dir") ??
    readBenchOptionValue(args, "--dataset");
  const adapterRaw = readBenchOptionValue(args, "--adapter");
  const mcpCommand = readBenchOptionValue(args, "--mcp-command");
  const mcpArgsRaw = readBenchOptionValue(args, "--mcp-args");
  const mcpUrl = readBenchOptionValue(args, "--mcp-url");
  const mcpToolMapRaw = readBenchOptionValue(args, "--mcp-tool-map");
  const mcpDemo = args.includes("--mcp-demo");
  const resultsDir = readBenchOptionValue(args, "--results-dir");
  const baselinesDir = readBenchOptionValue(args, "--baselines-dir");
  const runtimeProfileRaw = readBenchOptionValue(args, "--runtime-profile");
  const matrixRaw = readBenchOptionValue(args, "--matrix");
  const remnicConfigRaw = readBenchOptionValue(args, "--remnic-config");
  const openclawConfigRaw = readBenchOptionValue(args, "--openclaw-config");
  const modelSourceRaw = readBenchOptionValue(args, "--model-source");
  const gatewayAgentId = readBenchOptionValue(args, "--gateway-agent-id");
  const fastGatewayAgentId = readBenchOptionValue(args, "--fast-gateway-agent-id");
  const systemProviderRaw = readBenchOptionValue(args, "--system-provider");
  const systemModel = readBenchOptionValue(args, "--system-model");
  const systemBaseUrl = readBenchOptionValue(args, "--system-base-url");
  const systemApiKey = readBenchOptionValue(args, "--system-api-key");
  const systemCodexReasoningEffortRaw = readBenchOptionValue(
    args,
    "--system-codex-reasoning-effort",
  );
  const systemResponderContextBudgetRaw = readBenchOptionValue(
    args,
    "--system-responder-context-budget-chars",
  );
  const systemResponderPromptBudgetRaw = readBenchOptionValue(
    args,
    "--system-responder-prompt-budget-chars",
  );
  const judgeProviderRaw = readBenchOptionValue(args, "--judge-provider");
  const judgeModel = readBenchOptionValue(args, "--judge-model");
  const judgeBaseUrl = readBenchOptionValue(args, "--judge-base-url");
  const judgeApiKey = readBenchOptionValue(args, "--judge-api-key");
  const judgeCodexReasoningEffortRaw = readBenchOptionValue(
    args,
    "--judge-codex-reasoning-effort",
  );
  const internalProviderRaw = readBenchOptionValue(args, "--internal-provider");
  const internalModel = readBenchOptionValue(args, "--internal-model");
  const internalBaseUrl = readBenchOptionValue(args, "--internal-base-url");
  const internalApiKey = readBenchOptionValue(args, "--internal-api-key");
  const internalCodexReasoningEffortRaw = readBenchOptionValue(
    args,
    "--internal-codex-reasoning-effort",
  );
  const thresholdRaw = readBenchOptionValue(args, "--threshold");
  const customRaw = readBenchOptionValue(args, "--custom");
  const formatRaw = readBenchOptionValue(args, "--format");
  const output = readBenchOptionValue(args, "--output");
  const targetRaw = readBenchOptionValue(args, "--target");
  const requestTimeoutRaw = readBenchOptionValue(args, "--request-timeout");
  const localJudgeRequestTimeoutRaw = readBenchOptionValue(args, "--local-judge-request-timeout");
  const frontierJudgeRequestTimeoutRaw = readBenchOptionValue(args, "--frontier-judge-request-timeout");
  const calibrationDirRaw = readBenchOptionValue(args, "--calibration-dir");
  const calibrationLocalConfigSha256 = readBenchOptionValue(args, "--calibration-local-config-sha256");
  const calibrationFrontierConfigSha256 = readBenchOptionValue(args, "--calibration-frontier-config-sha256");
  const sourceResultId = readBenchOptionValue(args, "--source-result-id");
  const expectedAnswerSetSha256 = readBenchOptionValue(args, "--expected-answer-set-sha256");
  const expectedQuestionIdListSha256 = readBenchOptionValue(args, "--expected-question-id-list-sha256");
  const taskIdsFileRaw = readBenchOptionValue(args, "--task-ids-file");
  const expectedTaskIdListSha256 = readBenchOptionValue(args, "--expected-task-id-list-sha256");
  const drainTimeoutRaw = readBenchOptionValue(args, "--drain-timeout");
  // Issue #1573 PR1: judge-result cache directory override. `parseBenchArgs`
  // resolves tildes + relative paths identically to other filesystem flags
  // (datasetDir, resultsDir, baselinesDir).
  const judgeCacheDirRaw = readBenchOptionValue(args, "--judge-cache-dir");
  const localLabManifestRaw = readBenchOptionValue(args, "--local-lab-manifest");
  const max429WaitRaw = readBenchOptionValue(args, "--max-429-wait");
  const amaBenchJudgeProtocolRaw = readBenchOptionValue(args, "--ama-bench-judge-protocol");
  const amaBenchCrossJudgeProviderRaw = readBenchOptionValue(args, "--ama-bench-cross-judge-provider");
  const amaBenchCrossJudgeModel = readBenchOptionValue(args, "--ama-bench-cross-judge-model");
  const amaBenchCrossJudgeBaseUrl = readBenchOptionValue(args, "--ama-bench-cross-judge-base-url");
  const amaBenchCrossJudgeApiKey = readBenchOptionValue(args, "--ama-bench-cross-judge-api-key");

  let adapter: "remnic" | "mcp" | undefined;
  if (adapterRaw !== undefined) {
    if (adapterRaw !== "remnic" && adapterRaw !== "mcp") {
      throw new Error('ERROR: --adapter must be "remnic" or "mcp".');
    }
    adapter = adapterRaw;
  }
  const research = parseBenchResearchArgs(action, args);

  const hasMcpOptions = Boolean(
    mcpCommand || mcpArgsRaw || mcpUrl || mcpToolMapRaw || mcpDemo,
  );
  if (hasMcpOptions && adapter !== "mcp") {
    throw new Error("ERROR: MCP options require --adapter mcp.");
  }
  if (adapter === "mcp") {
    const transportCount = Number(Boolean(mcpCommand)) + Number(Boolean(mcpUrl)) + Number(mcpDemo);
    if (transportCount !== 1) {
      throw new Error(
        "ERROR: --adapter mcp requires exactly one of --mcp-command, --mcp-url, or --mcp-demo.",
      );
    }
  }
  if (mcpArgsRaw && !mcpCommand) {
    throw new Error("ERROR: --mcp-args requires --mcp-command.");
  }
  if (mcpUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(mcpUrl);
    } catch {
      throw new Error("ERROR: --mcp-url must be a valid HTTP(S) URL.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("ERROR: --mcp-url must use http or https.");
    }
  }
  let mcpArgs: string[] | undefined;
  if (mcpArgsRaw) {
    try {
      const parsed: unknown = JSON.parse(mcpArgsRaw);
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error("shape");
      }
      mcpArgs = parsed;
    } catch {
      throw new Error('ERROR: --mcp-args must be a JSON array of strings, for example ["server.js"].');
    }
  }
  let mcpToolMap: McpMemoryToolMapping | undefined;
  if (mcpToolMapRaw) {
    try {
      const parsed: unknown = JSON.parse(mcpToolMapRaw);
      mcpToolMap = parseMcpToolMapping(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`ERROR: --mcp-tool-map is invalid: ${detail}`);
    }
  }
  const amaBenchCrossJudgeCodexReasoningEffortRaw = readBenchOptionValue(
    args,
    "--ama-bench-cross-judge-codex-reasoning-effort",
  );
  let runtimeProfile: BenchRuntimeProfile | undefined;
  if (runtimeProfileRaw !== undefined) {
    runtimeProfile = parseBenchRuntimeProfile(
      runtimeProfileRaw,
      "--runtime-profile",
    );
  }

  let matrixProfiles: BenchRuntimeProfile[] | undefined;
  if (matrixRaw !== undefined) {
    const candidates = matrixRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (candidates.length === 0) {
      throw new Error(
        'ERROR: --matrix must contain one or more of "baseline", "real", "openclaw-chain", or "local-lab".',
      );
    }
    matrixProfiles = candidates.map((candidate) =>
      parseBenchRuntimeProfile(candidate, "--matrix"),
    );
  }

  let modelSource: BenchModelSource | undefined;
  if (modelSourceRaw !== undefined) {
    if (modelSourceRaw !== "plugin" && modelSourceRaw !== "gateway") {
      throw new Error('ERROR: --model-source must be "plugin" or "gateway".');
    }
    modelSource = modelSourceRaw;
  }

  let systemProvider: BuiltInProvider | undefined;
  if (systemProviderRaw !== undefined) {
    systemProvider = parseBenchProvider(systemProviderRaw, "--system-provider");
  }

  let judgeProvider: BuiltInProvider | undefined;
  if (judgeProviderRaw !== undefined) {
    judgeProvider = parseBenchProvider(judgeProviderRaw, "--judge-provider");
  }

  const systemCodexReasoningEffort = systemCodexReasoningEffortRaw === undefined
    ? undefined
    : parseCodexReasoningEffort(
      systemCodexReasoningEffortRaw,
      "--system-codex-reasoning-effort",
    );
  const judgeCodexReasoningEffort = judgeCodexReasoningEffortRaw === undefined
    ? undefined
    : parseCodexReasoningEffort(
      judgeCodexReasoningEffortRaw,
      "--judge-codex-reasoning-effort",
    );

  let internalProvider: BuiltInProvider | undefined;
  if (internalProviderRaw !== undefined) {
    internalProvider = parseBenchInternalProvider(internalProviderRaw, "--internal-provider");
  }

  const internalCodexReasoningEffort = internalCodexReasoningEffortRaw === undefined
    ? undefined
    : parseCodexReasoningEffort(
      internalCodexReasoningEffortRaw,
      "--internal-codex-reasoning-effort",
    );

  let amaBenchJudgeProtocol: AmaBenchJudgeProtocol | undefined;
  if (amaBenchJudgeProtocolRaw !== undefined) {
    if (
      amaBenchJudgeProtocolRaw !== "default" &&
      amaBenchJudgeProtocolRaw !== "recommended"
    ) {
      throw new Error(
        'ERROR: --ama-bench-judge-protocol must be "default" or "recommended".',
      );
    }
    amaBenchJudgeProtocol = amaBenchJudgeProtocolRaw;
  }

  let amaBenchCrossJudgeProvider: BuiltInProvider | undefined;
  if (amaBenchCrossJudgeProviderRaw !== undefined) {
    amaBenchCrossJudgeProvider = parseBenchProvider(
      amaBenchCrossJudgeProviderRaw,
      "--ama-bench-cross-judge-provider",
    );
  }
  const amaBenchCrossJudgeCodexReasoningEffort =
    amaBenchCrossJudgeCodexReasoningEffortRaw === undefined
      ? undefined
      : parseCodexReasoningEffort(
        amaBenchCrossJudgeCodexReasoningEffortRaw,
        "--ama-bench-cross-judge-codex-reasoning-effort",
      );

  let threshold: number | undefined;
  if (thresholdRaw !== undefined) {
    threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new Error("ERROR: --threshold must be a non-negative number.");
    }
    if (action === "attribute" && threshold > 1) {
      throw new Error("ERROR: --threshold must be a number between 0 and 1.");
    }
  }

  let format: BenchExportFormat | undefined;
  if (formatRaw !== undefined) {
    if (formatRaw !== "json" && formatRaw !== "csv" && formatRaw !== "html") {
      throw new Error('ERROR: --format must be "json", "csv", or "html".');
    }
    format = formatRaw;
  }

  let target: BenchPublishTarget | undefined;
  if (targetRaw !== undefined) {
    if (targetRaw !== "remnic-ai") {
      throw new Error('ERROR: --target must be "remnic-ai".');
    }
    target = targetRaw;
  }

  let requestTimeout: number | undefined;
  if (requestTimeoutRaw !== undefined) {
    requestTimeout = Number(requestTimeoutRaw);
    if (!Number.isInteger(requestTimeout) || requestTimeout <= 0) {
      throw new Error(
        "ERROR: --request-timeout must be a positive integer (milliseconds).",
      );
    }
    if (requestTimeout > 3600_000) {
      throw new Error(
        "ERROR: --request-timeout must not exceed 3,600,000 ms (1 hour).",
      );
    }
  }

  const parseJudgeTimeout = (raw: string | undefined, flag: string): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > 3_600_000) {
      throw new Error(`ERROR: ${flag} must be a positive integer no greater than 3,600,000 ms.`);
    }
    return value;
  };
  const localJudgeRequestTimeout = parseJudgeTimeout(localJudgeRequestTimeoutRaw, "--local-judge-request-timeout");
  const frontierJudgeRequestTimeout = parseJudgeTimeout(frontierJudgeRequestTimeoutRaw, "--frontier-judge-request-timeout");
  for (const [flag, digest] of [
    ["--expected-answer-set-sha256", expectedAnswerSetSha256],
    ["--expected-question-id-list-sha256", expectedQuestionIdListSha256],
    ["--expected-task-id-list-sha256", expectedTaskIdListSha256],
    ["--calibration-local-config-sha256", calibrationLocalConfigSha256],
    ["--calibration-frontier-config-sha256", calibrationFrontierConfigSha256],
  ] as const) {
    if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`ERROR: ${flag} must be a lowercase SHA-256 hex digest.`);
    }
  }

  let drainTimeout: number | undefined;
  if (drainTimeoutRaw !== undefined) {
    drainTimeout = Number(drainTimeoutRaw);
    if (!Number.isInteger(drainTimeout) || drainTimeout <= 0) {
      throw new Error(
        "ERROR: --drain-timeout must be a positive integer (milliseconds).",
      );
    }
    if (drainTimeout > 3600_000) {
      throw new Error(
        "ERROR: --drain-timeout must not exceed 3,600,000 ms (1 hour).",
      );
    }
  }

  let max429WaitMs: number | undefined;
  if (max429WaitRaw !== undefined) {
    max429WaitMs = Number(max429WaitRaw);
    if (!Number.isInteger(max429WaitMs) || max429WaitMs < 0) {
      throw new Error(
        "ERROR: --max-429-wait must be a non-negative integer (milliseconds).",
      );
    }
    if (max429WaitMs > 86_400_000) {
      throw new Error(
        "ERROR: --max-429-wait must not exceed 86,400,000 ms (24 hours).",
      );
    }
  }

  let systemResponderContextBudgetChars: number | undefined;
  if (systemResponderContextBudgetRaw !== undefined) {
    systemResponderContextBudgetChars = Number(systemResponderContextBudgetRaw);
    if (
      !Number.isInteger(systemResponderContextBudgetChars) ||
      systemResponderContextBudgetChars <= 0
    ) {
      throw new Error(
        "ERROR: --system-responder-context-budget-chars must be a positive integer.",
      );
    }
    if (systemResponderContextBudgetChars > 1_000_000) {
      throw new Error(
        "ERROR: --system-responder-context-budget-chars must not exceed 1,000,000.",
      );
    }
  }

  let systemResponderPromptBudgetChars: number | undefined;
  if (systemResponderPromptBudgetRaw !== undefined) {
    systemResponderPromptBudgetChars = Number(systemResponderPromptBudgetRaw);
    if (
      !Number.isInteger(systemResponderPromptBudgetChars) ||
      systemResponderPromptBudgetChars <= 0
    ) {
      throw new Error(
        "ERROR: --system-responder-prompt-budget-chars must be a positive integer.",
      );
    }
    if (systemResponderPromptBudgetChars > 1_000_000) {
      throw new Error(
        "ERROR: --system-responder-prompt-budget-chars must not exceed 1,000,000.",
      );
    }
  }

  // `bench published` flags. Parsed unconditionally so `--name`, `--model`,
  // etc. raise consistent errors even when used outside the `published`
  // action (mirrors CLAUDE.md rule 14: validate flag args at input boundaries).
  const publishedNameRaw = readBenchOptionValue(args, "--name");
  const publishedModelRaw = readBenchOptionValue(args, "--model");
  const publishedLimitRaw = readBenchOptionValue(args, "--limit");
  const publishedTrialLimitRaw = readBenchOptionValue(args, "--trial-limit");
  const publishedTrialConcurrencyRaw = readBenchOptionValue(
    args,
    "--trial-concurrency",
  );
  const publishedIngestConcurrencyRaw = readBenchOptionValue(
    args,
    "--ingest-concurrency",
  );
  const publishedTaskFilterRaw = readBenchOptionValue(args, "--task-filter");
  const publishedSeedRaw = readBenchOptionValue(args, "--seed");
  const publishedOutRaw = readBenchOptionValue(args, "--out");
  const publishedProviderRaw = readBenchOptionValue(args, "--provider");
  const publishedBaseUrlRaw = readBenchOptionValue(args, "--base-url");

  let publishedName: PublishedBenchmarkName | undefined;
  if (publishedNameRaw !== undefined) {
    if (!PUBLISHED_BENCHMARK_NAMES.includes(
      publishedNameRaw as PublishedBenchmarkName,
    )) {
      throw new Error(
        `ERROR: --name must be one of ${PUBLISHED_BENCHMARK_NAMES.join(", ")}.`,
      );
    }
    publishedName = publishedNameRaw as PublishedBenchmarkName;
  }

  let publishedLimit: number | undefined;
  if (publishedLimitRaw !== undefined) {
    const parsed = Number(publishedLimitRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        "ERROR: --limit must be a non-negative integer (use 0 to load zero items).",
      );
    }
    publishedLimit = parsed;
  }

  let publishedTrialLimit: number | undefined;
  if (publishedTrialLimitRaw !== undefined) {
    const parsed = Number(publishedTrialLimitRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        "ERROR: --trial-limit must be a non-negative integer (use 0 to run zero scored trials).",
      );
    }
    publishedTrialLimit = parsed;
  }
  const trialLimitTargetsSupportedBenchmark =
    publishedName === "locomo" ||
    publishedName === "memoryagentbench" ||
    (
      publishedName === undefined &&
      action === "published"
    ) ||
    (
      publishedName === undefined &&
      action !== "published" &&
      !args.includes("--all") &&
      benchmarks.length === 1 &&
      (benchmarks[0] === "locomo" || benchmarks[0] === "memoryagentbench")
    );
  if (publishedTrialLimit !== undefined && !trialLimitTargetsSupportedBenchmark) {
    throw new Error("ERROR: --trial-limit is currently supported only for LoCoMo and MemoryAgentBench.");
  }

  const hasTaskIdsFile = taskIdsFileRaw !== undefined;
  const hasExpectedTaskIdListSha256 = expectedTaskIdListSha256 !== undefined;
  if (hasTaskIdsFile !== hasExpectedTaskIdListSha256) {
    throw new Error(
      "ERROR: --task-ids-file and --expected-task-id-list-sha256 must be supplied together.",
    );
  }
  if (hasTaskIdsFile) {
    const targetsSingleLoCoMo = action === "published"
      ? publishedName === "locomo" && benchmarks.length === 0
      : action === "run" && !args.includes("--all") &&
        benchmarks.length === 1 && benchmarks[0] === "locomo";
    if (!targetsSingleLoCoMo) {
      throw new Error(
        "ERROR: --task-ids-file is supported only for a single LoCoMo run.",
      );
    }
    if (args.includes("--quick")) {
      throw new Error("ERROR: --task-ids-file requires a full LoCoMo run; remove --quick.");
    }
    if (publishedLimit !== undefined || publishedTrialLimit !== undefined) {
      throw new Error(
        "ERROR: --task-ids-file cannot be combined with --limit or --trial-limit.",
      );
    }
  }

  let publishedTrialConcurrency: number | undefined;
  if (publishedTrialConcurrencyRaw !== undefined) {
    const parsed = Number(publishedTrialConcurrencyRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 64) {
      throw new Error(
        "ERROR: --trial-concurrency must be an integer from 1 to 64.",
      );
    }
    publishedTrialConcurrency = parsed;
  }
  const trialConcurrencyTargetsSupportedBenchmark =
    publishedName === "locomo" ||
    publishedName === "ama-bench" ||
    (
      publishedName === undefined &&
      action === "published"
    ) ||
    (
      publishedName === undefined &&
      action !== "published" &&
      !args.includes("--all") &&
      benchmarks.length === 1 &&
      (benchmarks[0] === "locomo" || benchmarks[0] === "ama-bench")
    );
  if (
    publishedTrialConcurrency !== undefined &&
    !trialConcurrencyTargetsSupportedBenchmark
  ) {
    throw new Error("ERROR: --trial-concurrency is currently supported only for LoCoMo and AMA-Bench.");
  }

  let publishedIngestConcurrency: number | undefined;
  if (publishedIngestConcurrencyRaw !== undefined) {
    const parsed = Number(publishedIngestConcurrencyRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 64) {
      throw new Error(
        "ERROR: --ingest-concurrency must be an integer from 1 to 64.",
      );
    }
    publishedIngestConcurrency = parsed;
  }
  const ingestConcurrencyTargetsSupportedBenchmark =
    publishedName === "locomo" ||
    (
      publishedName === undefined &&
      action === "published"
    ) ||
    (
      publishedName === undefined &&
      action !== "published" &&
      !args.includes("--all") &&
      benchmarks.length === 1 &&
      benchmarks[0] === "locomo"
    );
  if (
    publishedIngestConcurrency !== undefined &&
    !ingestConcurrencyTargetsSupportedBenchmark
  ) {
    throw new Error("ERROR: --ingest-concurrency is currently supported only for LoCoMo.");
  }

  let publishedTaskFilter: string | undefined;
  if (publishedTaskFilterRaw !== undefined) {
    const taskFilterTargetsBeam =
      publishedName === "beam" ||
      (
        publishedName === undefined &&
        action !== "published" &&
        !args.includes("--all") &&
        benchmarks.length === 1 &&
        benchmarks[0] === "beam"
      );
    if (!taskFilterTargetsBeam) {
      throw new Error("ERROR: --task-filter is currently supported only for BEAM.");
    }
    const trimmed = publishedTaskFilterRaw.trim();
    if (trimmed.length === 0) {
      throw new Error("ERROR: --task-filter must not be empty.");
    }
    publishedTaskFilter = trimmed;
  }

  const memcorrectAdapterRaw = readBenchOptionValue(args, "--memcorrect-adapter");
  let memcorrectAdapter: "remnic" | "prompt-only" | undefined;
  if (memcorrectAdapterRaw !== undefined) {
    if (memcorrectAdapterRaw !== "remnic" && memcorrectAdapterRaw !== "prompt-only") {
      // Rule 51: reject invalid enum values with the valid options listed.
      throw new Error(
        'ERROR: --memcorrect-adapter must be "remnic" or "prompt-only".',
      );
    }
    // Mirror the other benchmark-specific flag checks (--task-filter,
    // --ingest-concurrency): an explicit adapter choice on a non-MemCorrect
    // run would be silently ignored downstream — reject instead (codex P2).
    const targetsMemcorrect =
      action !== "published" &&
      !args.includes("--all") &&
      benchmarks.length === 1 &&
      benchmarks[0] === "memcorrect-v1";
    if (!targetsMemcorrect) {
      throw new Error(
        "ERROR: --memcorrect-adapter is only supported for a single-benchmark memcorrect-v1 run.",
      );
    }
    memcorrectAdapter = memcorrectAdapterRaw;
  }

  let publishedSeed: number | undefined;
  if (publishedSeedRaw !== undefined) {
    const parsed = Number(publishedSeedRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        "ERROR: --seed must be a non-negative integer.",
      );
    }
    publishedSeed = parsed;
  }

  // `--model` is free-form (any provider-specific model ID), but we
  // reject empty strings so it doesn't silently fall through to a
  // default at a later stage.
  if (publishedModelRaw !== undefined && publishedModelRaw.trim().length === 0) {
    throw new Error("ERROR: --model must not be empty.");
  }

  // `--provider` is validated against the same allow-list as
  // `--system-provider` so the two surfaces stay in lockstep
  // (CLAUDE.md rule 52). `bench published` callers that prefer the
  // legacy flags can keep using `--system-provider`; `--provider`
  // is a shorthand specific to the published action.
  let publishedProvider: BuiltInProvider | undefined;
  if (publishedProviderRaw !== undefined) {
    publishedProvider = parseBenchProvider(publishedProviderRaw, "--provider");
  }

  // Published action aliases: `--system-*` takes precedence; the
  // shorthand `--provider` / `--base-url` / `--model` only fill in
  // when the legacy flags are absent so the two code paths stay
  // behaviorally identical.
  const effectiveSystemProvider = systemProvider ?? publishedProvider;
  const effectiveSystemModel = systemModel ?? publishedModelRaw;
  const effectiveSystemBaseUrl = systemBaseUrl ?? publishedBaseUrlRaw;

  // Issue #566 slice 5 — when the effective provider is `local-llm`,
  // a base URL is REQUIRED at the boundary. Silently defaulting to
  // an OpenAI URL violates CLAUDE.md rule 51 (reject invalid user
  // input with a listed option) and makes the `--provider local-llm`
  // contract untrustworthy. The same rule applies to `--judge-provider`.
  if (effectiveSystemProvider === "local-llm" && !effectiveSystemBaseUrl) {
    throw new Error(
      "ERROR: --provider local-llm requires --base-url (or --system-base-url). " +
        "Examples: llama.cpp (http://localhost:8080/v1), " +
        "vLLM (http://localhost:8000/v1), LM Studio (http://localhost:1234/v1).",
    );
  }
  if (judgeProvider === "local-llm" && !judgeBaseUrl) {
    throw new Error(
      "ERROR: --judge-provider local-llm requires --judge-base-url. " +
        "Examples: llama.cpp (http://localhost:8080/v1), " +
        "vLLM (http://localhost:8000/v1), LM Studio (http://localhost:1234/v1).",
    );
  }
  if (
    systemCodexReasoningEffort !== undefined &&
    effectiveSystemProvider !== "codex-cli"
  ) {
    throw new Error(
      "ERROR: --system-codex-reasoning-effort requires --system-provider codex-cli (or --provider codex-cli).",
    );
  }
  if (
    systemResponderContextBudgetChars !== undefined &&
    effectiveSystemProvider === undefined
  ) {
    throw new Error(
      "ERROR: --system-responder-context-budget-chars requires --system-provider (or --provider).",
    );
  }
  if (
    systemResponderPromptBudgetChars !== undefined &&
    effectiveSystemProvider === undefined
  ) {
    throw new Error(
      "ERROR: --system-responder-prompt-budget-chars requires --system-provider (or --provider).",
    );
  }
  if (
    judgeCodexReasoningEffort !== undefined &&
    judgeProvider !== "codex-cli"
  ) {
    throw new Error(
      "ERROR: --judge-codex-reasoning-effort requires --judge-provider codex-cli.",
    );
  }
  if (internalProvider === "local-llm" && !internalBaseUrl) {
    throw new Error(
      "ERROR: --internal-provider local-llm requires --internal-base-url. " +
        "Examples: llama.cpp (http://localhost:8080/v1), " +
        "vLLM (http://localhost:8000/v1), LM Studio (http://localhost:1234/v1).",
    );
  }
  if (
    internalCodexReasoningEffort !== undefined &&
    internalProvider !== "codex-cli"
  ) {
    throw new Error(
      "ERROR: --internal-codex-reasoning-effort requires --internal-provider codex-cli.",
    );
  }
  const effectiveAmaBenchCrossJudgeProvider =
    amaBenchCrossJudgeProvider ?? judgeProvider;
  if (
    amaBenchCrossJudgeCodexReasoningEffort !== undefined &&
    effectiveAmaBenchCrossJudgeProvider !== "codex-cli"
  ) {
    throw new Error(
      "ERROR: --ama-bench-cross-judge-codex-reasoning-effort requires " +
        "--ama-bench-cross-judge-provider codex-cli (or --judge-provider codex-cli).",
    );
  }
  if (
    amaBenchCrossJudgeProvider === "local-llm" &&
    !(amaBenchCrossJudgeBaseUrl ?? judgeBaseUrl)
  ) {
    throw new Error(
      "ERROR: --ama-bench-cross-judge-provider local-llm requires " +
        "--ama-bench-cross-judge-base-url (or --judge-base-url).",
    );
  }
  if (
    (amaBenchCrossJudgeProvider !== undefined ||
      amaBenchCrossJudgeBaseUrl !== undefined ||
      amaBenchCrossJudgeApiKey !== undefined ||
      amaBenchCrossJudgeCodexReasoningEffort !== undefined) &&
    amaBenchCrossJudgeModel === undefined
  ) {
    throw new Error(
      "ERROR: --ama-bench-cross-judge-model is required when configuring an AMA-Bench cross judge.",
    );
  }

  const resume = args.includes("--resume");
  const retryFailed = args.includes("--retry-failed");
  if (resume && retryFailed) {
    throw new Error(
      "ERROR: --resume and --retry-failed are mutually exclusive. " +
        "Use --resume to skip completed benchmarks, or --retry-failed to only re-run failed ones.",
    );
  }

  return {
    action,
    benchmarks,
    quick: args.includes("--quick"),
    all: args.includes("--all"),
    json: args.includes("--json"),
    detail: args.includes("--detail"),
    adapter,
    mcpCommand,
    mcpArgs,
    mcpUrl,
    mcpToolMap,
    mcpDemo,
    datasetDir: datasetDir ? path.resolve(expandTilde(datasetDir)) : undefined,
    resultsDir: resultsDir ? path.resolve(expandTilde(resultsDir)) : undefined,
    baselinesDir: baselinesDir ? path.resolve(expandTilde(baselinesDir)) : undefined,
    runtimeProfile,
    matrixProfiles,
    remnicConfigPath: remnicConfigRaw ? path.resolve(expandTilde(remnicConfigRaw)) : undefined,
    openclawConfigPath: openclawConfigRaw ? path.resolve(expandTilde(openclawConfigRaw)) : undefined,
    modelSource,
    gatewayAgentId,
    fastGatewayAgentId,
    systemProvider: effectiveSystemProvider,
    systemModel: effectiveSystemModel,
    systemBaseUrl: effectiveSystemBaseUrl,
    systemApiKey,
    systemCodexReasoningEffort,
    systemResponderContextBudgetChars,
    systemResponderPromptBudgetChars,
    judgeProvider,
    judgeModel,
    judgeBaseUrl,
    judgeApiKey,
    judgeCodexReasoningEffort,
    internalProvider,
    internalModel,
    internalBaseUrl,
    internalApiKey,
    internalDisableThinking: args.includes("--internal-disable-thinking"),
    internalCodexReasoningEffort,
    threshold,
    custom: customRaw ? path.resolve(expandTilde(customRaw)) : undefined,
    baselineAction,
    datasetAction,
    providerAction,
    runAction,
    format,
    output: output ? path.resolve(expandTilde(output)) : undefined,
    target,
    publishedName,
    publishedSeed,
    publishedLimit,
    publishedTrialLimit,
    publishedTrialConcurrency,
    publishedIngestConcurrency,
    publishedTaskFilter,
    memcorrectAdapter,
    publishedOut: publishedOutRaw
      ? path.resolve(expandTilde(publishedOutRaw))
      : undefined,
    publishedDryRun: args.includes("--dry-run"),
    requestTimeout,
    localJudgeRequestTimeout,
    frontierJudgeRequestTimeout,
    calibrationDir: calibrationDirRaw ? path.resolve(expandTilde(calibrationDirRaw)) : undefined,
    calibrationLocalConfigSha256,
    calibrationFrontierConfigSha256,
    sourceResultId,
    expectedAnswerSetSha256,
    expectedQuestionIdListSha256,
    taskIdsFile: taskIdsFileRaw
      ? path.resolve(expandTilde(taskIdsFileRaw))
      : undefined,
    expectedTaskIdListSha256,
    drainTimeout,
    // Issue #1573 PR1: surface judge-cache flags into the runner options.
    noJudgeCache: args.includes("--no-judge-cache"),
    judgeCacheDir: judgeCacheDirRaw ? path.resolve(expandTilde(judgeCacheDirRaw)) : undefined,
    localLabManifestPath: localLabManifestRaw
      ? path.resolve(expandTilde(localLabManifestRaw))
      : undefined,
    max429WaitMs,
    disableThinking: args.includes("--disable-thinking"),
    amaBenchJudgeProtocol,
    amaBenchCrossJudgeProvider,
    amaBenchCrossJudgeModel,
    amaBenchCrossJudgeBaseUrl,
    amaBenchCrossJudgeApiKey,
    amaBenchCrossJudgeCodexReasoningEffort,
    resume,
    retryFailed,
    ...research,
    driftGenAction,
    driftGenDir,
  };
}
