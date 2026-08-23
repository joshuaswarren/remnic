import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CodexCompactionFlushMode,
  CodingModeConfig,
  CodexCompatConfig,
  DreamingConfig,
  DreamsLightSleepConfig,
  DreamsRemConfig,
  DreamsDeepSleepConfig,
  DreamsPhasesConfig,
  ProceduralConfig,
  HeartbeatConfig,
  IdentityInjectionMode,
  MemoryOsPresetName,
  AgentPersonaModelConfig,
  PluginConfig,
  PrincipalRule,
  RecallPipelineConfig,
  RecallSectionConfig,
  ReasoningEffort,
  SemanticChunkingConfigShape,
  SessionObserverBandConfig,
  SlotBehaviorConfig,
  SlotMismatchMode,
  TriggerMode,
  TrustWeights,
} from "./types.js";
import { parseConvergeConfig } from "./converge-config.js";
import { parseExternalWikiRecallGuard } from "./external-wiki-guard.js";
import { log } from "./logger.js";
import { cloneDefaultSessionObserverBands } from "./session-observer-bands.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { normalizeEntitySchemas } from "./entity-schema.js";
import { expandTildePath } from "./utils/path.js";
// Finding 4 (#394): use the shared coerce helper instead of inlining the same
// boolean-coercion logic that connectors/index.ts already exports. The helper
// lives in connectors/coerce.ts (a tiny, dependency-free module) so neither
// config.ts → connectors/index.ts nor the reverse circular import arises.
import { coerceBool, coerceBooleanLike, coerceInstallExtension, coerceNumber } from "./connectors/coerce.js";
import { parseSubjectRuntimeConfig } from "./subject-config.js";
import { parseRecallConcurrencyConfig } from "./recall-concurrency-config.js";
import { parseExtractionLivenessConfig } from "./extraction-liveness.js";
import { parseReplicaPeersConfig } from "./replica-peers-config.js";
import { parseDependencyPropagationConfig } from "./dependency-propagation-config.js";
import { parseProceduralMaintenanceConfig } from "./procedural/maintenance-config.js";
import { parseActiveContextFields } from "./active-context-config.js";
import { parseSkillProjectionConfig } from "./procedural/skill-projection.js";
import { parseDriftDetectionConfig } from "./preferences/drift-config.js";
import { parseDeepRecallConfig } from "./deep-recall-config.js";
import { parseContradictionLocalizationConfig, parseContradictionScanConfig } from "./contradiction-config.js";
import { parseGraphPathScoringConfig } from "./graph-path-scoring-config.js";
import { parseWritePathDedupConfig } from "./dedup/novelty-gate.js";
import { parseSemanticMergeConfig } from "./dedup/merge.js";
import { hasLegacyConnectorEntries } from "./connectors/paths.js";
import {
  parseQmdChunkStrategy,
  parseQmdDaemonTimeoutMs,
  parseQmdGpuBackend,
  parseQmdSearchStrategy,
  parseQmdSubprocessStrategy,
  parseQmdSupportedVersion,
} from "./config-qmd.js";
import { parseSecurityConfig } from "./config-security.js";
import {
  resolveEmitLegacyTools,
  resolveNamespaceCatalogEnabled,
} from "./emit-legacy-tools.js";
import { parseWearablesConfig } from "./wearables/config.js";
import { parseCaptureCompanionConfigs } from "./location/parse-companions.js";
import { parseLocationConfig } from "./location/config.js";
import { parseOkfConfig } from "./okf/config.js";
import { parseBoundedJsonlStateConfig } from "./bounded-jsonl-state.js";
import { parseCodingKnowledgeConfig } from "./coding/coding-knowledge-config.js";
import { parseActionGateConfig } from "./coding/action-gate.js";
import { parseChatConfig } from "./chat/chat-config.js";
import { parseSupportPassportConfig } from "./support-passport/config.js";
import { parseCorrectionIntentConfig, parseFaithfulnessGateConfig } from "./faithfulness-config.js";
import { parseOfflineSyncExcludes } from "./offline-sync.js";
import { parseExternalWikiRoots } from "./external-wiki-config.js";
import {
  parseScopeProfiles,
  parseScopeTeams,
  validateScopeProfileTeamReferences,
} from "./namespaces/scope-profile-config.js";
const DEFAULT_MEMORY_DIR = path.join(
  resolveHomeDir(),
  ".openclaw",
  "workspace",
  "memory",
  "local",
);
const DEFAULT_WORKSPACE_DIR = path.join(
  resolveHomeDir(),
  ".openclaw",
  "workspace",
);

const DEFAULT_INIT_GATE_TIMEOUT_MS = 30_000;

const CLIENT_SECRET_FIELD = ["client", "Secret"].join("") as "clientSecret";
const REFRESH_TOKEN_FIELD = ["refresh", "Token"].join("") as "refreshToken";
const LEGACY_ACTIVE_RECALL_CUSTOM_FIELD = [
  "activeRecall",
  "Prompt",
  "Override",
].join("") as "activeRecallPromptOverride";

function parseBoundedIntegerMs(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const coerced = coerceNumber(value);
  if (coerced === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(coerced)));
}

