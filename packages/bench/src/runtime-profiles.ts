import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  type FallbackLlmRuntimeContext,
  resolvePluginEntry,
  setCodexCliFallbackRunnerForProcess,
  type GatewayConfig,
  type CodexCliFallbackRunner,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchResponder,
} from "./adapters/types.js";
import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.js";
import {
  ASSISTANT_AGENT_CONFIG_KEY,
  ASSISTANT_JUDGE_CONFIG_KEY,
  buildAssistantResponderPrompt,
  finalizeAssistantOutput,
} from "./benchmarks/remnic/_assistant-common/default-agent.js";
import type { AssistantAgent } from "./benchmarks/remnic/_assistant-common/types.js";
import {
  createGatewayResponder,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
} from "./responders.js";
import type { ProviderFactoryConfig } from "./providers/types.js";
import { createProvider } from "./providers/factory.js";
import {
  DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL,
} from "./providers/openai-responses.js";
import { OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION } from "./judges/memcorrect-rubrics.js";
import { isSecretKey } from "./security/secret-keys.js";
import type { BenchRuntimeProfile, BuiltInProvider, ProviderConfig } from "./types.js";
import {
  loadLocalLabManifest,
  resolveLocalLabProfile,
  type ResolvedLocalLabProfile,
} from "./local-lab/index.js";
export type BenchModelSource = "plugin" | "gateway";

const OPENCLAW_REMNIC_PLUGIN_IDS = ["openclaw-remnic", "openclaw-engram"] as const;

function getOpenClawPluginEntries(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const entries =
    plugins && plugins["entries"] && typeof plugins["entries"] === "object" && !Array.isArray(plugins["entries"])
      ? (plugins["entries"] as Record<string, unknown>)
      : undefined;
  return entries;
}

function getOpenClawMemorySlotId(raw: Record<string, unknown>): string | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const slots =
    plugins && plugins["slots"] && typeof plugins["slots"] === "object" && !Array.isArray(plugins["slots"])
      ? (plugins["slots"] as Record<string, unknown>)
      : undefined;
  const slotId = slots?.["memory"];
  return typeof slotId === "string" ? slotId : undefined;
}

function resolveOpenClawRemnicPluginEntry(raw: unknown): Record<string, unknown> | undefined {
  return resolvePluginEntry(raw, {
    candidateIds: OPENCLAW_REMNIC_PLUGIN_IDS,
    getEntries: getOpenClawPluginEntries,
    getSlotId: getOpenClawMemorySlotId,
  });
}

export interface ResolveBenchRuntimeProfileOptions {
  runtimeProfile?: BenchRuntimeProfile;
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: BenchModelSource;
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  systemApiKey?: string;
  systemCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  systemResponderContextBudgetChars?: number;
  systemResponderPromptBudgetChars?: number;
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  judgeCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  internalProvider?: BuiltInProvider;
  internalModel?: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalDisableThinking?: boolean;
  internalCodexReasoningEffort?: ProviderConfig["reasoningEffort"];
  lcmObserveConcurrency?: number;
  requestTimeout?: number;
  drainTimeout?: number;
  max429WaitMs?: number;
  disableThinking?: boolean;
  /**
   * Path to a local-lab manifest JSON file (issue #1573 PR2). Required when
   * `runtimeProfile: "local-lab"`. For other profiles, an explicit manifest
   * binds the benchmark judge to the manifest's normalized judge config while
   * leaving the profile's responder unchanged. The manifest pins
   * provider/model/baseUrl/temperature/seed; runtime options are overlaid by
   * the same resolver used by `judge-calibrate`.
   */
  localLabManifestPath?: string;
}

export interface ResolvedBenchRuntimeProfile {
  profile: BenchRuntimeProfile;
  remnicConfig: Record<string, unknown>;
  effectiveRemnicConfig: Record<string, unknown>;
  adapterOptions: {
    configOverrides: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: BenchResponder;
    judge?: BenchJudge;
    drainTimeoutMs?: number;
  };
  systemProvider: ProviderConfig | null;
  judgeProvider: ProviderConfig | null;
  internalProvider: ProviderConfig | null;
  /**
   * Resolved local-lab profile (issue #1573 PR2). Present only when
   * `runtimeProfile: "local-lab"`. Drives sequential phase scheduling +
   * endpoint preflight in the bench runner.
   */
  localLab?: ResolvedLocalLabProfile;
}

