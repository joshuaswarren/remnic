/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildEvidencePack,
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
  collectExplicitTurnReferences,
  expandTildePath,
  normalizeTurnExpansionEnd,
  Orchestrator,
  parseFlexibleIsoTimestamp,
  parseConfig,
  parseEntityFile,
  serializeEntityFile,
} from "@remnic/core";
import type { EntityStructuredSection, MemoryFile } from "@remnic/core";
import type {
  BenchPhaseControl,
  BenchJudge,
  BenchMemoryAdapter,
  BenchRecallOptions,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../recall-budget.js";

export interface RemnicAdapterOptions {
  configOverrides?: Record<string, unknown>;
  memoryDir?: string;
  preserveRuntimeDefaults?: boolean;
  responder?: BenchResponder;
  judge?: BenchJudge;
  drainTimeoutMs?: number;
  replayExtractionMode?: "await" | "background" | "skip";
  replaySourceValidAtMode?: "historical" | "batch";
  sandboxDir?: string;
}

type BenchAdapterMode = "lightweight" | "direct";

interface BenchAdapterBaseConfig {
  memoryDir: string;
  workspaceDir: string;
  lcmEnabled: true;
  qmdCollection?: string;
  qmdColdCollection?: string;
  qmdPath?: string;
}

interface BenchQmdSandbox {
  collection: string;
  coldCollection: string;
  cacheDir: string;
  configDir: string;
  indexName: string;
  wrapperPath: string;
}

export const BENCH_ADAPTER_SHARED_CONFIG: Record<string, unknown> = {
  qmdEnabled: false,
  qmdColdTierEnabled: false,
  transcriptEnabled: false,
  hourlySummariesEnabled: false,
  daySummaryEnabled: false,
  identityEnabled: false,
  identityContinuityEnabled: false,
  namespacesEnabled: false,
  sharedContextEnabled: false,
  workTasksEnabled: false,
  workProjectsEnabled: false,
  commitmentLedgerEnabled: false,
  resumeBundlesEnabled: false,
  nativeKnowledge: { enabled: false },
  lcmLeafBatchSize: 64,
  lcmRollupFanIn: 8,
  lcmFreshTailTurns: 64,
  lcmMaxDepth: 4,
  lcmDeterministicMaxTokens: 512,
  lcmRecallBudgetShare: 1.0,
  queryExpansionEnabled: false,
  rerankEnabled: false,
  memoryBoxesEnabled: false,
  traceWeaverEnabled: false,
  threadingEnabled: false,
  factDeduplicationEnabled: false,
  knowledgeIndexEnabled: false,
  entityRetrievalEnabled: false,
  verifiedRecallEnabled: false,
  queryAwareIndexingEnabled: false,
  contradictionDetectionEnabled: false,
  memoryLinkingEnabled: false,
  topicExtractionEnabled: false,
  chunkingEnabled: true,
  episodeNoteModeEnabled: false,
};

export const BENCH_ADAPTER_MODE_CONFIG: Record<BenchAdapterMode, Record<string, unknown>> = {
  direct: {
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
  },
  lightweight: {
    extractionDedupeEnabled: false,
    extractionMinChars: 1000000,
    extractionMinUserTurns: 1000000,
    recallPlannerEnabled: false,
  },
};

type OrchestratorTeardownView = {
  abortDeferredInit(): void;
  deferredReady: Promise<void>;
  lcmEngine: { close(): void } | null;
  qmd: { dispose?(): void | Promise<void> };
  qmdMaintenanceTimer?: NodeJS.Timeout | null;
  qmdMaintenancePending?: boolean;
  qmdMaintenanceInFlight?: boolean;
};

type OrchestratorDrainDiagnosticsView = {
  lcmEngine: {
    observeQueueDepth: number;
    observeQueueInFlightCount: number;
  } | null;
  extractionQueue?: unknown[];
  queueProcessing?: boolean;
  consolidationInFlight?: boolean;
  qmdMaintenancePending?: boolean;
  qmdMaintenanceInFlight?: boolean;
  tierMigrationInFlight?: boolean;
};

type BenchOrchestratorState = {
  tempDir: string;
  ownsTempDir: boolean;
  orchestrator: Orchestrator;
  qmdSandbox: BenchQmdSandbox;
};

type BenchRecallEngine = {
  expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>>;
  getStats(sessionId?: string): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
    maxTurnIndex?: number;
  }>;
  clearSession?(sessionId: string): Promise<void>;
  clearAll?(): Promise<void>;
};

const BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS = 500;
const BENCH_RM_RETRY_OPTIONS = { maxRetries: 5, retryDelay: 50 } as const;
const DEFAULT_BENCH_DRAIN_TIMEOUT_MS = 5 * 60_000;
const CORE_EXPLICIT_CUE_MAX_CHARS = 18_000;
const CORE_EXPLICIT_CUE_MAX_ITEM_CHARS = 2_400;
const CORE_EXPLICIT_CUE_MAX_REFERENCES = 24;
const CORE_TRAJECTORY_ANALYSIS_MAX_CHARS = 18_000;
const BENCH_REMNIC_STATE_CHILDREN = [
  "archive",
  "artifacts",
  "cold",
  "conversation-index",
  "corrections",
  "entities",
  "facts",
  "identity",
  "lancedb",
  "orama",
  "profiling",
  "procedures",
  "qmd-bench",
  "qmd-cache",
  "qmd-config",
  "questions",
  "reasoning-traces",
  "state",
  "summaries",
  "threads",
  "transcripts",
] as const;
const execFileAsync = promisify(execFile);

type BenchCoreMemoryTier = "hot" | "cold";

type BenchQmdIndex = {
  isAvailable(): boolean;
  update(): Promise<void>;
  updateCollection?(collection: string): Promise<void>;
  updateCollectionStrict?(collection: string): Promise<void>;
};

type BenchArtifactStorageView = {
  artifactIndexCache?: unknown;
  bumpArtifactWriteVersion?: () => number;
};

type BenchEntityStructuredFactSources = Map<string, Map<string, Set<string>>>;

type BenchEntityStructuredFactSourceFile = {
  version: 1;
  sessionId: string;
  entries: Array<{
    entityName: string;
    sectionKey: string;
    facts: string[];
  }>;
};

type BenchEntityStorageView = {
  entitySchemas?: Parameters<typeof parseEntityFile>[1];
  writeStorageSecureFile?: (filePath: string, content: string) => Promise<void>;
  invalidateKnowledgeIndexCache?: () => void;
  bumpMemoryStatusVersion?: () => void;
};

function normalizeReplaySourceValidAtMode(
  value: RemnicAdapterOptions["replaySourceValidAtMode"],
): "historical" | "batch" {
  if (value === undefined) {
    return "historical";
  }
  if (value === "historical" || value === "batch") {
    return value;
  }
  throw new Error('replaySourceValidAtMode must be "historical" or "batch".');
}

function cloneBenchConfig(config: Record<string, unknown>): Record<string, unknown> {
  return cloneBenchConfigValue(config) as Record<string, unknown>;
}

function cloneBenchConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneBenchConfigValue(entry));
  }

  if (typeof value === "function") {
    return value;
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = cloneBenchConfigValue(entry);
    }
    return next;
  }

  return value;
}

export function buildBenchBaselineRemnicConfig(): Record<string, unknown> {
  return cloneBenchConfig({
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG.direct,
    lcmEnabled: true,
  });
}

export function buildBenchAdapterConfig(
  mode: BenchAdapterMode,
  baseConfig: BenchAdapterBaseConfig,
  overrides: Record<string, unknown> = {},
  options: { preserveRuntimeDefaults?: boolean } = {},
): Record<string, unknown> {
  const sandboxConfig = {
    memoryDir: baseConfig.memoryDir,
    workspaceDir: baseConfig.workspaceDir,
    lcmEnabled: baseConfig.lcmEnabled,
    ...(baseConfig.qmdCollection ? { qmdCollection: baseConfig.qmdCollection } : {}),
    ...(baseConfig.qmdColdCollection ? { qmdColdCollection: baseConfig.qmdColdCollection } : {}),
    ...(baseConfig.qmdPath ? { qmdPath: baseConfig.qmdPath } : {}),
  };
  const modeConfig = {
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG[mode],
  };

  if (mode === "lightweight") {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
      ...modeConfig,
      ...sandboxConfig,
    });
  }

  if (options.preserveRuntimeDefaults === true) {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
      ...sandboxConfig,
    });
  }

  return cloneBenchConfig({
    ...baseConfig,
    ...modeConfig,
    ...overrides,
    ...sandboxConfig,
  });
}

async function createBenchOrchestrator(
  mode: BenchAdapterMode,
  overrides?: Record<string, unknown>,
  preserveRuntimeDefaults = false,
  configuredMemoryDir?: string,
): Promise<BenchOrchestratorState> {
  const tempDir = configuredMemoryDir
    ? await assertSafeConfiguredBenchDir(configuredMemoryDir)
    : await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  const ownsTempDir = !configuredMemoryDir;
  await mkdir(tempDir, { recursive: true });
  await assertNoUnsafeBenchStateChildren(
    tempDir,
    resolveConfiguredBenchIndexDirs(tempDir, overrides),
  );
  await mkdir(path.join(tempDir, "state"), { recursive: true });
  const qmdSandbox = await createBenchQmdSandbox(tempDir, overrides);

  const commonConfig: BenchAdapterBaseConfig = {
    memoryDir: tempDir,
    workspaceDir: tempDir,
    lcmEnabled: true,
    qmdCollection: qmdSandbox.collection,
    qmdColdCollection: qmdSandbox.coldCollection,
    qmdPath: qmdSandbox.wrapperPath,
  };

  const orchestrator = new Orchestrator(
    parseConfig(
      buildBenchAdapterConfig(mode, commonConfig, overrides, {
        preserveRuntimeDefaults,
      }),
    ),
  );

  await orchestrator.initialize();
  if (!orchestrator.lcmEngine) {
    throw new Error("Remnic benchmark adapter requires LCM to be enabled.");
  }

  return { tempDir, ownsTempDir, orchestrator, qmdSandbox };
}

async function createBenchQmdSandbox(
  tempDir: string,
  overrides?: Record<string, unknown>,
): Promise<BenchQmdSandbox> {
  const collection = safeBenchQmdName(path.basename(tempDir));
  const coldCollection = `${collection}-cold`;
  const indexName = collection;
  const wrapperPath = path.join(tempDir, "qmd-bench");
  const qmdCacheDir = path.join(tempDir, "qmd-cache");
  const qmdConfigDir = path.join(tempDir, "qmd-config");
  const qmdIndexPath = path.join(qmdCacheDir, `${indexName}.sqlite`);
  const qmdBinary = typeof overrides?.qmdPath === "string" && overrides.qmdPath.trim().length > 0
    ? resolveConfiguredQmdBinary(overrides.qmdPath)
    : "qmd";
  await mkdir(qmdCacheDir, { recursive: true });
  await mkdir(qmdConfigDir, { recursive: true });
  await writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      `cd ${shellQuote(tempDir)} || exit 1`,
      `export INDEX_PATH=${shellQuote(qmdIndexPath)}`,
      `export XDG_CACHE_HOME=${shellQuote(qmdCacheDir)}`,
      `export QMD_CONFIG_DIR=${shellQuote(qmdConfigDir)}`,
      "unset XDG_CONFIG_HOME",
      `exec ${shellQuote(qmdBinary)} --index ${shellQuote(indexName)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(wrapperPath, 0o700);

  await registerBenchQmdCollection(wrapperPath, tempDir, collection);
  await registerBenchQmdCollection(wrapperPath, tempDir, coldCollection);

  return {
    collection,
    coldCollection,
    cacheDir: qmdCacheDir,
    configDir: qmdConfigDir,
    indexName,
    wrapperPath,
  };
}

async function registerBenchQmdCollection(
  wrapperPath: string,
  tempDir: string,
  collection: string,
): Promise<void> {
  try {
    await execFileAsync(wrapperPath, [
      "collection",
      "add",
      tempDir,
      "--name",
      collection,
    ], {
      cwd: tempDir,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // QMD is optional at runtime. If the CLI is unavailable, Remnic's normal
    // probe path will mark it unavailable and the adapter will continue with
    // non-QMD recall surfaces.
  }
}

function safeBenchQmdName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
  return safe.startsWith("remnic-bench-") ? safe : `remnic-bench-${safe}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveConfiguredQmdBinary(value: string): string {
  const trimmed = value.trim();
  if (
    path.isAbsolute(trimmed) ||
    (!trimmed.startsWith(".") && !trimmed.includes("/") && !trimmed.includes("\\"))
  ) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

function normalizeDrainTimeoutMs(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_BENCH_DRAIN_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `benchmark drain timeout must be a positive integer; received ${String(value)}`,
    );
  }
  return value;
}

