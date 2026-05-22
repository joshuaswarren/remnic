import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { lintWorkspaceFiles } from "./hygiene.js";
import { parseConfig } from "./config.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { resolvePluginEntry } from "./plugin-entry-resolver.js";
import {
  resolveCuratedIncludeFilesStatePath,
  resolveNativeKnowledgeStatePath,
  resolveOpenClawWorkspaceStatePath,
} from "./native-knowledge.js";
import { StorageManager } from "./storage.js";
import { listNamespaces } from "./namespaces/migrate.js";
import {
  createEvalBaselineSnapshot,
  getEvalHarnessStatus,
  runEvalBaselineDeltaReport,
  runEvalBenchmarkCiGate,
  validateEvalBenchmarkPack,
  type EvalBaselineDeltaReport,
  type EvalCiGateReport,
  type EvalHarnessStatus,
} from "./evals.js";
import { analyzeGraphHealth, type GraphHealthReport } from "./graph.js";
import {
  analyzeSessionIntegrity,
  applySessionRepair,
  planSessionRepair,
  type SessionIntegrityReport,
  type SessionRepairApplyResult,
  type SessionRepairPlan,
} from "./session-integrity.js";
import {
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
} from "./maintenance/memory-governance.js";
import {
  runConsolidationProvenanceCheck,
  type ConsolidationProvenanceReport,
} from "./consolidation-provenance-check.js";
import type {
  BufferSurpriseEvent,
  DreamsPhasesConfig,
  FileHygieneConfig,
  MemoryFile,
  PluginConfig,
} from "./types.js";
import { reportBufferSurpriseDistribution } from "./buffer-surprise-report.js";
import { readJudgeVerdictStats } from "./extraction-judge-telemetry.js";

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

interface QmdRuntimeLike {
  probe(): Promise<boolean>;
  isAvailable(): boolean;
  ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped">;
  debugStatus(): string;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ConversationIndexLike {
  getConversationIndexHealth(): Promise<{
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
    qmdAvailable?: boolean;
    faiss?: {
      ok: boolean;
      status: "ok" | "degraded" | "error";
      indexPath: string;
      message?: string;
      manifest?: {
        version: number;
        modelId: string;
        normalizedModelId: string;
        dimension: number;
        chunkCount: number;
        updatedAt: string;
        lastSuccessfulRebuildAt: string;
      };
    };
  }>;
  rebuildConversationIndex(
    sessionKey?: string,
    hours?: number,
    opts?: { embed?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    embedded?: boolean;
    rebuilt?: boolean;
  }>;
}

export interface OperatorToolkitOrchestrator extends ConversationIndexLike {
  config: PluginConfig;
  storage: StorageManager;
  qmd: QmdRuntimeLike;
}

export interface OperatorConfigLoadResult {
  found: boolean;
  path: string;
  parsed: boolean;
  memoryDir?: string;
  workspaceDir?: string;
  error?: string;
}

export interface OperatorSetupReport {
  schemaVersion: 1;
  generatedAt: string;
  config: OperatorConfigLoadResult;
  memoryDir: string;
  workspaceDir: string;
  directories: Array<{ path: string; exists: boolean; writable: boolean }>;
  qmd: {
    enabled: boolean;
    available: boolean;
    collectionState: "present" | "missing" | "unknown" | "skipped";
    debugStatus: string;
  };
  nativeKnowledge: {
    enabled: boolean;
    includeFiles: string[];
    curatedIncludeSync: {
      statePath: string;
      exists: boolean;
      updatedAt: string | null;
      fileCount: number;
      activeChunkCount: number;
      deletedFileCount: number;
    };
    openclawWorkspaceAdapterEnabled: boolean;
    obsidianVaultAdapterEnabled: boolean;
    obsidianSync: {
      statePath: string;
      exists: boolean;
      updatedAt: string | null;
      vaultCount: number;
      activeChunkCount: number;
      deletedNoteCount: number;
    };
    openclawWorkspaceSync: {
      statePath: string;
      exists: boolean;
      updatedAt: string | null;
      fileCount: number;
      activeChunkCount: number;
      deletedFileCount: number;
    };
  };
  explicitCapture: {
    captureMode: string;
    enabled: boolean;
    memoryDocPath: string;
    memoryDocExists: boolean;
    memoryDocInstalled: boolean;
    memoryDocUpdated: boolean;
    memoryDocRemoved: boolean;
    preview: string | null;
  };
  nextSteps: string[];
  verificationCommands: string[];
}

export interface OperatorDoctorCheck {
  key: string;
  status: "ok" | "warn" | "error";
  summary: string;
  remediation?: string;
  details?: unknown;
}

export interface OperatorConfigReviewFinding {
  key: string;
  status: "recommend" | "problem";
  setting: string;
  currentValue: string;
  defaultValue: string;
  recommendedValue: string;
  summary: string;
  rationale: string;
}

export interface OperatorConfigReviewReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  config: OperatorConfigLoadResult;
  profile: {
    memoryOsPreset?: string;
    searchBackend: string;
    qmdEnabled: boolean;
    qmdDaemonEnabled: boolean;
    nativeKnowledgeEnabled: boolean;
    fileHygieneEnabled: boolean;
    conversationIndexEnabled: boolean;
  };
  summary: {
    recommend: number;
    problem: number;
  };
  findings: OperatorConfigReviewFinding[];
}

export interface OperatorDoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  config: OperatorConfigLoadResult;
  checks: OperatorDoctorCheck[];
}

export interface OperatorInventoryNamespaceSummary {
  namespace: string;
  memoryCount: number;
  entityCount: number;
}

export interface OperatorInventoryReport {
  schemaVersion: 1;
  generatedAt: string;
  memoryDir: string;
  totals: {
    memories: number;
    entities: number;
    namespaces: number;
    reviewQueue: number;
    storageBytes: number;
  };
  categories: Record<string, number>;
  statuses: Record<string, number>;
  namespaces: OperatorInventoryNamespaceSummary[];
  ageBands: Record<string, number>;
  profile: {
    exists: boolean;
    chars: number;
    lines: number;
  };
  storageFootprint: {
    bytes: number;
    byTopLevel: Record<string, number>;
  };
  archivePressure: {
    archived: number;
    pendingReview: number;
    quarantined: number;
    rejected: number;
  };
  conversationIndex: {
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
  };
  nativeKnowledge: {
    enabled: boolean;
    curatedIncludeSync: {
      exists: boolean;
      updatedAt: string | null;
      fileCount: number;
      activeChunkCount: number;
      deletedFileCount: number;
    };
    obsidianSync: {
      exists: boolean;
      updatedAt: string | null;
      vaultCount: number;
      activeChunkCount: number;
      deletedNoteCount: number;
    };
    openclawWorkspaceSync: {
      exists: boolean;
      updatedAt: string | null;
      fileCount: number;
      activeChunkCount: number;
      deletedFileCount: number;
    };
  };
}

export interface BenchmarkRecallReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "status" | "validate" | "baseline-report" | "ci-gate" | "snapshot";
  status: EvalHarnessStatus;
  validate?: Awaited<ReturnType<typeof validateEvalBenchmarkPack>>;
  baselineReport?: EvalBaselineDeltaReport;
  ciGate?: EvalCiGateReport;
  snapshot?: {
    targetPath: string;
    snapshotId: string;
  };
}

export interface OperatorRepairReport {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: boolean;
  sessionCheck: SessionIntegrityReport;
  sessionRepairPlan: SessionRepairPlan;
  sessionRepairApply: SessionRepairApplyResult;
  graphHealth: GraphHealthReport;
}

export interface OperatorSetupOptions {
  orchestrator: OperatorToolkitOrchestrator;
  installCaptureInstructions?: boolean;
  captureInstructionsMode?: "preview" | "install" | "remove";
  configPath?: string;
  now?: Date;
}

export interface OperatorDoctorOptions {
  orchestrator: OperatorToolkitOrchestrator;
  configPath?: string;
  now?: Date;
}

export interface OperatorConfigReviewOptions {
  orchestrator: OperatorToolkitOrchestrator;
  configPath?: string;
  now?: Date;
}

export interface OperatorInventoryOptions {
  orchestrator: OperatorToolkitOrchestrator;
  now?: Date;
}

export interface BenchmarkRecallOptions {
  config: Pick<
    PluginConfig,
    | "memoryDir"
    | "evalStoreDir"
    | "evalHarnessEnabled"
    | "evalShadowModeEnabled"
    | "benchmarkBaselineSnapshotsEnabled"
    | "benchmarkDeltaReporterEnabled"
    | "memoryRedTeamBenchEnabled"
  >;
  validatePath?: string;
  baseEvalStoreDir?: string;
  candidateEvalStoreDir?: string;
  snapshotId?: string;
  createSnapshot?: boolean;
  snapshotNotes?: string;
  gitRef?: string;
  createdAt?: string;
  now?: Date;
}

export interface OperatorRepairOptions {
  config: Pick<
    PluginConfig,
    "memoryDir" | "entityGraphEnabled" | "timeGraphEnabled" | "causalGraphEnabled"
  >;
  apply?: boolean;
  dryRun?: boolean;
  allowSessionFileRepair?: boolean;
  sessionFilesDir?: string;
  now?: Date;
}

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) return explicitPath.trim();
  const configured =
    readEnvVar("OPENCLAW_CONFIG_PATH") ||
    readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH");
  if (configured && configured.trim().length > 0) return configured.trim();
  return path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
}

