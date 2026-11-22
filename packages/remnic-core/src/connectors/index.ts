
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { generateToken, revokeToken, buildTokenEntry, commitTokenEntry, loadTokenStore, saveTokenStore } from "../tokens.js";
import { checkDaemonHealth } from "../runtime/daemon-health.js";
import { readEnvVar, resolveHomeDir } from "../runtime/env.js";
import { expandTildePath } from "../utils/path.js";
import { coerceBool, coerceInstallExtension } from "./coerce.js";
import {
  assertConfigComponentsNotSymlinked,
  hermesShimPath,
  isPlausibleHermesConfigPath,
  materializeHermesShim,
  reconcileHermesShim,
  removeHermesShim,
  resolveHermesRoot,
  sameShimTarget,
  survivingMarkerShims,
} from "./hermes-shim.js";
import { getConnectorsDir, getRegistryPath } from "./paths.js";
export { getConnectorsDir, getRegistryPath } from "./paths.js";
export { resolveFactoryMcpPath, upsertFactoryMcpRemnicEntry, removeFactoryMcpRemnicEntry } from "./droid-mcp.js";
export { DROID_CONNECTOR_MANIFEST } from "./droid-mcp.js";
import {
  DROID_CONNECTOR_MANIFEST,
  droidInstallStep,
  removeDroidMcpEntry as removeDroidMcpEntryImpl,
  droidMcpDoctorCheck as droidMcpDoctorCheckImpl,
  readDroidMcpProvenance,
} from "./droid-mcp.js";
import { PRIME_AGENT_CONNECTOR_MANIFEST } from "./prime-agent.js";

// Native memory artifact materialization for Codex CLI (#378). Surfaced here
// so downstream callers can `import { materializeForNamespace } from "@remnic/core/connectors"`.
export {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  renderMemorySummary,
  renderMemoryMd,
  renderRawMemories,
  renderRolloutSummary,
  validateMemoryMd,
  approximateTokenCount,
  truncateToTokenBudget,
  MATERIALIZE_VERSION,
  SENTINEL_FILE,
  TMP_DIR,
  type MaterializeOptions,
  type MaterializeResult,
  type RolloutSummaryInput,
  type MemoryMdValidation,
} from "./codex-materialize.js";
export {
  runCodexMaterialize,
  type RunMaterializeOptions,
} from "./codex-materialize-runner.js";
export {
  generateMarketplaceManifest,
  validateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  MARKETPLACE_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_FILENAME,
  type MarketplaceManifest,
  type MarketplaceEntry,
  type MarketplaceConfig,
  type MarketplaceInstallType,
  type MarketplaceInstallResult,
  type MarketplaceValidation,
  type MarketplaceLogger,
} from "./codex-marketplace.js";


export interface ConnectorManifest {
  /** Unique connector ID (e.g. "claude-code", "codex-cli") */
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: ConnectorCapability;
  configSchema?: Record<string, string>;
  installed?: boolean;
  homepage?: string;
  author?: string;
  repository?: string;
  tags?: string[];
  /**
   * Whether this connector requires a bearer token for daemon authentication.
   * When false (the default), installConnector will NOT generate or persist a
   * token entry in tokens.json — credentials are never materialized on disk for
   * connectors that use MCP, embedded, CLI, or SDK transports that don't need
   * token auth.  Set to true only for HTTP connectors that actually authenticate
   * requests with a bearer token (e.g. hermes, replit, generic-mcp).
   */
  requiresToken?: boolean;
}

export interface ConnectorCapability {
  observe: boolean;
  recall: boolean;
  store: boolean;
  search: boolean;
  entities: boolean;
  realtimeSync: boolean;
  batch: boolean;
  /** Max memory budget in chars */
  maxBudgetChars?: number;
  connectionType: "mcp" | "http" | "cli" | "sdk" | "embedded";
}

export interface ConnectorInstance {
  connectorId: string;
  config: Record<string, unknown>;
  status: "installed" | "running" | "error" | "disabled";
  installedAt?: string;
  /** Error message if erro */
  error?: string;
}

export interface ConnectorRegistry {
  connectors: ConnectorManifest[];
  registryPath: string;
}

export interface InstallOptions {
  connectorId: string;
  config?: Record<string, unknown>;
  memoryDir?: string;
  force?: boolean;
}

export interface InstallResult {
  /** Connector ID */
  connectorId: string;
  /** Status */
  status: "installed" | "already_installed" | "config_required" | "error";
  configPath?: string;
  message: string;
}

export interface RemoveResult {
  /** Connector ID */
  connectorId: string;
  configPath: string;
  /** Message */
  message: string;
  /** Status: "removed" on success, "error" if the removal failed partway, "not_found" if the connector was not installed, "skipped" if removal was aborted (e.g. malformed config). */
  status: "removed" | "error" | "not_found" | "skipped";
  /** Machine-readable skip reason (present when status === "skipped"). */
  reason?: string;
}

export interface DoctorResult {
  /** Connector ID */
  connectorId: string;
  checks: DoctorCheck[];
  healthy: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}


// Re-export coerceInstallExtension so existing import sites
// (`import { coerceInstallExtension } from "./index.js"`) keep working without
// change. The binding comes from the top-level import above.
export { coerceInstallExtension };


export const BUILTIN_CONNECTORS: ConnectorManifest[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    description: "Anthropic's Claude Code CLI — direct memory access via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace (default: 'default')",
    },
    homepage: "https://claude.ai/code",
    author: "Anthropic",
    tags: ["official", "ai", "claude"],
    requiresToken: true,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    version: "1.0.0",
    description: "OpenAI Codex CLI — memory via MCP tool",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 8000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://openai.com/codex",
    author: "OpenAI",
    tags: ["official", "ai", "codex"],
    requiresToken: true,
  },
  {
    id: "cursor",
    name: "Cursor IDE",
    version: "1.0.0",
    description: "Cursor IDE — memory via config file + tool calls",
    capabilities: {
      observe: false,
      recall: true,
      store: false,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "embedded",
    },
    configSchema: {
      memoryDir: "Path to Remnic memory directory",
    },
    homepage: "https://cursor.com",
    author: "Cursor Inc.",
    tags: ["official", "ide"],
  },
  {
    id: "cline",
    name: "Cline",
    version: "1.0.0",
    description: "VS Code Cline extension — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 8000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://github.com/cline/cline",
    author: "Cline",
    tags: ["community", "vscode"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    version: "1.0.0",
    description: "GitHub Copilot — memory via MCP server",
    capabilities: {
      observe: false,
      recall: true,
      store: false,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 16000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://github.com/features/copilot",
    author: "GitHub",
    tags: ["official", "ai", "github"],
  },
  {
    id: "roo-code",
    name: "Roo Code",
    version: "1.0.0",
    description: "Roo Code — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 16000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://roocode.com",
    author: "Roo Code",
    tags: ["community", "vscode"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    version: "1.0.0",
    description: "Windsurf IDE — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://windsurf.com",
    author: "Codeium",
    tags: ["official", "ide"],
  },
  {
    id: "amp",
    name: "Amp",
    version: "1.0.0",
    description: "Amp coding agent — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://ampcode.com",
    author: "Sourcegraph",
    tags: ["official", "ai"],
  },
  {
    id: "pi",
    name: "Pi Coding Agent",
    version: "1.0.0",
    description: "Pi Coding Agent — native extension for recall, observe, MCP tools, and compaction coordination",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: true,
      maxBudgetChars: 32000,
      connectionType: "http",
    },
    configSchema: {
      remnicDaemonUrl: "URL of the Remnic daemon (default: http://127.0.0.1:4318)",
      namespace: "Optional namespace",
      installExtension: "Install the Pi extension into ~/.pi/agent/extensions/remnic (default: true)",
    },
    homepage: "https://pi.dev",
    author: "Remnic",
    tags: ["official", "ai", "pi", "coding-agent"],
    requiresToken: true,
  },
  {
    id: "omp",
    name: "Oh My Pi (omp)",
    version: "1.0.0",
    description:
      "Oh My Pi (omp) — Pi-fork coding agent; native extension for recall, observe, MCP tools, and compaction coordination",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: true,
      maxBudgetChars: 32000,
      connectionType: "http",
    },
    configSchema: {
      remnicDaemonUrl: "URL of the Remnic daemon (default: http://127.0.0.1:4318)",
      namespace: "Optional namespace",
      installExtension: "Install the omp extension into ~/.omp/agent/extensions/remnic (default: true)",
    },
    homepage: "https://omp.sh",
    author: "Remnic",
    tags: ["official", "ai", "omp", "pi", "coding-agent"],
    requiresToken: true,
  },
  PRIME_AGENT_CONNECTOR_MANIFEST,
  {
    id: "replit",
    name: "Replit Agent",
    version: "1.0.0",
    description: "Replit Agent — memory via HTTP API (reduced capabilities)",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 8000,
      connectionType: "http",
    },
    configSchema: {
      apiUrl: "URL of the Remnic HTTP API",
      authToken: "Bearer token for authentication",
    },
    homepage: "https://replit.com",
    author: "Replit",
    tags: ["official", "cloud"],
    requiresToken: true,
  },
  {
    id: "generic-mcp",
    name: "Generic MCP Client",
    version: "1.0.0",
    description: "Any MCP-compatible client — connect via standard MCP protocol",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: true,
      maxBudgetChars: 64000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
      authToken: "Bearer token for authentication",
    },
    homepage: "https://github.com/joshuaswarren/remnic",
    author: "Remnic",
    tags: ["generic", "mcp"],
    requiresToken: true,
  },
  {
    id: "weclone",
    name: "WeClone Avatar",
    version: "1.0.0",
    description:
      "Memory-aware OpenAI-compatible proxy for deployed WeClone avatars — " +
      "injects Remnic recall into chat completions and buffers turns via observe",
    capabilities: {
      observe: true,
      recall: true,
      store: false,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "http",
    },
    configSchema: {
      wecloneApiUrl:
        "Base URL of the WeClone OpenAI-compatible API (e.g. http://localhost:8000/v1)",
      proxyPort: "Local port where the memory proxy will listen (default 8100)",
      remnicDaemonUrl:
        "URL of the Remnic daemon exposing /engram/v1/recall and /engram/v1/observe",
      sessionStrategy:
        "Per-caller session mapping strategy: 'caller-id' | 'single'",
      wecloneModelName: "Optional fine-tuned model name passed through to WeClone",
    },
    homepage: "https://github.com/xming521/weclone",
    author: "Remnic",
    tags: ["official", "ai", "weclone", "proxy"],
    requiresToken: true,
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    version: "1.0.0",
    description: "Hermes Agent MemoryProvider — automatic recall/observe on every turn via Python plugin protocol",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: true,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "http",
    },
    configSchema: {
      host: "Remnic daemon host (default: 127.0.0.1)",
      port: "Remnic daemon port (default: 4318)",
      profile: "Hermes profile name (default: default)",
    },
    homepage: "https://github.com/joshuaswarren/remnic/tree/main/packages/plugin-hermes",
    author: "Remnic",
    tags: ["official", "python", "hermes"],
    requiresToken: true,
  },
  DROID_CONNECTOR_MANIFEST,
];


export const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidConnectorId(connectorId: unknown): connectorId is string {
  return typeof connectorId === "string" && CONNECTOR_ID_PATTERN.test(connectorId);
}

function isConnectorManifest(value: unknown): value is ConnectorManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isValidConnectorId((value as { id?: unknown }).id)
  );
}


export function loadRegistry(): ConnectorRegistry {
  const regPath = getRegistryPath();

  if (!fs.existsSync(regPath)) {
    // First time — bootstrap with built-in connectors
    const registry: ConnectorRegistry = {
      connectors: BUILTIN_CONNECTORS,
      registryPath: regPath,
    };
    saveRegistry(registry);
    return registry;
  }

  try {
    const raw = fs.readFileSync(regPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { connectors?: unknown }).connectors)
    ) {
      throw new Error("invalid registry schema");
    }
    // Only connectors whose IDs are NOT in BUILTIN_CONNECTORS are preserved from
    // the persisted file — those are genuine user-added custom connectors.
    const builtinIds = new Set(BUILTIN_CONNECTORS.map((b) => b.id));
    const customOnly = (parsed as { connectors: unknown[] }).connectors.filter(
      (c): c is ConnectorManifest => isConnectorManifest(c) && !builtinIds.has(c.id),
    );
    const merged = [...BUILTIN_CONNECTORS, ...customOnly];
    return {
      connectors: merged,
      registryPath: regPath,
    };
  } catch {
    return {
      connectors: BUILTIN_CONNECTORS,
      registryPath: regPath,
    };
  }
}

export function saveRegistry(registry: ConnectorRegistry): void {
  const regPath = registry.registryPath;
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify({ connectors: registry.connectors }, null, 2));
}