// A gateway model string must be "provider/model" — at least one "/" with a
// non-empty provider segment and a non-empty model segment. This mirrors
// FallbackLlmClient.parseModelString (which requires >= 2 slash-parts), so a
// model the runtime would silently drop is rejected at config time instead.
function isQualifiedModelString(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

function parseModelChainConfig(
  value: unknown,
  keyName: string,
): AgentPersonaModelConfig | undefined {
  // Absent → not configured (no error).
  if (value === undefined || value === null) return undefined;

  // Present but malformed → reject loudly rather than silently dropping it,
  // so a typo'd chain surfaces instead of quietly reverting to defaults
  // (gotcha #51). Issue #1365 / PR #1370.
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${keyName} must be an object like { "primary": "provider/model", "fallbacks": ["provider/model", ...] }; got ${JSON.stringify(value)}`,
    );
  }
  const raw = value as Record<string, unknown>;
  // Reject unknown keys (matches the manifest's additionalProperties:false) so a
  // misspelled "fallback"/"fallbackModels" doesn't silently drop the fallback
  // chain (gotcha #51, codex review #1425).
  const unknownKeys = Object.keys(raw).filter((k) => k !== "primary" && k !== "fallbacks");
  if (unknownKeys.length > 0) {
    throw new Error(
      `${keyName} has unknown propert${unknownKeys.length === 1 ? "y" : "ies"}: ${unknownKeys.join(", ")}. Allowed: "primary", "fallbacks".`,
    );
  }
  if (typeof raw.primary !== "string" || raw.primary.trim().length === 0) {
    throw new Error(
      `${keyName}.primary is required and must be a non-empty "provider/model" string; got ${JSON.stringify(raw.primary)}`,
    );
  }
  const primary = raw.primary.trim();
  if (!isQualifiedModelString(primary)) {
    throw new Error(
      `${keyName}.primary must be in "provider/model" form (e.g. "zai/glm-4.7-flash"); got ${JSON.stringify(primary)}`,
    );
  }

  let dedupedFallbacks: string[] | undefined;
  if (raw.fallbacks !== undefined) {
    if (!Array.isArray(raw.fallbacks)) {
      throw new Error(
        `${keyName}.fallbacks must be an array of "provider/model" strings; got ${JSON.stringify(raw.fallbacks)}`,
      );
    }
    if (raw.fallbacks.some((item) => typeof item !== "string")) {
      throw new Error(`${keyName}.fallbacks must contain only strings`);
    }
    const trimmed = raw.fallbacks
      .map((item) => (item as string).trim())
      .filter((item) => item.length > 0 && item !== primary);
    for (const fb of trimmed) {
      if (!isQualifiedModelString(fb)) {
        throw new Error(
          `${keyName}.fallbacks entries must be in "provider/model" form; got ${JSON.stringify(fb)}`,
        );
      }
    }
    dedupedFallbacks = [...new Set(trimmed)];
  }

  return {
    primary,
    ...(dedupedFallbacks && dedupedFallbacks.length > 0 ? { fallbacks: dedupedFallbacks } : {}),
  };
}

function parsePositiveInteger(value: unknown, keyName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced <= 0
  ) {
    throw new Error(
      `${keyName} must be a positive integer; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseBoundedPositiveInteger(
  value: unknown,
  min: number,
  max: number,
  keyName: string,
): number | undefined {
  const parsed = parsePositiveInteger(value, keyName);
  if (parsed === undefined) return undefined;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Validate a closed-range integer config knob, coercing CLI numeric strings
 * first (issue #1909 review round 8). `undefined`/`null` → `fallback`. Anything
 * provided must coerce to a FINITE INTEGER in `[min, max]`; otherwise THROW
 * (AGENTS.md #1/#39: reject invalid user input, never silently floor/clamp).
 */
function parseIntegerInClosedRange(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  keyName: string,
): number {
  // Only an absent key (undefined) falls back to the default; an explicit `null`
  // is invalid input and proceeds to validation → throw (round 9 finding 1).
  if (value === undefined) return fallback;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < min ||
    coerced > max
  ) {
    throw new Error(
      `${keyName} must be an integer in [${min}, ${max}]; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseIntegerAtLeast(
  value: unknown,
  fallback: number,
  min: number,
  keyName: string,
): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < min
  ) {
    throw new Error(
      `${keyName} must be an integer greater than or equal to ${min}; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parseOptionalIntegerAtLeast(
  value: unknown,
  min: number,
  keyName: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < min
  ) {
    throw new Error(
      `${keyName} must be an integer greater than or equal to ${min}; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function parsePortNumber(
  value: unknown,
  fallback: number,
  keyName: string,
): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isInteger(coerced) ||
    coerced < 0 ||
    coerced > 65535
  ) {
    throw new Error(
      `${keyName} must be an integer from 0 to 65535; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function readNestedConfig(
  cfg: Record<string, unknown>,
  blockName: string,
  key: string,
): unknown {
  const block = validateNestedConfigBlock(cfg, blockName);
  if (!block) return undefined;
  return block[key];
}

function validateNestedConfigBlock(
  cfg: Record<string, unknown>,
  blockName: string,
): Record<string, unknown> | undefined {
  const block = cfg[blockName];
  if (block === undefined || block === null) return undefined;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${blockName} must be a plain object`);
  }
  return block as Record<string, unknown>;
}

function readFlatOrNestedConfig(
  cfg: Record<string, unknown>,
  flatKey: string,
  blockName: string,
  nestedKey: string,
): unknown {
  return cfg[flatKey] !== undefined
    ? cfg[flatKey]
    : readNestedConfig(cfg, blockName, nestedKey);
}

function resolveBooleanConfig(
  value: unknown,
  defaultValue: boolean,
  keyName: string,
): boolean {
  if (value === undefined || value === null) return defaultValue;
  const coerced = coerceBool(value);
  if (coerced === undefined) {
    throw new Error(
      `${keyName} must be a boolean-like value (true/false/1/0/yes/no/on/off); got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function resolvePositiveIntegerConfig(
  value: unknown,
  defaultValue: number,
  keyName: string,
): number {
  if (value === undefined || value === null) return defaultValue;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 1
  ) {
    throw new Error(
      `${keyName} must be a positive integer; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

function resolveNonNegativeIntegerConfig(
  value: unknown,
  defaultValue: number,
  keyName: string,
): number {
  if (value === undefined || value === null) return defaultValue;
  const coerced = coerceNumber(value);
  if (
    coerced === undefined ||
    !Number.isFinite(coerced) ||
    !Number.isInteger(coerced) ||
    coerced < 0
  ) {
    throw new Error(
      `${keyName} must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return coerced;
}

export function isOpenaiApiKeyDisabled(value: unknown): boolean {
  return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

/**
 * Detect a SecretRef-shaped object (issue #757) without resolving it.
 * SecretRefs are preserved verbatim through `parseConfig` and resolved at
 * service-start time via `resolveAgentAccessAuthToken` (which delegates to
 * OpenClaw's gateway resolver). Standalone Remnic does not resolve these.
 */
function isSecretRefShape(value: unknown): value is import("./types.js").SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.source === "string" && obj.source.trim().length > 0;
}

/**
 * Parse the `agentAccessHttp.authToken` field. Accepts:
 *   - `string` → env-expanded immediately (current behavior preserved)
 *   - `SecretRef` object (`{source, ...}`) → preserved verbatim for runtime
 *     resolution by OpenClaw's gateway secret resolver
 *   - `undefined` / empty string → fall back to env var, then `undefined`
 *   - Any other shape → throw with a clear, actionable error so operators can
 *     debug rather than chasing a generic startup failure (issue #757).
 */
function parseAgentAccessAuthToken(raw: unknown): import("./types.js").AgentAccessAuthToken | undefined {
  if (raw === undefined || raw === null) {
    return readEnvVar("OPENCLAW_REMNIC_ACCESS_TOKEN") ?? readEnvVar("OPENCLAW_ENGRAM_ACCESS_TOKEN");
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return readEnvVar("OPENCLAW_REMNIC_ACCESS_TOKEN") ?? readEnvVar("OPENCLAW_ENGRAM_ACCESS_TOKEN");
    }
    return resolveEnvVars(raw);
  }
  if (isSecretRefShape(raw)) {
    return raw;
  }
  throw new Error(
    "unsupported SecretRef shape for agentAccessHttp.authToken — " +
      "expected a string or an object with a non-empty `source` field " +
      "(see https://github.com/joshuaswarren/remnic/issues/757)",
  );
}

function parseAgentAccessPrincipal(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return resolveEnvVars(raw);
  }
  return (
    readEnvVar("OPENCLAW_REMNIC_ACCESS_PRINCIPAL")?.trim() ||
    readEnvVar("OPENCLAW_ENGRAM_ACCESS_PRINCIPAL")?.trim() ||
    undefined
  );
}

export function resolveEnvVars(value: string): string {
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, envVar: string) => {
    const envValue = readEnvVar(envVar);
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
  const remaining = resolved.match(/\$\{[^}]*\}/);
  if (remaining) {
    throw new Error(`Malformed environment variable placeholder: ${remaining[0]}`);
  }
  return resolved;
}

function normalizeOpenaiBaseUrl(value: string | undefined, source: "config" | "env"): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${source === "env" ? "OPENAI_BASE_URL" : "openaiBaseUrl"} must be an absolute HTTP or HTTPS URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${source === "env" ? "OPENAI_BASE_URL" : "openaiBaseUrl"} must be an absolute HTTP or HTTPS URL`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${source === "env" ? "OPENAI_BASE_URL" : "openaiBaseUrl"} must use HTTP or HTTPS`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${source === "env" ? "OPENAI_BASE_URL" : "openaiBaseUrl"} must not include credentials, query parameters, or fragments`,
    );
  }

  if (parsed.protocol === "http:") {
    log.warn(`openaiBaseUrl from ${source} is using insecure http; prefer https`);
  }

  // Avoid duplicate slash behavior in downstream baseURL path joins.
  let url = parsed.toString();
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}


const LLM_BRIDGE_PLACEHOLDER_KEY = "remnic-hermes-llm-bridge";

function deriveOpenaiBaseUrlFromBridgeEndpoint(endpoint: string): string {
  let trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    trimmed = trimmed.slice(0, -"/chat/completions".length);
  }
  const derived = normalizeOpenaiBaseUrl(trimmed, "config");
  if (!derived) {
    throw new Error("llmBridgeClientConfigPath endpoint must be an absolute HTTP or HTTPS URL");
  }
  return derived;
}

function applyLlmBridgeClientConfigPath(
  cfg: Record<string, unknown>,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  openaiApiKeyDisabled: boolean,
): { baseUrl: string | undefined; apiKey: string | undefined } {
  const raw = cfg.llmBridgeClientConfigPath;
  if (raw === undefined || raw === null || raw === "") {
    return { baseUrl, apiKey };
  }
  if (typeof raw !== "string") {
    throw new Error("llmBridgeClientConfigPath must be a string");
  }
  const expanded = expandTildePath(resolveEnvVars(raw.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(expanded, "utf8"));
  } catch {
    throw new Error(`llmBridgeClientConfigPath could not be read: ${expanded}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("llmBridgeClientConfigPath must contain a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const endpoint = record.endpoint ?? record.url;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new Error("llmBridgeClientConfigPath JSON must include an endpoint URL");
  }
  const derived = deriveOpenaiBaseUrlFromBridgeEndpoint(endpoint);
  return {
    baseUrl: baseUrl ?? derived,
    apiKey: apiKey !== undefined || openaiApiKeyDisabled ? apiKey : LLM_BRIDGE_PLACEHOLDER_KEY,
  };
}

function normalizeMemoryRelativeDir(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;

  const normalized = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  return normalized.length > 0 ? normalized : fallback;
}

function parseSemanticChunkingConfig(
  raw: unknown,
): Partial<SemanticChunkingConfigShape> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<SemanticChunkingConfigShape> = {};

  if (typeof src.targetTokens === "number") out.targetTokens = src.targetTokens;
  if (typeof src.minTokens === "number") out.minTokens = src.minTokens;
  if (typeof src.maxTokens === "number") out.maxTokens = src.maxTokens;
  if (typeof src.smoothingWindowSize === "number") out.smoothingWindowSize = src.smoothingWindowSize;
  if (typeof src.boundaryThresholdStdDevs === "number") out.boundaryThresholdStdDevs = src.boundaryThresholdStdDevs;
  if (typeof src.embeddingBatchSize === "number") out.embeddingBatchSize = src.embeddingBatchSize;
  if (typeof src.fallbackToRecursive === "boolean") out.fallbackToRecursive = src.fallbackToRecursive;

  return out;
}

// Cursor review on PR #736: the default reasoning model used by the
// extraction pipeline (`config.model`) and the new peer profile
// reasoner (`peerProfileReasonerModel`) was hardcoded as `"gpt-5.5"`
// in two places. Centralize the default so both surfaces — and any
// future LLM-backed surface — always agree on the same model id.
// Sibling packages may keep their own constants only when they are scoped to
// their own subsystem and intentionally diverge. Shared reasoning-model
// defaults should use this constant.
export const DEFAULT_REASONING_MODEL = "gpt-5.5";

const VALID_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const VALID_TRIGGERS: TriggerMode[] = ["smart", "every_n", "time_based"];
const VALID_IDENTITY_INJECTION_MODES: IdentityInjectionMode[] = ["recovery_only", "minimal", "full"];
const VALID_MEMORY_OS_PRESETS: MemoryOsPresetName[] = [
  "conservative",
  "balanced",
  "research-max",
  "local-llm-heavy",
];
const VALID_SLOT_MISMATCH_MODES: SlotMismatchMode[] = ["error", "warn", "silent"];
const VALID_CODEX_COMPACTION_FLUSH_MODES: CodexCompactionFlushMode[] = ["signal", "heuristic", "auto"];
export const VALID_MEMORY_CATEGORIES = new Set([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
]);

const DEFAULT_BEHAVIOR_LOOP_PROTECTED_PARAMS = [
  "maxMemoryTokens",
  "qmdMaxResults",
  "qmdColdMaxResults",
  "qmdEmbeddingBacklogThreshold",
  "recallPlannerMaxQmdResultsMinimal",
  "verbatimArtifactsMaxRecall",
];

const MEMORY_OS_PRESET_ALIASES: Record<string, MemoryOsPresetName> = {
  research: "research-max",
};

const MEMORY_OS_PRESETS: Record<MemoryOsPresetName, Record<string, unknown>> = {
  conservative: {
    maxMemoryTokens: 1500,
    recallPlannerMaxQmdResultsMinimal: 2,
    recallPlannerMaxQmdResultsFull: 5,
    queryAwareIndexingEnabled: false,
    verbatimArtifactsEnabled: false,
    verbatimArtifactsMaxRecall: 2,
    rerankEnabled: false,
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: false,
    contextCompressionActionsEnabled: false,
    compressionGuidelineLearningEnabled: false,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 0,
    maxCompressionTokensPerHour: 0,
    behaviorLoopAutoTuneEnabled: false,
    // Issue #567 PR 4/5 flipped `procedural.enabled` default to `true`.
    // The conservative preset intentionally keeps the feature OFF to
    // match its restrictive intent (no proactive extraction, no
    // compression guideline learning, etc.). Users who want procedural
    // memory on a conservative preset must set `procedural.enabled: true`
    // explicitly.
    procedural: { enabled: false },
  },
  balanced: {
    maxMemoryTokens: 2000,
    recallPlannerMaxQmdResultsMinimal: 4,
    recallPlannerMaxQmdResultsFull: 8,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 4,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: false,
    contextCompressionActionsEnabled: false,
    compressionGuidelineLearningEnabled: false,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 2,
    maxCompressionTokensPerHour: 1500,
    behaviorLoopAutoTuneEnabled: false,
  },
  "research-max": {
    maxMemoryTokens: 3200,
    recallPlannerMaxQmdResultsMinimal: 6,
    recallPlannerMaxQmdResultsFull: 12,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 6,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: true,
    graphRecallEnabled: true,
    graphAssistInFullModeEnabled: true,
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    compressionGuidelineSemanticRefinementEnabled: true,
    explicitCueRecallEnabled: true,
    explicitCueRecallMaxChars: 3200,
    lcmEnabled: true,
    maxProactiveQuestionsPerExtraction: 4,
    maxCompressionTokensPerHour: 3000,
    behaviorLoopAutoTuneEnabled: true,
  },
  "local-llm-heavy": {
    maxMemoryTokens: 2400,
    recallPlannerMaxQmdResultsMinimal: 4,
    recallPlannerMaxQmdResultsFull: 8,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 4,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: true,
    localLlmFastEnabled: true,
    embeddingFallbackProvider: "local",
    localLlmFallback: true,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 2,
    maxCompressionTokensPerHour: 1500,
    behaviorLoopAutoTuneEnabled: false,
  },
};

function resolveMemoryOsPreset(value: unknown): MemoryOsPresetName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (VALID_MEMORY_OS_PRESETS.includes(normalized as MemoryOsPresetName)) {
    return normalized as MemoryOsPresetName;
  }
  return MEMORY_OS_PRESET_ALIASES[normalized];
}
export function parseConfig(
  raw: unknown,
  rawOperatorConfig?: Record<string, unknown> | null,
  runtimeSet?: ReadonlySet<string>,
): PluginConfig {
  const baseCfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const memoryOsPreset = resolveMemoryOsPreset(baseCfg.memoryOsPreset);
  let cfg: Record<string, unknown>;
  if (memoryOsPreset) {
    const preset = MEMORY_OS_PRESETS[memoryOsPreset];
    // Deep-merge the `procedural` block specifically: the preset may pin a
    // subset of keys (e.g. `conservative` pins `procedural: { enabled: false }`),
    // and a user-provided `procedural` block with just `minOccurrences` or
    // `lookbackDays` must NOT silently discard the preset's `enabled: false`.
    // CLAUDE.md rule 22 (dedup config resolution) + Codex P1 on #609.
    const presetProcedural =
      preset.procedural &&
      typeof preset.procedural === "object" &&
      !Array.isArray(preset.procedural)
        ? (preset.procedural as Record<string, unknown>)
        : undefined;
    const baseProcedural =
      baseCfg.procedural &&
      typeof baseCfg.procedural === "object" &&
      !Array.isArray(baseCfg.procedural)
        ? (baseCfg.procedural as Record<string, unknown>)
        : undefined;
    const mergedProcedural =
      presetProcedural && baseProcedural
        ? { ...presetProcedural, ...baseProcedural }
        : (baseProcedural ?? presetProcedural);
    cfg = {
      ...preset,
      ...baseCfg,
      memoryOsPreset,
    };
    if (mergedProcedural !== undefined) {
      cfg.procedural = mergedProcedural;
    }
  } else {
    cfg = baseCfg;
  }
  validateNestedConfigBlock(cfg, "maintenance");

  const modelSource =
    cfg.modelSource === "gateway" ? "gateway" : "plugin";

  const openaiApiKeyDisabled = isOpenaiApiKeyDisabled(cfg.openaiApiKey);

  let apiKey: string | undefined;
  if (openaiApiKeyDisabled) {
    // Explicit opt-out for local/gateway-only deployments. Without this,
    // a stale process-level OPENAI_API_KEY can be captured even when the
    // operator wants Remnic to use local LLMs and never try direct OpenAI.
    apiKey = undefined;
  } else if (typeof cfg.openaiApiKey === "string" && cfg.openaiApiKey.length > 0) {
    apiKey = resolveEnvVars(cfg.openaiApiKey);
  } else if (modelSource === "gateway") {
    // Gateway mode deliberately delegates LLM calls to OpenClaw's model chain.
    // Do not implicitly capture OPENAI_API_KEY from the Remnic process env here:
    // doing so makes diagnostics look OpenAI-dependent and can accidentally
    // route extraction through a stale direct key before gateway fallback.
    apiKey = undefined;
  } else {
    apiKey = readEnvVar("OPENAI_API_KEY");
  }

  // API key is optional at load time — retrieval works without it.
  // Extraction will log a warning if called without a key.

  const taskModelChain = parseModelChainConfig(cfg.taskModelChain, "taskModelChain");
  // Gateway-routed background tasks (flush plan, hourly summary cron, recall
  // planner) default to the configured task-model primary, or empty so the
  // Gateway default wins — never a bare reasoning id that resolves to an
  // unroutable `<provider>/gpt-5.5` (issue #1469).
  const taskModelFallback =
    modelSource === "gateway"
      ? (taskModelChain?.primary ?? "")
      : DEFAULT_REASONING_MODEL;
  const explicitModel =
    typeof cfg.model === "string" && cfg.model.length > 0 ? cfg.model : "";
  // Base reasoning/extraction model. Kept DIRECT-compatible: direct-key call
  // sites (e.g. briefing follow-ups when `openaiApiKey` is set) pass this
  // straight to the OpenAI Responses API, so it must stay a bare/direct model
  // id and never a provider-qualified gateway route string. The gateway task
  // chain is applied at gateway-routed call sites (summaryModel, recall planner)
  // instead, not here (issue #1469 / codex review on PR #1470).
  const model = explicitModel || DEFAULT_REASONING_MODEL;
  // In gateway mode a usable task route must be provider-qualified (`provider/model`).
  // A bare id — including the `"gpt-5.5"` schema default OpenClaw injects when the
  // operator only configured `modelSource` + `taskModelChain` — resolves to an
  // unroutable `<provider>/gpt-5.5`, so it is treated as ABSENT and the configured
  // task chain wins. Direct (non-gateway) mode keeps bare ids as-is (#1469).
  const gatewayTaskModel = (value: string): string =>
    modelSource === "gateway" && !value.includes("/") ? "" : value;
  const captureMode =
    cfg.captureMode === "explicit" || cfg.captureMode === "hybrid"
      ? cfg.captureMode
      : "implicit";

  const rawEffort = cfg.reasoningEffort as string | undefined;
  const reasoningEffort: ReasoningEffort =
    rawEffort && VALID_EFFORTS.includes(rawEffort as ReasoningEffort)
      ? (rawEffort as ReasoningEffort)
      : "low";

  const rawTrigger = cfg.triggerMode as string | undefined;
  const triggerMode: TriggerMode =
    rawTrigger && VALID_TRIGGERS.includes(rawTrigger as TriggerMode)
      ? (rawTrigger as TriggerMode)
      : "smart";
  const rawSlotBehavior =
    cfg.slotBehavior && typeof cfg.slotBehavior === "object" && !Array.isArray(cfg.slotBehavior)
      ? (cfg.slotBehavior as Record<string, unknown>)
      : {};
  const slotBehavior: SlotBehaviorConfig = {
    requireExclusiveMemorySlot:
      rawSlotBehavior.requireExclusiveMemorySlot !== false,
    onSlotMismatch:
      typeof rawSlotBehavior.onSlotMismatch === "string" &&
      VALID_SLOT_MISMATCH_MODES.includes(
        rawSlotBehavior.onSlotMismatch as SlotMismatchMode,
      )
        ? (rawSlotBehavior.onSlotMismatch as SlotMismatchMode)
        : "error",
  };
  const rawDreaming =
    cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming)
      ? (cfg.dreaming as Record<string, unknown>)
      : {};
  const dreaming: DreamingConfig = {
    enabled: rawDreaming.enabled === true,
    journalPath:
      typeof rawDreaming.journalPath === "string" && rawDreaming.journalPath.trim().length > 0
        ? rawDreaming.journalPath.trim()
        : "DREAMS.md",
    maxEntries:
      typeof rawDreaming.maxEntries === "number"
        ? rawDreaming.maxEntries === 0
          ? 0
          : rawDreaming.maxEntries < 0
            ? 500
          : rawDreaming.maxEntries < 10
            ? 500
            : Math.min(10000, Math.floor(rawDreaming.maxEntries))
        : 500,
    injectRecentCount:
      typeof rawDreaming.injectRecentCount === "number"
        ? Math.min(20, Math.max(0, Math.floor(rawDreaming.injectRecentCount)))
        : 3,
    minIntervalMinutes:
      typeof rawDreaming.minIntervalMinutes === "number"
        ? Math.max(1, Math.floor(rawDreaming.minIntervalMinutes))
        : 120,
    narrativeModel:
      typeof rawDreaming.narrativeModel === "string" && rawDreaming.narrativeModel.trim().length > 0
        ? rawDreaming.narrativeModel.trim()
        : null,
    narrativePromptStyle:
      rawDreaming.narrativePromptStyle === "diary" ||
      rawDreaming.narrativePromptStyle === "analytical"
        ? rawDreaming.narrativePromptStyle
        : "reflective",
    watchFile: rawDreaming.watchFile !== false,
  };

  // ── Dreams phases config (issue #678 PR 2/4) ─────────────────────────────
  // The `dreams.phases.*` block groups existing top-level lifecycle / REM /
  // deep-sleep gates under a unified namespace.  When a value is explicitly
  // set under `dreams.phases.*`, it WINS over the corresponding legacy
  // top-level key.  Legacy top-level keys continue to be parsed so existing
  // configs work without modification.
  //
  // Precedence summary (highest → lowest):
  //   dreams.phases.lightSleep.enabled  > lifecyclePolicyEnabled
  //   dreams.phases.rem.enabled         > semanticConsolidationEnabled
  //   dreams.phases.deepSleep.enabled   > (no legacy top-level equivalent)
  //
  // This block is intentionally a DIFFERENT namespace from `dreaming`
  // (the diary surface — `surfaces/dreams.ts`). See docs/dreams.md.
  const rawDreamsBlock =
    cfg.dreams && typeof cfg.dreams === "object" && !Array.isArray(cfg.dreams)
      ? (cfg.dreams as Record<string, unknown>)
      : {};
  const rawDreamsPhases =
    rawDreamsBlock.phases && typeof rawDreamsBlock.phases === "object" && !Array.isArray(rawDreamsBlock.phases)
      ? (rawDreamsBlock.phases as Record<string, unknown>)
      : {};
  const rawDreamsLightSleep =
    rawDreamsPhases.lightSleep && typeof rawDreamsPhases.lightSleep === "object" && !Array.isArray(rawDreamsPhases.lightSleep)
      ? (rawDreamsPhases.lightSleep as Record<string, unknown>)
      : {};
  const rawDreamsRem =
    rawDreamsPhases.rem && typeof rawDreamsPhases.rem === "object" && !Array.isArray(rawDreamsPhases.rem)
      ? (rawDreamsPhases.rem as Record<string, unknown>)
      : {};
  const rawDreamsDeepSleep =
    rawDreamsPhases.deepSleep && typeof rawDreamsPhases.deepSleep === "object" && !Array.isArray(rawDreamsPhases.deepSleep)
      ? (rawDreamsPhases.deepSleep as Record<string, unknown>)
      : {};

  // Resolve legacy top-level defaults that the phases mirror. We compute them
  // here (before the return statement) so the phase parser can apply precedence
  // without duplicating the clamping logic.
  const legacyLifecyclePolicyEnabled = coerceBooleanLike(cfg.lifecyclePolicyEnabled) ?? true;
  const legacyLifecyclePromoteHeatThreshold =
    typeof cfg.lifecyclePromoteHeatThreshold === "number"
      ? Math.min(1, Math.max(0, cfg.lifecyclePromoteHeatThreshold))
      : 0.55;
  const legacyLifecycleStaleDecayThreshold =
    typeof cfg.lifecycleStaleDecayThreshold === "number"
      ? Math.min(1, Math.max(0, cfg.lifecycleStaleDecayThreshold))
      : 0.65;
  const legacyLifecycleArchiveDecayThreshold =
    typeof cfg.lifecycleArchiveDecayThreshold === "number"
      ? Math.min(1, Math.max(0, cfg.lifecycleArchiveDecayThreshold))
      : 0.85;
  const legacySemanticConsolidationEnabled = cfg.semanticConsolidationEnabled === true;
  const legacySemanticConsolidationIntervalHours =
    typeof cfg.semanticConsolidationIntervalHours === "number"
      ? Math.max(1, Math.floor(cfg.semanticConsolidationIntervalHours))
      : 168;
  const legacySemanticConsolidationThreshold =
    typeof cfg.semanticConsolidationThreshold === "number" ? cfg.semanticConsolidationThreshold : 0.8;
  const legacySemanticConsolidationMinClusterSize =
    typeof cfg.semanticConsolidationMinClusterSize === "number"
      ? Math.max(2, Math.floor(cfg.semanticConsolidationMinClusterSize))
      : 3;
  const legacySemanticConsolidationMaxPerRun =
    typeof cfg.semanticConsolidationMaxPerRun === "number"
      ? Math.max(0, Math.floor(cfg.semanticConsolidationMaxPerRun))
      : 100;
  const legacyConsolidationMinIntervalMs =
    typeof cfg.consolidationMinIntervalMs === "number" ? cfg.consolidationMinIntervalMs : 10 * 60_000;
  const legacyVersioningEnabled = cfg.versioningEnabled === true;
  const legacyVersioningMaxPerPage =
    typeof cfg.versioningMaxPerPage === "number"
      ? Math.max(0, Math.floor(cfg.versioningMaxPerPage))
      : 50;
  const legacyDeepSleepEnabled =
    cfg.nightlyGovernanceCronAutoRegister === true ||
    cfg.qmdTierMigrationEnabled === true ||
    legacyVersioningEnabled;

  // Light sleep phase — dreams.phases.lightSleep.* wins when present.
  const dreamsLightSleepEnabledRaw = coerceBooleanLike(rawDreamsLightSleep.enabled);
  const dreamsLightSleep: DreamsLightSleepConfig = {
    // new key wins; fall back to resolved legacy default
    enabled: dreamsLightSleepEnabledRaw !== undefined ? dreamsLightSleepEnabledRaw : legacyLifecyclePolicyEnabled,
    cadenceMs:
      typeof rawDreamsLightSleep.cadenceMs === "number"
        ? Math.max(0, Math.floor(rawDreamsLightSleep.cadenceMs))
        : 0, // 0 = no override; orchestrator uses its own internal cadence
    promoteHeatThreshold:
      typeof rawDreamsLightSleep.promoteHeatThreshold === "number"
        ? Math.min(1, Math.max(0, rawDreamsLightSleep.promoteHeatThreshold))
        : legacyLifecyclePromoteHeatThreshold,
    staleDecayThreshold:
      typeof rawDreamsLightSleep.staleDecayThreshold === "number"
        ? Math.min(1, Math.max(0, rawDreamsLightSleep.staleDecayThreshold))
        : legacyLifecycleStaleDecayThreshold,
    archiveDecayThreshold:
      typeof rawDreamsLightSleep.archiveDecayThreshold === "number"
        ? Math.min(1, Math.max(0, rawDreamsLightSleep.archiveDecayThreshold))
        : legacyLifecycleArchiveDecayThreshold,
    filterStaleEnabled:
      rawDreamsLightSleep.filterStaleEnabled !== undefined
        ? coerceBooleanLike(rawDreamsLightSleep.filterStaleEnabled) === true
        : cfg.lifecycleFilterStaleEnabled === true,
  };

  // REM phase — dreams.phases.rem.* wins when present.
  const dreamsRemEnabledRaw = coerceBooleanLike(rawDreamsRem.enabled);
  const dreamsRem: DreamsRemConfig = {
    enabled: dreamsRemEnabledRaw !== undefined ? dreamsRemEnabledRaw : legacySemanticConsolidationEnabled,
    cadenceMs:
      typeof rawDreamsRem.cadenceMs === "number"
        ? Math.max(0, Math.floor(rawDreamsRem.cadenceMs))
        : legacySemanticConsolidationIntervalHours * 3_600_000,
    similarityThreshold:
      typeof rawDreamsRem.similarityThreshold === "number"
        ? Math.min(1, Math.max(0, rawDreamsRem.similarityThreshold))
        : legacySemanticConsolidationThreshold,
    minClusterSize:
      typeof rawDreamsRem.minClusterSize === "number"
        ? Math.max(2, Math.floor(rawDreamsRem.minClusterSize))
        : legacySemanticConsolidationMinClusterSize,
    maxPerRun:
      typeof rawDreamsRem.maxPerRun === "number"
        ? Math.max(0, Math.floor(rawDreamsRem.maxPerRun))
        : legacySemanticConsolidationMaxPerRun,
    minIntervalMs:
      typeof rawDreamsRem.minIntervalMs === "number"
        ? Math.max(0, Math.floor(rawDreamsRem.minIntervalMs))
        : legacyConsolidationMinIntervalMs,
  };

  // Deep sleep phase — dreams.phases.deepSleep.* wins when present.
  const dreamsDeepSleepEnabledRaw = coerceBooleanLike(rawDreamsDeepSleep.enabled);
  const dreamsDeepSleep: DreamsDeepSleepConfig = {
    enabled:
      dreamsDeepSleepEnabledRaw !== undefined
        ? dreamsDeepSleepEnabledRaw
        : legacyDeepSleepEnabled,
    enabledExplicitlySet: dreamsDeepSleepEnabledRaw !== undefined,
    cadenceMs:
      typeof rawDreamsDeepSleep.cadenceMs === "number"
        ? Math.max(0, Math.floor(rawDreamsDeepSleep.cadenceMs))
        : 24 * 3_600_000, // default: 24 h (mirrors nightly governance cron)
    versioningEnabled:
      rawDreamsDeepSleep.versioningEnabled !== undefined
        ? coerceBooleanLike(rawDreamsDeepSleep.versioningEnabled) === true
        : legacyVersioningEnabled,
    versioningMaxPerPage:
      typeof rawDreamsDeepSleep.versioningMaxPerPage === "number"
        ? Math.max(0, Math.floor(rawDreamsDeepSleep.versioningMaxPerPage))
        : legacyVersioningMaxPerPage,
  };

  const dreamsPhases: DreamsPhasesConfig = {
    lightSleep: dreamsLightSleep,
    rem: dreamsRem,
    deepSleep: dreamsDeepSleep,
  };
  // ── End dreams phases ─────────────────────────────────────────────────────

  const rawHeartbeat =
    cfg.heartbeat && typeof cfg.heartbeat === "object" && !Array.isArray(cfg.heartbeat)
      ? (cfg.heartbeat as Record<string, unknown>)
      : {};
  const heartbeat: HeartbeatConfig = {
    enabled: rawHeartbeat.enabled === true,
    journalPath:
      typeof rawHeartbeat.journalPath === "string" && rawHeartbeat.journalPath.trim().length > 0
        ? rawHeartbeat.journalPath.trim()
        : "HEARTBEAT.md",
    maxPreviousRuns:
      typeof rawHeartbeat.maxPreviousRuns === "number"
        ? Math.min(20, Math.max(0, Math.floor(rawHeartbeat.maxPreviousRuns)))
        : 5,
    watchFile: rawHeartbeat.watchFile !== false,
    detectionMode:
      rawHeartbeat.detectionMode === "runtime-signal" ||
      rawHeartbeat.detectionMode === "heuristic"
        ? rawHeartbeat.detectionMode
        : "auto",
    gateExtractionDuringHeartbeat:
      rawHeartbeat.gateExtractionDuringHeartbeat !== false,
  };
  const rawCodexCompat =
    cfg.codexCompat && typeof cfg.codexCompat === "object" && !Array.isArray(cfg.codexCompat)
      ? (cfg.codexCompat as Record<string, unknown>)
      : {};
  const codexCompat: CodexCompatConfig = {
    enabled: rawCodexCompat.enabled === true,
    threadIdBufferKeying: rawCodexCompat.threadIdBufferKeying !== false,
    compactionFlushMode:
      typeof rawCodexCompat.compactionFlushMode === "string" &&
      VALID_CODEX_COMPACTION_FLUSH_MODES.includes(
        rawCodexCompat.compactionFlushMode as CodexCompactionFlushMode,
      )
        ? (rawCodexCompat.compactionFlushMode as CodexCompactionFlushMode)
        : "auto",
    fingerprintDedup: rawCodexCompat.fingerprintDedup !== false,
  };

  // Validate the shape of the `procedural` config block BEFORE applying the
  // default-on behavior. Codex P2 on #609: a shorthand opt-out like
  // `procedural: false` or `procedural: null` would previously normalize
  // silently to `{}`, and the omitted-key branch would then enable the
  // feature — the opposite of what the user asked for. Reject
  // non-object shapes loudly per CLAUDE.md rule 51.
  if (
    cfg.procedural !== undefined &&
    (cfg.procedural === null ||
      typeof cfg.procedural !== "object" ||
      Array.isArray(cfg.procedural))
  ) {
    throw new Error(
      `procedural must be an object (got ${JSON.stringify(cfg.procedural)}). Use procedural: { enabled: false } to opt out; omit the key to use the default-on behavior (issue #567 PR 4).`,
    );
  }
  const rawProcedural =
    cfg.procedural && typeof cfg.procedural === "object" && !Array.isArray(cfg.procedural)
      ? (cfg.procedural as Record<string, unknown>)
      : {};
  const proceduralMinCoerced = coerceNumber(rawProcedural.minOccurrences);
  const proceduralMinRaw =
    proceduralMinCoerced !== undefined
      ? Math.floor(proceduralMinCoerced)
      : 3;
  const successFloorRaw = coerceNumber(rawProcedural.successFloor);
  // Safer-by-default floor (issue #567 PR 3/5): raise from 0.7 to 0.75.
  // Miner promotion now requires a stricter trajectory success rate before
  // procedures become candidates, reducing false positives when procedural
  // recall is enabled by default in slice 4.
  const successFloor =
    successFloorRaw !== undefined &&
    successFloorRaw >= 0 &&
    successFloorRaw <= 1
      ? successFloorRaw
      : 0.75;
  const autoPromoteOccRaw = coerceNumber(rawProcedural.autoPromoteOccurrences);
  const autoPromoteOccurrences =
    autoPromoteOccRaw !== undefined && Number.isFinite(autoPromoteOccRaw)
      ? autoPromoteOccRaw <= 0
        ? 0
        : Math.min(10_000, Math.max(1, Math.floor(autoPromoteOccRaw)))
      : 8;
  const lookbackCoerced = coerceNumber(rawProcedural.lookbackDays);
  // Safer-by-default lookback (issue #567 PR 3/5): lower from 30 to 14 days.
  // Shorter window keeps mined procedures more recent, which improves
  // relevance once recall is on by default.
  const lookbackDays =
    lookbackCoerced !== undefined && Number.isFinite(lookbackCoerced)
      ? Math.min(3650, Math.max(1, Math.floor(lookbackCoerced)))
      : 14;
  const recallMaxCoerced = coerceNumber(rawProcedural.recallMaxProcedures);
  // Safer-by-default recall cap (issue #567 PR 3/5): lower from 3 to 2.
  // Cap the injected procedure block so enabling procedural recall by
  // default does not crowd out other recall sections.
  const recallMaxProcedures =
    recallMaxCoerced !== undefined && Number.isFinite(recallMaxCoerced)
      ? Math.min(10, Math.max(1, Math.floor(recallMaxCoerced)))
      : 2;
  const maintenance = parseProceduralMaintenanceConfig(rawProcedural.maintenance);
  const skillProjection = parseSkillProjectionConfig(rawProcedural.skillProjection);
  // Default-on procedural memory (issue #567 PR 4/5). Explicit false-ish values stay off. Unknown values throw.
  const rawEnabledValue = rawProcedural.enabled;
  let proceduralEnabled: boolean;
  if (rawEnabledValue === undefined) {
    proceduralEnabled = true;
  } else {
    const enabledCoerced = coerceBool(rawEnabledValue);
    if (enabledCoerced === undefined) {
      throw new Error(
        `procedural.enabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawEnabledValue)}). Omit the key to use the default-on behavior (issue #567 PR 4).`,
      );
    }
    proceduralEnabled = enabledCoerced;
  }
  const procedural: ProceduralConfig = {
    maintenance,
    enabled: proceduralEnabled,
    /** `0` skips all mining (`minOccurrences_zero`); otherwise clusters need at least this many members. */
    minOccurrences: Math.min(1000, Math.max(0, proceduralMinRaw)),
    successFloor,
    autoPromoteOccurrences,
    autoPromoteEnabled: coerceBool(rawProcedural.autoPromoteEnabled) === true,
    lookbackDays,
    proceduralMiningCronAutoRegister: coerceBool(rawProcedural.proceduralMiningCronAutoRegister) === true,
    recallMaxProcedures,
    skillProjection,
  };
  const wearables = parseWearablesConfig(cfg.wearables);
  const { activity, meetings, provenance } = parseCaptureCompanionConfigs(cfg);
  const location = parseLocationConfig(cfg.location);
  // Coding-agent project/branch scoping (issue #569)
  const rawCodingMode =
    cfg.codingMode && typeof cfg.codingMode === "object" && !Array.isArray(cfg.codingMode)
      ? (cfg.codingMode as Record<string, unknown>)
      : {};
  // Default: projectScope=true, branchScope=false (opt-in; CLAUDE.md #36).
  const codingProjectScopeRaw = coerceBool(rawCodingMode.projectScope);
  const codingBranchScopeRaw = coerceBool(rawCodingMode.branchScope);
  const codingGlobalFallbackRaw = coerceBool(rawCodingMode.globalFallback);
  const codingMode: CodingModeConfig = {
    projectScope: codingProjectScopeRaw === undefined ? true : codingProjectScopeRaw,
    branchScope: codingBranchScopeRaw === true,
    // Default true — project-scoped sessions include the root namespace in
    // read fallbacks so globally useful memories remain visible. CLAUDE.md #30.
    globalFallback: codingGlobalFallbackRaw === undefined ? true : codingGlobalFallbackRaw,
  };

  const memoryDir =
    typeof cfg.memoryDir === "string" && cfg.memoryDir.length > 0
      ? expandTildePath(cfg.memoryDir)
      : DEFAULT_MEMORY_DIR;
  const scopeProfiles = parseScopeProfiles(cfg.scopeProfiles);
  const teams = parseScopeTeams(cfg.teams);
  validateScopeProfileTeamReferences(scopeProfiles, teams);
  const defaultScopeProfile = (() => {
    if (cfg.defaultScopeProfile === undefined || cfg.defaultScopeProfile === null) {
      return undefined;
    }
    if (typeof cfg.defaultScopeProfile !== "string" || cfg.defaultScopeProfile.trim().length === 0) {
      throw new Error("defaultScopeProfile must be a non-empty string");
    }
    return cfg.defaultScopeProfile.trim();
  })();
  if (
    defaultScopeProfile !== undefined &&
    scopeProfiles[defaultScopeProfile] === undefined
  ) {
    throw new Error(`defaultScopeProfile references unknown scope profile: ${defaultScopeProfile}`);
  }
  const rawIdentityInjectionMode = cfg.identityInjectionMode as string | undefined;
  const identityInjectionMode: IdentityInjectionMode =
    rawIdentityInjectionMode
      && VALID_IDENTITY_INJECTION_MODES.includes(rawIdentityInjectionMode as IdentityInjectionMode)
      ? (rawIdentityInjectionMode as IdentityInjectionMode)
      : "recovery_only";
  const identityContinuityEnabled = cfg.identityContinuityEnabled === true;
  const sessionObserverBands: SessionObserverBandConfig[] = Array.isArray(cfg.sessionObserverBands)
    ? (cfg.sessionObserverBands as Array<Record<string, unknown>>)
        .map((band) => ({
          maxBytes:
            typeof band?.maxBytes === "number" ? Math.max(0, Math.floor(band.maxBytes)) : 0,
          triggerDeltaBytes:
            typeof band?.triggerDeltaBytes === "number"
              ? Math.max(0, Math.floor(band.triggerDeltaBytes))
              : 0,
          triggerDeltaTokens:
            typeof band?.triggerDeltaTokens === "number"
              ? Math.max(0, Math.floor(band.triggerDeltaTokens))
              : 0,
        }))
        .filter((band) => band.maxBytes > 0)
    : cloneDefaultSessionObserverBands();

  const principalRules: PrincipalRule[] = Array.isArray(cfg.principalFromSessionKeyRules)
    ? (cfg.principalFromSessionKeyRules as any[]).map((r) => ({
        match: typeof r?.match === "string" ? r.match : "",
        principal: typeof r?.principal === "string" ? r.principal : "",
      })).filter((r) => r.match.length > 0 && r.principal.length > 0)
    : [];
  const entitySchemas = normalizeEntitySchemas(cfg.entitySchemas);

  // Optional file hygiene (memory file limits / truncation risk mitigation)
  const rawHygiene =
    cfg.fileHygiene && typeof cfg.fileHygiene === "object" && !Array.isArray(cfg.fileHygiene)
      ? (cfg.fileHygiene as Record<string, unknown>)
      : undefined;
  const hygieneEnabled = rawHygiene?.enabled === true;
  const fileHygiene = hygieneEnabled
    ? {
        enabled: true,
        lintEnabled: rawHygiene?.lintEnabled !== false,
        lintBudgetBytes:
          typeof rawHygiene?.lintBudgetBytes === "number" ? rawHygiene.lintBudgetBytes : 20_000,
        lintWarnRatio:
          typeof rawHygiene?.lintWarnRatio === "number" ? rawHygiene.lintWarnRatio : 0.8,
        lintPaths: Array.isArray(rawHygiene?.lintPaths)
          ? (rawHygiene!.lintPaths as string[])
          : ["IDENTITY.md", "MEMORY.md"],
        rotateEnabled: rawHygiene?.rotateEnabled === true,
        rotateMaxBytes:
          typeof rawHygiene?.rotateMaxBytes === "number" ? rawHygiene.rotateMaxBytes : 18_000,
        rotateKeepTailChars:
          typeof rawHygiene?.rotateKeepTailChars === "number"
            ? rawHygiene.rotateKeepTailChars
            : 2000,
        rotatePaths: Array.isArray(rawHygiene?.rotatePaths)
          ? (rawHygiene!.rotatePaths as string[])
          : ["IDENTITY.md"],
        archiveDir:
          typeof rawHygiene?.archiveDir === "string" && rawHygiene.archiveDir.length > 0
            ? (rawHygiene.archiveDir as string)
            : ".engram-archive",
        runMinIntervalMs:
          typeof rawHygiene?.runMinIntervalMs === "number" ? rawHygiene.runMinIntervalMs : 5 * 60 * 1000,
        warningsLogEnabled: rawHygiene?.warningsLogEnabled === true,
        warningsLogPath:
          typeof rawHygiene?.warningsLogPath === "string" && rawHygiene.warningsLogPath.length > 0
            ? (rawHygiene.warningsLogPath as string)
            : "hygiene/warnings.md",
        indexEnabled: rawHygiene?.indexEnabled === true,
        indexPath:
          typeof rawHygiene?.indexPath === "string" && rawHygiene.indexPath.length > 0
            ? (rawHygiene.indexPath as string)
            : "ENGRAM_INDEX.md",
      }
    : undefined;

  const rawNativeKnowledge =
    cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" && !Array.isArray(cfg.nativeKnowledge)
      ? (cfg.nativeKnowledge as Record<string, unknown>)
      : undefined;
  const nativeKnowledge = rawNativeKnowledge?.enabled === true
    ? {
        enabled: true,
        includeFiles: Array.isArray(rawNativeKnowledge.includeFiles)
          ? (rawNativeKnowledge.includeFiles as unknown[])
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
          : ["IDENTITY.md", "MEMORY.md"],
        maxChunkChars:
          typeof rawNativeKnowledge.maxChunkChars === "number"
            ? Math.max(200, Math.floor(rawNativeKnowledge.maxChunkChars))
            : 900,
        maxResults:
          typeof rawNativeKnowledge.maxResults === "number"
            ? Math.max(0, Math.floor(rawNativeKnowledge.maxResults))
            : 4,
        maxChars:
          typeof rawNativeKnowledge.maxChars === "number"
            ? Math.max(0, Math.floor(rawNativeKnowledge.maxChars))
            : 2400,
        stateDir:
          normalizeMemoryRelativeDir(rawNativeKnowledge.stateDir, "state/native-knowledge"),
        openclawWorkspace:
          rawNativeKnowledge.openclawWorkspace &&
            typeof rawNativeKnowledge.openclawWorkspace === "object" &&
            !Array.isArray(rawNativeKnowledge.openclawWorkspace) &&
            (rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).enabled === true
            ? {
              enabled: true,
              bootstrapFiles: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).bootstrapFiles)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).bootstrapFiles as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["IDENTITY.md", "MEMORY.md", "USER.md"],
              handoffGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).handoffGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).handoffGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["**/*handoff*.md", "handoffs/**/*.md"],
              dailySummaryGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).dailySummaryGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).dailySummaryGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["**/*daily*summary*.md", "summaries/**/*.md"],
              automationNoteGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).automationNoteGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).automationNoteGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
              workspaceDocGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).workspaceDocGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).workspaceDocGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
              excludeGlobs: [
                ".git/**",
                "node_modules/**",
                "dist/**",
                "build/**",
                "coverage/**",
                "**/*.log",
                "**/.env*",
                "**/*.pem",
                "**/*.key",
                ...(Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).excludeGlobs)
                  ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).excludeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : []),
              ].filter((value, index, array) => array.indexOf(value) === index),
              sharedSafeGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).sharedSafeGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).sharedSafeGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
            }
            : undefined,
        obsidianVaults: Array.isArray(rawNativeKnowledge.obsidianVaults)
          ? (rawNativeKnowledge.obsidianVaults as unknown[])
            .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
            .map((vault, index) => {
              const defaultId = `vault-${index + 1}`;
              return {
                id:
                  typeof vault.id === "string" && vault.id.trim().length > 0
                    ? vault.id.trim()
                    : defaultId,
                rootDir:
                  typeof vault.rootDir === "string" && vault.rootDir.trim().length > 0
                    ? vault.rootDir.trim()
                    : "",
                includeGlobs: Array.isArray(vault.includeGlobs)
                  ? (vault.includeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : ["**/*.md"],
                excludeGlobs: Array.isArray(vault.excludeGlobs)
                  ? (vault.excludeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : [".obsidian/**", "**/*.canvas", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.pdf"],
                namespace:
                  typeof vault.namespace === "string" && vault.namespace.trim().length > 0
                    ? vault.namespace.trim()
                    : undefined,
                privacyClass:
                  typeof vault.privacyClass === "string" && vault.privacyClass.trim().length > 0
                    ? vault.privacyClass.trim()
                    : undefined,
                folderRules: Array.isArray(vault.folderRules)
                  ? (vault.folderRules as unknown[])
                    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
                    .map((rule) => ({
                      pathPrefix:
                        typeof rule.pathPrefix === "string" && rule.pathPrefix.trim().length > 0
                          ? rule.pathPrefix.trim()
                          : "",
                      namespace:
                        typeof rule.namespace === "string" && rule.namespace.trim().length > 0
                          ? rule.namespace.trim()
                          : undefined,
                      privacyClass:
                        typeof rule.privacyClass === "string" && rule.privacyClass.trim().length > 0
                          ? rule.privacyClass.trim()
                          : undefined,
                    }))
                    .filter((rule) => rule.pathPrefix.length > 0)
                  : [],
                dailyNotePatterns: Array.isArray(vault.dailyNotePatterns)
                  ? (vault.dailyNotePatterns as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : ["YYYY-MM-DD"],
                materializeBacklinks: vault.materializeBacklinks === true,
              };
            })
            .filter((vault) => vault.rootDir.length > 0)
          : [],
      }
    : undefined;

  const rawAgentAccessHttp =
    cfg.agentAccessHttp && typeof cfg.agentAccessHttp === "object" && !Array.isArray(cfg.agentAccessHttp)
      ? (cfg.agentAccessHttp as Record<string, unknown>)
      : undefined;
  const agentAccessAuthToken = parseAgentAccessAuthToken(rawAgentAccessHttp?.authToken);
  const agentAccessHttp = {
    enabled: rawAgentAccessHttp?.enabled === true,
    host:
      typeof rawAgentAccessHttp?.host === "string" && rawAgentAccessHttp.host.trim().length > 0
        ? rawAgentAccessHttp.host.trim()
        : "127.0.0.1",
    port: parsePortNumber(rawAgentAccessHttp?.port, 4318, "agentAccessHttp.port"),
    [["auth", "Token"].join("")]: agentAccessAuthToken,
    principal: parseAgentAccessPrincipal(rawAgentAccessHttp?.principal),
    maxBodyBytes:
      typeof rawAgentAccessHttp?.maxBodyBytes === "number"
        ? Math.max(1, Math.floor(rawAgentAccessHttp.maxBodyBytes))
        : 131072,
    writeRateLimitMaxRequests: resolvePositiveIntegerConfig(
      rawAgentAccessHttp?.writeRateLimitMaxRequests,
      30,
      "agentAccessHttp.writeRateLimitMaxRequests",
    ),
    writeRateLimitWindowMs: resolvePositiveIntegerConfig(
      rawAgentAccessHttp?.writeRateLimitWindowMs,
      60_000,
      "agentAccessHttp.writeRateLimitWindowMs",
    ),
  };

  let baseUrl: string | undefined;
  if (cfg.openaiBaseUrl !== undefined && typeof cfg.openaiBaseUrl !== "string") {
    throw new Error("openaiBaseUrl must be a string");
  }
  if (cfg.openaiBaseUrl !== undefined) {
    baseUrl = normalizeOpenaiBaseUrl(resolveEnvVars(cfg.openaiBaseUrl), "config");
  } else if (apiKey !== undefined) {
    baseUrl = normalizeOpenaiBaseUrl(readEnvVar("OPENAI_BASE_URL"), "env");
  }
  ({ baseUrl, apiKey } = applyLlmBridgeClientConfigPath(
    cfg,
    baseUrl,
    apiKey,
    openaiApiKeyDisabled,
  ));

  const sharedCrossSignalSemanticEnabled =
    cfg.sharedCrossSignalSemanticEnabled === true || cfg.crossSignalsSemanticEnabled === true;
  const sharedCrossSignalSemanticTimeoutMs =
    typeof cfg.sharedCrossSignalSemanticTimeoutMs === "number"
      ? Math.max(1, Math.floor(cfg.sharedCrossSignalSemanticTimeoutMs))
      : typeof cfg.crossSignalsSemanticTimeoutMs === "number"
        ? Math.max(1, Math.floor(cfg.crossSignalsSemanticTimeoutMs))
        : 4000;
  const recallPipelineConfig = buildRecallPipelineConfig(cfg);
  const maintenanceNamespaceFanoutEnabled = resolveBooleanConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceNamespaceFanoutEnabled",
      "maintenance",
      "namespaceFanoutEnabled",
    ),
    true,
    "maintenance.namespaceFanoutEnabled",
  );
  const maintenanceMaxNamespacesPerCycle = resolvePositiveIntegerConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceMaxNamespacesPerCycle",
      "maintenance",
      "maxNamespacesPerCycle",
    ),
    20,
    "maintenance.maxNamespacesPerCycle",
  );
  const maintenanceIncludeProjectNamespaces = resolveBooleanConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceIncludeProjectNamespaces",
      "maintenance",
      "includeProjectNamespaces",
    ),
    true,
    "maintenance.includeProjectNamespaces",
  );
  const maintenanceIncludeBranchNamespaces = resolveBooleanConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceIncludeBranchNamespaces",
      "maintenance",
      "includeBranchNamespaces",
    ),
    false,
    "maintenance.includeBranchNamespaces",
  );
  const maintenanceIncludeTeamProjectNamespaces = resolveBooleanConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceIncludeTeamProjectNamespaces",
      "maintenance",
      "includeTeamProjectNamespaces",
    ),
    true,
    "maintenance.includeTeamProjectNamespaces",
  );
  const maintenanceNamespaceLockStaleMs = resolvePositiveIntegerConfig(
    readFlatOrNestedConfig(
      cfg,
      "maintenanceNamespaceLockStaleMs",
      "maintenance",
      "namespaceLockStaleMs",
    ),
    10 * 60_000,
    "maintenance.namespaceLockStaleMs",
  );

  const { wikiMergeIntoRecall, qmdCollection, qmdColdCollection } =
    parseExternalWikiRecallGuard(cfg);

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl: baseUrl,
    model,
    reasoningEffort,
    triggerMode,
    ...parseSecurityConfig(cfg, rawOperatorConfig),
    bufferMaxTurns:
      typeof cfg.bufferMaxTurns === "number" ? cfg.bufferMaxTurns : 5,
    bufferMaxMinutes:
      typeof cfg.bufferMaxMinutes === "number" ? cfg.bufferMaxMinutes : 15,
    // Surprise-gated buffer flush (issue #563, D-MEM). See types.ts for
    // semantics. Default off so PR 2 ships as a pure no-op until an operator
    // opts in. PR 4 benchmarks the flag and may flip the default.
    //
    // Use `coerceBool` rather than a strict `=== true` check: CLI operators
    // set booleans via `--config bufferSurpriseTriggerEnabled=true` which
    // arrives as the string `"true"` — the strict form would silently
    // leave the flag off. Matches the coercion contract established for
    // other boolean config keys (CLAUDE.md rule #36).
    bufferSurpriseTriggerEnabled:
      coerceBool(cfg.bufferSurpriseTriggerEnabled) === true,
    // Numeric surprise knobs go through `coerceNumber` so CLI operators
    // can pass `--config bufferSurpriseThreshold=0.5` without the string
    // silently dropping to the default. Matches the coercion contract
    // applied to other numeric config keys (CLAUDE.md rule #28).
    bufferSurpriseThreshold: clampSurpriseThreshold(
      coerceNumber(cfg.bufferSurpriseThreshold),
      0.35,
    ),
    bufferSurpriseK: clampSurpriseK(
      coerceNumber(cfg.bufferSurpriseK),
      5,
    ),
    bufferSurpriseRecentMemoryCount: clampSurpriseRecentMemoryCount(
      coerceNumber(cfg.bufferSurpriseRecentMemoryCount),
      20,
    ),
    bufferSurpriseProbeTimeoutMs: clampSurpriseProbeTimeoutMs(
      coerceNumber(cfg.bufferSurpriseProbeTimeoutMs),
      2000,
    ),
    consolidateEveryN:
      typeof cfg.consolidateEveryN === "number" ? cfg.consolidateEveryN : 3,
    highSignalPatterns: Array.isArray(cfg.highSignalPatterns)
      ? (cfg.highSignalPatterns as string[])
      : [],
    maxMemoryTokens:
      typeof cfg.maxMemoryTokens === "number" ? cfg.maxMemoryTokens : 2000,
    memoryOsPreset,
    qmdEnabled: cfg.qmdEnabled !== false,
    qmdCollection,
    wikiMergeIntoRecall,
    qmdMaxResults:
      typeof cfg.qmdMaxResults === "number" ? cfg.qmdMaxResults : 8,
    qmdEmbeddingBacklogThreshold: (() => {
      const raw = cfg.qmdEmbeddingBacklogThreshold;
      const n = typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;
      return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : 1000;
    })(),
    qmdColdTierEnabled: cfg.qmdColdTierEnabled === true,
    qmdColdCollection,
    qmdColdMaxResults:
      typeof cfg.qmdColdMaxResults === "number" ? cfg.qmdColdMaxResults : 8,
    // Issue #678 PR 2/4: gate hot/cold tier migration (a deep-sleep activity)
    // on dreams.phases.deepSleep.enabled. When deep sleep is disabled,
    // tier migration is forced off regardless of legacy flag.
    qmdTierMigrationEnabled: dreamsDeepSleep.enabled && cfg.qmdTierMigrationEnabled === true,
    qmdTierDemotionMinAgeDays:
      typeof cfg.qmdTierDemotionMinAgeDays === "number"
        ? Math.max(0, Math.floor(cfg.qmdTierDemotionMinAgeDays))
        : 14,
    qmdTierDemotionValueThreshold:
      typeof cfg.qmdTierDemotionValueThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.qmdTierDemotionValueThreshold))
        : 0.35,
    qmdTierPromotionValueThreshold:
      typeof cfg.qmdTierPromotionValueThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.qmdTierPromotionValueThreshold))
        : 0.7,
    qmdTierParityGraphEnabled: cfg.qmdTierParityGraphEnabled !== false,
    qmdTierParityHiMemEnabled: cfg.qmdTierParityHiMemEnabled !== false,
    qmdTierAutoBackfillEnabled: cfg.qmdTierAutoBackfillEnabled === true,
    qmdSupportedVersion: parseQmdSupportedVersion(cfg.qmdSupportedVersion),
    qmdAutoUpgradeEnabled: coerceBool(cfg.qmdAutoUpgradeEnabled) === true,
    qmdAutoUpgradeCheckIntervalMs: parseBoundedIntegerMs(
      cfg.qmdAutoUpgradeCheckIntervalMs,
      24 * 60 * 60_000,
      60_000,
      30 * 24 * 60 * 60_000,
    ),
    qmdChunkStrategy: parseQmdChunkStrategy(cfg.qmdChunkStrategy),
    qmdCandidateLimit: parsePositiveInteger(cfg.qmdCandidateLimit, "qmdCandidateLimit"),
    qmdQueryRerankEnabled: coerceBooleanLike(cfg.qmdQueryRerankEnabled) ?? true,
    qmdSearchStrategy: parseQmdSearchStrategy(cfg.qmdSearchStrategy),
    qmdSubprocessStrategy: parseQmdSubprocessStrategy(cfg.qmdSubprocessStrategy),
    qmdDaemonTimeoutMs: parseQmdDaemonTimeoutMs(cfg.qmdDaemonTimeoutMs),
    qmdIndexName: parseOptionalNonEmptyString(cfg.qmdIndexName),
    qmdForceCpu: coerceBooleanLike(cfg.qmdForceCpu) ?? false,
    qmdGpuBackend: parseQmdGpuBackend(cfg.qmdGpuBackend),
    qmdEmbedParallelism: parseBoundedPositiveInteger(
      cfg.qmdEmbedParallelism,
      1,
      8,
      "qmdEmbedParallelism",
    ),
    qmdEmbedModel: parseOptionalNonEmptyString(cfg.qmdEmbedModel),
    qmdRerankModel: parseOptionalNonEmptyString(cfg.qmdRerankModel),
    qmdGenerateModel: parseOptionalNonEmptyString(cfg.qmdGenerateModel),
    embeddingFallbackEnabled: cfg.embeddingFallbackEnabled !== false,
    embeddingFallbackProvider:
      cfg.embeddingFallbackProvider === "openai"
        ? "openai"
        : cfg.embeddingFallbackProvider === "local"
          ? "local"
          : "auto",
    hostEmbeddingProviderEnabled:
      coerceBooleanLike(cfg.hostEmbeddingProviderEnabled) ??
      coerceBooleanLike(cfg.openclawHostEmbeddingProviderEnabled) ??
      true,
    hostEmbeddingProviderId:
      parseOptionalNonEmptyString(cfg.hostEmbeddingProviderId) ??
      parseOptionalNonEmptyString(cfg.openclawHostEmbeddingProviderId),
    hostEmbeddingProviderModel:
      parseOptionalNonEmptyString(cfg.hostEmbeddingProviderModel) ??
      parseOptionalNonEmptyString(cfg.openclawHostEmbeddingProviderModel),
    embeddingFallbackModel:
      typeof cfg.embeddingFallbackModel === "string" && cfg.embeddingFallbackModel.length > 0
        ? cfg.embeddingFallbackModel
        : "",
    qmdPath:
      typeof cfg.qmdPath === "string" && cfg.qmdPath.length > 0
        ? cfg.qmdPath
        : undefined,
    memoryDir,
    externalWikis: parseExternalWikiRoots(cfg.externalWikis, memoryDir),
    debug: cfg.debug === true,
    identityEnabled: cfg.identityEnabled !== false,
    identityContinuityEnabled,
    identityInjectionMode,
    identityMaxInjectChars:
      typeof cfg.identityMaxInjectChars === "number"
        ? Math.max(0, Math.floor(cfg.identityMaxInjectChars))
        : 1200,
    continuityIncidentLoggingEnabled:
      typeof cfg.continuityIncidentLoggingEnabled === "boolean"
        ? cfg.continuityIncidentLoggingEnabled
        : identityContinuityEnabled,
    continuityAuditEnabled: cfg.continuityAuditEnabled === true,
    sessionObserverEnabled: cfg.sessionObserverEnabled === true,
    sessionObserverDebounceMs:
      typeof cfg.sessionObserverDebounceMs === "number"
        ? Math.max(0, Math.floor(cfg.sessionObserverDebounceMs))
        : 120_000,
    // Explicit validation (issue #1909 review round 8): reject invalid input
    // rather than flooring/clamping. Must be an integer in [0, 2^31-1] (Node's
    // setTimeout ceiling); 0 = save every turn; undefined → 3000.
    bufferSaveDebounceMs: parseIntegerInClosedRange(
      cfg.bufferSaveDebounceMs,
      0,
      2_147_483_647,
      3_000,
      "bufferSaveDebounceMs",
    ),
    sessionObserverBands,
    injectQuestions: cfg.injectQuestions === true,
    commitmentDecayDays: parseIntegerAtLeast(
      cfg.commitmentDecayDays,
      90,
      1,
      "commitmentDecayDays",
    ),
    workspaceDir:
      typeof cfg.workspaceDir === "string" && cfg.workspaceDir.length > 0
        ? expandTildePath(cfg.workspaceDir)
        : DEFAULT_WORKSPACE_DIR,
    captureMode,
    fileHygiene,
    nativeKnowledge,
    agentAccessHttp,
    // Access tracking (Phase 1A)
    accessTrackingEnabled: cfg.accessTrackingEnabled !== false,
    accessTrackingBufferMaxSize:
      typeof cfg.accessTrackingBufferMaxSize === "number"
        ? cfg.accessTrackingBufferMaxSize
        : 100,
    // Retrieval options
    recencyWeight:
      typeof cfg.recencyWeight === "number" ? cfg.recencyWeight : 0.2,
    boostAccessCount: cfg.boostAccessCount !== false,
    recordEmptyRecallImpressions: cfg.recordEmptyRecallImpressions === true,
    // v2.2 Advanced Retrieval (safe defaults: off unless enabled)
    queryExpansionEnabled: cfg.queryExpansionEnabled === true,
    queryExpansionMaxQueries:
      typeof cfg.queryExpansionMaxQueries === "number"
        ? cfg.queryExpansionMaxQueries
        : 4,
    queryExpansionMinTokenLen:
      typeof cfg.queryExpansionMinTokenLen === "number"
        ? cfg.queryExpansionMinTokenLen
        : 3,
    rerankEnabled: cfg.rerankEnabled === true,
    rerankProvider:
      cfg.rerankProvider === "cloud" ? "cloud" : "local",
    rerankMaxCandidates:
      typeof cfg.rerankMaxCandidates === "number" ? cfg.rerankMaxCandidates : 20,
    rerankTimeoutMs:
      typeof cfg.rerankTimeoutMs === "number" ? cfg.rerankTimeoutMs : 8000,
    rerankCacheEnabled: cfg.rerankCacheEnabled !== false,
    rerankCacheTtlMs:
      typeof cfg.rerankCacheTtlMs === "number" ? cfg.rerankCacheTtlMs : 60 * 60 * 1000,
    feedbackEnabled: cfg.feedbackEnabled === true,
    // v2.2 Negative Examples (safe defaults: off unless enabled)
    negativeExamplesEnabled: cfg.negativeExamplesEnabled === true,
    negativeExamplesPenaltyPerHit:
      typeof cfg.negativeExamplesPenaltyPerHit === "number"
        ? cfg.negativeExamplesPenaltyPerHit
        : 0.05,
    negativeExamplesPenaltyCap:
      typeof cfg.negativeExamplesPenaltyCap === "number"
        ? cfg.negativeExamplesPenaltyCap
        : 0.25,
    // Chunking (Phase 2A)
    chunkingEnabled: cfg.chunkingEnabled === true, // Off by default initially
    chunkingTargetTokens:
      typeof cfg.chunkingTargetTokens === "number" ? cfg.chunkingTargetTokens : 200,
    chunkingMinTokens:
      typeof cfg.chunkingMinTokens === "number" ? cfg.chunkingMinTokens : 150,
    chunkingOverlapSentences:
      typeof cfg.chunkingOverlapSentences === "number" ? cfg.chunkingOverlapSentences : 2,
    // Semantic Chunking (Issue #368)
    semanticChunkingEnabled: cfg.semanticChunkingEnabled === true,
    semanticChunkingConfig: parseSemanticChunkingConfig(cfg.semanticChunkingConfig),
    // Contradiction Detection (Phase 2B)
    contradictionDetectionEnabled: cfg.contradictionDetectionEnabled === true, // Off by default initially
    contradictionSimilarityThreshold:
      typeof cfg.contradictionSimilarityThreshold === "number" ? cfg.contradictionSimilarityThreshold : 0.7,
    contradictionMinConfidence:
      typeof cfg.contradictionMinConfidence === "number" ? cfg.contradictionMinConfidence : 0.9,
    contradictionLocalization: parseContradictionLocalizationConfig(cfg.contradictionLocalization),
    contradictionAutoResolve: cfg.contradictionAutoResolve !== false,
    // Contradiction Scan cron (issue #520)
    contradictionScan: parseContradictionScanConfig(cfg.contradictionScan),
    // Preference drift detection (issue #2371)
    driftDetection: parseDriftDetectionConfig(cfg.driftDetection),
    // Budgeted deep-recall surface (issue #2332)
    deepRecall: parseDeepRecallConfig(cfg.deepRecall),
    dependencyPropagation: parseDependencyPropagationConfig(cfg),
    // Temporal Supersession (issue #375)
    temporalSupersessionEnabled: cfg.temporalSupersessionEnabled !== false, // On by default
    temporalSupersessionIncludeInRecall:
      cfg.temporalSupersessionIncludeInRecall === true, // Off by default
    // Bi-temporal validity (issue #1578). Default `false` so recall behaves
    // byte-identically to pre-#1578 until an operator opts in. Uses coerceBool
    // (same as recallDirectAnswerEnabled below) so CLI string "true" works.
    //
    // CURRENT scope (this PR): the recall injection filter (expired-validity
    // facts leave default injection but stay findable by explicit search and
    // as_of queries) + the observedAt/eventTimeSource storage fields. The
    // extraction prompt → resolveEventTime write-time wiring lands in a
    // follow-on PR; until then, enabling the gate exercises the filter and
    // storage round-trip but new extractions are not yet event-time-resolved
    // (docs kept honest — review: wire resolver before exposing the gate).
    temporalBiTemporal: coerceBool(cfg.temporalBiTemporal) ?? false,
    temporalExpiredInInjection: coerceBool(cfg.temporalExpiredInInjection) ?? false,
    // Correction Contract (issue #1580). Parsed here so operators can actually
    // set the documented toggles/limits (review thread Txp): parseConfig builds
    // an explicit output, so without these lines the raw `correction` block /
    // flat legacy keys are dropped and the runtime always sees defaults. Nested
    // `correction.<key>` wins; flat `correction<Key>` is the legacy fallback.
    correctionEnabled: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.enabled;
      const raw = nested !== undefined ? nested : cfg.correctionEnabled;
      if (raw === undefined || raw === null) return true;
      const v = coerceBool(raw);
      if (v === undefined) {
        throw new Error(`Invalid correction.enabled: expected a boolean, got ${JSON.stringify(raw)}`);
      }
      return v;
    })(),
    correctionApplyRequiresConfirm: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.applyRequiresConfirm;
      const raw = nested !== undefined ? nested : cfg.correctionApplyRequiresConfirm;
      if (raw === undefined || raw === null) return true;
      const v = coerceBool(raw);
      if (v === undefined) {
        throw new Error(`Invalid correction.applyRequiresConfirm: expected a boolean, got ${JSON.stringify(raw)}`);
      }
      return v;
    })(),
    correctionMaxAffected: (() => {
      const rawNested = (cfg.correction as Record<string, unknown> | undefined)?.maxAffected;
      const raw = rawNested !== undefined ? rawNested : cfg.correctionMaxAffected;
      if (raw === undefined || raw === null) return 10;
      const n = coerceNumber(raw);
      // #1678 (thread Oiup6): the error message says "integer" — enforce it
      // with Number.isInteger so 3.7 is rejected rather than silently floored.
      if (n === undefined || !Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        throw new Error(`Invalid correction.maxAffected: expected an integer >= 1, got ${JSON.stringify(raw)}`);
      }
      return n;
    })(),
    correctionPlanTtlHours: (() => {
      const nested = (cfg.correction as Record<string, unknown> | undefined)?.planTtlHours;
      const fromNested = nested !== undefined ? coerceNumber(nested) : undefined;
      if (fromNested !== undefined && fromNested >= 1) return fromNested;
      // #1678 (threads Ohtvi/Ohyvf): reject invalid (0/negative/non-numeric)
      // instead of silently defaulting to 24h — completes the config-reject
      // class already enforced for enabled/applyRequiresConfirm/maxAffected.
      if (nested !== undefined && fromNested === undefined) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(nested)}`);
      }
      if (fromNested !== undefined && fromNested < 1) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(nested)}`);
      }
      const fromFlat = coerceNumber(cfg.correctionPlanTtlHours);
      if (fromFlat !== undefined && fromFlat >= 1) return fromFlat;
      if (cfg.correctionPlanTtlHours !== undefined && fromFlat === undefined) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(cfg.correctionPlanTtlHours)}`);
      }
      if (fromFlat !== undefined && fromFlat < 1) {
        throw new Error(`Invalid correction.planTtlHours: expected a number >= 1, got ${JSON.stringify(cfg.correctionPlanTtlHours)}`);
      }
      return 24;
    })(),
    // Passive correction capture (issue #1581). Parsed from
    // `correctionCapture.<key>` (nested) or flat legacy keys. Default "off" —
    // operators opt in (rule 48). Invalid mode → rejected listing options (rule 51).
    correctionCaptureMode: (() => {
      const nested = (cfg.correctionCapture as Record<string, unknown> | undefined)?.mode;
      const raw = nested !== undefined ? nested : cfg.correctionCaptureMode;
      if (raw === undefined || raw === null) return "off" as const;
      if (raw === "off" || raw === "queue" || raw === "auto") return raw;
      throw new Error(
        `Invalid correctionCapture.mode: expected one of "off", "queue", "auto", got ${JSON.stringify(raw)}`,
      );
    })(),
    correctionCaptureConfidenceFloor: (() => {
      const nested = (cfg.correctionCapture as Record<string, unknown> | undefined)?.confidenceFloor;
      const raw = nested !== undefined ? nested : cfg.correctionCaptureConfidenceFloor;
      if (raw === undefined || raw === null) return 0.85;
      const n = coerceNumber(raw);
      if (n === undefined || !Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`Invalid correctionCapture.confidenceFloor: expected a number in [0, 1], got ${JSON.stringify(raw)}`);
      }
      return n;
    })(),
    correctionCaptureAutoApplyMaxAffected: (() => {
      const nested = (cfg.correctionCapture as Record<string, unknown> | undefined)?.autoApplyMaxAffected;
      const raw = nested !== undefined ? nested : cfg.correctionCaptureAutoApplyMaxAffected;
      if (raw === undefined || raw === null) return 2;
      const n = coerceNumber(raw);
      if (n === undefined || !Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid correctionCapture.autoApplyMaxAffected: expected an integer >= 1, got ${JSON.stringify(raw)}`);
      }
      return Math.floor(n);
    })(),
    // Tombstones — non-resurrection invariant (issue #1579). The invariant is
    // the point, so it ships ON by default; `false` restores pre-feature
    // behavior for rollback safety (rule 30). Uses coerceBool so CLI string
    // "false" / "0" disable it (CLAUDE.md §24).
    tombstonesEnabled: coerceBool(cfg.tombstonesEnabled) ?? true,
    tombstonesSemanticMatch: coerceBool(cfg.tombstonesSemanticMatch) ?? false,
    tombstonesSemanticThreshold: (() => {
      const n = coerceNumber(cfg.tombstonesSemanticThreshold);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.9;
    })(),
    // Direct-answer retrieval tier (issue #518).  Default off so the
    // recall path keeps least-privileged behavior unless operators
    // explicitly opt in.
    recallDirectAnswerEnabled:
      coerceBool(cfg.recallDirectAnswerEnabled) ?? false,
    // Disclosure auto-escalation (issue #677 PR 4/4).  Default `manual`
    // so pre-#677 callers see unchanged behavior.  Reject anything
    // outside the allow-list rather than silently defaulting (CLAUDE.md
    // rule 51).
    recallDisclosureEscalation: (() => {
      const raw = cfg.recallDisclosureEscalation;
      if (raw === undefined || raw === null) return "manual" as const;
      if (raw === "manual" || raw === "auto") return raw;
      throw new Error(
        `recallDisclosureEscalation must be "manual" or "auto" (got ${JSON.stringify(raw)}).`,
      );
    })(),
    recallDisclosureEscalationThreshold: (() => {
      const n = coerceNumber(cfg.recallDisclosureEscalationThreshold);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.5;
    })(),
    // Graph-based retrieval tier (issue #559 PR 4).  Default `false` —
    // the tier ships off pending the `retrieval-graph` bench in PR 5.
    recallGraphEnabled:
      coerceBool(cfg.recallGraphEnabled) ?? false,
    recallGraphDamping: (() => {
      const n = coerceNumber(cfg.recallGraphDamping);
      return n !== undefined && n >= 0 && n < 1 ? n : 0.85;
    })(),
    // Fractional integer values (e.g. `0.5`) are REJECTED rather than
    // silently floored to zero — CLAUDE.md rule 51 ("Reject invalid
    // user input instead of silently defaulting"). Users who set a
    // fractional iteration cap almost certainly meant an integer and
    // quietly flooring their value to 0 turns off the tier without
    // warning.
    recallGraphIterations: (() => {
      if (cfg.recallGraphIterations === undefined) return 20;
      const n = coerceNumber(cfg.recallGraphIterations);
      if (n === undefined || !Number.isFinite(n) || n < 0 || n > 500) {
        throw new Error(
          `recallGraphIterations must be an integer in [0, 500] (got ${JSON.stringify(cfg.recallGraphIterations)}).`,
        );
      }
      if (!Number.isInteger(n)) {
        throw new Error(
          `recallGraphIterations must be an integer (got fractional value ${n}).`,
        );
      }
      return n;
    })(),
    recallGraphTopK: (() => {
      if (cfg.recallGraphTopK === undefined) return 50;
      const n = coerceNumber(cfg.recallGraphTopK);
      if (n === undefined || !Number.isFinite(n) || n < 0 || n > 10000) {
        throw new Error(
          `recallGraphTopK must be an integer in [0, 10000] (got ${JSON.stringify(cfg.recallGraphTopK)}).`,
        );
      }
      if (!Number.isInteger(n)) {
        throw new Error(
          `recallGraphTopK must be an integer (got fractional value ${n}).`,
        );
      }
      return n;
    })(),
    recallDirectAnswerTokenOverlapFloor: (() => {
      const n = coerceNumber(cfg.recallDirectAnswerTokenOverlapFloor);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.55;
    })(),
    recallDirectAnswerImportanceFloor: (() => {
      const n = coerceNumber(cfg.recallDirectAnswerImportanceFloor);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.7;
    })(),
    recallDirectAnswerAmbiguityMargin: (() => {
      const n = coerceNumber(cfg.recallDirectAnswerAmbiguityMargin);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.15;
    })(),
    recallDirectAnswerEligibleTaxonomyBuckets: Array.isArray(
      cfg.recallDirectAnswerEligibleTaxonomyBuckets,
    )
      ? (cfg.recallDirectAnswerEligibleTaxonomyBuckets as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
      : ["decisions", "principles", "conventions", "runbooks", "entities"],
    // Cross-namespace query-budget limiter (issue #565 PR 4/5). Defaults to
    // false — ships disabled; when enabled, throttles cross-namespace recall bursts.
    recallCrossNamespaceBudgetEnabled:
      coerceBool(cfg.recallCrossNamespaceBudgetEnabled) ?? false,
    recallCrossNamespaceBudgetWindowMs: (() => {
      const n = coerceNumber(cfg.recallCrossNamespaceBudgetWindowMs);
      return n !== undefined && n > 0 ? Math.floor(n) : 60_000;
    })(),
    recallCrossNamespaceBudgetSoftLimit: (() => {
      const n = coerceNumber(cfg.recallCrossNamespaceBudgetSoftLimit);
      return n !== undefined && n >= 0 ? Math.floor(n) : 10;
    })(),
    recallCrossNamespaceBudgetHardLimit: (() => {
      const n = coerceNumber(cfg.recallCrossNamespaceBudgetHardLimit);
      return n !== undefined && n > 0 ? Math.floor(n) : 30;
    })(),
    ...parseRecallConcurrencyConfig(cfg),
    // Recall-audit anomaly detector (issue #565 PR 5/5). Defaults off so
    // existing deployments are unaffected; enable explicitly to let the
    // access surfaces flag suspicious query patterns derived from the
    // audit trail. Thresholds floor AFTER validating the floored value
    // is still >= 1 — a `0.5` input that floors to 0 would turn every
    // detector into a flood-on-anything, flipping the default to
    // max-noise instead of max-silence.
    recallAuditAnomalyDetectionEnabled:
      coerceBool(cfg.recallAuditAnomalyDetectionEnabled) ?? false,
    recallAuditAnomalyWindowMs: (() => {
      const n = coerceNumber(cfg.recallAuditAnomalyWindowMs);
      if (n === undefined) return 5 * 60_000;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : 5 * 60_000;
    })(),
    recallAuditAnomalyRepeatQueryLimit: (() => {
      const n = coerceNumber(cfg.recallAuditAnomalyRepeatQueryLimit);
      if (n === undefined) return 5;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : 5;
    })(),
    recallAuditAnomalyNamespaceWalkLimit: (() => {
      const n = coerceNumber(cfg.recallAuditAnomalyNamespaceWalkLimit);
      if (n === undefined) return 3;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : 3;
    })(),
    recallAuditAnomalyHighCardinalityLimit: (() => {
      const n = coerceNumber(cfg.recallAuditAnomalyHighCardinalityLimit);
      if (n === undefined) return 50;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : 50;
    })(),
    recallAuditAnomalyRapidFireLimit: (() => {
      const n = coerceNumber(cfg.recallAuditAnomalyRapidFireLimit);
      if (n === undefined) return 30;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : 30;
    })(),

    // Memory Worth recall filter (issue #560 PR 4, default flipped in PR 5).
    // Bench result on the seeded fixture: precision@5 lifts from 0.00 to
    // 0.60 across all 50 cases with zero regressions. See
    // `runMemoryWorthBench` in memory-worth-bench.ts. Operators can still
    // opt out with recallMemoryWorthFilterEnabled=false.
    recallMemoryWorthFilterEnabled:
      coerceBool(cfg.recallMemoryWorthFilterEnabled) ?? true,
    // Trust/Memory-Worth recall stage corpus-level fallback (issue #1905).
    // Default true: when a candidate is missing from the frontmatter already
    // loaded on the hot recall path, the stage may fall back to a per-namespace
    // corpus counter/signal map (version-keyed, so it hits in steady state).
    // Set false to disable that O(corpus) fallback entirely — the stage then
    // uses only the preloaded frontmatter plus a bounded-parallel per-candidate
    // direct read (fully O(candidates)). coerceBool handles "false"/"0" forms.
    recallTrustStageCorpusFallbackEnabled:
      coerceBool(cfg.recallTrustStageCorpusFallbackEnabled) ?? true,
    // Hot-memories result cache (issue #1902). Default on: readAllMemories()
    // serves from the version-keyed in-process corpus cache. coerceBool
    // handles "false"/"0" string forms; set false to force disk scans.
    hotMemoriesCacheEnabled: coerceBool(cfg.hotMemoriesCacheEnabled) ?? true,
    // Scope-aware cache invalidation (issue #1904). Default on: a plain fact
    // create no longer nukes the QMD/entity caches it can't affect. coerceBool
    // handles "false"/"0" string forms; set false to restore full-clear-per-write.
    scopedCacheInvalidationEnabled: coerceBool(cfg.scopedCacheInvalidationEnabled) ?? true,
    // External-edit safety net (issue #1902): the version sentinel gives
    // immediate coherence for cooperating writers, but direct user/git/editor
    // writes to memory files (which the project supports) don't bump it. Bound
    // the hot cache's staleness with a TTL so such edits self-heal. Default 60s;
    // 0 disables the TTL (version invalidation only — max perf for pure-daemon
    // deployments with no external edits). coerceNumber handles string forms.
    hotMemoriesCacheTtlMs: (() => {
      const n = coerceNumber(cfg.hotMemoriesCacheTtlMs);
      return n !== undefined && n >= 0 ? n : 60_000;
    })(),
    recallMemoryWorthHalfLifeMs: (() => {
      const n = coerceNumber(cfg.recallMemoryWorthHalfLifeMs);
      return n !== undefined && n >= 0 ? n : 0;
    })(),
    // Unified TrustScore recall stage (issue #1577). Default off: the stage
    // is absent and ranking is byte-identical to the pre-feature pipeline
    // (rule 39). Flip the master gate via #1574 ablation evidence only.
    trustScoreEnabled: coerceBool(cfg.trustScoreEnabled) ?? false,
    // Epistemic rendering ships behind its own gate so scoring can land first.
    trustScoreEpistemicRendering: coerceBool(cfg.trustScoreEpistemicRendering) ?? false,
    // Quarantine defaults on (only effective under the master gate); keeps
    // hard negatives out of injection but visible in X-ray (rule 34).
    trustScoreQuarantine: coerceBool(cfg.trustScoreQuarantine) ?? true,
    trustScoreMinMultiplier: (() => {
      const n = coerceNumber(cfg.trustScoreMinMultiplier);
      return n !== undefined && n >= 0 && n <= 1 ? n : 0.5;
    })(),
    trustScoreMaxMultiplier: (() => {
      const n = coerceNumber(cfg.trustScoreMaxMultiplier);
      return n !== undefined && n >= 1 && n <= 4 ? n : 1.25;
    })(),
    // Per-component weights. Accept a nested object from config; invalid
    // entries (non-finite, outside [0,1]) are dropped by resolveTrustWeights,
    // which falls back to the documented defaults (rule 51).
    trustScoreWeights: parseTrustScoreWeights(cfg.trustScoreWeights),
    // Memory Linking (Phase 3A)
    memoryLinkingEnabled: cfg.memoryLinkingEnabled === true, // Off by default initially
    // Conversation Threading (Phase 3B)
    threadingEnabled: cfg.threadingEnabled === true, // Off by default initially
    threadingGapMinutes:
      typeof cfg.threadingGapMinutes === "number" ? cfg.threadingGapMinutes : 30,
    // Memory Summarization (Phase 4A)
    summarizationEnabled: cfg.summarizationEnabled === true, // Off by default
    summarizationTriggerCount:
      typeof cfg.summarizationTriggerCount === "number" ? cfg.summarizationTriggerCount : 1000,
    summarizationRecentToKeep:
      typeof cfg.summarizationRecentToKeep === "number" ? cfg.summarizationRecentToKeep : 300,
    summarizationImportanceThreshold:
      typeof cfg.summarizationImportanceThreshold === "number" ? cfg.summarizationImportanceThreshold : 0.3,
    summarizationProtectedTags: Array.isArray(cfg.summarizationProtectedTags)
      ? (cfg.summarizationProtectedTags as string[])
      : ["commitment", "preference", "decision", "principle"],
    // Topic Extraction (Phase 4B)
    topicExtractionEnabled: cfg.topicExtractionEnabled !== false, // On by default
    topicExtractionTopN:
      typeof cfg.topicExtractionTopN === "number" ? cfg.topicExtractionTopN : 50,
    // Transcript & Context Preservation (v2.0)
    // Transcript archive
    transcriptEnabled: cfg.transcriptEnabled !== false, // default: true
    transcriptRetentionDays:
      typeof cfg.transcriptRetentionDays === "number" ? cfg.transcriptRetentionDays : 7,
    transcriptSkipChannelTypes: Array.isArray(cfg.transcriptSkipChannelTypes)
      ? (cfg.transcriptSkipChannelTypes as string[])
      : ["cron"], // default: skip cron transcripts
    // Transcript injection
    transcriptRecallHours:
      typeof cfg.transcriptRecallHours === "number" ? cfg.transcriptRecallHours : 12,
    maxTranscriptTurns:
      typeof cfg.maxTranscriptTurns === "number" ? cfg.maxTranscriptTurns : 50,
    maxTranscriptTokens:
      typeof cfg.maxTranscriptTokens === "number" ? cfg.maxTranscriptTokens : 1000,
    // Checkpoint
    checkpointEnabled: cfg.checkpointEnabled !== false, // default: true
    checkpointTurns:
      typeof cfg.checkpointTurns === "number" ? cfg.checkpointTurns : 15,
    // Compaction reset (opt-in, default: false)
    compactionResetEnabled: cfg.compactionResetEnabled === true,
    beforeResetTimeoutMs:
      typeof cfg.beforeResetTimeoutMs === "number"
        ? Math.min(30_000, Math.max(100, Math.floor(cfg.beforeResetTimeoutMs)))
        : 2_000,
    initGateTimeoutMs: parseBoundedIntegerMs(
      cfg.initGateTimeoutMs,
      DEFAULT_INIT_GATE_TIMEOUT_MS,
      1_000,
      120_000,
    ),
    flushOnResetEnabled: cfg.flushOnResetEnabled !== false,
    commandsListEnabled: cfg.commandsListEnabled !== false,
    openclawToolsEnabled: cfg.openclawToolsEnabled !== false,
    openclawToolSnippetMaxChars:
      typeof cfg.openclawToolSnippetMaxChars === "number"
        ? Math.min(4_000, Math.max(80, Math.floor(cfg.openclawToolSnippetMaxChars)))
        : 600,
    openclawMessageReceivedCaptureEnabled:
      coerceBooleanLike(cfg.openclawMessageReceivedCaptureEnabled) ?? true,
    openclawReplyMetadataCaptureEnabled:
      coerceBooleanLike(cfg.openclawReplyMetadataCaptureEnabled) ?? true,
    openclawReplyMetadataExtractionHintsEnabled:
      coerceBooleanLike(cfg.openclawReplyMetadataExtractionHintsEnabled) ?? false,
    openclawChannelEnvelopeCleaningEnabled:
      coerceBooleanLike(cfg.openclawChannelEnvelopeCleaningEnabled) ?? true,
    sessionTogglesEnabled: cfg.sessionTogglesEnabled !== false,
    verboseRecallVisibility: cfg.verboseRecallVisibility !== false,
    recallTranscriptsEnabled: cfg.recallTranscriptsEnabled === true,
    recallTranscriptRetentionDays:
      typeof cfg.recallTranscriptRetentionDays === "number"
        ? Math.min(365, Math.max(1, Math.floor(cfg.recallTranscriptRetentionDays)))
        : 30,
    respectBundledActiveMemoryToggle:
      cfg.respectBundledActiveMemoryToggle !== false,
    activeRecallEnabled: cfg.activeRecallEnabled === true,
    activeRecallAgents:
      Array.isArray(cfg.activeRecallAgents) && cfg.activeRecallAgents.length > 0
        ? cfg.activeRecallAgents
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim())
        : null,
    activeRecallAllowedChatTypes:
      Array.isArray(cfg.activeRecallAllowedChatTypes) &&
      cfg.activeRecallAllowedChatTypes.length > 0
        ? cfg.activeRecallAllowedChatTypes.filter(
            (value): value is "direct" | "group" | "channel" =>
              value === "direct" || value === "group" || value === "channel",
          )
        : ["direct", "group", "channel"],
    activeRecallQueryMode:
      cfg.activeRecallQueryMode === "message" ||
      cfg.activeRecallQueryMode === "full"
        ? cfg.activeRecallQueryMode
        : "recent",
    activeRecallPromptStyle:
      cfg.activeRecallPromptStyle === "strict" ||
      cfg.activeRecallPromptStyle === "contextual" ||
      cfg.activeRecallPromptStyle === "recall-heavy" ||
      cfg.activeRecallPromptStyle === "precision-heavy" ||
      cfg.activeRecallPromptStyle === "preference-only"
        ? cfg.activeRecallPromptStyle
        : "balanced",
    activeRecallCustomInstruction: (() => {
      const raw =
        typeof cfg.activeRecallCustomInstruction === "string"
          ? cfg.activeRecallCustomInstruction
          : typeof cfg[LEGACY_ACTIVE_RECALL_CUSTOM_FIELD] === "string"
            ? cfg[LEGACY_ACTIVE_RECALL_CUSTOM_FIELD]
            : "";
      return raw.trim().length > 0 ? raw.trim() : null;
    })(),
    activeRecallPromptReplacement: (() => {
      const raw = cfg.activeRecallPromptReplacement;
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        throw new Error(
          `activeRecallPromptReplacement must be a string; got ${JSON.stringify(raw)}`,
        );
      }
      return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    })(),
    activeRecallPromptOverride: (() => {
      const raw = cfg.activeRecallPromptOverride;
      if (raw !== undefined && raw !== null && typeof raw !== "string") {
        throw new Error(
          `activeRecallPromptOverride must be a string; got ${JSON.stringify(raw)}`,
        );
      }
      return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    })(),
    activeRecallPromptAppend:
      typeof cfg.activeRecallPromptAppend === "string" &&
      cfg.activeRecallPromptAppend.trim().length > 0
        ? cfg.activeRecallPromptAppend.trim()
        : null,
    activeRecallMaxSummaryChars:
      typeof cfg.activeRecallMaxSummaryChars === "number"
        ? Math.min(1000, Math.max(40, Math.floor(cfg.activeRecallMaxSummaryChars)))
        : 220,
    activeRecallRecentUserTurns:
      typeof cfg.activeRecallRecentUserTurns === "number"
        ? Math.min(4, Math.max(0, Math.floor(cfg.activeRecallRecentUserTurns)))
        : 2,
    activeRecallRecentAssistantTurns:
      typeof cfg.activeRecallRecentAssistantTurns === "number"
        ? Math.min(3, Math.max(0, Math.floor(cfg.activeRecallRecentAssistantTurns)))
        : 1,
    activeRecallRecentUserChars:
      typeof cfg.activeRecallRecentUserChars === "number"
        ? Math.min(1000, Math.max(40, Math.floor(cfg.activeRecallRecentUserChars)))
        : 600,
    activeRecallRecentAssistantChars:
      typeof cfg.activeRecallRecentAssistantChars === "number"
        ? Math.min(1000, Math.max(40, Math.floor(cfg.activeRecallRecentAssistantChars)))
        : 400,
    activeRecallThinking:
      cfg.activeRecallThinking === "low" ||
      cfg.activeRecallThinking === "off" ||
      cfg.activeRecallThinking === "minimal" ||
      cfg.activeRecallThinking === "medium" ||
      cfg.activeRecallThinking === "high" ||
      cfg.activeRecallThinking === "xhigh" ||
      cfg.activeRecallThinking === "adaptive"
        ? cfg.activeRecallThinking
        : "low",
    activeRecallTimeoutMs:
      typeof cfg.activeRecallTimeoutMs === "number"
        ? Math.max(250, Math.floor(cfg.activeRecallTimeoutMs))
        : 15_000,
    activeRecallCacheTtlMs:
      typeof cfg.activeRecallCacheTtlMs === "number"
        ? cfg.activeRecallCacheTtlMs === 0
          ? 0
          : cfg.activeRecallCacheTtlMs < 0
            ? 15_000
          : Math.min(
              120_000,
              Math.max(1, Math.floor(cfg.activeRecallCacheTtlMs)),
            )
        : 15_000,
    activeRecallModel:
      typeof cfg.activeRecallModel === "string" && cfg.activeRecallModel.trim().length > 0
        ? cfg.activeRecallModel.trim()
        : null,
    activeRecallModelFallbackPolicy:
      cfg.activeRecallModelFallbackPolicy === "resolved-only"
        ? "resolved-only"
        : "default-remote",
    activeRecallPersistTranscripts: cfg.activeRecallPersistTranscripts === true,
    activeRecallTranscriptDir: parseOptionalNonEmptyString(cfg.activeRecallTranscriptDir) ?? "active-recall",
    activeRecallEntityGraphDepth:
      typeof cfg.activeRecallEntityGraphDepth === "number"
        ? Math.min(3, Math.max(0, Math.floor(cfg.activeRecallEntityGraphDepth)))
        : 1,
    activeRecallIncludeCausalTrajectories: cfg.activeRecallIncludeCausalTrajectories === true,
    activeRecallIncludeDaySummary: cfg.activeRecallIncludeDaySummary === true,
    activeRecallAttachRecallExplain: cfg.activeRecallAttachRecallExplain === true,
    activeRecallAllowChainedActiveMemory: cfg.activeRecallAllowChainedActiveMemory === true,
    dreaming,
    dreamsPhases,
    procedural,
    extractionLiveness: parseExtractionLivenessConfig(cfg),
    replicaPeers: parseReplicaPeersConfig(cfg),
    converge: parseConvergeConfig(cfg.converge),
    wearables,
    meetings,
    okf: parseOkfConfig(cfg.okf),
    activity,
    location,
    provenance,
    // At-rest encryption (#690): coerceBool handles CLI string "true" (#36).
    secureStoreEnabled: coerceBool(cfg.secureStoreEnabled) === true,
    secureStoreEncryptOnWrite: coerceBool(cfg.secureStoreEncryptOnWrite) !== false, // default: true
    codingMode,
    heartbeat,
    slotBehavior,
    bridgeMode: cfg.bridgeMode === undefined ? "embedded" : String(cfg.bridgeMode),
    codexCompat,
    codingKnowledge: parseCodingKnowledgeConfig(cfg.codingKnowledge),
    actionGate: parseActionGateConfig(cfg.actionGate),
    chat: parseChatConfig(cfg.chat),
    supportPassport: parseSupportPassportConfig(cfg.supportPassport),
    hourlySummariesEnabled: cfg.hourlySummariesEnabled !== false, // default: true
    daySummaryEnabled: cfg.daySummaryEnabled !== false, // default: true
    hourlySummaryCronAutoRegister: cfg.hourlySummaryCronAutoRegister === true,
    // Day summary timezone override (issue #1475). When unset, the plugin
    // falls back to the server's local timezone.
    daySummaryTimezone:
      typeof cfg.daySummaryTimezone === "string" && cfg.daySummaryTimezone.trim().length > 0
        ? (() => {
            const tz = (cfg.daySummaryTimezone as string).trim();
            try {
              Intl.DateTimeFormat(undefined, { timeZone: tz });
              return tz;
            } catch {
              throw new Error(`daySummaryTimezone must be a valid IANA timezone: ${tz}`);
            }
          })()
        : undefined,
    // Codex P1 on PR 763 round 2: gate the nightly-governance cron
    // (deep-sleep's primary scheduled execution path) on
    // dreams.phases.deepSleep.enabled. When the phase is disabled the
    // cron must NOT auto-register, otherwise `deepSleep.enabled=false`
    // is a contract lie — deep-sleep keeps running.
    nightlyGovernanceCronAutoRegister:
      dreamsDeepSleep.enabled && cfg.nightlyGovernanceCronAutoRegister === true,
    summaryRecallHours:
      typeof cfg.summaryRecallHours === "number" ? cfg.summaryRecallHours : 24,
    maxSummaryCount:
      typeof cfg.maxSummaryCount === "number" ? cfg.maxSummaryCount : 6,
    // Gateway-routed (memory flush plan + hourly summary cron). Precedence:
    // explicit summaryModel → explicit base model → gateway task-chain primary →
    // "" (omit, so the Gateway default wins). In gateway mode bare ids (incl. the
    // injected `model` schema default) are dropped via `gatewayTaskModel`, so the
    // Gateway is never sent an unroutable `<provider>/gpt-5.5` (issue #1469).
    summaryModel:
      gatewayTaskModel(
        typeof cfg.summaryModel === "string" && cfg.summaryModel.length > 0
          ? cfg.summaryModel
          : "",
      ) ||
      gatewayTaskModel(explicitModel) ||
      taskModelFallback,
    // v2.4 Extended hourly summaries (default off)
    hourlySummariesExtendedEnabled: cfg.hourlySummariesExtendedEnabled === true,
    hourlySummariesIncludeToolStats: cfg.hourlySummariesIncludeToolStats === true,
    hourlySummariesIncludeSystemMessages: cfg.hourlySummariesIncludeSystemMessages === true,
    hourlySummariesMaxTurnsPerRun:
      typeof cfg.hourlySummariesMaxTurnsPerRun === "number" ? cfg.hourlySummariesMaxTurnsPerRun : 200,
    // v2.4 Conversation index (default off)
    conversationIndexEnabled: cfg.conversationIndexEnabled === true,
    conversationIndexBackend: cfg.conversationIndexBackend === "faiss" ? "faiss" : "qmd",
    conversationIndexQmdCollection:
      typeof cfg.conversationIndexQmdCollection === "string" && cfg.conversationIndexQmdCollection.length > 0
        ? cfg.conversationIndexQmdCollection
        // TODO(#403): Keep legacy collection name for backwards compat.
        : "openclaw-engram-conversations",
    conversationIndexRetentionDays:
      typeof cfg.conversationIndexRetentionDays === "number" ? cfg.conversationIndexRetentionDays : 30,
    conversationIndexMinUpdateIntervalMs:
      typeof cfg.conversationIndexMinUpdateIntervalMs === "number"
        ? cfg.conversationIndexMinUpdateIntervalMs
        : 15 * 60_000,
    conversationIndexEmbedOnUpdate: cfg.conversationIndexEmbedOnUpdate === true,
    conversationIndexFaissScriptPath:
      typeof cfg.conversationIndexFaissScriptPath === "string" && cfg.conversationIndexFaissScriptPath.trim().length > 0
        ? cfg.conversationIndexFaissScriptPath.trim()
        : undefined,
    conversationIndexFaissPythonBin:
      typeof cfg.conversationIndexFaissPythonBin === "string" && cfg.conversationIndexFaissPythonBin.trim().length > 0
        ? cfg.conversationIndexFaissPythonBin.trim()
        : undefined,
    conversationIndexFaissModelId:
      typeof cfg.conversationIndexFaissModelId === "string" && cfg.conversationIndexFaissModelId.trim().length > 0
        ? cfg.conversationIndexFaissModelId.trim()
        : "text-embedding-3-small",
    conversationIndexFaissIndexDir:
      typeof cfg.conversationIndexFaissIndexDir === "string" && cfg.conversationIndexFaissIndexDir.trim().length > 0
        ? cfg.conversationIndexFaissIndexDir.trim()
        : "state/conversation-index/faiss",
    conversationIndexFaissUpsertTimeoutMs:
      typeof cfg.conversationIndexFaissUpsertTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissUpsertTimeoutMs))
        : 30_000,
    conversationIndexFaissSearchTimeoutMs:
      typeof cfg.conversationIndexFaissSearchTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissSearchTimeoutMs))
        : 5_000,
    conversationIndexFaissHealthTimeoutMs:
      typeof cfg.conversationIndexFaissHealthTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissHealthTimeoutMs))
        : 2_000,
    conversationIndexFaissMaxBatchSize:
      typeof cfg.conversationIndexFaissMaxBatchSize === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissMaxBatchSize))
        : 512,
    conversationIndexFaissMaxSearchK:
      typeof cfg.conversationIndexFaissMaxSearchK === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissMaxSearchK))
        : 50,
    conversationRecallTopK:
      typeof cfg.conversationRecallTopK === "number" ? cfg.conversationRecallTopK : 3,
    conversationRecallMaxChars:
      typeof cfg.conversationRecallMaxChars === "number" ? cfg.conversationRecallMaxChars : 2500,
    conversationRecallTimeoutMs:
      typeof cfg.conversationRecallTimeoutMs === "number" ? cfg.conversationRecallTimeoutMs : 800,
    evalHarnessEnabled: cfg.evalHarnessEnabled === true,
    evalShadowModeEnabled: cfg.evalShadowModeEnabled === true,
    benchmarkBaselineSnapshotsEnabled: cfg.benchmarkBaselineSnapshotsEnabled === true,
    benchmarkDeltaReporterEnabled: cfg.benchmarkDeltaReporterEnabled === true,
    benchmarkStoredBaselineEnabled: cfg.benchmarkStoredBaselineEnabled === true,
    evalStoreDir:
      typeof cfg.evalStoreDir === "string" && cfg.evalStoreDir.trim().length > 0
        ? cfg.evalStoreDir.trim()
        : path.join(memoryDir, "state", "evals"),
    objectiveStateMemoryEnabled: cfg.objectiveStateMemoryEnabled === true,
    objectiveStateSnapshotWritesEnabled: cfg.objectiveStateSnapshotWritesEnabled === true,
    objectiveStateRecallEnabled: cfg.objectiveStateRecallEnabled === true,
    objectiveStateStoreDir:
      typeof cfg.objectiveStateStoreDir === "string" && cfg.objectiveStateStoreDir.trim().length > 0
        ? cfg.objectiveStateStoreDir.trim()
        : path.join(memoryDir, "state", "objective-state"),
    causalTrajectoryMemoryEnabled: cfg.causalTrajectoryMemoryEnabled === true,
    causalTrajectoryStoreDir:
      typeof cfg.causalTrajectoryStoreDir === "string" && cfg.causalTrajectoryStoreDir.trim().length > 0
        ? cfg.causalTrajectoryStoreDir.trim()
        : path.join(memoryDir, "state", "causal-trajectories"),
    causalTrajectoryRecallEnabled: cfg.causalTrajectoryRecallEnabled === true,
    actionGraphRecallEnabled: cfg.actionGraphRecallEnabled === true,
    trustZonesEnabled: cfg.trustZonesEnabled === true,
    quarantinePromotionEnabled: cfg.quarantinePromotionEnabled === true,
    trustZoneStoreDir:
      typeof cfg.trustZoneStoreDir === "string" && cfg.trustZoneStoreDir.trim().length > 0
        ? cfg.trustZoneStoreDir.trim()
        : path.join(memoryDir, "state", "trust-zones"),
    trustZoneRecallEnabled: cfg.trustZoneRecallEnabled === true,
    memoryPoisoningDefenseEnabled: cfg.memoryPoisoningDefenseEnabled === true,
    memoryRedTeamBenchEnabled: cfg.memoryRedTeamBenchEnabled === true,
    harmonicRetrievalEnabled: cfg.harmonicRetrievalEnabled === true,
    episodicContextEnabled: cfg.episodicContextEnabled === true,
    abstractionAnchorsEnabled: cfg.abstractionAnchorsEnabled === true,
    verifiedRecallEnabled: cfg.verifiedRecallEnabled === true,
    semanticRulePromotionEnabled: cfg.semanticRulePromotionEnabled === true,
    semanticRuleVerificationEnabled: cfg.semanticRuleVerificationEnabled === true,
    // Issue #678 PR 2/4: when `dreams.phases.rem.*` is set, the resolved
    // dreamsPhases value WINS over the legacy top-level key. The runtime
    // gates (orchestrator's `runSemanticConsolidation`) read these legacy
    // fields, so we must propagate the precedence here, not just in the
    // `dreamsPhases` object.
    semanticConsolidationEnabled: dreamsRem.enabled && dreamsRem.cadenceMs > 0,
    semanticConsolidationModel:
      typeof cfg.semanticConsolidationModel === "string" && cfg.semanticConsolidationModel.length > 0
        ? cfg.semanticConsolidationModel
        : "auto",
    semanticConsolidationThreshold: dreamsRem.similarityThreshold,
    semanticConsolidationMinClusterSize: dreamsRem.minClusterSize,
    semanticConsolidationExcludeCategories: Array.isArray(cfg.semanticConsolidationExcludeCategories)
      ? (cfg.semanticConsolidationExcludeCategories as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.length > 0,
        )
      : ["correction", "commitment", "procedure"],
    // semanticConsolidationIntervalHours is derived from dreamsRem.cadenceMs
    // when an override is set (rounded up to the nearest hour). Preserve
    // explicit zero so legacy schedulers see the same disable-by-zero signal
    // as the dreams.phases.rem config; the runtime enabled flag is also
    // disabled above so zero does not mean "run every maintenance cycle".
    semanticConsolidationIntervalHours:
      rawDreamsRem.cadenceMs !== undefined
        ? Math.max(0, Math.ceil(dreamsRem.cadenceMs / 3_600_000))
        : legacySemanticConsolidationIntervalHours,
    semanticConsolidationMaxPerRun: dreamsRem.maxPerRun,
    // Operator-aware consolidation prompt (issue #561 PR 3).  Defaults
    // to `false` to match sibling `*Enabled` flags' least-privileged
    // convention.  Operators opt in by setting `true` (or truthy
    // coercions like "true", "1", "yes", "on") when they want the
    // consolidation LLM to emit SPLIT/MERGE/UPDATE operator selection
    // on the `derived_via` frontmatter field.  Uses `coerceBool` per
    // Gotcha #36 so CLI / env-string inputs coerce correctly.  When
    // disabled, `derived_via` is still populated via the cluster-shape
    // heuristic (chooseConsolidationOperator) so PR 2's provenance
    // wiring keeps working without operator-aware prompts.
    operatorAwareConsolidationEnabled:
      coerceBool(cfg.operatorAwareConsolidationEnabled) ?? false,
    // Pattern reinforcement (issue #687 PR 2/4).  Defaults: off, weekly
    // cadence, min cluster size 3, target categories preference / fact
    // / decision.  All bounds clamped at parse time so invalid inputs
    // (negative numbers, non-arrays, non-strings) fail safe to defaults
    // rather than crash the job.
    patternReinforcementEnabled:
      coerceBool(cfg.patternReinforcementEnabled) ?? false,
    patternReinforcementCadenceMs: (() => {
      const raw = coerceNumber(cfg.patternReinforcementCadenceMs);
      if (raw === undefined || !Number.isFinite(raw)) {
        return 7 * 24 * 60 * 60 * 1000;
      }
      // Allow 0 to disable cadence gating; otherwise clamp to >= 0.
      return Math.max(0, Math.floor(raw));
    })(),
    patternReinforcementMinCount: (() => {
      const raw = coerceNumber(cfg.patternReinforcementMinCount);
      if (raw === undefined || !Number.isFinite(raw)) return 3;
      // Clusters of 1 are degenerate; clusters of 2 are the minimum
      // meaningful pattern.  Cap at a sane upper bound to prevent
      // accidentally locking out the job entirely.
      return Math.min(1000, Math.max(2, Math.floor(raw)));
    })(),
    patternReinforcementCategories: Array.isArray(cfg.patternReinforcementCategories)
      ? (cfg.patternReinforcementCategories as unknown[])
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : ["preference", "fact", "decision"],
    // issue #687 PR 3/4: reinforcement recall boost config.
    reinforcementRecallBoostEnabled:
      coerceBool(cfg.reinforcementRecallBoostEnabled) ?? false,
    reinforcementRecallBoostWeight: (() => {
      if (cfg.reinforcementRecallBoostWeight === undefined) return 0.05;
      const n = coerceNumber(cfg.reinforcementRecallBoostWeight);
      if (n === undefined || !Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(
          `reinforcementRecallBoostWeight must be a number in [0, 1] (got ${JSON.stringify(cfg.reinforcementRecallBoostWeight)}).`,
        );
      }
      return n;
    })(),
    reinforcementRecallBoostMax: (() => {
      if (cfg.reinforcementRecallBoostMax === undefined) return 0.3;
      const n = coerceNumber(cfg.reinforcementRecallBoostMax);
      if (n === undefined || !Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(
          `reinforcementRecallBoostMax must be a number in [0, 1] (got ${JSON.stringify(cfg.reinforcementRecallBoostMax)}).`,
        );
      }
      return n;
    })(),
    // Async peer profile reasoner (issue #679 PR 2/5). Defaults to
    // `false` (opt-in) per Gotchas #30/#48 — least-privileged default.
    // `coerceBool` handles "true"/"1"/"yes"/"on" CLI strings (Gotcha
    // #36). Numeric thresholds clamp at zero (Gotcha #28 + #45 — 0
    // is a documented disable value for both, so the schema minimum
    // matches and we do NOT silently bump to 1).
    peerProfileReasonerEnabled:
      coerceBool(cfg.peerProfileReasonerEnabled) ?? false,
    // Cursor M on PR #736: use the routing alias `"auto"` rather than
    // a hardcoded model identifier. Matches the convention established
    // by sibling `semanticConsolidationModel`. Operators can still
    // override via config; the value is logged for telemetry only.
    peerProfileReasonerModel:
      typeof cfg.peerProfileReasonerModel === "string" &&
      cfg.peerProfileReasonerModel.trim().length > 0
        ? cfg.peerProfileReasonerModel.trim()
        : "auto",
    // Cursor L on PR #736: numeric config keys must coerce string CLI
    // values (Gotcha #28 — `--config peerProfileReasonerMaxFieldsPerRun=2`
    // arrives as the string "2"). Pre-fix `typeof === "number"`
    // rejected string inputs and silently fell back to defaults. The
    // shared `coerceNonNegativeInt` helper accepts both forms, throws
    // on invalid input (Gotcha #51 — reject rather than silently
    // default), and falls back to the documented default when the
    // key is absent. 0 is a valid documented disable value here, so
    // the helper does NOT bump to 1.
    peerProfileReasonerMinInteractions: coerceNonNegativeInt(
      cfg.peerProfileReasonerMinInteractions,
      5,
      "peerProfileReasonerMinInteractions",
    ),
    peerProfileReasonerMaxFieldsPerRun: coerceNonNegativeInt(
      cfg.peerProfileReasonerMaxFieldsPerRun,
      8,
      "peerProfileReasonerMaxFieldsPerRun",
    ),
    // Peer profile recall injection (issue #679 PR 3/5). Default-off
    // per Gotcha #30/#48 (least-privileged default, new feature gate).
    // `coerceBool` handles CLI string forms "true"/"1"/"yes"/"on"
    // (Gotcha #36). `coerceNonNegativeInt` handles string CLI values
    // (Gotcha #28) and documents 0 as the disable value (Gotcha #45 —
    // schema minimum must also be 0 so they stay consistent).
    peerProfileRecallEnabled:
      coerceBool(cfg.peerProfileRecallEnabled) ?? false,
    peerProfileRecallMaxFields: coerceNonNegativeInt(
      cfg.peerProfileRecallMaxFields,
      5,
      "peerProfileRecallMaxFields",
    ),
    creationMemoryEnabled: cfg.creationMemoryEnabled === true,
    memoryUtilityLearningEnabled: cfg.memoryUtilityLearningEnabled === true,
    promotionByOutcomeEnabled: cfg.promotionByOutcomeEnabled === true,
    commitmentLedgerEnabled: cfg.commitmentLedgerEnabled === true,
    commitmentLifecycleEnabled: cfg.commitmentLifecycleEnabled === true,
    commitmentStaleDays:
      typeof cfg.commitmentStaleDays === "number" ? cfg.commitmentStaleDays : 14,
    commitmentLedgerDir:
      typeof cfg.commitmentLedgerDir === "string" && cfg.commitmentLedgerDir.trim().length > 0
        ? cfg.commitmentLedgerDir.trim()
        : path.join(memoryDir, "state", "commitment-ledger"),
    resumeBundlesEnabled: cfg.resumeBundlesEnabled === true,
    resumeBundleDir:
      typeof cfg.resumeBundleDir === "string" && cfg.resumeBundleDir.trim().length > 0
        ? cfg.resumeBundleDir.trim()
        : path.join(memoryDir, "state", "resume-bundles"),
    workProductRecallEnabled: cfg.workProductRecallEnabled === true,
    workTasksEnabled: cfg.workTasksEnabled === true,
    workProjectsEnabled: cfg.workProjectsEnabled === true,
    workTasksDir:
      typeof cfg.workTasksDir === "string" && cfg.workTasksDir.trim().length > 0
        ? cfg.workTasksDir.trim()
        : path.join(memoryDir, "work", "tasks"),
    workProjectsDir:
      typeof cfg.workProjectsDir === "string" && cfg.workProjectsDir.trim().length > 0
        ? cfg.workProjectsDir.trim()
        : path.join(memoryDir, "work", "projects"),
    workIndexEnabled: cfg.workIndexEnabled === true,
    workIndexDir:
      typeof cfg.workIndexDir === "string" && cfg.workIndexDir.trim().length > 0
        ? cfg.workIndexDir.trim()
        : path.join(memoryDir, "work", "index"),
    workTaskIndexEnabled: cfg.workTaskIndexEnabled === true,
    workProjectIndexEnabled: cfg.workProjectIndexEnabled === true,
    workIndexAutoRebuildEnabled: cfg.workIndexAutoRebuildEnabled === true,
    workIndexAutoRebuildDebounceMs:
      typeof cfg.workIndexAutoRebuildDebounceMs === "number" ? cfg.workIndexAutoRebuildDebounceMs : 1000,
    workProductLedgerDir:
      typeof cfg.workProductLedgerDir === "string" && cfg.workProductLedgerDir.trim().length > 0
        ? cfg.workProductLedgerDir.trim()
        : path.join(memoryDir, "state", "work-product-ledger"),
    abstractionNodeStoreDir:
      typeof cfg.abstractionNodeStoreDir === "string" && cfg.abstractionNodeStoreDir.trim().length > 0
        ? cfg.abstractionNodeStoreDir.trim()
        : path.join(memoryDir, "state", "abstraction-nodes"),
    // Local LLM Provider (v2.1)
    localLlmEnabled: cfg.localLlmEnabled === true || cfg.localLlmEnabled === "true", // default: false
    localLlmUrl:
      typeof cfg.localLlmUrl === "string" && cfg.localLlmUrl.length > 0
        ? cfg.localLlmUrl
        : "http://localhost:1234/v1",
    localLlmModel:
      typeof cfg.localLlmModel === "string" && cfg.localLlmModel.length > 0
        ? cfg.localLlmModel
        : "local-model",
    localLlmApiKey:
      typeof cfg.localLlmApiKey === "string" && cfg.localLlmApiKey.length > 0
        ? resolveEnvVars(cfg.localLlmApiKey)
        : undefined,
    localLlmHeaders:
      cfg.localLlmHeaders && typeof cfg.localLlmHeaders === "object" && !Array.isArray(cfg.localLlmHeaders)
        ? Object.fromEntries(
            Object.entries(cfg.localLlmHeaders as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, String(value)]),
          )
        : undefined,
    localLlmAuthHeader: cfg.localLlmAuthHeader !== false,
    localLlmFallback: cfg.localLlmFallback !== false, // default: true
    localLlmHomeDir:
      typeof cfg.localLlmHomeDir === "string" && cfg.localLlmHomeDir.length > 0
        ? cfg.localLlmHomeDir
        : undefined,
    localLmsCliPath:
      typeof cfg.localLmsCliPath === "string" && cfg.localLmsCliPath.length > 0
        ? cfg.localLmsCliPath
        : undefined,
    localLmsBinDir:
      typeof cfg.localLmsBinDir === "string" && cfg.localLmsBinDir.length > 0
        ? cfg.localLmsBinDir
        : undefined,
    localLlmTimeoutMs:
      parseBoundedIntegerMs(cfg.localLlmTimeoutMs, 180_000, 1, 86_400_000),
    localLlmMaxContext:
      parseOptionalIntegerAtLeast(cfg.localLlmMaxContext, 1024, "localLlmMaxContext"),
    // Observability (disabled by default to avoid log spam)
    slowLogEnabled: cfg.slowLogEnabled === true,
    slowLogThresholdMs:
      typeof cfg.slowLogThresholdMs === "number" ? cfg.slowLogThresholdMs : 30_000,
    // Trace recall content — disabled by default; enable to send recalled memory text to trace subscribers
    traceRecallContent: cfg.traceRecallContent === true,
    // Performance profiling (opt-in, disabled by default)
    profilingEnabled: cfg.profilingEnabled === true,
    profilingStorageDir:
      typeof cfg.profilingStorageDir === "string" && cfg.profilingStorageDir.length > 0
        ? cfg.profilingStorageDir
        : path.join(memoryDir, "profiling"),
    profilingMaxTraces:
      typeof cfg.profilingMaxTraces === "number" && Number.isFinite(cfg.profilingMaxTraces)
        ? Math.max(0, cfg.profilingMaxTraces)
        : 100,
    // Extraction stability guards (P0/P1)
    extractionDedupeEnabled: cfg.extractionDedupeEnabled !== false,
    extractionSourceGroundingEnabled: coerceBool(cfg.extractionSourceGroundingEnabled) !== false,
    extractionDedupeWindowMs:
      typeof cfg.extractionDedupeWindowMs === "number" ? cfg.extractionDedupeWindowMs : 5 * 60_000,
    extractionMinChars:
      typeof cfg.extractionMinChars === "number" ? cfg.extractionMinChars : 40,
    extractionMinUserTurns:
      typeof cfg.extractionMinUserTurns === "number" ? cfg.extractionMinUserTurns : 1,
    extractionTelemetryPrefilterEnabled:
      coerceBool(cfg.extractionTelemetryPrefilterEnabled) !== false,
    extractionMaxTurnChars:
      typeof cfg.extractionMaxTurnChars === "number" ? cfg.extractionMaxTurnChars : 4000,
    extractionMaxFactsPerRun:
      typeof cfg.extractionMaxFactsPerRun === "number" ? cfg.extractionMaxFactsPerRun : 12,
    extractionMaxEntitiesPerRun:
      typeof cfg.extractionMaxEntitiesPerRun === "number" ? cfg.extractionMaxEntitiesPerRun : 6,
    extractionMaxQuestionsPerRun:
      typeof cfg.extractionMaxQuestionsPerRun === "number" ? cfg.extractionMaxQuestionsPerRun : 3,
    extractionMaxProfileUpdatesPerRun:
      typeof cfg.extractionMaxProfileUpdatesPerRun === "number" ? cfg.extractionMaxProfileUpdatesPerRun : 4,
    // Importance write-gate for trivial extracted content (issue #372).
    // Default "low" drops only "trivial" facts (greetings, single-word replies,
    // heartbeat pings); set to "normal" or higher to make the gate stricter.
    extractionMinImportanceLevel: ((): PluginConfig["extractionMinImportanceLevel"] => {
      const raw = cfg.extractionMinImportanceLevel;
      if (
        raw === "trivial" ||
        raw === "low" ||
        raw === "normal" ||
        raw === "high" ||
        raw === "critical"
      ) {
        return raw;
      }
      return "low";
    })(),
    // Extraction scope classification (rule 30 gate): "global" facts promote
    // to the shared namespace. Default true.
    extractionScopeClassificationEnabled:
      coerceBool(cfg.extractionScopeClassificationEnabled) !== false,
    ...parseSubjectRuntimeConfig(cfg),
    // Extraction judge (issue #376). Opt-in LLM-as-judge fact-worthiness gate.
    extractionJudgeEnabled: cfg.extractionJudgeEnabled === true,
    extractionJudgeModel:
      typeof cfg.extractionJudgeModel === "string" ? cfg.extractionJudgeModel : "",
    extractionJudgeBatchSize:
      typeof cfg.extractionJudgeBatchSize === "number" && Number.isFinite(cfg.extractionJudgeBatchSize)
        ? Math.max(1, Math.round(cfg.extractionJudgeBatchSize))
        : 20,
    extractionJudgeShadow: cfg.extractionJudgeShadow === true,
    // Defer cap (issue #562 PR 2): max re-deferrals for the same candidate
    // text before the verdict is forcibly converted to reject.
    extractionJudgeMaxDeferrals:
      typeof cfg.extractionJudgeMaxDeferrals === "number" &&
      Number.isFinite(cfg.extractionJudgeMaxDeferrals) &&
      cfg.extractionJudgeMaxDeferrals >= 1
        ? Math.floor(cfg.extractionJudgeMaxDeferrals)
        : 2,
    // Judge telemetry (issue #562 PR 3): opt-in structured emit to the
    // observation ledger; `coerceBool` accepts CLI-style strings (gotcha 36).
    extractionJudgeTelemetryEnabled:
      coerceBool(cfg.extractionJudgeTelemetryEnabled) === true,
    // Judge training-pair collection (issue #562 PR 4): opt-in shim for a
    // future GRPO training pipeline. Rows land under ~/.remnic/judge-
    // training/<date>.jsonl — NOT in the shared memory directory.
    // Uses `coerceBool` per CLAUDE.md gotcha 36 for CLI-string parity.
    collectJudgeTrainingPairs: coerceBool(cfg.collectJudgeTrainingPairs) === true,
    judgeTrainingDir:
      typeof cfg.judgeTrainingDir === "string" ? cfg.judgeTrainingDir : "",
    // Extraction faithfulness gate (issue #1576) + model-lab pointer
    // `extractionFaithfulnessBaseUrl` (issue #1585), and the correction-intent
    // model-lab pointer (issue #1581 / #1585). Parsed in faithfulness-config.ts
    // (extracted from this god file so the block can grow without tripping the
    // ratchet). Defaults preserve the byte-identical pre-feature pipeline
    // (rule 39); invalid values reject (rule 51 / #1634).
    ...parseFaithfulnessGateConfig(cfg),
    ...parseCorrectionIntentConfig(cfg),
    // Inline source attribution (issue #369). Opt-in to preserve
    // backwards compatibility with existing downstream consumers.
    inlineSourceAttributionEnabled: cfg.inlineSourceAttributionEnabled === true,
    inlineSourceAttributionFormat:
      typeof cfg.inlineSourceAttributionFormat === "string" &&
      cfg.inlineSourceAttributionFormat.trim().length > 0
        ? cfg.inlineSourceAttributionFormat
        : "[Source: agent={agent}, session={sessionId}, ts={ts}]",
    consolidationRequireNonZeroExtraction: cfg.consolidationRequireNonZeroExtraction !== false,
    // Issue #678 PR 2/4: dreams.phases.rem.minIntervalMs WINS when set.
    consolidationMinIntervalMs: dreamsRem.minIntervalMs,
    // QMD maintenance (debounced singleflight)
    qmdMaintenanceEnabled: cfg.qmdMaintenanceEnabled !== false,
    qmdMaintenanceDebounceMs:
      typeof cfg.qmdMaintenanceDebounceMs === "number" ? cfg.qmdMaintenanceDebounceMs : 30_000,
    maintenanceNamespaceFanoutEnabled,
    maintenanceMaxNamespacesPerCycle,
    maintenanceIncludeProjectNamespaces,
    maintenanceIncludeBranchNamespaces,
    maintenanceIncludeTeamProjectNamespaces,
    maintenanceNamespaceLockStaleMs,
    qmdAutoEmbedEnabled: cfg.qmdAutoEmbedEnabled === true,
    qmdEmbedMinIntervalMs:
      typeof cfg.qmdEmbedMinIntervalMs === "number" ? cfg.qmdEmbedMinIntervalMs : 60 * 60_000,
    qmdUpdateTimeoutMs:
      typeof cfg.qmdUpdateTimeoutMs === "number" ? cfg.qmdUpdateTimeoutMs : 90_000,
    qmdUpdateMinIntervalMs:
      typeof cfg.qmdUpdateMinIntervalMs === "number" ? cfg.qmdUpdateMinIntervalMs : 15 * 60_000,
    // Local LLM resilience
    localLlmRetry5xxCount:
      typeof cfg.localLlmRetry5xxCount === "number" ? cfg.localLlmRetry5xxCount : 1,
    localLlmRetryBackoffMs:
      typeof cfg.localLlmRetryBackoffMs === "number" ? cfg.localLlmRetryBackoffMs : 400,
    localLlm400TripThreshold:
      typeof cfg.localLlm400TripThreshold === "number" ? cfg.localLlm400TripThreshold : 5,
    localLlm400CooldownMs:
      typeof cfg.localLlm400CooldownMs === "number" ? cfg.localLlm400CooldownMs : 120_000,
    // Ollama thinking suppression dialect (issue #1996): reasoning_effort value
    // for THINKING_SUPPRESSED_OPERATIONS on the ollama backend. Default "none"
    // (think off). "" disables injection. Invalid values fall back to "none"
    // rather than reaching Ollama, which 400s on unknown efforts.
    localLlmReasoningEffort:
      typeof cfg.localLlmReasoningEffort === "string" &&
      ["", "none", "low", "medium", "high", "max"].includes(cfg.localLlmReasoningEffort)
        ? cfg.localLlmReasoningEffort
        : "none",
    localLlmThinkingThresholdChars: (() => {
      const threshold = coerceNumber(cfg.localLlmThinkingThresholdChars);
      return threshold !== undefined && Number.isInteger(threshold) && threshold >= 0
        ? threshold
        : 3_000;
    })(),
    // Extraction retry/backoff + circuit breaker (extraction hot-loop hardening)
    extractionRetryEnabled: coerceBooleanLike(cfg.extractionRetryEnabled) ?? true,
    extractionRetryScheduleMs:
      Array.isArray(cfg.extractionRetryScheduleMs) &&
      cfg.extractionRetryScheduleMs.length > 0 &&
      cfg.extractionRetryScheduleMs.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
        ? (cfg.extractionRetryScheduleMs as number[])
        : [60_000, 300_000, 1_800_000, 7_200_000],
    extractionRetryMaxBackoffMs:
      typeof cfg.extractionRetryMaxBackoffMs === "number" && cfg.extractionRetryMaxBackoffMs > 0
        ? cfg.extractionRetryMaxBackoffMs : 21_600_000,
    extractionRetryJitterRatio:
      typeof cfg.extractionRetryJitterRatio === "number" &&
      cfg.extractionRetryJitterRatio >= 0 && cfg.extractionRetryJitterRatio <= 1
        ? cfg.extractionRetryJitterRatio : 0.2,
    extractionParseEmptyMaxAttempts:
      typeof cfg.extractionParseEmptyMaxAttempts === "number" &&
      Number.isInteger(cfg.extractionParseEmptyMaxAttempts) && cfg.extractionParseEmptyMaxAttempts > 0
        ? cfg.extractionParseEmptyMaxAttempts : 3,
    extractionBreakerFailureThreshold:
      typeof cfg.extractionBreakerFailureThreshold === "number" &&
      Number.isInteger(cfg.extractionBreakerFailureThreshold) && cfg.extractionBreakerFailureThreshold > 0
        ? cfg.extractionBreakerFailureThreshold : 5,
    extractionBreakerCooldownMs:
      typeof cfg.extractionBreakerCooldownMs === "number" && cfg.extractionBreakerCooldownMs >= 0
        ? cfg.extractionBreakerCooldownMs : 300_000,
    extractionBreakerAuthCooldownMs:
      typeof cfg.extractionBreakerAuthCooldownMs === "number" && cfg.extractionBreakerAuthCooldownMs >= 0
        ? cfg.extractionBreakerAuthCooldownMs : 1_800_000,
    // Local LLM fast tier (v9.1)
    localLlmFastEnabled: cfg.localLlmFastEnabled === true,
    localLlmFastModel:
      typeof cfg.localLlmFastModel === "string" && cfg.localLlmFastModel.length > 0
        ? cfg.localLlmFastModel
        : "",
    localLlmFastUrl:
      typeof cfg.localLlmFastUrl === "string" && cfg.localLlmFastUrl.length > 0
        ? cfg.localLlmFastUrl
        : typeof cfg.localLlmUrl === "string" && cfg.localLlmUrl.length > 0
          ? cfg.localLlmUrl
          : "http://localhost:1234/v1",
    localLlmFastTimeoutMs:
      typeof cfg.localLlmFastTimeoutMs === "number" ? cfg.localLlmFastTimeoutMs : 15_000,
    // Thinking-mode suppression on the main local LLM (issue #548).
    // Default true — extraction / consolidation produce structured
    // JSON and gain nothing from chain-of-thought; thinking-capable
    // models burn their token budget on reasoning and blow the
    // default 60s timeout.  Operators who need thinking on the main
    // client (e.g. for narrative tasks) can set this to false via
    // config or --config CLI flag.  The fast-tier `fastLlm` always
    // disables thinking and is unaffected by this flag.
    //
    // Injection is backend-gated inside LocalLlmClient: the
    // `chat_template_kwargs` field is only sent when the detected
    // backend is in `THINKING_COMPATIBLE_BACKENDS` (LM Studio, vLLM).
    // Strict OpenAI-compatible backends reject unknown request
    // fields with 400, so the client fails open on unknown backends
    // rather than tripping the 400 cooldown (Codex P1 on PR #550).
    localLlmDisableThinking:
      coerceBool(cfg.localLlmDisableThinking) ?? true,
    // Gateway config (passed from index.ts for fallback AI)
    gatewayConfig: cfg.gatewayConfig as PluginConfig["gatewayConfig"],
    // Gateway model source (v9.2) — route LLM calls through gateway agent model chain
    modelSource,
    gatewayAgentId:
      typeof cfg.gatewayAgentId === "string" && cfg.gatewayAgentId.length > 0
        ? cfg.gatewayAgentId
        : "",
    fastGatewayAgentId:
      typeof cfg.fastGatewayAgentId === "string" && cfg.fastGatewayAgentId.length > 0
        ? cfg.fastGatewayAgentId
        : "",
    taskModelChain,

    // v3.0 namespaces (default off)
    namespacesEnabled: cfg.namespacesEnabled === true,
    // Namespace catalog (issue #1499): default ON, but only does anything when
    // namespacesEnabled is also true (the catalog is inert otherwise). Operators
    // opt out with namespaceCatalogEnabled: false. Boolean-like opt-outs from
    // CLI/env/JSON ("false", "0", "no", "off") are honored (CLAUDE.md rule #36);
    // a PRESENT but unrecognized value ("flase", 2) is REJECTED rather than
    // silently defaulting to enabled (CLAUDE.md rule #51); default to enabled
    // only when the value is absent.
    namespaceCatalogEnabled: resolveNamespaceCatalogEnabled(cfg.namespaceCatalogEnabled, rawOperatorConfig, runtimeSet),
    // Namespace catalog touch-path performance knobs (issue #1903). Numerics use
    // resolveNonNegativeIntegerConfig so 0 is an accepted disable switch; a
    // present-but-invalid value (negative/non-integer) is REJECTED (rule #51).
    namespacesCatalogCompactBytes: resolveNonNegativeIntegerConfig(
      cfg.namespacesCatalogCompactBytes,
      16 * 1024 * 1024,
      "namespacesCatalogCompactBytes",
    ),
    namespacesCatalogReadTouchCoalesceMs: resolveNonNegativeIntegerConfig(
      cfg.namespacesCatalogReadTouchCoalesceMs,
      60_000,
      "namespacesCatalogReadTouchCoalesceMs",
    ),
    namespacesCatalogWriteTouchCoalesceMs: resolveNonNegativeIntegerConfig(
      cfg.namespacesCatalogWriteTouchCoalesceMs,
      1_000,
      "namespacesCatalogWriteTouchCoalesceMs",
    ),
    namespacesCatalogTouchStateWrites: resolveBooleanConfig(
      cfg.namespacesCatalogTouchStateWrites,
      false,
      "namespacesCatalogTouchStateWrites",
    ),
    // NOTE: namespace identifiers are intentionally NOT sanitized here — the
    // codebase rejects unsafe namespaces at the point of use (see
    // codex-materialize-runner and NamespaceStorageRouter / resolveNamespaceDir),
    // so a "../x" value is surfaced as an explicit error rather than silently
    // rewritten. Containment is enforced at the filesystem sinks.
    defaultNamespace:
      typeof cfg.defaultNamespace === "string" && cfg.defaultNamespace.length > 0 ? cfg.defaultNamespace : "default",
    sharedNamespace:
      typeof cfg.sharedNamespace === "string" && cfg.sharedNamespace.length > 0 ? cfg.sharedNamespace : "shared",
    principalFromSessionKeyMode:
      cfg.principalFromSessionKeyMode === "prefix"
        ? "prefix"
        : cfg.principalFromSessionKeyMode === "regex"
          ? "regex"
          : "map",
    principalFromSessionKeyRules: principalRules,
    namespacePolicies: Array.isArray(cfg.namespacePolicies)
      ? (cfg.namespacePolicies as any[]).map((p) => ({
          name: typeof p?.name === "string" ? p.name : "",
          readPrincipals: Array.isArray(p?.readPrincipals) ? p.readPrincipals.filter((x: any) => typeof x === "string") : [],
          writePrincipals: Array.isArray(p?.writePrincipals) ? p.writePrincipals.filter((x: any) => typeof x === "string") : [],
          includeInRecallByDefault: p?.includeInRecallByDefault === true,
        })).filter((p) => p.name.length > 0)
      : [],
    defaultRecallNamespaces: Array.isArray(cfg.defaultRecallNamespaces) ? ["self", "shared"].filter((x) => (cfg.defaultRecallNamespaces as any[]).includes(x)) as any : ["self", "shared"],
    scopeProfiles,
    defaultScopeProfile,
    teams,
    cronRecallMode:
      cfg.cronRecallMode === "none"
        ? "none"
        : cfg.cronRecallMode === "allowlist"
          ? "allowlist"
          : "all",
    cronRecallAllowlist: Array.isArray(cfg.cronRecallAllowlist)
      ? (cfg.cronRecallAllowlist as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
      : [],
    cronRecallPolicyEnabled: cfg.cronRecallPolicyEnabled !== false,
    cronRecallNormalizedQueryMaxChars:
      typeof cfg.cronRecallNormalizedQueryMaxChars === "number"
        ? cfg.cronRecallNormalizedQueryMaxChars
        : 480,
    cronRecallInstructionHeavyTokenCap:
      typeof cfg.cronRecallInstructionHeavyTokenCap === "number"
        ? cfg.cronRecallInstructionHeavyTokenCap
        : 36,
    cronConversationRecallMode:
      cfg.cronConversationRecallMode === "always"
        ? "always"
        : cfg.cronConversationRecallMode === "never"
          ? "never"
          : "auto",
    autoPromoteToSharedEnabled: cfg.autoPromoteToSharedEnabled === true,
    autoPromoteToSharedCategories: Array.isArray(cfg.autoPromoteToSharedCategories)
      ? (cfg.autoPromoteToSharedCategories as any[]).filter((c) => c === "fact" || c === "correction" || c === "decision" || c === "preference")
      : ["fact", "correction", "decision", "preference"],
    autoPromoteMinConfidenceTier:
      cfg.autoPromoteMinConfidenceTier === "explicit"
        ? "explicit"
        : cfg.autoPromoteMinConfidenceTier === "implied"
          ? "implied"
          : "explicit",
    routingRulesEnabled: cfg.routingRulesEnabled === true,
    routingRulesStateFile:
      typeof cfg.routingRulesStateFile === "string" && cfg.routingRulesStateFile.trim().length > 0
        ? cfg.routingRulesStateFile.trim()
        : "state/routing-rules.json",

    // v4.0 shared-context (default off)
    sharedContextEnabled: cfg.sharedContextEnabled === true,
    // CLI values arrive as strings (`--config sharedContextAllowBindingAuthority=true`),
    // so a strict `=== true` silently keeps the feature off. Default stays false.
    sharedContextAllowBindingAuthority:
      coerceBool(cfg.sharedContextAllowBindingAuthority, "sharedContextAllowBindingAuthority") ?? false,
    sharedContextDir:
      typeof cfg.sharedContextDir === "string" && cfg.sharedContextDir.length > 0 ? cfg.sharedContextDir : undefined,
    sharedContextMaxInjectChars:
      typeof cfg.sharedContextMaxInjectChars === "number" ? cfg.sharedContextMaxInjectChars : 4000,
    sharedCrossSignalSemanticEnabled,
    sharedCrossSignalSemanticTimeoutMs,
    sharedCrossSignalSemanticMaxCandidates:
      typeof cfg.sharedCrossSignalSemanticMaxCandidates === "number"
        ? Math.max(0, Math.floor(cfg.sharedCrossSignalSemanticMaxCandidates))
        : 120,
    // Backward-compatible aliases.
    crossSignalsSemanticEnabled: sharedCrossSignalSemanticEnabled,
    crossSignalsSemanticTimeoutMs: sharedCrossSignalSemanticTimeoutMs,

    // v5.0 compounding (default off)
    compoundingEnabled: cfg.compoundingEnabled === true,
    compoundingWeeklyCronEnabled: cfg.compoundingWeeklyCronEnabled === true,
    compoundingSemanticEnabled: cfg.compoundingSemanticEnabled === true,
    compoundingSynthesisTimeoutMs:
      typeof cfg.compoundingSynthesisTimeoutMs === "number" ? cfg.compoundingSynthesisTimeoutMs : 15_000,
    compoundingInjectEnabled: cfg.compoundingInjectEnabled !== false,

    // IRC (Inductive Rule Consolidation) — preference synthesis
    ircEnabled: cfg.ircEnabled !== false,
    ircMaxPreferences: typeof cfg.ircMaxPreferences === "number" ? cfg.ircMaxPreferences : 20,
    ircIncludeCorrections: cfg.ircIncludeCorrections !== false,
    ircMinConfidence: typeof cfg.ircMinConfidence === "number" ? cfg.ircMinConfidence : 0.3,

    // CMC (Causal Memory Consolidation) — cross-session causal reasoning
    cmcEnabled: cfg.cmcEnabled === true,
    cmcStitchLookbackDays: typeof cfg.cmcStitchLookbackDays === "number" ? cfg.cmcStitchLookbackDays : 7,
    cmcStitchMinScore: typeof cfg.cmcStitchMinScore === "number" ? cfg.cmcStitchMinScore : 2.5,
    cmcStitchMaxEdgesPerTrajectory: typeof cfg.cmcStitchMaxEdgesPerTrajectory === "number" ? cfg.cmcStitchMaxEdgesPerTrajectory : 3,
    cmcConsolidationEnabled: cfg.cmcConsolidationEnabled === true,
    cmcConsolidationMinRecurrence: typeof cfg.cmcConsolidationMinRecurrence === "number" ? cfg.cmcConsolidationMinRecurrence : 3,
    cmcConsolidationMinSessions: typeof cfg.cmcConsolidationMinSessions === "number" ? cfg.cmcConsolidationMinSessions : 2,
    cmcConsolidationSuccessThreshold: typeof cfg.cmcConsolidationSuccessThreshold === "number" ? cfg.cmcConsolidationSuccessThreshold : 0.7,
    cmcRetrievalEnabled: cfg.cmcRetrievalEnabled === true,
    cmcRetrievalMaxDepth: typeof cfg.cmcRetrievalMaxDepth === "number" ? cfg.cmcRetrievalMaxDepth : 3,
    cmcRetrievalMaxChars: typeof cfg.cmcRetrievalMaxChars === "number" ? cfg.cmcRetrievalMaxChars : 800,
    cmcRetrievalCounterfactualBoost: typeof cfg.cmcRetrievalCounterfactualBoost === "number" ? cfg.cmcRetrievalCounterfactualBoost : 0.4,
    cmcBehaviorLearningEnabled: cfg.cmcBehaviorLearningEnabled === true,
    cmcBehaviorMinFrequency: typeof cfg.cmcBehaviorMinFrequency === "number" ? cfg.cmcBehaviorMinFrequency : 3,
    cmcBehaviorMinSessions: typeof cfg.cmcBehaviorMinSessions === "number" ? cfg.cmcBehaviorMinSessions : 2,
    cmcBehaviorConfidenceThreshold: typeof cfg.cmcBehaviorConfidenceThreshold === "number" ? cfg.cmcBehaviorConfidenceThreshold : 0.6,
    cmcLifecycleCausalImpactWeight: typeof cfg.cmcLifecycleCausalImpactWeight === "number" ? cfg.cmcLifecycleCausalImpactWeight : 0.05,

    // PEDC (Prediction-Error-Driven Calibration) — model-user alignment
    calibrationEnabled: cfg.calibrationEnabled === true,
    calibrationMaxRulesPerRecall: typeof cfg.calibrationMaxRulesPerRecall === "number" ? cfg.calibrationMaxRulesPerRecall : 10,
    calibrationMaxChars: typeof cfg.calibrationMaxChars === "number" ? cfg.calibrationMaxChars : 1200,

    // v7.0 Knowledge Graph Enhancement
    knowledgeIndexEnabled: cfg.knowledgeIndexEnabled !== false,
    knowledgeIndexMaxEntities:
      typeof cfg.knowledgeIndexMaxEntities === "number" ? cfg.knowledgeIndexMaxEntities : 40,
    knowledgeIndexMaxChars:
      typeof cfg.knowledgeIndexMaxChars === "number" ? cfg.knowledgeIndexMaxChars : 4000,
    entityRetrievalEnabled: cfg.entityRetrievalEnabled !== false,
    entityRetrievalMaxChars:
      typeof cfg.entityRetrievalMaxChars === "number" ? cfg.entityRetrievalMaxChars : 2400,
    entityRetrievalMaxHints:
      typeof cfg.entityRetrievalMaxHints === "number" ? cfg.entityRetrievalMaxHints : 2,
    entityRetrievalMaxSupportingFacts:
      typeof cfg.entityRetrievalMaxSupportingFacts === "number" ? cfg.entityRetrievalMaxSupportingFacts : 6,
    entityRetrievalMaxRelatedEntities:
      typeof cfg.entityRetrievalMaxRelatedEntities === "number" ? cfg.entityRetrievalMaxRelatedEntities : 3,
    entityRetrievalRecentTurns:
      typeof cfg.entityRetrievalRecentTurns === "number" ? cfg.entityRetrievalRecentTurns : 6,
    entitySchemas,
    recallBudgetChars: recallPipelineConfig.recallBudgetChars,
    recallProfileMaxRatio: parseRecallProfileMaxRatio(cfg.recallProfileMaxRatio),
    recallOuterTimeoutMs:
      typeof cfg.recallOuterTimeoutMs === "number" ? Math.max(0, Math.floor(cfg.recallOuterTimeoutMs)) : 75_000,
    recallCoreDeadlineMs:
      typeof cfg.recallCoreDeadlineMs === "number" ? Math.max(0, Math.floor(cfg.recallCoreDeadlineMs)) : 75_000,
    recallEnrichmentDeadlineMs:
      typeof cfg.recallEnrichmentDeadlineMs === "number"
        ? Math.max(0, Math.floor(cfg.recallEnrichmentDeadlineMs))
        : 25_000,
    recallPipeline: recallPipelineConfig.pipeline,
    recallMmrEnabled: cfg.recallMmrEnabled !== false,
    recallMmrLambda:
      typeof cfg.recallMmrLambda === "number" && Number.isFinite(cfg.recallMmrLambda)
        ? Math.min(1, Math.max(0, cfg.recallMmrLambda))
        : 0.7,
    recallMmrTopN:
      typeof cfg.recallMmrTopN === "number" && Number.isFinite(cfg.recallMmrTopN)
        ? Math.max(0, Math.floor(cfg.recallMmrTopN))
        : 40,
    // Issue #564 PR 3: off by default; enable explicitly after bench validation.
    recallReasoningTraceBoostEnabled:
      coerceBool(cfg.recallReasoningTraceBoostEnabled) ?? false,
    // Issue #1582: off by default — handles are byte-additive at injection time.
    recallMemoryHandles: coerceBool(cfg.recallMemoryHandles) ?? false,
    recallHandleSnapshotDepth:
      typeof cfg.recallHandleSnapshotDepth === "number" &&
      Number.isFinite(cfg.recallHandleSnapshotDepth)
        ? Math.max(1, Math.min(50, Math.floor(cfg.recallHandleSnapshotDepth)))
        : 5,
    qmdRecallCacheTtlMs:
      typeof cfg.qmdRecallCacheTtlMs === "number" ? Math.max(0, Math.floor(cfg.qmdRecallCacheTtlMs)) : 60_000,
    qmdRecallCacheStaleTtlMs:
      typeof cfg.qmdRecallCacheStaleTtlMs === "number"
        ? Math.max(0, Math.floor(cfg.qmdRecallCacheStaleTtlMs))
        : 10 * 60_000,
    qmdRecallCacheMaxEntries:
      typeof cfg.qmdRecallCacheMaxEntries === "number"
        ? Math.max(0, Math.floor(cfg.qmdRecallCacheMaxEntries))
        : 128,
    entityRelationshipsEnabled: cfg.entityRelationshipsEnabled !== false,
    entityActivityLogEnabled: cfg.entityActivityLogEnabled !== false,
    entityActivityLogMaxEntries:
      typeof cfg.entityActivityLogMaxEntries === "number" ? cfg.entityActivityLogMaxEntries : 20,
    entityAliasesEnabled: cfg.entityAliasesEnabled !== false,
    entitySummaryEnabled: cfg.entitySummaryEnabled !== false,
    entitySynthesisMaxTokens:
      typeof cfg.entitySynthesisMaxTokens === "number" && Number.isFinite(cfg.entitySynthesisMaxTokens)
        ? (() => {
            const tokens = Math.max(0, Math.floor(cfg.entitySynthesisMaxTokens));
            return tokens === 0 ? 0 : Math.max(10, tokens);
          })()
        : 500,

    // Search backend abstraction
    searchBackend: (["qmd", "remote", "noop", "lancedb", "meilisearch", "orama"] as const).includes(cfg.searchBackend as any)
      ? (cfg.searchBackend as "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama")
      : "qmd",
    remoteSearchBaseUrl: typeof cfg.remoteSearchBaseUrl === "string" ? cfg.remoteSearchBaseUrl : undefined,
    remoteSearchApiKey: typeof cfg.remoteSearchApiKey === "string" ? cfg.remoteSearchApiKey : undefined,
    remoteSearchTimeoutMs: typeof cfg.remoteSearchTimeoutMs === "number" ? cfg.remoteSearchTimeoutMs : 30_000,

    // LanceDB backend
    lancedbEnabled: cfg.lancedbEnabled === true,
    lanceDbPath: typeof cfg.lanceDbPath === "string" ? cfg.lanceDbPath : path.join(memoryDir, "lancedb"),
    lanceEmbeddingDimension: typeof cfg.lanceEmbeddingDimension === "number" ? cfg.lanceEmbeddingDimension : 1536,

    // Meilisearch backend
    meilisearchEnabled: cfg.meilisearchEnabled === true,
    meilisearchHost: typeof cfg.meilisearchHost === "string" ? cfg.meilisearchHost : "http://localhost:7700",
    meilisearchApiKey: typeof cfg.meilisearchApiKey === "string" ? cfg.meilisearchApiKey : undefined,
    meilisearchTimeoutMs: typeof cfg.meilisearchTimeoutMs === "number" ? cfg.meilisearchTimeoutMs : 30_000,
    meilisearchAutoIndex: cfg.meilisearchAutoIndex === true,

    // Orama backend
    oramaEnabled: cfg.oramaEnabled === true,
    oramaDbPath: typeof cfg.oramaDbPath === "string" ? cfg.oramaDbPath : path.join(memoryDir, "orama"),
    oramaEmbeddingDimension: typeof cfg.oramaEmbeddingDimension === "number" ? cfg.oramaEmbeddingDimension : 1536,
    // CJK/Thai lexical segmentation (issue #2187) — default on; string forms
    // from CLI `--config` are coerced like neighboring boolean flags.
    oramaCjkSegmentation: coerceBooleanLike(cfg.oramaCjkSegmentation) ?? true,

    // QMD daemon mode
    qmdDaemonEnabled: cfg.qmdDaemonEnabled !== false,
    qmdDaemonUrl:
      typeof cfg.qmdDaemonUrl === "string" && cfg.qmdDaemonUrl.length > 0
        ? cfg.qmdDaemonUrl
        : "http://localhost:8181/mcp",
    qmdDaemonRecheckIntervalMs:
      typeof cfg.qmdDaemonRecheckIntervalMs === "number" ? cfg.qmdDaemonRecheckIntervalMs : 15_000,
    qmdIntentHintsEnabled: cfg.qmdIntentHintsEnabled === true,
    qmdExplainEnabled: cfg.qmdExplainEnabled === true,

    // v6.0 Fact deduplication & archival
    factDeduplicationEnabled: cfg.factDeduplicationEnabled !== false,
    ...parseWritePathDedupConfig(cfg),
    ...parseSemanticMergeConfig(cfg),
    factArchivalEnabled: cfg.factArchivalEnabled === true,
    factArchivalAgeDays:
      typeof cfg.factArchivalAgeDays === "number" ? cfg.factArchivalAgeDays : 90,
    factArchivalMaxImportance:
      typeof cfg.factArchivalMaxImportance === "number" ? cfg.factArchivalMaxImportance : 0.3,
    factArchivalMaxAccessCount:
      typeof cfg.factArchivalMaxAccessCount === "number" ? cfg.factArchivalMaxAccessCount : 2,
    factArchivalProtectedCategories: Array.isArray(cfg.factArchivalProtectedCategories)
      ? (cfg.factArchivalProtectedCategories as any[]).filter((c) => typeof c === "string")
      : ["commitment", "preference", "decision", "principle", "procedure"],
    // Lifecycle policy engine (issue #686 PR 3/6 — flipped default to
    // `true`).  Tier infrastructure (`tier-routing.ts`,
    // `tier-migration.ts`, separate cold QMD collection) has shipped
    // for several releases.  Default-on lets the year-2 retention
    // story land for every install instead of staying gated behind
    // an opt-in flag the typical operator never reaches.  Operators
    // who need pre-#686 behavior (no automatic hot↔cold migration,
    // no recall-time stale filtering) can set
    // `lifecyclePolicyEnabled: false` explicitly. Coerce string/number
    // boolean-likes (e.g. CLI `--config lifecyclePolicyEnabled=false`)
    // before applying the default — otherwise an explicit false-ish
    // input falls through and silently re-enables the policy.
    // Issue #678 PR 2/4: dreams.phases.lightSleep.* WINS over legacy keys.
    // The runtime gate (orchestrator's `runLifecyclePolicyPass`) reads
    // these legacy fields, so propagate the precedence here.
    lifecyclePolicyEnabled: dreamsLightSleep.enabled,
    lifecycleFilterStaleEnabled: dreamsLightSleep.filterStaleEnabled,
    lifecyclePromoteHeatThreshold: dreamsLightSleep.promoteHeatThreshold,
    lifecycleStaleDecayThreshold: dreamsLightSleep.staleDecayThreshold,
    lifecycleArchiveDecayThreshold: dreamsLightSleep.archiveDecayThreshold,
    lifecycleProtectedCategories: Array.isArray(cfg.lifecycleProtectedCategories)
      ? (cfg.lifecycleProtectedCategories as any[]).filter(
          (c): c is PluginConfig["lifecycleProtectedCategories"][number] =>
            typeof c === "string" && VALID_MEMORY_CATEGORIES.has(c),
        )
      : ["decision", "principle", "commitment", "preference", "procedure"],
    // Mirror the *resolved* lifecyclePolicyEnabled default (not the
    // raw input) — otherwise omitting both flags returns `false` for
    // metrics even though the policy is enabled by default since
    // #686 PR 3/6.
    // Issue #678 PR 2/4: mirror the resolved dreams light-sleep enabled flag
    // (which already incorporates dreams.phases precedence + legacy fallback).
    lifecycleMetricsEnabled:
      coerceBooleanLike(cfg.lifecycleMetricsEnabled) ?? dreamsLightSleep.enabled,
    // v8.3 proactive + policy learning (default off)
    proactiveExtractionEnabled: cfg.proactiveExtractionEnabled === true,
    contextCompressionActionsEnabled: cfg.contextCompressionActionsEnabled === true,
    compressionGuidelineLearningEnabled: cfg.compressionGuidelineLearningEnabled === true,
    compressionGuidelineSemanticRefinementEnabled:
      cfg.compressionGuidelineSemanticRefinementEnabled === true,
    compressionGuidelineSemanticTimeoutMs:
      typeof cfg.compressionGuidelineSemanticTimeoutMs === "number"
        ? Math.max(1, Math.floor(cfg.compressionGuidelineSemanticTimeoutMs))
        : 2500,
    maxProactiveQuestionsPerExtraction:
      typeof cfg.maxProactiveQuestionsPerExtraction === "number"
        ? Math.max(0, Math.floor(cfg.maxProactiveQuestionsPerExtraction))
        : 2,
    proactiveExtractionTimeoutMs:
      typeof cfg.proactiveExtractionTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.proactiveExtractionTimeoutMs))
        : 2500,
    proactiveExtractionSkipWhenLocalLlmBusy: ((): boolean => {
      const raw = cfg.proactiveExtractionSkipWhenLocalLlmBusy;
      if (raw === undefined || raw === null) return true;
      const value = coerceBooleanLike(raw, "proactiveExtractionSkipWhenLocalLlmBusy");
      if (value === undefined) {
        throw new Error(
          `proactiveExtractionSkipWhenLocalLlmBusy must be boolean-like (true|false|1|0|yes|no|on|off); got ${JSON.stringify(raw)}`,
        );
      }
      return value;
    })(),
    proactiveExtractionMaxTokens:
      typeof cfg.proactiveExtractionMaxTokens === "number"
        ? Math.max(0, Math.floor(cfg.proactiveExtractionMaxTokens))
        : 900,
    extractionMaxOutputTokens:
      typeof cfg.extractionMaxOutputTokens === "number"
        ? Math.max(1, Math.floor(cfg.extractionMaxOutputTokens))
        : 16384,
    proactiveExtractionCategoryAllowlist: Array.isArray(cfg.proactiveExtractionCategoryAllowlist)
      ? (cfg.proactiveExtractionCategoryAllowlist as unknown[]).filter(
          (category): category is PluginConfig["lifecycleProtectedCategories"][number] =>
            typeof category === "string" && VALID_MEMORY_CATEGORIES.has(category),
        )
      : undefined,
    maxCompressionTokensPerHour:
      typeof cfg.maxCompressionTokensPerHour === "number"
        ? Math.max(0, Math.floor(cfg.maxCompressionTokensPerHour))
        : 1500,
    ...parseActiveContextFields(cfg),
    behaviorLoopAutoTuneEnabled: cfg.behaviorLoopAutoTuneEnabled === true,
    behaviorLoopLearningWindowDays:
      typeof cfg.behaviorLoopLearningWindowDays === "number"
        ? Math.max(0, Math.floor(cfg.behaviorLoopLearningWindowDays))
        : 14,
    behaviorLoopMinSignalCount:
      typeof cfg.behaviorLoopMinSignalCount === "number"
        ? Math.max(0, Math.floor(cfg.behaviorLoopMinSignalCount))
        : 10,
    behaviorLoopMaxDeltaPerCycle:
      typeof cfg.behaviorLoopMaxDeltaPerCycle === "number"
        ? Math.min(1, Math.max(0, cfg.behaviorLoopMaxDeltaPerCycle))
        : 0.1,
    behaviorLoopProtectedParams: Array.isArray(cfg.behaviorLoopProtectedParams)
      ? (cfg.behaviorLoopProtectedParams as unknown[])
          .filter((param): param is string => typeof param === "string" && param.trim().length > 0)
      : [...DEFAULT_BEHAVIOR_LOOP_PROTECTED_PARAMS],
    // v8.0 phase 1
    // All recallPlanner boolean gates coerce boolean-like strings so CLI/env
    // surfaces (`--config recallPlanner*=true|false`) behave correctly — the
    // shadow-mode/telemetry/enable flags are documented rollout switches and
    // must not silently ignore string values (gotcha #36, #1428 review).
    recallPlannerEnabled: coerceBooleanLike(cfg.recallPlannerEnabled) ?? true,
    // Issue #1367 / Option C: LLM-based recall planning is opt-in so the
    // default recall path stays heuristic (no added latency / LLM call unless
    // the operator asks for it — gotcha #30). Coerce boolean-like strings so
    // CLI/env surfaces (`--config recallPlannerLlmEnabled=true`) actually
    // enable it (gotcha #36); defaults off.
    recallPlannerLlmEnabled: coerceBooleanLike(cfg.recallPlannerLlmEnabled) ?? false,
    // Gateway-routed via FallbackLlmClient (qualifiedPlannerModel drops bare ids).
    // Drop the bare schema-default model in gateway mode too so the resolved value
    // reflects the actual gateway route (task-chain primary) instead of "gpt-5.5".
    recallPlannerModel:
      gatewayTaskModel(
        typeof cfg.recallPlannerModel === "string" && cfg.recallPlannerModel.trim().length > 0
          ? cfg.recallPlannerModel.trim()
          : "",
      ) || taskModelFallback,
    recallPlannerTimeoutMs:
      typeof cfg.recallPlannerTimeoutMs === "number" ? cfg.recallPlannerTimeoutMs : 1500,
    recallPlannerUseResponsesApi: coerceBooleanLike(cfg.recallPlannerUseResponsesApi) ?? true,
    recallPlannerMaxPromptChars:
      typeof cfg.recallPlannerMaxPromptChars === "number" ? cfg.recallPlannerMaxPromptChars : 4000,
    recallPlannerMaxMemoryHints:
      typeof cfg.recallPlannerMaxMemoryHints === "number" ? cfg.recallPlannerMaxMemoryHints : 24,
    recallPlannerShadowMode: coerceBooleanLike(cfg.recallPlannerShadowMode) ?? false,
    recallPlannerTelemetryEnabled: coerceBooleanLike(cfg.recallPlannerTelemetryEnabled) ?? true,
    recallPlannerMaxQmdResultsMinimal:
      typeof cfg.recallPlannerMaxQmdResultsMinimal === "number"
        ? cfg.recallPlannerMaxQmdResultsMinimal
        : 4,
    recallPlannerMaxQmdResultsFull:
      typeof cfg.recallPlannerMaxQmdResultsFull === "number" ? cfg.recallPlannerMaxQmdResultsFull : 8,
    intentRoutingEnabled: cfg.intentRoutingEnabled === true,
    intentRoutingBoost:
      typeof cfg.intentRoutingBoost === "number" ? cfg.intentRoutingBoost : 0.12,
    verbatimArtifactsEnabled: cfg.verbatimArtifactsEnabled === true,
    verbatimArtifactsMinConfidence:
      typeof cfg.verbatimArtifactsMinConfidence === "number"
        ? cfg.verbatimArtifactsMinConfidence
        : 0.8,
    verbatimArtifactsMaxRecall:
      typeof cfg.verbatimArtifactsMaxRecall === "number" ? cfg.verbatimArtifactsMaxRecall : 5,
    verbatimArtifactCategories: Array.isArray(cfg.verbatimArtifactCategories)
      ? (cfg.verbatimArtifactCategories as any[]).filter(
          (c): c is PluginConfig["verbatimArtifactCategories"][number] =>
            typeof c === "string" && VALID_MEMORY_CATEGORIES.has(c),
        )
      : ["decision", "correction", "principle", "commitment"],
    // v8.0 Phase 2A: Memory Boxes + Trace Weaving
    memoryBoxesEnabled: cfg.memoryBoxesEnabled === true,
    boxTopicShiftThreshold:
      typeof cfg.boxTopicShiftThreshold === "number" ? cfg.boxTopicShiftThreshold : 0.35,
    boxTimeGapMs:
      typeof cfg.boxTimeGapMs === "number" ? cfg.boxTimeGapMs : 30 * 60 * 1000,
    boxMaxMemories:
      typeof cfg.boxMaxMemories === "number" ? cfg.boxMaxMemories : 50,
    traceWeaverEnabled: cfg.traceWeaverEnabled === true,
    traceWeaverLookbackDays:
      typeof cfg.traceWeaverLookbackDays === "number" ? cfg.traceWeaverLookbackDays : 7,
    traceWeaverOverlapThreshold:
      typeof cfg.traceWeaverOverlapThreshold === "number" ? cfg.traceWeaverOverlapThreshold : 0.4,
    boxRecallDays:
      typeof cfg.boxRecallDays === "number" ? cfg.boxRecallDays : 3,
    // v8.0 Phase 2B: Episode/Note dual store (HiMem)
    episodeNoteModeEnabled: cfg.episodeNoteModeEnabled === true,
    // v8.1: Temporal + Tag Indexes (SwiftMem-inspired)
    queryAwareIndexingEnabled: cfg.queryAwareIndexingEnabled === true,
    queryAwareIndexingMaxCandidates:
      typeof cfg.queryAwareIndexingMaxCandidates === "number"
        ? Math.max(0, cfg.queryAwareIndexingMaxCandidates) // clamp: negative treated as 0 (no cap)
        : 200,
    temporalIndexWindowDays:
      typeof cfg.temporalIndexWindowDays === "number" ? cfg.temporalIndexWindowDays : 30,
    temporalIndexMaxEntries:
      typeof cfg.temporalIndexMaxEntries === "number" ? cfg.temporalIndexMaxEntries : 5000,
    temporalBoostRecentDays:
      typeof cfg.temporalBoostRecentDays === "number" ? cfg.temporalBoostRecentDays : 7,
    temporalBoostScore: typeof cfg.temporalBoostScore === "number" ? cfg.temporalBoostScore : 0.15,
    temporalDecayEnabled: cfg.temporalDecayEnabled !== false,
    tagMemoryEnabled: cfg.tagMemoryEnabled === true,
    tagMaxPerMemory: typeof cfg.tagMaxPerMemory === "number" ? cfg.tagMaxPerMemory : 5,
    tagIndexMaxEntries:
      typeof cfg.tagIndexMaxEntries === "number" ? cfg.tagIndexMaxEntries : 10000,
    tagRecallBoost: typeof cfg.tagRecallBoost === "number" ? cfg.tagRecallBoost : 0.15,
    tagRecallMaxMatches: typeof cfg.tagRecallMaxMatches === "number" ? cfg.tagRecallMaxMatches : 10,
    // v8.2: Multi-graph memory (PR 18)
    multiGraphMemoryEnabled: cfg.multiGraphMemoryEnabled === true,
    graphRecallEnabled: cfg.graphRecallEnabled === true,
    graphRecallMaxExpansions:
      typeof cfg.graphRecallMaxExpansions === "number" ? cfg.graphRecallMaxExpansions : 3,
    graphRecallMaxPerSeed:
      typeof cfg.graphRecallMaxPerSeed === "number" ? cfg.graphRecallMaxPerSeed : 5,
    graphRecallMinEdgeWeight:
      typeof cfg.graphRecallMinEdgeWeight === "number" ? cfg.graphRecallMinEdgeWeight : 0.1,
    graphRecallShadowEnabled: cfg.graphRecallShadowEnabled === true,
    graphRecallSnapshotEnabled: cfg.graphRecallSnapshotEnabled === true,
    graphRecallShadowSampleRate:
      typeof cfg.graphRecallShadowSampleRate === "number" ? cfg.graphRecallShadowSampleRate : 0.1,
    graphRecallExplainToolEnabled: cfg.graphRecallExplainToolEnabled === true,
    graphRecallStoreColdMirror: cfg.graphRecallStoreColdMirror === true,
    graphRecallColdMirrorCollection:
      typeof cfg.graphRecallColdMirrorCollection === "string" &&
      cfg.graphRecallColdMirrorCollection.trim().length > 0
        ? cfg.graphRecallColdMirrorCollection.trim()
        : undefined,
    graphRecallColdMirrorMinAgeDays:
      typeof cfg.graphRecallColdMirrorMinAgeDays === "number" ? cfg.graphRecallColdMirrorMinAgeDays : 7,
    graphRecallUseEntityPriors: cfg.graphRecallUseEntityPriors === true,
    graphRecallEntityPriorBoost:
      typeof cfg.graphRecallEntityPriorBoost === "number" ? cfg.graphRecallEntityPriorBoost : 0.2,
    graphRecallPreferHubSeeds: cfg.graphRecallPreferHubSeeds === true,
    graphRecallHubBias:
      typeof cfg.graphRecallHubBias === "number" ? cfg.graphRecallHubBias : 0.3,
    graphRecallRecencyHalfLifeDays:
      typeof cfg.graphRecallRecencyHalfLifeDays === "number" ? cfg.graphRecallRecencyHalfLifeDays : 30,
    graphRecallDampingFactor:
      typeof cfg.graphRecallDampingFactor === "number" ? cfg.graphRecallDampingFactor : 0.85,
    graphRecallMaxSeedNodes:
      typeof cfg.graphRecallMaxSeedNodes === "number" ? cfg.graphRecallMaxSeedNodes : 10,
    graphRecallMaxExpandedNodes:
      typeof cfg.graphRecallMaxExpandedNodes === "number" ? cfg.graphRecallMaxExpandedNodes : 30,
    graphRecallMaxTrailPerNode:
      typeof cfg.graphRecallMaxTrailPerNode === "number" ? cfg.graphRecallMaxTrailPerNode : 5,
    graphRecallMinSeedScore:
      typeof cfg.graphRecallMinSeedScore === "number" ? cfg.graphRecallMinSeedScore : 0.3,
    graphRecallExpansionScoreThreshold:
      typeof cfg.graphRecallExpansionScoreThreshold === "number"
        ? cfg.graphRecallExpansionScoreThreshold
        : 0.2,
    graphRecallExplainMaxPaths:
      typeof cfg.graphRecallExplainMaxPaths === "number" ? cfg.graphRecallExplainMaxPaths : 3,
    graphRecallExplainMaxChars:
      typeof cfg.graphRecallExplainMaxChars === "number" ? cfg.graphRecallExplainMaxChars : 500,
    graphRecallExplainEdgeLimit:
      typeof cfg.graphRecallExplainEdgeLimit === "number" ? cfg.graphRecallExplainEdgeLimit : 5,
    graphRecallExplainEnabled: cfg.graphRecallExplainEnabled === true,
    graphRecallEntityHintsEnabled: cfg.graphRecallEntityHintsEnabled === true,
    graphRecallEntityHintMax:
      typeof cfg.graphRecallEntityHintMax === "number" ? cfg.graphRecallEntityHintMax : 3,
    graphRecallEntityHintMaxChars:
      typeof cfg.graphRecallEntityHintMaxChars === "number" ? cfg.graphRecallEntityHintMaxChars : 200,
    graphRecallSnapshotDir:
      typeof cfg.graphRecallSnapshotDir === "string" && cfg.graphRecallSnapshotDir.trim().length > 0
        ? cfg.graphRecallSnapshotDir.trim()
        : path.join(memoryDir, "state", "graph"),
    graphRecallEnableTrace: cfg.graphRecallEnableTrace === true,
    graphRecallEnableDebug: cfg.graphRecallEnableDebug === true,
    graphExpandedIntentEnabled: cfg.graphExpandedIntentEnabled !== false,
    graphAssistInFullModeEnabled: cfg.graphAssistInFullModeEnabled !== false,
    graphAssistShadowEvalEnabled: cfg.graphAssistShadowEvalEnabled === true,
    graphAssistMinSeedResults:
      typeof cfg.graphAssistMinSeedResults === "number"
        ? Math.max(1, Math.floor(cfg.graphAssistMinSeedResults))
        : 3,
    entityGraphEnabled: cfg.entityGraphEnabled !== false,
    timeGraphEnabled: cfg.timeGraphEnabled !== false,
    graphWriteSessionAdjacencyEnabled: cfg.graphWriteSessionAdjacencyEnabled !== false,
    causalGraphEnabled: cfg.causalGraphEnabled !== false,
    maxGraphTraversalSteps:
      typeof cfg.maxGraphTraversalSteps === "number" ? Math.max(0, cfg.maxGraphTraversalSteps) : 3,
    graphActivationDecay:
      typeof cfg.graphActivationDecay === "number"
        ? Math.min(1, Math.max(0, cfg.graphActivationDecay))
        : 0.7,
    graphPathScoring: parseGraphPathScoringConfig(
      cfg.graphPathScoring as Record<string, unknown> | undefined,
    ),
    graphExpansionActivationWeight:
      typeof cfg.graphExpansionActivationWeight === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionActivationWeight))
        : 0.65,
    graphExpansionBlendMin:
      typeof cfg.graphExpansionBlendMin === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionBlendMin))
        : 0.05,
    graphExpansionBlendMax:
      typeof cfg.graphExpansionBlendMax === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionBlendMax))
        : 0.95,
    maxEntityGraphEdgesPerMemory:
      typeof cfg.maxEntityGraphEdgesPerMemory === "number"
        ? Math.max(0, cfg.maxEntityGraphEdgesPerMemory)
        : 10,
    delinearizeEnabled: cfg.delinearizeEnabled !== false,
    recallConfidenceGateEnabled: cfg.recallConfidenceGateEnabled === true,
    recallConfidenceGateThreshold:
      typeof cfg.recallConfidenceGateThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.recallConfidenceGateThreshold))
        : 0.12,
    causalRuleExtractionEnabled: cfg.causalRuleExtractionEnabled === true,
    memoryReconstructionEnabled: cfg.memoryReconstructionEnabled === true,
    memoryReconstructionMaxExpansions:
      typeof cfg.memoryReconstructionMaxExpansions === "number" ? Math.max(0, Math.round(cfg.memoryReconstructionMaxExpansions)) : 3,
    graphLateralInhibitionEnabled: cfg.graphLateralInhibitionEnabled !== false,
    // Incremental GraphIndex edge cache (issue #1904). Default on: single-writer
    // edge appends are pushed into the warm cache in place (size-revalidated for
    // cross-process coherence) instead of nulling + re-reading the 6 MB edge
    // file. coerceBool handles string forms; set false to null the cache per write.
    graphEdgeCacheIncrementalEnabled: coerceBool(cfg.graphEdgeCacheIncrementalEnabled) ?? true,
    graphLateralInhibitionBeta:
      typeof cfg.graphLateralInhibitionBeta === "number"
        ? Math.max(0, Math.min(1, cfg.graphLateralInhibitionBeta))
        : 0.15,
    graphLateralInhibitionTopM:
      typeof cfg.graphLateralInhibitionTopM === "number"
        ? Math.max(0, Math.round(cfg.graphLateralInhibitionTopM))
        : 7,
    // Issue #681 PR 2/3 — graph-edge confidence decay maintenance.
    // Boolean coerced via shared helper (gotcha #36: string "false" is truthy).
    graphEdgeDecayEnabled: coerceBooleanLike(cfg.graphEdgeDecayEnabled) ?? false,
    graphEdgeDecayCadenceMs:
      typeof cfg.graphEdgeDecayCadenceMs === "number" && Number.isFinite(cfg.graphEdgeDecayCadenceMs)
        ? Math.max(60_000, Math.floor(cfg.graphEdgeDecayCadenceMs))
        : 7 * 24 * 60 * 60 * 1000,
    graphEdgeDecayWindowMs:
      typeof cfg.graphEdgeDecayWindowMs === "number" && Number.isFinite(cfg.graphEdgeDecayWindowMs)
        ? Math.max(60_000, Math.floor(cfg.graphEdgeDecayWindowMs))
        : 90 * 24 * 60 * 60 * 1000,
    graphEdgeDecayPerWindow:
      typeof cfg.graphEdgeDecayPerWindow === "number" && Number.isFinite(cfg.graphEdgeDecayPerWindow)
        ? Math.max(0, Math.min(1, cfg.graphEdgeDecayPerWindow))
        : 0.1,
    graphEdgeDecayFloor:
      typeof cfg.graphEdgeDecayFloor === "number" && Number.isFinite(cfg.graphEdgeDecayFloor)
        ? Math.max(0, Math.min(1, cfg.graphEdgeDecayFloor))
        : 0.1,
    graphEdgeDecayVisibilityThreshold:
      typeof cfg.graphEdgeDecayVisibilityThreshold === "number" &&
      Number.isFinite(cfg.graphEdgeDecayVisibilityThreshold)
        ? Math.max(0, Math.min(1, cfg.graphEdgeDecayVisibilityThreshold))
        : 0.2,
    // Issue #2119 — maintenance-scheduled memory-projection rebuild.
    // Enabled-by-default (gotcha #36 coercion); interval via the strict shared parser (strings coerced, non-integer/sub-60s rejected — pattern #39).
    projectionRebuildEnabled: coerceBooleanLike(cfg.projectionRebuildEnabled) ?? true,
    projectionRebuildIntervalMs: parseIntegerAtLeast(
      cfg.projectionRebuildIntervalMs, 6 * 60 * 60 * 1000, 60_000, "projectionRebuildIntervalMs"),
    ...parseBoundedJsonlStateConfig(cfg, parseIntegerAtLeast),
    // Issue #681 PR 3/3 — confidence-aware traversal. Floor clamps to [0,1]; a
    // documented 0 iterations disables PageRank refinement (BFS scores pass through).
    graphTraversalConfidenceFloor:
      typeof cfg.graphTraversalConfidenceFloor === "number" &&
      Number.isFinite(cfg.graphTraversalConfidenceFloor)
        ? Math.min(1, Math.max(0, cfg.graphTraversalConfidenceFloor))
        : 0.2,
    graphTraversalPageRankIterations:
      typeof cfg.graphTraversalPageRankIterations === "number" &&
      Number.isFinite(cfg.graphTraversalPageRankIterations) &&
      cfg.graphTraversalPageRankIterations >= 0
        ? Math.floor(cfg.graphTraversalPageRankIterations)
        : 8,
    // v8.2: Temporal Memory Tree
    temporalMemoryTreeEnabled: cfg.temporalMemoryTreeEnabled === true,
    tmtHourlyMinMemories:
      typeof cfg.tmtHourlyMinMemories === "number" ? cfg.tmtHourlyMinMemories : 3,
    tmtSummaryMaxTokens:
      typeof cfg.tmtSummaryMaxTokens === "number" ? cfg.tmtSummaryMaxTokens : 300,
    explicitCueRecallEnabled: coerceBool(cfg.explicitCueRecallEnabled) === true,
    explicitCueRecallMaxChars:
      coerceNumber(cfg.explicitCueRecallMaxChars) !== undefined
        ? Math.max(0, Math.floor(coerceNumber(cfg.explicitCueRecallMaxChars)!))
        : 2400,
    explicitCueRecallMaxReferences:
      coerceNumber(cfg.explicitCueRecallMaxReferences) !== undefined
        ? Math.max(0, Math.floor(coerceNumber(cfg.explicitCueRecallMaxReferences)!))
        : 24,
    targetedFactRecallEnabled: coerceBool(cfg.targetedFactRecallEnabled) === true,
    targetedFactRecallMaxChars:
      parseIntegerAtLeast(cfg.targetedFactRecallMaxChars, 2400, 0, "targetedFactRecallMaxChars"),
    targetedFactRecallMaxResults:
      parseIntegerAtLeast(cfg.targetedFactRecallMaxResults, 48, 0, "targetedFactRecallMaxResults"),
    targetedFactRecallScanWindowTurns:
      parseIntegerAtLeast(cfg.targetedFactRecallScanWindowTurns, 8, 1, "targetedFactRecallScanWindowTurns"),
    targetedFactRecallScanWindowTokens:
      parseIntegerAtLeast(cfg.targetedFactRecallScanWindowTokens, 12_000, 1, "targetedFactRecallScanWindowTokens"),
    focusedListRecallEnabled: coerceBool(cfg.focusedListRecallEnabled) === true,
    focusedListRecallMaxChars:
      parseIntegerAtLeast(cfg.focusedListRecallMaxChars, 2600, 0, "focusedListRecallMaxChars"),
    focusedListRecallMaxResults:
      parseIntegerAtLeast(cfg.focusedListRecallMaxResults, 40, 0, "focusedListRecallMaxResults"),
    focusedListRecallScanWindowTurns:
      parseIntegerAtLeast(cfg.focusedListRecallScanWindowTurns, 64, 1, "focusedListRecallScanWindowTurns"),
    focusedListRecallScanWindowTokens:
      parseIntegerAtLeast(cfg.focusedListRecallScanWindowTokens, 14_000, 1, "focusedListRecallScanWindowTokens"),
    responseGuidanceRecallEnabled:
      coerceBool(cfg.responseGuidanceRecallEnabled) === true,
    responseGuidanceRecallMaxChars:
      parseIntegerAtLeast(cfg.responseGuidanceRecallMaxChars, 2400, 0, "responseGuidanceRecallMaxChars"),
    responseGuidanceRecallMaxResults:
      parseIntegerAtLeast(cfg.responseGuidanceRecallMaxResults, 48, 0, "responseGuidanceRecallMaxResults"),
    responseGuidanceRecallScanWindowTurns:
      parseIntegerAtLeast(cfg.responseGuidanceRecallScanWindowTurns, 64, 1, "responseGuidanceRecallScanWindowTurns"),
    responseGuidanceRecallScanWindowTokens:
      parseIntegerAtLeast(cfg.responseGuidanceRecallScanWindowTokens, 16_000, 1, "responseGuidanceRecallScanWindowTokens"),
    eventOrderRecallEnabled: coerceBool(cfg.eventOrderRecallEnabled) === true,
    eventOrderRecallMaxChars:
      parseIntegerAtLeast(cfg.eventOrderRecallMaxChars, 2400, 0, "eventOrderRecallMaxChars"),
    eventOrderRecallMaxResults:
      parseIntegerAtLeast(cfg.eventOrderRecallMaxResults, 24, 0, "eventOrderRecallMaxResults"),
    eventOrderRecallScanWindowTurns:
      parseIntegerAtLeast(cfg.eventOrderRecallScanWindowTurns, 12, 1, "eventOrderRecallScanWindowTurns"),
    eventOrderRecallScanWindowTokens:
      parseIntegerAtLeast(cfg.eventOrderRecallScanWindowTokens, 24_000, 1, "eventOrderRecallScanWindowTokens"),
    // Lossless Context Management (LCM)
    lcmEnabled: cfg.lcmEnabled === true,
    lcmLeafBatchSize:
      typeof cfg.lcmLeafBatchSize === "number" ? Math.max(2, Math.floor(cfg.lcmLeafBatchSize)) : 8,
    lcmRollupFanIn:
      typeof cfg.lcmRollupFanIn === "number" ? Math.max(2, Math.floor(cfg.lcmRollupFanIn)) : 4,
    lcmFreshTailTurns:
      typeof cfg.lcmFreshTailTurns === "number" ? Math.max(1, Math.floor(cfg.lcmFreshTailTurns)) : 16,
    lcmMaxDepth:
      typeof cfg.lcmMaxDepth === "number" ? Math.max(1, Math.floor(cfg.lcmMaxDepth)) : 5,
    lcmRecallBudgetShare:
      typeof cfg.lcmRecallBudgetShare === "number"
        ? Math.max(0, Math.min(1, cfg.lcmRecallBudgetShare))
        : 0.15,
    lcmDeterministicMaxTokens:
      typeof cfg.lcmDeterministicMaxTokens === "number"
        ? Math.max(64, Math.floor(cfg.lcmDeterministicMaxTokens))
        : 512,
    lcmTelemetryPrefilterEnabled:
      coerceBool(cfg.lcmTelemetryPrefilterEnabled) !== false,
    lcmArchiveRetentionDays:
      typeof cfg.lcmArchiveRetentionDays === "number"
        ? Math.max(1, Math.floor(cfg.lcmArchiveRetentionDays))
        : 90,
    lcmObserveConcurrency:
      parseIntegerAtLeast(cfg.lcmObserveConcurrency, 1, 1, "lcmObserveConcurrency"),
    messagePartsEnabled: coerceBooleanLike(cfg.messagePartsEnabled) === true,
    messagePartsRecallMaxResults:
      typeof cfg.messagePartsRecallMaxResults === "number"
        ? Math.max(0, Math.floor(cfg.messagePartsRecallMaxResults))
        : 6,

    // v9.1 Parallel Specialized Retrieval
    parallelRetrievalEnabled: cfg.parallelRetrievalEnabled === true,
    parallelAgentWeights: (() => {
      const w = cfg.parallelAgentWeights as Record<string, unknown> | undefined;
      return {
        direct: typeof w?.direct === "number" ? Math.max(0, w.direct) : 1.0,
        contextual: typeof w?.contextual === "number" ? Math.max(0, w.contextual) : 0.7,
        temporal: typeof w?.temporal === "number" ? Math.max(0, w.temporal) : 0.85,
      };
    })(),
    parallelMaxResultsPerAgent:
      typeof cfg.parallelMaxResultsPerAgent === "number"
        ? Math.max(0, Math.floor(cfg.parallelMaxResultsPerAgent))
        : 20,

    briefing: parseBriefingConfig(cfg.briefing),

    // Codex CLI connector settings (install-time)
    codex: (() => {
      const raw =
        cfg.codex && typeof cfg.codex === "object" && !Array.isArray(cfg.codex)
          ? (cfg.codex as Record<string, unknown>)
          : {};
      // Coerce string "false"/"0"/"no" → false and "true"/"1"/"yes" → true so
      // that CLI inputs like --config installExtension=false are handled correctly.
      // Missing / undefined defaults to true (coerceInstallExtension returns
      // undefined for unknown values, so ?? true applies the default).
      const installExtension = coerceInstallExtension(raw.installExtension) ?? true;
      const codexHome =
        typeof raw.codexHome === "string" && raw.codexHome.trim().length > 0
          ? raw.codexHome.trim()
          : null;
      return { installExtension, codexHome };
    })(),

    // Live connectors (issue #683 PR 2/N).
    //
    // Per CLAUDE.md gotcha #30 and #48, every concrete connector ships
    // disabled-by-default and the parser MUST reject malformed top-level
    // shapes loudly (gotcha #51) rather than silently producing an empty
    // object.
    //
    // We do NOT validate credential strings here — the connector module
    // re-validates on every sync pass via `validateGoogleDriveConfig`.
    // That keeps secret-store-driven values (which may legitimately be
    // empty until the operator runs setup) round-trippable through the
    // config layer without crashing the orchestrator at boot.
    connectors: (() => {
      if (
        cfg.connectors !== undefined &&
        (cfg.connectors === null ||
          typeof cfg.connectors !== "object" ||
          Array.isArray(cfg.connectors))
      ) {
        throw new Error(
          `connectors must be an object (got ${JSON.stringify(cfg.connectors)}). ` +
            `Use connectors: {} to opt out of every live connector.`,
        );
      }
      const rawConnectors =
        cfg.connectors && typeof cfg.connectors === "object" && !Array.isArray(cfg.connectors)
          ? (cfg.connectors as Record<string, unknown>)
          : {};
      // googleDrive (#683 PR 2/N)
      if (
        rawConnectors.googleDrive !== undefined &&
        (rawConnectors.googleDrive === null ||
          typeof rawConnectors.googleDrive !== "object" ||
          Array.isArray(rawConnectors.googleDrive))
      ) {
        throw new Error(
          `connectors.googleDrive must be an object (got ${JSON.stringify(rawConnectors.googleDrive)}).`,
        );
      }
      const rawDrive =
        rawConnectors.googleDrive &&
        typeof rawConnectors.googleDrive === "object" &&
        !Array.isArray(rawConnectors.googleDrive)
          ? (rawConnectors.googleDrive as Record<string, unknown>)
          : {};
      const driveEnabled = coerceBool(rawDrive.enabled) === true;
      const driveClientId =
        typeof rawDrive.clientId === "string" ? rawDrive.clientId : "";
      const driveClientSecret =
        typeof rawDrive[CLIENT_SECRET_FIELD] === "string"
          ? rawDrive[CLIENT_SECRET_FIELD]
          : "";
      const driveRefreshToken =
        typeof rawDrive[REFRESH_TOKEN_FIELD] === "string"
          ? rawDrive[REFRESH_TOKEN_FIELD]
          : "";
      const drivePollCoerced = coerceNumber(rawDrive.pollIntervalMs);
      let drivePollIntervalMs = 300_000;
      if (drivePollCoerced !== undefined) {
        if (
          !Number.isFinite(drivePollCoerced) ||
          !Number.isInteger(drivePollCoerced) ||
          drivePollCoerced < 1_000 ||
          drivePollCoerced > 86_400_000
        ) {
          throw new Error(
            `connectors.googleDrive.pollIntervalMs must be an integer in [1000, 86400000] ms (got ${JSON.stringify(rawDrive.pollIntervalMs)})`,
          );
        }
        drivePollIntervalMs = drivePollCoerced;
      }
      let driveFolderIds: string[] = [];
      if (rawDrive.folderIds !== undefined) {
        if (!Array.isArray(rawDrive.folderIds)) {
          throw new Error(
            `connectors.googleDrive.folderIds must be an array of strings (got ${typeof rawDrive.folderIds})`,
          );
        }
        const seen = new Set<string>();
        for (const value of rawDrive.folderIds) {
          if (typeof value !== "string") {
            throw new Error(
              `connectors.googleDrive.folderIds entries must be strings; found ${typeof value}`,
            );
          }
          const trimmed = value.trim();
          if (trimmed.length === 0) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          driveFolderIds.push(trimmed);
        }
      }
      // notion (#683 PR 3/N)
      if (
        rawConnectors.notion !== undefined &&
        (rawConnectors.notion === null ||
          typeof rawConnectors.notion !== "object" ||
          Array.isArray(rawConnectors.notion))
      ) {
        throw new Error(
          `connectors.notion must be an object (got ${JSON.stringify(rawConnectors.notion)}).`,
        );
      }
      const rawNotion =
        rawConnectors.notion &&
        typeof rawConnectors.notion === "object" &&
        !Array.isArray(rawConnectors.notion)
          ? (rawConnectors.notion as Record<string, unknown>)
          : {};
      const notionEnabled = coerceBool(rawNotion.enabled) === true;
      const notionToken =
        typeof rawNotion.token === "string" ? rawNotion.token : "";
      const notionPollCoerced = coerceNumber(rawNotion.pollIntervalMs);
      let notionPollIntervalMs = 300_000;
      if (notionPollCoerced !== undefined) {
        if (
          !Number.isFinite(notionPollCoerced) ||
          !Number.isInteger(notionPollCoerced) ||
          notionPollCoerced < 1_000 ||
          notionPollCoerced > 86_400_000
        ) {
          throw new Error(
            `connectors.notion.pollIntervalMs must be an integer in [1000, 86400000] ms (got ${JSON.stringify(rawNotion.pollIntervalMs)})`,
          );
        }
        notionPollIntervalMs = notionPollCoerced;
      }
      let notionDatabaseIds: string[] = [];
      if (rawNotion.databaseIds !== undefined) {
        if (!Array.isArray(rawNotion.databaseIds)) {
          throw new Error(
            `connectors.notion.databaseIds must be an array of strings (got ${typeof rawNotion.databaseIds})`,
          );
        }
        const seen = new Set<string>();
        for (const value of rawNotion.databaseIds) {
          if (typeof value !== "string") {
            throw new Error(
              `connectors.notion.databaseIds entries must be strings; found ${typeof value}`,
            );
          }
          const trimmed = value.trim();
          if (trimmed.length === 0) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          notionDatabaseIds.push(trimmed);
        }
      }
      // gmail (#683 PR 4/6)
      if (
        rawConnectors.gmail !== undefined &&
        (rawConnectors.gmail === null ||
          typeof rawConnectors.gmail !== "object" ||
          Array.isArray(rawConnectors.gmail))
      ) {
        throw new Error(
          `connectors.gmail must be an object (got ${JSON.stringify(rawConnectors.gmail)}).`,
        );
      }
      const rawGmail =
        rawConnectors.gmail &&
        typeof rawConnectors.gmail === "object" &&
        !Array.isArray(rawConnectors.gmail)
          ? (rawConnectors.gmail as Record<string, unknown>)
          : {};
      const gmailEnabled = coerceBool(rawGmail.enabled) === true;
      const gmailClientId =
        typeof rawGmail.clientId === "string" ? rawGmail.clientId : "";
      const gmailClientSecret =
        typeof rawGmail[CLIENT_SECRET_FIELD] === "string"
          ? rawGmail[CLIENT_SECRET_FIELD]
          : "";
      const gmailRefreshToken =
        typeof rawGmail[REFRESH_TOKEN_FIELD] === "string"
          ? rawGmail[REFRESH_TOKEN_FIELD]
          : "";
      const gmailUserId =
        typeof rawGmail.userId === "string" && rawGmail.userId.trim().length > 0
          ? rawGmail.userId.trim()
          : "me";
      const gmailQuery =
        typeof rawGmail.query === "string" ? rawGmail.query : "in:inbox";
      const gmailPollCoerced = coerceNumber(rawGmail.pollIntervalMs);
      let gmailPollIntervalMs = 300_000;
      if (rawGmail.pollIntervalMs !== undefined) {
        // CLAUDE.md gotcha #51: reject invalid values explicitly rather than
        // silently coercing to a default. Non-numeric strings, NaN, and
        // ±Infinity all cause coerceNumber to return undefined — treat that as
        // a configuration error rather than a quiet fallback.
        if (gmailPollCoerced === undefined) {
          throw new Error(
            `connectors.gmail.pollIntervalMs must be a finite number; got ${JSON.stringify(rawGmail.pollIntervalMs)}`,
          );
        }
        if (gmailPollCoerced <= 0) {
          throw new Error(
            `connectors.gmail.pollIntervalMs must be positive; got ${JSON.stringify(rawGmail.pollIntervalMs)}`,
          );
        }
        if (
          !Number.isInteger(gmailPollCoerced) ||
          gmailPollCoerced < 1_000 ||
          gmailPollCoerced > 86_400_000
        ) {
          throw new Error(
            `connectors.gmail.pollIntervalMs must be an integer in [1000, 86400000] ms (got ${JSON.stringify(rawGmail.pollIntervalMs)})`,
          );
        }
        gmailPollIntervalMs = gmailPollCoerced;
      }

      // github (#683 PR 5/6)
      if (
        rawConnectors.github !== undefined &&
        (rawConnectors.github === null ||
          typeof rawConnectors.github !== "object" ||
          Array.isArray(rawConnectors.github))
      ) {
        throw new Error(
          `connectors.github must be an object (got ${JSON.stringify(rawConnectors.github)}).`,
        );
      }
      const rawGitHub =
        rawConnectors.github &&
        typeof rawConnectors.github === "object" &&
        !Array.isArray(rawConnectors.github)
          ? (rawConnectors.github as Record<string, unknown>)
          : {};
      const githubEnabled = coerceBool(rawGitHub.enabled) === true;
      const githubToken =
        typeof rawGitHub.token === "string" ? rawGitHub.token : "";
      const githubUserLogin =
        typeof rawGitHub.userLogin === "string" ? rawGitHub.userLogin : "";
      const githubPollCoerced = coerceNumber(rawGitHub.pollIntervalMs);
      let githubPollIntervalMs = 300_000;
      if (githubPollCoerced !== undefined) {
        if (
          !Number.isFinite(githubPollCoerced) ||
          !Number.isInteger(githubPollCoerced) ||
          githubPollCoerced < 1_000 ||
          githubPollCoerced > 86_400_000
        ) {
          throw new Error(
            `connectors.github.pollIntervalMs must be an integer in [1000, 86400000] ms (got ${JSON.stringify(rawGitHub.pollIntervalMs)})`,
          );
        }
        githubPollIntervalMs = githubPollCoerced;
      }
      let githubRepos: string[] = [];
      if (rawGitHub.repos !== undefined) {
        if (!Array.isArray(rawGitHub.repos)) {
          throw new Error(
            `connectors.github.repos must be an array of strings (got ${typeof rawGitHub.repos})`,
          );
        }
        const seen = new Set<string>();
        for (const value of rawGitHub.repos) {
          if (typeof value !== "string") {
            throw new Error(
              `connectors.github.repos entries must be strings; found ${typeof value}`,
            );
          }
          const trimmed = value.trim();
          if (trimmed.length === 0) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          githubRepos.push(trimmed);
        }
      }
      const githubIncludeDiscussions = coerceBool(rawGitHub.includeDiscussions) === true;
      return {
        googleDrive: {
          enabled: driveEnabled,
          clientId: driveClientId,
          [CLIENT_SECRET_FIELD]: driveClientSecret,
          [REFRESH_TOKEN_FIELD]: driveRefreshToken,
          pollIntervalMs: drivePollIntervalMs,
          folderIds: driveFolderIds,
        },
        notion: {
          enabled: notionEnabled,
          token: notionToken,
          databaseIds: notionDatabaseIds,
          pollIntervalMs: notionPollIntervalMs,
        },
        gmail: {
          enabled: gmailEnabled,
          clientId: gmailClientId,
          [CLIENT_SECRET_FIELD]: gmailClientSecret,
          [REFRESH_TOKEN_FIELD]: gmailRefreshToken,
          userId: gmailUserId,
          query: gmailQuery,
          pollIntervalMs: gmailPollIntervalMs,
        },
        github: {
          enabled: githubEnabled,
          token: githubToken,
          userLogin: githubUserLogin,
          repos: githubRepos,
          pollIntervalMs: githubPollIntervalMs,
          includeDiscussions: githubIncludeDiscussions,
        },
      };
    })(),

    // MECE Taxonomy (#366)
    // Coerce string booleans from CLI (e.g. --config taxonomyEnabled=true) — gotcha #36
    taxonomyEnabled: coerceBool(cfg.taxonomyEnabled) ?? false,
    taxonomyAutoGenResolver: coerceBool(cfg.taxonomyAutoGenResolver) ?? true,

    // Codex CLI — native memory materialization (#378)
    codexMaterializeMemories: coerceBool(cfg.codexMaterializeMemories) ?? true,
    codexMaterializeNamespace:
      typeof cfg.codexMaterializeNamespace === "string" && cfg.codexMaterializeNamespace.trim().length > 0
        ? cfg.codexMaterializeNamespace.trim()
        : "auto",
    codexMaterializeMaxSummaryTokens: parseIntegerAtLeast(
      cfg.codexMaterializeMaxSummaryTokens,
      4500,
      0,
      "codexMaterializeMaxSummaryTokens",
    ),
    codexMaterializeRolloutRetentionDays: parseIntegerAtLeast(
      cfg.codexMaterializeRolloutRetentionDays,
      30,
      0,
      "codexMaterializeRolloutRetentionDays",
    ),
    codexMaterializeOnConsolidation: coerceBool(cfg.codexMaterializeOnConsolidation) ?? true,
    codexMaterializeOnSessionEnd: coerceBool(cfg.codexMaterializeOnSessionEnd) ?? true,
    // Codex CLI — marketplace integration (#418)
    codexMarketplaceEnabled: cfg.codexMarketplaceEnabled !== false, // default: true

    // Page-level versioning (issue #371). Issue #678 PR 2/4:
    // dreams.phases.deepSleep.* WINS over legacy keys.
    versioningEnabled: dreamsDeepSleep.enabled && dreamsDeepSleep.versioningEnabled,
    versioningMaxPerPage: dreamsDeepSleep.versioningMaxPerPage,
    versioningSidecarDir:
      typeof cfg.versioningSidecarDir === "string" && cfg.versioningSidecarDir.trim().length > 0
        ? cfg.versioningSidecarDir.trim()
        : ".versions",

    // Binary file lifecycle management (#367)
    binaryLifecycleEnabled: cfg.binaryLifecycleEnabled === true,
    binaryLifecycleGracePeriodDays:
      typeof cfg.binaryLifecycleGracePeriodDays === "number"
        ? Math.max(0, Math.floor(cfg.binaryLifecycleGracePeriodDays))
        : 7,
    binaryLifecycleBackendType: (() => {
      const valid = ["filesystem", "s3", "none"] as const;
      const raw = cfg.binaryLifecycleBackendType;
      if (typeof raw === "string" && (valid as readonly string[]).includes(raw)) {
        return raw as "filesystem" | "s3" | "none";
      }
      return "none" as const;
    })(),
    binaryLifecycleBackendPath:
      typeof cfg.binaryLifecycleBackendPath === "string"
        ? cfg.binaryLifecycleBackendPath.trim()
        : "",

    // Legacy MCP tool aliases opt-out (issue #1427). Config field wins; then
    // the REMNIC_/ENGRAM_ env var (gotcha #9); default true for back-compat.
    // Malformed values fail fast rather than silently defaulting (gotcha #51).
    emitLegacyTools: resolveEmitLegacyTools(cfg.emitLegacyTools, rawOperatorConfig, runtimeSet),
    // Codex citation parity (issue #379)
    citationsEnabled: cfg.citationsEnabled === true,
    citationsAutoDetect: cfg.citationsAutoDetect !== false,

    // External enrichment pipeline (issue #365)
    enrichmentEnabled: cfg.enrichmentEnabled === true,
    enrichmentAutoOnCreate: cfg.enrichmentAutoOnCreate === true,
    enrichmentMaxCandidatesPerEntity:
      typeof cfg.enrichmentMaxCandidatesPerEntity === "number"
        ? Math.max(0, Math.floor(cfg.enrichmentMaxCandidatesPerEntity))
        : 20,

    // Memory extensions discovery (#382)
    memoryExtensionsEnabled: cfg.memoryExtensionsEnabled !== false,
    memoryExtensionsRoot:
      typeof cfg.memoryExtensionsRoot === "string" && cfg.memoryExtensionsRoot.trim().length > 0
        ? expandTildePath(cfg.memoryExtensionsRoot.trim())
        : "",

    // Offline sync excludes (#1786) — validated below (parseOfflineSyncExcludes
    // throws on non-array / non-string / empty entries and on invalid globs).
    offlineSyncExcludes: parseOfflineSyncExcludes(cfg.offlineSyncExcludes),
  };
}