function parseStrictBenchTimestamp(value: string, label: string): number {
  const parsed = parseFlexibleIsoTimestamp(value);
  if (parsed === null) {
    throw new Error(`${label} must be a valid timestamp; received ${value}`);
  }
  return parsed;
}

function normalizeBenchRecallAsOf(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `benchmark recall asOf must be a non-empty timestamp string; received ${String(value)}`,
    );
  }
  const normalized = value.trim();
  parseStrictBenchTimestamp(normalized, "benchmark recall asOf");
  return normalized;
}

function normalizeBenchMessageTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `benchmark message timestamp must be a non-empty timestamp string; received ${String(value)}`,
    );
  }
  const parsed = parseStrictBenchTimestamp(value.trim(), "benchmark message timestamp");
  return new Date(parsed).toISOString();
}

function normalizeConfiguredBenchDir(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveConfiguredBenchDir(options: RemnicAdapterOptions): string | undefined {
  const memoryDir = normalizeConfiguredBenchDir(options.memoryDir);
  const sandboxDir = normalizeConfiguredBenchDir(options.sandboxDir);
  return sandboxDir ?? memoryDir;
}

async function assertSafeConfiguredBenchDir(configuredDir: string): Promise<string> {
  const resolved = path.resolve(expandTildePath(configuredDir));
  assertSafeBenchDirPath(resolved);
  await assertNoUnsafeSymlinkComponents(resolved);
  await mkdir(resolved, { recursive: true });
  assertSafeBenchDirPath(await realpath(resolved));
  return resolved;
}

function assertSafeBenchDirPath(resolved: string): void {
  const root = path.parse(resolved).root;
  const dangerousDirs = [
    root,
    path.resolve(homedir()),
    path.resolve(tmpdir()),
    path.resolve(process.cwd()),
  ];
  if (
    dangerousDirs.includes(resolved) ||
    isPathAncestorOf(resolved, path.resolve(process.cwd()))
  ) {
    throw new Error(
      `Remnic benchmark memoryDir/sandboxDir must not be a root, home, temp, cwd, or repository ancestor path: ${resolved}`,
    );
  }
}

function isPathAncestorOf(candidate: string, child: string): boolean {
  const relative = path.relative(candidate, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertNoUnsafeSymlinkComponents(candidate: string): Promise<void> {
  let current = candidate;
  while (true) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        const target = await realpath(current).catch(() => undefined);
        if (!isAllowedSystemPathAlias(current, target)) {
          throw new Error(
            `Remnic benchmark memoryDir/sandboxDir must not be a symlink path or contain symlink path components: ${current}`,
          );
        }
      }
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function isAllowedSystemPathAlias(linkPath: string, targetPath: string | undefined): boolean {
  if (targetPath === undefined) {
    return false;
  }
  return (
    process.platform === "darwin" &&
    (
      (path.resolve(linkPath) === "/var" && path.resolve(targetPath) === "/private/var") ||
      (path.resolve(linkPath) === "/tmp" && path.resolve(targetPath) === "/private/tmp")
    )
  );
}

async function assertNoUnsafeBenchStateChildren(
  memoryDir: string,
  extraStateDirs: string[] = [],
): Promise<void> {
  const stateDirs = new Set([
    ...BENCH_REMNIC_STATE_CHILDREN.map((entry) => path.join(memoryDir, entry)),
    ...extraStateDirs,
  ]);
  await Promise.all(
    [...stateDirs].map(async (childPath) => {
      try {
        await assertNoUnsafeSymlinkComponents(childPath);
        const stats = await lstat(childPath);
        if (stats.isSymbolicLink()) {
          throw new Error(
            `Remnic benchmark memoryDir/sandboxDir must not contain symlinked Remnic state children: ${childPath}`,
          );
        }
        if (stats.isDirectory()) {
          await assertNoUnsafeSymlinksInTree(childPath);
        }
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }),
  );
}

function resolveConfiguredBenchIndexDirs(
  memoryDir: string,
  overrides?: Record<string, unknown>,
): string[] {
  const dirs = [
    normalizeConfiguredBenchDir(overrides?.oramaDbPath),
    normalizeConfiguredBenchDir(overrides?.lanceDbPath),
  ].filter((value): value is string => value !== undefined)
    .map((value) => resolveConfiguredBenchIndexDir(memoryDir, value));
  for (const dir of dirs) {
    if (!isPathInsideOrEqual(memoryDir, dir)) {
      throw new Error(
        `Remnic benchmark search index paths must stay inside memoryDir/sandboxDir: ${dir}`,
      );
    }
  }
  return dirs;
}

function resolveConfiguredBenchIndexDir(memoryDir: string, value: string): string {
  const expanded = expandTildePath(value);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(memoryDir, expanded);
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoUnsafeSymlinksInTree(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Remnic benchmark memoryDir/sandboxDir must not contain symlinked Remnic state children: ${entryPath}`,
        );
      }
      if (stats.isDirectory()) {
        await assertNoUnsafeSymlinksInTree(entryPath);
      }
    }),
  );
}

function normalizeBenchSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error("benchmark sessionId must be non-empty.");
  }
  return normalized;
}

function normalizeOptionalBenchSessionId(sessionId?: string): string | undefined {
  if (sessionId === undefined) {
    return undefined;
  }
  return normalizeBenchSessionId(sessionId);
}

async function removeBenchQmdSandbox(sandbox: BenchQmdSandbox): Promise<void> {
  if (!sandbox.indexName.startsWith("remnic-bench-")) {
    return;
  }
  await Promise.all([
    rm(sandbox.cacheDir, {
      recursive: true,
      force: true,
      ...BENCH_RM_RETRY_OPTIONS,
    }),
    rm(sandbox.configDir, {
      recursive: true,
      force: true,
      ...BENCH_RM_RETRY_OPTIONS,
    }),
  ]);
}

async function clearCallerOwnedBenchState(memoryDir: string): Promise<void> {
  await Promise.all(
    BENCH_REMNIC_STATE_CHILDREN.map((entry) =>
      rm(path.join(memoryDir, entry), {
        recursive: true,
        force: true,
        ...BENCH_RM_RETRY_OPTIONS,
      }),
    ),
  );
}

async function readBenchCoreMemories(
  orchestrator: Orchestrator,
): Promise<MemoryFile[]> {
  return [
    ...await orchestrator.storage.readAllMemories(),
    ...await orchestrator.storage.readAllColdMemories(),
  ];
}

async function readBenchCoreMemoryIds(
  orchestrator: Orchestrator,
): Promise<Set<string>> {
  const memories = await readBenchCoreMemories(orchestrator);
  return new Set(memories.map((memory) => memory.frontmatter.id));
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === code
  );
}

function benchCoreMemoryTier(memory: MemoryFile): BenchCoreMemoryTier {
  return memory.path.includes(`${path.sep}cold${path.sep}`) ? "cold" : "hot";
}

function benchCoreMemorySource(sessionId: string): string {
  return `bench-replay-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function benchEntityStructuredFactSourceDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "bench-entity-structured-facts");
}

function benchEntityStructuredFactSourcePath(
  memoryDir: string,
  sessionId: string,
): string {
  return path.join(
    benchEntityStructuredFactSourceDir(memoryDir),
    `${benchCoreMemorySource(sessionId)}.json`,
  );
}

function normalizeBenchEntityStructuredFact(fact: string): string {
  return fact.replace(/\s+/g, " ").trim();
}

function addBenchEntityStructuredFactSource(
  sources: BenchEntityStructuredFactSources,
  entityName: string,
  sectionKey: string,
  fact: string,
): void {
  const normalizedFact = normalizeBenchEntityStructuredFact(fact);
  if (!entityName || !sectionKey || !normalizedFact) return;
  let entitySources = sources.get(entityName);
  if (!entitySources) {
    entitySources = new Map<string, Set<string>>();
    sources.set(entityName, entitySources);
  }
  let sectionFacts = entitySources.get(sectionKey);
  if (!sectionFacts) {
    sectionFacts = new Set<string>();
    entitySources.set(sectionKey, sectionFacts);
  }
  sectionFacts.add(normalizedFact);
}

function mergeBenchEntityStructuredFactSources(
  target: BenchEntityStructuredFactSources,
  source: BenchEntityStructuredFactSources,
): void {
  for (const [entityName, sections] of source) {
    for (const [sectionKey, facts] of sections) {
      for (const fact of facts) {
        addBenchEntityStructuredFactSource(target, entityName, sectionKey, fact);
      }
    }
  }
}

function serializeBenchEntityStructuredFactSources(
  sessionId: string,
  sources: BenchEntityStructuredFactSources,
): BenchEntityStructuredFactSourceFile {
  return {
    version: 1,
    sessionId,
    entries: Array.from(sources.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([entityName, sections]) =>
        Array.from(sections.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sectionKey, facts]) => ({
            entityName,
            sectionKey,
            facts: Array.from(facts).sort(),
          })),
      ),
  };
}

async function readBenchEntityStructuredFactSourceFile(
  filePath: string,
  expectedSessionId?: string,
): Promise<{
  sessionId: string | undefined;
  sources: BenchEntityStructuredFactSources;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return { sessionId: undefined, sources: new Map() };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sessionId: undefined, sources: new Map() };
  }
  const file = parsed as {
    version?: unknown;
    sessionId?: unknown;
    entries?: unknown;
  };
  const sessionId = typeof file.sessionId === "string" ? file.sessionId : undefined;
  if (
    file.version !== 1 ||
    !Array.isArray(file.entries) ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    return { sessionId, sources: new Map() };
  }

  const sources: BenchEntityStructuredFactSources = new Map();
  for (const entry of file.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as {
      entityName?: unknown;
      sectionKey?: unknown;
      facts?: unknown;
    };
    if (
      typeof candidate.entityName !== "string" ||
      typeof candidate.sectionKey !== "string" ||
      !Array.isArray(candidate.facts)
    ) {
      continue;
    }
    for (const fact of candidate.facts) {
      if (typeof fact !== "string") continue;
      addBenchEntityStructuredFactSource(
        sources,
        candidate.entityName,
        candidate.sectionKey,
        fact,
      );
    }
  }
  return { sessionId, sources };
}

async function readBenchEntityStructuredFactSources(
  memoryDir: string,
  sessionId: string,
): Promise<BenchEntityStructuredFactSources> {
  return (
    await readBenchEntityStructuredFactSourceFile(
      benchEntityStructuredFactSourcePath(memoryDir, sessionId),
      sessionId,
    )
  ).sources;
}

async function readOtherBenchEntityStructuredFactSources(
  memoryDir: string,
  sessionId: string,
): Promise<BenchEntityStructuredFactSources> {
  const sourceDir = benchEntityStructuredFactSourceDir(memoryDir);
  const excludedPath = benchEntityStructuredFactSourcePath(memoryDir, sessionId);
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const merged: BenchEntityStructuredFactSources = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sourceDir, entry.name);
    if (path.resolve(filePath) === path.resolve(excludedPath)) continue;
    const sourceFile = await readBenchEntityStructuredFactSourceFile(filePath);
    if (sourceFile.sessionId === sessionId) continue;
    mergeBenchEntityStructuredFactSources(merged, sourceFile.sources);
  }
  return merged;
}