const REDACTED_CONFIG_VALUE = "[redacted]";
const INTERNAL_GATEWAY_AGENT_ID = "remnic-bench-internal";
const DEFAULT_CODEX_CLI_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_CODEX_CLI_DRAIN_TIMEOUT_MS = 600_000;
let codexCliFallbackRegistered = false;
let codexCliFallbackChain: Promise<void> = Promise.resolve();

export async function resolveBenchRuntimeProfile(
  options: ResolveBenchRuntimeProfileOptions,
): Promise<ResolvedBenchRuntimeProfile> {
  const profile = options.runtimeProfile ?? "baseline";

  if (profile === "local-lab") {
    return resolveLocalLabRuntimeProfile(options);
  }

  const systemProvider = profile === "openclaw-chain"
    ? null
    : resolveProviderConfig(
      "system",
      options.systemProvider,
      options.systemModel,
      options.systemBaseUrl,
      options.requestTimeout,
      options.disableThinking,
      options.systemApiKey,
      options.max429WaitMs,
      options.systemCodexReasoningEffort,
      options.systemResponderContextBudgetChars,
      options.systemResponderPromptBudgetChars,
    );
  const explicitJudgeProvider = resolveProviderConfig(
    "judge",
    options.judgeProvider,
    options.judgeModel,
    options.judgeBaseUrl,
    options.requestTimeout,
    options.disableThinking,
      options.judgeApiKey,
      options.max429WaitMs,
      options.judgeCodexReasoningEffort,
      undefined,
      undefined,
    );
  const judgeProvider = options.localLabManifestPath
    ? await resolveManifestBoundJudgeProvider(
        options.localLabManifestPath,
        options,
        explicitJudgeProvider,
      )
    : explicitJudgeProvider;
  const internalProvider = applyInternalProviderDefaults(
    resolveProviderConfig(
      "internal",
      options.internalProvider,
      options.internalModel,
      options.internalBaseUrl,
      options.requestTimeout,
      options.internalDisableThinking,
      options.internalApiKey,
      options.max429WaitMs,
      options.internalCodexReasoningEffort,
      undefined,
      undefined,
    ),
  );
  const internalConfigOverrides = buildInternalRemnicConfigOverrides(
    internalProvider,
    { disableThinking: options.internalDisableThinking === true },
  );
  const lcmObserveConcurrencyOverrides =
    buildLcmObserveConcurrencyOverrides(options.lcmObserveConcurrency);
  const usesImplicitCodexRequestTimeout =
    options.requestTimeout === undefined &&
    [systemProvider, judgeProvider, internalProvider].some(
      (config) => config?.provider === "codex-cli",
    );
  const drainTimeoutMs = normalizeDrainTimeoutMs(
    options.drainTimeout ??
      options.requestTimeout ??
      (usesImplicitCodexRequestTimeout
        ? DEFAULT_CODEX_CLI_DRAIN_TIMEOUT_MS
        : undefined),
  );
  registerCodexCliFallbackRunnerIfNeeded(internalProvider);
  const responderFactoryConfig = systemProvider
    ? asProviderFactoryConfig(systemProvider)
    : undefined;
  const judgeFactoryConfig = judgeProvider
    ? asProviderFactoryConfig(judgeProvider)
    : undefined;
  const judge = judgeFactoryConfig
    ? createProviderBackedJudge(judgeFactoryConfig)
    : undefined;
  const structuredJudge = judgeFactoryConfig
    ? createProviderBackedStructuredJudge(judgeFactoryConfig)
    : undefined;

  if (profile === "baseline") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const baselineConfig = buildBenchBaselineRemnicConfig();
    const baselineWithInternalLlm = {
      ...baselineConfig,
      ...internalConfigOverrides,
      ...lcmObserveConcurrencyOverrides,
    };
    const effectiveRemnicConfig = withAssistantHooks(
      baselineWithInternalLlm,
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig: sanitizePersistedConfig(baselineWithInternalLlm),
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        responder,
        judge,
        ...(drainTimeoutMs ? { drainTimeoutMs } : {}),
      },
      systemProvider,
      judgeProvider: judgeProvider ? sanitizeProviderConfig(judgeProvider) : null,
      internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
    };
  }

  if (profile === "real") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const fileConfig = options.remnicConfigPath
      ? await loadRemnicConfigFile(options.remnicConfigPath)
      : {};
    const realProfileOverrides = {
      lcmEnabled: true,
      ...(options.modelSource ? { modelSource: options.modelSource } : {}),
      ...(options.gatewayAgentId ? { gatewayAgentId: options.gatewayAgentId } : {}),
      ...(options.fastGatewayAgentId
        ? { fastGatewayAgentId: options.fastGatewayAgentId }
        : {}),
      ...internalConfigOverrides,
      ...lcmObserveConcurrencyOverrides,
    };
    const persistedRemnicConfig = sanitizePersistedConfig({
      ...fileConfig,
      ...realProfileOverrides,
    });
    const effectiveRemnicConfig = withAssistantHooks(
      {
        ...fileConfig,
        ...realProfileOverrides,
      },
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig: persistedRemnicConfig,
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        preserveRuntimeDefaults: true,
        responder,
        judge,
        ...(drainTimeoutMs ? { drainTimeoutMs } : {}),
      },
      systemProvider,
      judgeProvider: judgeProvider ? sanitizeProviderConfig(judgeProvider) : null,
      internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
    };
  }

  const openclawRuntime = await loadOpenclawRuntimeConfig(options.openclawConfigPath);
  const gatewayConfig = openclawRuntime.gatewayConfig;
  const gatewayAgentId =
    options.gatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.gatewayAgentId);
  const fastGatewayAgentId =
    options.fastGatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.fastGatewayAgentId);
  const gatewayResponder = createGatewayResponder({
    gatewayConfig,
    agentId: gatewayAgentId,
    ...openclawRuntime.runtimeContext,
  });
  const persistedRemnicConfig = sanitizePersistedConfig(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig: openclawRuntime.persistedGatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
      ...internalConfigOverrides,
      ...lcmObserveConcurrencyOverrides,
    },
  );
  const effectiveRemnicConfig = withAssistantHooks(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
      ...internalConfigOverrides,
      ...lcmObserveConcurrencyOverrides,
    },
    gatewayResponder,
    structuredJudge,
  );

  return {
    profile,
    remnicConfig: persistedRemnicConfig,
    effectiveRemnicConfig,
    adapterOptions: {
      configOverrides: effectiveRemnicConfig,
      preserveRuntimeDefaults: true,
      responder: gatewayResponder,
      judge,
      ...(drainTimeoutMs ? { drainTimeoutMs } : {}),
    },
    systemProvider: null,
    judgeProvider: judgeProvider ? sanitizeProviderConfig(judgeProvider) : null,
    internalProvider: internalProvider ? sanitizeProviderConfig(internalProvider) : null,
  };
}