function parseBriefingConfig(raw: unknown): import("./types.js").BriefingConfig {
  const entry =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const defaultFormat =
    entry.defaultFormat === "json" || entry.defaultFormat === "markdown"
      ? (entry.defaultFormat as "markdown" | "json")
      : "markdown";
  const maxFollowupsRaw =
    typeof entry.maxFollowups === "number" && Number.isFinite(entry.maxFollowups)
      ? Math.floor(entry.maxFollowups)
      : 5;
  const maxFollowups = Math.max(0, Math.min(10, maxFollowupsRaw));
  return {
    enabled: entry.enabled !== false,
    defaultWindow:
      typeof entry.defaultWindow === "string" && entry.defaultWindow.trim().length > 0
        ? entry.defaultWindow.trim()
        : "yesterday",
    defaultFormat,
    maxFollowups,
    calendarSource:
      typeof entry.calendarSource === "string" && entry.calendarSource.trim().length > 0
        ? entry.calendarSource.trim()
        : null,
    saveByDefault: entry.saveByDefault === true,
    saveDir:
      typeof entry.saveDir === "string" && entry.saveDir.trim().length > 0
        ? entry.saveDir.trim()
        : null,
    llmFollowups: entry.llmFollowups !== false,
  };
}

function clampNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function parseRecallProfileMaxRatio(value: unknown): number {
  if (value === undefined) return 0.3;
  const ratio = coerceNumber(value);
  if (ratio === undefined || ratio < 0 || ratio > 1) {
    throw new Error(
      `recallProfileMaxRatio must be a finite number in [0, 1]; got ${JSON.stringify(value)}`,
    );
  }
  return ratio;
}