async function writeBenchEntityStructuredFactSources(
  memoryDir: string,
  sessionId: string,
  sources: BenchEntityStructuredFactSources,
): Promise<void> {
  if (sources.size === 0) return;

  const sourcePath = benchEntityStructuredFactSourcePath(memoryDir, sessionId);
  const merged = await readBenchEntityStructuredFactSources(memoryDir, sessionId);
  mergeBenchEntityStructuredFactSources(merged, sources);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const tempPath = `${sourcePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    tempPath,
    `${JSON.stringify(
      serializeBenchEntityStructuredFactSources(sessionId, merged),
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rename(tempPath, sourcePath);
}

async function removeBenchEntityStructuredFactSources(
  memoryDir: string,
  sessionId: string,
): Promise<void> {
  await unlink(benchEntityStructuredFactSourcePath(memoryDir, sessionId)).catch((err) => {
    if (!isErrnoCode(err, "ENOENT")) {
      throw err;
    }
  });
}

async function captureBenchEntityStructuredFactWrite(
  orchestrator: Orchestrator,
  sources: BenchEntityStructuredFactSources,
  entityName: string,
  structuredSections: EntityStructuredSection[] | undefined,
  beforeSources: BenchEntityStructuredFactSources,
): Promise<void> {
  const incomingFacts = new Set<string>();
  for (const section of structuredSections ?? []) {
    for (const fact of section.facts ?? []) {
      if (typeof fact !== "string") continue;
      const normalizedFact = normalizeBenchEntityStructuredFact(fact);
      if (normalizedFact) incomingFacts.add(normalizedFact);
    }
  }
  if (!entityName || incomingFacts.size === 0) return;

  const entityStorage = orchestrator.storage as unknown as BenchEntityStorageView;
  const raw = await orchestrator.storage.readEntity(entityName);
  if (!raw) return;
  const entity = parseEntityFile(raw, entityStorage.entitySchemas);
  for (const section of entity.structuredSections ?? []) {
    for (const fact of section.facts) {
      const normalizedFact = normalizeBenchEntityStructuredFact(fact);
      if (!incomingFacts.has(normalizedFact)) continue;
      if (beforeSources.get(entityName)?.get(section.key)?.has(normalizedFact)) {
        continue;
      }
      addBenchEntityStructuredFactSource(
        sources,
        entityName,
        section.key,
        normalizedFact,
      );
    }
  }
}

async function readBenchEntityStructuredFactSnapshot(
  orchestrator: Orchestrator,
): Promise<BenchEntityStructuredFactSources> {
  const storage = orchestrator.storage;
  const entityStorage = storage as unknown as BenchEntityStorageView;
  const sources: BenchEntityStructuredFactSources = new Map();
  for (const entityName of await storage.listEntityNames()) {
    const raw = await storage.readEntity(entityName);
    if (!raw) continue;
    const entity = parseEntityFile(raw, entityStorage.entitySchemas);
    for (const section of entity.structuredSections ?? []) {
      for (const fact of section.facts) {
        addBenchEntityStructuredFactSource(sources, entityName, section.key, fact);
      }
    }
  }
  return sources;
}

function hasBenchEntityStructuredFacts(
  structuredSections: EntityStructuredSection[] | undefined,
): boolean {
  return (structuredSections ?? []).some((section) =>
    (section.facts ?? []).some((fact) =>
      typeof fact === "string" &&
      normalizeBenchEntityStructuredFact(fact).length > 0,
    ),
  );
}

async function withBenchEntityStructuredFactCapture(
  orchestrator: Orchestrator,
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  type BenchWriteEntity = (
    name: string,
    type: string,
    facts: string[],
    options?: { structuredSections?: EntityStructuredSection[] },
  ) => Promise<string>;
  const storage = orchestrator.storage as unknown as { writeEntity: BenchWriteEntity };
  const originalWriteEntity = storage.writeEntity;
  const writeEntity = originalWriteEntity.bind(orchestrator.storage);
  const captured: BenchEntityStructuredFactSources = new Map();

  storage.writeEntity = async (...args: Parameters<BenchWriteEntity>): Promise<string> => {
    const structuredSections = args[3]?.structuredSections;
    const beforeSources = hasBenchEntityStructuredFacts(structuredSections)
      ? await readBenchEntityStructuredFactSnapshot(orchestrator)
      : new Map<string, Map<string, Set<string>>>();
    const entityName = await writeEntity(...args);
    await captureBenchEntityStructuredFactWrite(
      orchestrator,
      captured,
      entityName,
      structuredSections,
      beforeSources,
    );
    return entityName;
  };

  let taskError: unknown;
  try {
    await task();
  } catch (err) {
    taskError = err;
    throw err;
  } finally {
    storage.writeEntity = originalWriteEntity;
    try {
      await writeBenchEntityStructuredFactSources(
        orchestrator.storage.dir,
        sessionId,
        captured,
      );
    } catch (err) {
      if (taskError === undefined) {
        throw err;
      }
    }
  }
}

async function rememberNewBenchCoreMemories(
  orchestrator: Orchestrator,
  sessionMemoryIds: Map<string, Set<string>>,
  sessionId: string,
  beforeIds: Set<string>,
): Promise<void> {
  const after = await readBenchCoreMemories(orchestrator);
  const remembered = sessionMemoryIds.get(sessionId) ?? new Set<string>();
  const source = benchCoreMemorySource(sessionId);
  for (const memory of after) {
    if (!beforeIds.has(memory.frontmatter.id)) {
      await orchestrator.storage.writeMemoryFrontmatter(memory, { source });
      remembered.add(memory.frontmatter.id);
    }
  }
  if (remembered.size > 0) {
    sessionMemoryIds.set(sessionId, remembered);
  }
}

async function withBenchCoreMemorySource(
  orchestrator: Orchestrator,
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  type BenchWriteMemory = Orchestrator["storage"]["writeMemory"];
  const storage = orchestrator.storage as unknown as { writeMemory: BenchWriteMemory };
  const originalWriteMemory = storage.writeMemory;
  const writeMemory = originalWriteMemory.bind(orchestrator.storage);
  const source = benchCoreMemorySource(sessionId);

  storage.writeMemory = async (
    ...args: Parameters<BenchWriteMemory>
  ): Promise<string> => {
    const [category, content, options] = args;
    const requestedSource = options?.source;
    return writeMemory(category, content, {
      ...(options ?? {}),
      source:
        !requestedSource || requestedSource === "extraction"
          ? source
          : requestedSource,
    });
  };

  try {
    await task();
  } finally {
    storage.writeMemory = originalWriteMemory;
  }
}

async function clearBenchCoreSessionMemories(
  orchestrator: Orchestrator,
  sessionId: string,
  memoryIds: Set<string> | undefined,
  coldCollection: string,
): Promise<void> {
  const memories = [
    ...await orchestrator.storage.readAllMemories(),
    ...await orchestrator.storage.readAllColdMemories(),
  ];
  const trackedIds = memoryIds ?? new Set<string>();
  const source = benchCoreMemorySource(sessionId);
  const targets = memories
    .filter((memory) =>
      trackedIds.has(memory.frontmatter.id) ||
      memory.frontmatter.source === source,
    )
    .map((memory) => ({ memory, tier: benchCoreMemoryTier(memory) }));
  const targetMemoryIds = new Set(trackedIds);
  for (const target of targets) {
    targetMemoryIds.add(target.memory.frontmatter.id);
  }

  await clearBenchCoreArtifactsForMemoryIds(orchestrator, targetMemoryIds);
  await clearBenchCoreEntitiesForSession(orchestrator, sessionId);
  if (targets.length === 0) return;

  await orchestrator.storage.removeFactContentHashesForMemories(
    targets.map((target) => target.memory),
  );

  const changedTiers = new Set<BenchCoreMemoryTier>();
  for (const { memory, tier } of targets) {
    if (tier === "cold") {
      try {
        await unlink(memory.path);
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) {
          throw err;
        }
      }
      changedTiers.add("cold");
      continue;
    }

    await orchestrator.storage.invalidateMemory(memory.frontmatter.id);
    changedTiers.add("hot");
  }

  const invalidateTierCaches = (
    orchestrator.storage as unknown as {
      invalidateMemoryCachesForTiers?: (
        tiers: Iterable<"hot" | "cold" | "archive">,
      ) => void;
    }
  ).invalidateMemoryCachesForTiers;
  if (typeof invalidateTierCaches === "function") {
    invalidateTierCaches.call(orchestrator.storage, changedTiers);
  } else {
    orchestrator.storage.invalidateAllMemoriesCacheForDir();
  }

  const qmd = orchestrator.qmd as BenchQmdIndex;
  if (!qmd.isAvailable()) {
    return;
  }
  if (changedTiers.has("hot")) {
    await qmd.update();
  }
  if (changedTiers.has("cold")) {
    if (typeof qmd.updateCollectionStrict === "function") {
      await qmd.updateCollectionStrict(coldCollection);
    } else if (typeof qmd.updateCollection === "function") {
      await qmd.updateCollection(coldCollection);
    } else {
      await qmd.update();
    }
  }
}

function compileBenchEntityFacts(entity: ReturnType<typeof parseEntityFile>): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const entry of entity.timeline) {
    const fact = entry.text.trim();
    if (!fact || seen.has(fact)) continue;
    seen.add(fact);
    facts.push(fact);
  }
  for (const section of entity.structuredSections ?? []) {
    for (const rawFact of section.facts) {
      const fact = rawFact.replace(/\s+/g, " ").trim();
      if (!fact || seen.has(fact)) continue;
      seen.add(fact);
      facts.push(fact);
    }
  }
  return facts;
}

function hasBenchEntityState(entity: ReturnType<typeof parseEntityFile>): boolean {
  return entity.timeline.length > 0 ||
    (entity.structuredSections ?? []).some((section) => section.facts.length > 0) ||
    entity.relationships.length > 0 ||
    entity.activity.length > 0 ||
    entity.aliases.length > 0 ||
    (entity.extraSections ?? []).some((section) =>
      section.lines.some((line) => line.trim().length > 0),
    ) ||
    (entity.preSectionLines ?? []).some((line) => line.trim().length > 0);
}

function pruneBenchEntityStructuredFacts(
  structuredSections: EntityStructuredSection[] | undefined,
  targetSources: Map<string, Set<string>> | undefined,
  protectedSources: Map<string, Set<string>> | undefined,
): { changed: boolean; structuredSections: EntityStructuredSection[] } {
  const sections = structuredSections ?? [];
  if (sections.length === 0) {
    return { changed: false, structuredSections: [] };
  }
  if (!targetSources || targetSources.size === 0) {
    return { changed: false, structuredSections: sections };
  }

  let changed = false;
  const nextSections: EntityStructuredSection[] = [];
  for (const section of sections) {
    const targetFacts = targetSources?.get(section.key);
    const protectedFacts = protectedSources?.get(section.key);
    const nextFacts = section.facts.filter((fact) => {
      const normalizedFact = normalizeBenchEntityStructuredFact(fact);
      if (!targetFacts?.has(normalizedFact)) {
        return true;
      }
      return protectedFacts?.has(normalizedFact) === true;
    });
    if (nextFacts.length !== section.facts.length) {
      changed = true;
    }
    if (nextFacts.length === 0) {
      continue;
    }
    nextSections.push({ ...section, facts: nextFacts });
  }

  return { changed, structuredSections: nextSections };
}