async function loadCliPluginConfig(configPath?: string): Promise<OperatorConfigLoadResult> {
  const resolvedPath = resolveConfigPath(configPath);
  try {
    const raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as Record<string, unknown>;
    // Delegate slot → canonical → legacy resolution to the generic helper so
    // all config loaders stay in sync (#403).
    const entry = resolveOpenClawRemnicPluginEntry(raw);
    const parsedConfig = parseConfig(
      entry && typeof entry === "object"
        ? ((entry["config"] as Record<string, unknown> | undefined) ?? {})
        : {},
    );
    return {
      found: true,
      path: resolvedPath,
      parsed: true,
      memoryDir: parsedConfig.memoryDir,
      workspaceDir: parsedConfig.workspaceDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      found: !/ENOENT/i.test(message),
      path: resolvedPath,
      parsed: false,
      error: message,
    };
  }
}

async function isWritable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatConfigValue(value: unknown): string {
  if (value === undefined || value === null) return "(unset)";
  if (typeof value === "string") return value.length > 0 ? value : "(unset)";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function gatherDirectoryStatus(
  paths: string[],
): Promise<Array<{ path: string; exists: boolean; writable: boolean }>> {
  return Promise.all(paths.map(async (targetPath) => {
    try {
      await access(targetPath, fsConstants.F_OK);
      return {
        path: targetPath,
        exists: true,
        writable: await isWritable(targetPath),
      };
    } catch {
      return {
        path: targetPath,
        exists: false,
        writable: false,
      };
    }
  }));
}

function getSetupPaths(config: PluginConfig): string[] {
  return [
    config.memoryDir,
    config.workspaceDir,
    path.join(config.memoryDir, "facts"),
    path.join(config.memoryDir, "entities"),
    path.join(config.memoryDir, "state"),
    path.join(config.memoryDir, "questions"),
    path.join(config.memoryDir, "artifacts"),
    path.join(config.memoryDir, "config"),
  ];
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

async function summarizeNativeKnowledgeStatus(config: PluginConfig): Promise<{
  enabled: boolean;
  includeFiles: string[];
  curatedIncludeSync: {
    statePath: string;
    exists: boolean;
    updatedAt: string | null;
    fileCount: number;
    activeChunkCount: number;
    deletedFileCount: number;
  };
  openclawWorkspaceAdapterEnabled: boolean;
  obsidianVaultAdapterEnabled: boolean;
  obsidianSync: {
    statePath: string;
    exists: boolean;
    updatedAt: string | null;
    vaultCount: number;
    activeChunkCount: number;
    deletedNoteCount: number;
  };
  openclawWorkspaceSync: {
    statePath: string;
    exists: boolean;
    updatedAt: string | null;
    fileCount: number;
    activeChunkCount: number;
    deletedFileCount: number;
  };
}> {
  const nativeKnowledge = config.nativeKnowledge;
  const nativeKnowledgeStateDir = nativeKnowledge?.stateDir ?? "state/native-knowledge";
  const curatedStatePath = nativeKnowledge
    ? resolveCuratedIncludeFilesStatePath(config.memoryDir, nativeKnowledge)
    : path.join(config.memoryDir, nativeKnowledgeStateDir, "curated-include-sync.json");
  const obsidianStatePath = nativeKnowledge
    ? resolveNativeKnowledgeStatePath(config.memoryDir, nativeKnowledge)
    : path.join(config.memoryDir, nativeKnowledgeStateDir, "obsidian-sync.json");
  const openclawStatePath = nativeKnowledge
    ? resolveOpenClawWorkspaceStatePath(config.memoryDir, nativeKnowledge)
    : path.join(config.memoryDir, nativeKnowledgeStateDir, "openclaw-workspace-sync.json");
  const [curatedRaw, obsidianRaw, openclawRaw] = await Promise.all([
    readJsonIfExists(curatedStatePath),
    readJsonIfExists(obsidianStatePath),
    readJsonIfExists(openclawStatePath),
  ]);

  const curatedFiles = curatedRaw && typeof curatedRaw === "object" && curatedRaw !== null
    && "files" in curatedRaw && typeof (curatedRaw as { files?: unknown }).files === "object"
    && (curatedRaw as { files?: unknown }).files !== null
      ? (curatedRaw as {
          updatedAt?: unknown;
          files: Record<string, { deleted?: boolean; chunks?: unknown[] }>;
        })
      : null;

  let curatedActiveChunkCount = 0;
  let curatedDeletedFileCount = 0;
  for (const file of Object.values(curatedFiles?.files ?? {})) {
    if (file.deleted) {
      curatedDeletedFileCount += 1;
      continue;
    }
    curatedActiveChunkCount += Array.isArray(file.chunks) ? file.chunks.length : 0;
  }

  const obsidianVaults = obsidianRaw && typeof obsidianRaw === "object" && obsidianRaw !== null
    && "vaults" in obsidianRaw && typeof (obsidianRaw as { vaults?: unknown }).vaults === "object"
    && (obsidianRaw as { vaults?: unknown }).vaults !== null
      ? (obsidianRaw as {
          updatedAt?: unknown;
          vaults: Record<string, { notes?: Record<string, { deleted?: boolean; chunks?: unknown[] }> }>;
        })
      : null;

  let obsidianActiveChunkCount = 0;
  let obsidianDeletedNoteCount = 0;
  for (const vault of Object.values(obsidianVaults?.vaults ?? {})) {
    for (const note of Object.values(vault.notes ?? {})) {
      if (note.deleted) {
        obsidianDeletedNoteCount += 1;
        continue;
      }
      obsidianActiveChunkCount += Array.isArray(note.chunks) ? note.chunks.length : 0;
    }
  }

  const openclawFiles = openclawRaw && typeof openclawRaw === "object" && openclawRaw !== null
    && "files" in openclawRaw && typeof (openclawRaw as { files?: unknown }).files === "object"
    && (openclawRaw as { files?: unknown }).files !== null
      ? (openclawRaw as {
          updatedAt?: unknown;
          files: Record<string, { deleted?: boolean; chunks?: unknown[] }>;
        })
      : null;

  let openclawActiveChunkCount = 0;
  let openclawDeletedFileCount = 0;
  for (const file of Object.values(openclawFiles?.files ?? {})) {
    if (file.deleted) {
      openclawDeletedFileCount += 1;
      continue;
    }
    openclawActiveChunkCount += Array.isArray(file.chunks) ? file.chunks.length : 0;
  }

  return {
    enabled: nativeKnowledge?.enabled === true,
    includeFiles: nativeKnowledge?.includeFiles ?? [],
    curatedIncludeSync: {
      statePath: curatedStatePath,
      exists: curatedFiles !== null,
      updatedAt: typeof curatedFiles?.updatedAt === "string" ? curatedFiles.updatedAt : null,
      fileCount: Object.keys(curatedFiles?.files ?? {}).length,
      activeChunkCount: curatedActiveChunkCount,
      deletedFileCount: curatedDeletedFileCount,
    },
    openclawWorkspaceAdapterEnabled: nativeKnowledge?.openclawWorkspace?.enabled === true,
    obsidianVaultAdapterEnabled: (nativeKnowledge?.obsidianVaults?.length ?? 0) > 0,
    obsidianSync: {
      statePath: obsidianStatePath,
      exists: obsidianVaults !== null,
      updatedAt: typeof obsidianVaults?.updatedAt === "string" ? obsidianVaults.updatedAt : null,
      vaultCount: Object.keys(obsidianVaults?.vaults ?? {}).length,
      activeChunkCount: obsidianActiveChunkCount,
      deletedNoteCount: obsidianDeletedNoteCount,
    },
    openclawWorkspaceSync: {
      statePath: openclawStatePath,
      exists: openclawFiles !== null,
      updatedAt: typeof openclawFiles?.updatedAt === "string" ? openclawFiles.updatedAt : null,
      fileCount: Object.keys(openclawFiles?.files ?? {}).length,
      activeChunkCount: openclawActiveChunkCount,
      deletedFileCount: openclawDeletedFileCount,
    },
  };
}

const CAPTURE_INSTRUCTIONS_START = "<!-- BEGIN ENGRAM EXPLICIT CAPTURE INSTRUCTIONS -->";
const CAPTURE_INSTRUCTIONS_END = "<!-- END ENGRAM EXPLICIT CAPTURE INSTRUCTIONS -->";

function buildCaptureInstructions(): string {
  return [
    CAPTURE_INSTRUCTIONS_START,
    "# Memory",
    "",
    "Use this file for explicit memory capture notes when Engram runs in explicit or hybrid mode.",
    "",
    "## Suggested format",
    "",
    "- Write durable facts, decisions, commitments, or corrections.",
    "- Keep entries concise and specific.",
    "- Avoid secrets, tokens, and private credentials.",
    "",
    "## Example",
    "",
    "- Decision: recall benchmark packs live under `state/evals/benchmarks/`.",
    "- Commitment: rerun `openclaw engram doctor --json` after changing retrieval settings.",
    "",
    CAPTURE_INSTRUCTIONS_END,
  ].join("\n");
}

function upsertManagedCaptureInstructions(existing: string | null, snippet: string): { content: string; updated: boolean; installed: boolean } {
  if (!existing || existing.trim().length === 0) {
    return { content: `${snippet}\n`, updated: false, installed: true };
  }
  if (existing.includes(CAPTURE_INSTRUCTIONS_START) && existing.includes(CAPTURE_INSTRUCTIONS_END)) {
    const next = existing.replace(
      new RegExp(`${CAPTURE_INSTRUCTIONS_START}[\\s\\S]*?${CAPTURE_INSTRUCTIONS_END}`),
      snippet,
    );
    return { content: next.endsWith("\n") ? next : `${next}\n`, updated: next !== existing, installed: false };
  }
  const trimmed = existing.trimEnd();
  return {
    content: `${trimmed}\n\n${snippet}\n`,
    updated: false,
    installed: true,
  };
}

function removeManagedCaptureInstructions(existing: string): { content: string; removed: boolean } {
  if (!existing.includes(CAPTURE_INSTRUCTIONS_START) || !existing.includes(CAPTURE_INSTRUCTIONS_END)) {
    return { content: existing, removed: false };
  }
  const stripped = existing
    .replace(new RegExp(`\\n*${CAPTURE_INSTRUCTIONS_START}[\\s\\S]*?${CAPTURE_INSTRUCTIONS_END}\\n*`), "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    content: stripped.length > 0 ? `${stripped}\n` : "",
    removed: true,
  };
}

export async function runOperatorSetup(options: OperatorSetupOptions): Promise<OperatorSetupReport> {
  const now = options.now ?? new Date();
  const configStatus = await loadCliPluginConfig(options.configPath);
  const storage = options.orchestrator.storage;
  await storage.ensureDirectories();
  await mkdir(options.orchestrator.config.workspaceDir, { recursive: true });

  const qmdAvailable = await options.orchestrator.qmd.probe();
  const collectionState = options.orchestrator.config.qmdEnabled
    ? await options.orchestrator.qmd.ensureCollection(options.orchestrator.config.memoryDir)
    : "skipped";
  const nativeKnowledgeStatus = await summarizeNativeKnowledgeStatus(options.orchestrator.config);

  const memoryDocPath = path.join(options.orchestrator.config.workspaceDir, "MEMORY.md");
  const captureInstructionsMode =
    options.captureInstructionsMode
    ?? (options.installCaptureInstructions ? "install" : undefined);
  let memoryDocExists = false;
  try {
    await access(memoryDocPath, fsConstants.F_OK);
    memoryDocExists = true;
  } catch {
    memoryDocExists = false;
  }
  let memoryDocInstalled = false;
  let memoryDocUpdated = false;
  let memoryDocRemoved = false;
  const explicitCaptureEnabled = options.orchestrator.config.captureMode === "explicit"
    || options.orchestrator.config.captureMode === "hybrid";
  const captureInstructionsPreview = captureInstructionsMode ? buildCaptureInstructions() : null;
  if (captureInstructionsMode) {
    if (captureInstructionsMode === "preview") {
      // no-op, preview only
    } else if (captureInstructionsMode === "install") {
      const existing = memoryDocExists ? await readFile(memoryDocPath, "utf-8") : null;
      const next = upsertManagedCaptureInstructions(existing, captureInstructionsPreview ?? "");
      if (!existing || next.content !== existing) {
        await writeFile(memoryDocPath, next.content, "utf-8");
      }
      memoryDocExists = true;
      memoryDocInstalled = next.installed;
      memoryDocUpdated = next.updated;
    } else if (captureInstructionsMode === "remove" && memoryDocExists) {
      const existing = await readFile(memoryDocPath, "utf-8");
      const next = removeManagedCaptureInstructions(existing);
      if (next.removed) {
        if (next.content.length === 0) {
          await unlink(memoryDocPath);
          memoryDocExists = false;
        } else {
          await writeFile(memoryDocPath, next.content, "utf-8");
          memoryDocExists = true;
        }
        memoryDocRemoved = true;
      }
    }
  }

  const directories = await gatherDirectoryStatus(getSetupPaths(options.orchestrator.config));
  const nextSteps = [
    `Run \`openclaw engram doctor${options.installCaptureInstructions ? "" : " --json"}\` to verify runtime health.`,
    "Run `openclaw engram inventory --json` to capture a baseline footprint.",
    "If QMD is enabled and the collection is missing, add the collection to `~/.config/qmd/index.yml` and run `qmd update && qmd embed`.",
  ];
  if (explicitCaptureEnabled && !memoryDocExists) {
    nextSteps.push("Run `openclaw engram setup --preview-capture-instructions` to review the managed explicit-capture snippet, then `--install-capture-instructions` to write it.");
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    config: configStatus,
    memoryDir: options.orchestrator.config.memoryDir,
    workspaceDir: options.orchestrator.config.workspaceDir,
    directories,
    qmd: {
      enabled: options.orchestrator.config.qmdEnabled,
      available: qmdAvailable,
      collectionState,
      debugStatus: options.orchestrator.qmd.debugStatus(),
    },
    nativeKnowledge: nativeKnowledgeStatus,
    explicitCapture: {
      captureMode: options.orchestrator.config.captureMode,
      enabled: explicitCaptureEnabled,
      memoryDocPath,
      memoryDocExists,
      memoryDocInstalled,
      memoryDocUpdated,
      memoryDocRemoved,
      preview: captureInstructionsMode === "preview" ? captureInstructionsPreview : null,
    },
    nextSteps,
    verificationCommands: [
      "openclaw engram doctor --json",
      "openclaw engram inventory --json",
      "openclaw engram benchmark recall --json",
    ],
  };
}

function summarizeHygieneWarnings(
  warnings: Awaited<ReturnType<typeof lintWorkspaceFiles>>,
  hygiene: FileHygieneConfig | undefined,
): OperatorDoctorCheck {
  if (!hygiene?.enabled || hygiene.lintEnabled !== true) {
    return {
      key: "file_hygiene",
      status: "warn",
      summary: "File hygiene linting is disabled; bootstrap file truncation warnings are not active.",
      remediation: "Enable `fileHygiene.enabled` and `fileHygiene.lintEnabled` if large workspace bootstrap files are common.",
      details: {
        enabled: hygiene?.enabled === true,
        lintEnabled: hygiene?.lintEnabled === true,
      },
    };
  }
  if (warnings.length > 0) {
    return {
      key: "file_hygiene",
      status: "warn",
      summary: `${warnings.length} bootstrap file(s) are near or above the configured budget.`,
      remediation: "Archive/split the listed files or adjust `fileHygiene` budgets.",
      details: { warnings },
    };
  }
  return {
    key: "file_hygiene",
    status: "ok",
    summary: "Bootstrap file hygiene is within budget.",
    details: {
      enabled: true,
      lintPaths: hygiene.lintPaths,
      budgetBytes: hygiene.lintBudgetBytes,
    },
  };
}

function buildConfigReviewFinding(input: {
  key: string;
  status: "recommend" | "problem";
  setting: string;
  currentValue: unknown;
  defaultValue: unknown;
  recommendedValue: unknown;
  summary: string;
  rationale: string;
}): OperatorConfigReviewFinding {
  return {
    key: input.key,
    status: input.status,
    setting: input.setting,
    currentValue: formatConfigValue(input.currentValue),
    defaultValue: formatConfigValue(input.defaultValue),
    recommendedValue: formatConfigValue(input.recommendedValue),
    summary: input.summary,
    rationale: input.rationale,
  };
}

export async function runOperatorConfigReview(
  options: OperatorConfigReviewOptions,
): Promise<OperatorConfigReviewReport> {
  const now = options.now ?? new Date();
  const configStatus = await loadCliPluginConfig(options.configPath);
  return buildOperatorConfigReviewReport({
    now,
    configStatus,
    config: options.orchestrator.config,
  });
}

async function buildOperatorConfigReviewReport(input: {
  now: Date;
  configStatus: OperatorConfigLoadResult;
  config: PluginConfig;
}): Promise<OperatorConfigReviewReport> {
  const { now, configStatus, config } = input;
  const findings: OperatorConfigReviewFinding[] = [];
  const searchBackend = config.searchBackend ?? "qmd";
  const workspaceBootstrapFiles = [
    path.join(config.workspaceDir, "IDENTITY.md"),
    path.join(config.workspaceDir, "MEMORY.md"),
    path.join(config.workspaceDir, "USER.md"),
  ];
  const workspaceBootstrapExists = (await Promise.all(workspaceBootstrapFiles.map(pathExists))).some(Boolean);

  if (
    config.memoryOsPreset !== "conservative" &&
    config.memoryOsPreset !== "balanced" &&
    config.memoryOsPreset !== "research-max" &&
    config.memoryOsPreset !== "local-llm-heavy" &&
    config.queryAwareIndexingEnabled === false &&
    config.verbatimArtifactsEnabled === false &&
    config.rerankEnabled === false
  ) {
    findings.push(buildConfigReviewFinding({
      key: "balanced_preset",
      status: "recommend",
      setting: "memoryOsPreset",
      currentValue: config.memoryOsPreset,
      defaultValue: "(unset)",
      recommendedValue: "balanced",
      summary: "Adopt the balanced preset as the baseline configuration profile.",
      rationale:
        "The balanced preset enables the recommended indexing, reranking, and artifact defaults without turning on the higher-churn graph and learning loops.",
    }));
  }

  if (config.qmdEnabled && config.qmdDaemonEnabled === false) {
    findings.push(buildConfigReviewFinding({
      key: "qmd_daemon",
      status: "recommend",
      setting: "qmdDaemonEnabled",
      currentValue: config.qmdDaemonEnabled,
      defaultValue: true,
      recommendedValue: true,
      summary: "Enable the QMD daemon path when QMD powers recall.",
      rationale:
        "The daemon path reduces recall/search contention by preferring the MCP transport instead of repeated subprocess calls when QMD is available.",
    }));
  }

  if (workspaceBootstrapExists && config.nativeKnowledge?.enabled !== true) {
    findings.push(buildConfigReviewFinding({
      key: "native_knowledge_enabled",
      status: "recommend",
      setting: "nativeKnowledge.enabled",
      currentValue: config.nativeKnowledge?.enabled,
      defaultValue: false,
      recommendedValue: true,
      summary: "Enable native knowledge recall for workspace bootstrap documents.",
      rationale:
        "When files like IDENTITY.md or MEMORY.md already exist, native knowledge recall can chunk and inject them directly instead of relying only on extracted memories.",
    }));
  }

  if (workspaceBootstrapExists && config.fileHygiene?.enabled !== true) {
    findings.push(buildConfigReviewFinding({
      key: "file_hygiene_enabled",
      status: "recommend",
      setting: "fileHygiene.enabled",
      currentValue: config.fileHygiene?.enabled,
      defaultValue: false,
      recommendedValue: true,
      summary: "Enable file hygiene to avoid silent workspace-file truncation.",
      rationale:
        "OpenClaw bootstrap files can grow quietly; file hygiene warns before oversized files are truncated during prompt bootstrap.",
    }));
  }

  if (searchBackend === "qmd" && config.qmdEnabled === false) {
    findings.push(buildConfigReviewFinding({
      key: "qmd_search_backend_disabled",
      status: "problem",
      setting: "qmdEnabled",
      currentValue: config.qmdEnabled,
      defaultValue: true,
      recommendedValue: true,
      summary: "QMD search is selected but QMD is disabled.",
      rationale:
        "When searchBackend resolves to qmd while qmdEnabled is false, Engram falls back to the noop backend and disables the primary search path.",
    }));
  }

  if (config.qmdColdTierEnabled === true && config.qmdEnabled === false) {
    findings.push(buildConfigReviewFinding({
      key: "qmd_cold_tier_requires_qmd",
      status: "problem",
      setting: "qmdEnabled",
      currentValue: config.qmdEnabled,
      defaultValue: true,
      recommendedValue: true,
      summary: "Cold-tier QMD recall is enabled while QMD itself is disabled.",
      rationale:
        "The cold tier depends on the same QMD runtime as the hot tier, so turning QMD off leaves the extra tiering path unusable.",
    }));
  }

  if (config.qmdTierMigrationEnabled && config.qmdColdTierEnabled !== true) {
    findings.push(buildConfigReviewFinding({
      key: "qmd_tier_migration_requires_cold_tier",
      status: "problem",
      setting: "qmdColdTierEnabled",
      currentValue: config.qmdColdTierEnabled,
      defaultValue: false,
      recommendedValue: true,
      summary: "Hot/cold tier migration is enabled without the cold tier itself.",
      rationale:
        "Tier migration depends on the cold-tier collection and recall path, so enabling migration while the cold tier is off leaves the feature in a contradictory state.",
    }));
  }

  if (config.conversationIndexEnabled && config.conversationIndexBackend === "qmd" && config.qmdEnabled === false) {
    findings.push(buildConfigReviewFinding({
      key: "conversation_index_qmd_requires_qmd",
      status: "problem",
      setting: "qmdEnabled",
      currentValue: config.qmdEnabled,
      defaultValue: true,
      recommendedValue: true,
      summary: "The conversation index is configured for QMD while QMD is disabled.",
      rationale:
        "A QMD-backed conversation index cannot rebuild or serve queries when the underlying QMD runtime is disabled.",
    }));
  }

  const summary = findings.reduce(
    (acc, finding) => {
      acc[finding.status] += 1;
      return acc;
    },
    { recommend: 0, problem: 0 },
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    ok: configStatus.parsed && summary.problem === 0,
    config: configStatus,
    profile: {
      memoryOsPreset: config.memoryOsPreset,
      searchBackend,
      qmdEnabled: config.qmdEnabled,
      qmdDaemonEnabled: config.qmdDaemonEnabled,
      nativeKnowledgeEnabled: config.nativeKnowledge?.enabled === true,
      fileHygieneEnabled: config.fileHygiene?.enabled === true,
      conversationIndexEnabled: config.conversationIndexEnabled,
    },
    summary,
    findings,
  };
}

export async function runOperatorDoctor(options: OperatorDoctorOptions): Promise<OperatorDoctorReport> {
  const now = options.now ?? new Date();
  const configStatus = await loadCliPluginConfig(options.configPath);
  const checks: OperatorDoctorCheck[] = [];
  const config = options.orchestrator.config;
  const storage = options.orchestrator.storage;
  const configReview = await buildOperatorConfigReviewReport({
    now,
    configStatus,
    config,
  });
  const nativeKnowledgeStatus = await summarizeNativeKnowledgeStatus(config);
  const setupPaths = await gatherDirectoryStatus(getSetupPaths(config));
  const missingPaths = setupPaths.filter((entry) => !entry.exists).map((entry) => entry.path);

  checks.push({
    key: "config",
    status: configStatus.parsed
      ? "ok"
      : options.configPath
      ? "error"
      : "warn",
    summary: configStatus.parsed ? "OpenClaw config loaded and Engram config parsed successfully." : "Config file could not be parsed.",
    remediation: configStatus.parsed ? undefined : "Fix the config file or set OPENCLAW_ENGRAM_CONFIG_PATH/OPENCLAW_CONFIG_PATH.",
    details: configStatus,
  });

  checks.push({
    key: "memory_dir",
    status: missingPaths.length === 0 ? "ok" : "warn",
    summary: missingPaths.length === 0
      ? "Expected Engram directories exist."
      : `${missingPaths.length} expected directory path(s) are missing.`,
    remediation: missingPaths.length === 0 ? undefined : "Run `openclaw engram setup` to create missing directories.",
    details: { directories: setupPaths },
  });

  checks.push({
    key: "config_review",
    status: configReview.summary.problem > 0 ? "error" : configReview.summary.recommend > 0 ? "warn" : "ok",
    summary: configReview.summary.problem > 0
      ? `${configReview.summary.problem} configuration problem(s) detected.`
      : configReview.summary.recommend > 0
      ? `No configuration problems detected; ${configReview.summary.recommend} optional recommendation(s) are available.`
      : "No configuration problems detected.",
    remediation: configReview.summary.problem > 0 || configReview.summary.recommend > 0
      ? "Run `openclaw engram config-review` to inspect and fix the flagged configuration combinations."
      : undefined,
    details: configReview,
  });

  const qmdAvailable = await options.orchestrator.qmd.probe();
  const collectionState = config.qmdEnabled
    ? await options.orchestrator.qmd.ensureCollection(config.memoryDir)
    : "skipped";
  checks.push({
    key: "qmd",
    status: !config.qmdEnabled
      ? "warn"
      : !qmdAvailable
      ? "error"
      : collectionState === "present"
      ? "ok"
      : collectionState === "missing"
      ? "error"
      : "warn",
    summary: !config.qmdEnabled
      ? "QMD is disabled in config."
      : qmdAvailable
      ? `QMD is reachable (${collectionState}).`
      : "QMD is not currently reachable.",
    remediation: !config.qmdEnabled
      ? "Enable `qmdEnabled` if you expect hybrid search."
      : !qmdAvailable
      ? "Ensure the `qmd` binary is installed and on PATH, or set `qmdPath`."
      : collectionState === "missing"
      ? "Add the configured collection to `~/.config/qmd/index.yml`."
      : collectionState === "present"
      ? undefined
      : "Re-run `openclaw engram setup` after restoring QMD access.",
    details: {
      available: qmdAvailable,
      collectionState,
      debugStatus: options.orchestrator.qmd.debugStatus(),
    },
  });

  const conversationIndex = await options.orchestrator.getConversationIndexHealth();
  checks.push({
    key: "conversation_index",
    status: conversationIndex.status === "ok"
      ? "ok"
      : conversationIndex.enabled
      ? "error"
      : "warn",
    summary: conversationIndex.enabled
      ? `Conversation index backend is ${conversationIndex.status}.`
      : "Conversation index is disabled.",
    remediation: conversationIndex.enabled && conversationIndex.status !== "ok"
      ? "Run `openclaw engram rebuild-index` to refresh the conversation index artifacts."
      : undefined,
    details: conversationIndex,
  });

  const meta = await storage.loadMeta();
  checks.push({
    key: "maintenance",
    status: meta.lastExtractionAt || meta.lastConsolidationAt ? "ok" : "warn",
    summary: meta.lastExtractionAt || meta.lastConsolidationAt
      ? "Extraction/consolidation metadata is present."
      : "No extraction or consolidation metadata found yet.",
    remediation: meta.lastExtractionAt || meta.lastConsolidationAt
      ? undefined
      : "Run a normal agent turn or `openclaw engram consolidate` after seeding memory.",
    details: meta,
  });

  const syncedChunkCount =
    nativeKnowledgeStatus.curatedIncludeSync.activeChunkCount +
    nativeKnowledgeStatus.obsidianSync.activeChunkCount +
    nativeKnowledgeStatus.openclawWorkspaceSync.activeChunkCount;
  const hasSyncState =
    nativeKnowledgeStatus.curatedIncludeSync.exists ||
    nativeKnowledgeStatus.obsidianSync.exists ||
    nativeKnowledgeStatus.openclawWorkspaceSync.exists;
  checks.push({
    key: "native_knowledge",
    status: !nativeKnowledgeStatus.enabled
      ? "warn"
      : hasSyncState
        ? "ok"
        : "warn",
    summary: !nativeKnowledgeStatus.enabled
      ? "Native knowledge sync is disabled."
      : hasSyncState
        ? `Native knowledge sync state is present (${syncedChunkCount} active chunks).`
        : "Native knowledge sync is enabled but no sync state has been written yet.",
    remediation: !nativeKnowledgeStatus.enabled
      ? "Enable `nativeKnowledge.enabled` if curated workspace recall should participate in retrieval."
      : hasSyncState
        ? undefined
        : "Run a recall, sync, or setup flow that touches native knowledge sources, then rerun `openclaw engram doctor --json`.",
    details: nativeKnowledgeStatus,
  });

  const agentAccessEnabled = config.agentAccessHttp?.enabled === true;
  // A SecretRef object counts as "configured" (issue #757) — resolution
  // happens at service-start time, not at doctor-time.  We only check that
  // *something* is set; we never log the resolved value.
  const rawAuthToken = config.agentAccessHttp?.authToken;
  const authTokenConfigured =
    (typeof rawAuthToken === "string" && rawAuthToken.length > 0) ||
    (rawAuthToken !== null &&
      typeof rawAuthToken === "object" &&
      typeof (rawAuthToken as { source?: unknown }).source === "string");
  checks.push({
    key: "access_http_auth",
    status: !agentAccessEnabled
      ? "warn"
      : authTokenConfigured
      ? "ok"
      : "error",
    summary: !agentAccessEnabled
      ? "Agent access HTTP bridge is disabled."
      : authTokenConfigured
      ? "Agent access HTTP bridge has an auth token configured."
      : "Agent access HTTP bridge is enabled without an auth token.",
    remediation: !agentAccessEnabled
      ? "Ignore unless you plan to enable the HTTP bridge."
      : authTokenConfigured
      ? undefined
      : "Set `agentAccessHttp.authToken` before exposing the bridge.",
  });

  const warnings = config.fileHygiene?.lintEnabled
    ? await lintWorkspaceFiles({
        workspaceDir: config.workspaceDir,
        paths: config.fileHygiene.lintPaths,
        budgetBytes: config.fileHygiene.lintBudgetBytes,
        warnRatio: config.fileHygiene.lintWarnRatio,
      })
    : [];
  checks.push(summarizeHygieneWarnings(warnings, config.fileHygiene));

  // Memory Worth legacy counter audit (issue #560 PR 1).
  // Memories written before #560 have no `mw_success` / `mw_fail` frontmatter
  // fields. That is fully supported — readers treat the absence as a uniform
  // Beta(1,1) prior — but surfacing the count helps operators understand how
  // much history will bootstrap the scoring pipeline landed in later PRs.
  // This is an informational check, never an error.
  checks.push(await summarizeMemoryWorthLegacyCounters(storage));

  // Buffer surprise telemetry distribution (issue #563 PR 3).
  // Surfaces recent surprise scores so operators can calibrate the
  // `bufferSurpriseThreshold` from real traffic. Never an error — an empty
  // ledger is the expected state until the flag is turned on.
  checks.push(
    await summarizeBufferSurpriseDistribution(storage, config),
  );

  // Consolidation provenance integrity (issue #561 PR 4).
  // Validates that every `derived_from` entry resolves to an on-disk
  // page-version snapshot and every `derived_via` is a known operator.
  // Broken provenance emits warnings with the offending file path — the
  // check is informational (never an error) because a missing snapshot
  // can legitimately occur after log pruning or versioning being disabled
  // retroactively; operators need visibility, not a hard fail.  Review
  // feedback (PR #634): the summarizer threads the configured
  // `versioningSidecarDir` into the scan so deployments that override
  // the default `.versions` directory get accurate results instead of
  // false-missing warnings.
  checks.push(await summarizeConsolidationProvenance(storage, config));

  // Graph-edge decay maintenance status (issue #681 PR 2/3).
  // Reports whether the periodic decay job has run and surfaces last-run
  // counts. Disabled is "ok" with a note; enabled-but-never-run is "warn".
  checks.push(await summarizeGraphEdgeDecayStatus(config));

  // Tier distribution (issue #686 retention-completion).
  // Shows hot/cold counts, per-status breakdown, and forgotten-memory count.
  // Informational only — never errors, never blocks doctor from returning ok.
  checks.push(await summarizeTierDistribution(options.orchestrator.storage));

  // Dreams phases thresholds and last-run timestamps (issue #678 PR 2/4).
  // Surfaces per-phase: enabled status, cadence, threshold values, and the
  // best-available last-run timestamp for each of the three pipeline phases.
  checks.push(await summarizeDreamsPhases(config, storage));

  // Security mitigation status (issue #565).
  // Reports whether the cross-namespace budget and anomaly detection
  // mitigations are enabled and surfaces config values for operator review.
  checks.push(summarizeSecurityMitigations(config));

  // Observation throughput + judge acceptance rate (issue #685).
  // Surfaces the total verdict count, accept/reject/defer breakdown, and the
  // most recent `observedAt` timestamp from the extraction-judge telemetry
  // ledger.  This closes the *(future)* item deferred in
  // `docs/trace-to-primitive.md`.  The check is purely informational — it
  // always resolves to `ok`; an empty ledger is the expected cold-install
  // state and is never an error.
  checks.push(await summarizeObservationThroughput(config.memoryDir));

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 },
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    ok: summary.error === 0,
    summary,
    config: configStatus,
    checks,
  };
}