async function loadRemnicConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  const parsed = await loadJsonObject(filePath, "Remnic config");
  const remnic = parsed.remnic;
  if (isPlainObject(remnic)) {
    return { ...remnic };
  }
  const engram = parsed.engram;
  if (isPlainObject(engram)) {
    return { ...engram };
  }
  return parsed;
}

async function loadOpenclawRuntimeConfig(
  filePath: string | undefined,
): Promise<{
  remnicConfig: Record<string, unknown>;
  gatewayConfig: GatewayConfig;
  persistedGatewayConfig: GatewayConfig;
  runtimeContext: FallbackLlmRuntimeContext;
}> {
  if (!filePath) {
    throw new Error("openclaw-chain runtime profile requires an OpenClaw config path");
  }

  const parsed = await loadJsonObject(filePath, "OpenClaw config");
  const entry = resolveOpenClawRemnicPluginEntry(parsed);
  const remnicConfig =
    isPlainObject(entry?.config) ? { ...entry.config } : {};

  const gatewayConfig: GatewayConfig = {
    ...(isPlainObject(parsed.agents) ? { agents: parsed.agents as GatewayConfig["agents"] } : {}),
    ...(isPlainObject(parsed.models) ? { models: parsed.models as GatewayConfig["models"] } : {}),
  };

  return {
    remnicConfig,
    gatewayConfig,
    persistedGatewayConfig: sanitizeGatewayConfig(gatewayConfig),
    runtimeContext: deriveOpenclawRuntimeContext(filePath),
  };
}

export function deriveOpenclawRuntimeContext(
  configPath: string,
): FallbackLlmRuntimeContext {
  const rootDir = path.dirname(path.resolve(configPath));
  return {
    agentDir: path.join(rootDir, "agents", "main", "agent"),
    workspaceDir: path.join(rootDir, "workspace"),
  };
}