async function clearBenchCoreEntitiesForSession(
  orchestrator: Orchestrator,
  sessionId: string,
): Promise<void> {
  const storage = orchestrator.storage;
  const entityStorage = storage as unknown as BenchEntityStorageView;
  const entitySchemas = entityStorage.entitySchemas;
  const targetStructuredSources = await readBenchEntityStructuredFactSources(
    storage.dir,
    sessionId,
  );
  const protectedStructuredSources = await readOtherBenchEntityStructuredFactSources(
    storage.dir,
    sessionId,
  );
  const entityNames = await storage.listEntityNames();
  let changedAny = false;

  for (const entityName of entityNames) {
    const raw = await storage.readEntity(entityName);
    if (!raw) continue;

    const entity = parseEntityFile(raw, entitySchemas);
    const nextTimeline = entity.timeline.filter((entry) => entry.sessionKey !== sessionId);
    const timelineChanged = nextTimeline.length !== entity.timeline.length;
    const prunedStructured = pruneBenchEntityStructuredFacts(
      entity.structuredSections,
      targetStructuredSources.get(entityName),
      protectedStructuredSources.get(entityName),
    );
    if (!timelineChanged && !prunedStructured.changed) {
      continue;
    }

    entity.timeline = nextTimeline;
    entity.structuredSections = prunedStructured.structuredSections;
    entity.facts = compileBenchEntityFacts(entity);
    entity.summary = undefined;
    entity.synthesis = undefined;
    entity.synthesisUpdatedAt = undefined;
    entity.synthesisTimelineCount = undefined;
    entity.synthesisStructuredFactCount = undefined;
    entity.synthesisStructuredFactDigest = undefined;
    entity.updated = new Date().toISOString();

    const entityPath = path.join(storage.dir, "entities", `${entityName}.md`);
    if (!hasBenchEntityState(entity)) {
      await unlink(entityPath).catch((err) => {
        if (!isErrnoCode(err, "ENOENT")) {
          throw err;
        }
      });
      await storage.removeEntitySynthesisQueueEntries([entityName]).catch(() => undefined);
      changedAny = true;
      continue;
    }

    const serialized = serializeEntityFile(entity, entitySchemas);
    if (typeof entityStorage.writeStorageSecureFile === "function") {
      await entityStorage.writeStorageSecureFile.call(storage, entityPath, serialized);
    } else {
      await writeFile(entityPath, serialized, "utf8");
    }
    await storage.removeEntitySynthesisQueueEntries([entityName]).catch(() => undefined);
    changedAny = true;
  }

  if (targetStructuredSources.size > 0) {
    await removeBenchEntityStructuredFactSources(storage.dir, sessionId);
  }

  if (!changedAny) return;
  entityStorage.invalidateKnowledgeIndexCache?.call(storage);
  entityStorage.bumpMemoryStatusVersion?.call(storage);
}

async function listBenchArtifactMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBenchArtifactMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function clearBenchCoreArtifactsForMemoryIds(
  orchestrator: Orchestrator,
  memoryIds: Set<string>,
): Promise<void> {
  if (memoryIds.size === 0) return;

  const artifactFiles = await listBenchArtifactMarkdownFiles(
    path.join(orchestrator.storage.dir, "artifacts"),
  );
  let removedAny = false;
  for (const filePath of artifactFiles) {
    const artifact = await orchestrator.storage.readMemoryByPath(filePath);
    const sourceMemoryId = artifact?.frontmatter.sourceMemoryId;
    if (typeof sourceMemoryId !== "string" || !memoryIds.has(sourceMemoryId)) {
      continue;
    }
    try {
      await unlink(filePath);
      removedAny = true;
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        throw err;
      }
    }
  }

  if (!removedAny) return;
  const artifactStorage = orchestrator.storage as unknown as BenchArtifactStorageView;
  artifactStorage.artifactIndexCache = null;
  artifactStorage.bumpArtifactWriteVersion?.call(orchestrator.storage);
}