/**
 * Categories whose memories are eligible for Memory Worth instrumentation.
 *
 * Memory Worth is a per-fact utility signal: the counters ride on extracted
 * facts whose retrieval outcome can be judged (success/fail) by the feedback
 * pipeline landing in issue #560 PR 3. Procedures, corrections, and other
 * non-fact memory kinds are out of scope — they are not expected to be
 * instrumented, and counting them as "legacy" would permanently inflate the
 * legacy bucket and make rollout progress misleading even when every fact
 * memory is instrumented.
 *
 * If a later PR widens Memory Worth to additional categories, extend this set
 * alongside the scoring/increment logic so the doctor audit stays in sync.
 */
const MEMORY_WORTH_ELIGIBLE_CATEGORIES: ReadonlySet<MemoryFile["frontmatter"]["category"]> =
  new Set(["fact"]);

/**
 * Count memories that pre-date the Memory Worth counters introduced in issue
 * #560 — i.e., neither `mw_success` nor `mw_fail` is set on the frontmatter.
 *
 * Only memories whose category is eligible for Memory Worth (see
 * `MEMORY_WORTH_ELIGIBLE_CATEGORIES`) are considered. Procedures, corrections,
 * and other kinds that are not instrumented are excluded entirely — they're
 * neither "legacy" nor "instrumented" for the purposes of this audit. The
 * total in the returned details reflects only eligible memories.
 *
 * Returned as an `ok` check regardless of count, since legacy memories are
 * fully functional (readers treat missing counters as zero observations). The
 * numbers are informational for operators following the #560 rollout.
 *
 * Exported so unit tests can exercise the classification logic without
 * booting a full orchestrator.
 */