async function loadJsonObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} at ${filePath} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} at ${filePath} must be a JSON object`);
  }

  return parsed;
}

function resolveProviderConfig(
  kind: "system" | "judge" | "internal",
  provider: BuiltInProvider | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
  requestTimeout?: number,
  disableThinking?: boolean,
  apiKey?: string,
  max429WaitMs?: number,
  reasoningEffort?: ProviderConfig["reasoningEffort"],
  responderContextBudgetChars?: number,
  responderPromptBudgetChars?: number,
): ProviderConfig | null {
  const hasProvider = typeof provider === "string";
  const defaultOpenAiJudgeModel =
    kind === "judge" && provider === "openai" && model === undefined
      ? DEFAULT_OPENAI_RESPONSES_JUDGE_MODEL
      : undefined;
  const resolvedModel = defaultOpenAiJudgeModel ?? model;
  const hasModel = typeof resolvedModel === "string" && resolvedModel.trim().length > 0;
  const hasBaseUrl = typeof baseUrl === "string" && baseUrl.trim().length > 0;
  const hasApiKey = typeof apiKey === "string" && apiKey.trim().length > 0;
  const hasReasoningEffort = reasoningEffort !== undefined;
  const hasResponderContextBudget = responderContextBudgetChars !== undefined;
  const hasResponderPromptBudget = responderPromptBudgetChars !== undefined;

  if (
    !hasProvider &&
    !hasModel &&
    !hasBaseUrl &&
    !hasApiKey &&
    !hasReasoningEffort &&
    !hasResponderContextBudget &&
    !hasResponderPromptBudget
  ) {
    return null;
  }

  if (!hasProvider || !hasModel) {
    throw new Error(`${kind} provider requires both provider and model`);
  }

  // Issue #566 slice 5 — defense in depth: the CLI rejects
  // `--provider local-llm` without `--base-url`, but programmatic
  // callers that bypass the CLI must also get a clear error rather
  // than silently falling through to an OpenAI default URL in the
  // provider factory.
  if (provider === "local-llm" && !hasBaseUrl) {
    throw new Error(
      `${kind} provider "local-llm" requires a baseUrl ` +
        "(e.g. http://localhost:8080/v1 for llama.cpp).",
    );
  }
  // PR #1735 review: defense in depth for programmatic callers that bypass
  // the CLI's `--internal-provider` allow-list (see bench-args.ts). Unlike
  // "codex-cli" / "anthropic", `@remnic/core`'s gateway has no `claude-cli`
  // api wiring — routing the internal Remnic-runtime LLM through it would
  // silently fall through to the generic/OpenAI-compatible gateway path
  // instead of actually invoking `claude -p`. `claude-cli` is only wired
  // for the bench responder/judge factory path (--provider / --system-
  // provider / --judge-provider), not this internal-LLM path.
  if (kind === "internal" && provider === "claude-cli") {
    throw new Error(
      `${kind} provider "claude-cli" is not supported: it has no @remnic/core ` +
        "gateway wiring and is only available via --provider, --system-provider, " +
        "or --judge-provider.",
    );
  }
  if (reasoningEffort !== undefined && provider !== "codex-cli") {
    throw new Error(
      `${kind} Codex reasoning effort requires provider "codex-cli"`,
    );
  }

  // A Codex CLI completion is a subprocess-backed model turn, including for
  // Remnic's fast gateway tier. Without a provider timeout, that tier inherits
  // core's intentional 15-second local-fast default, which is too short for a
  // normal Codex turn and can terminate it after dispatch. Keep this default
  // benchmark-specific and transport-only so core's host-agnostic fast-tier
  // contract and the harness's store/recall/reset phase guards are unchanged.
  const providerRequestTimeoutMs =
    requestTimeout === undefined && provider === "codex-cli"
      ? DEFAULT_CODEX_CLI_REQUEST_TIMEOUT_MS
      : undefined;

  return {
    provider,
    model: resolvedModel!.trim(),
    ...(kind === "judge" && provider === "openai"
      ? { rubricVersion: OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION }
      : {}),
    ...(hasBaseUrl ? { baseUrl: baseUrl!.trim() } : {}),
    ...(hasApiKey ? { apiKey: apiKey!.trim() } : {}),
    ...(requestTimeout != null || max429WaitMs != null
      ? { retryOptions: {
          ...(requestTimeout != null ? { timeoutMs: requestTimeout } : {}),
          ...(max429WaitMs != null ? { max429WaitMs } : {}),
        } }
      : {}),
    ...(providerRequestTimeoutMs !== undefined ? { providerRequestTimeoutMs } : {}),
    ...(disableThinking ? { disableThinking: true } : {}),
    ...(provider === "codex-cli" ? { reasoningEffort: reasoningEffort ?? "xhigh" } : {}),
    ...(responderContextBudgetChars !== undefined
      ? { responderContextBudgetChars }
      : {}),
    ...(responderPromptBudgetChars !== undefined
      ? { responderPromptBudgetChars }
      : {}),
  };
}

function normalizeDrainTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `benchmark drain timeout must be a positive integer; received ${value}`,
    );
  }
  return value;
}

function buildLcmObserveConcurrencyOverrides(
  value: number | undefined,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || value <= 0 || value > 64) {
    throw new Error(
      `benchmark LCM observe concurrency must be an integer from 1 to 64; received ${value}`,
    );
  }
  return { lcmObserveConcurrency: value };
}

function applyInternalProviderDefaults(
  config: ProviderConfig | null,
): ProviderConfig | null {
  if (!config || config.baseUrl) {
    return config;
  }

  const baseUrl = defaultInternalBaseUrl(config.provider);
  return baseUrl ? { ...config, baseUrl } : config;
}

function buildInternalRemnicConfigOverrides(
  config: ProviderConfig | null,
  options: { disableThinking: boolean },
): Record<string, unknown> {
  const thinkingOverrides = options.disableThinking
    ? {
        localLlmDisableThinking: true,
        reasoningEffort: "none",
      }
    : {};

  if (!config) {
    return thinkingOverrides;
  }

  if (config.provider === "local-llm") {
    return {
      ...thinkingOverrides,
      modelSource: "plugin",
      localLlmEnabled: true,
      localLlmFallback: false,
      localLlmUrl: config.baseUrl,
      localLlmModel: config.model,
      ...(config.apiKey ? { localLlmApiKey: config.apiKey } : {}),
      ...(config.retryOptions?.timeoutMs
        ? { localLlmTimeoutMs: config.retryOptions.timeoutMs }
        : {}),
    };
  }

  const providerTimeoutMs =
    config.retryOptions?.timeoutMs ?? config.providerRequestTimeoutMs;

  return {
    ...thinkingOverrides,
    modelSource: "gateway",
    localLlmEnabled: false,
    ...(providerTimeoutMs
      ? {
          localLlmTimeoutMs: providerTimeoutMs,
          localLlmFastTimeoutMs: providerTimeoutMs,
        }
      : {}),
    gatewayConfig: buildInternalGatewayConfig(config, options),
    gatewayAgentId: INTERNAL_GATEWAY_AGENT_ID,
    fastGatewayAgentId: INTERNAL_GATEWAY_AGENT_ID,
  };
}

function buildInternalGatewayConfig(
  config: ProviderConfig,
  options: { disableThinking: boolean },
): GatewayConfig {
  const providerId = INTERNAL_GATEWAY_AGENT_ID;
  const modelRef = `${providerId}/${config.model}`;
  const timeoutMs =
    config.retryOptions?.timeoutMs ?? config.providerRequestTimeoutMs;

  return {
    agents: {
      defaults: {
        model: { primary: modelRef },
        ...(options.disableThinking ? { thinking: { mode: "off" as const } } : {}),
      },
      list: [
        {
          id: INTERNAL_GATEWAY_AGENT_ID,
          name: "Remnic bench internal provider",
          model: { primary: modelRef },
        },
      ],
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl: config.baseUrl ?? defaultInternalBaseUrl(config.provider) ?? "",
          api: gatewayProviderApi(config.provider),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.disableThinking || options.disableThinking ? { disableThinking: true } : {}),
          ...(config.reasoningEffort ? { codexCliReasoningEffort: config.reasoningEffort } : {}),
          ...(timeoutMs ? { retryOptions: { timeoutMs } } : {}),
          models: [{ id: config.model, name: config.model }],
        },
      },
    },
  };
}

function gatewayProviderApi(provider: BuiltInProvider): string {
  if (provider === "anthropic") {
    return "anthropic-messages";
  }
  if (provider === "codex-cli") {
    return "codex-cli";
  }
  if (provider === "claude-cli") {
    // PR #1735 review: `@remnic/core` only special-cases `api ===
    // "codex-cli"` and `api === "anthropic-messages"` — there is no
    // `claude-cli` gateway integration, so this must never be reached.
    // `resolveProviderConfig` (kind === "internal") already rejects
    // `claude-cli` before a config gets here; this is a second guard so a
    // future caller of this function directly can't silently regress to
    // the old "falls through to openai-completions" behavior.
    throw new Error(
      "claude-cli has no @remnic/core gateway api mapping; it is only supported as a " +
        "--provider / --system-provider / --judge-provider, not an internal provider.",
    );
  }
  if (provider === "ollama") {
    return "ollama-chat";
  }
  if (provider === "openai") {
    return "openai-responses";
  }
  return "openai-completions";
}