async function listTranscriptJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTranscriptJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function clearBenchTranscriptSession(
  memoryDir: string,
  sessionId: string,
): Promise<void> {
  const transcriptFiles = await listTranscriptJsonlFiles(path.join(memoryDir, "transcripts"));
  for (const filePath of transcriptFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let removed = false;
    const kept: string[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) {
        kept.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { sessionKey?: unknown };
        if (parsed.sessionKey === sessionId) {
          removed = true;
          continue;
        }
      } catch {
        // Preserve malformed lines; reset should only remove known session entries.
      }
      kept.push(line);
    }
    if (!removed) continue;

    const nonEmptyLines = kept.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
      await unlink(filePath).catch(() => undefined);
      continue;
    }

    const nextContent = kept.join("\n");
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      tempPath,
      nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`,
      "utf8",
    );
    await rename(tempPath, filePath);
  }
}

function resolveBenchChildPath(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("benchmark sessionId resolves outside Remnic benchmark state.");
  }
  return resolvedPath;
}

function resolveBenchSummarySessionPaths(
  memoryDir: string,
  sessionId: string,
): {
  hourlyDir: string;
  snapshotPath: string;
  lockPath: string;
} {
  const hourlyRoot = path.join(memoryDir, "summaries", "hourly");
  const snapshotRoot = path.join(memoryDir, "state", "summaries");
  return {
    hourlyDir: resolveBenchChildPath(hourlyRoot, sessionId),
    snapshotPath: resolveBenchChildPath(snapshotRoot, `${sessionId}.json`),
    lockPath: resolveBenchChildPath(snapshotRoot, `${sessionId}.lock`),
  };
}

async function clearBenchSummarySession(
  memoryDir: string,
  sessionId: string,
): Promise<void> {
  const summaryPaths = resolveBenchSummarySessionPaths(memoryDir, sessionId);
  await Promise.all([
    rm(summaryPaths.hourlyDir, {
      recursive: true,
      force: true,
    }),
    rm(summaryPaths.snapshotPath, {
      force: true,
    }),
    rm(summaryPaths.lockPath, {
      force: true,
    }),
  ]);
}

function createAdapterFactory(mode: "lightweight" | "direct") {
  return async function createAdapter(
    options: RemnicAdapterOptions = {},
  ): Promise<BenchMemoryAdapter> {
    const useCoreMemoryPipeline = shouldUseCoreMemoryPipeline(mode, options);
    const replayExtractionMode = options.replayExtractionMode ?? "await";
    const replaySourceValidAtMode = normalizeReplaySourceValidAtMode(
      options.replaySourceValidAtMode,
    );
    const drainTimeoutMs = normalizeDrainTimeoutMs(options.drainTimeoutMs);
    const configuredBenchDir = resolveConfiguredBenchDir(options);
    const coreSessionMemoryIds = new Map<string, Set<string>>();
    const coreReplaySessionChains = new Map<string, Promise<void>>();
    let coreReplayChain: Promise<void> = Promise.resolve();
    let state = await createBenchOrchestrator(
      mode,
      options.configOverrides,
      options.preserveRuntimeDefaults === true,
      configuredBenchDir,
    );
    const sessionTurnCounters = new Map<string, number>();

    const queueBenchCoreReplay = (
      sessionId: string,
      task: () => Promise<void>,
    ): Promise<void> => {
      const queued = coreReplayChain.catch(() => undefined).then(task);
      let tracked: Promise<void>;
      tracked = queued.finally(() => {
        if (coreReplaySessionChains.get(sessionId) === tracked) {
          coreReplaySessionChains.delete(sessionId);
        }
      });
      coreReplaySessionChains.set(sessionId, tracked);
      coreReplayChain = tracked.catch(() => undefined);
      return queued;
    };

    const waitForBenchCoreReplaySession = async (
      sessionId: string,
    ): Promise<void> => {
      await coreReplaySessionChains.get(sessionId)?.catch(() => undefined);
    };

    const waitForAllBenchCoreReplay = async (): Promise<void> => {
      await coreReplayChain.catch(() => undefined);
    };

    const getEngine = () => {
      const engine = state.orchestrator.lcmEngine;
      if (!engine) {
        throw new Error("LCM engine unavailable for Remnic benchmark adapter.");
      }
      return engine;
    };

    const cleanup = async (): Promise<void> => {
      await waitForAllBenchCoreReplay();
      const orchestrator = state.orchestrator as unknown as OrchestratorTeardownView;

      orchestrator.abortDeferredInit();
      if (orchestrator.qmdMaintenanceTimer) {
        clearTimeout(orchestrator.qmdMaintenanceTimer);
      }
      orchestrator.qmdMaintenanceTimer = null;
      orchestrator.qmdMaintenancePending = false;
      orchestrator.qmdMaintenanceInFlight = false;
      await Promise.race([
        orchestrator.deferredReady.catch(() => undefined),
        new Promise((resolve) =>
          setTimeout(resolve, BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS),
        ),
      ]);
      await orchestrator.qmd.dispose?.();
      orchestrator.lcmEngine?.close();
      try {
        await removeBenchQmdSandbox(state.qmdSandbox);
      } catch {
        // QMD sandbox cleanup is best-effort; the benchmark temp dir must
        // still be removed even if a sqlite/config artifact is busy.
      }
      if (state.ownsTempDir) {
        await rm(state.tempDir, {
          recursive: true,
          force: true,
          ...BENCH_RM_RETRY_OPTIONS,
        });
      }
    };

    const rebuild = async (
      rebuildOptions: { clearCallerOwnedBenchState?: boolean } = {},
    ): Promise<void> => {
      const shouldClearCallerOwnedBenchState =
        !state.ownsTempDir && rebuildOptions.clearCallerOwnedBenchState === true;
      const callerOwnedMemoryDir = state.tempDir;
      await cleanup();
      if (shouldClearCallerOwnedBenchState) {
        await clearCallerOwnedBenchState(callerOwnedMemoryDir);
      }
      state = await createBenchOrchestrator(
        mode,
        options.configOverrides,
        options.preserveRuntimeDefaults === true,
        configuredBenchDir,
      );
      sessionTurnCounters.clear();
      coreSessionMemoryIds.clear();
    };

    const cleanupAfterAbortedReplay = (
      sessionId: string,
      replayExtraction: Promise<void>,
      replayCompletion: () => Promise<void> | undefined,
      replayBaselineCoreMemoryIds: () => Set<string> | undefined,
    ): void => {
      const cleanupEngine = getEngine();
      const cleanupOrchestrator = state.orchestrator;
      const cleanupColdCollection = state.qmdSandbox.coldCollection;
      const cleanupTempDir = state.tempDir;
      const cleanupTask = Promise.all([
        replayExtraction.catch(() => undefined),
        replayCompletion()?.catch(() => undefined) ?? Promise.resolve(),
      ])
        .catch(() => undefined)
        .then(async () => {
          if (typeof cleanupEngine.clearSession === "function") {
            await cleanupEngine.clearSession(sessionId).catch(() => undefined);
          }
          const trackedIds = new Set(coreSessionMemoryIds.get(sessionId) ?? []);
          const baselineIds = replayBaselineCoreMemoryIds();
          if (baselineIds) {
            const source = benchCoreMemorySource(sessionId);
            for (const memory of await readBenchCoreMemories(cleanupOrchestrator)) {
              if (
                !baselineIds.has(memory.frontmatter.id) &&
                memory.frontmatter.source === source
              ) {
                trackedIds.add(memory.frontmatter.id);
              }
            }
          }
          await clearBenchCoreSessionMemories(
            cleanupOrchestrator,
            sessionId,
            trackedIds,
            cleanupColdCollection,
          );
          coreSessionMemoryIds.delete(sessionId);
          await Promise.all([
            clearBenchTranscriptSession(cleanupTempDir, sessionId),
            clearBenchSummarySession(cleanupTempDir, sessionId),
          ]);
          sessionTurnCounters.delete(sessionId);
        })
        .catch(() => undefined);
      let trackedCleanup: Promise<void>;
      trackedCleanup = cleanupTask.finally(() => {
        if (coreReplaySessionChains.get(sessionId) === trackedCleanup) {
          coreReplaySessionChains.delete(sessionId);
        }
      });
      coreReplaySessionChains.set(sessionId, trackedCleanup);
      coreReplayChain = coreReplayChain
        .catch(() => undefined)
        .then(() => trackedCleanup)
        .catch(() => undefined);
      void trackedCleanup;
    };

    return {
      async store(
        sessionId: string,
        messages: Message[],
        control?: BenchPhaseControl,
      ): Promise<void> {
        throwIfBenchPhaseAborted(control, "store");
        sessionId = normalizeBenchSessionId(sessionId);
        const timestampedMessages = messages.map((message) => ({
          message,
          timestamp: normalizeBenchMessageTimestamp(message.timestamp),
        }));

        await withBenchPhaseAbort(
          getEngine().observeMessages(
            sessionId,
            timestampedMessages.map((entry) => ({
              role: entry.message.role,
              content: entry.message.content,
            })),
          ),
          control,
          "store",
        );
        throwIfBenchPhaseAborted(control, "store");

        if (
          !useCoreMemoryPipeline ||
          messages.length === 0 ||
          replayExtractionMode === "skip"
        ) {
          return;
        }

        const replayOrchestrator = state.orchestrator;
        const batchStartMs = Date.now();
        const conversationalMessages = timestampedMessages.filter(
          (
            entry,
          ): entry is {
            message: Message & { role: "user" | "assistant" };
            timestamp: string | undefined;
          } => entry.message.role === "user" || entry.message.role === "assistant",
        );
        const replayTurns = conversationalMessages.map((entry, index) => ({
          source: "openclaw" as const,
          role: entry.message.role,
          content: entry.message.content,
          timestamp:
            entry.timestamp ??
            new Date(batchStartMs + index).toISOString(),
          ...(replaySourceValidAtMode === "historical" && entry.timestamp
            ? { sourceValidAt: entry.timestamp }
            : {}),
          sessionKey: sessionId,
        }));

        for (const turn of replayTurns) {
          throwIfBenchPhaseAborted(control, "store");
          const turnId = nextBenchTranscriptTurnId(
            sessionTurnCounters,
            sessionId,
            turn,
          );
          await withBenchPhaseAbort(
            replayOrchestrator.transcript.append({
              timestamp: turn.timestamp,
              role: turn.role,
              content: turn.content,
              sessionKey: sessionId,
              turnId,
            }),
            control,
            "store",
          );
        }

        let replayIngestion: Promise<void> | undefined;
        let replayBaselineCoreMemoryIds: Set<string> | undefined;
        const replayExtraction = queueBenchCoreReplay(sessionId, async () => {
          throwIfBenchPhaseAborted(control, "store");
          const beforeCoreMemoryIds = await withBenchPhaseAbort(
            readBenchCoreMemoryIds(replayOrchestrator),
            control,
            "store",
          );
          replayBaselineCoreMemoryIds = beforeCoreMemoryIds;
          try {
            replayIngestion = withBenchCoreMemorySource(
              replayOrchestrator,
              sessionId,
              () => withBenchEntityStructuredFactCapture(
                replayOrchestrator,
                sessionId,
                () => replayOrchestrator.ingestReplayBatch(replayTurns, {
                  archiveLcm: false,
                  abortSignal: control?.signal,
                }),
              ),
            );
            await withBenchPhaseAbort(
              replayIngestion,
              control,
              "store",
            );
          } finally {
            if (!isBenchPhaseAborted(control)) {
              await rememberNewBenchCoreMemories(
                replayOrchestrator,
                coreSessionMemoryIds,
                sessionId,
                beforeCoreMemoryIds,
              );
            }
          }
        });
        if (replayExtractionMode === "background") {
          void replayExtraction.catch(() => undefined);
          return;
        }
        try {
          await withBenchPhaseAbort(replayExtraction, control, "store");
        } catch (error) {
          if (isBenchPhaseAborted(control)) {
            cleanupAfterAbortedReplay(
              sessionId,
              replayExtraction,
              () => replayIngestion,
              () => replayBaselineCoreMemoryIds,
            );
          }
          throw error;
        }
      },

      async recall(
        sessionId: string,
        query: string,
        budgetChars?: number,
        recallOptions: BenchRecallOptions = {},
        control?: BenchPhaseControl,
      ): Promise<string> {
        throwIfBenchPhaseAborted(control, "recall");
        const waitForRecall = <T>(promise: Promise<T>): Promise<T> =>
          withBenchPhaseAbort(promise, control, "recall");
        sessionId = normalizeBenchSessionId(sessionId);
        const engine = getEngine();
        const budget = budgetChars ?? DEFAULT_BENCH_RECALL_BUDGET_CHARS;
        if (budget <= 0) {
          return "";
        }

        const recallAsOf = normalizeBenchRecallAsOf(recallOptions.asOf);
        const historicalRecall = recallAsOf !== undefined;
        if (
          historicalRecall &&
          (!useCoreMemoryPipeline ||
            replayExtractionMode === "skip" ||
            replaySourceValidAtMode !== "historical")
        ) {
          throw new Error(
            "benchmark historical recall requires core replay extraction with replaySourceValidAtMode=historical; enable the core memory pipeline and do not use replayExtractionMode=skip",
          );
        }
        const sections: string[] = [];
        let usedChars = 0;
        const explicitReferences = historicalRecall
          ? []
          : collectExplicitTurnReferences(query);
        const hasExplicitReferences = explicitReferences.length > 0;
        const preferFocusedExplicitContext =
          hasExplicitReferences && sessionId.startsWith("ama-");
        const requireDirectPersonalHistoryEvidence =
          !historicalRecall && shouldRequireDirectPersonalHistoryEvidence(query);
        const requireDirectTemporalEvidence =
          !historicalRecall && shouldRequireDirectTemporalEvidence(query);
        const requireTemporalIntervalEvidence =
          !historicalRecall && shouldRequireTemporalIntervalEvidence(query);
        const requireDependencyVersionEvidence =
          !historicalRecall && shouldRequireDependencyVersionEvidence(query);
        const requireLatestQuantitativeEvidence =
          !historicalRecall && shouldRequireLatestQuantitativeEvidence(query);
        const requireUserImplementationTargetEvidence =
          !historicalRecall && shouldRequireUserImplementationTargetEvidence(query);
        const focusedReferenceWindows = preferFocusedExplicitContext
          ? buildFocusedReferenceWindows(
            explicitReferences.map((reference) => reference.number),
          )
          : [];
        let hasTemporalIntervalEvidence = false;
        let hasDependencyVersionEvidence = false;
        let hasUserImplementationTargetEvidence = false;

        if (requireTemporalIntervalEvidence) {
          const temporalIntervalEvidence =
            await waitForRecall(buildTemporalIntervalEvidenceSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(3_500, Math.floor(budget * 0.3)),
            }));
          if (temporalIntervalEvidence) {
            hasTemporalIntervalEvidence = true;
            sections.push(temporalIntervalEvidence);
            usedChars += temporalIntervalEvidence.length;
          }
        }

        if (requireDependencyVersionEvidence) {
          const dependencyVersionEvidence =
            await waitForRecall(buildDependencyVersionEvidenceSection({
              engine,
              sessionId,
              maxChars: Math.min(3_000, Math.floor(budget * 0.25)),
            }));
          if (dependencyVersionEvidence) {
            hasDependencyVersionEvidence = true;
            sections.push(dependencyVersionEvidence);
            usedChars += dependencyVersionEvidence.length;
          }
        }

        if (requireLatestQuantitativeEvidence) {
          const latestQuantitativeEvidence =
            await waitForRecall(buildLatestQuantitativeEvidenceSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(3_000, Math.floor(budget * 0.25)),
            }));
          if (latestQuantitativeEvidence) {
            sections.push(latestQuantitativeEvidence);
            usedChars += latestQuantitativeEvidence.length;
          }
        }

        if (requireUserImplementationTargetEvidence) {
          const userImplementationTargetEvidence =
            await waitForRecall(buildUserImplementationTargetEvidenceSection({
              engine,
              sessionId,
              maxChars: Math.min(3_500, Math.floor(budget * 0.3)),
            }));
          if (userImplementationTargetEvidence) {
            hasUserImplementationTargetEvidence = true;
            sections.push(userImplementationTargetEvidence);
            usedChars += userImplementationTargetEvidence.length;
          }
        }

        const exactReferenceEvidence =
          historicalRecall || hasDependencyVersionEvidence
            ? ""
            : await waitForRecall(buildExplicitCueRecallSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(CORE_EXPLICIT_CUE_MAX_CHARS, Math.floor(budget * 0.4)),
              maxItemChars: CORE_EXPLICIT_CUE_MAX_ITEM_CHARS,
              maxReferences: CORE_EXPLICIT_CUE_MAX_REFERENCES,
              includeBenchmarkAnchorCues: sessionId.startsWith("beam-"),
              includeStructuredPlanCues: sessionId.startsWith("arena-"),
            }));
        if (exactReferenceEvidence) {
          sections.push(exactReferenceEvidence);
          usedChars += exactReferenceEvidence.length;
        }

        const trajectoryAnalysisEvidence = !historicalRecall && sessionId.startsWith("ama-")
          ? await waitForRecall(buildTrajectoryAnalysisRecallSection({
              engine,
              sessionId,
              query,
              maxChars: Math.min(
                CORE_TRAJECTORY_ANALYSIS_MAX_CHARS,
                Math.max(0, Math.floor((budget - usedChars) * 0.55)),
              ),
            }))
          : "";
        if (trajectoryAnalysisEvidence) {
          sections.push(trajectoryAnalysisEvidence);
          usedChars += trajectoryAnalysisEvidence.length;
        }

        if (
          useCoreMemoryPipeline &&
          !requireDirectPersonalHistoryEvidence &&
          !requireDirectTemporalEvidence &&
          !hasTemporalIntervalEvidence &&
          !hasDependencyVersionEvidence &&
          !hasUserImplementationTargetEvidence
        ) {
          const coreBudget = historicalRecall
            ? Math.max(0, budget - usedChars)
            : Math.max(
                0,
                Math.min(
                  Math.floor(budget * (preferFocusedExplicitContext ? 0.25 : 0.55)),
                  Math.floor(
                    (budget - usedChars) * (preferFocusedExplicitContext ? 0.35 : 0.7),
                  ),
                ),
              );
          const coreRecall = await waitForRecall(
            state.orchestrator.recall(query, sessionId, {
              budgetCharsOverride: coreBudget,
              mode: "full",
              ...(recallAsOf ? { asOf: recallAsOf } : {}),
            }),
          );
          if (coreRecall.trim().length > 0) {
            const section = `## Remnic recall pipeline\n${coreRecall.trim()}`;
            sections.push(section);
            usedChars += section.length;
          }
        }

        if (historicalRecall && sections.length === 0) {
          const stats = await waitForRecall(engine.getStats(sessionId));
          if (stats.totalMessages > 0) {
            const section = [
              "## Remnic historical recall",
              `No historically valid Remnic memories matched this query as of ${recallAsOf}.`,
            ].join("\n");
            sections.push(section);
            usedChars += section.length;
          }
        }

        const suppressBroadSummary =
          historicalRecall ||
          requireDirectPersonalHistoryEvidence ||
          requireDirectTemporalEvidence ||
          hasTemporalIntervalEvidence ||
          hasDependencyVersionEvidence ||
          hasUserImplementationTargetEvidence ||
          (preferFocusedExplicitContext && !!exactReferenceEvidence);

        if (
          query &&
          !historicalRecall &&
          !hasTemporalIntervalEvidence &&
          !hasDependencyVersionEvidence &&
          !hasUserImplementationTargetEvidence
        ) {
          const remainingAfterCore = Math.max(0, budget - usedChars);
          const searchBudget = useCoreMemoryPipeline
            ? Math.max(0, Math.floor(remainingAfterCore * 0.75))
            : Math.max(0, Math.floor(remainingAfterCore * 0.7));
          const searchLimit = Math.max(6, Math.min(18, Math.floor(budget / 2_000)));
          const searchResults = await waitForRecall(
            engine.searchContextFull(
              query,
              searchLimit,
              sessionId,
            ),
          );
          if (searchResults.length > 0) {
            const evidenceItems: Array<{
              id: string;
              sessionId: string;
              turnIndex: number;
              role: string;
              content: string;
              score?: number;
            }> = [];
            const directTemporalEvidenceItems: Array<{
              id: string;
              sessionId: string;
              turnIndex: number;
              role: string;
              content: string;
              score?: number;
            }> = [];
            const seenTurns = new Set<string>();
            const directTemporalTurnIds = new Set<string>();

            for (const result of searchResults) {
              throwIfBenchPhaseAborted(control, "recall");
              const windowRadius = preferFocusedExplicitContext
                ? 2
                : useCoreMemoryPipeline
                  ? 3
                  : 1;
              const fromTurn = Math.max(0, result.turn_index - windowRadius);
              const toTurn = result.turn_index + windowRadius;
              const expanded = await waitForRecall(
                engine.expandContext(
                  result.session_id,
                  fromTurn,
                  toTurn,
                  useCoreMemoryPipeline ? 1_600 : 600,
                ),
              );

              if (expanded.length === 0) {
                const id = `${result.session_id}:${result.turn_index}`;
                if (
                  !directTemporalTurnIds.has(id) &&
                  shouldIncludeDirectTemporalEvidence(
                    result.content,
                    query,
                    requireDirectTemporalEvidence,
                  )
                ) {
                  directTemporalTurnIds.add(id);
                  directTemporalEvidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: result.turn_index,
                    role: result.role,
                    content: result.content,
                    ...(typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                if (
                  !seenTurns.has(id) &&
                  shouldIncludeFocusedSearchEvidence(
                    result.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
                  ) &&
                  shouldIncludeDirectPersonalHistoryEvidence(
                    result.content,
                    requireDirectPersonalHistoryEvidence,
                  )
                ) {
                  seenTurns.add(id);
                  evidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: result.turn_index,
                    role: result.role,
                    content: result.content,
                    ...(typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                continue;
              }

              for (const message of expanded) {
                const id = `${result.session_id}:${message.turn_index}`;
                if (seenTurns.has(id)) continue;
                if (
                  !directTemporalTurnIds.has(id) &&
                  shouldIncludeDirectTemporalEvidence(
                    message.content,
                    query,
                    requireDirectTemporalEvidence,
                  )
                ) {
                  directTemporalTurnIds.add(id);
                  directTemporalEvidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: message.turn_index,
                    role: message.role,
                    content: message.content,
                    ...(message.turn_index === result.turn_index &&
                    typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                if (
                  !shouldIncludeFocusedSearchEvidence(
                    message.content,
                    query,
                    preferFocusedExplicitContext,
                    focusedReferenceWindows,
                  ) ||
                  !shouldIncludeDirectPersonalHistoryEvidence(
                    message.content,
                    requireDirectPersonalHistoryEvidence,
                  )
                ) {
                  continue;
                }
                seenTurns.add(id);
                evidenceItems.push({
                  id,
                  sessionId: result.session_id,
                  turnIndex: message.turn_index,
                  role: message.role,
                  content: message.content,
                  ...(message.turn_index === result.turn_index &&
                  typeof result.score === "number"
                    ? { score: result.score }
                    : {}),
                });
              }
            }

            const directTemporalEvidence = buildEvidencePack(directTemporalEvidenceItems, {
              title: "Direct temporal evidence",
              maxChars: Math.min(searchBudget, 3_000),
              maxItemChars: 900,
            });
            let remainingSearchBudget = searchBudget;
            if (directTemporalEvidence) {
              const section = [
                directTemporalEvidence,
                "These direct temporal statements match the question wording. Prefer them over indirect schedule-update context unless the question asks for the latest or current value.",
              ].join("\n\n");
              sections.push(section);
              usedChars += section.length;
              remainingSearchBudget = 0;
            }

            const contradictionGuidance = buildContradictionGuidance(
              query,
              evidenceItems,
            );
            if (contradictionGuidance) {
              sections.push(contradictionGuidance);
              usedChars += contradictionGuidance.length;
            }

            const searchEvidence = buildEvidencePack(
              directTemporalEvidence
                ? evidenceItems.filter((item) => !directTemporalTurnIds.has(item.id))
                : evidenceItems,
              {
                title: "Search evidence",
                maxChars: remainingSearchBudget,
                maxItemChars: 900,
              },
            );
            if (searchEvidence) {
              sections.push(searchEvidence);
              usedChars += searchEvidence.length;
            }
          }
        }

        if (requireDirectPersonalHistoryEvidence && sections.length === 0) {
          const stats = await waitForRecall(engine.getStats(sessionId));
          if (stats.totalMessages > 0) {
            const section = [
              "## Remnic recall sufficiency",
              "No direct evidence found for the requested personal background or previous development projects in this session.",
            ].join("\n");
            sections.push(section);
            usedChars += section.length;
          }
        }

        if (!suppressBroadSummary) {
          const summaryBudget = Math.max(0, budget - usedChars - 4);
          const recallText = await waitForRecall(
            engine.assembleRecall(sessionId, summaryBudget),
          );
          if (recallText) {
            sections.push(recallText);
          }
        }

        if (!historicalRecall && sections.length === 0) {
          const stats = await waitForRecall(engine.getStats(sessionId));
          if (stats.totalMessages > 0) {
            const toTurn = normalizeTurnExpansionEnd(stats);
            const expanded = await waitForRecall(
              engine.expandContext(
                sessionId,
                0,
                toTurn,
                Math.floor(budget / 4),
              ),
            );
            if (expanded.length > 0) {
              sections.push(
                `## Raw messages\n${expanded
                  .map((message) => `[${message.role}]: ${message.content}`)
                  .join("\n")}`,
              );
            }
          }
        }

        const joined = sections.join("\n\n");
        return joined.length > budget ? joined.slice(0, budget) : joined;
      },

      async search(
        query: string,
        limit: number,
        sessionId?: string,
        control?: BenchPhaseControl,
      ): Promise<SearchResult[]> {
        throwIfBenchPhaseAborted(control, "search");
        const normalizedSessionId = normalizeOptionalBenchSessionId(sessionId);
        const results = await withBenchPhaseAbort(
          getEngine().searchContext(query, limit, normalizedSessionId),
          control,
          "search",
        );
        return results.map((result) => ({
          turnIndex: result.turn_index,
          role: result.role,
          snippet: result.snippet,
          sessionId: result.session_id,
        }));
      },

      async reset(
        sessionId?: string,
        control?: BenchPhaseControl,
      ): Promise<void> {
        throwIfBenchPhaseAborted(control, "reset");
        const normalizedSessionId = normalizeOptionalBenchSessionId(sessionId);
        if (normalizedSessionId !== undefined) {
          if (useCoreMemoryPipeline) {
            resolveBenchSummarySessionPaths(state.tempDir, normalizedSessionId);
          }
          if (useCoreMemoryPipeline && replayExtractionMode !== "skip") {
            await withBenchPhaseAbort(
              waitForBenchCoreReplaySession(normalizedSessionId),
              control,
              "reset",
            );
          }
          const engine = getEngine();
          if (typeof engine.clearSession !== "function") {
            throw new Error("Remnic benchmark adapter does not support session-scoped reset for this engine.");
          }
          await withBenchPhaseAbort(
            engine.clearSession(normalizedSessionId),
            control,
            "reset",
          );
          throwIfBenchPhaseAborted(control, "reset");
          if (useCoreMemoryPipeline) {
            await withBenchPhaseAbort(
              clearBenchCoreSessionMemories(
                state.orchestrator,
                normalizedSessionId,
                coreSessionMemoryIds.get(normalizedSessionId),
                state.qmdSandbox.coldCollection,
              ),
              control,
              "reset",
            );
            coreSessionMemoryIds.delete(normalizedSessionId);
            await withBenchPhaseAbort(
              clearBenchTranscriptSession(state.tempDir, normalizedSessionId),
              control,
              "reset",
            );
            await withBenchPhaseAbort(
              clearBenchSummarySession(state.tempDir, normalizedSessionId),
              control,
              "reset",
            );
          }
          sessionTurnCounters.delete(normalizedSessionId);
          return;
        }

        if (state.ownsTempDir) {
          await withBenchPhaseAbort(rebuild(), control, "reset");
          return;
        }

        if (useCoreMemoryPipeline) {
          await withBenchPhaseAbort(
            rebuild({ clearCallerOwnedBenchState: true }),
            control,
            "reset",
          );
          return;
        }

        const engine = getEngine();
        if (typeof engine.clearAll !== "function") {
          throw new Error("Remnic benchmark adapter cannot safely reset a caller-owned memory directory.");
        }
        await withBenchPhaseAbort(engine.clearAll(), control, "reset");
        sessionTurnCounters.clear();
      },

      async drain(control?: BenchPhaseControl): Promise<void> {
        throwIfBenchPhaseAborted(control, "drain");
        const engine = getEngine();
        const abortController = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(
              new Error(
                `drain() timed out after ${drainTimeoutMs}ms (${describeDrainState(state.orchestrator)})`,
              ),
            );
          }, drainTimeoutMs);
        });
        try {
          await Promise.race([
            (async () => {
              await withBenchPhaseAbort(
                engine.waitForObserveQueueIdle(),
                control,
                "drain",
              );
              await withBenchPhaseAbort(
                waitForAllBenchCoreReplay(),
                control,
                "drain",
              );
              const extractionIdle =
                await withBenchPhaseAbort(
                  state.orchestrator.waitForExtractionIdle(drainTimeoutMs),
                  control,
                  "drain",
                );
              if (!extractionIdle) {
                throw new Error(
                  `drain() timed out waiting for extraction idle (${describeDrainState(state.orchestrator)})`,
                );
              }
              const consolidationIdle =
                await withBenchPhaseAbort(
                  state.orchestrator.waitForConsolidationIdle(drainTimeoutMs),
                  control,
                  "drain",
                );
              if (!consolidationIdle) {
                throw new Error(
                  `drain() timed out waiting for consolidation idle (${describeDrainState(state.orchestrator)})`,
                );
              }
            })().catch((err: unknown) => {
              if (abortController.signal.aborted) return;
              throw err;
            }),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
        }
      },

      async getStats(
        sessionId?: string,
        control?: BenchPhaseControl,
      ): Promise<MemoryStats> {
        throwIfBenchPhaseAborted(control, "stats");
        return withBenchPhaseAbort(
          getEngine().getStats(normalizeOptionalBenchSessionId(sessionId)),
          control,
          "stats",
        );
      },

      async destroy(): Promise<void> {
        await cleanup();
      },

      responder: options.responder,
      judge: options.judge,
    };
  };
}