export async function summarizeMemoryWorthLegacyCounters(
  storage: StorageManager,
): Promise<OperatorDoctorCheck> {
  let legacy = 0;
  let instrumented = 0;
  let ineligible = 0;
  try {
    const memories = await storage.readAllMemories();
    for (const memory of memories) {
      if (!MEMORY_WORTH_ELIGIBLE_CATEGORIES.has(memory.frontmatter.category)) {
        ineligible += 1;
        continue;
      }
      const { mw_success, mw_fail } = memory.frontmatter;
      if (mw_success === undefined && mw_fail === undefined) {
        legacy += 1;
      } else {
        instrumented += 1;
      }
    }
  } catch (err) {
    return {
      key: "memory_worth_legacy",
      status: "warn",
      summary: "Could not enumerate memories to count Memory Worth instrumentation.",
      remediation: "Retry `remnic doctor` after ensuring the memory directory is readable.",
      details: { error: String(err) },
    };
  }

  const total = legacy + instrumented;
  return {
    key: "memory_worth_legacy",
    status: "ok",
    summary:
      total === 0
        ? "No Memory Worth–eligible memories on disk yet — counters will populate as facts are extracted."
        : `${legacy} of ${total} eligible memories have no Memory Worth counters yet (${instrumented} instrumented).`,
    details: { legacy, instrumented, total, ineligible },
  };
}

