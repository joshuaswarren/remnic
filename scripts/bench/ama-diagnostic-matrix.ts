#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchResponder,
  BenchRuntimeProfile,
  BuiltInProvider,
  AmaBenchDiagnosticMatrixArtifact,
  AmaBenchDiagnosticVariant,
  ProviderConfig,
  SanitizedDiagnosticProvider,
  ProviderFactoryConfig,
} from "@remnic/bench";

type BenchModule = typeof import("@remnic/bench");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

let buildAmaBenchDiagnosticMatrixArtifact: BenchModule["buildAmaBenchDiagnosticMatrixArtifact"];
let buildAmaBenchDiagnosticVariantSummary: BenchModule["buildAmaBenchDiagnosticVariantSummary"];
let createAmaBenchDiagnosticAdapter: BenchModule["createAmaBenchDiagnosticAdapter"];
let createLightweightAdapter: BenchModule["createLightweightAdapter"];
let createProviderBackedAmaBenchRecommendedJudge: BenchModule["createProviderBackedAmaBenchRecommendedJudge"];
let createProviderBackedResponder: BenchModule["createProviderBackedResponder"];
let createRemnicAdapter: BenchModule["createRemnicAdapter"];
let resolveBenchRuntimeProfile: BenchModule["resolveBenchRuntimeProfile"];
let runBenchmark: BenchModule["runBenchmark"];
let selectAmaBenchDiagnosticVariants: BenchModule["selectAmaBenchDiagnosticVariants"];
let expandTildePath: ((value: string) => string) | undefined;
let runtimeDepsLoaded = false;

const PROVIDERS: readonly BuiltInProvider[] = Object.freeze([
  "openai",
  "anthropic",
  "ollama",
  "litellm",
  "local-llm",
  "codex-cli",
]);

interface ParsedArgs {
  quick: boolean;
  datasetDir?: string;
  output?: string;
  limit?: number;
  seed?: number;
  runtimeProfile: BenchRuntimeProfile;
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: "plugin" | "gateway";
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  systemApiKey?: string;
  systemCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  judgeCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  internalProvider?: BuiltInProvider;
  internalModel?: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalDisableThinking: boolean;
  internalCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  strongSystemProvider?: BuiltInProvider;
  strongSystemModel?: string;
  strongSystemBaseUrl?: string;
  strongSystemApiKey?: string;
  strongSystemCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  strongDisableThinking: boolean;
  requestTimeout?: number;
  max429WaitMs?: number;
  disableThinking: boolean;
  amaBenchJudgeProtocol: "default" | "recommended";
  amaBenchCrossJudgeProvider?: BuiltInProvider;
  amaBenchCrossJudgeModel?: string;
  amaBenchCrossJudgeBaseUrl?: string;
  amaBenchCrossJudgeApiKey?: string;
  amaBenchCrossJudgeCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  variants?: string[];
  includeStrong: boolean;
}

interface MatrixRunResult {
  artifact: AmaBenchDiagnosticMatrixArtifact;
  outputPath?: string;
}