/**
 * Cursor L on PR #736: numeric config keys must accept BOTH numbers
 * and CLI-string forms (`--config peerProfileReasonerMinInteractions=10`
 * arrives as the string `"10"` per CLAUDE.md Gotcha #28). Pre-fix
 * `typeof === "number"` rejected strings and silently fell back to the
 * default — operators thought their override applied.
 *
 * Behavior:
 *   - `undefined` / `null` / missing → return `fallback`
 *   - finite number ≥ 0           → return floor(value)
 *   - string that parses to finite ≥ 0 → return floor(value)
 *   - anything else (NaN, ±Infinity, negative, non-numeric string,
 *     boolean, object) → throw an Error listing the offending key.
 *
 * Throwing matches Gotcha #51 — reject invalid input rather than
 * silently defaulting — and is consistent with how the surprise
 * knobs validate their inputs.
 */
function coerceNonNegativeInt(
  value: unknown,
  fallback: number,
  keyName?: string,
): number {
  if (value === undefined || value === null) return fallback;
  const coerced = coerceNumber(value);
  if (coerced === undefined || coerced < 0) {
    const label = keyName ? ` (${keyName})` : "";
    throw new Error(
      `config value${label} must be a non-negative finite number; got ${JSON.stringify(value)}`,
    );
  }
  return Math.floor(coerced);
}