function defaultInternalBaseUrl(provider: BuiltInProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "litellm":
      return "http://localhost:4000";
    case "ollama":
      return "http://localhost:11434/api";
    case "codex-cli":
      return "codex-cli://local";
    case "claude-cli":
      // PR #1735 review: no internal gateway wiring for claude-cli (see
      // gatewayProviderApi above) — never hand back a fake base URL for it.
      throw new Error(
        "claude-cli has no internal-provider base URL; it is only supported as a " +
          "--provider / --system-provider / --judge-provider, not an internal provider.",
      );
    case "local-llm":
      return undefined;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function sanitizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    ...(config.apiKey ? { apiKey: REDACTED_CONFIG_VALUE } : {}),
  };
}

/**
 * Apply the runtime options that the manifest cannot express onto a
 * local-lab ProviderConfig. The manifest pins provider/model/baseUrl/
 * temperature/seed; the CLI/runtime flags (`--request-timeout`,
 * `--max-429-wait`, `--disable-thinking`) layer on top so a local-lab run
 * honours the same timeout + thinking-suppression contract as every other
 * profile (cursor review, issue #1573 PR2).
 *
 * Returns the config unchanged when none of the three options are set, so
 * the common case (manifest-only) stays free of empty retryOptions.
 */
function applyLocalLabRuntimeOptions(
  config: ProviderConfig,
  options: Pick<ResolveBenchRuntimeProfileOptions, "requestTimeout" | "max429WaitMs" | "disableThinking">,
): ProviderConfig {
  const requestTimeout = options.requestTimeout;
  const max429WaitMs = options.max429WaitMs;
  const disableThinking = options.disableThinking;
  const hasRetry = requestTimeout != null || max429WaitMs != null;
  if (!hasRetry && !disableThinking) {
    return config;
  }
  return {
    ...config,
    ...(hasRetry
      ? {
          retryOptions: {
            ...(requestTimeout != null ? { timeoutMs: requestTimeout } : {}),
            ...(max429WaitMs != null ? { max429WaitMs } : {}),
          },
        }
      : {}),
    ...(disableThinking ? { disableThinking: true } : {}),
  };
}

