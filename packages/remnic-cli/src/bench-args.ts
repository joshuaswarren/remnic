import path from "node:path";
import type { BuiltInProvider } from "@remnic/bench";
import { expandTilde } from "./path-utils.js";

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
  | "check"
  | "report";

export type BenchBaselineAction = "save" | "list";
export type BenchDatasetAction = "download" | "status";
export type BenchExportFormat = "json" | "csv" | "html";
export type BenchProviderAction = "discover";
export type BenchPublishTarget = "remnic-ai";
export type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain";
export type BenchModelSource = "plugin" | "gateway";
export type BenchRunAction = "list" | "show" | "delete";
export type AmaBenchJudgeProtocol = "default" | "recommended";
export type BenchCodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ParsedBenchArgs {
  action: BenchAction;
  benchmarks: string[];
  quick: boolean;
  all: boolean;
  json: boolean;
  detail: boolean;
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
  /** `bench published` — specific benchmark to run (longmemeval|locomo). */
  publishedName?: PublishedBenchmarkName;
  /** `bench published` — seed forwarded into the harness context. */
  publishedSeed?: number;
  /** `bench published` — item limit forwarded into the dataset loader. */
  publishedLimit?: number;
  /** `bench published` — published artifact output directory. */
  publishedOut?: string;
  /** `bench published` — dry-run: validate + load but do NOT call the model. */
  publishedDryRun?: boolean;
  /** Skip benchmarks that completed successfully in the previous run. */
  resume?: boolean;
  /** Only re-run benchmarks that failed in the previous run. */
  retryFailed?: boolean;
}

export type PublishedBenchmarkName = "longmemeval" | "locomo";
export const PUBLISHED_BENCHMARK_NAMES: readonly PublishedBenchmarkName[] =
  Object.freeze(["longmemeval", "locomo"]);

function isBenchRuntimeProfile(value: string): value is BenchRuntimeProfile {
  return (
    value === "baseline" ||
    value === "real" ||
    value === "openclaw-chain"
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
      'ERROR: --runtime-profile must be "baseline", "real", or "openclaw-chain".',
    );
  }

  throw new Error(
    'ERROR: --matrix must contain only "baseline", "real", or "openclaw-chain".',
  );
}

/**
 * Shared allow-list for `--provider`, `--system-provider`, and
 * `--judge-provider`. Keeping these in lockstep is a CLAUDE.md rule 52
 * concern: if one flag accepts "local-llm" but another rejects it,
 * behavior becomes path-dependent. Issue #566 slice 5 added
 * "local-llm"; Codex CLI provider wiring added "codex-cli". The
 * single source of truth is here.
 */
const BENCH_PROVIDER_ALLOWED: readonly BuiltInProvider[] = Object.freeze([
  "openai",
  "anthropic",
  "ollama",
  "litellm",
  "local-llm",
  "codex-cli",
]);

function isBuiltInProvider(value: string): value is BuiltInProvider {
  return (BENCH_PROVIDER_ALLOWED as readonly string[]).includes(value);
}

function parseBenchProvider(raw: string, flag: string): BuiltInProvider {
  if (!isBuiltInProvider(raw)) {
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

export function readBenchOptionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`ERROR: ${flag} requires a value.`);
  }

  return value;
}

export function collectBenchmarks(argv: string[]): string[] {
  const benchmarks: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--dataset-dir" ||
      arg === "--results-dir" ||
      arg === "--baselines-dir" ||
      arg === "--runtime-profile" ||
      arg === "--matrix" ||
      arg === "--remnic-config" ||
      arg === "--openclaw-config" ||
      arg === "--model-source" ||
      arg === "--gateway-agent-id" ||
      arg === "--fast-gateway-agent-id" ||
      arg === "--system-provider" ||
      arg === "--system-model" ||
      arg === "--system-base-url" ||
      arg === "--system-api-key" ||
      arg === "--system-codex-reasoning-effort" ||
      arg === "--judge-provider" ||
      arg === "--judge-model" ||
      arg === "--judge-base-url" ||
      arg === "--judge-api-key" ||
      arg === "--judge-codex-reasoning-effort" ||
      arg === "--internal-provider" ||
      arg === "--internal-model" ||
      arg === "--internal-base-url" ||
      arg === "--internal-api-key" ||
      arg === "--internal-codex-reasoning-effort" ||
      arg === "--threshold" ||
      arg === "--custom" ||
      arg === "--format" ||
      arg === "--output" ||
      arg === "--target" ||
      arg === "--name" ||
      arg === "--dataset" ||
      arg === "--model" ||
      arg === "--limit" ||
      arg === "--seed" ||
      arg === "--out" ||
      arg === "--provider" ||
      arg === "--base-url" ||
      arg === "--request-timeout" ||
      arg === "--max-429-wait" ||
      arg === "--ama-bench-judge-protocol" ||
      arg === "--ama-bench-cross-judge-provider" ||
      arg === "--ama-bench-cross-judge-model" ||
      arg === "--ama-bench-cross-judge-base-url" ||
      arg === "--ama-bench-cross-judge-api-key" ||
      arg === "--ama-bench-cross-judge-codex-reasoning-effort"
    ) {
      index += 1;
      continue;
    }
    if (arg === "--resume" || arg === "--retry-failed") {
      continue;
    }
    if (!arg.startsWith("-")) {
      benchmarks.push(arg);
    }
  }
  return benchmarks;
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
    first === "check" ||
    first === "report"
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

  const benchmarkArgs =
    action === "baseline" ||
    action === "datasets" ||
    action === "providers" ||
    action === "runs"
      ? args.slice(1)
      : args;
  const benchmarks = collectBenchmarks(benchmarkArgs);
  // `--dataset` is an alias for `--dataset-dir`. `--dataset-dir` wins
  // if both are supplied.
  const datasetDir =
    readBenchOptionValue(args, "--dataset-dir") ??
    readBenchOptionValue(args, "--dataset");
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
  const max429WaitRaw = readBenchOptionValue(args, "--max-429-wait");
  const amaBenchJudgeProtocolRaw = readBenchOptionValue(args, "--ama-bench-judge-protocol");
  const amaBenchCrossJudgeProviderRaw = readBenchOptionValue(args, "--ama-bench-cross-judge-provider");
  const amaBenchCrossJudgeModel = readBenchOptionValue(args, "--ama-bench-cross-judge-model");
  const amaBenchCrossJudgeBaseUrl = readBenchOptionValue(args, "--ama-bench-cross-judge-base-url");
  const amaBenchCrossJudgeApiKey = readBenchOptionValue(args, "--ama-bench-cross-judge-api-key");
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
        'ERROR: --matrix must contain one or more of "baseline", "real", or "openclaw-chain".',
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
    internalProvider = parseBenchProvider(internalProviderRaw, "--internal-provider");
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

  // `bench published` flags. Parsed unconditionally so `--name`, `--model`,
  // etc. raise consistent errors even when used outside the `published`
  // action (mirrors CLAUDE.md rule 14: validate flag args at input boundaries).
  const publishedNameRaw = readBenchOptionValue(args, "--name");
  const publishedModelRaw = readBenchOptionValue(args, "--model");
  const publishedLimitRaw = readBenchOptionValue(args, "--limit");
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
    publishedOut: publishedOutRaw
      ? path.resolve(expandTilde(publishedOutRaw))
      : undefined,
    publishedDryRun: args.includes("--dry-run"),
    requestTimeout,
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
  };
}