/**
 * Summarize the recent buffer-surprise telemetry distribution for the
 * Doctor report (issue #563 PR 3).
 *
 * Reports mean/median/p90 surprise scores and the triggered-flush rate
 * over the most recent window of ledger rows. An empty ledger is the
 * expected state until `bufferSurpriseTriggerEnabled` is turned on — the
 * check never escalates beyond `ok` / `warn` (ledger unreadable).
 *
 * Exported so tests can exercise the formatting without booting a real
 * orchestrator.
 */
export async function summarizeBufferSurpriseDistribution(
  storage: StorageManager,
  config: PluginConfig,
): Promise<OperatorDoctorCheck> {
  const storageWithLedger = storage as StorageManager & {
    readBufferSurpriseEvents?: (
      opts: { limit?: number },
    ) => Promise<BufferSurpriseEvent[]>;
  };

  // Defensive: older StorageManager builds (not yet rebuilt) may lack the
  // reader. Do not fail the entire Doctor run in that case.
  if (typeof storageWithLedger.readBufferSurpriseEvents !== "function") {
    return {
      key: "buffer_surprise_distribution",
      status: "ok",
      summary: "Buffer-surprise telemetry reader unavailable in this build.",
      details: { available: false },
    };
  }

  try {
    const dist = await reportBufferSurpriseDistribution(
      async (opts) =>
        storageWithLedger.readBufferSurpriseEvents!({ limit: opts.limit }),
      { limit: 200 },
    );

    if (dist.count === 0) {
      return {
        key: "buffer_surprise_distribution",
        status: "ok",
        summary: config.bufferSurpriseTriggerEnabled
          ? "Surprise trigger is enabled but no telemetry has been recorded yet."
          : "Surprise trigger is disabled; no telemetry expected.",
        details: {
          enabled: config.bufferSurpriseTriggerEnabled,
          distribution: dist,
        },
      };
    }

    const pct = (value: number) => (value * 100).toFixed(1);
    return {
      key: "buffer_surprise_distribution",
      status: "ok",
      summary: `Recent surprise: mean=${dist.mean.toFixed(3)}, median=${dist.median.toFixed(3)}, p90=${dist.p90.toFixed(3)}, triggered=${pct(dist.triggeredRate)}% over ${dist.count} turns (threshold=${dist.currentThreshold ?? config.bufferSurpriseThreshold}).`,
      details: {
        enabled: config.bufferSurpriseTriggerEnabled,
        distribution: dist,
      },
    };
  } catch (err) {
    return {
      key: "buffer_surprise_distribution",
      status: "warn",
      summary: "Could not read buffer-surprise telemetry ledger.",
      remediation:
        "Retry `remnic doctor` after ensuring the memory state directory is readable.",
      details: { error: String(err) },
    };
  }
}