export function listConnectors(): {
  installed: ConnectorInstance[];
  available: ConnectorManifest[];
} {
  const registry = loadRegistry();
  const connectorsDir = getConnectorsDir();
  const installedIds = new Set<string>();

  if (fs.existsSync(connectorsDir)) {
    for (const entry of fs.readdirSync(connectorsDir)) {
      if (entry.endsWith(".json")) {
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(connectorsDir, entry), "utf8"),
          );
          if (isValidConnectorId(config.connectorId)) {
            installedIds.add(config.connectorId);
          }
        } catch {
          // ignore malformed configs
        }
      }
    }
  }

  const available: ConnectorManifest[] = registry.connectors.map((manifest) => ({
    ...manifest,
    installed: installedIds.has(manifest.id),
  }));

  const installed: ConnectorInstance[] = [];
  for (const id of installedIds) {
    const configPath = path.join(connectorsDir, `${id}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const { token: _redacted, ...config } = raw;
      installed.push({
        connectorId: id,
        config,
        status: "installed",
        installedAt: raw.installedAt as string | undefined,
      });
    } catch {
      // ignore
    }
  }

  return { installed, available };
}


export function getConnectorToken(connectorId: string): string | undefined {
  if (!isValidConnectorId(connectorId)) {
    return undefined;
  }
  try {
    return loadTokenStore().tokens.find((t) => t.connector === connectorId)?.token;
  } catch {
    return undefined;
  }
}

function readSavedConnectorConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const {
      connectorId: _connectorId,
      installedAt: _installedAt,
      token: _token,
      ...config
    } = parsed as Record<string, unknown>;
    return config;
  } catch {
    return {};
  }
}

function removeClearedSavedConnectorConfig(
  savedConnectorConfig: Record<string, unknown>,
  rawUserConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...savedConnectorConfig };
  for (const [key, value] of Object.entries(rawUserConfig)) {
    if (value === undefined || value === null || value === "") {
      delete merged[key];
    }
  }
  return merged;
}

function compactConnectorConfigOverrides(rawUserConfig: Record<string, unknown>): Record<string, unknown> {
  const safeUserConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawUserConfig)) {
    if (value === undefined || value === null || value === "") continue;
    safeUserConfig[key] = value;
  }
  return safeUserConfig;
}

// ── Install connector ───────────────────────────────────────────────────────

export function installConnector(options: InstallOptions): InstallResult {
  if (!isValidConnectorId(options.connectorId)) {
    return {
      connectorId: options.connectorId,
      status: "error",
      message:
        `Invalid connector ID ${JSON.stringify(options.connectorId)}. ` +
        "Connector IDs must match [A-Za-z0-9][A-Za-z0-9._-]*.",
    };
  }

  const registry = loadRegistry();
  const manifest = registry.connectors.find((c) => c.id === options.connectorId);

  if (!manifest) {
    return {
      connectorId: options.connectorId,
      status: "error",
      message: `Unknown connector: ${options.connectorId}`,
    };
  }

  const existing = listConnectors().installed.find(
    (c) => c.connectorId === options.connectorId,
  );

  if (existing && !options.force) {
    let backfillNote = "";
    if (options.connectorId === "hermes") {
      try {
        const hermesJsonPath = path.join(getConnectorsDir(), "hermes.json");
        let parsed: Record<string, unknown> | null = null;
        try {
          const parsedRaw: unknown = JSON.parse(fs.readFileSync(hermesJsonPath, "utf8"));
          if (parsedRaw !== null && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)) {
            parsed = parsedRaw as Record<string, unknown>;
          }
        } catch {
          /* connector JSON unreadable — reconcile without a prior path */
        }
        const priorRaw = parsed?.pluginShimPath;
        const priorPersisted = typeof priorRaw === "string" && priorRaw.length > 0 ? priorRaw : null;
        const profileRaw = parsed?.profile;
        let currentConfigPath: string | null = null;
        let activeConfigHasBlock = false;
        let configResolutionError: string | null = null;
        try {
          currentConfigPath = hermesConfigPath(
            typeof profileRaw === "string" && profileRaw.length > 0 ? profileRaw : "default",
          );
          activeConfigHasBlock =
            fs.existsSync(currentConfigPath) &&
            /^remnic:/m.test(fs.readFileSync(currentConfigPath, "utf8"));
        } catch (resolveErr) {
          configResolutionError = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
          activeConfigHasBlock = false;
        }
        if (!activeConfigHasBlock) {
          backfillNote = configResolutionError
            ? ` Note: could not resolve the active Hermes home (${configResolutionError}) — skipped the shim backfill. ` +
              `Fix the HERMES_HOME/profile configuration and re-run.`
            : " Note: the active Hermes home's config.yaml has no remnic: block — skipped the shim backfill " +
              "so Hermes cannot discover an unconfigured provider. If Hermes was installed under a different " +
              "HERMES_HOME, re-run with --force to rewrite the config (and token) and migrate the shim " +
              "under the current home.";
          return {
            connectorId: options.connectorId,
            status: "already_installed",
            message: `Already installed. Use --force to reinstall.${backfillNote}`,
          };
        }
        const outcome = reconcileHermesShim(priorPersisted);
        if (outcome.notes.length > 0) {
          backfillNote = ` ${outcome.notes.join(" ")}`;
        }
        let configProvenanceAdded = false;
        if (
          parsed !== null &&
          currentConfigPath !== null &&
          (typeof parsed.hermesConfigPath !== "string" || parsed.hermesConfigPath.length === 0)
        ) {
          parsed.hermesConfigPath = currentConfigPath;
          configProvenanceAdded = true;
        }
        let shimPriorsChanged = false;
        const cleanedInheritedBackfillShims: string[] = [];
        if (parsed !== null) {
          const shimPriorCandidates: string[] = [];
          if (priorPersisted !== null) {
            shimPriorCandidates.push(priorPersisted);
          }
          if (Array.isArray(parsed.priorPluginShimPaths)) {
            for (const entry of parsed.priorPluginShimPaths) {
              if (typeof entry === "string" && entry.length > 0) {
                shimPriorCandidates.push(entry);
              }
            }
          }
          if (outcome.materializedAt !== null && shimPriorCandidates.length > 0) {
            const cleanupTargets = shimPriorCandidates.filter(
              (candidate) => outcome.persistPath === null || !sameShimTarget(candidate, outcome.persistPath),
            );
            if (cleanupTargets.length > 0) {
              try {
                const cleaned = removeHermesShim(cleanupTargets);
                cleanedInheritedBackfillShims.push(...cleaned.removedPaths);
              } catch {
                /* survivors below stay tracked */
              }
            }
          }
          const survivingShims = survivingMarkerShims(shimPriorCandidates, outcome.persistPath);
          const persistedShimPriors = Array.isArray(parsed.priorPluginShimPaths)
            ? parsed.priorPluginShimPaths
            : null;
          shimPriorsChanged =
            persistedShimPriors === null
              ? survivingShims.length > 0
              : persistedShimPriors.length !== survivingShims.length ||
                survivingShims.some((entry, index) => persistedShimPriors[index] !== entry);
          if (survivingShims.length > 0) {
            parsed.priorPluginShimPaths = survivingShims;
          } else {
            delete parsed.priorPluginShimPaths;
          }
        }
        const shimPathChanged =
          parsed !== null && outcome.persistPath !== null && parsed.pluginShimPath !== outcome.persistPath;
        if (parsed !== null && (shimPathChanged || configProvenanceAdded || shimPriorsChanged)) {
          if (outcome.persistPath !== null) {
            parsed.pluginShimPath = outcome.persistPath;
          }
          try {
            writeSecretFileSync(hermesJsonPath, JSON.stringify(parsed, null, 2));
          } catch (persistErr) {
            const rollbackFailures: string[] = [];
            if (
              outcome.materializedAt !== null &&
              outcome.createdNew &&
              (priorPersisted === null || !sameShimTarget(outcome.materializedAt, priorPersisted))
            ) {
              try {
                removeHermesShim([outcome.materializedAt]);
              } catch {
                rollbackFailures.push(`remove ${outcome.materializedAt} manually`);
              }
            }
            if (outcome.priorCleanedAt !== null) {
              try {
                materializeHermesShim(outcome.priorCleanedAt);
              } catch {
                rollbackFailures.push(`restore the shim at ${outcome.priorCleanedAt} manually`);
              }
            }
            for (const cleanedPath of cleanedInheritedBackfillShims) {
              if (outcome.priorCleanedAt !== null && sameShimTarget(cleanedPath, outcome.priorCleanedAt)) {
                continue;
              }
              try {
                materializeHermesShim(cleanedPath);
              } catch {
                rollbackFailures.push(`restore the shim at ${cleanedPath} manually`);
              }
            }
            const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
            backfillNote =
              rollbackFailures.length === 0
                ? ` Note: could not persist the shim path (${persistMsg}); shim changes were rolled back.`
                : ` Note: could not persist the shim path (${persistMsg}) and rollback was incomplete — ${rollbackFailures.join("; ")}.`;
          }
        }
      } catch {
        /* best-effort backfill — install status is unchanged */
      }
    }
    return {
      connectorId: options.connectorId,
      status: "already_installed",
      message: `Already installed. Use --force to reinstall.${backfillNote}`,
    };
  }

  const configDir = getConnectorsDir();
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `${options.connectorId}.json`);
  const savedConnectorConfig = existing ? readSavedConnectorConfig(configPath) : {};

  let hermesSavedProfile: string | undefined;
  let hermesSavedHost: string | undefined;
  let hermesSavedPort: number | undefined;
  let hermesSavedAllowInsecureHttp: boolean | undefined;
  let hermesResolvedProfile: string | undefined;
  let hermesResolvedHost: string | undefined;
  let hermesResolvedPort: number | undefined;
  let hermesResolvedAllowInsecureHttp = false;
  if (options.connectorId === "hermes") {
    if (fs.existsSync(configPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (prev?.profile != null) {
          try {
            hermesSavedProfile = sanitizeHermesProfile(String(prev.profile));
          } catch {
            // Invalid saved profile — fall through to default
          }
        }
        if (prev?.host != null) {
          try {
            hermesSavedHost = sanitizeHermesHost(String(prev.host));
          } catch {
            // Invalid saved host — fall through to default
          }
        }
        if (prev?.port != null) {
          try {
            const coercedPort = Number(String(prev.port));
            hermesSavedPort = sanitizeHermesPort(coercedPort);
          } catch {
            // Invalid saved port — fall through to default
          }
        }
        if (prev?.allow_insecure_http != null) {
          hermesSavedAllowInsecureHttp = coerceBool(prev.allow_insecure_http, "allow_insecure_http");
        }
      } catch {
        // Could not read existing config — fall through to defaults
      }
    }
    hermesResolvedProfile = hermesSavedProfile ?? "default";
    hermesResolvedHost = hermesSavedHost ?? "127.0.0.1";
    hermesResolvedAllowInsecureHttp = hermesSavedAllowInsecureHttp ?? false;

    if (options.config?.port !== undefined) {
      try {
        hermesResolvedPort = sanitizeHermesPort(Number(String(options.config.port)));
      } catch (err) {
        return {
          connectorId: options.connectorId,
          status: "error",
          message: `Invalid Hermes config: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (hermesResolvedPort === undefined) {
      hermesResolvedPort = hermesSavedPort ?? 4318;
    }

    if (options.config?.profile !== undefined) {
      try {
        hermesResolvedProfile = sanitizeHermesProfile(String(options.config.profile));
      } catch (err) {
        return {
          connectorId: options.connectorId,
          status: "error",
          message: `Invalid Hermes config: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (options.config?.host !== undefined) {
      try {
        hermesResolvedHost = sanitizeHermesHost(String(options.config.host));
      } catch (err) {
        return {
          connectorId: options.connectorId,
          status: "error",
          message: `Invalid Hermes config: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (options.config?.allow_insecure_http !== undefined) {
      const allowInsecureHttp = coerceBool(options.config.allow_insecure_http, "allow_insecure_http");
      if (allowInsecureHttp === undefined) {
        return {
          connectorId: options.connectorId,
          status: "error",
          message: "Invalid Hermes config: allow_insecure_http must be true or false",
        };
      }
      hermesResolvedAllowInsecureHttp = allowInsecureHttp;
    }
  }

  //
  //
  //
  //
  //
  const nonHermesPriorTokenStore = (options.connectorId !== "hermes" && manifest.requiresToken)
    ? loadTokenStore()
    : null;

  let tokenEntry: ReturnType<typeof generateToken> | null = null;
  if (options.connectorId === "hermes") {
    try {
      tokenEntry = buildTokenEntry(options.connectorId);
    } catch {
      // Non-fatal: fall through with tokenEntry === null.
    }
  } else if (manifest.requiresToken) {
    try {
      tokenEntry = generateToken(options.connectorId);
    } catch {
      //
      if (nonHermesPriorTokenStore !== null) {
        try {
          saveTokenStore(nonHermesPriorTokenStore);
        } catch {
          // Best-effort: snapshot restore failed; caller sees degraded install.
        }
      }
    }
  }

  if (options.connectorId !== "hermes" && manifest.requiresToken && tokenEntry === null) {
    return {
      connectorId: options.connectorId,
      status: "error",
      message:
        `${manifest.name} install aborted: token generation failed. ` +
        `Run \`remnic token generate ${options.connectorId}\` to create the token, then reinstall.`,
    };
  }

  //
  //
  const { token: _callerToken, ...rawUserConfig } = (options.config ?? {}) as Record<string, unknown>;
  const savedConnectorConfigForMerge = removeClearedSavedConnectorConfig(savedConnectorConfig, rawUserConfig);
  const safeUserConfig = compactConnectorConfigOverrides(rawUserConfig);
  const resolvedConfig: Record<string, unknown> = {
    ...savedConnectorConfigForMerge,
    ...safeUserConfig,
    connectorId: options.connectorId,
    installedAt: new Date().toISOString(),
    ...(hermesResolvedProfile !== undefined ? {
      profile: hermesResolvedProfile,
      host: hermesResolvedHost,
      port: hermesResolvedPort,
      allow_insecure_http: hermesResolvedAllowInsecureHttp,
    } : {}),
  };

  // The Hermes install sequence must be atomic: connector.json must only be
  // written if and only if both the YAML write AND the token-store commit
  // succeed. Partial failures must leave the prior state intact so the daemon
  // keeps working with the old token.
  //
  // Step order (all-or-nothing):
  //   a. Generate token candidate (buildTokenEntry, no store write yet).
  //   b. Validate profile (fail-fast).
  //   c. Write config.yaml via upsertHermesConfig — if skipped (missing dir)
  //      or throws, abort with status "error". Old token is NOT revoked.
  //   d. Commit new token to tokens.json — if this throws, rollback the YAML
  //      write (restore prior content or delete new file) and abort.
  //   e. Write connector.json only after both (c) and (d) succeed.
  //

  if (options.connectorId === "hermes") {
    const rawProfile = hermesResolvedProfile!;
    const hermesHost = hermesResolvedHost!;
    const hermesPort = hermesResolvedPort!;

    let hermesProfile: string;
    try {
      hermesProfile = sanitizeHermesProfile(rawProfile);
    } catch (err) {
      return {
        connectorId: options.connectorId,
        status: "error",
        message: `Hermes install aborted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!tokenEntry) {
      return {
        connectorId: options.connectorId,
        status: "error",
        message:
          "Hermes install aborted: token store unavailable. " +
          "Run `remnic token generate hermes` then reinstall to complete setup.",
      };
    }

    {
      const envHermesHome = readEnvVar("HERMES_HOME");
      if (typeof envHermesHome === "string" && envHermesHome.trim().length > 0) {
        try {
          fs.mkdirSync(path.dirname(hermesConfigPath(hermesProfile)), { recursive: true });
        } catch {
          /* resolution or mkdir failure — the config write below reports it */
        }
      }
    }

    let yamlResult: HermesConfigResult;
    try {
      yamlResult = upsertHermesConfig({
        profile: hermesProfile,
        host: hermesHost,
        port: hermesPort,
        token: tokenEntry.token,
        allowInsecureHttp: hermesResolvedAllowInsecureHttp,
      });
    } catch (err) {
      return {
        connectorId: options.connectorId,
        status: "error",
        message: `Hermes install aborted: config.yaml write failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!yamlResult.updated) {
      return {
        connectorId: options.connectorId,
        status: "error",
        message: `Hermes install aborted: ${yamlResult.reason ?? "config.yaml not written"}. ` +
          `Create the Hermes profile directory first, then reinstall.`,
      };
    }

    //
    const priorTokenStore = loadTokenStore();
    let committed = false;
    try {
      commitTokenEntry(tokenEntry);
      committed = true;
    } catch (commitErr) {
      let tokensRolledBack = true;
      let tokensRollbackErrMsg = "";
      try {
        saveTokenStore(priorTokenStore);
      } catch (tokenRestoreErr) {
        tokensRolledBack = false;
        tokensRollbackErrMsg = tokenRestoreErr instanceof Error ? tokenRestoreErr.message : String(tokenRestoreErr);
      }
      let yamlRolledBack = true;
      let yamlRollbackErrMsg = "";
      try {
        if (yamlResult.priorContent === null) {
          fs.unlinkSync(yamlResult.configPath);
        } else if (typeof yamlResult.priorContent === "string") {
          writeSecretFileSync(yamlResult.configPath, yamlResult.priorContent);
        }
      } catch (yamlRestoreErr) {
        yamlRolledBack = false;
        yamlRollbackErrMsg = yamlRestoreErr instanceof Error ? yamlRestoreErr.message : String(yamlRestoreErr);
      }
      const commitErrMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      let message: string;
      if (tokensRolledBack && yamlRolledBack) {
        message =
          `Hermes install failed during token commit — ` +
          `${commitErrMsg}. ` +
          `config.yaml and tokens.json restored to prior state. ` +
          `Resolve the tokens.json access issue, then reinstall.`;
      } else if (!yamlRolledBack && tokensRolledBack) {
        message =
          `Hermes install failed during token commit — ` +
          `${commitErrMsg}. ` +
          `tokens.json restored but config.yaml rollback ALSO failed ` +
          `(${yamlRollbackErrMsg}). ` +
          `Hermes daemon may be in an inconsistent state: config references a stale token. ` +
          `Manually inspect ${yamlResult.configPath} and reinstall.`;
      } else if (yamlRolledBack && !tokensRolledBack) {
        message =
          `Hermes install failed during token commit — ` +
          `${commitErrMsg}. ` +
          `config.yaml restored but tokens.json rollback ALSO failed ` +
          `(${tokensRollbackErrMsg}). ` +
          `Hermes daemon may be in an inconsistent state: tokens.json is corrupt or incomplete. ` +
          `Manually inspect ~/.remnic/tokens.json and reinstall.`;
      } else {
        message =
          `Hermes install failed during token commit — ` +
          `${commitErrMsg}. ` +
          `BOTH rollbacks failed: config.yaml rollback failed (${yamlRollbackErrMsg}); ` +
          `tokens.json rollback failed (${tokensRollbackErrMsg}). ` +
          `Hermes daemon is likely in an inconsistent state. ` +
          `Manually inspect ${yamlResult.configPath} ` +
          `and ~/.remnic/tokens.json, then reinstall.`;
      }
      return {
        connectorId: options.connectorId,
        status: "error",
        message,
      };
    }

    const priorShimPathRaw = savedConnectorConfig.pluginShimPath;
    const shimOutcome = reconcileHermesShim(
      typeof priorShimPathRaw === "string" && priorShimPathRaw.length > 0 ? priorShimPathRaw : null,
    );
    if (shimOutcome.persistPath !== null) {
      resolvedConfig.pluginShimPath = shimOutcome.persistPath;
    }
    const cleanedInheritedShims: string[] = [];
    {
      const shimPriorCandidates: string[] = [];
      if (typeof priorShimPathRaw === "string" && priorShimPathRaw.length > 0) {
        shimPriorCandidates.push(priorShimPathRaw);
      }
      const inheritedShimPriorsRaw = savedConnectorConfig.priorPluginShimPaths;
      if (Array.isArray(inheritedShimPriorsRaw)) {
        for (const entry of inheritedShimPriorsRaw) {
          if (typeof entry === "string" && entry.length > 0) {
            shimPriorCandidates.push(entry);
          }
        }
      }
      if (shimOutcome.materializedAt !== null && shimPriorCandidates.length > 0) {
        const cleanupTargets = shimPriorCandidates.filter(
          (candidate) => shimOutcome.persistPath === null || !sameShimTarget(candidate, shimOutcome.persistPath),
        );
        if (cleanupTargets.length > 0) {
          try {
            const cleaned = removeHermesShim(cleanupTargets);
            cleanedInheritedShims.push(...cleaned.removedPaths);
          } catch {
            /* survivors below stay tracked */
          }
        }
      }
      const survivingShims = survivingMarkerShims(shimPriorCandidates, shimOutcome.persistPath);
      if (survivingShims.length > 0) {
        resolvedConfig.priorPluginShimPaths = survivingShims;
      } else {
        delete resolvedConfig.priorPluginShimPaths;
      }
    }

    // Persist the config.yaml location used at install time (it honors the
    resolvedConfig.hermesConfigPath = yamlResult.configPath;

    const hermesPriorNotes: string[] = [];
    const priorConfigPathRaw = savedConnectorConfig.hermesConfigPath;
    const priorConfigPath =
      typeof priorConfigPathRaw === "string" && priorConfigPathRaw.length > 0 ? priorConfigPathRaw : null;
    const priorConfigDiffers =
      priorConfigPath !== null && !sameHermesConfigTarget(priorConfigPath, yamlResult.configPath);
    const hermesPriorConfigMutations: Array<{ mutatedPath: string; priorContent: string }> = [];
    if (priorConfigDiffers && priorConfigPath !== null && shimOutcome.materializedAt === null) {
      // file's other remnic: sub-keys.
      let fallbackDetail = "";
      if (isPlausibleHermesConfigPath(priorConfigPath)) {
        try {
          const beforeRefresh = fs.readFileSync(priorConfigPath, "utf8");
          const refresh = upsertHermesConfigAt(priorConfigPath, {
            host: hermesHost,
            port: hermesPort,
            token: tokenEntry.token,
            allowInsecureHttp: hermesResolvedAllowInsecureHttp,
          });
          if (refresh.updated) {
            hermesPriorConfigMutations.push({ mutatedPath: priorConfigPath, priorContent: beforeRefresh });
          }
          fallbackDetail = refresh.updated
            ? " Its remnic: block was refreshed with the newly-issued token so it keeps working."
            : ` Note: its token could not be refreshed (${refresh.reason ?? "config not writable"}) — re-run install with HERMES_HOME pointing there to restore daemon auth.`;
        } catch (refreshErr) {
          fallbackDetail = ` Note: its token could not be refreshed (${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}) — re-run install with HERMES_HOME pointing there to restore daemon auth.`;
        }
      } else {
        fallbackDetail =
          " Note: its token was rotated by this install — re-run install with HERMES_HOME pointing there to restore daemon auth.";
      }
      hermesPriorNotes.push(
        `Note: left the prior-install Hermes config in place at ${priorConfigPath} — ` +
          `no Remnic shim could be written under the current Hermes home, so the prior ` +
          `installation remains the working fallback.${fallbackDetail} Resolve the shim ` +
          `collision/failure above and re-run with --force to complete the migration.`,
      );
    }
    {
      const candidates: string[] = [];
      if (priorConfigDiffers && priorConfigPath !== null) {
        candidates.push(priorConfigPath);
      }
      const inheritedArrayRaw = savedConnectorConfig.priorHermesConfigPaths;
      if (Array.isArray(inheritedArrayRaw)) {
        for (const entry of inheritedArrayRaw) {
          if (typeof entry === "string" && entry.length > 0) {
            candidates.push(entry);
          }
        }
      }
      // Legacy single-path key from earlier builds of this branch.
      const inheritedLegacyRaw = savedConnectorConfig.priorHermesConfigPath;
      if (typeof inheritedLegacyRaw === "string" && inheritedLegacyRaw.length > 0) {
        candidates.push(inheritedLegacyRaw);
      }
      if (shimOutcome.materializedAt !== null) {
        for (const candidate of candidates) {
          if (sameHermesConfigTarget(candidate, yamlResult.configPath)) {
            continue;
          }
          if (!isPlausibleHermesConfigPath(candidate)) {
            continue;
          }
          try {
            const beforeCleanup = fs.readFileSync(candidate, "utf8");
            const cleanup = removeHermesConfigFile(candidate);
            if (cleanup.updated) {
              hermesPriorConfigMutations.push({ mutatedPath: candidate, priorContent: beforeCleanup });
              hermesPriorNotes.push(`Cleaned remnic: block from prior-install Hermes config: ${candidate}`);
            }
          } catch {
            hermesPriorNotes.push(
              `Note: could not clean the remnic: block from the prior-install Hermes config at ${candidate} — remove it manually.`,
            );
          }
        }
      }
      const survivingPriors: string[] = [];
      for (const candidate of candidates) {
        if (sameHermesConfigTarget(candidate, yamlResult.configPath)) {
          continue;
        }
        if (survivingPriors.some((kept) => sameHermesConfigTarget(kept, candidate))) {
          continue;
        }
        let blockSurvives = false;
        try {
          blockSurvives = /^remnic:/m.test(fs.readFileSync(candidate, "utf8"));
        } catch {
          blockSurvives = false;
        }
        if (blockSurvives) {
          survivingPriors.push(candidate);
        }
      }
      if (survivingPriors.length > 0) {
        resolvedConfig.priorHermesConfigPaths = survivingPriors;
      } else {
        delete resolvedConfig.priorHermesConfigPaths;
      }
      // The legacy single-path key never survives a rewrite.
      delete resolvedConfig.priorHermesConfigPath;
    }

    try {
      writeSecretFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));
    } catch (writeErr) {
      let tokenRollbackFailed = false;
      let tokenRollbackMsg = "token store restored to pre-install snapshot";
      try {
        saveTokenStore(priorTokenStore);
      } catch (tokenRestoreErr) {
        tokenRollbackFailed = true;
        tokenRollbackMsg = `token rollback failed: ${tokenRestoreErr instanceof Error ? tokenRestoreErr.message : String(tokenRestoreErr)}`;
      }
      let yamlRollbackMsg = "config.yaml restored";
      try {
        if (yamlResult.priorContent === null) {
          let unlinkSucceeded = false;
          let unlinkErr: unknown;
          try {
            fs.unlinkSync(yamlResult.configPath);
            unlinkSucceeded = true;
          } catch (err) {
            unlinkErr = err;
          }
          if (unlinkSucceeded) {
            yamlRollbackMsg = "config.yaml removed (was newly created)";
          } else {
            const unlinkMsg = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
            yamlRollbackMsg = `config.yaml rollback failed: could not remove newly-created file — ${unlinkMsg}`;
          }
        } else if (typeof yamlResult.priorContent === "string") {
          writeSecretFileSync(yamlResult.configPath, yamlResult.priorContent);
          yamlRollbackMsg = "config.yaml restored to prior content";
        }
      } catch (yamlRollbackErr) {
        yamlRollbackMsg = `config.yaml rollback failed: ${yamlRollbackErr instanceof Error ? yamlRollbackErr.message : String(yamlRollbackErr)}`;
      }
      let shimRollbackMsg = "no shim changes to roll back";
      const shimRollbackFailures: string[] = [];
      const priorPersisted =
        typeof priorShimPathRaw === "string" && priorShimPathRaw.length > 0 ? priorShimPathRaw : null;
      if (
        shimOutcome.materializedAt !== null &&
        shimOutcome.createdNew &&
        (priorPersisted === null || !sameShimTarget(shimOutcome.materializedAt, priorPersisted))
      ) {
        try {
          removeHermesShim([shimOutcome.materializedAt]);
        } catch (err) {
          shimRollbackFailures.push(
            `could not remove the newly-written shim at ${shimOutcome.materializedAt} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      if (shimOutcome.priorCleanedAt !== null) {
        try {
          materializeHermesShim(shimOutcome.priorCleanedAt);
        } catch (err) {
          shimRollbackFailures.push(
            `could not restore the prior shim at ${shimOutcome.priorCleanedAt} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      for (const cleanedPath of cleanedInheritedShims) {
        if (shimOutcome.priorCleanedAt !== null && sameShimTarget(cleanedPath, shimOutcome.priorCleanedAt)) {
          continue;
        }
        try {
          materializeHermesShim(cleanedPath);
        } catch (err) {
          shimRollbackFailures.push(
            `could not restore the prior shim at ${cleanedPath} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      if (
        shimOutcome.materializedAt !== null ||
        shimOutcome.priorCleanedAt !== null ||
        cleanedInheritedShims.length > 0
      ) {
        shimRollbackMsg =
          shimRollbackFailures.length === 0
            ? "plugin shim changes rolled back"
            : `plugin shim rollback incomplete: ${shimRollbackFailures.join("; ")}`;
      }
      let priorConfigRollbackMsg = "no prior-config changes to roll back";
      if (hermesPriorConfigMutations.length > 0) {
        const priorConfigRollbackFailures: string[] = [];
        for (const mutation of [...hermesPriorConfigMutations].reverse()) {
          try {
            writeSecretFileSync(mutation.mutatedPath, mutation.priorContent);
          } catch (restoreErr) {
            priorConfigRollbackFailures.push(
              `could not restore ${mutation.mutatedPath} (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)})`,
            );
          }
        }
        priorConfigRollbackMsg =
          priorConfigRollbackFailures.length === 0
            ? "prior-install config(s) restored"
            : `prior-install config rollback incomplete: ${priorConfigRollbackFailures.join("; ")}`;
      }
      const urgentSuffix = tokenRollbackFailed
        ? ` tokens.json may be in an inconsistent state — manually restore hermes token with 'remnic token generate hermes'.`
        : "";
      return {
        connectorId: options.connectorId,
        status: "error",
        message:
          `Hermes install aborted: connector config write failed — ` +
          `connector directory may not be writable. ` +
          `Rollback: ${tokenRollbackMsg}; ${yamlRollbackMsg}; ${shimRollbackMsg}; ${priorConfigRollbackMsg}.` +
          `${urgentSuffix} Resolve the permission issue, then reinstall.`,
      };
    }

    const notes: string[] = [];
    notes.push(`Updated Hermes config: ${yamlResult.configPath}`);

    notes.push(...shimOutcome.notes);
    notes.push(...hermesPriorNotes);
    notes.push(
      "Next step: set `memory.provider: remnic` (and `memory_enabled: true`) in your Hermes config.yaml to activate the provider.",
    );

    if (hermesProfile === "default") {
      const legacyDefaultConfigPath = hermesDefaultProfileConfigPath();
      if (!sameHermesConfigTarget(yamlResult.configPath, legacyDefaultConfigPath)) {
        try {
          const legacyDefaultCleanResult = removeHermesConfigFile(legacyDefaultConfigPath);
          if (legacyDefaultCleanResult.updated) {
            notes.push(`Cleaned stale remnic: block from legacy default profile: ${legacyDefaultConfigPath}`);
          }
        } catch {
          notes.push("Note: could not clean stale remnic: block from legacy default profile");
        }
      }
    }

    let oldProfileResolvesToDifferentFile = false;
    if (hermesSavedProfile !== undefined) {
      try {
        oldProfileResolvesToDifferentFile =
          !sameHermesConfigTarget(hermesConfigPath(hermesSavedProfile), hermesConfigPath(hermesProfile));
      } catch {
        oldProfileResolvesToDifferentFile = false;
      }
    }
    if (oldProfileResolvesToDifferentFile) {
      try {
        const oldCleanResult = removeHermesConfig({ profile: hermesSavedProfile! });
        if (oldCleanResult.updated) {
          notes.push(`Cleaned stale remnic: block from previous profile: ${oldCleanResult.configPath}`);
        }
      } catch {
        notes.push(`Note: could not clean stale remnic: block from previous profile "${hermesSavedProfile}"`);
      }
    }

    if (committed && tokenEntry) {
      const daemonOk = checkDaemonHealth(
        hermesHost,
        hermesPort,
        tokenEntry.token,
        hermesResolvedAllowInsecureHttp,
      );
      if (daemonOk) {
        notes.push("Daemon health check: OK");
      } else {
        notes.push(
          `Daemon not reachable at ${hermesHost}:${hermesPort} — start with: remnic daemon start`,
        );
      }
    }

    const suffix = notes.length > 0 ? `\n  ${notes.join("\n  ")}` : "";
    return {
      connectorId: options.connectorId,
      status: "installed",
      configPath,
      message: `Installed ${manifest.name} v${manifest.version}${suffix}`,
    };
  }


  let extensionMessage = "";
  let extensionInstalled = false;
  // Holds the commit/rollback handle returned by installCodexMemoryExtension().
  // The backup of any prior extension is kept alive until commit() is called.
  let extensionHandle: { commit(): void; rollback(): void } | null = null;
  if (options.connectorId === "codex-cli") {
    const coerced = coerceInstallExtension(resolvedConfig.installExtension);
    if (coerced !== undefined) {
      resolvedConfig.installExtension = coerced;
    }
    const shouldInstall = resolvedConfig.installExtension !== false;
    resolvedConfig.installExtension = shouldInstall;
    const codexHomeOverride =
      typeof resolvedConfig.codexHome === "string" && resolvedConfig.codexHome.length > 0
        ? (resolvedConfig.codexHome as string)
        : null;
    const resolvedCodexHome = resolveCodexHome(codexHomeOverride);
    resolvedConfig.codexHome = resolvedCodexHome;

    if (shouldInstall) {
      try {
        const extensionSourceOverride =
          typeof resolvedConfig.extensionSourceDir === "string" &&
          resolvedConfig.extensionSourceDir.length > 0
            ? (resolvedConfig.extensionSourceDir as string)
            : null;
        const extResult = installCodexMemoryExtension({
          codexHome: resolvedCodexHome,
          sourceDir: extensionSourceOverride,
        });
        extensionMessage = ` (memory extension: ${extResult.remnicExtensionDir})`;
        extensionInstalled = true;
        extensionHandle = extResult;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown error";
        // tokens.json before reaching this point. The extension threw, so no
        // connector.json was written — roll back the token store to the
        // pre-install snapshot so tokens.json and the absent connector.json
        //
        // For connectors without requiresToken the rollback block is skipped
        // entirely, so the suffix must remain absent — not "Token has been
        // rolled back." (which would be factually incorrect).
        let extensionErrTokenRolledBack = false;
        let extensionErrTokenRollbackMsg = "";
        if (tokenEntry !== null && nonHermesPriorTokenStore !== null) {
          try {
            saveTokenStore(nonHermesPriorTokenStore);
            extensionErrTokenRolledBack = true;
          } catch (tokenRestoreErr) {
            extensionErrTokenRolledBack = false;
            extensionErrTokenRollbackMsg =
              tokenRestoreErr instanceof Error ? tokenRestoreErr.message : String(tokenRestoreErr);
          }
        }
        const tokenRollbackSuffix = manifest.requiresToken
          ? extensionErrTokenRolledBack
            ? " Token has been rolled back."
            : ` Token rollback FAILED (${extensionErrTokenRollbackMsg}) — tokens.json may contain an orphaned entry. ` +
              `Manually inspect ~/.remnic/tokens.json and reinstall.`
          : "";
        return {
          connectorId: options.connectorId,
          status: "error",
          message: `Memory extension install failed — ${errMsg}.${tokenRollbackSuffix} Resolve the issue, then reinstall.`,
        };
      }
    } else {
      extensionMessage = " (memory extension: skipped via installExtension=false)";
    }
  }

  //
  //
  let weCloneProxyHandleRollback: (() => void) | null = null;
  if (options.connectorId === "weclone") {
    try {
      let proxyConfigPath: string | null = null;
      if (existing && fs.existsSync(configPath)) {
        try {
          const savedRegistryConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
          if (
            typeof savedRegistryConfig.proxyConfigPath === "string" &&
            savedRegistryConfig.proxyConfigPath.length > 0
          ) {
            proxyConfigPath = savedRegistryConfig.proxyConfigPath;
          }
        } catch {
          // Saved registry config unreadable — fall through to env resolution.
        }
      }
      if (proxyConfigPath === null) {
        proxyConfigPath = resolveWeCloneProxyConfigPath();
      }
      const prior = readWeCloneProxyConfigIfExists(proxyConfigPath);
      const proxyConfig = buildWeCloneProxyConfig({
        userConfig: safeUserConfig,
        priorConfig: prior ? safeParseJson(prior) : null,
        authToken: tokenEntry?.token,
      });
      fs.mkdirSync(path.dirname(proxyConfigPath), { recursive: true });
      // we can always restore prior content (or delete a newly-created file)
      // even if the write itself throws.
      weCloneProxyHandleRollback = () => {
        try {
          if (prior === null) {
            if (fs.existsSync(proxyConfigPath)) {
              fs.unlinkSync(proxyConfigPath);
            }
          } else {
            writeSecretFileSync(proxyConfigPath, prior);
          }
        } catch {
          // Best-effort rollback.
        }
      };
      try {
        writeSecretFileSync(
          proxyConfigPath,
          JSON.stringify(proxyConfig, null, 2),
        );
      } catch (writeErr) {
        try {
          weCloneProxyHandleRollback();
        } catch {
          // Best-effort.
        }
        weCloneProxyHandleRollback = null;
        throw writeErr;
      }
      resolvedConfig.proxyConfigPath = proxyConfigPath;
      resolvedConfig.proxyPort = proxyConfig.proxyPort;
      resolvedConfig.wecloneApiUrl = proxyConfig.wecloneApiUrl;
      resolvedConfig.remnicDaemonUrl = proxyConfig.remnicDaemonUrl;
      resolvedConfig.sessionStrategy = proxyConfig.sessionStrategy;
    } catch (weCloneErr) {
      let tokenRolledBack = false;
      let tokenRollbackMsg = "";
      if (tokenEntry !== null && nonHermesPriorTokenStore !== null) {
        try {
          saveTokenStore(nonHermesPriorTokenStore);
          tokenRolledBack = true;
        } catch (tokenRestoreErr) {
          tokenRolledBack = false;
          tokenRollbackMsg =
            tokenRestoreErr instanceof Error ? tokenRestoreErr.message : String(tokenRestoreErr);
        }
      }
      const tokenSuffix = manifest.requiresToken && tokenEntry !== null
        ? tokenRolledBack
          ? " Token has been rolled back."
          : ` Token rollback FAILED (${tokenRollbackMsg}) — tokens.json may contain an orphaned entry. ` +
            `Manually inspect ~/.remnic/tokens.json and reinstall.`
        : "";
      return {
        connectorId: options.connectorId,
        status: "error",
        message:
          `WeClone install aborted: proxy config write failed — ` +
          `${weCloneErr instanceof Error ? weCloneErr.message : String(weCloneErr)}.` +
          `${tokenSuffix} Resolve the write permission issue on ~/.remnic/connectors/, then reinstall.`,
      };
    }
  }

  let droidMcpRollback: (() => void) | null = null;
  if (options.connectorId === "droid") {
    const stepResult = droidInstallStep(
      tokenEntry?.token,
      resolvedConfig,
      manifest.requiresToken ?? false,
      tokenEntry,
      nonHermesPriorTokenStore,
      saveTokenStore,
    );
    if (!stepResult.ok) {
      return { connectorId: options.connectorId, status: "error", message: stepResult.errorMessage };
    }
    droidMcpRollback = stepResult.rollback;
    resolvedConfig.factoryMcpPath = stepResult.mcpPath;
  }

  const INTERNAL_KEYS_DENYLIST = [
    "extensionSourceDir", // test-only override for the plugin-codex source path
  ];
  for (const key of INTERNAL_KEYS_DENYLIST) {
    delete resolvedConfig[key];
  }

  //
  try {
    writeSecretFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));
  } catch (writeErr) {
    //
    // Initialize to false: only set true once saveTokenStore() succeeds.
    let configWriteTokenRolledBack = false;
    let configWriteTokenRollbackMsg = "";
    if (tokenEntry !== null && nonHermesPriorTokenStore !== null) {
      try {
        saveTokenStore(nonHermesPriorTokenStore);
        configWriteTokenRolledBack = true;
      } catch (tokenRestoreErr) {
        configWriteTokenRolledBack = false;
        configWriteTokenRollbackMsg =
          tokenRestoreErr instanceof Error ? tokenRestoreErr.message : String(tokenRestoreErr);
      }
    }
    if (extensionInstalled && extensionHandle !== null) {
      try {
        extensionHandle.rollback();
      } catch {
        console.warn(
          "[remnic/connectors] installConnector: config write failed and extension rollback also failed — " +
            "manual cleanup of memories_extensions/remnic may be required.",
        );
      }
    }
    if (weCloneProxyHandleRollback !== null) {
      try {
        weCloneProxyHandleRollback();
      } catch {
        // Best-effort rollback.
      }
    }
    if (droidMcpRollback !== null) {
      try {
        droidMcpRollback();
      } catch {
        // Best-effort rollback.
      }
    }
    const configWriteTokenSuffix = manifest.requiresToken && tokenEntry !== null
      ? configWriteTokenRolledBack
        ? " Token has been rolled back."
        : ` Token rollback FAILED (${configWriteTokenRollbackMsg}) — tokens.json may contain an orphaned entry. ` +
          `Manually inspect ~/.remnic/tokens.json and reinstall.`
      : "";
    return {
      connectorId: options.connectorId,
      status: "error",
      message:
        `${manifest.name} install aborted: connector config write failed — ` +
        `${writeErr instanceof Error ? writeErr.message : String(writeErr)}.` +
        `${configWriteTokenSuffix} Resolve the write permission issue, then reinstall.`,
    };
  }

  if (extensionInstalled && extensionHandle !== null) {
    extensionHandle.commit();
  }

  return {
    connectorId: options.connectorId,
    status: "installed",
    configPath,
    message: `Installed ${manifest.name} v${manifest.version}${extensionMessage}`,
  };
}


export function removeConnector(connectorId: string): RemoveResult {
  const configDir = getConnectorsDir();
  if (!isValidConnectorId(connectorId)) {
    return {
      connectorId,
      configPath: configDir,
      status: "skipped",
      reason: "invalid-connector-id",
      message:
        `Removal aborted: invalid connector ID ${JSON.stringify(connectorId)}. ` +
        "Connector IDs must match [A-Za-z0-9][A-Za-z0-9._-]*.",
    };
  }
  const configPath = path.join(configDir, `${connectorId}.json`);

  let codexHomeOverride: string | null = null;
  let savedInstallExtension: boolean | undefined = undefined;
  let configParsed = false;
  if (connectorId === "codex-cli" && fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      configParsed = true;
      if (typeof parsed.codexHome === "string" && parsed.codexHome.length > 0) {
        codexHomeOverride = parsed.codexHome;
      }
      const coerced = coerceInstallExtension(parsed.installExtension);
      if (coerced !== undefined) {
        savedInstallExtension = coerced;
      }
    } catch {
      console.debug(
        "[remnic/connectors] removeConnector: codex-cli.json parse failed — skipping extension removal to avoid touching unverified paths",
      );
    }
  }

  let savedHermesShimPath: string | null = null;
  let savedHermesConfigPath: string | null = null;
  const savedPriorHermesConfigPaths: string[] = [];
  const savedPriorHermesShimPaths: string[] = [];
  if (connectorId === "hermes" && fs.existsSync(configPath)) {
    try {
      const parsedRaw: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsedRaw === null || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
        throw new Error("hermes.json is not a JSON object");
      }
      const parsed = parsedRaw as Record<string, unknown>;
      if (typeof parsed.pluginShimPath === "string" && parsed.pluginShimPath.length > 0) {
        savedHermesShimPath = parsed.pluginShimPath;
      }
      if (Array.isArray(parsed.priorPluginShimPaths)) {
        for (const entry of parsed.priorPluginShimPaths) {
          if (typeof entry === "string" && entry.length > 0) {
            savedPriorHermesShimPaths.push(entry);
          }
        }
      }
      if (typeof parsed.hermesConfigPath === "string" && parsed.hermesConfigPath.length > 0) {
        savedHermesConfigPath = parsed.hermesConfigPath;
      }
      // Array provenance (round 13) plus the legacy single-path key from
      // earlier builds of this branch.
      if (Array.isArray(parsed.priorHermesConfigPaths)) {
        for (const entry of parsed.priorHermesConfigPaths) {
          if (typeof entry === "string" && entry.length > 0) {
            savedPriorHermesConfigPaths.push(entry);
          }
        }
      }
      if (typeof parsed.priorHermesConfigPath === "string" && parsed.priorHermesConfigPath.length > 0) {
        savedPriorHermesConfigPaths.push(parsed.priorHermesConfigPath);
      }
    } catch {
      // Fail closed, mirroring the codex-cli provenance guard: a malformed
      return {
        connectorId,
        configPath,
        status: "error",
        message:
          `Removal aborted: ${configPath} is malformed and cannot be parsed. ` +
          `It records where the Hermes plugin shim was installed; removing the connector without it ` +
          `could orphan the shim. Fix or delete the file (and remove any ` +
          `plugins/remnic/__init__.py under your Hermes home manually), then re-run removal.`,
      };
    }
  }

  if (!fs.existsSync(configPath)) {
    // cleanup (e.g. connector JSON deleted manually or XDG_CONFIG_HOME change).
    // the connector appears "not installed" to the caller.
    let staleTokenRevoked = false;
    try {
      staleTokenRevoked = revokeToken(connectorId);
    } catch {
      // Best-effort: token store may be missing or read-only; do not mask the
      // not_found signal to the caller.
    }
    const message = staleTokenRevoked
      ? `${connectorId} is not installed. Removed stale token entry for ${connectorId}.`
      : "Not installed";
    return {
      connectorId,
      configPath,
      status: "not_found",
      message,
    };
  }

  let storedProfile = "default";
  if (connectorId === "hermes") {
    try {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof stored?.profile === "string") storedProfile = stored.profile;
    } catch {
      // use default profile
    }
  }

  //
  let weCloneProxyConfigPath: string | null = null;
  let weCloneRegistryParseFailed = false;
  if (connectorId === "weclone") {
    try {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (typeof stored.proxyConfigPath === "string" && stored.proxyConfigPath.length > 0) {
        weCloneProxyConfigPath = stored.proxyConfigPath;
      }
    } catch {
      weCloneRegistryParseFailed = true;
    }
    if (weCloneProxyConfigPath === null && !weCloneRegistryParseFailed) {
      try {
        weCloneProxyConfigPath = resolveWeCloneProxyConfigPath();
      } catch {
        // Resolution failed (e.g. no HOME) — leave null; cleanup block skips.
      }
    }
  }

  let droidMcpConfigPath: string | null = null;
  let droidRegistryParseFailed = false;
  if (connectorId === "droid") {
    const prov = readDroidMcpProvenance(configPath);
    droidMcpConfigPath = prov.mcpConfigPath;
    droidRegistryParseFailed = prov.registryParseFailed;
  }
  if (connectorId === "droid" && droidRegistryParseFailed) {
    console.warn(`[remnic/connectors] removeConnector: droid.json malformed — aborting. Fix or delete ${configPath} manually and retry.`);
    return { connectorId, configPath, message: "Removal aborted: droid.json is malformed. Registry config left in place.", status: "skipped", reason: "config-parse-failed" };
  }

  if (connectorId === "weclone" && weCloneRegistryParseFailed) {
    console.warn(
      "[remnic/connectors] removeConnector: weclone.json is malformed — " +
        "aborting removal to preserve provenance. Fix or delete " +
        configPath +
        " manually and retry.",
    );
    return {
      connectorId,
      configPath,
      message:
        "Removal aborted: weclone.json is malformed. Registry config left in place for inspection; " +
        "proxy config NOT removed.",
      status: "skipped",
      reason: "config-parse-failed",
    };
  }

  if (connectorId === "codex-cli" && fs.existsSync(configPath) && !configParsed) {
    console.warn(
      "[remnic/connectors] removeConnector: codex-cli.json is malformed — " +
        "aborting removal to preserve provenance. Fix or delete " +
        configPath +
        " manually and retry.",
    );
    return {
      connectorId,
      configPath,
      message: "Removal aborted: codex-cli.json is malformed. Config file left in place for inspection.",
      status: "skipped",
      reason: "config-parse-failed",
    };
  }

  let extensionMessage = "";
  if (connectorId === "codex-cli") {
    if (savedInstallExtension === false) {
      extensionMessage = " (memory extension: skipped — installExtension=false)";
    // Finding 3: require EXPLICIT provenance (installExtension===true AND a saved
    // codexHome) before removing the extension. Legacy configs that pre-date this
    // feature have no installExtension key, so savedInstallExtension is undefined;
    // without provenance we cannot be sure Remnic ever owned the directory.
    } else if (savedInstallExtension !== true || codexHomeOverride === null) {
      extensionMessage = " (memory extension: skipped — no install provenance in saved config)";
    } else {
      const extResult = removeCodexMemoryExtension({ codexHome: codexHomeOverride });
      extensionMessage = extResult.removed
        ? ` (memory extension removed: ${extResult.remnicExtensionDir})`
        : " (no memory extension present)";
    }
  }

  if (connectorId === "hermes") {
    const preflightCandidates: string[] = [];
    try {
      preflightCandidates.push(...hermesConfigCleanupPaths(storedProfile));
    } catch {
      /* current-environment resolution failed — persisted paths still checked */
    }
    if (savedHermesConfigPath !== null && isPlausibleHermesConfigPath(savedHermesConfigPath)) {
      preflightCandidates.push(savedHermesConfigPath);
    }
    preflightCandidates.push(...savedPriorHermesConfigPaths.filter(isPlausibleHermesConfigPath));
    const uniqueCandidates: string[] = [];
    for (const candidate of preflightCandidates) {
      if (!uniqueCandidates.some((kept) => sameHermesConfigTarget(kept, candidate))) {
        uniqueCandidates.push(candidate);
      }
    }
    const blocked: string[] = [];
    for (const candidate of uniqueCandidates) {
      let needsCleanup = false;
      try {
        needsCleanup = /^remnic:/m.test(fs.readFileSync(candidate, "utf8"));
      } catch {
        needsCleanup = false; // missing/unreadable — cleanup will skip it
      }
      if (!needsCleanup) {
        continue;
      }
      try {
        assertConfigComponentsNotSymlinked(candidate);
      } catch {
        blocked.push(`${candidate} (symlinked path component)`);
        continue;
      }
      try {
        fs.accessSync(candidate, fs.constants.W_OK);
        fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      } catch {
        blocked.push(`${candidate} (not writable)`);
      }
    }
    if (blocked.length > 0) {
      return {
        connectorId,
        configPath,
        status: "error",
        message:
          `Hermes remove aborted: the following config.yaml path(s) hold a remnic: block but cannot be cleaned: ` +
          `${blocked.join(", ")}. The connector registry entry, provenance, and token were left untouched — ` +
          `fix the permissions or resolve the symlink and re-run removal.`,
      };
    }
  }

  try {
    fs.unlinkSync(configPath);
  } catch (unlinkErr) {
    const sanitizedErr = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
    return {
      connectorId,
      configPath,
      status: "error",
      message:
        `${connectorId} remove aborted: could not delete connector file (${sanitizedErr}). ` +
        `Token and any connector-specific state were not modified.`,
    };
  }

  const notes: string[] = [];
  let tokenRevoked = true;
  try {
    revokeToken(connectorId);
  } catch (revokeErr) {
    tokenRevoked = false;
    const revokeMsg = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
    notes.push(`Warning: token revocation failed — ${revokeMsg}. The token for ${connectorId} may still be present in tokens.json.`);
  }

  let weCloneProxyDeleteFailed: string | null = null;
  if (connectorId === "weclone") {
    if (weCloneProxyConfigPath === null) {
      notes.push(
        "WeClone proxy config cleanup skipped: no persisted path found in saved config " +
          "(likely a legacy install predating proxyConfigPath provenance).",
      );
    } else {
      const expectedSuffix = path.join("connectors", "weclone.json");
      const isSafePath =
        path.isAbsolute(weCloneProxyConfigPath) &&
        weCloneProxyConfigPath.endsWith(expectedSuffix);
      if (!isSafePath) {
        weCloneProxyDeleteFailed =
          `Proxy config path ${JSON.stringify(weCloneProxyConfigPath)} failed safety validation ` +
          `(must be absolute and end with "${expectedSuffix}"). ` +
          `Refusing to delete — remove the file manually if it exists.`;
      } else {
        try {
          if (fs.existsSync(weCloneProxyConfigPath)) {
            fs.unlinkSync(weCloneProxyConfigPath);
            notes.push(`Removed WeClone proxy config: ${weCloneProxyConfigPath}`);
          }
        } catch (err) {
          weCloneProxyDeleteFailed = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }
  if (weCloneProxyDeleteFailed !== null && weCloneProxyConfigPath !== null) {
    const tokenStatus = tokenRevoked
      ? "the registry config was deleted and the token was revoked"
      : "the registry config was deleted but TOKEN REVOCATION ALSO FAILED — " +
        "inspect ~/.remnic/tokens.json and revoke manually";
    return {
      connectorId,
      configPath,
      status: "error",
      message:
        `WeClone remove partially succeeded: ${tokenStatus}, ` +
        `but the proxy config at ${weCloneProxyConfigPath} could not be deleted ` +
        `(${weCloneProxyDeleteFailed}). Manually remove that file — it may still contain ` +
        `a Remnic daemon bearer token.`,
    };
  }

  let droidMcpDeleteFailed: string | null = null;
  if (connectorId === "droid") {
    if (droidMcpConfigPath === null) {
      notes.push("Droid MCP config cleanup skipped: no persisted path found (legacy install).");
    } else {
      try { const note = removeDroidMcpEntryImpl(droidMcpConfigPath); if (note) notes.push(note); }
      catch (err) { droidMcpDeleteFailed = err instanceof Error ? err.message : String(err); }
    }
  }
  if (droidMcpDeleteFailed !== null && droidMcpConfigPath !== null) {
    const ts = tokenRevoked ? "token was revoked" : "TOKEN REVOCATION ALSO FAILED — inspect ~/.remnic/tokens.json and revoke manually";
    return { connectorId, configPath, status: "error", message: `Droid remove partially succeeded: registry config deleted, ${ts}, but the MCP config at ${droidMcpConfigPath} could not be updated (${droidMcpDeleteFailed}). Manually remove the "remnic" entry.` };
  }

  if (connectorId === "hermes") {
    try {
      const shimCandidates: string[] = [];
      if (savedHermesShimPath !== null) {
        shimCandidates.push(savedHermesShimPath);
      }
      shimCandidates.push(...savedPriorHermesShimPaths);
      try {
        shimCandidates.push(hermesShimPath());
      } catch {
        /* HERMES_HOME unresolved in the current environment — persisted path only */
      }
      const shimResult = removeHermesShim(shimCandidates);
      if (shimResult.notes.length > 0) {
        notes.push(shimResult.notes.join("; "));
      }
    } catch (shimErr) {
      notes.push(
        `Hermes plugin shim cleanup skipped: ${shimErr instanceof Error ? shimErr.message : String(shimErr)}`,
      );
    }

    try {
      const yamlResult = removeHermesConfig({
        profile: storedProfile,
        extraConfigPaths: [
          ...(savedHermesConfigPath !== null ? [savedHermesConfigPath] : []),
          ...savedPriorHermesConfigPaths,
        ],
      });
      if (yamlResult.updated) {
        notes.push(`Removed remnic: block from Hermes config: ${yamlResult.configPath}`);
      } else if (yamlResult.reason?.startsWith("Hermes config cleanup partially failed:")) {
        const tokenStatus = tokenRevoked
          ? "the connector registry config was deleted and the token was revoked"
          : "the connector registry config was deleted but TOKEN REVOCATION ALSO FAILED — " +
            "inspect ~/.remnic/tokens.json and revoke manually";
        const shimSuffix = notes.length > 0 ? ` Completed cleanup: ${notes.join("; ")}.` : "";
        return {
          connectorId,
          configPath,
          status: "error",
          message:
            `Hermes remove partially succeeded: ${tokenStatus}, but ${yamlResult.reason}. ` +
            `Updated paths: ${yamlResult.configPath}. Manually remove any stale remnic: ` +
            `block and token material from the failed Hermes config path.` +
            shimSuffix,
        };
      } else if (yamlResult.skipped) {
        notes.push(`Hermes config cleanup skipped: ${yamlResult.reason}`);
      }
    } catch (err) {
      notes.push(
        `Hermes config cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const suffix = notes.length > 0 ? `\n  ${notes.join("\n  ")}` : "";
  return {
    connectorId,
    configPath,
    status: "removed",
    message: `Removed${extensionMessage}${suffix}`,
  };
}


interface HermesConfigResult {
  updated: boolean;
  skipped: boolean;
  reason?: string;
  configPath: string;
  /**
   * The exact byte-for-byte content of the config.yaml that existed BEFORE
   * this upsert ran. `null` when the file did not exist (new file was created).
   * `undefined` when the write was skipped (priorContent is irrelevant).
   * Used by installConnector to roll back the YAML write if commitTokenEntry
   * subsequently throws.
   */
  priorContent?: string | null;
}

/**
 * Validate and sanitize a Hermes profile name.
 *
 * Profile names appear as a path segment under `~/.hermes/profiles/`, so we
 * must reject any value that could traverse outside that directory. Hermes
 * itself restricts profile names to filesystem-safe identifiers; we mirror
 * that convention and additionally require the resolved config path to stay
 * under the profiles root.
 *
 * Throws on invalid input rather than silently normalizing — the caller
 * should surface the error so the user can supply a valid profile.
 */
function sanitizeHermesProfile(profile: string): string {
  if (typeof profile !== "string" || profile.length === 0) {
    throw new Error("Hermes profile name must be a non-empty string");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(
      `Invalid Hermes profile name: ${JSON.stringify(profile)} — must match [A-Za-z0-9][A-Za-z0-9._-]*`,
    );
  }
  if (profile.includes("..")) {
    throw new Error(`Invalid Hermes profile name: ${JSON.stringify(profile)} — must not contain ".."`);
  }
  return profile;
}

function hermesConfigPath(profile: string): string {
  const safeProfile = sanitizeHermesProfile(profile);
  const hermesRoot = resolveHermesRoot();
  const rootConfigPath = path.join(hermesRoot, "config.yaml");
  const profilesRoot = path.join(hermesRoot, "profiles");
  if (safeProfile === "default") {
    const defaultProfileDir = path.join(profilesRoot, safeProfile);
    if (isFile(rootConfigPath) || (!fs.existsSync(rootConfigPath) && !isDirectory(defaultProfileDir))) {
      return rootConfigPath;
    }
  }
  const cfgPath = path.resolve(profilesRoot, safeProfile, "config.yaml");
  const rel = path.relative(profilesRoot, cfgPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Invalid Hermes profile path: resolved outside ${profilesRoot}`,
    );
  }
  return cfgPath;
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hermesConfigTarget(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function sameHermesConfigTarget(leftPath: string, rightPath: string): boolean {
  return hermesConfigTarget(leftPath) === hermesConfigTarget(rightPath);
}

function hermesDefaultProfileConfigPath(): string {
  return path.join(resolveHermesRoot(), "profiles", "default", "config.yaml");
}

function hermesConfigCleanupPaths(profile: string): string[] {
  const cfgPath = hermesConfigPath(profile);
  const safeProfile = sanitizeHermesProfile(profile);
  if (safeProfile !== "default") {
    return [cfgPath];
  }
  return [...new Set([cfgPath, hermesDefaultProfileConfigPath()])];
}


/**
 * Validate a Hermes host string before interpolating it into YAML.
 *
 * YAML-injection guard: connector config values come from raw CLI input
 * (`--config host=...`) or config-file JSON, both of which are untrusted.
 * Without validation, a value like `127.0.0.1"\n  session_key: "evil`
 * would emit additional YAML keys into the `remnic:` block and silently
 * override Hermes settings.
 *
 * Accepted forms:
 *   - Plain IPv4: 127.0.0.1, 10.0.0.5
 *   - Plain DNS hostname: localhost, foo.example.com
 *   - Bracketed IPv6 literal: [::1], [2001:db8::1]
 *
 * Rejected forms:
 *   - host:port combos: 127.0.0.1:4318 (colons not allowed outside brackets)
 *   - Unbalanced brackets: [::1
 *   - Any whitespace, quotes, or control characters
 *
 * Hermes builds its base URL as `http://{host}:{port}`, so supplying a
 * host that already embeds a port (e.g. "127.0.0.1:4318") would produce
 * the double-port URL "http://127.0.0.1:4318:4318/..." and fail at runtime
 * even though install reports success.  We reject that form here.
 */
function sanitizeHermesHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("Hermes host must be a non-empty string");
  }
  if (host.length > 253) {
    throw new Error(`Hermes host too long (max 253 chars): ${JSON.stringify(host.slice(0, 32))}…`);
  }

  if (host.startsWith("[")) {
    if (!host.endsWith("]")) {
      throw new Error(
        `Invalid Hermes host: ${JSON.stringify(host)} — unbalanced brackets in IPv6 literal`,
      );
    }
    const inner = host.slice(1, -1);
    if (inner.length === 0 || !/^[0-9A-Fa-f:]+$/.test(inner)) {
      throw new Error(
        `Invalid Hermes host: ${JSON.stringify(host)} — bracketed IPv6 literal must contain only hex digits and colons`,
      );
    }
    return host;
  }

  if (host.includes(":")) {
    throw new Error(
      `Invalid Hermes host: ${JSON.stringify(host)} — host must not include a port; supply the port separately with --config port=<n>`,
    );
  }

  if (!/^[A-Za-z0-9._\-]+$/.test(host)) {
    throw new Error(
      `Invalid Hermes host: ${JSON.stringify(host)} — must be a plain hostname or IP literal`,
    );
  }
  return host;
}

/**
 * Validate a Hermes port value. Accepts positive integers in [1, 65535].
 *
 * Rejects non-integer numeric strings (e.g. "4318.9") rather than silently
 * truncating them — a fractional port is almost certainly a typo and writing
 * the truncated value to config.yaml would be misleading.
 */
function sanitizeHermesPort(port: number | string): number {
  const numeric = Number(port);
  if (!Number.isInteger(numeric)) {
    throw new Error(
      `Invalid Hermes port "${port}": must be a positive integer`,
    );
  }
  if (numeric < 1 || numeric > 65535) {
    throw new Error(`Invalid Hermes port: ${JSON.stringify(port)} — must be an integer in [1, 65535]`);
  }
  return numeric;
}

/**
 * Atomically write a file with owner-only (0o600) permissions.
 *
 * Used for any file that may contain a bearer token. Write to a unique temp file
 * in the destination directory, chmod the temp file, then rename into place so a
 * failed write cannot truncate or corrupt the existing connector config.
 */
function writeSecretFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let wroteTemp = false;
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600, flag: "wx" });
    wroteTemp = true;
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      /* best-effort on non-POSIX filesystems */
    }
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort on non-POSIX filesystems */
    }
  } catch (err) {
    if (wroteTemp) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best-effort temp cleanup */
      }
    }
    throw err;
  }
}

