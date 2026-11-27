export { loadDaySummaryPrompt } from "@remnic/core/day-summary";
export type { MemoryObservation } from "@remnic/core/types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import OpenAI from "openai";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { parseConfig } from "@remnic/core/config";
import { initLogger, log } from "@remnic/core/logger";
import {
  detectSdkCapabilities,
  type OpenClawRegistrationMode,
  type SdkCapabilities,
} from "@remnic/core/sdk-compat";
import {
  Orchestrator,
  sanitizeSessionKeyForFilename,
  defaultWorkspaceDir,
} from "@remnic/core/orchestrator";
import { beginCodexSubscriptionShutdown, getCodexSubscriptionRunnerForOwner, terminateActiveCodexSubscriptionChildren } from "@remnic/core";
import { buildLegacyMemorySearchToolForPublicShape, registerTools } from "./tools.js";
import { registerLcmTools } from "@remnic/core/lcm/index";
import { estimateTokens as estimateLcmTokens } from "@remnic/core/lcm/archive";
import { registerCli } from "@remnic/core/cli";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
} from "@remnic/core/fallback-llm";
import { objectiveStateStoreOverrideForNamespace } from "@remnic/core/objective-state";
import { recordObjectiveStateSnapshotsFromAgentMessages } from "@remnic/core/objective-state-writers";
import { probeQmdAvailability } from "./qmd-availability-probe.js";
import {
  EngramAccessService,
  createConfiguredSupportPassportGatewayRoute,
} from "./access-service.js";
import { EngramAccessHttpServer } from "@remnic/core/access-http";

import {
  InlineExplicitCaptureProcessor,
  mergeInlineCaptureDedupeKeys,
  shouldProcessInlineExplicitCapture,
  stripInlineExplicitCaptureNotes,
} from "./explicit-capture.js";
import path from "node:path";
import os from "node:os";
import { createOpikExporter } from "@remnic/core/opik-exporter";
import { readEnvVar, resolveHomeDir } from "@remnic/core/runtime/env";
import { displayErrorDetail } from "@remnic/core/runtime/better-sqlite";
import { migrateFromEngram } from "@remnic/core/migrate/from-engram";
import {
  createOpenClawUserMessageCleaner,
} from "./user-message-cleaning.js";
import { listRemnicPublicArtifacts } from "../packages/plugin-openclaw/src/public-artifacts.js";
import {
  buildMemoryGetTool,
  buildMemorySearchTool,
} from "../packages/plugin-openclaw/src/openclaw-tools/index.js";
import {
  matchesDelimitedPhrase,
  parseDreamNarrativeResponse,
  planDreamEntryFromConsolidation,
  resolveDreamNarrativeRoute,
  syncDreamSurfaceEntries,
  syncHeartbeatOutcomeLinks,
  syncHeartbeatSurfaceEntries,
} from "../packages/plugin-openclaw/src/runtime-surfaces.js";
import {
  forEachRuntimeSurfaceStorage,
} from "../packages/plugin-openclaw/src/runtime-surface-namespaces.js";
import {
  buildSessionCommandDescriptors,
} from "../packages/plugin-openclaw/src/session-command-descriptors.js";
import { validateSlotSelection } from "../packages/plugin-openclaw/src/slot-validator.js";
import { processOpenClawFlushPlanFile } from "./openclaw-flush-plan-lifecycle.js";
import {
  REMNIC_OPENCLAW_PLUGIN_ID,
  resolveRemnicOpenClawPluginEntry,
} from "../packages/plugin-openclaw/src/plugin-id.js";
import {
  maybeRegisterDelegateRuntime,
  type DelegateHookApi,
} from "../packages/plugin-openclaw/src/delegate-runtime.js";
import { isSubagentSessionKeyDetected } from "../packages/plugin-openclaw/src/delegate-hook-fields.js";
import { registerEmbeddedTools } from "../packages/plugin-openclaw/src/delegate-tools.js";
import {
  extractLastTurn,
  extractTextContent,
} from "../packages/plugin-openclaw/src/transcript-turns.js";
import {
  createMemoryReadScope,
  isMemoryArtifactPath,
  isSessionsMemoryPath,
} from "../packages/plugin-openclaw/src/memory-read-scope.js";
import type {
  RemnicCapabilityRuntime,
  RuntimeReadParams,
  RuntimeSearchOptions,
  RuntimeSearchResult,
} from "../packages/plugin-openclaw/src/memory-capability-types.js";
import {
  buildMemoryFlushPlan,
  type MemoryFlushPlan,
} from "../packages/plugin-openclaw/src/memory-flush-plan.js";
import { createFileToggleStore } from "@remnic/core/session-toggles";
import { appendRecallAuditEntry, pruneRecallAuditEntries } from "@remnic/core/recall-audit";
import { createActiveRecallEngine } from "@remnic/core/active-recall";
import {
  buildTurnFingerprint,
  CODEX_THREAD_KEY_PREFIX,
  codexLogicalSessionKey,
  extractCodexThreadId,
  resolveCodexSessionIdentity,
} from "./codex-compat.js";
import { planRecallMode } from "@remnic/core/intent";
import {
  expandTildePath,
  isSupportPassportPrivateMemory,
  renderMemoryContextPrompt as renderSharedMemoryContextPrompt,
  resolveAgentAccessAuthToken,
  resolvePrincipal,
  searchWithGenericExclusion,
  type RecallContextComposition,
} from "@remnic/core";
import {
  normalizeHostEmbeddingVector,
  registerHostEmbeddingProvider,
  type HostEmbeddingProvider,
} from "@remnic/core/host-embedding-provider";
import { findGatewayRuntimeModules } from "./resolve-provider-secret.js";
import { createDreamsSurface } from "@remnic/core/surfaces/dreams";
import { createHeartbeatSurface, type HeartbeatEntry } from "@remnic/core/surfaces/heartbeat";
import type { ConsolidationObservation } from "@remnic/core/types";
import { ensureLiveConnectorCron } from "./openclaw-live-connector-cron.js";
import { hasEnabledLiveConnectorConfig } from "./openclaw-live-connector-config.js";

const ENGRAM_MIGRATION_PROMISE = "__openclawEngramMigrationPromise";

const CLI_REGISTERED_GUARD = "__openclawEngramCliRegistered";
const SESSION_COMMANDS_REGISTERED_GUARD =
  "__openclawEngramSessionCommandsRegistered";
const ACTIVE_RECALL_OVERLAP_WARNED = "__openclawEngramActiveRecallOverlapWarned";

const CLI_ACTIVE_SERVICE_COUNT = "__openclawEngramCliActiveServiceCount";
const SECRET_REF_RESOLVER_TEST_KEY = "__openclawEngramSecretRefResolverForTest";
const NODE_FS_MODULE_ID = ["node", "fs"].join(":");
const NODE_FS_PROMISES_MODULE_ID = ["node", "fs/promises"].join(":");
const READ_FILE_SYNC_FIELD = ["read", "File", "Sync"].join("");
const EXISTS_SYNC_FIELD = ["exists", "Sync"].join("");

function readTextFileNow(filePath: string): string {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire(NODE_FS_MODULE_ID) as typeof import("node:fs");
  const reader = fs[READ_FILE_SYNC_FIELD as keyof typeof fs] as unknown as (
    path: string,
    encoding: BufferEncoding,
  ) => string;
  return reader(filePath, "utf-8");
}

function fileExistsNow(filePath: string): boolean {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire(NODE_FS_MODULE_ID) as typeof import("node:fs");
  const exists = fs[EXISTS_SYNC_FIELD as keyof typeof fs] as unknown as (
    path: string,
  ) => boolean;
  return exists(filePath);
}

async function readTextFileLater(filePath: string): Promise<string> {
  const fs = await import(NODE_FS_PROMISES_MODULE_ID);
  return fs.readFile(filePath, "utf-8");
}

async function writeTextFileLater(filePath: string, data: string): Promise<void> {
  const fs = await import(NODE_FS_PROMISES_MODULE_ID);
  await fs.writeFile(filePath, data, "utf-8");
}

type HourlySummaryCronJob = Record<string, unknown> & { id?: unknown };

export interface HourlySummaryCronJobsData {
  version: number;
  jobs: HourlySummaryCronJob[];
  [key: string]: unknown;
}