/**
 * Summarize the consolidation-provenance integrity scan for the doctor
 * report (issue #561 PR 4).  Returns an `ok` check when no issues are
 * found, `warn` otherwise.  Never returns `error` — a broken provenance
 * pointer is informational because it can legitimately result from log
 * pruning, versioning being disabled retroactively, or operator-driven
 * archive operations.
 *
 * Exported so unit tests can exercise the summarization without booting a
 * full orchestrator.
 */

async function summarizeGraphEdgeDecayStatus(
  config: Pick<
    PluginConfig,
    "memoryDir" | "graphEdgeDecayEnabled" | "graphEdgeDecayCadenceMs"
  >,
): Promise<OperatorDoctorCheck> {
  // Lazy import to keep the doctor fast when the feature is disabled.
  const { readGraphEdgeDecayStatus } = await import("./maintenance/graph-edge-decay.js");
  const enabled = config.graphEdgeDecayEnabled === true;
  if (!enabled) {
    return {
      key: "graph_edge_decay",
      status: "ok",
      summary: "Graph-edge decay maintenance is disabled (graphEdgeDecayEnabled = false).",
      remediation: "Set graphEdgeDecayEnabled = true to opt into the periodic decay job (issue #681).",
      details: { enabled: false },
    };
  }

  const status = await readGraphEdgeDecayStatus(config.memoryDir);
  if (!status) {
    return {
      key: "graph_edge_decay",
      status: "warn",
      summary: "Graph-edge decay is enabled but has not run yet (no status file present).",
      remediation:
        "Trigger the cron, run `engram.graph_edge_decay_run` via MCP, or wait for the scheduled cadence to fire.",
      details: { enabled: true, lastRun: null, cadenceMs: config.graphEdgeDecayCadenceMs },
    };
  }

  return {
    key: "graph_edge_decay",
    status: "ok",
    summary:
      `Graph-edge decay last ran at ${status.ranAt} ` +
      `(${status.edgesDecayed}/${status.edgesTotal} edges decayed, ` +
      `${status.edgesBelowVisibilityThreshold} below visibility threshold).`,
    details: {
      enabled: true,
      lastRun: status.ranAt,
      durationMs: status.durationMs,
      edgesTotal: status.edgesTotal,
      edgesDecayed: status.edgesDecayed,
      edgesBelowVisibilityThreshold: status.edgesBelowVisibilityThreshold,
      topDecayedEntities: status.topDecayedEntities,
      cadenceMs: config.graphEdgeDecayCadenceMs,
    },
  };
}

/**
 * Summarize hot/cold tier distribution for the Doctor report
 * (issue #686 retention-completion).
 *
 * Shows:
 *   - hot vs cold memory counts
 *   - forgotten-memory count
 *   - top per-status breakdown
 *   - recent migrations in the last 7 days (from the tier-migration journal)
 *   - top demotion reasons from the journal
 *
 * Always returns an `ok` check — this section is informational, never
 * a gate. A missing journal or unreadable corpus is surfaced as a note,
 * not an error.
 *
 * Exported so tests can exercise the summarizer without a full orchestrator.
 */
export async function summarizeTierDistribution(
  storage: StorageManager,
): Promise<OperatorDoctorCheck> {
  try {
    const { summarizeTiers } = await import("./maintenance/tier-stats.js");
    const summary = await summarizeTiers(storage);

    // Read recent migration journal entries (last 7 days)
    const storageDir = (storage as unknown as { dir?: string }).dir ?? "";
    const journalPath = storageDir.length > 0
      ? path.join(storageDir, "state", "tier-migration-journal.jsonl")
      : null;
    let recentMigrations = 0;
    const demotionReasons: Record<string, number> = {};
    const sevenDaysAgoMs = Date.now() - 7 * 86_400_000;

    if (journalPath) {
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(journalPath, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const entry = JSON.parse(trimmed) as {
              ts?: string;
              changed?: boolean;
              fromTier?: string;
              toTier?: string;
              reason?: string;
            };
            const tsMs = entry.ts ? Date.parse(entry.ts) : NaN;
            if (Number.isFinite(tsMs) && tsMs >= sevenDaysAgoMs && entry.changed === true) {
              recentMigrations += 1;
              if (entry.fromTier === "hot" && entry.toTier === "cold" && typeof entry.reason === "string") {
                const reason = entry.reason;
                demotionReasons[reason] = (demotionReasons[reason] ?? 0) + 1;
              }
            }
          } catch {
            // Malformed line — skip
          }
        }
      } catch {
        // Journal not present yet — expected on fresh installs
      }
    }

    const topDemotionReasons = Object.entries(demotionReasons)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    const statusParts = Object.entries(summary.byStatus)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([s, n]) => `${s}: ${n}`)
      .join(", ");

    return {
      key: "tier_distribution",
      status: "ok",
      summary:
        `Tier distribution: hot=${summary.byTier.hot}, cold=${summary.byTier.cold}` +
        (summary.forgottenCount > 0 ? `, forgotten=${summary.forgottenCount}` : "") +
        `. Total: ${summary.total}.` +
        (recentMigrations > 0 ? ` Recent migrations (7d): ${recentMigrations}.` : ""),
      details: {
        total: summary.total,
        byTier: summary.byTier,
        byStatus: summary.byStatus,
        forgottenCount: summary.forgottenCount,
        statusSummary: statusParts,
        recentMigrations,
        topDemotionReasons,
      },
    };
  } catch (err) {
    return {
      key: "tier_distribution",
      status: "ok",
      summary: "Tier distribution unavailable — could not enumerate memories.",
      details: { error: String(err) },
    };
  }
}

/**
 * Dreams phases doctor check (issue #678 PR 2/4).
 *
 * Reports per-phase: enabled status, cadence, threshold values, and last-run
 * timestamp sourced from `meta.json` (the existing maintenance ledger).
 *
 * Last-run mapping (best available in PR 2; PR 3/4 will emit per-phase events):
 *   light sleep → `meta.lastExtractionAt`   (lifecycle pass runs with extraction)
 *   REM         → `meta.lastConsolidationAt` (semantic consolidation)
 *   deep sleep  → latest governance run manifest when present, otherwise null
 */