/**
 * Resolve the local judge configuration that is shared by calibration and
 * benchmark execution. Keeping manifest normalization and runtime overlays in
 * one path prevents the persisted calibration hash from describing a subtly
 * different judge (for example, a bare Ollama URL without temperature/seed).
 */
export async function resolveLocalLabJudgeProviderConfig(
  options: Pick<
    ResolveBenchRuntimeProfileOptions,
    "requestTimeout" | "max429WaitMs" | "disableThinking"
  > & { localLabManifestPath: string },
): Promise<ProviderConfig> {
  const manifest = await loadLocalLabManifest(options.localLabManifestPath);
  const resolved = resolveLocalLabProfile(manifest);
  return buildLocalLabJudgeProviderConfig(resolved, options);
}

function buildLocalLabJudgeProviderConfig(
  resolved: ResolvedLocalLabProfile,
  options: Pick<
    ResolveBenchRuntimeProfileOptions,
    "requestTimeout" | "max429WaitMs" | "disableThinking"
  >,
): ProviderConfig {
  return applyLocalLabRuntimeOptions(
    sanitizeProviderConfig(resolved.judge.providerConfig),
    options,
  );
}

async function resolveManifestBoundJudgeProvider(
  localLabManifestPath: string,
  options: ResolveBenchRuntimeProfileOptions,
  explicitJudgeProvider: ProviderConfig | null,
): Promise<ProviderConfig> {
  const manifestJudge = await resolveLocalLabJudgeProviderConfig({
    localLabManifestPath,
    requestTimeout: options.requestTimeout,
    max429WaitMs: options.max429WaitMs,
    disableThinking: options.disableThinking,
  });
  if (explicitJudgeProvider) {
    assertManifestJudgeIdentity(explicitJudgeProvider, manifestJudge);
  }
  return manifestJudge;
}