/**
 * Upsert the `remnic:` block in a Hermes profile config.yaml.
 *
 * Rules:
 * - If the profile directory does not exist, skip with a warning (we do not
 *   create arbitrary Hermes state).
 * - If config.yaml does not exist, create it with only the remnic: block.
 * - If config.yaml exists and already contains a `remnic:` block, update the
 *   host/port/token lines in-place (line-based, preserves comments elsewhere).
 * - If config.yaml exists with no `remnic:` block, append one.
 * - Idempotent on repeated calls.
 */
export function upsertHermesConfig(opts: {
  profile: string;
  host: string;
  port: number;
  token: string;
  allowInsecureHttp?: boolean;
}): HermesConfigResult {
  return upsertHermesConfigAt(hermesConfigPath(opts.profile), opts);
}

/**
 * Path-addressed variant of {@link upsertHermesConfig}: writes/updates the
 * `remnic:` block in the config.yaml at `cfgPath`. Used both for the
 * profile-resolved primary config and for refreshing a preserved
 * prior-install config with the active token (PR #1938, round 13).
 */
function upsertHermesConfigAt(
  cfgPath: string,
  opts: { host: string; port: number; token: string; allowInsecureHttp?: boolean },
): HermesConfigResult {
  assertConfigComponentsNotSymlinked(cfgPath);
  const profileDir = path.dirname(cfgPath);

  const safeHost = sanitizeHermesHost(opts.host);
  const safePort = sanitizeHermesPort(opts.port);
  const allowInsecureHttp = opts.allowInsecureHttp ?? false;
  if (!/^[A-Za-z0-9_]+$/.test(opts.token)) {
    throw new Error("Invalid Hermes token: contains non-alphanumeric characters");
  }

  if (!isDirectory(profileDir)) {
    return {
      updated: false,
      skipped: true,
      reason: `Hermes profile directory not found: ${profileDir}`,
      configPath: cfgPath,
    };
  }

  const block = [
    "remnic:",
    `  host: "${safeHost}"`,
    `  port: ${safePort}`,
    `  token: "${opts.token}"`,
    `  allow_insecure_http: ${allowInsecureHttp}`,
  ].join("\n");

  if (!fs.existsSync(cfgPath)) {
    writeSecretFileSync(cfgPath, block + "\n");
    // priorContent: null signals "file was created new" — rollback means delete.
    return { updated: true, skipped: false, configPath: cfgPath, priorContent: null };
  }

  const raw = fs.readFileSync(cfgPath, "utf8");

  const hasRemnicBlock = /^remnic:/m.test(raw);

  if (!hasRemnicBlock) {
    const separator = raw.endsWith("\n") ? "\n" : "\n\n";
    writeSecretFileSync(cfgPath, raw + separator + block + "\n");
    // priorContent: raw preserves the original file so it can be restored on rollback.
    return { updated: true, skipped: false, configPath: cfgPath, priorContent: raw };
  }

  //
  const splitLines = raw.split("\n");
  if (splitLines.length > 0 && splitLines[splitLines.length - 1] === "") {
    splitLines.pop();
  }
  const lines = splitLines;
  const newLines: string[] = [];
  let inRemnicBlock = false;
  let blockWritten = false;

  const written = { host: false, port: false, token: false, allowInsecureHttp: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^remnic:/.test(line)) {
      inRemnicBlock = true;
      newLines.push(line);
      continue;
    }

    if (inRemnicBlock) {
      if (line.length > 0 && !/^\s/.test(line)) {
        if (!written.host) newLines.push(`  host: "${safeHost}"`);
        if (!written.port) newLines.push(`  port: ${safePort}`);
        if (!written.token) newLines.push(`  token: "${opts.token}"`);
        if (!written.allowInsecureHttp) newLines.push(`  allow_insecure_http: ${allowInsecureHttp}`);
        blockWritten = true;
        inRemnicBlock = false;
        newLines.push(line);
        continue;
      }

      if (/^\s+host:/.test(line)) {
        newLines.push(`  host: "${safeHost}"`);
        written.host = true;
      } else if (/^\s+port:/.test(line)) {
        newLines.push(`  port: ${safePort}`);
        written.port = true;
      } else if (/^\s+token:/.test(line)) {
        newLines.push(`  token: "${opts.token}"`);
        written.token = true;
      } else if (/^\s+allow_insecure_http:/.test(line)) {
        newLines.push(`  allow_insecure_http: ${allowInsecureHttp}`);
        written.allowInsecureHttp = true;
      } else {
        newLines.push(line);
      }
      continue;
    }

    newLines.push(line);
  }

  if (inRemnicBlock && !blockWritten) {
    if (!written.host) newLines.push(`  host: "${safeHost}"`);
    if (!written.port) newLines.push(`  port: ${safePort}`);
    if (!written.token) newLines.push(`  token: "${opts.token}"`);
    if (!written.allowInsecureHttp) newLines.push(`  allow_insecure_http: ${allowInsecureHttp}`);
  }

  writeSecretFileSync(cfgPath, newLines.join("\n") + "\n");
  // priorContent: raw is the original file content for rollback if needed.
  return { updated: true, skipped: false, configPath: cfgPath, priorContent: raw };
}