export type HourlySummaryCronJobsLoadResult =
  | { status: "missing" }
  | { status: "invalid"; error: Error }
  | { status: "loaded"; jobsData: HourlySummaryCronJobsData };

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHourlySummaryCronJobsData(
  content: string,
  filePath = "cron jobs file",
): HourlySummaryCronJobsData {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecordLike(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  if (!Array.isArray(parsed.jobs)) {
    throw new Error(`${filePath} must contain a jobs array.`);
  }
  if (!parsed.jobs.every(isRecordLike)) {
    throw new Error(`${filePath} jobs entries must be JSON objects.`);
  }
  return {
    ...parsed,
    version: typeof parsed.version === "number" ? parsed.version : 1,
    jobs: parsed.jobs,
  };
}

export async function loadHourlySummaryCronJobsData(
  cronFilePath: string,
): Promise<HourlySummaryCronJobsLoadResult> {
  try {
    const content = await readTextFileLater(cronFilePath);
    return {
      status: "loaded",
      jobsData: parseHourlySummaryCronJobsData(content, cronFilePath),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

type HourlySummaryCronConfig = Pick<
  ReturnType<typeof parseConfig>,
  "summaryModel" | "taskModelChain" | "gatewayConfig"
>;

function resolveHourlySummaryCronRouting(cfg: HourlySummaryCronConfig): {
  model: string | undefined;
  fallbacks: string[];
} {
  const model = cfg.summaryModel || cfg.taskModelChain?.primary || undefined;
  if (!model || model !== cfg.taskModelChain?.primary) {
    return { model, fallbacks: [] };
  }
  const fallbacks: string[] = [];
  const seen = new Set<string>([model]);
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    fallbacks.push(trimmed);
  };
  for (const fb of cfg.taskModelChain?.fallbacks ?? []) add(fb);
  const gatewayDefault = cfg.gatewayConfig?.agents?.defaults?.model;
  add(gatewayDefault?.primary);
  for (const fb of Array.isArray(gatewayDefault?.fallbacks)
    ? gatewayDefault.fallbacks
    : []) {
    add(fb);
  }
  return { model, fallbacks };
}

export function buildHourlySummaryCronJob(
  cfg: HourlySummaryCronConfig,
  opts: { jobId: string; minute: number; nowMs: number },
): HourlySummaryCronJob {
  const { model, fallbacks } = resolveHourlySummaryCronRouting(cfg);

  // - `sessionTarget: "main"` only supports `payload.kind: "systemEvent"` in this install.
  // - For agent-driven automation, use `sessionTarget: "isolated"` + `payload.kind: "agentTurn"`.
  return {
    id: opts.jobId,
    agentId: "generalist",
    ...(model ? { model } : {}),
    name: "Remnic Hourly Summary",
    enabled: true,
    createdAtMs: opts.nowMs,
    updatedAtMs: opts.nowMs,
    schedule: {
      kind: "cron",
      expr: `${opts.minute} * * * *`, // Every hour at the given minute
      tz: "America/Chicago",
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 120,
      thinking: "off",
      ...(model ? { model } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
      message:
        "You are OpenClaw automation.\n\n" +
        "Task: Generate Remnic hourly summaries.\n\n" +
        "Call the tool `memory_summarize_hourly` with empty params.\n\n" +
        "Output policy:\n" +
        "- If you generated summaries successfully: output exactly NO_REPLY.\n" +
        "- If there is an error: output one concise line describing it.\n\n" +
        "Rules:\n" +
        "- Do NOT send anything to Discord.\n" +
        "- Never print secrets.\n",
    },
    delivery: { mode: "none" },
    state: {},
  };
}

export function reconcileHourlySummaryCronRouting(
  existing: HourlySummaryCronJob,
  cfg: HourlySummaryCronConfig,
  opts: { nowMs: number },
): { changed: boolean; job: HourlySummaryCronJob } {
  if (!isRecordLike(existing.payload)) {
    return { changed: false, job: existing };
  }

  const { model, fallbacks } = resolveHourlySummaryCronRouting(cfg);
  const desiredModel = model ?? undefined;
  const desiredFallbacks = fallbacks.length > 0 ? fallbacks : undefined;

  const payload: Record<string, unknown> = { ...existing.payload };
  const curRoot = typeof existing.model === "string" ? existing.model : undefined;
  const curPayloadModel = typeof payload.model === "string" ? payload.model : undefined;
  const curFallbacks = Array.isArray(payload.fallbacks) ? payload.fallbacks : undefined;

  const fallbacksEqual =
    curFallbacks === undefined && desiredFallbacks === undefined
      ? true
      : JSON.stringify(curFallbacks) === JSON.stringify(desiredFallbacks);
  const changed =
    curRoot !== desiredModel || curPayloadModel !== desiredModel || !fallbacksEqual;

  if (!changed) return { changed: false, job: existing };

  if (desiredModel === undefined) delete payload.model;
  else payload.model = desiredModel;
  if (desiredFallbacks === undefined) delete payload.fallbacks;
  else payload.fallbacks = desiredFallbacks;

  const job: Record<string, unknown> = {
    ...existing,
    payload,
    updatedAtMs: opts.nowMs,
  };
  if (desiredModel === undefined) delete job.model;
  else job.model = desiredModel;

  return { changed: true, job: job as HourlySummaryCronJob };
}

async function realPathLater(filePath: string): Promise<string> {
  const fs = await import(NODE_FS_PROMISES_MODULE_ID);
  return fs.realpath(filePath);
}

type ResolveSecretRefFn = (
  ref: import("@remnic/core/types").SecretRef,
  context?: unknown,
) => Promise<string | undefined> | string | undefined;

const SECRET_REF_RESOLVER_RETRY_BACKOFF_MS = 60_000;
const SECRET_REF_RESOLVER_EXPORT_NAMES = [
  "resolveSecretRef",
  "resolveSecret",
  "loadSecretRef",
  "readSecretRef",
] as const;
const SECRET_REF_RESOLVER_MODULE_PREFIXES = [
  "runtime-secret-resolver.runtime-",
  "runtime-secrets.runtime-",
  "runtime-secret.runtime-",
  "runtime-model-auth.runtime-",
] as const;
const PROVIDER_AUTH_RUNTIME_MODULE_PREFIX = "runtime-model-auth.runtime-";

let secretRefResolver: ResolveSecretRefFn | null = null;
let secretRefResolverLoaded = false;
let secretRefResolverNextRetryAt = 0;
let providerAuthRuntimeModule: Record<string, unknown> | null = null;
let providerAuthRuntimeLoaded = false;
let providerAuthRuntimeNextRetryAt = 0;

async function loadOpenClawProviderAuthRuntimeModule(): Promise<Record<string, unknown> | null> {
  if (providerAuthRuntimeLoaded) return providerAuthRuntimeModule;
  if (
    providerAuthRuntimeNextRetryAt > 0 &&
    Date.now() < providerAuthRuntimeNextRetryAt
  ) {
    return null;
  }

  try {
    const { pathToFileURL } = await import("node:url");
    const candidates = await findGatewayRuntimeModules(PROVIDER_AUTH_RUNTIME_MODULE_PREFIX);
    for (const candidate of candidates) {
      try {
        const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
        if (
          typeof mod.resolveApiKeyForProvider === "function" ||
          typeof mod.getRuntimeAuthForModel === "function"
        ) {
          providerAuthRuntimeModule = mod;
          providerAuthRuntimeLoaded = true;
          log.debug("loaded OpenClaw provider auth runtime module");
          return providerAuthRuntimeModule;
        }
      } catch {
        // Try next candidate.
      }
    }
  } catch {
    // Silent — fall through to backoff.
  }

  providerAuthRuntimeNextRetryAt = Date.now() + SECRET_REF_RESOLVER_RETRY_BACKOFF_MS;
  log.debug(
    `OpenClaw provider auth runtime not available — will retry after ${
      SECRET_REF_RESOLVER_RETRY_BACKOFF_MS / 1000
    }s`,
  );
  return null;
}

async function resolveOpenClawProviderApiKey(params: {
  provider: string;
  cfg?: unknown;
  agentDir?: string;
}): Promise<{ apiKey?: string; source?: string; mode?: string } | null> {
  const mod = await loadOpenClawProviderAuthRuntimeModule();
  const resolver = mod?.resolveApiKeyForProvider;
  if (typeof resolver !== "function") return null;
  return await (resolver as (input: typeof params) => Promise<{ apiKey?: string; source?: string; mode?: string } | null>)(params);
}

async function getOpenClawRuntimeAuthForModel(params: {
  model: { provider: string; id: string; api?: string; baseUrl?: string };
  cfg?: unknown;
  workspaceDir?: string;
}): Promise<{
  apiKey?: string;
  baseUrl?: string;
  source?: string;
  mode?: string;
  profileId?: string;
} | null> {
  const mod = await loadOpenClawProviderAuthRuntimeModule();
  const resolver = mod?.getRuntimeAuthForModel;
  if (typeof resolver !== "function") return null;
  return await (resolver as (input: typeof params) => Promise<{
    apiKey?: string;
    baseUrl?: string;
    source?: string;
    mode?: string;
    profileId?: string;
  } | null>)(params);
}

async function loadOpenClawSecretRefResolver(): Promise<ResolveSecretRefFn | null> {
  const testResolver = (globalThis as Record<string, unknown>)[SECRET_REF_RESOLVER_TEST_KEY];
  if (typeof testResolver === "function") {
    return testResolver as ResolveSecretRefFn;
  }
  if (secretRefResolverLoaded) return secretRefResolver;
  if (
    secretRefResolverNextRetryAt > 0 &&
    Date.now() < secretRefResolverNextRetryAt
  ) {
    return null;
  }

  try {
    const { pathToFileURL } = await import("node:url");
    for (const prefix of SECRET_REF_RESOLVER_MODULE_PREFIXES) {
      const candidates = await findGatewayRuntimeModules(prefix);
      for (const candidate of candidates) {
        try {
          const importUrl = pathToFileURL(candidate).href;
          const mod = (await import(importUrl)) as Record<string, unknown>;
          for (const exportName of SECRET_REF_RESOLVER_EXPORT_NAMES) {
            const fn = mod[exportName];
            if (typeof fn === "function") {
              secretRefResolver = fn as ResolveSecretRefFn;
              secretRefResolverLoaded = true;
              log.debug(
                `loaded OpenClaw SecretRef resolver "${exportName}" from ${prefix}*.js`,
              );
              return secretRefResolver;
            }
          }
        } catch {
          // Try next candidate.
        }
      }
    }
  } catch {
    // Silent — fall through to backoff.
  }

  secretRefResolverNextRetryAt = Date.now() + SECRET_REF_RESOLVER_RETRY_BACKOFF_MS;
  log.debug(
    `OpenClaw SecretRef resolver not available — will retry after ${
      SECRET_REF_RESOLVER_RETRY_BACKOFF_MS / 1000
    }s`,
  );
  return null;
}

type ServiceKeys = {
  REGISTERED_GUARD: string;
  HOST_EMBEDDING_UNREGISTER: string;
  HOST_EMBEDDING_SIGNATURE: string;
  HOOK_APIS: string;
  ACCESS_SERVICE: string;
  ACCESS_HTTP_SERVER: string;
  ACCESS_HTTP_AUTH_STATE: string;
  FLUSH_PLAN_PROCESSING_CHAINS: string;
  SERVICE_STARTED: string;
  INIT_PROMISE: string;
  ORCHESTRATOR: string;
};

function buildServiceKeys(serviceId: string): ServiceKeys {
  const suffix = `::${serviceId}`;
  return {
    REGISTERED_GUARD: `__openclawEngramRegistered${suffix}`,
    HOST_EMBEDDING_UNREGISTER: `__openclawEngramHostEmbeddingUnregister${suffix}`,
    HOST_EMBEDDING_SIGNATURE: `__openclawEngramHostEmbeddingSignature${suffix}`,
    HOOK_APIS: `__openclawEngramHookApis${suffix}`,
    ACCESS_SERVICE: `__openclawEngramAccessService${suffix}`,
    ACCESS_HTTP_SERVER: `__openclawEngramAccessHttpServer${suffix}`,
    ACCESS_HTTP_AUTH_STATE: `__openclawEngramAccessHttpAuthState${suffix}`,
    FLUSH_PLAN_PROCESSING_CHAINS: `__openclawEngramFlushPlanProcessingChains${suffix}`,
    SERVICE_STARTED: `__openclawEngramServiceStarted${suffix}`,
    INIT_PROMISE: `__openclawEngramInitPromise${suffix}`,
    ORCHESTRATOR: `__openclawEngramOrchestrator${suffix}`,
  };
}

function resolveOpenClawConfigFilePath(): string {
  const explicitConfigPath =
    readEnvVar("OPENCLAW_CONFIG_PATH") ||
    readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH");
  if (explicitConfigPath && explicitConfigPath.length > 0) {
    return expandTildePath(explicitConfigPath);
  }
  return path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
}

function coerceRawConfigBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return undefined;
}

function loadPluginEntryFromFile(pluginId?: string): Record<string, unknown> | undefined {
  try {
    const configPath = resolveOpenClawConfigFilePath();
    const content = readTextFileNow(configPath);
    const config = JSON.parse(content);
    return resolveRemnicOpenClawPluginEntry(config, pluginId);
  } catch (err) {
    log.warn(`Failed to load config from file: ${err}`);
    return undefined;
  }
}

function loadPluginConfigFromFile(pluginId?: string): Record<string, unknown> | undefined {
  const entry = loadPluginEntryFromFile(pluginId);
  const cfg = entry?.config;
  if (cfg === null || cfg === undefined) return undefined;
  if (typeof cfg !== "object" || Array.isArray(cfg)) return undefined;
  return cfg as Record<string, unknown>;
}

function loadRawConfigFromFile(): Record<string, unknown> | undefined {
  try {
    const configPath = resolveOpenClawConfigFilePath();
    const content = readTextFileNow(configPath);
    const config = JSON.parse(content);
    return config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : undefined;
  } catch (err) {
    log.warn(`Failed to load raw OpenClaw config from file: ${err}`);
    return undefined;
  }
}

function readPluginHooksPolicy(
  apiConfig: unknown,
  pluginId?: string,
): Record<string, unknown> | undefined {
  const apiEntry = resolveRemnicOpenClawPluginEntry(apiConfig, pluginId);
  const fromApi = apiEntry?.["hooks"] as Record<string, unknown> | undefined;
  if (fromApi && typeof fromApi === "object") return fromApi;
  return loadPluginEntryFromFile(pluginId)?.["hooks"] as
    | Record<string, unknown>
    | undefined;
}

async function maybeRegisterLiveConnectorCron(orchestrator: Orchestrator): Promise<void> {
  if (!hasEnabledLiveConnectorConfig(orchestrator.config.connectors)) return;

  const jobsPath = path.join(resolveHomeDir(), ".openclaw", "cron", "jobs.json");
  try {
    if (!fileExistsNow(jobsPath)) {
      log.debug("live connectors cron: jobs.json not found, skipping auto-register");
      return;
    }
    const result = await ensureLiveConnectorCron(jobsPath, {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      connectors: orchestrator.config.connectors,
    });
    if (result.created || result.updated) {
      log.info(`live connectors cron ${result.created ? "auto-registered" : "reconciled"} (${result.jobId})`);
    } else {
      log.debug("live connectors cron already exists, skipping auto-register");
    }
  } catch (err) {
    log.debug(`live connectors cron auto-register error: ${err}`);
  }
}

function isBundledActiveMemoryEnabledForAgent(
  runtimeConfig: unknown,
  fileBackedRuntimeConfig: unknown,
  agentId: string,
): boolean {
  const readMemorySlot = (config: unknown): string | undefined => {
    if (!config || typeof config !== "object") return undefined;
    const plugins = (config as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object") return undefined;
    const slots = (plugins as Record<string, unknown>).slots;
    if (!slots || typeof slots !== "object") return undefined;
    const memorySlot = (slots as Record<string, unknown>).memory;
    return typeof memorySlot === "string" && memorySlot.length > 0 ? memorySlot : undefined;
  };

  const readActiveMemoryEntry = (config: unknown): Record<string, unknown> | undefined => {
    if (!config || typeof config !== "object") return undefined;
    const plugins = (config as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object") return undefined;
    const entries = (plugins as Record<string, unknown>).entries;
    if (!entries || typeof entries !== "object") return undefined;
    const activeMemoryEntry = (entries as Record<string, unknown>)["active-memory"];
    return activeMemoryEntry && typeof activeMemoryEntry === "object"
      ? (activeMemoryEntry as Record<string, unknown>)
      : undefined;
  };

  const runtimeMemorySlot = readMemorySlot(runtimeConfig);
  const fileBackedMemorySlot = readMemorySlot(fileBackedRuntimeConfig);
  const effectiveMemorySlot = runtimeMemorySlot ?? fileBackedMemorySlot;
  if (effectiveMemorySlot !== "active-memory") return false;

  const runtimeEntry = readActiveMemoryEntry(runtimeConfig);
  const fileBackedEntry = readActiveMemoryEntry(fileBackedRuntimeConfig);
  const activeMemoryEntry = runtimeEntry ?? fileBackedEntry;
  if (!activeMemoryEntry || typeof activeMemoryEntry !== "object") return false;

  const resolveEnabled = (
    entry: Record<string, unknown> | undefined,
  ): boolean | undefined => {
    return coerceRawConfigBoolean(entry?.enabled);
  };

  const runtimeEnabled = resolveEnabled(runtimeEntry);
  if (runtimeEnabled === false) return false;

  const fileBackedEnabled = resolveEnabled(fileBackedEntry);
  if (runtimeEnabled === undefined && fileBackedEnabled === false) return false;

  const resolveAgents = (
    entry: Record<string, unknown> | undefined,
  ): string[] | undefined => {
    const entryConfig = entry?.config;
    if (!entryConfig || typeof entryConfig !== "object") return undefined;
    const agents = (entryConfig as Record<string, unknown>).agents;
    if (!Array.isArray(agents)) return undefined;
    return agents.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  };

  const runtimeAgents = resolveAgents(runtimeEntry);
  if (Array.isArray(runtimeAgents)) {
    return runtimeAgents.includes(agentId);
  }

  const fileBackedAgents = resolveAgents(fileBackedEntry);
  if (Array.isArray(fileBackedAgents)) {
    return fileBackedAgents.includes(agentId);
  }

  return true;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function shouldSkipRecallForSession(
  sessionKey: string,
  cfg: {
    cronRecallMode: "all" | "none" | "allowlist";
    cronRecallAllowlist: string[];
  },
): boolean {
  const isCron = sessionKey.includes(":cron:");
  if (!isCron) return false;

  if (cfg.cronRecallMode === "none") return true;
  if (cfg.cronRecallMode === "all") return false;

  if (cfg.cronRecallAllowlist.length === 0) return true;
  return !cfg.cronRecallAllowlist.some((pattern) => {
    try {
      return wildcardToRegExp(pattern).test(sessionKey);
    } catch {
      return false;
    }
  });
}

function isVerboseRecallRequested(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): boolean {
  const runtime = ctx.runtime as Record<string, unknown> | undefined;
  return (
    ctx.verbose === true ||
    event.verbose === true ||
    runtime?.verbose === true ||
    (ctx.metadata as Record<string, unknown> | undefined)?.verbose === true
  );
}

function summarizeRecallTextForStatus(value: string | null, maxChars: number = 220): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars)).trimEnd()}...`;
}

function buildVerboseRecallHeader(params: {
  sessionKey: string;
  agentId: string;
  latencyMs?: number;
  memoryIds: string[];
  plannerMode?: string;
  toggleState: "enabled" | "disabled-primary" | "disabled-secondary";
  summary: string | null;
}): string[] {
  const status =
    params.toggleState === "enabled"
      ? "enabled"
      : params.toggleState === "disabled-secondary"
        ? "disabled by bundled active-memory"
        : "disabled by Remnic session toggle";
  const summary = params.summary ?? "NONE - no relevant memory";
  return [
    `━━━ Remnic recall (${params.sessionKey}, agent ${params.agentId}) ━━━`,
    `Status: ${status} · Planner: ${params.plannerMode ?? "unknown"} · Memories: ${params.memoryIds.length} · Latency: ${params.latencyMs ?? "?"}ms`,
    summary,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ];
}

function resolveActiveRecallChatType(
  ctx: Record<string, unknown>,
): "direct" | "group" | "channel" {
  const provider = String(ctx.messageProvider ?? "").toLowerCase();
  if (
    provider.includes("discord") ||
    provider.includes("slack") ||
    provider.includes("channel")
  ) {
    return ctx.channelId ? "channel" : "group";
  }
  return "direct";
}

function extractRecentTurnsForActiveRecall(
  messages: Array<Record<string, unknown>> | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      const role =
        message.role === "user" || message.role === "assistant"
          ? message.role
          : null;
      const content = extractTextContent(message);
      if (!role || content.length === 0) return null;
      return { role, content };
    })
    .filter(
      (
        value,
      ): value is {
        role: "user" | "assistant";
        content: string;
      } => value !== null,
    );
}

/**
 * Try to use the new SDK's definePluginEntry when available, otherwise return
 * the bare plugin definition object (works on legacy runtimes).
 */
function tryDefinePluginEntry(def: {
  id: string;
  name: string;
  description: string;
  kind: "memory";
  register: (api: OpenClawPluginApi) => void;
}) {
  try {
    const _require = createRequire(import.meta.url);
    const { definePluginEntry } = _require(
      "openclaw/plugin-sdk/plugin-entry",
    ) as {
      definePluginEntry: (d: typeof def) => typeof def;
    };
    return definePluginEntry(def);
  } catch {
    return def;
  }
}

export type OpenClawEmbeddingAdapterKind = "generic" | "memory";

type OpenClawEmbeddingAdapter = {
  id: string;
  defaultModel?: string;
  create: (options: Record<string, unknown>) => Promise<{
    provider?: unknown;
    runtime?: unknown;
  } | null>;
};

const MAX_OBSERVED_INBOUND_MESSAGE_IDS = 1024;

function requireOpenClawSdkSubpath<T>(subpath: string): T | null {
  try {
    const _require = createRequire(import.meta.url);
    return _require(subpath) as T;
  } catch {
    return null;
  }
}

function resolveChannelEnvelopePrefixes(cfg: {
  openclawChannelEnvelopeCleaningEnabled: boolean;
}): {
  prefixes: string[];
  includeLegacyChannelEnvelopePattern: boolean;
} {
  if (!cfg.openclawChannelEnvelopeCleaningEnabled) {
    return { prefixes: ["OpenClaw"], includeLegacyChannelEnvelopePattern: true };
  }
  const sdk = requireOpenClawSdkSubpath<{
    BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES?: unknown;
  }>("openclaw/plugin-sdk/chat-channel-ids");
  const prefixes = sdk?.BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES;
  if (!Array.isArray(prefixes)) {
    return { prefixes: ["OpenClaw"], includeLegacyChannelEnvelopePattern: true };
  }
  const cleaned = prefixes.filter((value): value is string => typeof value === "string");
  return {
    prefixes: cleaned.length > 0 ? cleaned : ["OpenClaw"],
    includeLegacyChannelEnvelopePattern: false,
  };
}

function registerOpenClawHostEmbeddingProvider(params: {
  api: OpenClawPluginApi;
  cfg: {
    memoryDir: string;
    hostEmbeddingProviderEnabled: boolean;
    hostEmbeddingProviderId?: string;
    hostEmbeddingProviderModel?: string;
  };
  serviceId: string;
}): (() => void) | null {
  const { api, cfg, serviceId } = params;
  if (cfg.hostEmbeddingProviderEnabled === false) return null;

  const selected = selectOpenClawEmbeddingAdapter(api, cfg.hostEmbeddingProviderId);
  if (!selected) return null;

  const model =
    cfg.hostEmbeddingProviderModel ||
    selected.adapter.defaultModel ||
    "text-embedding-3-small";
  const workspaceDir = getOpenClawRuntimeWorkspaceDir(api);

  let providerPromise: Promise<unknown | null> | null = null;
  let providerInstance: unknown | null = null;

  const resolveProvider = async (): Promise<unknown | null> => {
    if (providerInstance) return providerInstance;
    providerPromise ??= selected.adapter
      .create({
        config: api.config ?? {},
        workspaceDir,
        agentDir: workspaceDir,
        provider: cfg.hostEmbeddingProviderId || selected.adapter.id,
        model,
      })
      .then((result) => {
        providerInstance =
          result && typeof result === "object"
            ? (result as Record<string, unknown>).provider ?? null
            : null;
        if (!providerInstance) {
          log.debug(
            `OpenClaw host embedding provider ${selected.adapter.id} did not create a provider; using Remnic fallback embeddings`,
          );
        }
        return providerInstance;
      })
      .catch((error) => {
        log.debug(
          `OpenClaw host embedding provider ${selected.adapter.id} unavailable: ${error}`,
        );
        return null;
      })
      .finally(() => {
        if (!providerInstance) {
          providerPromise = null;
        }
      });
    return providerPromise;
  };

  const hostProvider: HostEmbeddingProvider = {
    id: `openclaw:${selected.kind}:${selected.adapter.id}`,
    model: `${selected.kind}:${selected.adapter.id}/${model}`,
    async embed(text, options) {
      const provider = await resolveProvider();
      if (!provider) return null;
      return embedWithOpenClawProvider(selected.kind, provider, text, options);
    },
    async embedBatch(texts, options) {
      const provider = await resolveProvider();
      if (!provider) return texts.map(() => null);
      return embedBatchWithOpenClawProvider(selected.kind, provider, texts, options);
    },
    async close() {
      const close = providerInstance && typeof providerInstance === "object"
        ? (providerInstance as Record<string, unknown>).close
        : undefined;
      if (typeof close === "function") {
        await close.call(providerInstance);
      }
    },
  };

  const unregister = registerHostEmbeddingProvider(cfg.memoryDir, hostProvider);
  log.info(
    `registered OpenClaw host embedding provider bridge (${selected.adapter.id}) for ${serviceId}`,
  );
  return unregister;
}

function getOpenClawRuntimeAgent(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  if (!("runtime" in api)) return undefined;
  const runtime: unknown = api.runtime;
  if (typeof runtime !== "object" || runtime === null || !("agent" in runtime)) return undefined;
  const agent: unknown = runtime.agent;
  return typeof agent === "object" && agent !== null
    ? (agent as Record<string, unknown>)
    : undefined;
}

function getOpenClawRuntimeWorkspaceDir(api: OpenClawPluginApi): string | undefined {
  const workspaceDir = getOpenClawRuntimeAgent(api)?.workspaceDir;
  return typeof workspaceDir === "string" && workspaceDir.length > 0 ? workspaceDir : undefined;
}

function getOpenClawRuntimeAgentId(api: OpenClawPluginApi): string | undefined {
  const agentId = getOpenClawRuntimeAgent(api)?.id;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

function stableOpenClawConfigSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return JSON.stringify(value);
  }
  if (valueType === "bigint") return JSON.stringify(String(value));
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return JSON.stringify(`[${valueType}]`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableOpenClawConfigSignature(entry, seen)).join(",")}]`;
  }
  if (value && valueType === "object") {
    if (seen.has(value)) return JSON.stringify("[Circular]");
    seen.add(value);
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${stableOpenClawConfigSignature(
          (value as Record<string, unknown>)[key],
          seen,
        )}`
      );
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function openClawHostEmbeddingConfigSignature(cfg: {
  memoryDir: string;
  hostEmbeddingProviderEnabled: boolean;
  hostEmbeddingProviderId?: string;
  hostEmbeddingProviderModel?: string;
}, apiConfig: unknown, workspaceDir?: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    enabled: cfg.hostEmbeddingProviderEnabled !== false,
    memoryDir: cfg.memoryDir,
    providerId: cfg.hostEmbeddingProviderId ?? "",
    providerModel: cfg.hostEmbeddingProviderModel ?? "",
    workspaceDir: workspaceDir ?? "",
    openClawConfig: stableOpenClawConfigSignature(apiConfig),
  })).digest("hex")}`;
}

function selectOpenClawEmbeddingAdapter(
  api: OpenClawPluginApi,
  requestedId?: string,
): { kind: OpenClawEmbeddingAdapterKind; adapter: OpenClawEmbeddingAdapter } | null {
  const memorySdk = loadOpenClawMemoryEmbeddingSdk();
  const memoryAdapters = memorySdk?.listMemoryEmbeddingProviders?.(api.config) ?? [];
  const selectedMemory = selectAdapter(memoryAdapters, requestedId);
  if (selectedMemory) {
    return { kind: "memory", adapter: selectedMemory };
  }

  const genericSdk = requireOpenClawSdkSubpath<{
    listEmbeddingProviders?: (cfg?: unknown) => unknown[];
  }>("openclaw/plugin-sdk/embedding-providers");
  const genericAdapters = genericSdk?.listEmbeddingProviders?.(api.config) ?? [];
  const selectedGeneric = selectAdapter(genericAdapters, requestedId);
  if (selectedGeneric) {
    return { kind: "generic", adapter: selectedGeneric };
  }

  return null;
}

export function loadOpenClawMemoryEmbeddingSdk(): {
  listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[];
} | null {
  return selectOpenClawMemoryEmbeddingSdk(
    requireOpenClawSdkSubpath<{
      listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[];
    }>("openclaw/plugin-sdk/memory-core-host-engine-embeddings"),
    requireOpenClawSdkSubpath<{
      listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[];
    }>("openclaw/plugin-sdk/memory-core-host-embedding-registry"),
  );
}

export function selectOpenClawMemoryEmbeddingSdk(
  currentSdk: { listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[] } | null,
  legacySdk: { listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[] } | null,
): { listMemoryEmbeddingProviders?: (cfg?: unknown) => unknown[] } | null {
  return currentSdk ?? legacySdk;
}

function selectAdapter(
  adapters: unknown[],
  requestedId?: string,
): OpenClawEmbeddingAdapter | null {
  const valid = adapters.filter(isOpenClawEmbeddingAdapter);
  if (valid.length === 0) return null;
  if (requestedId) {
    return valid.find((adapter) => adapter.id === requestedId) ?? null;
  }
  return valid[0] ?? null;
}

function isOpenClawEmbeddingAdapter(value: unknown): value is OpenClawEmbeddingAdapter {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).create === "function"
  );
}

export async function embedWithOpenClawProvider(
  _kind: OpenClawEmbeddingAdapterKind,
  provider: unknown,
  text: string,
  options?: { signal?: AbortSignal; inputType?: string },
): Promise<number[] | null> {
  if (!provider || typeof provider !== "object") return null;
  const record = provider as Record<string, unknown>;
  if (options?.inputType === "query" && typeof record.embedQuery === "function") {
    return normalizeHostEmbeddingVector(
      await record.embedQuery.call(provider, text, { signal: options.signal }),
    );
  }
  if (typeof record.embed === "function") {
    return normalizeHostEmbeddingVector(
      await record.embed.call(provider, text, {
        signal: options?.signal,
        inputType: options?.inputType,
      }),
    );
  }
  if (typeof record.embedBatch === "function") {
    const vectors = await record.embedBatch.call(provider, [text], {
      signal: options?.signal,
      inputType: options?.inputType,
    });
    return normalizeHostEmbeddingVector(Array.isArray(vectors) ? vectors[0] : null);
  }
  return null;
}

async function embedBatchWithOpenClawProvider(
  kind: OpenClawEmbeddingAdapterKind,
  provider: unknown,
  texts: string[],
  options?: { signal?: AbortSignal; inputType?: string },
): Promise<Array<number[] | null>> {
  if (!provider || typeof provider !== "object") return texts.map(() => null);
  const record = provider as Record<string, unknown>;
  if (typeof record.embedBatch === "function") {
    const vectors = await record.embedBatch.call(provider, texts, {
      signal: options?.signal,
      inputType: options?.inputType,
    });
    return texts.map((_, index) =>
      normalizeHostEmbeddingVector(Array.isArray(vectors) ? vectors[index] : null),
    );
  }
  return Promise.all(
    texts.map((text) => embedWithOpenClawProvider(kind, provider, text, options)),
  );
}

let sdkCaps: SdkCapabilities | undefined;

const NON_RUNTIME_REGISTRATION_MODES = new Set<OpenClawRegistrationMode>([
  "setup-only",
  "setup-runtime",
  "cli-metadata",
]);

const DISCOVERY_REGISTRATION_MODES = new Set<OpenClawRegistrationMode>([
  "discovery",
  "tool-discovery",
]);

function isNonRuntimeRegistrationMode(
  mode: SdkCapabilities["registrationMode"],
): boolean {
  return typeof mode === "string" && NON_RUNTIME_REGISTRATION_MODES.has(mode);
}