function assertManifestJudgeIdentity(
  explicitJudge: ProviderConfig,
  manifestJudge: ProviderConfig,
): void {
  if (
    explicitJudge.provider !== manifestJudge.provider ||
    explicitJudge.model !== manifestJudge.model
  ) {
    throw new Error(
      "judge provider/model flags do not match the local-lab manifest judge: " +
        `flags=${explicitJudge.provider}/${explicitJudge.model}, ` +
        `manifest=${manifestJudge.provider}/${manifestJudge.model}`,
    );
  }
  if (
    explicitJudge.baseUrl !== undefined &&
    normalizeProviderBaseUrl(explicitJudge.provider, explicitJudge.baseUrl) !==
      manifestJudge.baseUrl
  ) {
    throw new Error(
      "judge baseUrl flag does not match the normalized local-lab manifest judge: " +
        `flags=${normalizeProviderBaseUrl(explicitJudge.provider, explicitJudge.baseUrl)}, ` +
        `manifest=${String(manifestJudge.baseUrl)}`,
    );
  }
  if (explicitJudge.apiKey !== undefined) {
    throw new Error(
      "manifest-bound local judge does not accept --judge-api-key; keep local endpoint credentials out of the persisted manifest/hash contract",
    );
  }
}

function normalizeProviderBaseUrl(
  provider: BuiltInProvider,
  rawBaseUrl: string,
): string {
  const trimmed = rawBaseUrl.trim().endsWith("/")
    ? rawBaseUrl.trim().slice(0, -1)
    : rawBaseUrl.trim();
  if (provider === "ollama" && !trimmed.endsWith("/api")) {
    return `${trimmed}/api`;
  }
  if (provider === "local-llm" && !trimmed.endsWith("/v1")) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

function registerCodexCliFallbackRunnerIfNeeded(config: ProviderConfig | null): void {
  if (!config || config.provider !== "codex-cli" || codexCliFallbackRegistered) {
    return;
  }

  const runner: CodexCliFallbackRunner = async (request) =>
    enqueueCodexCliFallback(async () => {
      if (request.options.signal?.aborted) {
        throw abortReason(request.options.signal);
      }
      const reasoningEffort = asCodexReasoningEffort(
        request.config.codexCliReasoningEffort ?? request.config.reasoningEffort,
      );
      const provider = createProvider({
        provider: "codex-cli",
        model: request.modelId,
        ...(typeof request.config.apiKey === "string"
          ? { apiKey: request.config.apiKey }
          : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(typeof request.config.codexCliExecutable === "string"
          ? { executable: request.config.codexCliExecutable }
          : typeof request.config.executable === "string"
            ? { executable: request.config.executable }
            : {}),
        ...(typeof request.config.retryOptions?.timeoutMs === "number" ||
          typeof request.options.timeoutMs === "number"
          ? {
              retryOptions: {
                timeoutMs:
                  typeof request.config.retryOptions?.timeoutMs === "number"
                    ? request.config.retryOptions.timeoutMs
                    : request.options.timeoutMs,
              },
            }
          : {}),
      });
      const split = splitCodexFallbackMessages(request.messages);
      const completion = await provider.complete(split.prompt, {
        systemPrompt: split.systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
        signal: request.options.signal,
      });
      return {
        content: completion.text,
        usage: {
          inputTokens: completion.tokens.input,
          outputTokens: completion.tokens.output,
          totalTokens: completion.tokens.input + completion.tokens.output,
        },
      };
    });

  setCodexCliFallbackRunnerForProcess(runner);
  codexCliFallbackRegistered = true;
}

function enqueueCodexCliFallback<T>(task: () => Promise<T>): Promise<T> {
  const run = codexCliFallbackChain.then(task, task);
  codexCliFallbackChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("codex-cli fallback aborted");
}

function asCodexReasoningEffort(
  value: unknown,
): ProviderConfig["reasoningEffort"] | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function splitCodexFallbackMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): { systemPrompt?: string; prompt: string } {
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const prompt = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n")
    .trim();
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    prompt: prompt || messages.map((message) => message.content).join("\n\n"),
  };
}

function withAssistantHooks(
  config: Record<string, unknown>,
  responder: BenchResponder | undefined,
  structuredJudge: ReturnType<typeof createProviderBackedStructuredJudge> | undefined,
): Record<string, unknown> {
  const next = { ...config };

  if (responder) {
    next[ASSISTANT_AGENT_CONFIG_KEY] = createAssistantAgentFromResponder(responder);
  }
  if (structuredJudge) {
    next[ASSISTANT_JUDGE_CONFIG_KEY] = structuredJudge;
  }

  return next;
}

export function createAssistantAgentFromResponder(
  responder: BenchResponder,
): AssistantAgent {
  return {
    async respond(request) {
      const response = await responder.respond(
        buildAssistantResponderPrompt(request.prompt),
        request.memoryView,
      );
      return finalizeAssistantOutput(request, response.text);
    },
  };
}