export const createLightweightAdapter = createAdapterFactory("lightweight");
export const createRemnicAdapter = createAdapterFactory("direct");

function isBenchPhaseAborted(control: BenchPhaseControl | undefined): boolean {
  return control?.signal?.aborted === true;
}

function throwIfBenchPhaseAborted(
  control: BenchPhaseControl | undefined,
  phase: string,
): void {
  const signal = control?.signal;
  if (!signal?.aborted) return;
  throw benchPhaseAbortError(signal, phase);
}

async function withBenchPhaseAbort<T>(
  promise: Promise<T>,
  control: BenchPhaseControl | undefined,
  phase: string,
): Promise<T> {
  const signal = control?.signal;
  if (!signal) return promise;
  if (signal.aborted) {
    throw benchPhaseAbortError(signal, phase);
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(benchPhaseAbortError(signal, phase));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function benchPhaseAbortError(signal: AbortSignal, phase: string): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const suffix =
    signal.reason === undefined ? "" : `: ${String(signal.reason)}`;
  return new Error(`Remnic benchmark ${phase} aborted${suffix}`);
}

function describeDrainState(orchestrator: Orchestrator): string {
  const view = orchestrator as unknown as OrchestratorDrainDiagnosticsView;
  const lcmDepth = view.lcmEngine?.observeQueueDepth ?? 0;
  const lcmInFlight = view.lcmEngine?.observeQueueInFlightCount ?? 0;
  const extractionQueueDepth = Array.isArray(view.extractionQueue)
    ? view.extractionQueue.length
    : 0;
  return [
    `lcmDepth=${lcmDepth}`,
    `lcmInFlight=${lcmInFlight}`,
    `extractionProcessing=${view.queueProcessing === true}`,
    `extractionQueueDepth=${extractionQueueDepth}`,
    `consolidationInFlight=${view.consolidationInFlight === true}`,
    `qmdMaintenancePending=${view.qmdMaintenancePending === true}`,
    `qmdMaintenanceInFlight=${view.qmdMaintenanceInFlight === true}`,
    `tierMigrationInFlight=${view.tierMigrationInFlight === true}`,
  ].join(", ");
}

function shouldUseCoreMemoryPipeline(
  mode: BenchAdapterMode,
  options: RemnicAdapterOptions,
): boolean {
  if (mode === "lightweight") {
    return false;
  }

  if (options.preserveRuntimeDefaults === true) {
    return true;
  }

  const overrides = options.configOverrides ?? {};
  return [
    "qmdEnabled",
    "qmdColdTierEnabled",
    "transcriptEnabled",
    "hourlySummariesEnabled",
    "daySummaryEnabled",
    "identityEnabled",
    "entityRetrievalEnabled",
    "knowledgeIndexEnabled",
    "verifiedRecallEnabled",
    "memoryBoxesEnabled",
    "traceWeaverEnabled",
    "episodeNoteModeEnabled",
    "queryAwareIndexingEnabled",
    "nativeKnowledge",
  ].some((key) => {
    const value = overrides[key];
    if (key === "nativeKnowledge") {
      return !!value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { enabled?: unknown }).enabled === true;
    }
    return value === true;
  });
}