export async function summarizeDreamsPhases(
  config: Pick<PluginConfig, "memoryDir" | "dreamsPhases">,
  storage: StorageManager = new StorageManager(config.memoryDir),
): Promise<OperatorDoctorCheck> {
  const phases: DreamsPhasesConfig = config.dreamsPhases;

  // Load meta.json for best-available last-run timestamps.
  const meta = await storage.loadMeta();

  let deepSleepLastRun: string | null = null;
  let deepSleepLastRunWarning: string | null = null;
  try {
    // Read the latest governance run's manifest from the real on-disk format
    // rather than treating every failure as "no runs yet".
    const runsDir = path.join(config.memoryDir, "state", "memory-governance", "runs");
    const runIds = (await readdir(runsDir)).sort().reverse();
    if (runIds.length > 0) {
      const latestRunId = runIds[0];
      const manifestPath = path.join(
        runsDir,
        latestRunId,
        "manifest.json",
      );
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.createdAt === "string" && parsed.createdAt.length > 0) {
        deepSleepLastRun = parsed.createdAt;
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      deepSleepLastRunWarning = `Could not read latest governance run manifest: ${formatUnknownError(error)}`;
    }
  }

  // Build per-phase summary lines for the human-readable `summary` field.
  const phaseLines: string[] = [
    `lightSleep: enabled=${phases.lightSleep.enabled}, cadenceMs=${phases.lightSleep.cadenceMs}, promoteHeat=${phases.lightSleep.promoteHeatThreshold}, staleDecay=${phases.lightSleep.staleDecayThreshold}, archiveDecay=${phases.lightSleep.archiveDecayThreshold}, filterStale=${phases.lightSleep.filterStaleEnabled}, lastRun=${meta.lastExtractionAt ?? "never"}`,
    `rem: enabled=${phases.rem.enabled}, cadenceMs=${phases.rem.cadenceMs}, similarity=${phases.rem.similarityThreshold}, minCluster=${phases.rem.minClusterSize}, maxPerRun=${phases.rem.maxPerRun}, minIntervalMs=${phases.rem.minIntervalMs}, lastRun=${meta.lastConsolidationAt ?? "never"}`,
    `deepSleep: enabled=${phases.deepSleep.enabled}, cadenceMs=${phases.deepSleep.cadenceMs}, versioning=${phases.deepSleep.versioningEnabled}, versioningMaxPerPage=${phases.deepSleep.versioningMaxPerPage}, lastRun=${deepSleepLastRun ?? "never"}`,
  ];

  return {
    key: "dreams_phases",
    status: deepSleepLastRunWarning ? "warn" : "ok",
    summary: `Dreams pipeline phases: ${phaseLines.join("; ")}${deepSleepLastRunWarning ? `; ${deepSleepLastRunWarning}` : ""}`,
    remediation: deepSleepLastRunWarning
      ? "Inspect state/memory-governance/runs and repair or remove unreadable governance run artifacts."
      : undefined,
    details: {
      lightSleep: {
        enabled: phases.lightSleep.enabled,
        cadenceMs: phases.lightSleep.cadenceMs,
        promoteHeatThreshold: phases.lightSleep.promoteHeatThreshold,
        staleDecayThreshold: phases.lightSleep.staleDecayThreshold,
        archiveDecayThreshold: phases.lightSleep.archiveDecayThreshold,
        filterStaleEnabled: phases.lightSleep.filterStaleEnabled,
        lastRun: meta.lastExtractionAt ?? null,
      },
      rem: {
        enabled: phases.rem.enabled,
        cadenceMs: phases.rem.cadenceMs,
        similarityThreshold: phases.rem.similarityThreshold,
        minClusterSize: phases.rem.minClusterSize,
        maxPerRun: phases.rem.maxPerRun,
        minIntervalMs: phases.rem.minIntervalMs,
        lastRun: meta.lastConsolidationAt ?? null,
      },
      deepSleep: {
        enabled: phases.deepSleep.enabled,
        cadenceMs: phases.deepSleep.cadenceMs,
        versioningEnabled: phases.deepSleep.versioningEnabled,
        versioningMaxPerPage: phases.deepSleep.versioningMaxPerPage,
        lastRun: deepSleepLastRun,
        warning: deepSleepLastRunWarning,
      },
    },
  };
}

function summarizeSecurityMitigations(
  config: Pick<
    PluginConfig,
    | "recallCrossNamespaceBudgetEnabled"
    | "recallCrossNamespaceBudgetWindowMs"
    | "recallCrossNamespaceBudgetSoftLimit"
    | "recallCrossNamespaceBudgetHardLimit"
    | "recallAuditAnomalyDetectionEnabled"
    | "recallAuditAnomalyWindowMs"
    | "recallAuditAnomalyRepeatQueryLimit"
    | "recallAuditAnomalyNamespaceWalkLimit"
    | "recallAuditAnomalyHighCardinalityLimit"
    | "recallAuditAnomalyRapidFireLimit"
  >,
): OperatorDoctorCheck {
  const budgetEnabled = config.recallCrossNamespaceBudgetEnabled === true;
  const anomalyEnabled = config.recallAuditAnomalyDetectionEnabled === true;

  if (!budgetEnabled && !anomalyEnabled) {
    return {
      key: "security_mitigations",
      status: "warn",
      summary: "Memory-extraction mitigations are disabled (cross-namespace budget and anomaly detection off).",
      remediation: "Enable recallCrossNamespaceBudgetEnabled and/or recallAuditAnomalyDetectionEnabled for production deployments. See docs/security/memory-extraction-threat-model.md.",
      details: {
        budgetEnabled: false,
        anomalyDetectionEnabled: false,
      },
    };
  }

  const details: Record<string, unknown> = {
    budgetEnabled,
    anomalyDetectionEnabled: anomalyEnabled,
  };

  if (budgetEnabled) {
    details.budgetConfig = {
      windowMs: config.recallCrossNamespaceBudgetWindowMs,
      softLimit: config.recallCrossNamespaceBudgetSoftLimit,
      hardLimit: config.recallCrossNamespaceBudgetHardLimit,
    };
  }

  if (anomalyEnabled) {
    details.anomalyConfig = {
      windowMs: config.recallAuditAnomalyWindowMs,
      repeatQueryLimit: config.recallAuditAnomalyRepeatQueryLimit,
      namespaceWalkLimit: config.recallAuditAnomalyNamespaceWalkLimit,
      highCardinalityLimit: config.recallAuditAnomalyHighCardinalityLimit,
      rapidFireLimit: config.recallAuditAnomalyRapidFireLimit,
    };
  }

  return {
    key: "security_mitigations",
    status: "ok",
    summary: `Memory-extraction mitigation config enabled: ${budgetEnabled ? "budget" : ""}${budgetEnabled && anomalyEnabled ? ", " : ""}${anomalyEnabled ? "anomaly detection" : ""}.`,
    details: { ...details, configOnly: true },
  };
}

/**
 * Observation throughput check for `remnic doctor` (issue #685).
 *
 * Reads the extraction-judge verdict ledger to surface:
 *  - total observations (verdicts) recorded
 *  - accept / reject / defer breakdown
 *  - most-recent `observedAt` timestamp
 *
 * The check is purely informational (always `ok`): a missing or empty
 * ledger is the expected state on a fresh install and is never an error.
 * This closes the `*(future)*` item deferred in `docs/trace-to-primitive.md`.
 */
export async function summarizeObservationThroughput(
  memoryDir: string,
): Promise<OperatorDoctorCheck> {
  try {
    const stats = await readJudgeVerdictStats(memoryDir);
    if (stats.total === 0) {
      return {
        key: "observations",
        status: "ok",
        summary: "No observations recorded yet (extraction-judge telemetry ledger is empty or missing).",
        details: { total: 0, accept: 0, reject: 0, defer: 0, lastObservedAt: null },
      };
    }
    const acceptPct = ((stats.accept / stats.total) * 100).toFixed(1);
    const rejectPct = ((stats.reject / stats.total) * 100).toFixed(1);
    const deferPct = ((stats.defer / stats.total) * 100).toFixed(1);
    return {
      key: "observations",
      status: "ok",
      summary: `${stats.total} observations recorded: accept=${acceptPct}%, reject=${rejectPct}%, defer=${deferPct}%. Last observed: ${stats.lastTs ?? "unknown"}.`,
      details: {
        total: stats.total,
        accept: stats.accept,
        reject: stats.reject,
        defer: stats.defer,
        deferCapTriggered: stats.deferCapTriggered,
        deferRate: stats.deferRate,
        meanElapsedMs: stats.meanElapsedMs,
        firstObservedAt: stats.firstTs ?? null,
        lastObservedAt: stats.lastTs ?? null,
      },
    };
  } catch (err) {
    return {
      key: "observations",
      status: "warn",
      summary: "Could not read observation telemetry ledger.",
      remediation: "Retry `remnic doctor` after ensuring the memory state directory is readable.",
      details: { error: String(err) },
    };
  }
}