function asProviderFactoryConfig(config: ProviderConfig): ProviderFactoryConfig {
  const retryOptions =
    config.retryOptions || config.providerRequestTimeoutMs !== undefined
      ? {
          ...config.retryOptions,
          ...(config.retryOptions?.timeoutMs === undefined &&
          config.providerRequestTimeoutMs !== undefined
            ? { timeoutMs: config.providerRequestTimeoutMs }
            : {}),
        }
      : undefined;
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(retryOptions ? { retryOptions } : {}),
    ...(config.disableThinking ? { disableThinking: config.disableThinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.responderContextBudgetChars !== undefined
      ? { responderContextBudgetChars: config.responderContextBudgetChars }
      : {}),
    ...(config.responderPromptBudgetChars !== undefined
      ? { responderPromptBudgetChars: config.responderPromptBudgetChars }
      : {}),
    ...(config.rubricVersion !== undefined
      ? { rubricVersion: config.rubricVersion }
      : {}),
  } as ProviderFactoryConfig;
}

export const __runtimeProfilesTestHooks = {
  asProviderFactoryConfig,
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sanitizeGatewayConfig(config: GatewayConfig): GatewayConfig {
  const sanitized = sanitizePersistedConfig(config);
  return isPlainObject(sanitized) ? sanitized as GatewayConfig : {};
}

function sanitizePersistedConfig(config: unknown): Record<string, unknown> {
  const sanitized = sanitizePersistedValue(config);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePersistedValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      next[key] = REDACTED_CONFIG_VALUE;
      continue;
    }
    next[key] = sanitizePersistedValue(entry);
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/**
 * Resolve a `local-lab` runtime profile (issue #1573 PR2) into the bench
 * runtime profile structure. Loads + validates the manifest, then maps the
 * manifest's responder/judge roles into the existing system/judge provider
 * slots so the bench runner can drive them without a CLI flag rewrite. The
 * full resolved profile (with embedding + hand-off notes) is also returned
 * under `localLab` for the sequential phase scheduler.
 *
 * Embedding is intentionally NOT aliased onto `internalProvider`: the
 * existing `internalProvider` slot describes Remnic's internal LLM calls
 * (extraction, summarization), not embedding. Wiring embedding into the
 * runtime path is a separate follow-up; this PR exposes it only via
 * `localLab.embedding`.
 */
async function resolveLocalLabRuntimeProfile(
  options: ResolveBenchRuntimeProfileOptions,
): Promise<ResolvedBenchRuntimeProfile> {
  if (!options.localLabManifestPath) {
    throw new Error(
      'local-lab runtime profile requires localLabManifestPath pointing at a manifest JSON file (issue #1573 PR2)',
    );
  }
  const manifest = await loadLocalLabManifest(options.localLabManifestPath);
  const resolved = resolveLocalLabProfile(manifest);
  const drainTimeoutMs = normalizeDrainTimeoutMs(
    options.drainTimeout ?? options.requestTimeout,
  );
  const systemProvider = applyLocalLabRuntimeOptions(
    sanitizeProviderConfig(resolved.responder.providerConfig),
    options,
  );
  const judgeProvider = buildLocalLabJudgeProviderConfig(resolved, options);
  const judgeFactoryConfig = judgeProvider
    ? asProviderFactoryConfig(judgeProvider)
    : undefined;
  const judge = judgeFactoryConfig
    ? createProviderBackedJudge(judgeFactoryConfig)
    : undefined;
  const structuredJudge = judgeFactoryConfig
    ? createProviderBackedStructuredJudge(judgeFactoryConfig)
    : undefined;
  const responderFactoryConfig = systemProvider
    ? asProviderFactoryConfig(systemProvider)
    : undefined;
  const responder = responderFactoryConfig
    ? createProviderBackedResponder(responderFactoryConfig)
    : undefined;
  const lcmObserveConcurrencyOverrides =
    buildLcmObserveConcurrencyOverrides(options.lcmObserveConcurrency);
  const baselineConfig = buildBenchBaselineRemnicConfig();
  const localLabRemnicConfig = {
    ...baselineConfig,
    ...lcmObserveConcurrencyOverrides,
  };
  const effectiveRemnicConfig = withAssistantHooks(
    localLabRemnicConfig,
    responder,
    structuredJudge,
  );
  return {
    profile: "local-lab",
    remnicConfig: sanitizePersistedConfig(localLabRemnicConfig),
    effectiveRemnicConfig,
    adapterOptions: {
      configOverrides: effectiveRemnicConfig,
      responder,
      judge,
      ...(drainTimeoutMs ? { drainTimeoutMs } : {}),
    },
    systemProvider,
    judgeProvider,
    internalProvider: null,
    localLab: resolved,
  };
}