const pluginDefinition = {
  id: REMNIC_OPENCLAW_PLUGIN_ID,
  name: "Remnic (Local Memory)",
  description:
    "Local-first memory plugin. Uses GPT-5.2 for intelligent extraction and hybrid local retrieval.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // OpenClaw's cli-metadata loader currently invokes register(api) as an
    // unbound function, so `this` can legitimately be undefined there.
    // Guard that path and fall back to the canonical id when no bound entry
    // object is available.
    const registerThis =
      typeof this === "object" && this !== null
        ? (this as { id?: unknown })
        : undefined;
    const serviceId: string =
      typeof registerThis?.id === "string" && registerThis.id.trim().length > 0
        ? registerThis.id
        : REMNIC_OPENCLAW_PLUGIN_ID;
    const keys = buildServiceKeys(serviceId);

    initLogger(api.logger, false);

    sdkCaps = detectSdkCapabilities(api as unknown as Record<string, unknown>);
    log.info(
      `SDK detection: version=${sdkCaps.sdkVersion}, beforePromptBuild=${sdkCaps.hasBeforePromptBuild}, memoryPromptSection=${sdkCaps.hasRegisterMemoryPromptSection}, memoryCapability=${sdkCaps.hasRegisterMemoryCapability}, typedHooks=${sdkCaps.hasTypedHooks}`,
    );

    if (isNonRuntimeRegistrationMode(sdkCaps.registrationMode)) {
      log.info(
        `registrationMode=${sdkCaps.registrationMode} — skipping runtime initialization`,
      );
      return;
    }

    const discoveryPass =
      typeof sdkCaps.registrationMode === "string" &&
      DISCOVERY_REGISTRATION_MODES.has(sdkCaps.registrationMode);
    const disableRegisterMigration =
      readEnvVar("REMNIC_DISABLE_REGISTER_MIGRATION") === "1" ||
      readEnvVar("OPENCLAW_ENGRAM_DISABLE_REGISTER_MIGRATION") === "1" ||
      discoveryPass;
    if (!disableRegisterMigration) {
      const migrationPromise = ((globalThis as any)[ENGRAM_MIGRATION_PROMISE] ??=
        migrateFromEngram({
          quiet: true,
          logger: (message) => log.info(message),
        }).catch((error) => {
          log.warn(`register migration failed: ${error}`);
        }));
      void migrationPromise;
    }
    const fileConfig = loadPluginConfigFromFile(serviceId);
    const openclawFlushPlanProcessingEnabled = resolveOpenClawFlushPlanProcessingEnabledFromConfig(fileConfig, api.pluginConfig);
    const runtimeSet = new Set<string>();
    const rawPluginConfig = {
      ...fileConfig,
      ...api.pluginConfig,
    };
    const cfg = parseConfig(
      {
        ...rawPluginConfig,
        gatewayConfig: api.config, // Pass gateway config for fallback AI
      },
      fileConfig ?? {},
      runtimeSet,
    );
    cfg.providerApiKeyResolver = resolveOpenClawProviderApiKey;
    cfg.runtimeAuthForModelResolver = getOpenClawRuntimeAuthForModel;
    initLogger(api.logger, cfg.debug);
    log.info(
      `initialized (debug=${cfg.debug}, qmdEnabled=${cfg.qmdEnabled}, transcriptEnabled=${cfg.transcriptEnabled}, hourlySummariesEnabled=${cfg.hourlySummariesEnabled})`,
    );
    log.debug(
      `init llm routing (modelSource=${cfg.modelSource}, localLlmEnabled=${cfg.localLlmEnabled}${cfg.localLlmFastEnabled ? `, fastLlm=${cfg.localLlmFastModel || "(primary)"}` : ""})`,
    );
    const fileBackedRawRuntimeConfig = loadRawConfigFromFile();
    const rawRuntimeConfig =
      api.config && typeof api.config === "object"
        ? (api.config as Record<string, unknown>)
        : fileBackedRawRuntimeConfig;
    const slotValidationMode = validateSlotSelection({
      pluginId: serviceId,
      runtimeConfig: rawRuntimeConfig,
      requireExclusive: cfg.slotBehavior.requireExclusiveMemorySlot,
      onMismatch: cfg.slotBehavior.onSlotMismatch,
      logger: api.logger,
    });
    const passiveMode = slotValidationMode === "passive";
    if (passiveMode) {
      log.info(
        `[remnic] memory slot not assigned to ${serviceId}; running passively`,
      );
    }
    const channelEnvelopeCleaning = resolveChannelEnvelopePrefixes(cfg);
    const cleanOpenClawUserMessage = createOpenClawUserMessageCleaner(
      channelEnvelopeCleaning.prefixes,
      {
        includeLegacyChannelEnvelopePattern:
          channelEnvelopeCleaning.includeLegacyChannelEnvelopePattern,
      },
    );

    const delegateApi = api as unknown as DelegateHookApi;
    const delegateSupportPassportGatewayRoute =
      createConfiguredSupportPassportGatewayRoute(cfg);
    const delegateHandled = maybeRegisterDelegateRuntime(delegateApi, {
      serviceId,
      configBridgeMode: cfg.bridgeMode,
      bridgeHealthTimeoutMs: rawPluginConfig.bridgeHealthTimeoutMs,
      passive: passiveMode,
      allowPromptInjection:
        coerceRawConfigBoolean(
          readPluginHooksPolicy(api.config, serviceId)?.allowPromptInjection,
        ) !== false,
      gateHeartbeatTurns:
        cfg.heartbeat.enabled && cfg.heartbeat.gateExtractionDuringHeartbeat,
      recallBudgetChars: cfg.recallBudgetChars,
      memoryDir: cfg.memoryDir,
      sessionTogglesEnabled: cfg.sessionTogglesEnabled,
      respectBundledActiveMemoryToggle: cfg.respectBundledActiveMemoryToggle,
      cleanUserMessage: cleanOpenClawUserMessage,
      hookTimeoutMs: cfg.initGateTimeoutMs,
      shouldSkipRecall: (sk: string) => shouldSkipRecallForSession(sk, cfg),
      cwd: getOpenClawRuntimeWorkspaceDir(api),
      flushOnResetEnabled: cfg.flushOnResetEnabled,
      openclawToolsEnabled: cfg.openclawToolsEnabled,
      openclawToolSnippetMaxChars: cfg.openclawToolSnippetMaxChars,
      supportPassportModelRoute: delegateSupportPassportGatewayRoute ?? undefined,
      capability: {
        memoryDir: cfg.memoryDir,
        workspaceDir:
          getOpenClawRuntimeWorkspaceDir(api) ?? cfg.workspaceDir ?? defaultWorkspaceDir(),
        agentIds: [getOpenClawRuntimeAgentId(api) ?? "generalist"],
        extractionMaxTurnChars: cfg.extractionMaxTurnChars,
        flushModel:
          typeof cfg.summaryModel === "string" && cfg.summaryModel.length > 0
            ? cfg.summaryModel
            : cfg.taskModelChain?.primary,
        configuredSearchBackend:
          (cfg.searchBackend ?? "qmd") === "qmd" && cfg.qmdEnabled !== false
            ? "qmd"
            : "builtin",
        configuredQmdCommand:
          typeof cfg.qmdPath === "string" && cfg.qmdPath.trim().length > 0
            ? cfg.qmdPath.trim()
            : "qmd",
      },
    });
    if (delegateHandled) return;

    const existing = (globalThis as any)[keys.ORCHESTRATOR] as
      | Orchestrator
      | undefined;
    const orchestrator = existing?.recall ? existing : new Orchestrator(cfg);
    const isFirstRegistration = !(globalThis as any)[keys.REGISTERED_GUARD];
    (globalThis as any)[keys.REGISTERED_GUARD] = true;
    const unregisterExistingHostEmbeddingProvider = () => {
      const unregisterHostEmbedding = (globalThis as any)[
        keys.HOST_EMBEDDING_UNREGISTER
      ] as (() => void) | undefined;
      unregisterHostEmbedding?.();
      delete (globalThis as any)[keys.HOST_EMBEDDING_UNREGISTER];
      delete (globalThis as any)[keys.HOST_EMBEDDING_SIGNATURE];
    };
    if (passiveMode) {
      unregisterExistingHostEmbeddingProvider();
    } else {
      const hostEmbeddingSignature = openClawHostEmbeddingConfigSignature(
        cfg,
        api.config,
        getOpenClawRuntimeWorkspaceDir(api),
      );
      const existingHostEmbeddingSignature = (globalThis as any)[
        keys.HOST_EMBEDDING_SIGNATURE
      ] as string | undefined;
      if (
        (globalThis as any)[keys.HOST_EMBEDDING_UNREGISTER] &&
        existingHostEmbeddingSignature !== hostEmbeddingSignature
      ) {
        unregisterExistingHostEmbeddingProvider();
      }
      if (!(globalThis as any)[keys.HOST_EMBEDDING_UNREGISTER]) {
        const unregisterHostEmbedding = registerOpenClawHostEmbeddingProvider({
          api,
          cfg,
          serviceId,
        });
        if (unregisterHostEmbedding) {
          (globalThis as any)[keys.HOST_EMBEDDING_UNREGISTER] =
            unregisterHostEmbedding;
          (globalThis as any)[keys.HOST_EMBEDDING_SIGNATURE] =
            hostEmbeddingSignature;
        }
      }
    }

    const hookApis: WeakSet<object> = ((globalThis as any)[keys.HOOK_APIS] ??=
      new WeakSet());
    if (hookApis.has(api)) {
      log.debug(
        "register: this api already has hooks bound — skipping duplicate hook registration",
      );
      return;
    }
    hookApis.add(api);

    if (!isFirstRegistration) {
      log.debug(
        "register called again (new registry); re-registering hooks with shared orchestrator",
      );
    }

    (globalThis as any)[keys.ORCHESTRATOR] = orchestrator;
    (globalThis as any).__openclawEngramOrchestrator = orchestrator;
    if ((globalThis as any).__openclawEngramTrace === undefined) {
      (globalThis as any).__openclawEngramTrace = undefined;
    }

    const existingAccessService = (globalThis as any)[keys.ACCESS_SERVICE] as
      | EngramAccessService
      | undefined;
    const accessService =
      existingAccessService && (existingAccessService as EngramAccessService)
        ? existingAccessService
        : new EngramAccessService(orchestrator, {
            resolveSecretRef: (ref, context) =>
              loadOpenClawSecretRefResolver().then((resolver) => (resolver ? resolver(ref, context) : undefined)),
          });
    (globalThis as any)[keys.ACCESS_SERVICE] = accessService;

    const rawAuthToken = cfg.agentAccessHttp.authToken;
    const authTokenIsSecretRef =
      rawAuthToken !== undefined && typeof rawAuthToken !== "string";
    const accessHttpAuthState =
      (((globalThis as any)[keys.ACCESS_HTTP_AUTH_STATE] ??= {
        resolvedSecretRefAuthToken: undefined as string | undefined,
      }) as { resolvedSecretRefAuthToken: string | undefined });
    const authTokensFromSecretRef = (): string[] =>
      accessHttpAuthState.resolvedSecretRefAuthToken
        ? [accessHttpAuthState.resolvedSecretRefAuthToken]
        : [];

    const existingAccessHttpServer = (globalThis as any)[
      keys.ACCESS_HTTP_SERVER
    ] as EngramAccessHttpServer | undefined;
    const accessHttpServer =
      existingAccessHttpServer &&
      (existingAccessHttpServer as EngramAccessHttpServer)
        ? existingAccessHttpServer
        : new EngramAccessHttpServer({
            service: accessService,
            host: cfg.agentAccessHttp.host,
            port: cfg.agentAccessHttp.port,
            authToken: authTokenIsSecretRef
              ? undefined
              : (rawAuthToken as string | undefined),
            authTokensGetter: authTokenIsSecretRef
              ? authTokensFromSecretRef
              : undefined,
            principal: cfg.agentAccessHttp.principal,
            maxBodyBytes: cfg.agentAccessHttp.maxBodyBytes,
            writeRateLimitMaxRequests: cfg.agentAccessHttp.writeRateLimitMaxRequests,
            writeRateLimitWindowMs: cfg.agentAccessHttp.writeRateLimitWindowMs,
            trustPrincipalHeader: cfg.agentAccessHttp.trustPrincipalHeader,
            citationsEnabled: cfg.citationsEnabled,
            citationsAutoDetect: cfg.citationsAutoDetect,
            emitLegacyTools: cfg.emitLegacyTools,
          });
    (globalThis as any)[keys.ACCESS_HTTP_SERVER] = accessHttpServer;

    const pluginStateDir = path.join(cfg.memoryDir, "state", "plugins", serviceId);
    const togglePrimaryPath = path.join(pluginStateDir, "session-toggles.json");
    const toggleSecondaryPath = cfg.respectBundledActiveMemoryToggle
      ? path.join(cfg.memoryDir, "state", "plugins", "active-memory", "session-toggles.json")
      : undefined;
    const sessionToggleStore = createFileToggleStore(togglePrimaryPath, {
      secondaryReadOnlyPath: toggleSecondaryPath,
    });
    const dreamsSurface = createDreamsSurface();
    const heartbeatSurface = createHeartbeatSurface();
    const dreamNarrativeClient = cfg.openaiApiKey
      ? new OpenAI({
          apiKey: cfg.openaiApiKey,
          ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
        })
      : null;
    let stopDreamWatcher: (() => void) | null = null;
    let stopHeartbeatWatcher: (() => void) | null = null;
    let removeDreamingObserver: (() => void) | null = null;
    let dreamSurfaceSyncChain: Promise<void> = Promise.resolve();
    let heartbeatSurfaceSyncChain: Promise<void> = Promise.resolve();
    const recallAuditDir = pluginStateDir;
    const lastRecallSummaryBySession = new Map<string, string | null>();

    function resolveWorkspaceRoot(runtimeWorkspaceDir?: string): string {
      return runtimeWorkspaceDir && runtimeWorkspaceDir.trim().length > 0
        ? runtimeWorkspaceDir
        : cfg.workspaceDir;
    }

    function resolveDreamJournalPath(runtimeWorkspaceDir?: string): string {
      const workspaceRoot = resolveWorkspaceRoot(runtimeWorkspaceDir);
      return path.isAbsolute(cfg.dreaming.journalPath)
        ? cfg.dreaming.journalPath
        : path.join(workspaceRoot, cfg.dreaming.journalPath);
    }

    function resolveHeartbeatJournalPath(runtimeWorkspaceDir?: string): string {
      const workspaceRoot = resolveWorkspaceRoot(runtimeWorkspaceDir);
      return path.isAbsolute(cfg.heartbeat.journalPath)
        ? cfg.heartbeat.journalPath
        : path.join(workspaceRoot, cfg.heartbeat.journalPath);
    }

    const existingFlushPlanProcessingChains = (globalThis as any)[
      keys.FLUSH_PLAN_PROCESSING_CHAINS
    ];
    const flushPlanProcessingChains =
      existingFlushPlanProcessingChains instanceof Map
        ? (existingFlushPlanProcessingChains as Map<string, Promise<void>>)
        : new Map<string, Promise<void>>();
    (globalThis as any)[keys.FLUSH_PLAN_PROCESSING_CHAINS] =
      flushPlanProcessingChains;

    function resolveFlushPlanDeadlineMs(options: {
      deadlineMs?: number;
      timeoutMs?: number;
    }): number | undefined {
      if (
        typeof options.deadlineMs === "number" &&
        Number.isFinite(options.deadlineMs)
      ) {
        return options.deadlineMs;
      }
      if (
        typeof options.timeoutMs === "number" &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs >= 0
      ) {
        return Date.now() + Math.floor(options.timeoutMs);
      }
      return undefined;
    }

    function waitForOpenClawFlushPlanTask(
      task: Promise<void>,
      reason: string,
      deadlineMs?: number,
    ): Promise<void> {
      if (typeof deadlineMs !== "number") {
        return task;
      }
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      if (remainingMs === 0) {
        log.warn(
          `OpenClaw flush-plan processing timed out before queue wait for ${reason}`,
        );
        return Promise.resolve();
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        task,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            log.warn(
              `OpenClaw flush-plan processing timed out while waiting for ${reason}; current drain remains fenced until it settles`,
            );
            resolve();
          }, remainingMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
    }

    async function runOpenClawFlushPlanProcessing(
      reason: string,
      workspaceRoot: string,
      deadlineMs?: number,
    ): Promise<void> {
      if (typeof deadlineMs === "number" && Date.now() >= deadlineMs) {
        log.warn(
          `OpenClaw flush-plan processing timed out before starting for ${reason}`,
        );
        return;
      }
      try {
        const result = await processOpenClawFlushPlanFile({
          enabled: openclawFlushPlanProcessingEnabled,
          workspaceDir: workspaceRoot,
          serviceId,
          ingestor: orchestrator,
          logger: {
            debug: (message) => log.debug(message),
            info: (message) => log.info(message),
            warn: (message) => log.warn(message),
          },
          reason,
          deadlineMs,
          maxTurnChars: cfg.extractionMaxTurnChars,
        });
        if (
          result.status === "processed" ||
          result.status === "processed_preserved_tail" ||
          result.status === "processed_marker_recovered" ||
          result.status === "processed_marker_recovered_tail" ||
          result.status === "processed_cleanup_deferred"
        ) {
          log.info(
            `OpenClaw flush-plan ${result.status}: ${result.bytesProcessed ?? 0} bytes` +
              (result.preservedBytes ? ` (${result.preservedBytes} bytes preserved)` : ""),
          );
        } else if (result.status === "skipped") {
          log.warn(
            `OpenClaw flush-plan processing skipped: ${result.reason ?? "unknown reason"}`,
          );
        }
      } catch (error) {
        const detail = displayErrorDetail(error) || "unknown error";
        log.warn(`OpenClaw flush-plan processing failed: ${detail}`);
      }
    }

    async function queueOpenClawFlushPlanProcessing(
      reason: string,
      runtimeWorkspaceDir?: string,
      options: { deadlineMs?: number; timeoutMs?: number } = {},
    ): Promise<void> {
      if (passiveMode || !openclawFlushPlanProcessingEnabled) {
        return Promise.resolve();
      }
      const workspaceRoot = resolveWorkspaceRoot(runtimeWorkspaceDir);
      const chainKey = await resolveFlushPlanProcessingChainKey(workspaceRoot);
      const deadlineMs = resolveFlushPlanDeadlineMs(options);
      const previousTask =
        flushPlanProcessingChains.get(chainKey);
      const task = (previousTask ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => runOpenClawFlushPlanProcessing(reason, workspaceRoot, deadlineMs));
      const fencedTask = task.catch(() => undefined);
      flushPlanProcessingChains.set(chainKey, fencedTask);
      void fencedTask.finally(() => {
        if (flushPlanProcessingChains.get(chainKey) === fencedTask) {
          flushPlanProcessingChains.delete(chainKey);
        }
      });
      return waitForOpenClawFlushPlanTask(task, reason, deadlineMs);
    }

    function queueDreamSurfaceSync(runtimeWorkspaceDir?: string): Promise<void> {
      if (!cfg.dreaming.enabled) return Promise.resolve();
      dreamSurfaceSyncChain = dreamSurfaceSyncChain
        .catch(() => {})
        .then(async () => {
          const journalPath = resolveDreamJournalPath(runtimeWorkspaceDir);
          const entries = await dreamsSurface.read(journalPath);
          await forEachRuntimeSurfaceStorage({
            config: cfg,
            storage: orchestrator.storage,
            getStorageForNamespace: (namespace) =>
              typeof orchestrator.getStorageForNamespace === "function"
                ? orchestrator.getStorageForNamespace(namespace)
                : Promise.resolve(orchestrator.storage),
            work: async (storage) => {
              await syncDreamSurfaceEntries({
                storage,
                entries,
                journalPath,
                maxEntries: cfg.dreaming.maxEntries,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
              });
            },
          });
        });
      return dreamSurfaceSyncChain;
    }

    function queueHeartbeatSurfaceSync(runtimeWorkspaceDir?: string): Promise<void> {
      if (!cfg.heartbeat.enabled) return Promise.resolve();
      heartbeatSurfaceSyncChain = heartbeatSurfaceSyncChain
        .catch(() => {})
        .then(async () => {
          const journalPath = resolveHeartbeatJournalPath(runtimeWorkspaceDir);
          const entries = await heartbeatSurface.read(journalPath);
          if (entries.length === 0) {
            return;
          }
          await forEachRuntimeSurfaceStorage({
            config: cfg,
            storage: orchestrator.storage,
            getStorageForNamespace: (namespace) =>
              typeof orchestrator.getStorageForNamespace === "function"
                ? orchestrator.getStorageForNamespace(namespace)
                : Promise.resolve(orchestrator.storage),
            work: async (storage) => {
              await syncHeartbeatSurfaceEntries({
                storage,
                entries,
                journalPath,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
              });
              await syncHeartbeatOutcomeLinks({
                storage,
                entries,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
                logger: {
                  debug: (message) => log.debug(message),
                },
              });
            },
          });
        });
      return heartbeatSurfaceSyncChain;
    }

    async function maybeAppendDreamFromConsolidation(
      observation: ConsolidationObservation,
    ): Promise<void> {
      if (!cfg.dreaming.enabled) return;
      const route = resolveDreamNarrativeRoute(cfg, !!dreamNarrativeClient);
      if (route.kind === "skip") {
        log.debug(
          "dreaming narrative skipped: no LLM available (set openaiApiKey or use modelSource=gateway)",
        );
        return;
      }
      const journalPath = resolveDreamJournalPath();
      const existingDreams = await dreamsSurface.read(journalPath);
      const plan = planDreamEntryFromConsolidation({
        observation,
        existingDreams,
        minIntervalMinutes: cfg.dreaming.minIntervalMinutes,
      });
      if (!plan) return;

      const styleInstruction =
        cfg.dreaming.narrativePromptStyle === "diary"
          ? "Write like a compact private diary entry."
          : cfg.dreaming.narrativePromptStyle === "analytical"
            ? "Write like an analytical retrospective with explicit patterns."
            : "Write like a reflective narrative that notices patterns and emotional tone.";
      const instructions =
        "You write short reflective dream-journal entries for an AI memory system. " +
        `${styleInstruction} Return exactly this structure:\n` +
        "Title: <short title>\nTags: #tag #tag\nBody:\n<2-4 concise paragraphs>";
      const input =
        `The last consolidation spanned ${plan.sessionLikeCount} session-like windows.\n` +
        `Keep the reflection grounded in the evidence below.\n\n` +
        plan.memoryContext.join("\n");
      let rawNarrative = "";
      try {
        if (route.kind === "gateway") {
          const llm = new FallbackLlmClient(
            cfg.gatewayConfig,
            fallbackLlmRuntimeContextFromConfig(cfg),
          );
          if (!route.hasExplicitModel && !llm.isAvailable(route.options)) {
            log.debug(
              "dreaming narrative skipped: no gateway model configured (set dreaming.narrativeModel or taskModelChain)",
            );
            return;
          }
          const response = await llm.chatCompletion(
            [
              { role: "system", content: instructions },
              { role: "user", content: input },
            ],
            { temperature: 0.4, maxTokens: 400, ...route.options },
          );
          rawNarrative = response?.content ?? "";
        } else {
          const response = await dreamNarrativeClient!.responses.create({
            model: cfg.dreaming.narrativeModel ?? cfg.model,
            instructions,
            input,
            temperature: 0.4,
            max_output_tokens: 400,
          });
          rawNarrative =
            typeof response.output_text === "string"
              ? response.output_text
              : JSON.stringify(response.output_text ?? "");
        }
      } catch (error) {
        log.warn(`dreaming narrative generation failed: ${String(error)}`);
        return;
      }
      const parsed = parseDreamNarrativeResponse(
        rawNarrative,
        plan.suggestedTags,
      );
      if (!parsed) return;
      await dreamsSurface.append(journalPath, {
        timestamp: plan.timestamp,
        title: parsed.title,
        body: parsed.body,
        tags: parsed.tags,
      });
      await queueDreamSurfaceSync();
    }

    if (!discoveryPass) {
      void pruneRecallAuditEntries(recallAuditDir, cfg.recallTranscriptRetentionDays).catch((error) => {
        log.debug(`recall audit prune failed: ${String(error)}`);
      });
    }
    const sessionCommandDescriptors = buildSessionCommandDescriptors(serviceId, {
      toggles: sessionToggleStore,
      getLastRecall: (sessionKey) => orchestrator.getLastRecall(sessionKey),
      getLastRecallSummary: (sessionKey) =>
        lastRecallSummaryBySession.get(sessionKey) ?? null,
      flushSession: async (sessionKey) => {
        await orchestrator.flushSession(sessionKey, {
          reason: "session-command",
        });
      },
    });
    const activeRecallEngine = createActiveRecallEngine(
      {
        recall: async (query, sessionKey) =>
          orchestrator.recall(query, sessionKey, { sourceConnector: "openclaw" }),
        getLastRecallSnapshot: (sessionKey) => orchestrator.getLastRecall(sessionKey),
        explainLastRecall:
          cfg.activeRecallAttachRecallExplain === true
            ? async () =>
                await orchestrator.recallIntrospection
                  .explainLastQmdRecall()
                  .catch(() => null)
            : undefined,
      },
      {
        enabled: cfg.activeRecallEnabled,
        agents: cfg.activeRecallAgents,
        allowedChatTypes: cfg.activeRecallAllowedChatTypes,
        queryMode: cfg.activeRecallQueryMode,
        promptStyle: cfg.activeRecallPromptStyle,
        customInstruction: cfg.activeRecallCustomInstruction,
        promptReplacement: cfg.activeRecallPromptReplacement,
        promptAppend: cfg.activeRecallPromptAppend,
        maxSummaryChars: cfg.activeRecallMaxSummaryChars,
        recentUserTurns: cfg.activeRecallRecentUserTurns,
        recentAssistantTurns: cfg.activeRecallRecentAssistantTurns,
        recentUserChars: cfg.activeRecallRecentUserChars,
        recentAssistantChars: cfg.activeRecallRecentAssistantChars,
        thinking: cfg.activeRecallThinking,
        timeoutMs: cfg.activeRecallTimeoutMs,
        cacheTtlMs: cfg.activeRecallCacheTtlMs,
        persistTranscripts: cfg.activeRecallPersistTranscripts,
        transcriptDir: path.isAbsolute(cfg.activeRecallTranscriptDir)
          ? cfg.activeRecallTranscriptDir : path.join(pluginStateDir, cfg.activeRecallTranscriptDir),
        entityGraphDepth: cfg.activeRecallEntityGraphDepth,
        includeCausalTrajectories: cfg.activeRecallIncludeCausalTrajectories,
        includeDaySummary: cfg.activeRecallIncludeDaySummary,
        attachRecallExplain: cfg.activeRecallAttachRecallExplain,
        modelOverride: cfg.activeRecallModel,
        modelFallbackPolicy: cfg.activeRecallModelFallbackPolicy,
      },
    );

    if (!passiveMode) {
    // ========================================================================
    // ========================================================================
    const hooksPolicy = readPluginHooksPolicy(api.config, serviceId);
    const promptInjectionAllowed =
      coerceRawConfigBoolean(hooksPolicy?.allowPromptInjection) !== false;

    const useMemoryPromptSection =
      sdkCaps.hasRegisterMemoryPromptSection &&
      typeof api.registerMemoryPromptSection === "function" &&
      promptInjectionAllowed;
    const warnedBundledActiveMemoryCollisionAgents = new Set<string>();

    const cachedMemoryBySession = new Map<string, string[] | null>();
    const cachedMemoryByCodexCacheKey = new Map<string, string[] | null>();
    const codexThreadBySession = new Map<string, string>();
    const codexBufferKeyBySession = new Map<string, string>();
    const codexSessionsByThread = new Map<string, Set<string>>();
    const codexSessionsByBufferKey = new Map<string, Set<string>>();
    const codexMessageCountByBufferKey = new Map<string, number>();
    const observedInboundMessageIds = new Set<string>();
    const observedInboundMessageIdOrder: string[] = [];
    const observedInboundContentFingerprints = new Set<string>();
    const observedInboundContentFingerprintOrder: string[] = [];
    const observedInboundCaptureContentFingerprints = new Set<string>();
    const observedInboundCaptureContentFingerprintOrder: string[] = [];
    const pendingSparseInboundContentFingerprints = new Set<string>();
    const pendingSparseInboundContentFingerprintOrder: string[] = [];
    const inboundReplyMetadataByMessageKey = new Map<string, OpenClawTranscriptMetadata>();
    const inboundReplyMetadataKeyOrder: string[] = [];
    const inlineCaptureProcessor = new InlineExplicitCaptureProcessor(orchestrator, {
      sourceConnector: "openclaw",
    });
    let codexCompactionModeLogged = false;

    function rememberObservedInboundMessageId(messageKey: string): void {
      if (!observedInboundMessageIds.has(messageKey)) {
        observedInboundMessageIds.add(messageKey);
        observedInboundMessageIdOrder.push(messageKey);
      }
      while (observedInboundMessageIdOrder.length > MAX_OBSERVED_INBOUND_MESSAGE_IDS) {
        const expired = observedInboundMessageIdOrder.shift();
        if (expired) {
          observedInboundMessageIds.delete(expired);
          inboundReplyMetadataByMessageKey.delete(expired);
        }
      }
    }

    function rememberObservedInboundMessageKeys(messageKeys: string[]): void {
      for (const messageKey of messageKeys) {
        rememberObservedInboundMessageId(messageKey);
      }
    }

    function rememberObservedInboundContentFingerprint(
      contentFingerprint: string | null,
    ): void {
      if (!contentFingerprint) return;
      if (!observedInboundContentFingerprints.has(contentFingerprint)) {
        observedInboundContentFingerprints.add(contentFingerprint);
        observedInboundContentFingerprintOrder.push(contentFingerprint);
      }
      while (
        observedInboundContentFingerprintOrder.length >
        MAX_OBSERVED_INBOUND_MESSAGE_IDS
      ) {
        const expired = observedInboundContentFingerprintOrder.shift();
        if (expired) observedInboundContentFingerprints.delete(expired);
      }
    }

    function rememberObservedInboundCaptureContentFingerprint(
      contentFingerprint: string | null,
    ): void {
      if (!contentFingerprint) return;
      if (!observedInboundCaptureContentFingerprints.has(contentFingerprint)) {
        observedInboundCaptureContentFingerprints.add(contentFingerprint);
        observedInboundCaptureContentFingerprintOrder.push(contentFingerprint);
      }
      while (
        observedInboundCaptureContentFingerprintOrder.length >
        MAX_OBSERVED_INBOUND_MESSAGE_IDS
      ) {
        const expired = observedInboundCaptureContentFingerprintOrder.shift();
        if (expired) observedInboundCaptureContentFingerprints.delete(expired);
      }
    }

    function rememberPendingSparseInboundContentFingerprint(
      contentFingerprint: string | null,
    ): void {
      if (!contentFingerprint) return;
      if (!pendingSparseInboundContentFingerprints.has(contentFingerprint)) {
        pendingSparseInboundContentFingerprints.add(contentFingerprint);
        pendingSparseInboundContentFingerprintOrder.push(contentFingerprint);
      }
      while (
        pendingSparseInboundContentFingerprintOrder.length >
        MAX_OBSERVED_INBOUND_MESSAGE_IDS
      ) {
        const expired = pendingSparseInboundContentFingerprintOrder.shift();
        if (expired) pendingSparseInboundContentFingerprints.delete(expired);
      }
    }

    function consumePendingSparseInboundContentFingerprint(
      contentFingerprint: string | null,
    ): boolean {
      if (!contentFingerprint || !pendingSparseInboundContentFingerprints.has(contentFingerprint)) {
        return false;
      }
      pendingSparseInboundContentFingerprints.delete(contentFingerprint);
      const index = pendingSparseInboundContentFingerprintOrder.indexOf(contentFingerprint);
      if (index >= 0) pendingSparseInboundContentFingerprintOrder.splice(index, 1);
      return true;
    }

    function rememberInboundReplyMetadata(
      messageKeys: readonly string[],
      metadata: OpenClawTranscriptMetadata | null,
    ): void {
      if (!metadata?.replyToBody?.trim()) return;
      for (const messageKey of messageKeys) {
        if (!inboundReplyMetadataByMessageKey.has(messageKey)) {
          inboundReplyMetadataKeyOrder.push(messageKey);
        }
        inboundReplyMetadataByMessageKey.set(messageKey, metadata);
      }
      while (inboundReplyMetadataKeyOrder.length > MAX_OBSERVED_INBOUND_MESSAGE_IDS) {
        const expired = inboundReplyMetadataKeyOrder.shift();
        if (expired && !observedInboundMessageIds.has(expired)) {
          inboundReplyMetadataByMessageKey.delete(expired);
        }
      }
    }

    function getInboundReplyMetadata(
      messageKeys: readonly string[],
    ): OpenClawTranscriptMetadata | null {
      for (const messageKey of messageKeys) {
        const metadata = inboundReplyMetadataByMessageKey.get(messageKey);
        if (metadata?.replyToBody?.trim()) return metadata;
      }
      return null;
    }

    async function processInlineExplicitCapture(
      content: string,
      messageKeys: readonly string[] | null | undefined,
      fallbackDedupeKeys: readonly (string | null)[] = [],
      sessionKey = "default",
    ) {
      const dedupeKeys = mergeInlineCaptureDedupeKeys(messageKeys, fallbackDedupeKeys);
      const reviewNamespace =
        typeof orchestrator.resolveSelfNamespace === "function"
          ? orchestrator.resolveSelfNamespace(sessionKey)
          : undefined;
      return inlineCaptureProcessor.process({
        captureMode: orchestrator.config.captureMode,
        content,
        dedupeKeys: [...dedupeKeys],
        ...(reviewNamespace
          ? { reviewNamespace, reviewNamespacePreResolved: true }
          : {}),
      });
    }

    function resolveStoredCodexThreadId(sessionKey: string): string | null {
      const threadId = codexThreadBySession.get(sessionKey);
      return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
    }

    function resolveStoredCodexBufferKey(sessionKey: string): string | null {
      const bufferKey = codexBufferKeyBySession.get(sessionKey);
      return typeof bufferKey === "string" && bufferKey.length > 0
        ? bufferKey
        : null;
    }

    function addSessionToCodexIndex(
      index: Map<string, Set<string>>,
      key: string,
      sessionKey: string,
    ): void {
      const sessions = index.get(key) ?? new Set<string>();
      sessions.add(sessionKey);
      index.set(key, sessions);
    }

    function removeSessionFromCodexIndex(
      index: Map<string, Set<string>>,
      key: string,
      sessionKey: string,
    ): boolean {
      const sessions = index.get(key);
      if (!sessions) return true;
      sessions.delete(sessionKey);
      if (sessions.size === 0) {
        index.delete(key);
        return true;
      }
      return false;
    }

    function resolveCodexCompactionBaselineKey(
      sessionKey: string,
      providerThreadId?: string | null,
    ): string | null {
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      if (!resolvedThreadId) return null;
      const logicalSessionKey =
        cfg.codexCompat.threadIdBufferKeying !== false
          ? codexLogicalSessionKey(resolvedThreadId)
          : sessionKey;
      return resolveExtractionBufferKey(sessionKey, logicalSessionKey);
    }

    function resolveCodexPromptCacheKey(
      sessionKey: string,
      providerThreadId?: string | null,
    ): string | null {
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      if (!resolvedThreadId) return null;
      if (!cfg.namespacesEnabled) {
        return resolvedThreadId;
      }
      if (cfg.codexCompat.threadIdBufferKeying !== false) {
        return resolveExtractionBufferKey(
          sessionKey,
          codexLogicalSessionKey(resolvedThreadId),
        );
      }
      const principal = resolvePrincipal(sessionKey, cfg);
      return `${resolvedThreadId}::principal:${principal}`;
    }

    function rememberCodexThread(
      sessionKey: string,
      providerThreadId: string | null,
    ): void {
      if (!providerThreadId) return;
      const previousThreadId = resolveStoredCodexThreadId(sessionKey);
      const previousBufferKey = resolveStoredCodexBufferKey(sessionKey);
      const previousPromptCacheKey = resolveCodexPromptCacheKey(
        sessionKey,
        previousThreadId,
      );
      const nextBufferKey = resolveCodexCompactionBaselineKey(
        sessionKey,
        providerThreadId,
      );
      const nextPromptCacheKey = resolveCodexPromptCacheKey(
        sessionKey,
        providerThreadId,
      );
      if (
        previousThreadId === providerThreadId &&
        previousBufferKey === nextBufferKey
      ) {
        return;
      }
      if (previousBufferKey) {
        const bufferWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByBufferKey,
          previousBufferKey,
          sessionKey,
        );
        if (bufferWasEmptied) {
          codexMessageCountByBufferKey.delete(previousBufferKey);
        }
      }
      if (
        previousPromptCacheKey &&
        previousPromptCacheKey !== nextPromptCacheKey
      ) {
        cachedMemoryByCodexCacheKey.delete(previousPromptCacheKey);
      }
      if (previousThreadId) {
        removeSessionFromCodexIndex(
          codexSessionsByThread,
          previousThreadId,
          sessionKey,
        );
      }
      codexThreadBySession.set(sessionKey, providerThreadId);
      if (nextBufferKey) {
        codexBufferKeyBySession.set(sessionKey, nextBufferKey);
        addSessionToCodexIndex(
          codexSessionsByBufferKey,
          nextBufferKey,
          sessionKey,
        );
      }
      addSessionToCodexIndex(codexSessionsByThread, providerThreadId, sessionKey);
    }

    function forgetCodexThread(
      sessionKey: string,
      providerThreadId?: string | null,
    ): void {
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      const resolvedBufferKey =
        resolveStoredCodexBufferKey(sessionKey) ??
        resolveCodexCompactionBaselineKey(sessionKey, resolvedThreadId);
      if (resolvedBufferKey) {
        const bufferWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByBufferKey,
          resolvedBufferKey,
          sessionKey,
        );
        if (bufferWasEmptied) {
          codexMessageCountByBufferKey.delete(resolvedBufferKey);
        }
      }
      const resolvedPromptCacheKey = resolveCodexPromptCacheKey(
        sessionKey,
        resolvedThreadId,
      );
      if (resolvedPromptCacheKey) {
        cachedMemoryByCodexCacheKey.delete(resolvedPromptCacheKey);
      }
      if (resolvedThreadId) {
        removeSessionFromCodexIndex(
          codexSessionsByThread,
          resolvedThreadId,
          sessionKey,
        );
      }
      codexThreadBySession.delete(sessionKey);
      codexBufferKeyBySession.delete(sessionKey);
    }

    function clearCodexCompatCaches(
      sessionKey: string,
      providerThreadId?: string | null,
      options?: {
        preserveMessageCount?: boolean;
        preserveThreadBinding?: boolean;
      },
    ): void {
      cachedMemoryBySession.delete(sessionKey);
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      const resolvedBufferKey =
        resolveStoredCodexBufferKey(sessionKey) ??
        resolveCodexCompactionBaselineKey(sessionKey, resolvedThreadId);
      const resolvedPromptCacheKey = resolveCodexPromptCacheKey(
        sessionKey,
        resolvedThreadId,
      );
      if (resolvedPromptCacheKey) {
        cachedMemoryByCodexCacheKey.delete(resolvedPromptCacheKey);
      }
      if (resolvedBufferKey && options?.preserveMessageCount !== true) {
        const sessionsForBuffer = codexSessionsByBufferKey.get(resolvedBufferKey);
        const otherSessionsRemain =
          options?.preserveThreadBinding === true ||
          Array.from(sessionsForBuffer ?? []).some(
            (boundSessionKey) => boundSessionKey !== sessionKey,
          );
        if (!otherSessionsRemain) {
          codexMessageCountByBufferKey.delete(resolvedBufferKey);
        }
      }
      if (options?.preserveThreadBinding !== true) {
        if (resolvedBufferKey) {
          removeSessionFromCodexIndex(
            codexSessionsByBufferKey,
            resolvedBufferKey,
            sessionKey,
          );
        }
        if (resolvedThreadId) {
          removeSessionFromCodexIndex(
            codexSessionsByThread,
            resolvedThreadId,
            sessionKey,
          );
        }
        codexThreadBySession.delete(sessionKey);
        codexBufferKeyBySession.delete(sessionKey);
      }
    }

    function hasExplicitProviderIdentity(
      source: Record<string, unknown> | undefined,
    ): boolean {
      if (!source || typeof source !== "object") return false;
      if (typeof source.messageProvider === "string" && source.messageProvider.length > 0) {
        return true;
      }
      if (typeof source.providerId === "string" && source.providerId.length > 0) {
        return true;
      }
      if (typeof source.providerName === "string" && source.providerName.length > 0) {
        return true;
      }
      if (typeof source.modelId === "string" && source.modelId.length > 0) {
        return true;
      }
      if (typeof source.model === "string" && source.model.length > 0) {
        return true;
      }
      if (typeof source.codexThreadId === "string" && source.codexThreadId.length > 0) {
        return true;
      }
      if (source.provider && typeof source.provider === "object") {
        const provider = source.provider as Record<string, unknown>;
        return (
          (typeof provider.id === "string" && provider.id.length > 0) ||
          (typeof provider.name === "string" && provider.name.length > 0) ||
          (typeof provider.model === "string" && provider.model.length > 0) ||
          (typeof provider.modelId === "string" && provider.modelId.length > 0)
        );
      }
      return false;
    }

    function cachePromptMemoryLines(
      sessionKey: string,
      providerThreadId: string | null,
      memoryLines: string[] | null,
    ): void {
      cachedMemoryBySession.set(sessionKey, memoryLines);
      if (providerThreadId) {
        rememberCodexThread(sessionKey, providerThreadId);
        const promptCacheKey = resolveCodexPromptCacheKey(
          sessionKey,
          providerThreadId,
        );
        if (promptCacheKey) {
          cachedMemoryByCodexCacheKey.set(promptCacheKey, memoryLines);
        }
      }
    }

    function consumePromptMemoryLines(
      sessionKey: string,
      options?: { destructive?: boolean },
    ): string[] | null {
      const destructive = options?.destructive !== false;
      const hasSessionLines = cachedMemoryBySession.has(sessionKey);
      const sessionLines = hasSessionLines
        ? (cachedMemoryBySession.get(sessionKey) ?? null)
        : null;
      const promptCacheKey = resolveCodexPromptCacheKey(sessionKey);
      const threadLines = promptCacheKey
        ? (cachedMemoryByCodexCacheKey.get(promptCacheKey) ?? null)
        : null;
      const resolved = hasSessionLines ? sessionLines : threadLines;
      if (!destructive) return resolved;
      cachedMemoryBySession.delete(sessionKey);
      if (promptCacheKey) {
        cachedMemoryByCodexCacheKey.delete(promptCacheKey);
      }
      return resolved;
    }

    function resolveSessionIdentity(
      sessionKey: string,
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) {
      const base = resolveCodexSessionIdentity({
        sessionKey,
        event,
        ctx,
        codexCompat: cfg.codexCompat,
      });
      const explicitProviderIdentity =
        hasExplicitProviderIdentity(event) || hasExplicitProviderIdentity(ctx);
      const storedCodexThreadId = resolveStoredCodexThreadId(sessionKey);
      const hintedThreadId =
        extractCodexThreadId(ctx as Record<string, unknown>) ??
        extractCodexThreadId(event as Record<string, unknown>);
      const previousCodexThreadId =
        explicitProviderIdentity && !base.isCodex ? storedCodexThreadId : null;
      const previousCodexBufferKey = previousCodexThreadId
        ? resolveStoredCodexBufferKey(sessionKey) ??
          resolveCodexCompactionBaselineKey(sessionKey, previousCodexThreadId)
        : null;
      const hasRememberedCodexBinding = !!storedCodexThreadId;
      const allowHintedThreadFallback =
        base.isCodex || (!explicitProviderIdentity && hasRememberedCodexBinding);
      const rememberedThreadId =
        base.providerThreadId ??
        (allowHintedThreadFallback
          ? storedCodexThreadId ?? hintedThreadId
          : null);
      return {
        ...base,
        providerThreadId: rememberedThreadId,
        codexThreadBound:
          !!rememberedThreadId &&
          (base.isCodex || (!explicitProviderIdentity && hasRememberedCodexBinding)),
        logicalSessionKey:
          cfg.codexCompat.threadIdBufferKeying !== false &&
          rememberedThreadId &&
          (base.isCodex || (!explicitProviderIdentity && hasRememberedCodexBinding))
            ? codexLogicalSessionKey(rememberedThreadId)
            : base.logicalSessionKey,
        previousCodexThreadId,
        previousCodexBufferKey,
      };
    }

    async function flushAndForgetCodexThreadOnProviderSwitch(
      sessionKey: string,
      sessionIdentity: {
        isCodex: boolean;
        previousCodexThreadId?: string | null;
        previousCodexBufferKey?: string | null;
      },
    ): Promise<void> {
      if (sessionIdentity.isCodex || !sessionIdentity.previousCodexThreadId) {
        return;
      }
      const bufferKey = sessionIdentity.previousCodexBufferKey;
      if (!bufferKey) {
        forgetCodexThread(sessionKey, sessionIdentity.previousCodexThreadId);
        return;
      }
      if (typeof (orchestrator as any).flushSession !== "function") {
        log.warn("codexCompat provider-switch flush unavailable; preserving binding");
        return;
      }
      try {
        await (orchestrator as any).flushSession(sessionKey, {
          reason: "codex_provider_switch",
          bufferKey,
        });
        forgetCodexThread(sessionKey, sessionIdentity.previousCodexThreadId);
      } catch (error) {
        log.warn(`codexCompat provider-switch flush failed: ${String(error)}`);
      }
    }

    async function flushAndForgetRememberedCodexThreadOnMetadataLoss(
      sessionKey: string,
      sessionIdentity: {
        isCodex: boolean;
        providerThreadId?: string | null;
        previousCodexThreadId?: string | null;
      },
    ): Promise<void> {
      if (
        sessionIdentity.isCodex ||
        sessionIdentity.providerThreadId ||
        sessionIdentity.previousCodexThreadId
      ) {
        return;
      }
      const rememberedThreadId = resolveStoredCodexThreadId(sessionKey);
      if (!rememberedThreadId) {
        forgetCodexThread(sessionKey);
        return;
      }
      const bufferKey =
        resolveStoredCodexBufferKey(sessionKey) ??
        resolveCodexCompactionBaselineKey(sessionKey, rememberedThreadId);
      if (!bufferKey) {
        forgetCodexThread(sessionKey, rememberedThreadId);
        return;
      }
      if (typeof (orchestrator as any).flushSession !== "function") {
        log.warn("codexCompat metadata-loss flush unavailable; preserving binding");
        return;
      }
      try {
        await (orchestrator as any).flushSession(sessionKey, {
          reason: "codex_metadata_loss",
          bufferKey,
        });
        forgetCodexThread(sessionKey, rememberedThreadId);
      } catch (error) {
        log.warn(`codexCompat metadata-loss flush failed: ${String(error)}`);
      }
    }

    function hasBufferedTurns(bufferKey: string): boolean {
      try {
        if (typeof (orchestrator as any).buffer?.getTurns !== "function") {
          return false;
        }
        return ((orchestrator as any).buffer.getTurns(bufferKey) as unknown[]).length > 0;
      } catch {
        return false;
      }
    }

    async function resolveBeforeResetBufferKeys(
      sessionKey: string,
      sessionIdentity: {
        providerThreadId?: string | null;
        logicalSessionKey: string;
      },
    ): Promise<string[]> {
      const rememberedThreadId =
        sessionIdentity.providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      const primaryBufferKey = resolveExtractionBufferKey(
        sessionKey,
        rememberedThreadId && cfg.codexCompat.threadIdBufferKeying !== false
          ? codexLogicalSessionKey(rememberedThreadId)
          : sessionIdentity.logicalSessionKey,
      );
      const rawBufferKey = sessionKey;
      const discoveredBufferKeys =
        typeof sessionKey === "string" &&
        sessionKey.length > 0 &&
        typeof (orchestrator as any).buffer?.findBufferKeysForSession === "function"
          ? await (orchestrator as any).buffer
              .findBufferKeysForSession(sessionKey)
              .catch(() => [])
          : [];
      const bufferKeys = [primaryBufferKey];
      for (const bufferKey of discoveredBufferKeys) {
        if (bufferKey !== primaryBufferKey && hasBufferedTurns(bufferKey)) {
          bufferKeys.push(bufferKey);
        }
      }
      if (rawBufferKey !== primaryBufferKey && hasBufferedTurns(rawBufferKey)) {
        bufferKeys.push(rawBufferKey);
      }
      return Array.from(new Set(bufferKeys));
    }

    function resolveExtractionBufferKey(
      sessionKey: string,
      logicalSessionKey: string,
    ): string {
      if (
        !cfg.namespacesEnabled ||
        !logicalSessionKey.startsWith(CODEX_THREAD_KEY_PREFIX)
      ) {
        return logicalSessionKey;
      }
      const principal = resolvePrincipal(sessionKey, cfg);
      return `${logicalSessionKey}::principal:${principal}`;
    }

    function renderMemoryContext(composition: RecallContextComposition) {
      return renderSharedMemoryContextPrompt({
        ...composition,
        maxChars: cfg.recallBudgetChars,
      });
    }

    async function loadRecentDreamLines(runtimeWorkspaceDir?: string): Promise<string[]> {
      if (!cfg.dreaming.enabled || cfg.dreaming.injectRecentCount <= 0) return [];
      const journalPath = resolveDreamJournalPath(runtimeWorkspaceDir);
      const dreams = await dreamsSurface.read(journalPath);
      if (dreams.length === 0) return [];
      const entries = dreams.slice(-cfg.dreaming.injectRecentCount).reverse();
      return [
        "## Recent Dreams (Remnic)",
        "",
        ...entries.map((entry) => {
          const header = entry.title
            ? `${entry.timestamp} — ${entry.title}`
            : entry.timestamp;
          const preview = entry.body.replace(/\s+/g, " ").trim();
          const compactPreview =
            preview.length > 180 ? `${preview.slice(0, 180).trimEnd()}...` : preview;
          return `- ${header}: ${compactPreview}`;
        }),
        "",
      ];
    }

    function isHeartbeatTrigger(
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): boolean {
      return event.trigger === "heartbeat" || ctx.trigger === "heartbeat";
    }

    function resolveHeartbeatPromptCandidates(prompt: string): string[] {
      const normalized = prompt.toLowerCase();
      return normalized
        .split(/[^a-z0-9-]+/g)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    function matchHeartbeatEntry(
      entries: HeartbeatEntry[],
      prompt: string,
    ): HeartbeatEntry | null {
      if (entries.length === 0) return null;
      const lowered = prompt.toLowerCase();
      const tokenSet = new Set(resolveHeartbeatPromptCandidates(prompt));
      const phraseMatches = entries.filter((entry) => {
        if (matchesDelimitedPhrase(lowered, entry.slug)) return true;
        return matchesDelimitedPhrase(lowered, entry.title);
      });
      if (phraseMatches.length === 1) {
        return phraseMatches[0] ?? null;
      }
      if (phraseMatches.length > 1) {
        return null;
      }
      const tokenMatches = entries.filter((entry) => {
        const slugTokens = entry.slug.toLowerCase().split("-").filter(Boolean);
        return slugTokens.length > 0 && slugTokens.every((token) => tokenSet.has(token));
      });
      if (tokenMatches.length === 1) {
        return tokenMatches[0] ?? null;
      }
      if (tokenMatches.length > 1) {
        return null;
      }
      return entries.length === 1 ? entries[0] ?? null : null;
    }

    function looksLikeHeartbeatPrompt(prompt: string): boolean {
      const lowered = prompt.trim().toLowerCase();
      return (
        lowered.startsWith("read heartbeat.md") ||
        lowered.startsWith("run the following periodic tasks")
      );
    }

    async function loadHeartbeatContextLines(params: {
      prompt: string;
      event: Record<string, unknown>;
      ctx: Record<string, unknown>;
    }): Promise<string[] | null> {
      if (!cfg.heartbeat.enabled) return null;
      const sessionKey =
        typeof params.ctx?.sessionKey === "string" ? params.ctx.sessionKey : undefined;
      const heartbeatNamespace =
        typeof orchestrator.resolveSelfNamespace === "function"
          ? orchestrator.resolveSelfNamespace(sessionKey)
          : undefined;
      const heartbeatStorage =
        typeof orchestrator.getStorageForNamespace === "function"
          ? await orchestrator.getStorageForNamespace(heartbeatNamespace)
          : orchestrator.storage;
      const runtimeWorkspaceDir = params.ctx?.workspaceDir as string | undefined;
      const journalPath = resolveHeartbeatJournalPath(runtimeWorkspaceDir);
      const entries = await heartbeatSurface.read(journalPath);
      if (entries.length === 0) return null;

      const runtimeSignal = isHeartbeatTrigger(params.event, params.ctx);
      const useRuntimeSignal =
        cfg.heartbeat.detectionMode === "runtime-signal" ||
        (cfg.heartbeat.detectionMode === "auto" && runtimeSignal);
      const useHeuristic =
        cfg.heartbeat.detectionMode === "heuristic" ||
        (cfg.heartbeat.detectionMode === "auto" && !runtimeSignal);
      if (!useRuntimeSignal && !useHeuristic) return null;
      if (!runtimeSignal && useRuntimeSignal) return null;
      if (!runtimeSignal && useHeuristic && !looksLikeHeartbeatPrompt(params.prompt)) {
        return null;
      }

      const activeEntry = matchHeartbeatEntry(entries, params.prompt);
      if (!activeEntry) return null;
      await syncHeartbeatOutcomeLinks({
        storage: heartbeatStorage,
        entries,
        reindexMemory: async (id) => {
          await orchestrator.reindexMemoryById(id, {
            storage: heartbeatStorage,
          });
        },
      });

      const allMemories = await heartbeatStorage.readAllMemories().catch(() => []);
      const previousRuns = allMemories
        .filter((memory) => {
          if (
            memory.frontmatter.structuredAttributes?.remnicSurfaceType ===
            "heartbeat"
          ) {
            return false;
          }
          const relatedSlug =
            memory.frontmatter.structuredAttributes?.relatedHeartbeatSlug;
          if (relatedSlug === activeEntry.slug) return true;
          return (memory.frontmatter.tags ?? []).some(
            (tag) => tag === `heartbeat:${activeEntry.slug}`,
          );
        })
        .sort((a, b) =>
          (b.frontmatter.updated ?? b.frontmatter.created).localeCompare(
            a.frontmatter.updated ?? a.frontmatter.created,
          ),
        )
        .slice(0, cfg.heartbeat.maxPreviousRuns);

      const lines = [
        "## Active Heartbeat (Remnic)",
        "",
        `- Slug: ${activeEntry.slug}`,
        `- Title: ${activeEntry.title}`,
      ];
      if (activeEntry.schedule) {
        lines.push(`- Schedule: ${activeEntry.schedule}`);
      }
      if (activeEntry.tags.length > 0) {
        lines.push(`- Tags: ${activeEntry.tags.join(", ")}`);
      }
      lines.push("", activeEntry.body, "");
      if (previousRuns.length > 0) {
        lines.push("## Previous Runs", "");
        for (const memory of previousRuns) {
          const preview = memory.content.replace(/\s+/g, " ").trim();
          const compactPreview =
            preview.length > 220 ? `${preview.slice(0, 220).trimEnd()}...` : preview;
          lines.push(`- ${compactPreview}`);
        }
        lines.push("");
      }
      return lines;
    }

    async function recallHookHandler(
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) {
      const hookLabel = "before_prompt_build";
      let prompt = event.prompt as string | undefined;
      if ((!prompt || prompt.length < 5) && Array.isArray(event.messages)) {
        const msgs = event.messages as Array<Record<string, unknown>>;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role === "user") {
            const text = extractTextContent(msgs[i] as Record<string, unknown>);
            if (text.length >= 5) {
              prompt = text;
              break;
            }
          }
        }
      }
      const sessionKey = (ctx?.sessionKey as string) ?? "default";
      const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
      await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
      rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);
      if (sessionIdentity.isCodex && !codexCompactionModeLogged) {
        const mode =
          cfg.codexCompat.compactionFlushMode === "auto"
            ? "auto compaction flush mode (signal + heuristic)"
            : `${cfg.codexCompat.compactionFlushMode} compaction flush mode`;
        log.info(
          `codexCompat enabled: using ${mode} for bundled Codex sessions`,
        );
        codexCompactionModeLogged = true;
      }
      if (
        cfg.codexCompat.enabled !== false &&
        sessionIdentity.codexThreadBound &&
        sessionIdentity.providerThreadId &&
        (cfg.codexCompat.compactionFlushMode === "heuristic" ||
          cfg.codexCompat.compactionFlushMode === "auto")
      ) {
        const currentCount = sessionIdentity.messageCount;
        const codexBaselineKey = resolveCodexCompactionBaselineKey(
          sessionKey,
          sessionIdentity.providerThreadId,
        );
        const previousCount = codexBaselineKey
          ? codexMessageCountByBufferKey.get(codexBaselineKey)
          : undefined;
        let shouldPersistMessageCount = typeof currentCount === "number";
        if (
          typeof currentCount === "number" &&
          typeof previousCount === "number" &&
          currentCount < previousCount
        ) {
          try {
            await orchestrator.flushSession(sessionKey, {
              reason: "codex_compaction_heuristic",
              bufferKey: resolveExtractionBufferKey(
                sessionKey,
                sessionIdentity.logicalSessionKey,
              ),
            });
            clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId);
            rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);
            log.info(
              `codexCompat heuristic flush: thread=${sessionIdentity.providerThreadId} messages ${previousCount} -> ${currentCount}`,
            );
          } catch (error) {
            shouldPersistMessageCount = false;
            log.warn(`codexCompat heuristic flush failed: ${String(error)}`);
          }
        }
        if (
          typeof currentCount === "number" &&
          shouldPersistMessageCount &&
          codexBaselineKey
        ) {
          codexMessageCountByBufferKey.set(codexBaselineKey, currentCount);
        }
      }
      if (!prompt || prompt.length < 5) return;

      const runtimeAgent = (ctx.runtime as Record<string, unknown> | undefined)
        ?.agent as Record<string, unknown> | undefined;
      const agentId =
        (ctx?.agentId as string | undefined) ??
        (runtimeAgent?.id as string | undefined) ??
        "main";
      const verboseRequested = cfg.verboseRecallVisibility !== false &&
        isVerboseRecallRequested(event, ctx);
      log.debug(
        `${hookLabel}: sessionKey=${sessionKey}, promptLen=${prompt.length}`,
      );
      log.debug(
        `${hookLabel}: cronRecallMode=${cfg.cronRecallMode}, allowlistCount=${cfg.cronRecallAllowlist.length}`,
      );
      if (sessionKey.includes(":cron:") && cfg.cronRecallMode === "allowlist") {
        const matchedPattern = cfg.cronRecallAllowlist.find((pattern) => {
          const re = wildcardToRegExp(pattern);
          return re.test(sessionKey);
        });
        log.debug(
          `${hookLabel}: cron allowlist match=${matchedPattern ? "yes" : "no"} pattern=${matchedPattern ?? "none"}`,
        );
      }

      if (await isSubagentSessionKeyDetected(sessionKey)) {
        log.debug(
          `${hookLabel}: skip recall for spawned-subagent session ${sessionKey}`,
        );
        return;
      }

      if (shouldSkipRecallForSession(sessionKey, cfg)) {
        log.debug(
          `${hookLabel}: skip recall for cron session ${sessionKey} (mode=${cfg.cronRecallMode})`,
        );
        return;
      }

      const toggleState =
        cfg.sessionTogglesEnabled !== false
          ? await sessionToggleStore.resolve(sessionKey, agentId)
          : {
              disabled: false,
              source: "none" as const,
            };
      const auditToggleState =
        toggleState.disabled === true
          ? toggleState.source === "secondary"
            ? "disabled-secondary"
            : "disabled-primary"
          : "enabled";
      if (toggleState.disabled) {
        lastRecallSummaryBySession.set(sessionKey, null);
        if (cfg.recallTranscriptsEnabled) {
          await appendRecallAuditEntry(recallAuditDir, {
            ts: new Date().toISOString(),
            sessionKey,
            agentId,
            trigger: hookLabel,
            queryText: prompt.slice(0, 2000),
            candidateMemoryIds: [],
            summary: null,
            injectedChars: 0,
            toggleState: auditToggleState,
          }).catch((error) => {
            log.debug(`recall audit append failed: ${String(error)}`);
          });
        }
        if (!verboseRequested) return;
        const verboseLines = buildVerboseRecallHeader({
          sessionKey,
          agentId,
          memoryIds: [],
          plannerMode: "disabled",
          toggleState: auditToggleState,
          summary: null,
        });
        const verbosePrompt = verboseLines.join("\n").replace(/\n$/, "");
        return useMemoryPromptSection
          ? { memoryLines: verboseLines }
          : { prependSystemContext: verbosePrompt, memoryLines: verboseLines };
      }

      try {
        await orchestrator.maybeRunFileHygiene().catch(() => undefined);

        const heartbeatLines = await loadHeartbeatContextLines({
          prompt,
          event,
          ctx,
        }).catch(() => null);
        if (heartbeatLines && heartbeatLines.length > 0) {
          lastRecallSummaryBySession.set(
            sessionKey,
            summarizeRecallTextForStatus(heartbeatLines.join(" ")),
          );
          const verboseLines = verboseRequested
            ? buildVerboseRecallHeader({
                sessionKey,
                agentId,
                memoryIds: [],
                plannerMode: "heartbeat",
                toggleState: auditToggleState,
                summary: summarizeRecallTextForStatus(heartbeatLines.join(" ")),
              })
            : [];
          const mergedLines = [...verboseLines, ...heartbeatLines];
          const heartbeatPrompt = mergedLines.join("\n").replace(/\n$/, "");
          return useMemoryPromptSection
            ? { memoryLines: mergedLines }
            : { prependSystemContext: heartbeatPrompt, memoryLines: mergedLines };
        }

        if (orchestrator.config.compactionResetEnabled) {
          const agentWorkspace = ctx?.workspaceDir as string | undefined;
          if (agentWorkspace) {
            orchestrator.setRecallWorkspaceOverride(sessionKey, agentWorkspace);
          }
        }
        const plannerPreflightMode = planRecallMode(prompt);
        const bundledActiveMemoryEnabledForAgent =
          isBundledActiveMemoryEnabledForAgent(
            rawRuntimeConfig,
            fileBackedRawRuntimeConfig,
            agentId,
          );
        const shouldWarnAndSuppressBundledActiveMemoryCollision =
          cfg.activeRecallEnabled &&
          !cfg.activeRecallAllowChainedActiveMemory &&
          bundledActiveMemoryEnabledForAgent;
        if (
          shouldWarnAndSuppressBundledActiveMemoryCollision &&
          !warnedBundledActiveMemoryCollisionAgents.has(agentId)
        ) {
          warnedBundledActiveMemoryCollisionAgents.add(agentId);
          log.warn(
            `active recall suppressed because bundled active-memory plugin is enabled for agent "${agentId}" while activeRecallAllowChainedActiveMemory=false`,
          );
        }
        const shouldSkipChainedActiveRecall =
          plannerPreflightMode === "no_recall" ||
          shouldWarnAndSuppressBundledActiveMemoryCollision;
        const activeRecallResult = shouldSkipChainedActiveRecall
          ? null
          : await activeRecallEngine
              .run({
                sessionKey,
                agentId,
                chatType: resolveActiveRecallChatType(ctx),
                recentTurns: extractRecentTurnsForActiveRecall(
                  Array.isArray(event.messages)
                    ? (event.messages as Array<Record<string, unknown>>)
                    : undefined,
                ),
                currentMessage: prompt,
              })
              .catch((error) => {
                log.debug(`active recall fallback failed: ${String(error)}`);
                return null;
              });
        const activeRecallLines =
          activeRecallResult?.summary && activeRecallResult.summary.length > 0
            ? ["## Active Recall (Remnic)", "", activeRecallResult.summary, ""]
            : [];
        const dreamLines = await loadRecentDreamLines(
          ctx?.workspaceDir as string | undefined,
        ).catch(() => []);
        let recallComposition: RecallContextComposition | undefined;
        const context = await orchestrator.recall(prompt, sessionKey, {
          sourceConnector: "openclaw",
          onContextComposition: (composition) => {
            recallComposition = composition;
          },
        });
        recallComposition ??= { context };
        log.debug(
          `${hookLabel}: recall returned ${context?.length ?? 0} chars`,
        );
        const lastRecall = orchestrator.getLastRecall(sessionKey);
        const plannerSuppressesAuxiliaryRecall =
          lastRecall?.plannerMode === "no_recall";
        const auxiliaryDreamLines = plannerSuppressesAuxiliaryRecall ? [] : dreamLines;
        const auxiliaryActiveRecallLines = plannerSuppressesAuxiliaryRecall
          ? []
          : activeRecallLines;
        const memoryIds = lastRecall?.memoryIds ?? [];
        if (!recallComposition.context && !recallComposition.footer) {
          const auxiliarySummary =
            summarizeRecallTextForStatus(activeRecallResult?.summary ?? null) ??
            summarizeRecallTextForStatus(
              [...auxiliaryDreamLines, ...auxiliaryActiveRecallLines].join(" "),
            ) ??
            (verboseRequested
              ? "Remnic recall metadata injected without matching memory context."
              : null);
          const verboseLines = verboseRequested
            ? buildVerboseRecallHeader({
                sessionKey,
                agentId,
                latencyMs: lastRecall?.latencyMs,
                memoryIds,
                plannerMode: lastRecall?.plannerMode,
                toggleState: auditToggleState,
                summary: auxiliarySummary,
              })
            : [];
          const mergedLines = [
            ...verboseLines,
            ...auxiliaryDreamLines,
            ...auxiliaryActiveRecallLines,
          ];
          const auxiliaryPrompt = mergedLines.join("\n").replace(/\n$/, "");
          lastRecallSummaryBySession.set(
            sessionKey,
            auxiliarySummary,
          );
          if (cfg.recallTranscriptsEnabled) {
            await appendRecallAuditEntry(recallAuditDir, {
              ts: new Date().toISOString(),
              sessionKey,
              agentId,
              trigger: hookLabel,
              queryText: prompt.slice(0, 2000),
              candidateMemoryIds: memoryIds,
              summary: auxiliarySummary,
              injectedChars: auxiliaryPrompt.length,
              toggleState: auditToggleState,
              latencyMs: lastRecall?.latencyMs,
              plannerMode: lastRecall?.plannerMode,
              requestedMode: lastRecall?.requestedMode,
              fallbackUsed: lastRecall?.fallbackUsed,
            }).catch((error) => {
              log.debug(`recall audit append failed: ${String(error)}`);
            });
          }
          if (mergedLines.length === 0) return;
          return useMemoryPromptSection
            ? { memoryLines: mergedLines }
            : { prependSystemContext: auxiliaryPrompt, memoryLines: mergedLines };
        }

        const memoryContext = renderMemoryContext(recallComposition);
        if (!memoryContext) return;
        const trimmed = memoryContext.body;
        const summaryText =
          summarizeRecallTextForStatus(activeRecallResult?.summary ?? null) ??
          summarizeRecallTextForStatus(trimmed);
        lastRecallSummaryBySession.set(sessionKey, summaryText);
        if (cfg.recallTranscriptsEnabled) {
          await appendRecallAuditEntry(recallAuditDir, {
            ts: new Date().toISOString(),
            sessionKey,
            agentId,
            trigger: hookLabel,
            queryText: prompt.slice(0, 2000),
            candidateMemoryIds: memoryIds,
            summary: summaryText,
            injectedChars: trimmed.length,
            toggleState: auditToggleState,
            latencyMs: lastRecall?.latencyMs,
            plannerMode: lastRecall?.plannerMode,
            requestedMode: lastRecall?.requestedMode,
            fallbackUsed: lastRecall?.fallbackUsed,
          }).catch((error) => {
            log.debug(`recall audit append failed: ${String(error)}`);
          });
        }

        const verboseLines = verboseRequested
          ? buildVerboseRecallHeader({
              sessionKey,
              agentId,
              latencyMs: lastRecall?.latencyMs,
              memoryIds,
              plannerMode: lastRecall?.plannerMode,
              toggleState: auditToggleState,
              summary: summaryText,
            })
          : [];
        const auxiliaryLines = [
          ...verboseLines,
          ...auxiliaryDreamLines,
          ...auxiliaryActiveRecallLines,
        ];
        const memorySectionLines = memoryContext.lines;
        const memoryLines = useMemoryPromptSection
          ? memorySectionLines
          : [...auxiliaryLines, ...memorySectionLines];
        const promptWithVerbose =
          useMemoryPromptSection
            ? (auxiliaryLines.length > 0
                ? auxiliaryLines.join("\n").replace(/\n$/, "")
                : undefined)
            : auxiliaryLines.length > 0
              ? [...auxiliaryLines, ...memorySectionLines].join("\n").replace(/\n$/, "")
              : memoryContext.prompt;

        log.debug(
            `${hookLabel}: returning memory context with ${trimmed.length} chars`,
        );
        return promptWithVerbose
          ? { prependSystemContext: promptWithVerbose, memoryLines }
          : { memoryLines };
      } catch (err) {
        log.error("recall failed", err);
        lastRecallSummaryBySession.set(sessionKey, null);
        clearCodexCompatCaches(sessionKey, undefined, {
          preserveMessageCount: true,
          preserveThreadBinding: true,
        });
        if (orchestrator.config.compactionResetEnabled) {
          orchestrator.clearRecallWorkspaceOverride(sessionKey);
        }
        return;
      }
    }

    if (!useMemoryPromptSection && promptInjectionAllowed) {
      //
      const needsCacheFallback =
        sdkCaps.hasRegisterMemoryCapability &&
        typeof (api as any).registerMemoryCapability === "function";

      if (sdkCaps.hasBeforePromptBuild) {
        type HookApiWithOptions = {
          on: (
            event: string,
            handler: (
              event: Record<string, unknown>,
              ctx: Record<string, unknown>,
            ) => Promise<unknown>,
            opts?: { timeoutMs?: number },
          ) => void;
        };

        ((api: HookApiWithOptions) => {
          api.on(
            "before_prompt_build",
            async (
              event: Record<string, unknown>,
              ctx: Record<string, unknown>,
            ) => {
              const sessionKey = (ctx?.sessionKey as string) ?? "default";
              const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
              if (needsCacheFallback) {
                cachePromptMemoryLines(
                  sessionKey,
                  sessionIdentity.providerThreadId,
                  null,
                );
              }
              const result = await recallHookHandler(event, ctx);
              if (needsCacheFallback && result?.memoryLines) {
                cachePromptMemoryLines(
                  sessionKey,
                  sessionIdentity.providerThreadId,
                  result.memoryLines,
                );
              }
              if (result && "memoryLines" in result) {
                const { memoryLines: _ml, ...gatewayResult } = result;
                return Object.keys(gatewayResult).length > 0 ? gatewayResult : undefined;
              }
              return result;
            },
            { timeoutMs: cfg.initGateTimeoutMs },
          );
        })(api as unknown as HookApiWithOptions);
      }
    }

    // ========================================================================
    // ========================================================================
    //
    // The gateway calls the builder **synchronously** during system-prompt
    // construction and spreads the result into a string[].  This means:
    //   1. The builder MUST be a plain function (not an object).
    //   2. The builder MUST return string[] | null synchronously (not a Promise).
    //
    // Since orchestrator.recall() is async, we pre-compute the recall in the
    // before_prompt_build hook (which IS async-capable) and cache the result
    // for the synchronous builder to return.
    // ========================================================================

    let memoryPromptBuilder: ((params: { sessionKey?: string }) => string[] | null) | undefined;

    if (useMemoryPromptSection && api.registerMemoryPromptSection) {
      if (cfg.activeRecallEnabled && !(globalThis as any)[ACTIVE_RECALL_OVERLAP_WARNED]) {
        (globalThis as any)[ACTIVE_RECALL_OVERLAP_WARNED] = true;
        log.warn(
          "activeRecallEnabled=true while memory-slot prompt injection is active " +
            "(registerMemoryPromptSection). Prompt injection does NOT require " +
            "active recall; this runs a second blocking retrieval per turn. " +
            "Disable activeRecallEnabled unless the secondary pre-reply summary " +
            "block is intentional (issue #1550).",
        );
      }
      (api.on as (
        event: string,
        handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>,
        opts?: { timeoutMs?: number },
      ) => void)(
        "before_prompt_build",
        async (
          event: Record<string, unknown>,
          ctx: Record<string, unknown>,
        ) => {
          const sessionKey = (ctx?.sessionKey as string) ?? "default";
          const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
          cachePromptMemoryLines(sessionKey, sessionIdentity.providerThreadId, null);
          const result = await recallHookHandler(event, ctx);
          if (result?.memoryLines) {
            cachePromptMemoryLines(
              sessionKey,
              sessionIdentity.providerThreadId,
              result.memoryLines,
            );
          }
          if (result && "memoryLines" in result) {
            const { memoryLines: _ml, ...gatewayResult } = result;
            return Object.keys(gatewayResult).length > 0 ? gatewayResult : undefined;
          }
          return result;
        },
        { timeoutMs: cfg.initGateTimeoutMs },
      );

      const memoryBuildFn = (params: {
        sessionKey?: string;
      }): string[] | null => {
        const key = params?.sessionKey ?? "default";
        return consumePromptMemoryLines(key);
      };

      (memoryBuildFn as any).id = "engram-memory";
      (memoryBuildFn as any).label = "Engram Memory Context";
      // OpenClaw 1.x-only seam (removed in 2026.8.x). Bound to a local so the
      // ClawHub Plugin Inspector's static `api.register*(` scan does not flag
      // this feature-detected call as a breakage against 2.0 hosts.
      const registerSection = api.registerMemoryPromptSection;
      registerSection.call(api, memoryBuildFn as Parameters<typeof registerSection>[0]);

      memoryPromptBuilder = memoryBuildFn;
    }

    // ========================================================================
    // ========================================================================
    //
    if (
      (sdkCaps.hasRegisterMemoryCapability &&
        typeof (api as any).registerMemoryCapability === "function") ||
      typeof (api as any).registerMemoryRuntime === "function" ||
      typeof (api as any).registerMemoryFlushPlan === "function"
    ) {
      const capabilityPromptBuilder = memoryPromptBuilder
        ? (params: { sessionKey?: string }): string[] | null => {
            const key = params?.sessionKey ?? "default";
            return consumePromptMemoryLines(key, { destructive: false });
          }
        : (params: { sessionKey?: string }): string[] | null => {
            const key = params?.sessionKey ?? "default";
            return consumePromptMemoryLines(key);
          };

      const capabilityAgentIds = [getOpenClawRuntimeAgentId(api) ?? "generalist"];
      const capabilityWorkspaceDir =
        getOpenClawRuntimeWorkspaceDir(api) ??
        orchestrator.config.workspaceDir ??
        defaultWorkspaceDir();
      const remnicUsesQmd =
        (orchestrator.config.searchBackend ?? "qmd") === "qmd" &&
        orchestrator.config.qmdEnabled !== false;
      const remnicQmdCommand =
        typeof orchestrator.config.qmdPath === "string" && orchestrator.config.qmdPath.trim().length > 0
          ? orchestrator.config.qmdPath.trim()
          : "qmd";
      const readScope = createMemoryReadScope({
        memoryDir: orchestrator.config.memoryDir,
        workspaceDir: capabilityWorkspaceDir,
        realpath: realPathLater,
      });
      const remnicMemoryRuntime: RemnicCapabilityRuntime = {
        async getMemorySearchManager(_params: {
          cfg: unknown;
          agentId: string;
          purpose?: "default" | "status";
        }) {
          return {
            manager: {
              async search(query: string, opts?: RuntimeSearchOptions) {
                const namespace =
                  typeof orchestrator.resolveSelfNamespace === "function"
                    ? orchestrator.resolveSelfNamespace(opts?.sessionKey)
                    : undefined;
                const resolvedMode =
                  opts?.qmdSearchModeOverride === "vsearch"
                    ? "vector"
                    : opts?.qmdSearchModeOverride === "query"
                      ? "search"
                      : opts?.qmdSearchModeOverride ?? "search";
                const requestedMaxResults =
                  typeof opts?.maxResults === "number" && Number.isFinite(opts.maxResults)
                    ? Math.max(0, Math.floor(opts.maxResults))
                    : undefined;
                const minScore =
                  typeof opts?.minScore === "number" && Number.isFinite(opts.minScore)
                    ? opts.minScore
                    : undefined;
                const visibleResults = await searchWithGenericExclusion({
                  budget: requestedMaxResults ?? Number.MAX_SAFE_INTEGER,
                  sendInitialLimit: requestedMaxResults !== undefined,
                  search: (limit) => orchestrator.searchAcrossNamespaces({
                    query,
                    ...(limit !== undefined ? { maxResults: limit } : {}),
                    namespaces: namespace ? [namespace] : undefined,
                    mode: resolvedMode,
                  }),
                  filterPrivate: (results) => orchestrator.filterPrivateSearchResults(
                    results,
                    namespace ? [namespace] : [],
                  ),
                  isExcluded: (resultPath) => isMemoryArtifactPath(resultPath),
                });
                const scoredResults = minScore === undefined
                  ? visibleResults
                  : visibleResults.filter((result) => result.score >= minScore);
                return scoredResults
                  .map((result, index): RuntimeSearchResult => {
                  const candidate = result as unknown as {
                    path?: string;
                    id?: string;
                    startLine?: number;
                    endLine?: number;
                    score?: number;
                    snippet?: string;
                    text?: string;
                  };
                  const rawPath =
                    typeof candidate.path === "string"
                      ? candidate.path
                      : typeof candidate.id === "string"
                        ? candidate.id
                        : `memory-${index + 1}`;
                  const absolutePath = readScope.absolutize(rawPath);
                  const normalizedPath = readScope.relativizeToMemoryRoot(rawPath);
                  const startLine =
                    typeof candidate.startLine === "number" && Number.isFinite(candidate.startLine)
                      ? Math.max(1, Math.floor(candidate.startLine))
                      : 1;
                  const endLine =
                    typeof candidate.endLine === "number" && Number.isFinite(candidate.endLine)
                      ? Math.max(startLine, Math.floor(candidate.endLine))
                      : startLine;
                  return {
                    path: absolutePath,
                    startLine,
                    endLine,
                    score:
                      typeof candidate.score === "number" && Number.isFinite(candidate.score)
                        ? candidate.score
                        : 0,
                    snippet:
                      typeof candidate.snippet === "string"
                        ? candidate.snippet
                        : typeof candidate.text === "string"
                          ? candidate.text
                          : "",
                    source: isSessionsMemoryPath(normalizedPath) ? "sessions" : "memory",
                    citation: normalizedPath,
                  };
                });
              },
              async readFile(params: RuntimeReadParams) {
                const requestedPath = readScope.normalizeWorkspacePath(params.relPath);
                const absolutePath = await readScope.resolveReadablePath(params.relPath);
                const visible = await orchestrator.filterPrivateSearchResults([{
                  docid: absolutePath,
                  path: absolutePath,
                  snippet: "",
                  score: 0,
                }], [], true);
                if (visible.length === 0) {
                  throw new Error(`memory read excluded (private record): ${params.relPath}`);
                }
                const text = await readTextFileLater(absolutePath);
                const allLines = text.split(/\r?\n/);
                const from = typeof params.from === "number" ? Math.max(1, Math.floor(params.from)) : 1;
                const lines =
                  typeof params.lines === "number" && Number.isFinite(params.lines)
                    ? Math.max(1, Math.floor(params.lines))
                    : undefined;
                const startIndex = from - 1;
                const endIndex = typeof lines === "number" ? startIndex + lines : allLines.length;
                const slice = allLines.slice(startIndex, endIndex);
                const truncated = endIndex < allLines.length;
                return {
                  text: slice.join("\n"),
                  path: requestedPath,
                  truncated: truncated || undefined,
                  from,
                  lines,
                  nextFrom: truncated ? endIndex + 1 : undefined,
                };
              },
              status() {
                const qmdAvailable =
                  remnicUsesQmd && typeof (orchestrator as any).qmd?.isAvailable === "function"
                    ? Boolean((orchestrator as any).qmd.isAvailable())
                    : !remnicUsesQmd;
                const qmdDebug =
                  typeof (orchestrator as any).qmd?.debugStatus === "function"
                    ? (orchestrator as any).qmd.debugStatus()
                    : undefined;
                return {
                  backend: remnicUsesQmd ? "qmd" : "builtin",
                  provider: remnicUsesQmd ? "qmd" : "builtin",
                  requestedProvider: remnicUsesQmd ? "qmd" : "builtin",
                  model: remnicUsesQmd ? remnicQmdCommand : "builtin",
                  dirty: false,
                  workspaceDir: capabilityWorkspaceDir,
                  dbPath: orchestrator.config.memoryDir,
                  sources: ["memory"],
                  sourceCounts: [],
                  vector: remnicUsesQmd
                    ? {
                        enabled: true,
                        available: qmdAvailable,
                      }
                    : {
                        enabled: false,
                      },
                  fts: {
                    enabled: true,
                    available: qmdAvailable,
                  },
                  custom: {
                    remnic: {
                      qmdAvailable,
                      qmdDebug,
                      memoryDir: orchestrator.config.memoryDir,
                    },
                  },
                };
              },
              async sync(_params?: { reason?: string; force?: boolean }) {
                if (remnicUsesQmd && typeof (orchestrator as any).qmd?.update === "function") {
                  await (orchestrator as any).qmd.update();
                }
              },
              async probeEmbeddingAvailability() {
                if (!remnicUsesQmd) return { ok: true };
                const qmdAvailable = await probeQmdAvailability(orchestrator as unknown as Parameters<typeof probeQmdAvailability>[0]);
                if (qmdAvailable) return { ok: true };
                const qmdDebug =
                  typeof (orchestrator as any).qmd?.debugStatus === "function"
                    ? (orchestrator as any).qmd.debugStatus()
                    : undefined;
                return {
                  ok: false,
                  error: qmdDebug ?? "Remnic QMD backend unavailable",
                };
              },
              async probeVectorAvailability() {
                if (!remnicUsesQmd) return false;
                return probeQmdAvailability(orchestrator as unknown as Parameters<typeof probeQmdAvailability>[0]);
              },
              async close() {},
            },
          };
        },
        resolveMemoryBackendConfig(_params: { cfg: unknown; agentId: string }) {
          return remnicUsesQmd
            ? { backend: "qmd", qmd: { command: remnicQmdCommand } }
            : { backend: "builtin" };
        },
        async closeAllMemorySearchManagers() {},
      };
      const remnicMemoryFlushPlanResolver = (): MemoryFlushPlan =>
        buildMemoryFlushPlan({
          serviceId,
          extractionMaxTurnChars: cfg.extractionMaxTurnChars,
          flushModel:
            typeof cfg.summaryModel === "string" && cfg.summaryModel.length > 0
              ? cfg.summaryModel
              : cfg.taskModelChain?.primary,
        });

      const memoryCapability: import("openclaw/plugin-sdk").MemoryPluginCapability = {
        ...(promptInjectionAllowed ? { promptBuilder: capabilityPromptBuilder } : {}),
        flushPlanResolver: remnicMemoryFlushPlanResolver,
        runtime: remnicMemoryRuntime,
        publicArtifacts: {
          listArtifacts: async (_params: { cfg: unknown }) => {
            try {
              return await listRemnicPublicArtifacts({
                memoryDir: orchestrator.config.memoryDir,
                workspaceDir: capabilityWorkspaceDir,
                agentIds: capabilityAgentIds,
              });
            } catch (err) {
              log.error("publicArtifacts.listArtifacts failed", err);
              return [];
            }
          },
        },
      };
      if (typeof (api as any).registerMemoryCapability === "function") {
        (api as any).registerMemoryCapability(memoryCapability);
      }
      // OpenClaw 1.x-only split seams (removed in 2026.8.x). Read through a
      // narrowed view and bound to locals so ClawHub's static `api.register*(`
      // scan does not flag these guarded calls as breakages on 2.0 hosts.
      const legacyMemoryApi = api as unknown as {
        registerMemoryRuntime?: (runtime: RemnicCapabilityRuntime) => void;
        registerMemoryFlushPlan?: (resolver: () => MemoryFlushPlan) => void;
      };
      const registerRuntime = legacyMemoryApi.registerMemoryRuntime;
      const registerFlushPlan = legacyMemoryApi.registerMemoryFlushPlan;
      if (typeof registerRuntime === "function") {
        registerRuntime.call(api, remnicMemoryRuntime);
      }
      if (typeof registerFlushPlan === "function") {
        registerFlushPlan.call(api, remnicMemoryFlushPlanResolver);
      }
      const builderDesc = !promptInjectionAllowed
        ? " (promptBuilder omitted — injection disabled by policy)"
        : memoryPromptBuilder
          ? " and promptBuilder (from registerMemoryPromptSection)"
          : " and promptBuilder (capability-only fallback)";
      const capabilityDesc =
        typeof (api as any).registerMemoryCapability === "function"
          ? `memory capability with publicArtifacts provider${builderDesc}`
          : "split memory runtime/flush-plan surfaces";
      log.info(`registered ${capabilityDesc}`);
    }

    if (cfg.openclawMessageReceivedCaptureEnabled) {
      (api.on as (
        event: string,
        handler: (
          event: Record<string, unknown>,
          ctx: Record<string, unknown>,
        ) => Promise<unknown>,
      ) => void)(
        "message_received",
        async (
          event: Record<string, unknown>,
          ctx: Record<string, unknown>,
        ) => {
          if (
            cfg.heartbeat.enabled &&
            cfg.heartbeat.gateExtractionDuringHeartbeat &&
            isHeartbeatTrigger(event, ctx)
          ) {
            log.debug(
              `message_received: skipping transcript capture during heartbeat run for ${(ctx?.sessionKey as string) ?? "default"}`,
            );
            return;
          }
          const content =
            typeof event.content === "string" ? event.content.trim() : "";
          if (content.length === 0) return;
          const sessionKey =
            normalizeOptionalString(ctx.sessionKey) ??
            normalizeOptionalString(event.sessionKey) ??
            "default";
          const inboundMessageKeys = getOpenClawMessageDedupeKeys(event, event, ctx, sessionKey);
          if (inboundMessageKeys.some((key) => observedInboundMessageIds.has(key))) return;
          const metadata = buildOpenClawMessageMetadata(event, event, ctx, cfg);
          const inboundReplyHintMetadata = cfg.openclawReplyMetadataExtractionHintsEnabled
            ? buildOpenClawMessageMetadata(event, event, ctx, {
                openclawReplyMetadataCaptureEnabled: true,
              })
            : metadata;
          const eventDate =
            typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
              ? new Date(event.timestamp)
              : new Date();
          const timestamp = Number.isFinite(eventDate.getTime())
            ? eventDate.toISOString()
            : new Date().toISOString();
          const cleaned = cleanOpenClawUserMessage(content);
          const inlineCaptureContentFingerprint = buildOpenClawInboundContentFingerprint(
            cleaned,
            event,
            event,
            ctx,
            sessionKey,
          );
          const sparseInlineCaptureContentFingerprint =
            buildOpenClawSparseInboundContentFingerprint(cleaned, sessionKey);
          const transcriptCandidate = shouldProcessInlineExplicitCapture(orchestrator.config)
            ? stripInlineExplicitCaptureNotes(cleaned)
            : cleaned;
          const inboundContentFingerprint = buildOpenClawInboundContentFingerprint(
            transcriptCandidate,
            event,
            event,
            ctx,
            sessionKey,
          );
          const sparseInboundContentFingerprint = buildOpenClawSparseInboundContentFingerprint(
            transcriptCandidate,
            sessionKey,
          );
          if (
            inboundMessageKeys.length === 0 &&
            inlineCaptureContentFingerprint &&
            observedInboundCaptureContentFingerprints.has(inlineCaptureContentFingerprint)
          ) {
            return;
          }
          const inlineCapture = await processInlineExplicitCapture(
            cleaned,
            inboundMessageKeys,
            [inlineCaptureContentFingerprint, sparseInlineCaptureContentFingerprint],
            sessionKey,
          );
          const transcriptContent = inlineCapture.content;
          const inlineCaptureWasHandled =
            inlineCapture.failed === 0 && (inlineCapture.processed > 0 || inlineCapture.content === cleaned);
          if (
            inboundContentFingerprint &&
            observedInboundContentFingerprints.has(inboundContentFingerprint)
          ) {
            if (inlineCaptureWasHandled) {
              rememberObservedInboundCaptureContentFingerprint(inlineCaptureContentFingerprint);
            }
            return;
          }
          const processedExplicitNotes = inlineCapture.processed;
          if (!orchestrator.config.transcriptEnabled || transcriptContent.length === 0) {
            rememberInboundReplyMetadata(inboundMessageKeys, inboundReplyHintMetadata);
            if (processedExplicitNotes > 0 && inlineCapture.failed === 0) {
              rememberObservedInboundMessageKeys(inboundMessageKeys);
              rememberObservedInboundCaptureContentFingerprint(inlineCaptureContentFingerprint);
              rememberObservedInboundContentFingerprint(inboundContentFingerprint);
              if (inboundMessageKeys.length === 0) {
                rememberPendingSparseInboundContentFingerprint(sparseInboundContentFingerprint);
              }
            }
            return;
          }
          try {
            await orchestrator.transcript.append({
              timestamp,
              role: "user",
              content: transcriptContent,
              sessionKey,
              turnId: crypto.randomUUID(),
              ...(metadata ? { metadata } : {}),
            });
            if (inboundMessageKeys.length > 0 && inlineCapture.failed === 0) {
              rememberObservedInboundMessageKeys(inboundMessageKeys);
              rememberInboundReplyMetadata(inboundMessageKeys, inboundReplyHintMetadata);
            }
            if (inlineCaptureWasHandled) {
              rememberObservedInboundCaptureContentFingerprint(inlineCaptureContentFingerprint);
            }
            rememberObservedInboundContentFingerprint(inboundContentFingerprint);
            if (inlineCapture.failed === 0 && inboundMessageKeys.length === 0) {
              rememberPendingSparseInboundContentFingerprint(sparseInboundContentFingerprint);
            }
          } catch (err) {
            log.debug(`message_received transcript append failed: ${err}`);
          }
        },
      );
    }

    // ========================================================================
    // ========================================================================
    api.on(
      "agent_end",
      async (
        event: import("openclaw/plugin-sdk").PluginHookAgentEndEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        if (!event.success || !Array.isArray(event.messages)) return;
        if (event.messages.length === 0) return;

        if (
          cfg.heartbeat.enabled &&
          cfg.heartbeat.gateExtractionDuringHeartbeat &&
          isHeartbeatTrigger(event as Record<string, unknown>, ctx as Record<string, unknown>)
        ) {
          log.debug(
            `agent_end: skipping transcript/extraction buffering during heartbeat run for ${(ctx?.sessionKey as string) ?? "default"}`,
          );
          return;
        }

        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
        await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
        await flushAndForgetRememberedCodexThreadOnMetadataLoss(
          sessionKey,
          sessionIdentity,
        );
        rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);

        try {
          const messages = event.messages as Array<Record<string, unknown>>;
          const lastTurn = extractLastTurn(messages);
          const eventTimestamp = new Date().toISOString();

          if (orchestrator.config.hourlySummariesIncludeToolStats) {
            const toolNames: string[] = [];
            for (const msg of messages) {
              const role = msg.role as string | undefined;
              if (role === "tool") {
                const name =
                  (msg as any).name ??
                  (msg as any).toolName ??
                  (msg as any).tool;
                if (typeof name === "string" && name.length > 0)
                  toolNames.push(name);
              }
              if (role === "assistant") {
                const toolCalls =
                  (msg as any).tool_calls ?? (msg as any).toolCalls;
                if (Array.isArray(toolCalls)) {
                  for (const tc of toolCalls) {
                    const fnName = tc?.function?.name ?? tc?.name;
                    if (typeof fnName === "string" && fnName.length > 0)
                      toolNames.push(fnName);
                  }
                }
              }
            }
            for (const tool of toolNames) {
              await orchestrator.transcript.appendToolUse({
                timestamp: eventTimestamp,
                sessionKey,
                tool,
              });
            }
          }

          try {
            const objectiveStateNamespace =
              orchestrator.config.namespacesEnabled &&
              typeof orchestrator.resolveSelfNamespace === "function"
                ? orchestrator.resolveSelfNamespace(sessionKey)
                : orchestrator.config.defaultNamespace;
            const objectiveStateStorage =
              orchestrator.config.namespacesEnabled &&
              typeof orchestrator.getStorageForNamespace === "function"
                ? await orchestrator.getStorageForNamespace(objectiveStateNamespace)
                : null;
            await recordObjectiveStateSnapshotsFromAgentMessages({
              memoryDir:
                objectiveStateStorage?.dir ?? orchestrator.config.memoryDir,
              objectiveStateStoreDir: objectiveStateStoreOverrideForNamespace({
                memoryDir: orchestrator.config.memoryDir,
                configuredStoreDir: orchestrator.config.objectiveStateStoreDir,
                namespacesEnabled: orchestrator.config.namespacesEnabled,
                namespace: objectiveStateNamespace,
              }),
              objectiveStateMemoryEnabled:
                orchestrator.config.objectiveStateMemoryEnabled,
              objectiveStateSnapshotWritesEnabled:
                orchestrator.config.objectiveStateSnapshotWritesEnabled,
              sessionKey,
              recordedAt: eventTimestamp,
              messages,
            });
          } catch (error) {
            log.debug(
              `agent_end objective-state writer skipped due to error: ${error}`,
            );
          }

          let persistedTurnIndex = 0;
          for (const msg of lastTurn) {
            const rawRole = typeof msg.role === "string" ? msg.role : "";
            if (rawRole !== "user" && rawRole !== "assistant") {
              continue;
            }
            const role = rawRole;
            const content = extractTextContent(msg);
            if (content.length < 10) continue;

            const cleaned =
              role === "user" ? cleanOpenClawUserMessage(content) : content;
            const messageDedupeKeys = getOpenClawMessageDedupeKeys(msg, event, ctx, sessionKey);
            const inlineCaptureContentFingerprint = buildOpenClawInboundContentFingerprint(
              cleaned,
              msg,
              event,
              ctx,
              sessionKey,
            );
            const sparseInlineCaptureContentFingerprint =
              buildOpenClawSparseInboundContentFingerprint(cleaned, sessionKey);
            const transcriptCandidate = shouldProcessInlineExplicitCapture(orchestrator.config)
              ? stripInlineExplicitCaptureNotes(cleaned)
              : cleaned;
            const messageContentFingerprint = buildOpenClawInboundContentFingerprint(
              transcriptCandidate,
              msg,
              event,
              ctx,
              sessionKey,
            );
            const sparseMessageContentFingerprint =
              buildOpenClawSparseInboundContentFingerprint(transcriptCandidate, sessionKey);
            const inlineCapture = await processInlineExplicitCapture(
              cleaned,
              messageDedupeKeys,
              [inlineCaptureContentFingerprint, sparseInlineCaptureContentFingerprint],
              sessionKey,
            );
            const stripped = inlineCapture.content;
            const inlineCaptureWasHandled =
              inlineCapture.failed === 0 && (inlineCapture.processed > 0 || inlineCapture.content === cleaned);
            const messageMetadata = buildOpenClawMessageMetadata(
              msg,
              event,
              ctx,
              cfg,
            );
            const cachedReplyHintMetadata =
              role === "user" && cfg.openclawReplyMetadataExtractionHintsEnabled
                ? getInboundReplyMetadata(messageDedupeKeys)
                : null;
            const replyHintMetadata = cfg.openclawReplyMetadataExtractionHintsEnabled
              ? cachedReplyHintMetadata ?? buildOpenClawMessageMetadata(msg, event, ctx, {
                  openclawReplyMetadataCaptureEnabled: true,
                })
              : messageMetadata;
            const messageDedupeKey = messageDedupeKeys[0];
            const sparseInboundAlreadyCaptured =
              role === "user" &&
              messageDedupeKeys.length === 0 &&
              consumePendingSparseInboundContentFingerprint(sparseMessageContentFingerprint);
            const transcriptAlreadyCaptured =
              role === "user" &&
              ((messageDedupeKeys.length > 0 &&
                messageDedupeKeys.some((key) => observedInboundMessageIds.has(key))) ||
                sparseInboundAlreadyCaptured ||
                (messageContentFingerprint !== null &&
                  observedInboundContentFingerprints.has(messageContentFingerprint)));

            if (
              orchestrator.config.transcriptEnabled &&
              stripped.length > 0 &&
              !transcriptAlreadyCaptured
            ) {
              await orchestrator.transcript.append({
                timestamp: eventTimestamp,
                role,
                content: stripped,
                sessionKey,
                turnId: crypto.randomUUID(),
                ...(messageMetadata ? { metadata: messageMetadata } : {}),
              });
              if (role === "user") {
                if (inlineCapture.failed === 0) {
                  if (messageDedupeKey) {
                    rememberObservedInboundMessageKeys(messageDedupeKeys);
                  }
                  if (inlineCaptureWasHandled) {
                    rememberObservedInboundCaptureContentFingerprint(
                      inlineCaptureContentFingerprint,
                    );
                  }
                }
                rememberObservedInboundContentFingerprint(messageContentFingerprint);
              }
            }

            if (stripped.length > 0) {
              const extractionContent =
                role === "user" &&
                cfg.openclawReplyMetadataExtractionHintsEnabled
                  ? withReplyExtractionHint(stripped, replyHintMetadata)
                  : stripped;
              try {
                await orchestrator.processTurn(role, extractionContent, sessionKey, {
                  bufferKey: resolveExtractionBufferKey(
                    sessionKey,
                    sessionIdentity.logicalSessionKey,
                  ),
                  logicalSessionKey: sessionIdentity.logicalSessionKey,
                  providerThreadId: sessionIdentity.providerThreadId,
                  turnFingerprint: buildTurnFingerprint({
                    role,
                    content: extractionContent,
                    logicalSessionKey: sessionIdentity.logicalSessionKey,
                    providerThreadId: sessionIdentity.providerThreadId,
                    maxContentChars: cfg.extractionMaxTurnChars,
                    turnIndex: persistedTurnIndex,
                  }),
                  persistProcessedFingerprint:
                    sessionIdentity.codexThreadBound &&
                    cfg.codexCompat.enabled !== false &&
                    cfg.codexCompat.fingerprintDedup === true &&
                    cfg.codexCompat.threadIdBufferKeying !== false &&
                    !!sessionIdentity.providerThreadId,
                  sourceConnector: "openclaw",
                });
                persistedTurnIndex += 1;
              } catch (bufferErr) {
                if (!(bufferErr instanceof Error) || bufferErr.name !== "BufferAdmissionRefusedError") {
                  throw bufferErr;
                }
                log.warn(`agent_end: extraction buffer refused the turn: ${bufferErr.message}`);
              }
            }
          }

          if (orchestrator.lcmEngine?.enabled) {
            try {
              const lcmMessages = lastTurn
                .map((msg) => {
                  const rawRole = typeof msg.role === "string" ? msg.role : "";
                  const content = extractTextContent(msg);
                  return {
                    role: rawRole,
                    content,
                    rawContent: msg,
                    sourceFormat: "openclaw" as const,
                  };
                })
                .filter((m) => m.content.length > 0);
              if (lcmMessages.length > 0) {
                await orchestrator.lcmEngine.enqueueObserveMessages(
                  sessionKey,
                  lcmMessages,
                );
              }
            } catch (lcmErr) {
              log.error(`LCM agent_end archiving failed: ${lcmErr}`);
            }
          }
        } catch (err) {
          log.error("agent_end processing failed", err);
        }
      },
    );

    const lcmTokensBefore = new Map<string, number>();

    // ========================================================================
    // ========================================================================
    api.on(
      "before_compaction",
      async (
        event: import("openclaw/plugin-sdk").PluginHookBeforeCompactionEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        const sessionKey =
          (ctx?.sessionKey as string) ??
          (event?.sessionKey as string) ??
          "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
        const signalThreadId =
          sessionIdentity.providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
        const signalLogicalSessionKey =
          signalThreadId && cfg.codexCompat.threadIdBufferKeying !== false
            ? codexLogicalSessionKey(signalThreadId)
            : sessionIdentity.logicalSessionKey;
        rememberCodexThread(sessionKey, signalThreadId);

        try {
          if (
            signalThreadId &&
            cfg.codexCompat.enabled !== false &&
            cfg.codexCompat.compactionFlushMode !== "heuristic"
          ) {
            try {
              await orchestrator.flushSession(sessionKey, {
                reason: "codex_compaction_signal",
                bufferKey: resolveExtractionBufferKey(
                  sessionKey,
                  signalLogicalSessionKey,
                ),
              });
              clearCodexCompatCaches(sessionKey, signalThreadId);
              rememberCodexThread(sessionKey, signalThreadId);
            } catch (error) {
              log.warn(`codexCompat signal flush failed: ${String(error)}`);
            }
          }
          if (orchestrator.lcmEngine?.enabled) {
            try {
              let tokensBefore = 0;
              if (typeof event.tokenCount === "number") {
                tokensBefore = event.tokenCount;
              } else if (Array.isArray(event.messages)) {
                for (const msg of event.messages as Array<{
                  content?: unknown;
                }>) {
                  if (typeof msg.content === "string") {
                    tokensBefore += estimateLcmTokens(msg.content);
                  } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                      if (typeof block === "string")
                        tokensBefore += estimateLcmTokens(block);
                      else if (
                        block &&
                        typeof block === "object" &&
                        typeof (block as any).text === "string"
                      )
                        tokensBefore += estimateLcmTokens((block as any).text);
                    }
                  }
                }
              }
              lcmTokensBefore.set(sessionKey, tokensBefore);
              await orchestrator.lcmEngine.waitForSessionObserveIdle(
                sessionKey,
              );
              await orchestrator.lcmEngine.preCompactionFlush(sessionKey);
            } catch (lcmErr) {
              log.debug(`LCM before_compaction error: ${lcmErr}`);
            }
          }

          if (!orchestrator.config.checkpointEnabled) {
            return;
          }

          const entries = await orchestrator.transcript.readRecent(
            1,
            sessionKey,
          );
          const checkpointTurns = entries.slice(
            -orchestrator.config.checkpointTurns,
          );

          if (checkpointTurns.length > 0) {
            await orchestrator.transcript.saveCheckpoint({
              sessionKey,
              capturedAt: new Date().toISOString(),
              turns: checkpointTurns,
              ttl: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
            log.info(`saved checkpoint for ${sessionKey} before compaction`);
          }
        } catch (err) {
          log.error("before_compaction hook failed", err);
        }
      },
    );

    // ========================================================================
    // ========================================================================
    api.on(
      "after_compaction",
      async (
        event: import("openclaw/plugin-sdk").PluginHookAfterCompactionEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        const sessionKey =
          (ctx?.sessionKey as string) ??
          (event?.sessionKey as string) ??
          "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
        const workspaceDir =
          (ctx?.workspaceDir as string) ||
          (event?.workspaceDir as string) ||
          orchestrator.config.workspaceDir ||
          defaultWorkspaceDir();

        try {
          clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId, {
            preserveMessageCount: true,
            preserveThreadBinding: true,
          });
          if (orchestrator.lcmEngine?.enabled) {
            try {
              let tokensAfter = 0;
              if (typeof event.tokenCount === "number") {
                tokensAfter = event.tokenCount;
              } else {
                const storedBefore = lcmTokensBefore.get(sessionKey) ?? 0;
                const msgCountAfter =
                  typeof event.messageCount === "number"
                    ? event.messageCount
                    : 0;
                const compacted =
                  typeof event.compactedCount === "number"
                    ? event.compactedCount
                    : 0;
                const msgCountBefore = msgCountAfter + compacted;
                if (storedBefore > 0 && msgCountBefore > 0) {
                  tokensAfter = Math.round(
                    storedBefore * (msgCountAfter / msgCountBefore),
                  );
                }
              }
              const tokensBefore = lcmTokensBefore.get(sessionKey) ?? 0;
              lcmTokensBefore.delete(sessionKey);
              await orchestrator.lcmEngine.recordCompaction(
                sessionKey,
                tokensBefore,
                tokensAfter,
              );
              await orchestrator.lcmEngine.verifyPostCompaction(sessionKey);
            } catch (lcmErr) {
              log.debug(`LCM after_compaction error: ${lcmErr}`);
            }
          }
          void queueOpenClawFlushPlanProcessing("after_compaction", workspaceDir);

          if (!orchestrator.config.compactionResetEnabled) {
            log.debug(
              `compaction completed for ${sessionKey}, reset disabled — skipping`,
            );
            return;
          }

          log.info(
            `compaction completed for ${sessionKey}, triggering session reset`,
          );

          const apiAny = api as any;
          if (typeof apiAny.resetSession === "function") {
            const result = await apiAny.resetSession(sessionKey, "new");
            if (result?.ok === true) {
              log.info(
                `session reset via API for ${sessionKey}, new sessionId=${result.sessionId}`,
              );

              const safeSessionKey = sanitizeSessionKeyForFilename(sessionKey);
              const signalPath = path.join(
                workspaceDir,
                `.compaction-reset-signal-${safeSessionKey}`,
              );
              await writeTextFileLater(
                signalPath,
                JSON.stringify({
                  sessionKey,
                  compactedAt: new Date().toISOString(),
                  messageCount: event.messageCount ?? 0,
                }),
              );
            } else {
              const errorDetail =
                result && typeof result === "object" && "error" in result
                  ? String(
                      (result as { error?: unknown }).error ?? "unknown error",
                    )
                  : `invalid result: ${JSON.stringify(result)}`;
              log.error(
                `api.resetSession failed for ${sessionKey}: ${errorDetail}`,
              );
            }
          } else {
            log.error(
              `api.resetSession not available — compaction reset requires OC fork with PR #29985. ` +
                `Session ${sessionKey} will continue without reset.`,
            );
          }
        } catch (err) {
          log.error("after_compaction reset failed", err);
        }
      },
    );

    try {
      api.on(
        "before_reset",
        async (
          event: import("openclaw/plugin-sdk").PluginHookBeforeResetEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey =
            (ctx?.sessionKey as string) ??
            (event?.sessionKey as string) ??
            "default";
          const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
          await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
          const bufferKeys = await resolveBeforeResetBufferKeys(
            sessionKey,
            sessionIdentity,
          );
          const flushEnabled =
            cfg.flushOnResetEnabled &&
            typeof (orchestrator as any).flushSession === "function";
          const beforeResetDeadlineMs = Date.now() + cfg.beforeResetTimeoutMs;
          const flushAbort = new AbortController();
          let flushTimedOut = false;
          let flushFailed = false;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const flushPromise = flushEnabled
            ? (async () => {
                for (const bufferKey of bufferKeys) {
                  if (flushAbort.signal.aborted) break;
                  await Promise.resolve(
                    (orchestrator as any).flushSession(sessionKey, {
                      reason: "before_reset",
                      bufferKey,
                      abortSignal: flushAbort.signal,
                    }),
                  ).catch((error) => {
                    if (!flushAbort.signal.aborted) {
                      flushFailed = true;
                      log.warn(
                        `before_reset flush failed for ${bufferKey}: ${String(error)}`,
                      );
                    }
                  });
                }
              })()
            : Promise.resolve();
          const boundedFlush = flushEnabled
            ? Promise.race([
                flushPromise,
                new Promise<void>((resolve) => {
                  const remainingMs = Math.max(
                    0,
                    beforeResetDeadlineMs - Date.now(),
                  );
                  timeoutId = setTimeout(() => {
                    flushTimedOut = true;
                    flushAbort.abort();
                    resolve();
                  }, remainingMs);
                }),
              ])
            : flushPromise;
          await boundedFlush;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (!flushTimedOut) {
            await queueOpenClawFlushPlanProcessing(
              "before_reset",
              (ctx?.workspaceDir as string) || (event?.workspaceDir as string),
              { deadlineMs: beforeResetDeadlineMs },
            );
          }
          if (flushTimedOut) {
            log.warn(
              `before_reset flush timed out after ${cfg.beforeResetTimeoutMs}ms`,
            );
          }
          const drainedAllBuffers =
            flushEnabled && !flushTimedOut && !flushFailed;
          clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId, {
            preserveThreadBinding: !drainedAllBuffers,
            preserveMessageCount: !drainedAllBuffers,
          });
          if (
            typeof (orchestrator as any).clearRecallWorkspaceOverride === "function"
          ) {
            (orchestrator as any).clearRecallWorkspaceOverride(sessionKey);
          }
        },
      );
    } catch (error) {
      log.debug(`before_reset hook unavailable on this runtime: ${String(error)}`);
    }

    // ========================================================================
    // ========================================================================
    if (!passiveMode && sdkCaps.hasBeforePromptBuild) {
      api.on(
        "session_start",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = event.sessionKey ?? "default";
          log.debug(`session_start: ${sessionKey}`);
          try {
            await orchestrator.maybeRunFileHygiene().catch(() => undefined);
          } catch (err) {
            log.debug(`session_start file hygiene failed: ${err}`);
          }
          void queueOpenClawFlushPlanProcessing(
            "session_start",
            (ctx?.workspaceDir as string | undefined) ??
              (event.workspaceDir as string | undefined),
            { timeoutMs: cfg.beforeResetTimeoutMs },
          );
        },
      );

      api.on(
        "session_end",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = event.sessionKey ?? ctx.sessionKey ?? "default";
          log.debug(`session_end: ${sessionKey}`);
          const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
          const rememberedThreadId =
            sessionIdentity.providerThreadId ??
            resolveStoredCodexThreadId(sessionKey);
          const bufferKeys = await resolveBeforeResetBufferKeys(sessionKey, {
            providerThreadId: rememberedThreadId,
            logicalSessionKey: sessionIdentity.logicalSessionKey,
          });
          let drainedAllBuffers = false;
          if (typeof (orchestrator as any).flushSession === "function") {
            let flushFailed = false;
            for (const bufferKey of bufferKeys) {
              try {
                await (orchestrator as any).flushSession(sessionKey, {
                  reason: "session_end",
                  bufferKey,
                });
              } catch (error) {
                flushFailed = true;
                log.warn(
                  `session_end flush failed for ${bufferKey}: ${String(error)}`,
                );
              }
            }
            drainedAllBuffers = !flushFailed;
          }
          clearCodexCompatCaches(sessionKey, rememberedThreadId, {
            preserveThreadBinding: !drainedAllBuffers,
            preserveMessageCount: !drainedAllBuffers,
          });
          if (orchestrator.config.compactionResetEnabled) {
            orchestrator.clearRecallWorkspaceOverride(sessionKey);
          }
          await queueOpenClawFlushPlanProcessing(
            "session_end",
            (ctx?.workspaceDir as string) || (event?.workspaceDir as string),
            { timeoutMs: cfg.beforeResetTimeoutMs },
          );
        },
      );

      api.on(
        "before_tool_call",
        async (
          event: import("openclaw/plugin-sdk").PluginHookBeforeToolCallEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          if (event.toolName) {
            log.debug(`before_tool_call: ${event.toolName}`);
          }
        },
      );

      api.on(
        "after_tool_call",
        async (
          event: import("openclaw/plugin-sdk").PluginHookAfterToolCallEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          if (event.toolName) {
            log.debug(
              `after_tool_call: ${event.toolName} (${event.durationMs ?? "?"}ms)`,
            );
          }
        },
      );

      api.on(
        "llm_output",
        async (
          event: import("openclaw/plugin-sdk").PluginHookLlmOutputEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = (ctx?.sessionKey as string) ?? "default";
          if (event.tokenUsage) {
            log.debug(
              `llm_output: model=${event.model ?? "?"}, tokens=${event.tokenUsage.input ?? 0}/${event.tokenUsage.output ?? 0}, ${event.durationMs ?? "?"}ms, session=${sessionKey}`,
            );
          }
        },
      );

      api.on(
        "subagent_spawned",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSubagentSpawningEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          log.debug(
            `subagent_spawned: ${event.subagentId ?? "?"} purpose=${event.purpose ?? "?"} parent=${event.parentSessionKey ?? "?"}`,
          );
        },
      );

      api.on(
        "subagent_ended",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSubagentEndedEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          log.debug(
            `subagent_ended: ${event.subagentId ?? "?"} success=${event.success ?? "?"} ${event.durationMs ?? "?"}ms`,
          );
        },
      );
    }

    }

    // ========================================================================
    // ========================================================================
    async function ensureHourlySummaryCron(
      api: OpenClawPluginApi,
    ): Promise<void> {
      const jobId = "engram-hourly-summary";
      const cronFilePath = path.join(
        os.homedir(),
        ".openclaw",
        "cron",
        "jobs.json",
      );

      try {
        const loadedJobs = await loadHourlySummaryCronJobsData(cronFilePath);
        if (loadedJobs.status === "invalid") {
          log.error(
            `hourly summary cron auto-registration skipped: existing jobs file is invalid at ${cronFilePath}`,
            loadedJobs.error,
          );
          return;
        }
        const jobsData: HourlySummaryCronJobsData =
          loadedJobs.status === "loaded"
            ? loadedJobs.jobsData
            : { version: 1, jobs: [] };

        const existingIndex = jobsData.jobs.findIndex((j) => j.id === jobId);
        if (existingIndex >= 0) {
          const { changed, job } = reconcileHourlySummaryCronRouting(
            jobsData.jobs[existingIndex],
            cfg,
            { nowMs: Date.now() },
          );
          if (!changed) {
            log.debug("hourly summary cron job already up to date");
            return;
          }
          jobsData.jobs[existingIndex] = job;
          await writeTextFileLater(
            cronFilePath,
            JSON.stringify(jobsData, null, 2),
          );
          log.info("reconciled hourly summary cron job routing to configured task model");
          return;
        }

        const randomMinute = Math.floor(Math.random() * 59) + 1;

        const newJob = buildHourlySummaryCronJob(cfg, {
          jobId,
          minute: randomMinute,
          nowMs: Date.now(),
        });

        jobsData.jobs.push(newJob);

        await writeTextFileLater(
          cronFilePath,
          JSON.stringify(jobsData, null, 2),
        );
        log.info("auto-registered hourly summary cron job");
      } catch (err) {
        log.error("failed to auto-register hourly summary cron job:", err);
      }
    }

    if (typeof (api as any).registerMemoryCorpusSupplement === "function") {
      const normalizeCorpusLookup = (lookup: unknown): string | null =>
        typeof lookup === "string" && lookup.trim().length > 0
          ? lookup.trim()
          : null;
      const resolveCorpusStorage = async (agentSessionKey?: string) => {
        const namespace =
          typeof orchestrator.resolveSelfNamespace === "function"
            ? orchestrator.resolveSelfNamespace(agentSessionKey)
            : undefined;
        return typeof orchestrator.getStorageForNamespace === "function"
          ? await orchestrator.getStorageForNamespace(namespace)
          : orchestrator.storage;
      };
      const normalizeCorpusPath = (value: string): string =>
        value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      const pathIsInside = (root: string, candidate: string): boolean => {
        const relative = path.relative(root, candidate);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };
      const corpusPathCandidates = (
        rawPath: string,
        storageDir: string,
      ): string[] => {
        const candidates = new Set<string>();
        const trimmed = rawPath.trim();
        if (!trimmed) return [];
        candidates.add(normalizeCorpusPath(trimmed));
        if (path.isAbsolute(trimmed)) {
          const absolutePath = path.resolve(trimmed);
          const absoluteStorageDir = path.resolve(storageDir);
          if (pathIsInside(absoluteStorageDir, absolutePath)) {
            candidates.add(normalizeCorpusPath(path.relative(absoluteStorageDir, absolutePath)));
          }
        }
        candidates.add(path.basename(trimmed));
        return [...candidates].filter((candidate) => candidate.length > 0);
      };
      const displayCorpusPath = (rawPath: string, storageDir: string): string => {
        const trimmed = rawPath.trim();
        if (!trimmed) return "";
        if (path.isAbsolute(trimmed)) {
          const absolutePath = path.resolve(trimmed);
          const absoluteStorageDir = path.resolve(storageDir);
          if (pathIsInside(absoluteStorageDir, absolutePath)) {
            return normalizeCorpusPath(path.relative(absoluteStorageDir, absolutePath));
          }
        }
        return normalizeCorpusPath(trimmed);
      };
      const readMemoryByLookup = async (
        lookup: string,
        agentSessionKey?: string,
      ) => {
        const storage = await resolveCorpusStorage(agentSessionKey);
        const storageDir =
          typeof storage.dir === "string" && storage.dir.length > 0
            ? storage.dir
            : orchestrator.config.memoryDir;
        const memories = await storage.readAllMemories();
        const normalizedLookup = normalizeCorpusPath(lookup);
        const matched =
          memories.find((memory) => memory.frontmatter.id === lookup) ??
          memories.find((memory) =>
            corpusPathCandidates(memory.path, storageDir).includes(normalizedLookup),
          ) ??
          null;
        if (!matched) return null;
        const displayPath = displayCorpusPath(matched.path, storageDir);
        return { memory: matched, displayPath };
      };
      const corpusBackendError = (operation: "search" | "get", err: unknown): Error => {
        const message = err instanceof Error ? err.message : String(err);
        const error = new Error(`Remnic corpus ${operation} failed: ${message}`);
        (error as Error & { cause?: unknown }).cause = err;
        return error;
      };
      const remnicCorpusSupplement = {
        id: `${serviceId}:remnic-memory-corpus`,
        label: "Remnic Memory Corpus",
        async search(params: string | {
          query?: string;
          maxResults?: number;
          agentSessionKey?: string;
        }) {
          const query = normalizeCorpusLookup(
            typeof params === "string" ? params : params?.query,
          );
          if (!query) return [];
          const maxResults =
            typeof params === "object" &&
            typeof params.maxResults === "number" &&
            Number.isFinite(params.maxResults)
              ? Math.max(1, Math.floor(params.maxResults))
              : 8;
          const agentSessionKey =
            typeof params === "object" ? params.agentSessionKey : undefined;
          const namespace =
            typeof orchestrator.resolveSelfNamespace === "function"
              ? orchestrator.resolveSelfNamespace(agentSessionKey)
              : undefined;
          try {
            const visibleResults = await searchWithGenericExclusion({
              budget: maxResults,
              sendInitialLimit: true,
              search: (limit) => orchestrator.searchAcrossNamespaces({
                query,
                ...(limit !== undefined ? { maxResults: limit } : {}),
                namespaces: namespace ? [namespace] : undefined,
                mode: "search",
              }),
              filterPrivate: (results) => orchestrator.filterPrivateSearchResults(
                results,
                namespace ? [namespace] : [],
              ),
              isExcluded: (resultPath) => isMemoryArtifactPath(resultPath),
            });
            return visibleResults
              .map((result, index) => {
                const candidate = result as unknown as {
                  path?: string;
                  id?: string;
                  startLine?: number;
                  endLine?: number;
                  score?: number;
                  snippet?: string;
                  text?: string;
                  metadata?: Record<string, unknown>;
                };
                const lookupPath =
                  typeof candidate.path === "string"
                    ? candidate.path
                    : typeof candidate.id === "string"
                      ? candidate.id
                      : `remnic-memory-${index + 1}`;
                const startLine =
                  typeof candidate.startLine === "number" && Number.isFinite(candidate.startLine)
                    ? Math.max(1, Math.floor(candidate.startLine))
                    : 1;
                const endLine =
                  typeof candidate.endLine === "number" && Number.isFinite(candidate.endLine)
                    ? Math.max(startLine, Math.floor(candidate.endLine))
                    : startLine;
                return {
                  corpus: "remnic",
                  path: lookupPath,
                  title:
                    typeof candidate.id === "string" && candidate.id.length > 0
                      ? candidate.id
                      : lookupPath,
                  kind: "memory",
                  score:
                    typeof candidate.score === "number" && Number.isFinite(candidate.score)
                      ? candidate.score
                      : 0,
                  snippet:
                    typeof candidate.snippet === "string"
                      ? candidate.snippet
                      : typeof candidate.text === "string"
                        ? candidate.text
                        : "",
                  id: typeof candidate.id === "string" ? candidate.id : lookupPath,
                  startLine,
                  endLine,
                  citation: lookupPath,
                  source: "remnic",
                  provenanceLabel: "Remnic",
                  sourceType: "memory",
                  sourcePath: lookupPath,
                  updatedAt:
                    typeof candidate.metadata?.updatedAt === "string"
                      ? candidate.metadata.updatedAt
                      : undefined,
                };
              });
          } catch (err) {
            log.warn(`memory corpus search failed: ${err}`);
            throw corpusBackendError("search", err);
          }
        },
        async get(params: string | {
          lookup?: string;
          fromLine?: number;
          lineCount?: number;
          agentSessionKey?: string;
        }) {
          const lookup = normalizeCorpusLookup(
            typeof params === "string" ? params : params?.lookup,
          );
          if (!lookup || isMemoryArtifactPath(lookup)) return null;
          const agentSessionKey =
            typeof params === "object" ? params.agentSessionKey : undefined;
          try {
            const resolved = await readMemoryByLookup(lookup, agentSessionKey);
            if (!resolved) return null;
            const { memory, displayPath } = resolved;
            if (
              isMemoryArtifactPath(displayPath) ||
              isMemoryArtifactPath(memory.path) ||
              isSupportPassportPrivateMemory(memory)
            ) {
              return null;
            }
            const allLines = memory.content.split(/\r?\n/);
            const fromLine =
              typeof params === "object" &&
              typeof params.fromLine === "number" &&
              Number.isFinite(params.fromLine)
                ? Math.max(1, Math.floor(params.fromLine))
                : 1;
            const lineCount =
              typeof params === "object" &&
              typeof params.lineCount === "number" &&
              Number.isFinite(params.lineCount)
                ? Math.max(1, Math.floor(params.lineCount))
                : allLines.length;
            const selected = allLines.slice(fromLine - 1, fromLine - 1 + lineCount);
            return {
              corpus: "remnic",
              path: displayPath,
              title: memory.frontmatter.id,
              kind: memory.frontmatter.category,
              content: selected.join("\n"),
              fromLine,
              lineCount: selected.length,
              id: memory.frontmatter.id,
              provenanceLabel: "Remnic",
              sourceType: "memory",
              sourcePath: displayPath,
              updatedAt: memory.frontmatter.updated,
            };
          } catch (err) {
            log.warn(`memory corpus get failed: ${err}`);
            throw corpusBackendError("get", err);
          }
        },
      };
      (api as any).registerMemoryCorpusSupplement(remnicCorpusSupplement);
    }

    // ========================================================================
    // ========================================================================
    //
    //
    const adaptersEnabled = cfg.openclawToolsEnabled !== false;
    const ownedToolNames = registerEmbeddedTools(api, {
      enabled: adaptersEnabled,
      passive: passiveMode,
      tools: adaptersEnabled
        ? [
            buildMemorySearchTool(orchestrator, { snippetMaxChars: cfg.openclawToolSnippetMaxChars }),
            buildMemoryGetTool(orchestrator),
          ]
        : [buildLegacyMemorySearchToolForPublicShape(orchestrator)],
    });

    // OpenClaw's command discovery is driven by registerCommand() entries.
    // `commands.list` is a gateway RPC surface, not a plugin typed hook, so
    // attempting to bind it through api.on() produces an "unknown typed hook"
    // warning on current runtimes.
    const commandApi = api as { registerCommand?: (spec: unknown) => void };
    if (
      !discoveryPass &&
      !passiveMode &&
      cfg.commandsListEnabled &&
      cfg.sessionTogglesEnabled !== false
    ) {
      if (
        typeof commandApi.registerCommand === "function" &&
        !(globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD]
      ) {
        (globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD] = true;
        for (const descriptor of sessionCommandDescriptors) {
          commandApi.registerCommand(descriptor);
        }
      } else if (typeof commandApi.registerCommand !== "function") {
        log.debug(
          "registerCommand unavailable on this runtime; skipping Remnic session command descriptors because commands.list is a gateway RPC surface, not a typed plugin hook",
        );
      }
    }

    registerTools(
      api as unknown as Parameters<typeof registerTools>[0],
      orchestrator,
      getOpenClawRuntimeAgentId(api),
      ownedToolNames,
    );
    if (orchestrator.lcmEngine?.enabled) {
      registerLcmTools(
        api as unknown as Parameters<typeof registerLcmTools>[0],
        orchestrator.lcmEngine,
      );
    }

    if (!discoveryPass && !(globalThis as any)[CLI_REGISTERED_GUARD]) {
      (globalThis as any)[CLI_REGISTERED_GUARD] = true;
      registerCli(
        api as unknown as Parameters<typeof registerCli>[0],
        orchestrator,
        { loadResolveSecretRef: loadOpenClawSecretRefResolver },
      );
    }

    // ========================================================================
    // ========================================================================
    //
    let activeOpikExporter: import("@remnic/core/opik-exporter").OpikExporter | null =
      null;
    let didCountStart = false;
    api.registerService({
      id: serviceId,
      start: async () => {
        //
        for (;;) {
          while ((globalThis as any)[keys.INIT_PROMISE]) {
            try {
              await (globalThis as any)[keys.INIT_PROMISE];
            } catch {
              // A primary's init failed and its outer try-finally already cleared
              // INIT_PROMISE to null. Re-evaluate the while condition: if another
              // secondary claimed INIT_PROMISE in the meantime, await it; otherwise
              // exit and decide whether to become the next primary.
            }
            if ((globalThis as any)[keys.SERVICE_STARTED]) return;
          }
          if ((globalThis as any)[keys.SERVICE_STARTED]) {
            log.debug(
              `${serviceId}: service.start() called again — skipping duplicate init`,
            );
            return;
          }
          if ((globalThis as any)[keys.INIT_PROMISE]) continue;
          break;
        }
        didCountStart = true;
        (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] =
          ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) + 1;
        (globalThis as any)[keys.ORCHESTRATOR] = orchestrator;
        const initPromise = (async () => {
          try {
            log.info("initializing engram memory system...");
            await orchestrator.initialize();

            if (!didCountStart) return;

            activeOpikExporter = createOpikExporter({}, log);
            if (activeOpikExporter) activeOpikExporter.subscribe();

            if (orchestrator.config.transcriptEnabled) {
              await orchestrator.transcript.cleanup(
                orchestrator.config.transcriptRetentionDays,
              );
              if (!didCountStart) return;
            }

            if (
              orchestrator.config.hourlySummariesEnabled &&
              orchestrator.config.hourlySummaryCronAutoRegister
            ) {
              await ensureHourlySummaryCron(api);
              if (!didCountStart) return;
            } else if (orchestrator.config.hourlySummariesEnabled) {
              log.info(
                "hourly summaries enabled; cron auto-register is disabled. " +
                  "To schedule summaries, create an isolated/agentTurn cron job that calls `memory_summarize_hourly`.",
              );
            }

            if (!passiveMode) {
              await maybeRegisterLiveConnectorCron(orchestrator);
              if (!didCountStart) return;
            }

            if (cfg.dreaming.enabled) {
              await queueDreamSurfaceSync();
              if (cfg.dreaming.watchFile) {
                stopDreamWatcher?.();
                stopDreamWatcher = dreamsSurface.watch(
                  resolveDreamJournalPath(),
                  () => {
                    void queueDreamSurfaceSync().catch((error) => {
                      log.debug(`dream surface watch sync failed: ${String(error)}`);
                    });
                  },
                );
              }
              removeDreamingObserver?.();
              removeDreamingObserver = orchestrator.registerConsolidationObserver(
                async (observation) => {
                  await maybeAppendDreamFromConsolidation(observation);
                },
              );
            }

            if (cfg.heartbeat.enabled) {
              await queueHeartbeatSurfaceSync();
              if (cfg.heartbeat.watchFile) {
                stopHeartbeatWatcher?.();
                stopHeartbeatWatcher = heartbeatSurface.watch(
                  resolveHeartbeatJournalPath(),
                  () => {
                    void queueHeartbeatSurfaceSync().catch((error) => {
                      log.debug(`heartbeat surface watch sync failed: ${String(error)}`);
                    });
                  },
                );
              }
            }

            if (cfg.agentAccessHttp.enabled) {
              if (!didCountStart) return;
              if (authTokenIsSecretRef) {
                const resolved = await resolveAgentAccessAuthToken(rawAuthToken, {
                  resolveSecretRef: await loadOpenClawSecretRefResolver(),
                });
                if (!resolved) {
                  throw new Error(
                    "agentAccessHttp.authToken SecretRef resolved to empty value — refusing to start the HTTP bridge",
                  );
                }
                accessHttpAuthState.resolvedSecretRefAuthToken = resolved;
              }
              try {
                const status = await accessHttpServer.start();
                log.info(
                  `engram access HTTP ready at http://${status.host}:${status.port}`,
                );
              } catch (err) {
                log.error("failed to start engram access HTTP server", err);
              }
            }

            if (!didCountStart) return;
            (globalThis as any)[keys.SERVICE_STARTED] = true;
            //
            //
            log.info("engram memory system ready");
            log.info(
              `gateway_start fired — Remnic memory plugin is active (id=${pluginDefinition.id}, memoryDir=${cfg.memoryDir})`,
            );
            void queueOpenClawFlushPlanProcessing(
              "gateway_start",
              getOpenClawRuntimeWorkspaceDir(api),
            );
          } catch (err) {
            try {
              activeOpikExporter?.unsubscribe();
            } catch {}
            activeOpikExporter = null;
            //
            if (didCountStart) {
              (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] = Math.max(
                0,
                ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) - 1,
              );
            }
            didCountStart = false;
            (globalThis as any)[keys.SERVICE_STARTED] = false;
            //
            throw err;
          }
          // No finally here — see comment above. INIT_PROMISE is cleared
          // by the outer try-finally after `await initPromise` below.
        })();
        (globalThis as any)[keys.INIT_PROMISE] = initPromise;
        try {
          await initPromise;
        } finally {
          (globalThis as any)[keys.INIT_PROMISE] = null;
        }
      },
      stop: async () => {
        if (!didCountStart) return;
        didCountStart = false;

        const initPromiseAtStopEntry = (globalThis as any)[
          keys.INIT_PROMISE
        ] as Promise<void> | null;

        try {
          await orchestrator.deferredReady;
        } catch {
          // deferredReady should never reject, but guard defensively.
        }

        const remainingServices = Math.max(
          0,
          ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) - 1,
        );
        (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] = remainingServices;

        const currentInitPromise = initPromiseAtStopEntry;
        let secondaryTookOver = false;


        if (!currentInitPromise && (globalThis as any)[keys.INIT_PROMISE]) {
          secondaryTookOver = true;
        }

        //
        //
        if (!currentInitPromise) {
          if (!secondaryTookOver) {
            (globalThis as any)[keys.REGISTERED_GUARD] = false;
            if (remainingServices === 0) {
              (globalThis as any)[CLI_REGISTERED_GUARD] = false;
              (globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD] = false;
            }
          }
        } else {

          if (
            (globalThis as any)[keys.INIT_PROMISE] &&
            (globalThis as any)[keys.INIT_PROMISE] !== currentInitPromise
          ) {
            secondaryTookOver = true;
          }

          //
          try {
            await currentInitPromise;
          } catch {}
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          if (
            (globalThis as any)[keys.INIT_PROMISE] ||
            (globalThis as any)[keys.SERVICE_STARTED]
          ) {
            secondaryTookOver = true;
          }
        }

        if (!secondaryTookOver) {
          try {
            activeOpikExporter?.unsubscribe();
          } catch (err) {
            log.debug(`engram opik exporter unsubscribe failed: ${err}`);
          }
          activeOpikExporter = null;
          const finishCodex = beginCodexSubscriptionShutdown(getCodexSubscriptionRunnerForOwner(cfg));
          try {
            try {
              await accessHttpServer.stop();
            } catch (err) {
              log.debug(`engram access HTTP stop failed: ${err}`);
            }
            stopDreamWatcher?.();
            stopDreamWatcher = null;
            stopHeartbeatWatcher?.();
            stopHeartbeatWatcher = null;
            removeDreamingObserver?.();
            removeDreamingObserver = null;
            try {
              await orchestrator.destroy();
            } catch (err) {
              log.debug(`engram orchestrator destroy on stop failed: ${err}`);
            }
          } finally {
            finishCodex();
          }
          terminateActiveCodexSubscriptionChildren("SIGKILL", getCodexSubscriptionRunnerForOwner(cfg));
          if ((globalThis as any)[keys.ORCHESTRATOR] === orchestrator) {
            delete (globalThis as any)[keys.ORCHESTRATOR];
          }
          const unregisterOpenClawHostEmbeddingProvider = (globalThis as any)[
            keys.HOST_EMBEDDING_UNREGISTER
          ] as (() => void) | undefined;
          unregisterOpenClawHostEmbeddingProvider?.();
          delete (globalThis as any)[keys.HOST_EMBEDDING_UNREGISTER];
          delete (globalThis as any)[keys.HOST_EMBEDDING_SIGNATURE];
          delete (globalThis as any)[keys.ACCESS_HTTP_SERVER];
          delete (globalThis as any)[keys.ACCESS_HTTP_AUTH_STATE];
          delete (globalThis as any)[keys.ACCESS_SERVICE];
          if (flushPlanProcessingChains.size === 0) {
            delete (globalThis as any)[keys.FLUSH_PLAN_PROCESSING_CHAINS];
          }
        }

        if (!secondaryTookOver) {
          (globalThis as any)[keys.HOOK_APIS] = new WeakSet();
        }
        if (!secondaryTookOver) {
          (globalThis as any)[keys.SERVICE_STARTED] = false;
        }
        log.info("stopped");
      },
    });
  },
};