// -----------------------------------------------------------------------------
// Issue #563 buffer-surprise knobs — shared clamp helpers
// -----------------------------------------------------------------------------
//
// Each helper takes a post-`coerceNumber` value (number | undefined) and a
// fallback. This keeps the coercion layer (coerce CLI strings → number) and
// the range layer (clamp to valid domain) cleanly separated — a common
// source of post-merge fixes when these were inlined (CLAUDE.md rule #28).

function clampSurpriseThreshold(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  // [0, 1] inclusive. 0 means "always flush on any score"; 1 means "never
  // flush on surprise alone" — both are valid-but-odd configurations.
  return Math.min(1, Math.max(0, value));
}

function clampSurpriseK(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function clampSurpriseRecentMemoryCount(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

function clampSurpriseProbeTimeoutMs(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  // A zero or negative timeout would either skip the probe entirely or
  // fire instantly — both surprising behaviors that hide config errors.
  // Clamp to a minimum of 1ms and round to integer.
  return Math.max(1, Math.floor(value));
}

function parseRecallSectionEntry(raw: unknown): RecallSectionConfig {
  const entry =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    id: typeof entry.id === "string" ? entry.id.trim() : "",
    enabled: entry.enabled !== false,
    maxChars:
      entry.maxChars === null
        ? null
        : clampNonNegativeNumber(entry.maxChars),
    maxHints: clampNonNegativeNumber(entry.maxHints),
    maxSupportingFacts: clampNonNegativeNumber(entry.maxSupportingFacts),
    maxRelatedEntities: clampNonNegativeNumber(entry.maxRelatedEntities),
    consolidateTriggerLines: clampNonNegativeNumber(entry.consolidateTriggerLines),
    consolidateTargetLines: clampNonNegativeNumber(entry.consolidateTargetLines),
    maxEntities: clampNonNegativeNumber(entry.maxEntities),
    maxResults: clampNonNegativeNumber(entry.maxResults),
    recentTurns: clampNonNegativeNumber(entry.recentTurns),
    maxTurns: clampNonNegativeNumber(entry.maxTurns),
    maxTokens: clampNonNegativeNumber(entry.maxTokens),
    lookbackHours: clampNonNegativeNumber(entry.lookbackHours),
    maxCount: clampNonNegativeNumber(entry.maxCount),
    topK: clampNonNegativeNumber(entry.topK),
    timeoutMs: clampNonNegativeNumber(entry.timeoutMs),
    maxPatterns: clampNonNegativeNumber(entry.maxPatterns),
    maxRubrics: clampNonNegativeNumber(entry.maxRubrics),
    ...(entry.forceGeneric === undefined
      ? {}
      : { forceGeneric: coerceBool(entry.forceGeneric) === true }),
  };
}

function buildDefaultRecallPipeline(cfg: Record<string, unknown>): RecallSectionConfig[] {
  return [
    {
      id: "shared-context",
      enabled: cfg.sharedContextEnabled === true,
      maxChars:
        typeof cfg.sharedContextMaxInjectChars === "number"
          ? Math.max(0, Math.floor(cfg.sharedContextMaxInjectChars))
          : 4000,
    },
    {
      id: "explicit-cue",
      enabled: coerceBool(cfg.explicitCueRecallEnabled) === true,
      maxChars:
        coerceNumber(cfg.explicitCueRecallMaxChars) !== undefined
          ? Math.max(0, Math.floor(coerceNumber(cfg.explicitCueRecallMaxChars)!))
          : 2400,
      maxResults:
        coerceNumber(cfg.explicitCueRecallMaxReferences) !== undefined
          ? Math.max(0, Math.floor(coerceNumber(cfg.explicitCueRecallMaxReferences)!))
          : 24,
    },
    {
      id: "targeted-facts",
      enabled: coerceBool(cfg.targetedFactRecallEnabled) === true,
      maxChars: parseIntegerAtLeast(cfg.targetedFactRecallMaxChars, 2400, 0, "targetedFactRecallMaxChars"),
      maxResults: parseIntegerAtLeast(cfg.targetedFactRecallMaxResults, 48, 0, "targetedFactRecallMaxResults"),
      maxTurns: parseIntegerAtLeast(cfg.targetedFactRecallScanWindowTurns, 8, 1, "targetedFactRecallScanWindowTurns"),
      maxTokens: parseIntegerAtLeast(cfg.targetedFactRecallScanWindowTokens, 12_000, 1, "targetedFactRecallScanWindowTokens"),
    },
    {
      id: "focused-list",
      enabled: coerceBool(cfg.focusedListRecallEnabled) === true,
      maxChars: parseIntegerAtLeast(cfg.focusedListRecallMaxChars, 2600, 0, "focusedListRecallMaxChars"),
      maxResults: parseIntegerAtLeast(cfg.focusedListRecallMaxResults, 40, 0, "focusedListRecallMaxResults"),
      maxTurns: parseIntegerAtLeast(cfg.focusedListRecallScanWindowTurns, 64, 1, "focusedListRecallScanWindowTurns"),
      maxTokens: parseIntegerAtLeast(cfg.focusedListRecallScanWindowTokens, 14_000, 1, "focusedListRecallScanWindowTokens"),
    },
    {
      id: "response-guidance",
      enabled: coerceBool(cfg.responseGuidanceRecallEnabled) === true,
      maxChars: parseIntegerAtLeast(cfg.responseGuidanceRecallMaxChars, 2400, 0, "responseGuidanceRecallMaxChars"),
      maxResults: parseIntegerAtLeast(cfg.responseGuidanceRecallMaxResults, 48, 0, "responseGuidanceRecallMaxResults"),
      maxTurns: parseIntegerAtLeast(cfg.responseGuidanceRecallScanWindowTurns, 64, 1, "responseGuidanceRecallScanWindowTurns"),
      maxTokens: parseIntegerAtLeast(cfg.responseGuidanceRecallScanWindowTokens, 16_000, 1, "responseGuidanceRecallScanWindowTokens"),
    },
    {
      id: "event-order",
      enabled: coerceBool(cfg.eventOrderRecallEnabled) === true,
      maxChars: parseIntegerAtLeast(cfg.eventOrderRecallMaxChars, 2400, 0, "eventOrderRecallMaxChars"),
      maxResults: parseIntegerAtLeast(cfg.eventOrderRecallMaxResults, 24, 0, "eventOrderRecallMaxResults"),
      maxTurns: parseIntegerAtLeast(cfg.eventOrderRecallScanWindowTurns, 12, 1, "eventOrderRecallScanWindowTurns"),
      maxTokens: parseIntegerAtLeast(cfg.eventOrderRecallScanWindowTokens, 24_000, 1, "eventOrderRecallScanWindowTokens"),
    },
    {
      id: "profile",
      enabled: true,
      consolidateTriggerLines: 100,
      consolidateTargetLines: 50,
    },
    {
      id: "identity-continuity",
      enabled: cfg.identityContinuityEnabled === true,
    },
    {
      id: "entity-retrieval",
      enabled: cfg.entityRetrievalEnabled !== false,
      maxChars:
        typeof cfg.entityRetrievalMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxChars))
          : 2400,
      maxHints:
        typeof cfg.entityRetrievalMaxHints === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxHints))
          : 2,
      maxSupportingFacts:
        typeof cfg.entityRetrievalMaxSupportingFacts === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxSupportingFacts))
          : 6,
      maxRelatedEntities:
        typeof cfg.entityRetrievalMaxRelatedEntities === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxRelatedEntities))
          : 3,
      recentTurns:
        typeof cfg.entityRetrievalRecentTurns === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalRecentTurns))
          : 6,
    },
    {
      id: "knowledge-index",
      enabled: cfg.knowledgeIndexEnabled !== false,
      maxChars:
        typeof cfg.knowledgeIndexMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.knowledgeIndexMaxChars))
          : 4000,
      maxEntities:
        typeof cfg.knowledgeIndexMaxEntities === "number"
          ? Math.max(0, Math.floor(cfg.knowledgeIndexMaxEntities))
          : 40,
    },
    { id: "verbatim-artifacts", enabled: cfg.verbatimArtifactsEnabled === true },
    {
      id: "procedure-recall",
      // Default-on since issue #567 PR 4/5: the master `procedural.enabled`
      // gate now defaults to `true` when the key is omitted, so the recall
      // pipeline must stay in sync. Explicit `false` (or any coerceBool
      // falsy variant) still disables recall injection.
      //
      // CLAUDE.md rule 48 (least-privileged defaults) + Cursor review on #609:
      // never fail open on unrecognized values. Only `coerced === true` or
      // the "key omitted" path enables the section. `parseConfig` throws
      // on invalid values upstream, so this branch only ever sees boolean
      // results — `coerced === undefined` should never happen in practice,
      // but defense-in-depth keeps the section disabled if it ever does.
      enabled: (() => {
        const proceduralRaw =
          typeof cfg.procedural === "object" &&
          cfg.procedural !== null &&
          !Array.isArray(cfg.procedural)
            ? (cfg.procedural as { enabled?: unknown })
            : undefined;
        if (proceduralRaw === undefined) return true;
        const rawEnabled = proceduralRaw.enabled;
        if (rawEnabled === undefined) return true;
        return coerceBool(rawEnabled) === true;
      })(),
      maxChars: 2400,
    },
    { id: "memory-boxes", enabled: cfg.memoryBoxesEnabled === true },
    { id: "temporal-memory-tree", enabled: cfg.temporalMemoryTreeEnabled === true },
    { id: "lcm-compressed-history", enabled: cfg.lcmEnabled === true },
    {
      id: "objective-state",
      enabled: cfg.objectiveStateRecallEnabled === true,
      maxResults: 4,
      maxChars: 1800,
    },
    {
      id: "causal-trajectories",
      enabled: cfg.causalTrajectoryRecallEnabled === true,
      maxResults: 3,
      maxChars: 2200,
    },
    {
      id: "trust-zones",
      enabled: cfg.trustZoneRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "harmonic-retrieval",
      enabled: cfg.harmonicRetrievalEnabled === true,
      maxResults: 3,
      maxChars: 2200,
    },
    {
      id: "verified-episodes",
      enabled: cfg.verifiedRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "verified-rules",
      enabled: cfg.semanticRuleVerificationEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "work-products",
      enabled: cfg.workProductRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "memories",
      enabled: true,
      maxResults:
        typeof cfg.qmdMaxResults === "number"
          ? Math.max(0, Math.floor(cfg.qmdMaxResults))
          : 8,
    },
    {
      id: "episodic-context",
      enabled: cfg.episodicContextEnabled === true,
      maxResults: 2,
      maxTurns: 8,
      maxChars: 2400,
    },
    {
      id: "compression-guidelines",
      enabled: cfg.compressionGuidelineLearningEnabled === true,
    },
    {
      id: "native-knowledge",
      enabled: cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object"
        ? (cfg.nativeKnowledge as Record<string, unknown>).enabled === true
        : false,
      maxResults:
        cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" &&
          typeof (cfg.nativeKnowledge as Record<string, unknown>).maxResults === "number"
          ? Math.max(0, Math.floor((cfg.nativeKnowledge as Record<string, unknown>).maxResults as number))
          : 4,
      maxChars:
        cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" &&
          typeof (cfg.nativeKnowledge as Record<string, unknown>).maxChars === "number"
          ? Math.max(0, Math.floor((cfg.nativeKnowledge as Record<string, unknown>).maxChars as number))
          : 2400,
    },
    {
      id: "transcript",
      enabled: cfg.transcriptEnabled !== false,
      maxTurns:
        typeof cfg.maxTranscriptTurns === "number"
          ? Math.max(0, Math.floor(cfg.maxTranscriptTurns))
          : 50,
      maxTokens:
        typeof cfg.maxTranscriptTokens === "number"
          ? Math.max(0, Math.floor(cfg.maxTranscriptTokens))
          : 1000,
      lookbackHours:
        typeof cfg.transcriptRecallHours === "number"
          ? Math.max(0, Math.floor(cfg.transcriptRecallHours))
          : 12,
    },
    {
      id: "summaries",
      enabled: cfg.hourlySummariesEnabled !== false,
      maxCount:
        typeof cfg.maxSummaryCount === "number"
          ? Math.max(0, Math.floor(cfg.maxSummaryCount))
          : 6,
      lookbackHours:
        typeof cfg.summaryRecallHours === "number"
          ? Math.max(0, Math.floor(cfg.summaryRecallHours))
          : 24,
    },
    {
      id: "conversation-recall",
      enabled: cfg.conversationIndexEnabled === true,
      topK:
        typeof cfg.conversationRecallTopK === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallTopK))
          : 3,
      maxChars:
        typeof cfg.conversationRecallMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallMaxChars))
          : 2500,
      timeoutMs:
        typeof cfg.conversationRecallTimeoutMs === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallTimeoutMs))
          : 800,
    },
    {
      id: "compounding",
      enabled: cfg.compoundingEnabled === true && cfg.compoundingInjectEnabled !== false,
      maxPatterns: 40,
      maxRubrics: 4,
    },
    { id: "questions", enabled: cfg.injectQuestions === true },
  ];
}