/**
 * Remove the `remnic:` block from a Hermes profile config.yaml.
 * Idempotent — if the block is absent, returns skipped.
 *
 * `extraConfigPaths` carries the config.yaml location persisted in the
 * connector JSON at install time, so a HERMES_HOME change between install and
 * remove cannot leave the old home's remnic: block (with its daemon token)
 * behind (Codex P2 on PR #1938, round 6). Extra candidates are shape-guarded
 * and de-duplicated against the environment-resolved paths.
 */
export function removeHermesConfig(opts: {
  profile: string;
  extraConfigPaths?: readonly string[];
}): HermesConfigResult {
  let envCfgPaths: string[];
  let envResolutionError: string | null = null;
  try {
    envCfgPaths = [...hermesConfigCleanupPaths(opts.profile)];
  } catch (err) {
    envCfgPaths = [];
    envResolutionError = err instanceof Error ? err.message : String(err);
  }
  const cfgPaths: string[] = [];
  for (const candidate of envCfgPaths) {
    if (!cfgPaths.some((existing) => sameHermesConfigTarget(existing, candidate))) {
      cfgPaths.push(candidate);
    }
  }
  for (const extra of opts.extraConfigPaths ?? []) {
    if (
      isPlausibleHermesConfigPath(extra) &&
      !cfgPaths.some((existing) => sameHermesConfigTarget(existing, extra))
    ) {
      cfgPaths.push(extra);
    }
  }
  if (cfgPaths.length === 0) {
    return {
      updated: false,
      skipped: true,
      reason: envResolutionError
        ? `Hermes config cleanup failed: ${envResolutionError}`
        : "Hermes config.yaml not found",
      configPath: "<unresolved>",
    };
  }
  const results = cfgPaths.map((cfgPath) => {
    try {
      return removeHermesConfigFile(cfgPath);
    } catch (err) {
      return {
        updated: false,
        skipped: true,
        reason: `Hermes config cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        configPath: cfgPath,
      };
    }
  });
  const updated = results.filter((result) => result.updated);
  const cleanupFailures = results.filter((result) => result.reason?.startsWith("Hermes config cleanup failed:"));

  if (updated.length > 0) {
    const updatedPaths = updated.map((result) => result.configPath).join(", ");
    if (cleanupFailures.length > 0) {
      const failedPaths = cleanupFailures.map((result) => result.configPath).join(", ");
      return {
        updated: false,
        skipped: true,
        reason: `Hermes config cleanup partially failed: updated ${updatedPaths}; failed ${failedPaths}`,
        configPath: `${updatedPaths}; failed: ${failedPaths}`,
      };
    }
    return {
      updated: true,
      skipped: false,
      configPath: updatedPaths,
    };
  }

  const cleanupFailure = cleanupFailures[0];
  if (cleanupFailure) {
    return cleanupFailure;
  }

  const existingWithoutBlock = results.find((result) => result.reason !== "Hermes config.yaml not found");
  const fallbackResult = existingWithoutBlock ?? results[0];
  if (fallbackResult) {
    return fallbackResult;
  }
  return {
    updated: false,
    skipped: true,
    reason: "Hermes config.yaml not found",
    configPath: cfgPaths[0] ?? "<unresolved>",
  };
}

function removeHermesConfigFile(cfgPath: string): HermesConfigResult {
  try {
    assertConfigComponentsNotSymlinked(cfgPath);
  } catch (err) {
    return {
      updated: false,
      skipped: true,
      reason: `Hermes config cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      configPath: cfgPath,
    };
  }
  if (!fs.existsSync(cfgPath)) {
    return {
      updated: false,
      skipped: true,
      reason: "Hermes config.yaml not found",
      configPath: cfgPath,
    };
  }

  const raw = fs.readFileSync(cfgPath, "utf8");
  if (!/^remnic:/m.test(raw)) {
    return {
      updated: false,
      skipped: true,
      reason: "No remnic: block found in config.yaml",
      configPath: cfgPath,
    };
  }

  const lines = raw.split("\n");
  const newLines: string[] = [];
  let inRemnicBlock = false;

  for (const line of lines) {
    if (/^remnic:/.test(line)) {
      inRemnicBlock = true;
      continue;
    }
    if (inRemnicBlock) {
      if (line.length > 0 && !/^\s/.test(line)) {
        inRemnicBlock = false;
        newLines.push(line);
      }
      continue;
    }
    newLines.push(line);
  }

  while (newLines.length > 0 && newLines[newLines.length - 1]?.trim() === "") {
    newLines.pop();
  }

  writeSecretFileSync(cfgPath, newLines.length > 0 ? newLines.join("\n") + "\n" : "");
  return { updated: true, skipped: false, configPath: cfgPath };
}


export async function doctorConnector(connectorId: string): Promise<DoctorResult> {
  const installed = listConnectors().installed;
  const instance = installed.find((c) => c.connectorId === connectorId);

  if (!instance) {
    return {
      connectorId,
      checks: [{ name: "Installed", ok: false, detail: "Not installed" }],
      healthy: false,
    };
  }

  const configPath = path.join(getConnectorsDir(), `${connectorId}.json`);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "Config file",
    ok: fs.existsSync(configPath),
    detail: configPath,
  });

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    JSON.parse(raw);
    checks.push({ name: "Config valid", ok: true, detail: "OK" });
  } catch (e) {
    checks.push({ name: "Config valid", ok: false, detail: String(e) });
  }

  const mcpUrl = instance.config.mcpServerUrl as string | undefined;
  if (mcpUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(mcpUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      checks.push({ name: "MCP server", ok: response.ok, detail: mcpUrl });
    } catch (e) {
      checks.push({
        name: "MCP server",
        ok: false,
        detail: `Cannot reach ${mcpUrl}: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  const memoryDir = instance.config.memoryDir as string | undefined;
  if (memoryDir) {
    if (fs.existsSync(memoryDir)) {
      checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
    } else {
      checks.push({ name: "Memory directory", ok: false, detail: `Not found: ${memoryDir}` });
    }
  }

  if (connectorId === "droid") {
    checks.push(droidMcpDoctorCheckImpl(instance.config.factoryMcpPath as string | undefined));
  }

  const healthy = checks.every((c) => c.ok);
  return { connectorId, checks, healthy };
}


/**
 * Name of the Codex memories folder. Matches Codex's
 * `MEMORIES_SUBDIR = "memories"`.
 */
const CODEX_MEMORIES_SUBDIR = "memories";

/**
 * Name of the Codex memory-extensions folder. Matches Codex's
 * `EXTENSIONS_SUBDIR = "memories_extensions"`.
 *
 * Codex computes the extensions root as a **sibling** of the memories dir via
 * Rust's `Path::with_file_name("memories_extensions")` — so for the default
 * Codex home the layout is:
 *
 *     ~/.codex/memories/
 *     ~/.codex/memories_extensions/
 *
 * Extension files live **outside** of `memories/`, never inside it.
 */
const CODEX_EXTENSIONS_SUBDIR = "memories_extensions";

/** Folder name Remnic installs its extension under. */
const REMNIC_EXTENSION_DIR_NAME = "remnic";

export interface CodexMemoryExtensionPaths {
  /** Resolved Codex home directory (e.g. `~/.codex`). */
  codexHome: string;
  /** Resolved Codex memories directory (`<codex_home>/memories`). */
  memoriesDir: string;
  /** Sibling extensions root (`<codex_home>/memories_extensions`). */
  extensionsRoot: string;
  /** The specific Remnic extension directory inside the extensions root. */
  remnicExtensionDir: string;
}

export interface InstallCodexMemoryExtensionOptions {
  /** Optional override for `$CODEX_HOME`. Highest priority. */
  codexHome?: string | null;
  /** Optional override for the plugin-codex extension source directory. */
  sourceDir?: string | null;
}

export interface InstallCodexMemoryExtensionResult extends CodexMemoryExtensionPaths {
  /** Absolute path to the installed `instructions.md`. */
  instructionsPath: string;
  /** Number of files copied. */
  filesCopied: number;
  /**
   * Commit the install: permanently remove the backup of the prior extension
   * (if one existed). Call this once the config write has succeeded.
   */
  commit(): void;
  /**
   * Roll back the install: restore the prior extension if one existed, or
   * remove the newly-installed directory for a fresh install. Call this when
   * a subsequent step (e.g. config write) has failed.
   */
  rollback(): void;
}

export interface RemoveCodexMemoryExtensionOptions {
  codexHome?: string | null;
}

export interface RemoveCodexMemoryExtensionResult extends CodexMemoryExtensionPaths {
  /** True if an existing `remnic` extension directory was removed. */
  removed: boolean;
}

/**
 * Resolve the Codex home directory. Precedence:
 *   1. explicit `override` argument (from config)
 *   2. `$CODEX_HOME` env var
 *   3. `$HOME/.codex`, `$USERPROFILE/.codex`, or the OS home directory
 */
export function resolveCodexHome(override?: string | null): string {
  if (override && typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const envHome = readEnvVar("CODEX_HOME");
  if (envHome && envHome.trim().length > 0) {
    return path.resolve(envHome.trim());
  }
  const home = readEnvVar("HOME") || readEnvVar("USERPROFILE") || resolveHomeDir();
  return path.resolve(home, ".codex");
}

/**
 * Compute the Codex memories + memory-extensions layout for a given Codex home.
 *
 * The extensions root is computed as a **sibling** of the memories dir by
 * taking `path.dirname(memoriesDir)` and joining `memories_extensions`. This
 * mirrors Rust's `with_file_name("memories_extensions")` semantics used by
 * Codex's `memory_extensions_root()`. Do NOT place the extension inside
 * `<codex_home>/memories/`.
 */
export function resolveCodexMemoryExtensionPaths(
  codexHomeOverride?: string | null,
): CodexMemoryExtensionPaths {
  const codexHome = resolveCodexHome(codexHomeOverride);
  const memoriesDir = path.join(codexHome, CODEX_MEMORIES_SUBDIR);
  const extensionsRoot = path.join(path.dirname(memoriesDir), CODEX_EXTENSIONS_SUBDIR);
  const remnicExtensionDir = path.join(extensionsRoot, REMNIC_EXTENSION_DIR_NAME);
  return { codexHome, memoriesDir, extensionsRoot, remnicExtensionDir };
}

/**
 * Locate the plugin-codex `memories_extensions/remnic/` source directory on
 * disk. Search order:
 *   1. explicit `override`
 *   2. resolve via `@remnic/plugin-codex` package (handles global npm installs)
 *   3. sibling `node_modules/@remnic/plugin-codex` relative to this module
 *   4. walk upward from this file's location (monorepo development)
 *   5. walk upward from `process.cwd()` (monorepo fallback)
 *
 * Returns the absolute path or throws a descriptive error listing all paths
 * searched when none exist.
 */
export function locatePluginCodexExtensionSource(override?: string | null): string {
  if (override && typeof override === "string" && override.trim().length > 0) {
    const resolved = path.resolve(override.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    throw new Error(`Codex extension source directory not found: ${resolved}`);
  }

  const EXTENSION_SUBPATH = path.join("memories_extensions", "remnic");
  const WORKSPACE_RELATIVE_PATH = path.join(
    "packages",
    "plugin-codex",
    "memories_extensions",
    "remnic",
  );

  const searched: string[] = [];

  // Primary path: the bundled payload shipped with @remnic/core itself.
  // tsup copies src/connectors/codex/ → dist/connectors/codex/ (see tsup.config.ts
  // onSuccess hook). However, tsup bundles all source into dist/ as flat files
  // (dist/index.js, dist/chunk-*.js), so at runtime import.meta.url points to
  // dist/index.js or a dist/chunk-*.js — NOT dist/connectors/index.js.
  // Therefore we probe two sibling-relative candidates:
  //   1. moduleDir/codex          — matches tsx/ts-node on src/connectors/index.ts
  //   2. moduleDir/connectors/codex — matches the tsup dist layout where this code
  //                                   lands in dist/index.js or dist/chunk-*.js
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));

    const bundledCandidate = path.join(moduleDir, "codex");
    searched.push(bundledCandidate);
    if (fs.existsSync(bundledCandidate) && fs.statSync(bundledCandidate).isDirectory()) {
      return bundledCandidate;
    }

    // When this module is bundled into dist/index.js or dist/chunk-*.js,
    const distConnectorsCandidate = path.join(moduleDir, "connectors", "codex");
    searched.push(distConnectorsCandidate);
    if (
      fs.existsSync(distConnectorsCandidate) &&
      fs.statSync(distConnectorsCandidate).isDirectory()
    ) {
      return distConnectorsCandidate;
    }
  } catch {
    // import.meta.url unavailable — not running as ESM, skip bundled path.
  }

  try {
    const requireFromHere = createRequire(import.meta.url);
    const pluginPkgJsonPath = requireFromHere.resolve("@remnic/plugin-codex/package.json");
    const pluginPkgRoot = path.dirname(pluginPkgJsonPath);
    const candidate = path.join(pluginPkgRoot, EXTENSION_SUBPATH);
    searched.push(candidate);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // @remnic/plugin-codex not installed — fall through to next strategy.
  }

  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = moduleDir;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(
        dir,
        "node_modules",
        "@remnic",
        "plugin-codex",
        EXTENSION_SUBPATH,
      );
      searched.push(candidate);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable — not running as ESM.
  }

  const anchors: string[] = [];
  try {
    anchors.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Not running under ESM with import.meta — skip.
  }
  anchors.push(process.cwd());

  for (const anchor of anchors) {
    let dir = anchor;
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = path.join(dir, WORKSPACE_RELATIVE_PATH);
      searched.push(candidate);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    "Could not locate the plugin-codex memories_extensions/remnic source directory.\n" +
      "Paths searched:\n" +
      searched.map((p) => `  - ${p}`).join("\n") +
      "\nInstall @remnic/plugin-codex or pass sourceDir explicitly.",
  );
}

function copyDirRecursiveSync(src: string, dest: string): number {
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursiveSync(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
    // Skip symlinks, sockets, etc. — extension content is plain files.
  }
  return count;
}

/**
 * Install the Remnic memory extension into `<codex_home>/memories_extensions/remnic/`
 * atomically. The copy is written to a sibling `.remnic.tmp-<pid>-<ts>` directory
 * and then renamed into place, so a concurrent Codex phase-2 run never sees a
 * half-written extension.
 *
 * This function is **idempotent and scoped**: it only touches the `remnic`
 * subfolder inside `memories_extensions/`. Adjacent extensions (other
 * vendors) are never read, written, or removed.
 */
export function installCodexMemoryExtension(
  options: InstallCodexMemoryExtensionOptions = {},
): InstallCodexMemoryExtensionResult {
  const paths = resolveCodexMemoryExtensionPaths(options.codexHome ?? null);
  const sourceDir = locatePluginCodexExtensionSource(options.sourceDir ?? null);

  fs.mkdirSync(paths.extensionsRoot, { recursive: true });

  //
  const tmpPrefix = `.${REMNIC_EXTENSION_DIR_NAME}.tmp-`;
  const STALE_TMP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();
  try {
    const existingEntries = fs.readdirSync(paths.extensionsRoot);
    for (const entry of existingEntries) {
      if (!entry.startsWith(tmpPrefix)) continue;
      const stalePath = path.join(paths.extensionsRoot, entry);
      try {
        const stat = fs.statSync(stalePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < STALE_TMP_THRESHOLD_MS) {
          continue;
        }
        fs.rmSync(stalePath, { recursive: true, force: true });
      } catch {
        // swallow — one bad entry should not abort the others
      }
    }
  } catch {
    // extensions root just-created / unreadable — nothing to clean
  }

  const tmpName = `${tmpPrefix}${process.pid}-${Date.now()}`;
  const tmpDir = path.join(paths.extensionsRoot, tmpName);

  let filesCopied = 0;
  let commitFn: () => void = () => { /* no-op: set below on success */ };
  let rollbackFn: () => void = () => { /* no-op: set below on success */ };
  try {
    filesCopied = copyDirRecursiveSync(sourceDir, tmpDir);

    const backupDir = `${paths.remnicExtensionDir}.bak-${Date.now()}`;
    const hadExisting = fs.existsSync(paths.remnicExtensionDir);
    if (hadExisting) {
      fs.renameSync(paths.remnicExtensionDir, backupDir);
    }
    try {
      fs.renameSync(tmpDir, paths.remnicExtensionDir);
    } catch (renameErr) {
      if (hadExisting) {
        try {
          fs.renameSync(backupDir, paths.remnicExtensionDir);
        } catch {
          // swallow — backup restore best-effort
        }
      }
      throw renameErr;
    }
    //
    // commit() — remove the backup (called on success)
    // rollback() — restore the prior extension from backup, or remove the newly
    //              installed directory if this was a fresh install
    commitFn = (): void => {
      if (hadExisting) {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch {
          // swallow — stale backup is harmless
        }
      }
    };
    rollbackFn = (): void => {
      if (hadExisting) {
        try {
          if (fs.existsSync(paths.remnicExtensionDir)) {
            fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
          }
          fs.renameSync(backupDir, paths.remnicExtensionDir);
        } catch {
          // swallow — best-effort restore; backup remains on disk
        }
      } else {
        try {
          if (fs.existsSync(paths.remnicExtensionDir)) {
            fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
          }
        } catch {
          // swallow
        }
      }
    };
  } catch (err) {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
    throw err;
  }

  const instructionsPath = path.join(paths.remnicExtensionDir, "instructions.md");

  return {
    ...paths,
    instructionsPath,
    filesCopied,
    commit: commitFn,
    rollback: rollbackFn,
  };
}

/**
 * Remove the Remnic memory extension. Only touches
 * `<codex_home>/memories_extensions/remnic/` — never adjacent extensions.
 */
export function removeCodexMemoryExtension(
  options: RemoveCodexMemoryExtensionOptions = {},
): RemoveCodexMemoryExtensionResult {
  const paths = resolveCodexMemoryExtensionPaths(options.codexHome ?? null);
  let removed = false;
  if (fs.existsSync(paths.remnicExtensionDir)) {
    fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
    removed = true;
  }
  return { ...paths, removed };
}



//

const WECLONE_PROXY_CONFIG_DIRNAME = ".remnic";
const WECLONE_PROXY_CONFIG_FILENAME = "weclone.json";

/**
 * Resolve the path to ~/.remnic/connectors/weclone.json for the current user.
 * Honours REMNIC_HOME / ENGRAM_HOME env overrides so tests can point the
 * install at a temp dir without leaking into the real home directory.
 *
 * Always returns an absolute path via `path.resolve` so install-time and
 * run-time resolution agree even when the override is a relative path like
 * `tmp/remnic` (which would otherwise be interpreted against the caller's
 * current working directory). Must stay in lockstep with the proxy CLI's
 * `defaultConfigPath()` in @remnic/connector-weclone/src/cli.ts.
 *
 * `HOME=""` edge case: a nullish fallback would keep the
 * empty string (empty is not nullish), which `path.resolve("", ...)` then
 * interprets as CWD. `os.homedir()` by contrast falls back to the OS
 * password database when HOME is empty, so the two code paths would
 * disagree. We therefore treat empty HOME as absent and delegate to
 * `os.homedir()` in both places — the same rule the proxy CLI follows.
 */
export function resolveWeCloneProxyConfigPath(): string {
  const remnicHome = readEnvVar("REMNIC_HOME");
  const override = remnicHome && remnicHome.length > 0 ? remnicHome : readEnvVar("ENGRAM_HOME");
  if (override && override.length > 0) {
    return path.resolve(expandTildePath(override), "connectors", WECLONE_PROXY_CONFIG_FILENAME);
  }
  const envHome = readEnvVar("HOME");
  const home = envHome && envHome.length > 0 ? envHome : os.homedir();
  return path.resolve(
    home,
    WECLONE_PROXY_CONFIG_DIRNAME,
    "connectors",
    WECLONE_PROXY_CONFIG_FILENAME,
  );
}

/**
 * Read the existing proxy config file, if any. Returns raw contents so the
 * caller can both parse it (for value precedence) and restore it verbatim on
 * rollback without touching byte-level formatting.
 */
function readWeCloneProxyConfigIfExists(configPath: string): string | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
}

/** Safely parse a JSON string into a record; returns null on error. */
function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface WeCloneProxyConfig {
  wecloneApiUrl: string;
  wecloneModelName: string;
  proxyPort: number;
  remnicDaemonUrl: string;
  remnicAuthToken?: string;
  sessionStrategy: "caller-id" | "single";
  memoryInjection: {
    maxTokens: number;
    position: "system-append" | "system-prepend";
    template: string;
  };
}

const WECLONE_DEFAULTS = {
  wecloneApiUrl: "http://localhost:8000/v1",
  wecloneModelName: "weclone-avatar",
  proxyPort: 8100,
  remnicDaemonUrl: "http://localhost:4318",
  sessionStrategy: "single" as const,
  memoryInjection: {
    maxTokens: 1500,
    position: "system-append" as const,
    template: "[Memory Context]\n{memories}\n[End Memory Context]",
  },
};

/**
 * Resolve a string field with precedence: userConfig → priorConfig → default.
 * Only non-empty strings are accepted from either source; invalid values fall
 * through so the user gets a working default rather than a broken install.
 */
function resolveStringField(
  userConfig: Record<string, unknown>,
  priorConfig: Record<string, unknown> | null,
  key: string,
  fallback: string,
): string {
  const fromUser = userConfig[key];
  if (typeof fromUser === "string" && fromUser.length > 0) return fromUser;
  if (priorConfig) {
    const fromPrior = priorConfig[key];
    if (typeof fromPrior === "string" && fromPrior.length > 0) return fromPrior;
  }
  return fallback;
}

/**
 * Coerce a config value to an integer port in [1, 65535]. Accepts number or
 * numeric string (parseConnectorConfig produces strings from `--config
 * proxyPort=8100`). Returns null if the value is missing or invalid so the
 * caller can fall through to the next precedence level.
 */
function coercePort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return null;
}

function resolvePort(
  userConfig: Record<string, unknown>,
  priorConfig: Record<string, unknown> | null,
  fallback: number,
): number {
  const fromUser = coercePort(userConfig.proxyPort);
  if (fromUser !== null) return fromUser;
  if (priorConfig) {
    const fromPrior = coercePort(priorConfig.proxyPort);
    if (fromPrior !== null) return fromPrior;
  }
  return fallback;
}

function resolveSessionStrategy(
  userConfig: Record<string, unknown>,
  priorConfig: Record<string, unknown> | null,
): "caller-id" | "single" {
  const valid = new Set(["caller-id", "single"]);
  const fromUser = userConfig.sessionStrategy;
  if (typeof fromUser === "string" && valid.has(fromUser)) {
    return fromUser as "caller-id" | "single";
  }
  if (priorConfig) {
    const fromPrior = priorConfig.sessionStrategy;
    if (typeof fromPrior === "string" && valid.has(fromPrior)) {
      return fromPrior as "caller-id" | "single";
    }
  }
  return WECLONE_DEFAULTS.sessionStrategy;
}

/**
 * Compose a WeCloneProxyConfig from user-supplied overrides and any prior
 * saved config, filling in defaults for every required field. The returned
 * shape is exactly what the proxy's parseConfig() expects.
 */
export function buildWeCloneProxyConfig(args: {
  userConfig: Record<string, unknown>;
  priorConfig: Record<string, unknown> | null;
  authToken?: string;
}): WeCloneProxyConfig {
  const { userConfig, priorConfig, authToken } = args;

  const wecloneApiUrl = resolveStringField(
    userConfig,
    priorConfig,
    "wecloneApiUrl",
    WECLONE_DEFAULTS.wecloneApiUrl,
  );
  const wecloneModelName = resolveStringField(
    userConfig,
    priorConfig,
    "wecloneModelName",
    WECLONE_DEFAULTS.wecloneModelName,
  );
  const remnicDaemonUrl = resolveStringField(
    userConfig,
    priorConfig,
    "remnicDaemonUrl",
    WECLONE_DEFAULTS.remnicDaemonUrl,
  );
  const proxyPort = resolvePort(
    userConfig,
    priorConfig,
    WECLONE_DEFAULTS.proxyPort,
  );
  const sessionStrategy = resolveSessionStrategy(userConfig, priorConfig);

  // Memory injection: always start from defaults, then shallow-merge any
  //
  // `typeof [] === "object"` so a bare `typeof ... === "object" && ... !==
  // null` guard would let an array spread numeric-indexed properties into
  const memoryInjection = {
    ...WECLONE_DEFAULTS.memoryInjection,
    ...(priorConfig &&
    typeof priorConfig.memoryInjection === "object" &&
    priorConfig.memoryInjection !== null &&
    !Array.isArray(priorConfig.memoryInjection)
      ? (priorConfig.memoryInjection as Record<string, unknown>)
      : {}),
    ...(typeof userConfig.memoryInjection === "object" &&
    userConfig.memoryInjection !== null &&
    !Array.isArray(userConfig.memoryInjection)
      ? (userConfig.memoryInjection as Record<string, unknown>)
      : {}),
  } as WeCloneProxyConfig["memoryInjection"];

  const config: WeCloneProxyConfig = {
    wecloneApiUrl,
    wecloneModelName,
    proxyPort,
    remnicDaemonUrl,
    sessionStrategy,
    memoryInjection,
  };

  if (authToken && authToken.length > 0) {
    config.remnicAuthToken = authToken;
  } else if (typeof userConfig.remnicAuthToken === "string" && userConfig.remnicAuthToken.length > 0) {
    config.remnicAuthToken = userConfig.remnicAuthToken;
  } else if (priorConfig && typeof priorConfig.remnicAuthToken === "string" && priorConfig.remnicAuthToken.length > 0) {
    config.remnicAuthToken = priorConfig.remnicAuthToken;
  }

  return config;
}