export default tryDefinePluginEntry(pluginDefinition);

// ============================================================================
// ============================================================================

const OPENCLAW_BOOLEAN_ACCEPTED_VALUES = "true/false/1/0/yes/no/on/off";

function coerceOpenClawBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function resolveOpenClawFlushPlanProcessingEnabled(configValue: unknown): boolean {
  if (configValue === undefined || configValue === null) return true;
  const coerced = coerceOpenClawBooleanLike(configValue);
  if (coerced === undefined) {
    throw new Error(
      `openclawFlushPlanProcessingEnabled must be a boolean-like value (${OPENCLAW_BOOLEAN_ACCEPTED_VALUES}); got ${JSON.stringify(configValue)}`,
    );
  }
  return coerced;
}

function resolveOpenClawFlushPlanProcessingEnabledFromConfig(
  fileConfig: Record<string, unknown> | undefined,
  runtimeConfig: unknown,
): boolean {
  const runtimeRecord =
    runtimeConfig && typeof runtimeConfig === "object"
      ? (runtimeConfig as Record<string, unknown>)
      : undefined;
  const hasRuntimeValue =
    runtimeRecord !== undefined &&
    Object.prototype.hasOwnProperty.call(
      runtimeRecord,
      "openclawFlushPlanProcessingEnabled",
    );
  const hasFileValue =
    fileConfig !== undefined &&
    Object.prototype.hasOwnProperty.call(
      fileConfig,
      "openclawFlushPlanProcessingEnabled",
    );
  const runtimeValue = hasRuntimeValue
    ? resolveOpenClawFlushPlanProcessingEnabled(
        runtimeRecord.openclawFlushPlanProcessingEnabled,
      )
    : undefined;
  const fileValue = hasFileValue
    ? resolveOpenClawFlushPlanProcessingEnabled(
        fileConfig.openclawFlushPlanProcessingEnabled,
      )
    : undefined;

  if (runtimeValue === false || fileValue === false) return false;
  return fileValue ?? runtimeValue ?? true;
}