function buildRecallPipelineConfig(cfg: Record<string, unknown>): RecallPipelineConfig {
  const maxMemoryTokens =
    typeof cfg.maxMemoryTokens === "number"
      ? Math.max(0, Math.floor(cfg.maxMemoryTokens))
      : 2000;
  const recallBudgetCharsRaw = clampNonNegativeNumber(cfg.recallBudgetChars);
  // Keep four characters per token as Latin-script headroom. Assemblers enforce
  // maxMemoryTokens with the shared script-aware estimator.
  const recallBudgetChars = recallBudgetCharsRaw ?? maxMemoryTokens * 4;

  const rawPipeline = cfg.recallPipeline;
  const pipeline = Array.isArray(rawPipeline)
    ? rawPipeline.map(parseRecallSectionEntry).filter((entry) => entry.id.length > 0)
    : buildDefaultRecallPipeline(cfg);

  return { recallBudgetChars, pipeline };
}

/**
 * Parse the `trustScoreWeights` config value into a {@link TrustWeights}
 * object. Accepts a plain object of per-component numbers; non-finite or
 * out-of-`[0,1]` entries are dropped (the scorer falls back to defaults via
 * `resolveTrustWeights`). A non-object value yields `{}` → all defaults.
 * Rule 51: invalid weight rejected, never silently clamped to an extreme.
 */
function parseTrustScoreWeights(value: unknown): TrustWeights {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  const out: TrustWeights = {};
  const keys: Array<keyof TrustWeights> = [
    "memoryWorth",
    "provenance",
    "faithfulness",
    "corroboration",
    "contradiction",
    "domainCalibration",
    "feedback",
    "recency",
  ];
  for (const key of keys) {
    const raw = src[key as string];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) continue;
    (out as Record<string, number>)[key as string] = raw;
  }
  return out;
}