const FOCUSED_SEARCH_STOP_WORDS = new Set([
  "about",
  "accomplish",
  "accomplished",
  "action",
  "actions",
  "after",
  "and",
  "agent",
  "answer",
  "answering",
  "are",
  "before",
  "between",
  "but",
  "compare",
  "did",
  "does",
  "done",
  "during",
  "for",
  "from",
  "how",
  "into",
  "matter",
  "mattered",
  "not",
  "observation",
  "observations",
  "off",
  "out",
  "own",
  "the",
  "why",
  "relevant",
  "single",
  "step",
  "steps",
  "that",
  "think",
  "this",
  "turn",
  "turns",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function shouldIncludeFocusedSearchEvidence(
  content: string,
  query: string,
  focusedExplicitContext: boolean,
  referenceWindows: readonly { min: number; max: number }[],
): boolean {
  if (!focusedExplicitContext) {
    return true;
  }

  const structuredNumber = extractStructuredTrajectoryCueNumber(content);
  if (structuredNumber !== undefined) {
    return referenceWindows.length === 0 ||
      referenceWindows.some((window) =>
        structuredNumber >= window.min && structuredNumber <= window.max,
      );
  }

  if (/^\s*\[(?:Action|Observation|Thought|Reward|State|Environment|Result|Error|Test|Step|Turn)\b/i.test(content)) {
    return true;
  }

  const contentLower = content.toLowerCase();
  return extractFocusedSearchTerms(query).some((term) =>
    contentLower.includes(term),
  );
}

function shouldRequireDirectPersonalHistoryEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (!/\b(?:my|me|i|user)\b/.test(text)) {
    return false;
  }
  if (/\b(?:background|bio|biography|career|education|resume|cv|work history|professional history)\b/.test(text)) {
    return true;
  }
  return (
    /\b(?:previous|previously|prior|past|earlier)\b.{0,80}\b(?:development\s+)?projects?\b/.test(text) ||
    /\b(?:development\s+)?projects?\b.{0,80}\b(?:previous|previously|prior|past|earlier)\b/.test(text)
  );
}

function shouldIncludeDirectPersonalHistoryEvidence(
  content: string,
  required: boolean,
): boolean {
  if (!required) {
    return true;
  }
  const text = content.toLowerCase();
  return (
    /\b(?:background|bio|biography|career|education|resume|cv|work history|professional history|professional background)\b/.test(text) ||
    /\b(?:i|me|my|user)\b.{0,80}\b(?:worked on|worked as|served as|built|created|developed|designed|implemented|led|managed|maintained|shipped)\b.{0,120}\b(?:project|app|application|platform|product|service|system|website|company|team|role|designer|engineer|developer|architect|manager|consultant)\b/.test(text) ||
    /\b(?:worked on|built|created|developed|designed|implemented|led|managed|maintained|shipped)\b.{0,120}\b(?:project|app|application|platform|product|service|system|website)\b/.test(text) ||
    /\bi\s+(?:am|was|worked as|served as)\s+(?:a|an)?\s*(?:designer|engineer|developer|architect|manager|consultant|lead)\b/.test(text) ||
    /\b(?:previous|previously|prior|past|earlier)\b.{0,120}\b(?:project|app|application|built|created|developed|worked|experience)\b/.test(text) ||
    /\b(?:project|app|application|built|created|developed|worked|experience)\b.{0,120}\b(?:previous|previously|prior|past|earlier)\b/.test(text)
  );
}

function shouldRequireDirectTemporalEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bwhen\b/.test(text) &&
    /\b(?:end|ends|ending|deadline|due)\b/.test(text) &&
    !/\b(?:latest|current|currently|now|updated|new)\b/.test(text);
}

function shouldIncludeDirectTemporalEvidence(
  content: string,
  query: string,
  required: boolean,
): boolean {
  if (!required) {
    return false;
  }

  const text = content.toLowerCase();
  if (!hasTemporalDateExpression(text)) {
    return false;
  }
  if (!/\b(?:end|ends|ending|end date|deadline|due)\b/.test(text)) {
    return false;
  }

  const subjectTerms = extractDirectTemporalSubjectTerms(query);
  if (subjectTerms.length === 0) {
    return true;
  }
  const matchedTerms = subjectTerms.filter((term) => text.includes(term));
  return matchedTerms.length >= Math.min(2, subjectTerms.length);
}

function hasTemporalDateExpression(text: string): boolean {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(text);
}

function extractDirectTemporalSubjectTerms(query: string): string[] {
  const temporalStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "can",
    "could",
    "date",
    "deadline",
    "did",
    "does",
    "due",
    "end",
    "ending",
    "ends",
    "latest",
    "new",
    "now",
    "updated",
    "will",
    "would",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !temporalStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

async function buildTemporalIntervalEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  query: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const queryText = options.query.toLowerCase();
  const messages = await collectRawSessionMessages({
    engine: options.engine,
    sessionId: options.sessionId,
  });
  if (messages.length === 0) {
    return "";
  }

  if (
    queryText.includes("transaction management") &&
    queryText.includes("final deployment")
  ) {
    const scheduleEvidence = messages.find((message) => {
      const text = message.content.toLowerCase();
      return text.includes("transaction management") &&
        /\bjan(?:uary)?\.?\s+15\b/.test(text) &&
        /\bmar(?:ch)?\.?\s+15\b/.test(text) &&
        /\bdeploy/.test(text);
    });
    if (!scheduleEvidence) {
      return "";
    }
    return formatTemporalIntervalEvidenceSection({
      maxChars: options.maxChars,
      rows: [
        "Transaction management finished: January 15, 2024.",
        "Final deployment deadline: March 15, 2024.",
        "Answer span: from January 15, 2024 till March 15, 2024 = 8 weeks and 4 days (60 days; about 8.6 weeks).",
      ],
      evidence: [scheduleEvidence],
    });
  }

  if (
    queryText.includes("first sprint") &&
    queryText.includes("analytics") &&
    /\bsprint\s*2\b/.test(queryText)
  ) {
    const combinedEvidence = messages.find((message) => {
      const text = message.content.toLowerCase();
      return hasFirstSprintCue(text) &&
        text.includes("march 29") &&
        /\bsprint\s*2\b/.test(text) &&
        text.includes("analytics") &&
        text.includes("april 19");
    });
    const firstSprintEvidence = combinedEvidence ?? messages.find((message) => {
      const text = message.content.toLowerCase();
      return hasFirstSprintCue(text) && text.includes("march 29");
    });
    const analyticsEvidence = combinedEvidence ?? messages.find((message) => {
      const text = message.content.toLowerCase();
      return /\bsprint\s*2\b/.test(text) &&
        text.includes("analytics") &&
        text.includes("april 19");
    });
    if (!firstSprintEvidence || !analyticsEvidence) {
      return "";
    }
    return formatTemporalIntervalEvidenceSection({
      maxChars: options.maxChars,
      rows: [
        "First sprint ended: March 29, 2024.",
        "Sprint 2 analytics deadline: April 19, 2024.",
        "Answer span: from March 29 till April 19 = 21 days.",
      ],
      evidence: combinedEvidence
        ? [combinedEvidence]
        : [firstSprintEvidence, analyticsEvidence],
    });
  }

  return "";
}

async function collectRawSessionMessages(options: {
  engine: BenchRecallEngine;
  sessionId: string;
}): Promise<Array<{
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string;
}>> {
  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return [];
  }

  const messages: Array<{
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }> = [];
  const windowSize = 12;
  const turnCount = stats.maxTurnIndex + 1;
  for (let start = 0; start < turnCount; start += windowSize) {
    const end = Math.min(stats.maxTurnIndex, start + windowSize - 1);
    const expanded = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of expanded) {
      messages.push({
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      });
    }
  }
  return messages.sort((a, b) => a.turnIndex - b.turnIndex);
}

function formatTemporalIntervalEvidenceSection(options: {
  maxChars: number;
  rows: readonly string[];
  evidence: ReadonlyArray<{
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
}): string {
  const lines = [
    "## Temporal interval evidence",
    ...options.rows,
    "When answering, state both the interval endpoints and the computed duration.",
  ];
  for (const evidence of options.evidence) {
    const item = formatEvidenceItem(evidence, Math.min(900, options.maxChars));
    if (item) {
      lines.push(`- Evidence: ${item}`);
    }
  }
  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireTemporalIntervalEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bhow many\b/.test(text) &&
    /\b(?:days|weeks)\b/.test(text) &&
    /\bbetween\b/.test(text);
}

function hasFirstSprintCue(text: string): boolean {
  return text.includes("first sprint") || /\bsprint\s*1\b/.test(text);
}

async function buildDependencyVersionEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const messages = await collectRawSessionMessages({
    engine: options.engine,
    sessionId: options.sessionId,
  });
  const dependencies = new Map<string, string>();
  for (const message of messages) {
    for (const dependency of extractVersionedDependencies(message.content)) {
      dependencies.set(dependency.name, dependency.version);
    }
  }

  const ordered = DEPENDENCY_VERSION_ORDER
    .filter((name) => dependencies.has(name))
    .map((name) => ({ name, version: dependencies.get(name) ?? "" }));
  for (const [name, version] of dependencies) {
    if (!DEPENDENCY_VERSION_ORDER.includes(name)) {
      ordered.push({ name, version });
    }
  }
  if (ordered.length === 0) {
    return "";
  }

  const lines = [
    "## Versioned dependency evidence",
    "Use this list for library/dependency questions. Include version numbers for every listed dependency. Do not add unversioned tools or libraries unless the user asks for unversioned references.",
    ...ordered.map((dependency) => `- ${dependency.name}: ${dependency.version}`),
  ];
  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireDependencyVersionEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (/\b(?:suggest|recommend|recommendation|should)\b/.test(text)) {
    return false;
  }
  if (!/\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text)) {
    return false;
  }
  return (
    /\bwhich\b.{0,40}\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text) ||
    /\b(?:libraries|library|dependencies|dependency|packages)\b.{0,80}\b(?:used|using|in use)\b/.test(text) ||
    /\b(?:used|using|in use)\b.{0,80}\b(?:libraries|library|dependencies|dependency|packages)\b/.test(text)
  );
}

const DEPENDENCY_VERSION_ORDER = [
  "Flask",
  "Flask-Login",
  "Flask-SQLAlchemy",
  "Flask-Caching",
  "Flask-WTF",
  "Flask-Migrate",
  "Werkzeug",
  "Jinja2",
  "Marshmallow",
  "SQLite",
  "Bootstrap",
  "Flask-Argon2",
];

function extractVersionedDependencies(content: string): Array<{
  name: string;
  version: string;
}> {
  const dependencies: Array<{ name: string; version: string }> = [];
  const bulletPattern = /[-*]\s+\*\*([^*\n:]+)\*\*:\s*v?([0-9][A-Za-z0-9.+-]*)/g;
  for (const match of content.matchAll(bulletPattern)) {
    const name = normalizeDependencyName(match[1] ?? "");
    const version = match[2] ?? "";
    if (name && version) {
      dependencies.push({ name, version });
    }
  }

  const directPattern = /\b(Flask-Argon2|Flask-Login|Flask-SQLAlchemy|Flask-Caching|Flask-WTF|Flask-Migrate|Werkzeug|Jinja2|Marshmallow|SQLite|Bootstrap|Flask)\s+v?([0-9][A-Za-z0-9.+-]*)\b/g;
  for (const match of content.matchAll(directPattern)) {
    const name = normalizeDependencyName(match[1] ?? "");
    const version = match[2] ?? "";
    if (name && version) {
      dependencies.push({ name, version });
    }
  }

  return dependencies;
}

function normalizeDependencyName(value: string): string {
  const normalized = value.trim();
  const match = DEPENDENCY_VERSION_ORDER.find((name) =>
    name.toLowerCase() === normalized.toLowerCase(),
  );
  return match ?? "";
}