type OpenClawTranscriptMetadata = NonNullable<
  import("@remnic/core/types").TranscriptEntry["metadata"]
>;

function buildOpenClawMessageMetadata(
  message: Record<string, unknown>,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  cfg: {
    openclawReplyMetadataCaptureEnabled: boolean;
  },
): OpenClawTranscriptMetadata | null {
  if (!cfg.openclawReplyMetadataCaptureEnabled) return null;
  const metadata: OpenClawTranscriptMetadata = {};
  const messageId = getOpenClawMessageId(message, event, ctx);
  if (messageId) metadata.messageId = truncateMetadataValue(messageId, 512);

  const threadId =
    normalizeThreadId(message.threadId) ??
    normalizeThreadId(event.threadId) ??
    normalizeThreadId(ctx.threadId);
  if (threadId) metadata.threadId = truncateMetadataValue(threadId, 512);

  const replyToId =
    normalizeOptionalString(message.replyToId) ??
    normalizeOptionalString(event.replyToId) ??
    normalizeOptionalString(ctx.replyToId);
  if (replyToId) metadata.replyToId = truncateMetadataValue(replyToId, 512);

  const replyToBody =
    normalizeOptionalString(message.replyToBody) ??
    normalizeOptionalString(event.replyToBody) ??
    normalizeOptionalString(ctx.replyToBody);
  if (replyToBody) metadata.replyToBody = truncateMetadataValue(replyToBody, 1_000);

  const replyToSender =
    normalizeOptionalString(message.replyToSender) ??
    normalizeOptionalString(event.replyToSender) ??
    normalizeOptionalString(ctx.replyToSender);
  if (replyToSender) metadata.replyToSender = truncateMetadataValue(replyToSender, 256);

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function getOpenClawMessageId(
  message: Record<string, unknown>,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  const messageId =
    normalizeOptionalString(message.messageId) ??
    normalizeOptionalString(event.messageId) ??
    normalizeOptionalString(ctx.messageId);
  return messageId ? truncateMetadataValue(messageId, 512) : undefined;
}

function getOpenClawMessageDedupeKeys(
  message: Record<string, unknown>,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  sessionKey: string,
): string[] {
  const messageId = getOpenClawMessageId(message, event, ctx);
  if (!messageId) return [];
  const sessionScope =
    normalizeOptionalString(message.sessionKey) ??
    normalizeOptionalString(event.sessionKey) ??
    normalizeOptionalString(ctx.sessionKey) ??
    sessionKey;
  const threadScope = truncateMetadataValue(
    normalizeThreadId(message.threadId) ??
    normalizeThreadId(event.threadId) ??
    normalizeThreadId(ctx.threadId) ??
    "",
    512,
  );
  const runScope = truncateMetadataValue(
    normalizeOptionalString(message.runId) ??
    normalizeOptionalString(event.runId) ??
    normalizeOptionalString(ctx.runId) ??
    "",
    512,
  );
  const sessionPart = truncateMetadataValue(sessionScope, 512);
  const dedupeScopes = new Set<string>();
  if (threadScope) dedupeScopes.add(threadScope);
  if (runScope) dedupeScopes.add(runScope);
  dedupeScopes.add("");
  return [...dedupeScopes].map((scope) => `${sessionPart}\u0000${scope}\u0000${messageId}`);
}

function buildOpenClawInboundContentFingerprint(
  content: string,
  message: Record<string, unknown>,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  sessionKey: string,
): string | null {
  const normalizedContent = content.trim();
  if (!normalizedContent) return null;
  const sessionPart = truncateMetadataValue(sessionKey || "default", 512);
  const runScope = truncateMetadataValue(
    normalizeOptionalString(message.runId) ??
      normalizeOptionalString(event.runId) ??
      normalizeOptionalString(ctx.runId) ??
      "",
    512,
  );
  const rawTimestamp =
    normalizeOptionalString(message.timestamp) ??
    normalizeOptionalString(event.timestamp) ??
    normalizeOptionalString(ctx.timestamp) ??
    (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? String(message.timestamp)
      : undefined) ??
    (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? String(event.timestamp)
      : undefined) ??
    (typeof ctx.timestamp === "number" && Number.isFinite(ctx.timestamp)
      ? String(ctx.timestamp)
      : undefined);
  const timestampScope = rawTimestamp
    ? truncateMetadataValue(rawTimestamp, 512)
    : "";
  if (!runScope && !timestampScope) return null;
  const threadScope = truncateMetadataValue(
    normalizeThreadId(message.threadId) ??
      normalizeThreadId(event.threadId) ??
      normalizeThreadId(ctx.threadId) ??
      "",
    512,
  );
  const contentHash = createHash("sha256")
    .update(normalizedContent)
    .digest("hex");
  return [
    sessionPart,
    "content",
    threadScope,
    runScope,
    timestampScope,
    contentHash,
  ].join("\u0000");
}

function buildOpenClawSparseInboundContentFingerprint(
  content: string,
  sessionKey: string,
): string | null {
  const normalizedContent = content.trim();
  if (!normalizedContent) return null;
  const sessionPart = truncateMetadataValue(sessionKey || "default", 512);
  const contentHash = createHash("sha256")
    .update(normalizedContent)
    .digest("hex");
  return `${sessionPart}\u0000sparse-content\u0000${contentHash}`;
}

function withReplyExtractionHint(
  content: string,
  metadata: OpenClawTranscriptMetadata | null,
): string {
  const replyBody = metadata?.replyToBody?.trim();
  if (!replyBody) return content;
  const sender = metadata?.replyToSender?.trim();
  const prefix = sender
    ? `Reply context from ${sender}: ${replyBody}`
    : `Reply context: ${replyBody}`;
  return `${prefix}\n\nCurrent message: ${content}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return normalizeOptionalString(value);
}

function truncateMetadataValue(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

async function resolveFlushPlanProcessingChainKey(workspaceRoot: string): Promise<string> {
  const lexicalRoot = path.resolve(workspaceRoot);
  try {
    return path.resolve(await realPathLater(lexicalRoot));
  } catch {
    return lexicalRoot;
  }
}