export async function runAmaBenchDiagnosticMatrix(
  parsed: ParsedArgs,
): Promise<MatrixRunResult> {
  await loadRuntimeDeps();
  validatePrimaryProviderConfigs(parsed);

  if (!parsed.quick && !parsed.datasetDir) {
    throw new Error(
      "AMA diagnostic matrix full mode requires --dataset-dir. Use --quick for the smoke fixture.",
    );
  }

  const strongResponder = createStrongResponder(parsed);
  const variants = selectAmaBenchDiagnosticVariants({
    ids: parsed.variants,
    includeStrong: parsed.includeStrong,
  });
  validateStrongVariants(variants, strongResponder);

  const runtime = await resolveBenchRuntimeProfile({
    runtimeProfile: parsed.runtimeProfile,
    remnicConfigPath: parsed.remnicConfigPath,
    openclawConfigPath: parsed.openclawConfigPath,
    modelSource: parsed.runtimeProfile === "real" ? parsed.modelSource : undefined,
    gatewayAgentId: parsed.gatewayAgentId,
    fastGatewayAgentId: parsed.fastGatewayAgentId,
    systemProvider:
      parsed.runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemProvider,
    systemModel:
      parsed.runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemModel,
    systemBaseUrl:
      parsed.runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemBaseUrl,
    systemApiKey:
      parsed.runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemApiKey,
    systemCodexReasoningEffort:
      parsed.runtimeProfile === "openclaw-chain"
        ? undefined
        : parsed.systemCodexReasoningEffort,
    judgeProvider: parsed.judgeProvider,
    judgeModel: parsed.judgeModel,
    judgeBaseUrl: parsed.judgeBaseUrl,
    judgeApiKey: parsed.judgeApiKey,
    judgeCodexReasoningEffort: parsed.judgeCodexReasoningEffort,
    internalProvider: parsed.internalProvider,
    internalModel: parsed.internalModel,
    internalBaseUrl: parsed.internalBaseUrl,
    internalApiKey: parsed.internalApiKey,
    internalDisableThinking: parsed.internalDisableThinking,
    internalCodexReasoningEffort: parsed.internalCodexReasoningEffort,
    requestTimeout: parsed.requestTimeout,
    max429WaitMs: parsed.max429WaitMs,
    disableThinking: parsed.disableThinking,
  });
  const primaryJudge = createPrimaryJudge(parsed, runtime.judgeProvider);
  const crossJudge = createCrossJudge(parsed, runtime.judgeProvider);
  const adapterMode = parsed.quick && runtime.profile === "baseline"
    ? "lightweight"
    : "direct";
  const summaries = [];

  for (const variant of variants) {
    process.stderr.write(`[ama-diagnostic] running ${variant.id}\n`);
    const adapterOptions = {
      ...runtime.adapterOptions,
      ...(primaryJudge ? { judge: primaryJudge } : {}),
    };
    const base = variant.recallMode === "oracle-trajectory"
      ? createOracleTrajectoryBaseAdapter(adapterOptions)
      : await createBaseAdapter(adapterMode, adapterOptions);
    const system = createAmaBenchDiagnosticAdapter(base, variant, {
      strongResponder,
    });

    try {
      const result = await runBenchmark("ama-bench", {
        mode: parsed.quick ? "quick" : "full",
        datasetDir: parsed.datasetDir,
        limit: parsed.limit,
        seed: parsed.seed,
        adapterMode,
        runtimeProfile: runtime.profile,
        systemProvider: runtime.systemProvider,
        judgeProvider: runtime.judgeProvider,
        internalProvider: runtime.internalProvider,
        remnicConfig: runtime.remnicConfig,
        amaBenchJudgeProtocol: parsed.amaBenchJudgeProtocol,
        ...(crossJudge.judge ? { amaBenchCrossJudge: crossJudge.judge } : {}),
        ...(crossJudge.provider
          ? { amaBenchCrossJudgeProvider: crossJudge.provider }
          : {}),
        system,
      });
      summaries.push(
        buildAmaBenchDiagnosticVariantSummary(variant, result, {
          runtimeProfile: runtime.profile,
          hasResponder: system.responder !== undefined,
        }),
      );
    } finally {
      await system.destroy();
    }
  }

  const artifact = buildAmaBenchDiagnosticMatrixArtifact({
    mode: parsed.quick ? "quick" : "full",
    config: {
      runtimeProfile: runtime.profile,
      adapterMode,
      datasetDir: parsed.datasetDir ? "[provided]" : undefined,
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
      systemProvider: sanitizeProvider(runtime.systemProvider),
      judgeProvider: sanitizeProvider(runtime.judgeProvider),
      internalProvider: sanitizeProvider(runtime.internalProvider),
      amaBenchCrossJudgeProvider: sanitizeProvider(crossJudge.provider),
      strongSystemProvider: sanitizeProvider(strongProviderConfig(parsed)),
      variantIds: variants.map((variant) => variant.id),
    },
    variants: summaries,
  });

  if (parsed.output) {
    const outputPath = path.resolve(parsed.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { artifact, outputPath };
  }

  return { artifact };
}

function createStrongResponder(parsed: ParsedArgs): BenchResponder | undefined {
  const config = strongProviderConfig(parsed);
  return config ? createProviderBackedResponder(asProviderFactoryConfig(config)) : undefined;
}

function createPrimaryJudge(
  parsed: ParsedArgs,
  judgeProvider: ProviderConfig | null,
): BenchJudge | undefined {
  if (parsed.amaBenchJudgeProtocol !== "recommended") {
    return undefined;
  }
  if (!judgeProvider) {
    throw new Error(
      "--ama-bench-judge-protocol recommended requires --judge-provider and --judge-model.",
    );
  }
  return createProviderBackedAmaBenchRecommendedJudge(
    asProviderFactoryConfig(judgeProvider),
  );
}

function createCrossJudge(
  parsed: ParsedArgs,
  primaryJudgeProvider: ProviderConfig | null,
): { judge?: BenchJudge; provider?: ProviderConfig } {
  const hasAnyCrossJudgeConfig =
    parsed.amaBenchCrossJudgeProvider !== undefined ||
    parsed.amaBenchCrossJudgeModel !== undefined ||
    parsed.amaBenchCrossJudgeBaseUrl !== undefined ||
    parsed.amaBenchCrossJudgeApiKey !== undefined ||
    parsed.amaBenchCrossJudgeCodexReasoningEffort !== undefined;
  if (!hasAnyCrossJudgeConfig) {
    return {};
  }
  if (!parsed.amaBenchCrossJudgeModel) {
    throw new Error(
      "Cross-judge config requires --ama-bench-cross-judge-model.",
    );
  }

  const provider = parsed.amaBenchCrossJudgeProvider ?? primaryJudgeProvider?.provider;
  if (!provider) {
    throw new Error(
      "--ama-bench-cross-judge-model requires --ama-bench-cross-judge-provider or --judge-provider.",
    );
  }
  const inheritPrimary =
    parsed.amaBenchCrossJudgeProvider === undefined ||
    parsed.amaBenchCrossJudgeProvider === primaryJudgeProvider?.provider;
  const baseUrl = parsed.amaBenchCrossJudgeBaseUrl ??
    (inheritPrimary ? primaryJudgeProvider?.baseUrl : undefined);
  const apiKey = parsed.amaBenchCrossJudgeApiKey ??
    (inheritPrimary ? primaryJudgeProvider?.apiKey : undefined);
  const reasoningEffort = parsed.amaBenchCrossJudgeCodexReasoningEffort ??
    (inheritPrimary ? primaryJudgeProvider?.reasoningEffort : undefined);

  const config: ProviderConfig = {
    provider,
    model: parsed.amaBenchCrossJudgeModel,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(inheritPrimary && primaryJudgeProvider?.retryOptions
      ? { retryOptions: primaryJudgeProvider.retryOptions }
      : {}),
    ...(inheritPrimary && primaryJudgeProvider?.disableThinking
      ? { disableThinking: primaryJudgeProvider.disableThinking }
      : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  if (config.provider === "local-llm" && !config.baseUrl) {
    throw new Error(
      "--ama-bench-cross-judge-provider local-llm requires --ama-bench-cross-judge-base-url or --judge-base-url.",
    );
  }
  if (reasoningEffort && config.provider !== "codex-cli") {
    throw new Error(
      "--ama-bench-cross-judge-codex-reasoning-effort requires " +
        "--ama-bench-cross-judge-provider codex-cli (or --judge-provider codex-cli).",
    );
  }

  return {
    judge: createProviderBackedAmaBenchRecommendedJudge(
      asProviderFactoryConfig(config),
    ),
    provider: config,
  };
}

async function createBaseAdapter(
  adapterMode: "lightweight" | "direct",
  options: Parameters<typeof createRemnicAdapter>[0],
): Promise<BenchMemoryAdapter> {
  return adapterMode === "lightweight"
    ? createLightweightAdapter(options)
    : createRemnicAdapter(options);
}

function createOracleTrajectoryBaseAdapter(
  options: Parameters<typeof createRemnicAdapter>[0],
): BenchMemoryAdapter {
  return {
    responder: options.responder,
    judge: options.judge,
    async store() {},
    async recall() {
      return "";
    },
    async search() {
      return [];
    },
    async reset() {},
    async getStats() {
      return {
        totalMessages: 0,
        totalSummaryNodes: 0,
        maxDepth: 0,
      };
    },
    async drain() {},
    async destroy() {},
  };
}

function validateStrongVariants(
  variants: readonly AmaBenchDiagnosticVariant[],
  strongResponder: BenchResponder | undefined,
): void {
  if (
    !strongResponder &&
    variants.some((variant) => variant.answererMode === "strong")
  ) {
    throw new Error(
      "Strong AMA diagnostic variants require --strong-system-provider and --strong-system-model.",
    );
  }
}

function validatePrimaryProviderConfigs(parsed: ParsedArgs): void {
  validateProviderFlagGroup("system", {
    provider: parsed.systemProvider,
    model: parsed.systemModel,
    baseUrl: parsed.systemBaseUrl,
    apiKey: parsed.systemApiKey,
    codexReasoningEffort: parsed.systemCodexReasoningEffort,
  });
  validateProviderFlagGroup("judge", {
    provider: parsed.judgeProvider,
    model: parsed.judgeModel,
    baseUrl: parsed.judgeBaseUrl,
    apiKey: parsed.judgeApiKey,
    codexReasoningEffort: parsed.judgeCodexReasoningEffort,
  });
  validateProviderFlagGroup("internal", {
    provider: parsed.internalProvider,
    model: parsed.internalModel,
    baseUrl: parsed.internalBaseUrl,
    apiKey: parsed.internalApiKey,
    codexReasoningEffort: parsed.internalCodexReasoningEffort,
  });
}

function validateProviderFlagGroup(
  label: "system" | "judge" | "internal" | "strong-system" | "ama-bench-cross-judge",
  config: {
    provider?: BuiltInProvider;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    codexReasoningEffort?: ProviderConfig["reasoningEffort"];
  },
): void {
  const hasAny =
    config.provider !== undefined ||
    config.model !== undefined ||
    config.baseUrl !== undefined ||
    config.apiKey !== undefined ||
    config.codexReasoningEffort !== undefined;
  if (!hasAny) {
    return;
  }
  if (!config.provider || !config.model) {
    throw new Error(
      `${label} provider config requires both --${label}-provider and --${label}-model.`,
    );
  }
  if (config.provider === "local-llm" && !config.baseUrl) {
    throw new Error(
      `--${label}-provider local-llm requires --${label}-base-url.`,
    );
  }
  if (
    config.codexReasoningEffort !== undefined &&
    config.provider !== "codex-cli"
  ) {
    throw new Error(
      `--${label}-codex-reasoning-effort requires --${label}-provider codex-cli.`,
    );
  }
}

function strongProviderConfig(parsed: ParsedArgs): ProviderConfig | undefined {
  const hasAny =
    parsed.strongSystemProvider !== undefined ||
    parsed.strongSystemModel !== undefined ||
    parsed.strongSystemBaseUrl !== undefined ||
    parsed.strongSystemApiKey !== undefined ||
    parsed.strongSystemCodexReasoningEffort !== undefined;
  if (!hasAny) {
    return undefined;
  }
  if (!parsed.strongSystemProvider || !parsed.strongSystemModel) {
    throw new Error(
      "Strong answerer config requires both --strong-system-provider and --strong-system-model.",
    );
  }
  if (parsed.strongSystemProvider === "local-llm" && !parsed.strongSystemBaseUrl) {
    throw new Error(
      "--strong-system-provider local-llm requires --strong-system-base-url.",
    );
  }
  if (
    parsed.strongSystemCodexReasoningEffort !== undefined &&
    parsed.strongSystemProvider !== "codex-cli"
  ) {
    throw new Error(
      "--strong-system-codex-reasoning-effort requires --strong-system-provider codex-cli.",
    );
  }

  return {
    provider: parsed.strongSystemProvider,
    model: parsed.strongSystemModel,
    ...(parsed.strongSystemBaseUrl ? { baseUrl: parsed.strongSystemBaseUrl } : {}),
    ...(parsed.strongSystemApiKey ? { apiKey: parsed.strongSystemApiKey } : {}),
    ...(parsed.requestTimeout !== undefined || parsed.max429WaitMs !== undefined
      ? {
          retryOptions: {
            ...(parsed.requestTimeout !== undefined
              ? { timeoutMs: parsed.requestTimeout }
              : {}),
            ...(parsed.max429WaitMs !== undefined
              ? { max429WaitMs: parsed.max429WaitMs }
              : {}),
          },
        }
      : {}),
    ...(parsed.strongDisableThinking ? { disableThinking: true } : {}),
    ...(parsed.strongSystemCodexReasoningEffort
      ? { reasoningEffort: parsed.strongSystemCodexReasoningEffort }
      : {}),
  };
}

function asProviderFactoryConfig(config: ProviderConfig): ProviderFactoryConfig {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.retryOptions ? { retryOptions: config.retryOptions } : {}),
    ...(config.disableThinking ? { disableThinking: config.disableThinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  } as ProviderFactoryConfig;
}

function sanitizeProvider(
  config: ProviderConfig | undefined | null,
): SanitizedDiagnosticProvider | null {
  if (!config) {
    return null;
  }
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    quick: false,
    runtimeProfile: "real",
    strongDisableThinking: false,
    disableThinking: false,
    internalDisableThinking: false,
    amaBenchJudgeProtocol: "default",
    includeStrong: false,
  };

  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--help":
      case "-h":
        throw new UsageRequested();
      case "--quick":
        parsed.quick = true;
        break;
      case "--dataset-dir":
      case "--dataset":
        parsed.datasetDir = resolveUserPath(takeValue(index, arg));
        index += 1;
        break;
      case "--output":
      case "--out":
        parsed.output = resolveUserPath(takeValue(index, arg));
        index += 1;
        break;
      case "--limit":
        parsed.limit = parseNonNegativeInteger(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--seed":
        parsed.seed = parseNonNegativeInteger(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--runtime-profile":
        parsed.runtimeProfile = parseRuntimeProfile(takeValue(index, arg));
        index += 1;
        break;
      case "--remnic-config":
        parsed.remnicConfigPath = resolveUserPath(takeValue(index, arg));
        index += 1;
        break;
      case "--openclaw-config":
        parsed.openclawConfigPath = resolveUserPath(takeValue(index, arg));
        index += 1;
        break;
      case "--model-source":
        parsed.modelSource = parseModelSource(takeValue(index, arg));
        index += 1;
        break;
      case "--gateway-agent-id":
        parsed.gatewayAgentId = takeValue(index, arg);
        index += 1;
        break;
      case "--fast-gateway-agent-id":
        parsed.fastGatewayAgentId = takeValue(index, arg);
        index += 1;
        break;
      case "--system-provider":
        parsed.systemProvider = parseProvider(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--system-model":
        parsed.systemModel = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--system-base-url":
        parsed.systemBaseUrl = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--system-api-key":
        parsed.systemApiKey = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--system-codex-reasoning-effort":
        parsed.systemCodexReasoningEffort = parseReasoningEffort(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--judge-provider":
        parsed.judgeProvider = parseProvider(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--judge-model":
        parsed.judgeModel = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--judge-base-url":
        parsed.judgeBaseUrl = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--judge-api-key":
        parsed.judgeApiKey = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--judge-codex-reasoning-effort":
        parsed.judgeCodexReasoningEffort = parseReasoningEffort(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--internal-provider":
        parsed.internalProvider = parseProvider(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--internal-model":
        parsed.internalModel = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--internal-base-url":
        parsed.internalBaseUrl = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--internal-api-key":
        parsed.internalApiKey = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--internal-disable-thinking":
        parsed.internalDisableThinking = true;
        break;
      case "--internal-codex-reasoning-effort":
        parsed.internalCodexReasoningEffort = parseReasoningEffort(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--strong-system-provider":
        parsed.strongSystemProvider = parseProvider(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--strong-system-model":
        parsed.strongSystemModel = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--strong-system-base-url":
        parsed.strongSystemBaseUrl = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--strong-system-api-key":
        parsed.strongSystemApiKey = parseNonEmptyValue(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--strong-system-codex-reasoning-effort":
        parsed.strongSystemCodexReasoningEffort = parseReasoningEffort(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--strong-disable-thinking":
        parsed.strongDisableThinking = true;
        break;
      case "--request-timeout":
        parsed.requestTimeout = parsePositiveInteger(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--max-429-wait":
        parsed.max429WaitMs = parseNonNegativeInteger(takeValue(index, arg), arg);
        index += 1;
        break;
      case "--disable-thinking":
        parsed.disableThinking = true;
        break;
      case "--ama-bench-judge-protocol":
        parsed.amaBenchJudgeProtocol = parseAmaProtocol(takeValue(index, arg));
        index += 1;
        break;
      case "--ama-bench-cross-judge-provider":
        parsed.amaBenchCrossJudgeProvider = parseProvider(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--ama-bench-cross-judge-model":
        parsed.amaBenchCrossJudgeModel = parseNonEmptyValue(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--ama-bench-cross-judge-base-url":
        parsed.amaBenchCrossJudgeBaseUrl = parseNonEmptyValue(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--ama-bench-cross-judge-api-key":
        parsed.amaBenchCrossJudgeApiKey = parseNonEmptyValue(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--ama-bench-cross-judge-codex-reasoning-effort":
        parsed.amaBenchCrossJudgeCodexReasoningEffort = parseReasoningEffort(
          takeValue(index, arg),
          arg,
        );
        index += 1;
        break;
      case "--variants":
        parsed.variants = takeValue(index, arg)
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (parsed.variants.length === 0) {
          throw new Error("--variants must include at least one variant id.");
        }
        index += 1;
        break;
      case "--include-strong":
        parsed.includeStrong = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function parseProvider(value: string, flag: string): BuiltInProvider {
  if ((PROVIDERS as readonly string[]).includes(value)) {
    return value as BuiltInProvider;
  }
  throw new Error(
    `${flag} must be one of ${PROVIDERS.map((provider) => `"${provider}"`).join(", ")}.`,
  );
}

function resolveUserPath(value: string): string {
  if (!expandTildePath) {
    throw new Error("AMA diagnostic matrix runtime dependencies were not loaded.");
  }
  return path.resolve(expandTildePath(value));
}

function parseRuntimeProfile(value: string): BenchRuntimeProfile {
  if (
    value === "baseline" ||
    value === "real" ||
    value === "openclaw-chain"
  ) {
    return value;
  }
  throw new Error(
    '--runtime-profile must be "baseline", "real", or "openclaw-chain".',
  );
}

function parseModelSource(value: string): "plugin" | "gateway" {
  if (value === "plugin" || value === "gateway") {
    return value;
  }
  throw new Error('--model-source must be "plugin" or "gateway".');
}

function parseAmaProtocol(value: string): "default" | "recommended" {
  if (value === "default" || value === "recommended") {
    return value;
  }
  throw new Error('--ama-bench-judge-protocol must be "default" or "recommended".');
}

function parseReasoningEffort(
  value: string,
  flag: string,
): NonNullable<ProviderConfig["reasoningEffort"]> {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(`${flag} must be "low", "medium", "high", or "xhigh".`);
}

function parseNonEmptyValue(value: string, flag: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${flag} must not be empty.`);
  }
  return value.trim();
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function printSummary(
  artifact: AmaBenchDiagnosticMatrixArtifact,
  stream: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  stream.write(`AMA-Bench diagnostic matrix (${artifact.mode})\n`);
  for (const summary of artifact.variants) {
    const preferredMetric =
      summary.scoreMeans.ama_bench_recommended_accuracy ??
      summary.scoreMeans.llm_judge ??
      summary.scoreMeans.f1;
    const metricText = preferredMetric === undefined
      ? "score=n/a"
      : `score=${preferredMetric.toFixed(4)}`;
    const processLabel = summary.isPrimaryFullSystemScore
      ? "primary-full-system"
      : summary.usesFullRemnicRecallProcess
        ? "full-remnic-recall-control"
        : "diagnostic-control";
    stream.write(
      `  ${summary.variant.id.padEnd(26)} ${processLabel} tasks=${summary.taskCount} ${metricText} unknown_like=${summary.unknownLikeRate.toFixed(4)}\n`,
    );
  }
}

function printUsage(): void {
  console.log(`Usage:
  pnpm exec tsx scripts/bench/ama-diagnostic-matrix.ts --dataset-dir <ama-bench-dir> [options]
  pnpm exec tsx scripts/bench/ama-diagnostic-matrix.ts --quick [options]

Core options:
  --output <path>                    Write sanitized matrix JSON. If omitted, JSON is printed to stdout.
  --limit <n>                        Limit episodes before expanding QA pairs.
  --seed <n>                         Record benchmark seed metadata.
  --runtime-profile <profile>        baseline, real, or openclaw-chain. Defaults to real.
  --remnic-config <path>             Remnic config for --runtime-profile real.
  --openclaw-config <path>           OpenClaw config for --runtime-profile openclaw-chain.
  --variants <ids>                   Comma-separated variant ids.

Normal answerer / judge:
  --system-provider <provider>       openai, anthropic, ollama, litellm, local-llm, or codex-cli.
  --system-model <model>
  --system-base-url <url>
  --system-codex-reasoning-effort <low|medium|high|xhigh>
  --judge-provider <provider>
  --judge-model <model>
  --judge-base-url <url>
  --judge-codex-reasoning-effort <low|medium|high|xhigh>
  --ama-bench-judge-protocol <default|recommended>
  --ama-bench-cross-judge-provider <provider>
  --ama-bench-cross-judge-model <model>
  --ama-bench-cross-judge-codex-reasoning-effort <low|medium|high|xhigh>

Remnic internal LLM:
  --internal-provider <provider>     Provider for Remnic extraction/summarization.
  --internal-model <model>
  --internal-base-url <url>
  --internal-api-key <key>
  --internal-disable-thinking
  --internal-codex-reasoning-effort <low|medium|high|xhigh>

Strong-answerer ablations:
  --strong-system-provider <provider>
  --strong-system-model <model>
  --strong-system-base-url <url>
  --strong-system-codex-reasoning-effort <low|medium|high|xhigh>
  --include-strong                   Include all strong variants when strong config is present.

Default variants:
  remnic-full-normal, explicit-only-normal, oracle-trajectory-normal

Primary full-system score:
  remnic-full-normal with --runtime-profile real and an isolated Remnic config.

Strong variants:
  remnic-full-strong, explicit-only-strong, oracle-trajectory-strong`);
}

class UsageRequested extends Error {}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

async function main(): Promise<void> {
  if (hasHelpFlag(process.argv.slice(2))) {
    printUsage();
    return;
  }

  await loadRuntimeDeps();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageRequested) {
      printUsage();
      return;
    }
    throw error;
  }

  const { artifact, outputPath } = await runAmaBenchDiagnosticMatrix(parsed);
  if (outputPath) {
    printSummary(artifact);
    console.log(`Matrix JSON: ${outputPath}`);
  } else {
    printSummary(artifact, process.stderr);
    console.log(JSON.stringify(artifact, null, 2));
  }
}

const directRunPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (directRunPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function loadRuntimeDeps(): Promise<void> {
  if (runtimeDepsLoaded) {
    return;
  }

  ensureRuntimeBuilds();
  const [benchModule, coreModule] = await Promise.all([
    import("@remnic/bench"),
    import("@remnic/core"),
  ]);

  buildAmaBenchDiagnosticMatrixArtifact =
    benchModule.buildAmaBenchDiagnosticMatrixArtifact;
  buildAmaBenchDiagnosticVariantSummary =
    benchModule.buildAmaBenchDiagnosticVariantSummary;
  createAmaBenchDiagnosticAdapter = benchModule.createAmaBenchDiagnosticAdapter;
  createLightweightAdapter = benchModule.createLightweightAdapter;
  createProviderBackedAmaBenchRecommendedJudge =
    benchModule.createProviderBackedAmaBenchRecommendedJudge;
  createProviderBackedResponder = benchModule.createProviderBackedResponder;
  createRemnicAdapter = benchModule.createRemnicAdapter;
  resolveBenchRuntimeProfile = benchModule.resolveBenchRuntimeProfile;
  runBenchmark = benchModule.runBenchmark;
  selectAmaBenchDiagnosticVariants = benchModule.selectAmaBenchDiagnosticVariants;
  expandTildePath = coreModule.expandTildePath;
  runtimeDepsLoaded = true;
}

function ensureRuntimeBuilds(): void {
  const coreDistPath = path.join(
    repoRoot,
    "packages",
    "remnic-core",
    "dist",
    "index.js",
  );
  if (!existsSync(coreDistPath)) {
    runPnpm(["--filter", "@remnic/core", "build"]);
  }

  const benchDistPath = path.join(
    repoRoot,
    "packages",
    "bench",
    "dist",
    "index.js",
  );
  const benchSourcePaths = [
    path.join(repoRoot, "packages", "bench", "src"),
    path.join(repoRoot, "packages", "bench", "package.json"),
    path.join(repoRoot, "packages", "bench", "tsup.config.ts"),
    path.join(repoRoot, "packages", "bench", "tsconfig.json"),
  ];
  if (!existsSync(benchDistPath) || isAnySourceNewerThan(benchSourcePaths, benchDistPath)) {
    runPnpm(["--filter", "@remnic/bench", "build"]);
  }
}

function runPnpm(args: string[]): void {
  const result = spawnSync(pnpmCmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed with exit ${result.status}.`);
  }
}

function isAnySourceNewerThan(sourcePaths: readonly string[], distPath: string): boolean {
  const distMtimeMs = statSync(distPath).mtimeMs;
  const newestSource = newestMtime(sourcePaths);
  return newestSource !== undefined && newestSource > distMtimeMs + 1_000;
}

function newestMtime(paths: readonly string[]): number | undefined {
  let newest: number | undefined;
  const visit = (entryPath: string): void => {
    if (!existsSync(entryPath)) {
      return;
    }
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      for (const child of readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (stat.isFile()) {
      newest = newest === undefined
        ? stat.mtimeMs
        : Math.max(newest, stat.mtimeMs);
    }
  };

  for (const sourcePath of paths) {
    visit(sourcePath);
  }
  return newest;
}