export async function summarizeConsolidationProvenance(
  storage: StorageManager,
  config: Pick<PluginConfig, "memoryDir"> & { versioningSidecarDir?: string },
): Promise<OperatorDoctorCheck> {
  let report: ConsolidationProvenanceReport;
  try {
    report = await runConsolidationProvenanceCheck({
      storage,
      memoryDir: config.memoryDir,
      // Honor the configured sidecar directory (PR #634 review): when an
      // operator overrides `versioningSidecarDir`, the default `.versions`
      // would point at the wrong location and every entry would report as
      // missing.  Undefined falls back to the helper's default.
      sidecarDir: config.versioningSidecarDir,
    });
  } catch (err) {
    return {
      key: "consolidation_provenance",
      status: "warn",
      summary: "Could not run consolidation-provenance integrity check.",
      remediation: "Ensure the memory directory is readable and rerun `remnic doctor`.",
      details: { error: String(err) },
    };
  }

  if (report.issues.length === 0) {
    return {
      key: "consolidation_provenance",
      status: "ok",
      summary:
        report.withProvenance === 0
          ? "No consolidation-provenance memories on disk yet."
          : `${report.withProvenance} consolidation-provenance memories verified (no broken references).`,
      details: report,
    };
  }

  return {
    key: "consolidation_provenance",
    status: "warn",
    summary: `${report.issues.length} consolidation-provenance integrity issue(s) detected across ${report.withProvenance} memories with provenance frontmatter.`,
    remediation:
      "Broken pointers are informational. Inspect flagged memories, and if they should resolve, re-snapshot via a consolidation pass or accept pruning.",
    details: report,
  };
}

function getMemoryAgeBand(memory: MemoryFile, now: Date): string {
  const created = Date.parse(memory.frontmatter.created ?? "");
  if (!Number.isFinite(created)) return "unknown";
  const ageDays = Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
  if (ageDays < 7) return "0_6d";
  if (ageDays < 30) return "7_29d";
  if (ageDays < 90) return "30_89d";
  return "90d_plus";
}

async function dirSize(targetPath: string): Promise<number> {
  try {
    const info = await stat(targetPath);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
  } catch {
    return 0;
  }

  let total = 0;
  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += await dirSize(path.join(targetPath, entry.name));
  }
  return total;
}

async function summarizeStorageFootprint(memoryDir: string): Promise<{ bytes: number; byTopLevel: Record<string, number> }> {
  const topLevel = [
    "facts",
    "entities",
    "questions",
    "corrections",
    "artifacts",
    "state",
    "identity",
    "namespaces",
    "summaries",
    "profile.md",
  ];
  const byTopLevel: Record<string, number> = {};
  let bytes = 0;
  for (const name of topLevel) {
    const size = await dirSize(path.join(memoryDir, name));
    if (size > 0) {
      byTopLevel[name] = size;
      bytes += size;
    }
  }
  return { bytes, byTopLevel };
}

export async function runOperatorInventory(options: OperatorInventoryOptions): Promise<OperatorInventoryReport> {
  const now = options.now ?? new Date();
  const config = options.orchestrator.config;
  const namespaceEntries = await listNamespaces({ config });
  const uniqueRootEntries = new Map<string, { namespace: string; rootDir: string }>();
  for (const entry of namespaceEntries) {
    if (!uniqueRootEntries.has(entry.rootDir)) {
      uniqueRootEntries.set(entry.rootDir, { namespace: entry.namespace, rootDir: entry.rootDir });
    }
  }
  const categories: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const ageBands: Record<string, number> = {
    "0_6d": 0,
    "7_29d": 0,
    "30_89d": 0,
    "90d_plus": 0,
    unknown: 0,
  };
  const namespaces: OperatorInventoryNamespaceSummary[] = [];
  let totalMemories = 0;
  let totalEntities = 0;
  let archived = 0;
  let pendingReview = 0;
  let quarantined = 0;
  let rejected = 0;

  for (const entry of uniqueRootEntries.values()) {
    const storage = new StorageManager(entry.rootDir);
    const memories = await storage.readAllMemories();
    const entities = await storage.readAllEntityFiles();
    namespaces.push({
      namespace: entry.namespace,
      memoryCount: memories.length,
      entityCount: entities.length,
    });
    totalMemories += memories.length;
    totalEntities += entities.length;
    for (const memory of memories) {
      const category = memory.frontmatter.category;
      categories[category] = (categories[category] ?? 0) + 1;
      const status = memory.frontmatter.status ?? "active";
      statuses[status] = (statuses[status] ?? 0) + 1;
      ageBands[getMemoryAgeBand(memory, now)] += 1;
      if (status === "archived") archived += 1;
      if (status === "pending_review") pendingReview += 1;
      if (status === "quarantined") quarantined += 1;
      if (status === "rejected") rejected += 1;
    }
  }

  const defaultStorage = new StorageManager(config.memoryDir);
  const profile = await defaultStorage.readProfile();
  const footprint = await summarizeStorageFootprint(config.memoryDir);
  const reviewRunId = (await listMemoryGovernanceRuns(config.memoryDir))[0];
  let reviewQueue = 0;
  if (reviewRunId) {
    try {
      reviewQueue = (await readMemoryGovernanceRunArtifact(config.memoryDir, reviewRunId)).reviewQueue.length;
    } catch {
      reviewQueue = 0;
    }
  }
  const conversationIndex = await options.orchestrator.getConversationIndexHealth();
  const nativeKnowledgeStatus = await summarizeNativeKnowledgeStatus(config);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    memoryDir: config.memoryDir,
    totals: {
      memories: totalMemories,
      entities: totalEntities,
      namespaces: namespaceEntries.length,
      reviewQueue,
      storageBytes: footprint.bytes,
    },
    categories,
    statuses,
    namespaces,
    ageBands,
    profile: {
      exists: profile.length > 0,
      chars: profile.length,
      lines: profile.length > 0 ? profile.split("\n").length : 0,
    },
    storageFootprint: footprint,
    archivePressure: {
      archived,
      pendingReview,
      quarantined,
      rejected,
    },
    conversationIndex: {
      enabled: conversationIndex.enabled,
      backend: conversationIndex.backend,
      status: conversationIndex.status,
      chunkDocCount: conversationIndex.chunkDocCount,
      lastUpdateAt: conversationIndex.lastUpdateAt,
    },
    nativeKnowledge: {
      enabled: nativeKnowledgeStatus.enabled,
      curatedIncludeSync: nativeKnowledgeStatus.curatedIncludeSync,
      obsidianSync: nativeKnowledgeStatus.obsidianSync,
      openclawWorkspaceSync: nativeKnowledgeStatus.openclawWorkspaceSync,
    },
  };
}

export async function runBenchmarkRecall(options: BenchmarkRecallOptions): Promise<BenchmarkRecallReport> {
  const now = options.now ?? new Date();
  const status = await getEvalHarnessStatus({
    memoryDir: options.config.memoryDir,
    evalStoreDir: options.config.evalStoreDir,
    enabled: options.config.evalHarnessEnabled,
    shadowModeEnabled: options.config.evalShadowModeEnabled,
    baselineSnapshotsEnabled: options.config.benchmarkBaselineSnapshotsEnabled,
    memoryRedTeamBenchEnabled: options.config.memoryRedTeamBenchEnabled,
  });

  if (options.createSnapshot && options.snapshotId) {
    const snapshot = await createEvalBaselineSnapshot({
      memoryDir: options.config.memoryDir,
      evalStoreDir: options.config.evalStoreDir,
      baselineSnapshotsEnabled: options.config.benchmarkBaselineSnapshotsEnabled,
      snapshotId: options.snapshotId,
      notes: options.snapshotNotes,
      gitRef: options.gitRef,
      createdAt: options.createdAt,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "snapshot",
      status,
      snapshot: {
        targetPath: snapshot.targetPath,
        snapshotId: snapshot.snapshot.snapshotId,
      },
    };
  }

  if (options.baseEvalStoreDir && options.candidateEvalStoreDir) {
    const ciGate = await runEvalBenchmarkCiGate({
      baseEvalStoreDir: options.baseEvalStoreDir,
      candidateEvalStoreDir: options.candidateEvalStoreDir,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "ci-gate",
      status,
      ciGate,
    };
  }

  if (options.snapshotId) {
    const baselineReport = await runEvalBaselineDeltaReport({
      memoryDir: options.config.memoryDir,
      evalStoreDir: options.config.evalStoreDir,
      benchmarkDeltaReporterEnabled: options.config.benchmarkDeltaReporterEnabled,
      snapshotId: options.snapshotId,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "baseline-report",
      status,
      baselineReport,
    };
  }

  if (options.validatePath) {
    const validate = await validateEvalBenchmarkPack(options.validatePath, {
      memoryRedTeamBenchEnabled: options.config.memoryRedTeamBenchEnabled,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "validate",
      status,
      validate,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: "status",
    status,
  };
}

export async function runOperatorRepair(options: OperatorRepairOptions): Promise<OperatorRepairReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true || options.apply !== true;
  const sessionCheck = await analyzeSessionIntegrity({ memoryDir: options.config.memoryDir });
  const sessionRepairPlan = planSessionRepair({
    report: sessionCheck,
    dryRun,
    allowSessionFileRepair: options.allowSessionFileRepair,
    sessionFilesDir: options.sessionFilesDir,
  });
  const sessionRepairApply = await applySessionRepair({
    plan: sessionRepairPlan,
  });
  const graphHealth = await analyzeGraphHealth(options.config.memoryDir, {
    entityGraphEnabled: options.config.entityGraphEnabled,
    timeGraphEnabled: options.config.timeGraphEnabled,
    causalGraphEnabled: options.config.causalGraphEnabled,
    includeRepairGuidance: true,
  });
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    dryRun,
    sessionCheck,
    sessionRepairPlan,
    sessionRepairApply,
    graphHealth,
  };
}