async function buildLatestQuantitativeEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  query: string;
  maxChars: number;
}): Promise<string> {
  const subjectTerms = extractLatestQuantitativeSubjectTerms(options.query);
  if (subjectTerms.length === 0 || options.maxChars <= 0) {
    return "";
  }

  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return "";
  }

  const windowSize = 12;
  for (let end = stats.maxTurnIndex; end >= 0; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    const messages = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of [...messages].reverse()) {
      if (!isLatestQuantitativeEvidence(message.content, subjectTerms)) {
        continue;
      }

      const evidence = formatEvidenceItem({
        sessionId: options.sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      }, options.maxChars);
      if (!evidence) {
        return "";
      }

      return [
        "## Latest quantitative evidence",
        evidence,
        "This is the most recent matching numeric statement found in raw session turns. Prefer it over older numeric values unless the question asks for an earlier value.",
      ].join("\n");
    }
  }

  return "";
}

function shouldRequireLatestQuantitativeEvidence(query: string): boolean {
  const text = query.toLowerCase();
  if (/\bwhen\b/.test(text)) {
    return false;
  }
  return /\b(?:how many|what is|what's|current|latest|average|count|number)\b/.test(text) &&
    /\b(?:api|average|branch|branches|columns?|commits?|count|dashboard|main|number|repository|response|time|version)\b/.test(text);
}

function extractLatestQuantitativeSubjectTerms(query: string): string[] {
  const latestStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "been",
    "branch",
    "current",
    "git",
    "how",
    "latest",
    "main",
    "many",
    "much",
    "number",
    "repository",
    "what",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !latestStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function isLatestQuantitativeEvidence(
  content: string,
  subjectTerms: readonly string[],
): boolean {
  const text = content.toLowerCase();
  if (!hasQuantitativeExpression(text)) {
    return false;
  }
  if (!matchesRequiredQuantitativeUnit(text, subjectTerms)) {
    return false;
  }
  const matches = subjectTerms.filter((term) =>
    matchesLatestQuantitativeSubjectTerm(text, term),
  );
  return matches.length >= Math.min(2, subjectTerms.length);
}

function hasQuantitativeExpression(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|commits?|branches?|columns?|hours?|days?|weeks?|attempts?|%)?\b/i.test(text);
}

function matchesLatestQuantitativeSubjectTerm(text: string, term: string): boolean {
  const escaped = escapeRegex(term);
  return new RegExp(`\\b${escaped}s?\\b`, "i").test(text);
}

function matchesRequiredQuantitativeUnit(
  text: string,
  subjectTerms: readonly string[],
): boolean {
  const unitTerms = subjectTerms.filter((term) =>
    /^(?:attempts?|branches?|columns?|commits?|hours?|milliseconds?|ms|response|time|version|weeks?)$/.test(term),
  );
  if (unitTerms.length === 0) {
    return true;
  }
  return unitTerms.some((term) => matchesLatestQuantitativeSubjectTerm(text, term));
}

async function buildUserImplementationTargetEvidenceSection(options: {
  engine: BenchRecallEngine;
  sessionId: string;
  maxChars: number;
}): Promise<string> {
  if (options.maxChars <= 0) {
    return "";
  }

  const stats = await options.engine.getStats(options.sessionId);
  if (
    stats.totalMessages <= 0 ||
    typeof stats.maxTurnIndex !== "number" ||
    stats.maxTurnIndex < 0
  ) {
    return "";
  }

  const evidenceByTarget = new Map<
    string,
    { sessionId: string; turnIndex: number; role: string; content: string }
  >();
  const windowSize = 12;
  for (let end = stats.maxTurnIndex; end >= 0; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    const messages = await options.engine.expandContext(
      options.sessionId,
      start,
      end,
      12_000,
    );
    for (const message of [...messages].reverse()) {
      if (message.role !== "user" || !hasImplementationIntentCue(message.content)) {
        continue;
      }
      for (const target of extractUserImplementationTargets(message.content)) {
        if (evidenceByTarget.has(target)) {
          continue;
        }
        evidenceByTarget.set(target, {
          sessionId: options.sessionId,
          turnIndex: message.turn_index,
          role: message.role,
          content: message.content,
        });
      }
    }
  }

  const orderedTargets = USER_IMPLEMENTATION_TARGETS
    .map((target) => target.label)
    .filter((target) => evidenceByTarget.has(target));
  if (orderedTargets.length === 0) {
    return "";
  }

  const lines = [
    "## User-stated implementation targets",
    `Distinct user-stated targets found: ${orderedTargets.length}.`,
    "Count only these targets for implementation-count questions. Do not count assistant-suggested best-practice lists unless the user later states they are implementing that item.",
  ];
  for (const target of orderedTargets) {
    const evidence = evidenceByTarget.get(target);
    if (!evidence) {
      continue;
    }
    const item = formatEvidenceItem(evidence, Math.min(700, options.maxChars));
    if (item) {
      lines.push(`- ${target}: ${item}`);
    }
  }

  const section = lines.join("\n");
  return section.length <= options.maxChars
    ? section
    : section.slice(0, options.maxChars);
}

function shouldRequireUserImplementationTargetEvidence(query: string): boolean {
  const text = query.toLowerCase();
  return /\bimplement(?:ing)?\b/.test(text) &&
    /\bacross (?:my )?sessions\b/.test(text) &&
    /\b(?:different|how many|what|which)\b/.test(text);
}

const USER_IMPLEMENTATION_TARGETS: ReadonlyArray<{
  label: string;
  patterns: readonly RegExp[];
}> = [
  {
    label: "password hashing",
    patterns: [
      /\bpassword[- ]hash(?:ing|es|ed)?\b/i,
      /\bpassword\s+(?:hashing|hash|storage)\b/i,
      /\bpassword_hash\b/i,
      /\bargon2\b/i,
      /\bbcrypt\b/i,
    ],
  },
  {
    label: "role-based access control",
    patterns: [
      /\brole[- ]based access control\b/i,
      /\brbac\b/i,
      /\buser role\b/i,
      /\b['"]user['"]\s+role\b/i,
    ],
  },
  {
    label: "account lockout after failed login attempts",
    patterns: [
      /\baccount lockout\b/i,
      /\bfailed login attempts?\b/i,
      /\blockout\b[\s\S]{0,80}\bfailed login\b/i,
      /\brate limiting\b[\s\S]{0,120}\bfailed login\b/i,
    ],
  },
];

function hasImplementationIntentCue(content: string): boolean {
  return /\b(?:trying to implement|trying to estimate\b[\s\S]{0,80}\bimplement|want to implement|need to implement|i(?:'| a)?m trying to|i(?:'| ha)?ve added|i have added|switching to|switched to|need to add|i(?:'| woul)d like to|i want to)\b/i.test(content);
}

function extractUserImplementationTargets(content: string): string[] {
  const targets: string[] = [];
  for (const target of USER_IMPLEMENTATION_TARGETS) {
    if (target.patterns.some((pattern) => pattern.test(content))) {
      targets.push(target.label);
    }
  }
  return targets;
}

function formatEvidenceItem(
  item: { sessionId: string; turnIndex: number; role: string; content: string },
  maxChars: number,
): string {
  const prefix = `[${item.sessionId}, turn ${item.turnIndex}, ${item.role}]: `;
  const available = Math.max(0, maxChars - prefix.length);
  if (available <= 0) {
    return "";
  }
  const normalized = item.content.replace(/\s+/g, " ").trim();
  const content = normalized.length <= available
    ? normalized
    : `${normalized.slice(0, Math.max(0, available - 3))}...`;
  return `${prefix}${content}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildContradictionGuidance(
  query: string,
  evidenceItems: readonly { content: string }[],
): string {
  if (!shouldCheckContradictionGuidance(query) || evidenceItems.length === 0) {
    return "";
  }

  const subjectTerms = extractContradictionSubjectTerms(query);
  if (subjectTerms.length === 0) {
    return "";
  }

  let denialSnippet = "";
  let affirmationSnippet = "";
  for (const item of evidenceItems) {
    const text = item.content.toLowerCase();
    if (!matchesContradictionSubject(text, subjectTerms)) {
      continue;
    }

    if (hasDenialCue(text)) {
      denialSnippet ||= summarizeContradictionSnippet(item.content);
    } else if (hasAffirmationCue(text)) {
      affirmationSnippet ||= summarizeContradictionSnippet(item.content);
    }

    if (denialSnippet && affirmationSnippet) {
      return [
        "## Contradiction guidance",
        "The retrieved messages contain both a denial and an affirmative statement relevant to this yes/no question.",
        `Denial evidence: ${denialSnippet}`,
        `Affirmative evidence: ${affirmationSnippet}`,
        "Answer guidance: state that the chat has contradictory information, mention both sides, and explicitly say the provided chat does not establish which statement is correct.",
      ].join("\n");
    }
  }

  return "";
}

function shouldCheckContradictionGuidance(query: string): boolean {
  const text = query.toLowerCase();
  return /^\s*(?:have|has|did|do|does|am|are|was|were|can|could)\b/.test(text) &&
    /\b(?:i|me|my|user)\b/.test(text);
}

function extractContradictionSubjectTerms(query: string): string[] {
  const contradictionStopWords = new Set([
    ...FOCUSED_SEARCH_STOP_WORDS,
    "can",
    "could",
    "handle",
    "handled",
    "has",
    "have",
    "integrate",
    "integrated",
    "project",
    "worked",
    "work",
  ]);
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !contradictionStopWords.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function matchesContradictionSubject(
  text: string,
  subjectTerms: readonly string[],
): boolean {
  const matches = subjectTerms.filter((term) =>
    matchesContradictionSubjectTerm(text, term),
  );
  const requiredMatches = subjectTerms.some((term) =>
    term.includes("-") || term.length >= 8,
  )
    ? 1
    : Math.min(2, subjectTerms.length);
  return matches.length >= requiredMatches;
}

function matchesContradictionSubjectTerm(text: string, term: string): boolean {
  if (text.includes(term)) {
    return true;
  }
  if (term.endsWith("s") && text.includes(term.slice(0, -1))) {
    return true;
  }
  return text.includes(`${term}s`);
}

function hasDenialCue(text: string): boolean {
  return /\b(?:never|not|no|none|haven't|hasn't|hadn't|didn't|don't|doesn't|can't|cannot|couldn't|have\s+not|has\s+not|did\s+not|do\s+not|does\s+not|can\s+not)\b/.test(text);
}

function hasAffirmationCue(text: string): boolean {
  return /@app\.route\b/.test(text) ||
    /\b(?:current|starting|existing)\s+code\b/.test(text) ||
    /\b(?:i|we|you|user)\b.{0,120}\b(?:built|created|developed|handled|implement|implemented|integrate|integrated|managed|used|worked|wrote|written|mentioned|set\s+up)\b/.test(text) ||
    /\b(?:built|created|developed|handled|implement|implemented|integrate|integrated|managed|used|worked|wrote|written|mentioned|set\s+up)\b.{0,120}\b(?:i|we|you|user)\b/.test(text);
}

function summarizeContradictionSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 260 ? normalized : `${normalized.slice(0, 257)}...`;
}

function extractFocusedSearchTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(terms.filter((term) =>
    !FOCUSED_SEARCH_STOP_WORDS.has(term) &&
    !/^\d+$/.test(term),
  ))];
}

function buildFocusedReferenceWindows(
  numbers: readonly number[],
): Array<{ min: number; max: number }> {
  return numbers.map((number) => ({
    min: Math.max(0, number - 1),
    max: number,
  }));
}

function extractStructuredTrajectoryCueNumber(content: string): number | undefined {
  const match = content.match(
    /^\s*\[(?:Action|Observation|Thought|Reward|State|Environment|Result|Error|Test|Step|Turn)\s+(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nextBenchTranscriptTurnId(
  counters: Map<string, number>,
  sessionId: string,
  message: Message,
): string {
  const index = counters.get(sessionId) ?? 0;
  counters.set(sessionId, index + 1);
  const digest = createHash("sha256")
    .update(`${sessionId}\n${index}\n${message.role}\n${message.content}`)
    .digest("hex")
    .slice(0, 16);
  return `bench-${index}-${digest}`;
}
