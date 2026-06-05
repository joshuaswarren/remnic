import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";
import { getCachedQmdSearch, setCachedQmdSearch } from "./memory-cache.js";
import {
  abortError,
  isAbortError,
  throwIfAborted,
} from "./abort-error.js";
import type { QmdSearchExplain, QmdSearchResult } from "./types.js";
import {
  resolveEnsureCollectionArgs,
  type SearchBackend,
  type SearchExecutionOptions,
  type SearchQueryOptions,
} from "./search/port.js";
import { launchProcess, type CommandChildProcess } from "./runtime/child-process.js";
import { mergeEnv } from "./runtime/env.js";

export interface QmdClientOptions {
  slowLog?: { enabled: boolean; thresholdMs: number };
  updateTimeoutMs?: number;
  updateMinIntervalMs?: number;
  qmdPath?: string;
  daemonUrl?: string;
  daemonRecheckIntervalMs?: number;
  qmdSupportedVersion?: string;
  qmdAutoUpgradeEnabled?: boolean;
  qmdAutoUpgradeCheckIntervalMs?: number;
  qmdChunkStrategy?: QmdChunkStrategy;
  qmdCandidateLimit?: number;
  qmdQueryRerankEnabled?: boolean;
  qmdIndexName?: string;
  qmdForceCpu?: boolean;
  qmdGpuBackend?: "auto" | "metal" | "cuda" | "vulkan" | "false";
  qmdEmbedParallelism?: number;
  qmdEmbedModel?: string;
  qmdRerankModel?: string;
  qmdGenerateModel?: string;
}

export type QmdVersionTuple = [number, number, number];
export type QmdChunkStrategy = "auto" | "regex";
export type QmdStructuredSearchType = "lex" | "vec" | "hyde";
export interface QmdStructuredSearch {
  type: QmdStructuredSearchType;
  query: string;
}

export interface QmdCapabilities {
  version: string | null;
  parsedVersion: QmdVersionTuple | null;
  stableSdk: boolean;
  unifiedSearch: boolean;
  getDocumentBody: boolean;
  maintenanceApi: boolean;
  legacySkillInstall: boolean;
  intentHints: boolean;
  explainTraces: boolean;
  candidateLimit: boolean;
  v2McpQueryTool: boolean;
  structuredSearches: boolean;
  queryRerankToggle: boolean;
  chunkStrategy: boolean;
  qmdBench: boolean;
  perCollectionModels: boolean;
  jsonLineNumbers: boolean;
  editorLinks: boolean;
  doctor: boolean;
  versionedSkills: boolean;
  absoluteSnippetLines: boolean;
  fullQueryOutput: boolean;
  forceCpu: boolean;
  gpuBackendOverride: boolean;
  embedParallelism: boolean;
  modelEnvConsistency: boolean;
  scopedEmbed: boolean;
  safeStatusDeviceProbe: boolean;
  mcpIndexSelection: boolean;
  outputFormatFlag: boolean;
}

export interface QmdVersionStatus {
  installedVersion: string | null;
  supportedVersion: string;
  supported: boolean;
  newerThanSupported: boolean;
  upgradeAvailable: boolean;
  capabilities: QmdCapabilities;
}

export interface QmdDoctorReport {
  available: boolean;
  skipped?: string;
  report?: unknown;
  raw?: string;
  error?: string;
}

const QMD_TIMEOUT_MS = 30_000;
// Daemon timeout for individual search calls. Keep well under RECALL_TIMEOUT_MS (75s) so a
// slow/loading daemon fails fast and the caller can return early rather than hanging.
// After the daemon has loaded its index (~90s for 75K files), actual searches complete in <3s.
// During the loading window, searches will timeout/return [] quickly — this is preferable to
// blocking the full 75s on every recall request.
// Note: keep this ≥ 5s to allow normal searches (post-load) to complete reliably.
const QMD_DAEMON_TIMEOUT_MS = 8_000;
const QMD_PROBE_TIMEOUT_MS = 8_000;
const QMD_UPDATE_BACKOFF_MS = 15 * 60 * 1000; // 15m
const QMD_EMBED_BACKOFF_MS = 60 * 60 * 1000; // 60m
const QMD_CLI_WARN_THROTTLE_MS = 15 * 60 * 1000; // 15m
export const QMD_SUPPORTED_VERSION = "2.5.3";
const QMD_PACKAGE_NAME = "@tobilu/qmd";
const QMD_AUTO_UPGRADE_TIMEOUT_MS = 120_000;
const QMD_AUTO_UPGRADE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const QMD_STRUCTURED_HYDE_MAX_CHARS = 320;
const QMD_FALLBACK_PATHS = [
  path.join(os.homedir(), ".bun", "bin", "qmd"),
  "/usr/local/bin/qmd",
  "/opt/homebrew/bin/qmd",
];
const QMD_GLOBAL_STATE_KEY = "__openclawEngramQmdGlobalState";

type QmdGlobalState = {
  warnedGlobalUpdateBehavior: boolean;
  lastGlobalUpdateRunAtMs: number | null;
  lastGlobalUpdateFailAtMs: number | null;
  lastGlobalEmbedRunAtMs: number | null;
  lastGlobalEmbedFailAtMs: number | null;
  lastCliWarnAtMs: number | null;
  lastUpdateByCollectionMs: Record<string, number>;
  lastUpdateFailByCollectionMs: Record<string, number>;
  lastEmbedByCollectionMs: Record<string, number>;
  lastEmbedFailByCollectionMs: Record<string, number>;
  lastAutoUpgradeCheckAtMs: number | null;
  lastAutoUpgradeStatus: string | null;
  lastAutoUpgradeCheckByTargetMs: Record<string, number>;
  lastAutoUpgradeStatusByTarget: Record<string, string>;
};

type QmdRuntimeEnv = Record<string, string | undefined>;

function getGlobalQmdState(): QmdGlobalState {
  const g = globalThis as any;
  if (!g[QMD_GLOBAL_STATE_KEY]) {
    g[QMD_GLOBAL_STATE_KEY] = {
      warnedGlobalUpdateBehavior: false,
      lastGlobalUpdateRunAtMs: null,
      lastGlobalUpdateFailAtMs: null,
      lastGlobalEmbedRunAtMs: null,
      lastGlobalEmbedFailAtMs: null,
      lastCliWarnAtMs: null,
      lastUpdateByCollectionMs: {},
      lastUpdateFailByCollectionMs: {},
      lastEmbedByCollectionMs: {},
      lastEmbedFailByCollectionMs: {},
      lastAutoUpgradeCheckAtMs: null,
      lastAutoUpgradeStatus: null,
      lastAutoUpgradeCheckByTargetMs: {},
      lastAutoUpgradeStatusByTarget: {},
    } satisfies QmdGlobalState;
  }
  const state = g[QMD_GLOBAL_STATE_KEY] as QmdGlobalState;
  state.lastAutoUpgradeCheckByTargetMs ??= {};
  state.lastAutoUpgradeStatusByTarget ??= {};
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function isCallerCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (isAbortError(err)) return true;
  if (err && typeof err === "object") {
    const code = "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === "ABORT_ERR" || code === "ERR_CANCELED") return true;
  }
  return false;
}

function isDaemonTimeoutError(err: unknown): boolean {
  return /timed out/i.test(errorMessage(err));
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError("operation aborted while waiting"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSqliteBusyError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("sqlite_busy_recovery") ||
    lower.includes("sqliterror: database is locked")
  );
}

function stripControlChars(s: string): string {
  // Remove ANSI escapes and other control characters that explode logs.
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
}

function truncateForLog(s: string, max = 2000): string {
  const cleaned = stripControlChars(s);
  return cleaned.length > max ? cleaned.slice(0, max) + "…(truncated)" : cleaned;
}

function isVectorDimensionMismatchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /dimension mismatch/i.test(msg) ||
    (/vectors?_vec/i.test(msg) && /float\[\d+\]/i.test(msg)) ||
    (/embedding/i.test(msg) && /dimensions?/i.test(msg))
  );
}

export function parseQmdVersion(version: string | null): QmdVersionTuple | null {
  if (!version) return null;
  const match = version.match(/v?(\d{1,10})\.(\d{1,10})\.(\d{1,10})/i);
  if (!match) return null;
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

export function parseQmdVersionOutput(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return null;
  const semanticLines = lines.filter((line) => parseQmdVersion(line) !== null);
  if (semanticLines.length === 0) return lines[0] ?? null;
  return semanticLines.find((line) => /\bqmd\b/i.test(line)) ?? semanticLines[0] ?? null;
}

export function compareQmdVersions(
  left: QmdVersionTuple | null,
  right: QmdVersionTuple | null,
): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) > (right[i] ?? 0)) return 1;
    if ((left[i] ?? 0) < (right[i] ?? 0)) return -1;
  }
  return 0;
}

export function versionAtLeast(
  current: QmdVersionTuple | null,
  target: QmdVersionTuple,
): boolean {
  return compareQmdVersions(current, target) >= 0;
}

export function resolveQmdCapabilities(version: string | null): QmdCapabilities {
  const parsedVersion = parseQmdVersion(version);
  const atLeast = (target: QmdVersionTuple): boolean => versionAtLeast(parsedVersion, target);
  return {
    version,
    parsedVersion,
    stableSdk: atLeast([2, 0, 0]),
    unifiedSearch: atLeast([2, 0, 0]),
    getDocumentBody: atLeast([2, 0, 0]),
    maintenanceApi: atLeast([2, 0, 0]),
    legacySkillInstall: atLeast([2, 0, 1]),
    intentHints: atLeast([1, 1, 5]),
    explainTraces: atLeast([1, 1, 2]),
    candidateLimit: atLeast([1, 1, 2]),
    v2McpQueryTool: atLeast([2, 0, 0]),
    structuredSearches: atLeast([2, 0, 0]),
    queryRerankToggle: atLeast([2, 1, 0]),
    chunkStrategy: atLeast([2, 1, 0]),
    qmdBench: atLeast([2, 1, 0]),
    perCollectionModels: atLeast([2, 1, 0]),
    jsonLineNumbers: atLeast([2, 1, 0]),
    editorLinks: atLeast([2, 1, 0]),
    doctor: atLeast([2, 5, 0]),
    versionedSkills: atLeast([2, 5, 0]),
    absoluteSnippetLines: atLeast([2, 5, 0]),
    fullQueryOutput: atLeast([2, 5, 0]),
    forceCpu: atLeast([2, 5, 0]),
    gpuBackendOverride: atLeast([2, 5, 0]),
    embedParallelism: atLeast([2, 5, 0]),
    modelEnvConsistency: atLeast([2, 5, 0]),
    scopedEmbed: atLeast([2, 5, 0]),
    safeStatusDeviceProbe: atLeast([2, 5, 0]),
    mcpIndexSelection: atLeast([2, 5, 0]),
    outputFormatFlag: atLeast([2, 5, 3]),
  };
}

export function shouldAutoUpgradeQmd(
  installedVersion: string | null,
  supportedVersion: string = QMD_SUPPORTED_VERSION,
): boolean {
  const installed = parseQmdVersion(installedVersion);
  const supported = parseQmdVersion(supportedVersion);
  if (!installed || !supported) return false;
  return compareQmdVersions(installed, supported) < 0;
}

export function getQmdPostInstallProbeTargets(
  qmdPath: string,
  qmdPathSource: "configured" | "auto-path" | "auto-fallback",
): Array<{ qmdPath: string; source: "auto-path" | "auto-fallback" }> {
  const targets: Array<{ qmdPath: string; source: "auto-path" | "auto-fallback" }> = [
    { qmdPath: "qmd", source: "auto-path" },
  ];
  const normalizedPath = qmdPath.trim();
  if (
    qmdPathSource === "auto-fallback" &&
    normalizedPath.length > 0 &&
    normalizedPath !== "qmd"
  ) {
    targets.push({ qmdPath: normalizedPath, source: "auto-fallback" });
  }
  return targets;
}

function qmdVersionToString(version: QmdVersionTuple): string {
  return `${version[0]}.${version[1]}.${version[2]}`;
}

function normalizeSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
  if (!options) return undefined;
  const intent = typeof options.intent === "string" ? options.intent.trim() : "";
  const normalized: SearchQueryOptions = {};
  if (intent.length > 0) {
    normalized.intent = intent;
  }
  if (options.explain === true) {
    normalized.explain = true;
  }
  if (options.rerank === false) {
    normalized.rerank = false;
  }
  if (options.chunkStrategy === "auto" || options.chunkStrategy === "regex") {
    normalized.chunkStrategy = options.chunkStrategy;
  }
  if (
    typeof options.candidateLimit === "number" &&
    Number.isFinite(options.candidateLimit) &&
    options.candidateLimit > 0
  ) {
    normalized.candidateLimit = Math.floor(options.candidateLimit);
  }
  const structuredSearches = normalizeStructuredSearches(options.structuredSearches);
  if (structuredSearches.length > 0) {
    normalized.structuredSearches = structuredSearches;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStructuredSearches(value: unknown): QmdStructuredSearch[] {
  if (!Array.isArray(value)) return [];
  const normalized: QmdStructuredSearch[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; query?: unknown };
    const type = candidate.type;
    const query = typeof candidate.query === "string" ? candidate.query.trim() : "";
    if ((type === "lex" || type === "vec" || type === "hyde") && query.length > 0) {
      normalized.push({ type, query });
    }
    if (normalized.length >= 10) break;
  }
  return normalized;
}

function buildSyntheticHydeQuery(query: string, intent?: string): string {
  const base = intent && intent.trim().length > 0
    ? `A relevant Remnic memory for ${intent.trim()} would answer: ${query.trim()}`
    : `A relevant Remnic memory would answer: ${query.trim()}`;
  return base.length > QMD_STRUCTURED_HYDE_MAX_CHARS
    ? base.slice(0, QMD_STRUCTURED_HYDE_MAX_CHARS)
    : base;
}

function buildDefaultStructuredSearches(
  query: string,
  options?: SearchQueryOptions,
): QmdStructuredSearch[] {
  const explicit = normalizeStructuredSearches(options?.structuredSearches);
  if (explicit.length > 0) return explicit;
  const trimmed = query.trim();
  if (!trimmed) return [];
  return [
    { type: "lex", query: trimmed },
    { type: "vec", query: trimmed },
    { type: "hyde", query: buildSyntheticHydeQuery(trimmed, options?.intent) },
  ];
}

function parseExplainScores(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores = value.filter((entry): entry is number => typeof entry === "number");
  return scores.length > 0 ? scores : undefined;
}

export function parseQmdExplain(value: unknown): QmdSearchExplain | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const rrf =
    typeof candidate.rrf === "number"
      ? candidate.rrf
      : candidate.rrf && typeof candidate.rrf === "object" &&
        typeof (candidate.rrf as Record<string, unknown>).totalScore === "number"
      ? ((candidate.rrf as Record<string, unknown>).totalScore as number)
      : undefined;
  const rrfObj =
    candidate.rrf && typeof candidate.rrf === "object"
      ? (candidate.rrf as Record<string, unknown>)
      : undefined;
  const parsed: QmdSearchExplain = {
    ftsScores: parseExplainScores(candidate.ftsScores),
    vectorScores: parseExplainScores(candidate.vectorScores),
    rrf,
    rrfRank: typeof rrfObj?.rank === "number" ? rrfObj.rank : undefined,
    rrfPositionScore:
      typeof rrfObj?.positionScore === "number" ? rrfObj.positionScore : undefined,
    rrfBaseScore: typeof rrfObj?.baseScore === "number" ? rrfObj.baseScore : undefined,
    rrfTopRankBonus:
      typeof rrfObj?.topRankBonus === "number" ? rrfObj.topRankBonus : undefined,
    rerankScore: typeof candidate.rerankScore === "number" ? candidate.rerankScore : undefined,
    blendedScore: typeof candidate.blendedScore === "number" ? candidate.blendedScore : undefined,
  };
  return Object.values(parsed).some((entry) => entry !== undefined) ? parsed : undefined;
}

class AsyncMutex {
  private locked = false;
  private queue: Array<{
    resolve: (release: () => void) => void;
    reject: (reason: Error) => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (release: () => void) => {
          signal?.removeEventListener("abort", waiter.onAbort);
          resolve(release);
        },
        reject: (reason: Error) => {
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(reason);
        },
        signal,
        onAbort: () => {
          this.queue = this.queue.filter((entry) => entry !== waiter);
          reject(abortError("operation aborted while waiting for qmd mutex"));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.signal?.aborted) {
        next.reject(abortError("operation aborted while waiting for qmd mutex"));
        continue;
      }
      this.locked = true;
      next.resolve(() => this.release());
      return;
    }
    this.locked = false;
  }
}

const QMD_MUTEX = new AsyncMutex();

function runQmd(
  args: string[],
  timeoutMs: number = QMD_TIMEOUT_MS,
  qmdPath: string = "qmd",
  signal?: AbortSignal,
  runtimeEnv?: QmdRuntimeEnv,
): Promise<{ stdout: string; stderr: string }> {
  // Serialize all qmd calls. This avoids SQLite lock contention when multiple
  // channels/agents trigger QMD operations at nearly the same time.
  return QMD_MUTEX.runExclusive(async () => {
    throwIfAborted(signal, `qmd ${args.join(" ")} aborted before start`);
    const maxAttempts = isLikelyWriteCommand(args) ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runQmdOnce(args, timeoutMs, qmdPath, signal, runtimeEnv);
      } catch (err) {
        if (isAbortError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts && isSqliteBusyError(msg)) {
          // Another qmd call (or an external qmd process) currently holds the DB.
          // Back off briefly and retry.
          await sleepWithSignal(1500 * attempt, signal);
          continue;
        }
        throw err;
      }
    }
    // unreachable
    throw new Error("qmd command failed");
  }, signal);
}

function isLikelyWriteCommand(args: string[]): boolean {
  const cmd = getQmdCommandName(args);
  return cmd === "update" || cmd === "embed" || cmd === "cleanup" || cmd === "collection";
}

export function getQmdCommandName(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--index") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--index=")) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return "";
}

function runQmdOnce(
  args: string[],
  timeoutMs: number,
  qmdPath: string,
  signal?: AbortSignal,
  runtimeEnv?: QmdRuntimeEnv,
): Promise<{ stdout: string; stderr: string }> {
  const isVersionCheck = args.length === 1 && args[0] === "--version";
  return runCommandWithTimeout(qmdPath, args, {
    timeoutMs,
    signal,
    env: runtimeEnv,
    label: `qmd ${args.join(" ")}`,
    isSuccessExitCode: (code) => code === 0 || (isVersionCheck && code === 1),
  });
}

function runCommandWithTimeout(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    env?: QmdRuntimeEnv;
    label?: string;
    isSuccessExitCode?: (code: number | null) => boolean;
  },
): Promise<{ stdout: string; stderr: string }> {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  const isSuccessExitCode = options.isSuccessExitCode ?? ((code: number | null) => code === 0);
  return new Promise((resolve, reject) => {
    throwIfAborted(options.signal, `${label} aborted before spawn`);
    const child = launchProcess(command, args, {
      env: mergeEnv({ NO_COLOR: "1", ...options.env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error(`${label} failed to open stdio pipes`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`${label} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      child.kill("SIGKILL");
      reject(abortError(`${label} aborted`));
    };
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (isSuccessExitCode(code)) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${label} failed (code ${code}): ${truncateForLog(stderr || stdout)}`,
          ),
        );
      }
    });
  });
}

function runProcessCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return runCommandWithTimeout(command, args, {
    timeoutMs,
    signal,
  });
}

// ---------------------------------------------------------------------------
// QMD Stdio Daemon Session (MCP over stdio child process)
// ---------------------------------------------------------------------------

let nextJsonRpcId = 1;

class QmdDaemonSession {
  private child: CommandChildProcess | null = null;
  private initialized = false;
  private buffer = "";
  private startPromise: Promise<boolean> | null = null;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  private readonly qmdPath: string;
  private readonly runtimeEnv: QmdRuntimeEnv;
  private readonly indexName?: string;

  constructor(qmdPath: string, runtimeEnv: QmdRuntimeEnv = {}, indexName?: string) {
    this.qmdPath = qmdPath;
    this.runtimeEnv = runtimeEnv;
    this.indexName = indexName?.trim() || undefined;
  }

  /** Spawn the qmd mcp child process and perform MCP handshake. */
  async start(): Promise<boolean> {
    if (this.child && !this.child.killed && this.initialized) {
      return true;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = (async () => {
      // If the process is already running but not yet initialized (e.g. it is still
      // loading its index after a previous handshake timeout), reuse it instead of
      // killing and re-spawning. This prevents accumulating zombie qmd-mcp processes
      // when the daemon takes >15s to load a large collection.
      const processAlreadyRunning = this.child != null && !this.child.killed;
      if (!processAlreadyRunning) {
        if (this.child) {
          this.cleanup({ killChild: true });
        }
        try {
          const args = this.indexName ? ["--index", this.indexName, "mcp"] : ["mcp"];
          const child = launchProcess(this.qmdPath, args, {
            env: mergeEnv({ NO_COLOR: "1", ...this.runtimeEnv }),
            stdio: ["pipe", "pipe", "pipe"],
          });
          this.child = child;
          this.buffer = "";

          child.stdout?.on("data", (data: Buffer) => {
            if (this.child !== child) return;
            this.handleStdoutData(data);
          });
          child.stderr?.on("data", (data: Buffer) => {
            if (this.child !== child) return;
            const msg = data.toString().trim();
            if (msg) log.debug(`QMD mcp stderr: ${stripControlChars(msg)}`);
          });
          child.stdin?.on("error", (err) => {
            // Swallow EPIPE/ERR_STREAM_DESTROYED — these happen when the child
            // process is killed (e.g. due to recall timeout) and a write arrives
            // after the pipe is broken.  Without this handler Node.js would throw
            // an uncaught exception and crash the process.
            log.debug(`QMD mcp stdin error (suppressed): ${err.message}`);
          });
          child.on("error", (err) => {
            if (this.child !== child) return;
            log.debug(`QMD mcp process error: ${err.message}`);
            this.cleanup({ child });
          });
          child.on("close", (code) => {
            if (this.child !== child) return;
            log.debug(`QMD mcp process exited (code ${code})`);
            this.cleanup({ child });
          });
        } catch (err) {
          log.debug(`QMD mcp: failed to spawn process: ${err}`);
          this.cleanup({ killChild: true });
          return false;
        }
      } else {
        log.debug("QMD mcp: process already running, retrying handshake");
      }

      try {
        // Use a generous timeout — large collections (75K+ files) can take 60-90s
        // to load their vector index. We keep the process alive across retries so
        // only one mcp instance is running at a time.
        const result = await this.sendRequest(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openclaw-remnic", version: "1.0.0" },
          },
          60_000,
        );
        if (!result) {
          // Null result (non-timeout failure) — kill and let the next probe respawn.
          this.cleanup({ killChild: true });
          return false;
        }
        this.sendNotification("notifications/initialized");
        this.initialized = true;
        log.info("QMD mcp: stdio session initialized");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out/i.test(msg)) {
          // Handshake timeout — process is still loading. Keep it alive for the
          // next retry (daemonRecheckIntervalMs). Do NOT kill and respawn.
          log.debug(`QMD mcp: handshake timed out — process still loading, will retry later`);
          // Reset initialized flag but leave child running.
          this.initialized = false;
        } else {
          log.debug(`QMD mcp: failed to start stdio session: ${err}`);
          this.cleanup({ killChild: true });
        }
        return false;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  /** Call an MCP tool and return the parsed result. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = 30_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || this.child.killed || !this.initialized) {
      throw new Error("QMD mcp process not running");
    }
    return this.sendRequest("tools/call", { name, arguments: args }, timeoutMs, signal);
  }

  /** Kill stdio process and clear state so the next probe can restart. */
  invalidate(): void {
    this.cleanup({ killChild: true });
  }

  /** Kill stdio process and wait briefly for the child handle to close. */
  async close(timeoutMs = 1_000): Promise<void> {
    const target = this.child;
    if (!target) {
      this.cleanup({ killChild: true });
      return;
    }

    let closed = false;
    const closedPromise = new Promise<void>((resolve) => {
      target.once("close", () => {
        closed = true;
        resolve();
      });
    });

    this.cleanup({ killChild: true });
    await Promise.race([closedPromise, sleep(timeoutMs)]);
    if (!closed) {
      try {
        target.kill("SIGKILL");
      } catch {
        // Ignore process-kill races during shutdown.
      }
      await Promise.race([closedPromise, sleep(250)]);
    }
  }

  isActive(): boolean {
    return this.child !== null && !this.child.killed && this.initialized;
  }

  /** True while the process is spawned but the MCP handshake has not yet completed. */
  isLoading(): boolean {
    return this.child !== null && !this.child.killed && !this.initialized;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal, `QMD mcp ${method} aborted before request`);
      if (!this.child || !this.child.stdin || this.child.killed) {
        reject(new Error("QMD mcp process not available"));
        return;
      }

      const id = nextJsonRpcId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        cleanup();
        reject(new Error(`QMD mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        cleanup();
        reject(abortError(`QMD mcp ${method} aborted`));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      this.pendingRequests.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          cleanup();
          reject(new Error(`Failed to write to QMD mcp stdin: ${err.message}`));
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.killed) return;
    if (this.child.stdin.destroyed) return;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    try {
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // Ignore EPIPE / write-after-close
    }
  }

  private handleStdoutData(data: Buffer): void {
    this.buffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        log.debug(`QMD mcp: unparseable stdout: ${truncateForLog(line, 200)}`);
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id as number);
        pending.cleanup();
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      log.debug(`QMD mcp notification: ${msg.method}`);
    }
  }

  private cleanup(opts?: { killChild?: boolean; child?: CommandChildProcess | null }): void {
    const target = opts?.child ?? this.child;
    if (!target) return;
    if (opts?.child && this.child !== opts.child) {
      return;
    }
    if (opts?.killChild && !target.killed) {
      target.kill("SIGTERM");
    }
    this.initialized = false;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error("QMD mcp process terminated"));
    }
    this.pendingRequests.clear();
    this.startPromise = null;
    this.child = null;
    this.buffer = "";
  }
}

/** Matches `#<hex-docid> <score>% <rest-of-line>` — rest is split in a second pass. */
const QMD_RESULT_LINE_RE = /^#([0-9a-fA-F]+)\s+(\d+)%\s+(.+)/;

/**
 * Splits `collection/path.ext - Title text` into path and title.
 * Non-greedy `.+?` finds the FIRST dot-extension (2+ alphabetic chars)
 * followed by ` - `, accepting any indexed file type while skipping
 * version-like segments (e.g. `v1.2` where `.2` is a single digit).
 */
const QMD_PATH_TITLE_RE = /^(.+?\.[a-zA-Z]{2,10})\s+-\s+(.*)$/;

function parseQmdMarkdownResultText(
  text: string,
  transport: QmdSearchResult["transport"],
): QmdSearchResult[] {
  const results: QmdSearchResult[] = [];
  for (const line of text.split("\n")) {
    const m = QMD_RESULT_LINE_RE.exec(line.trim());
    if (!m) continue;
    const rest = m[3]; // "collection/path.md - Title with - dashes"
    // Find the path by looking for known file extensions followed by " - "
    const pathTitleSplit = QMD_PATH_TITLE_RE.exec(rest);
    if (!pathTitleSplit) continue;
    results.push({
      docid: m[1],
      path: pathTitleSplit[1] ?? "unknown",
      snippet: "",
      score: parseInt(m[2], 10) / 100,
      transport,
    });
  }
  return results;
}

function parseMcpSearchResult(
  result: unknown,
  transport: QmdSearchResult["transport"] = "daemon",
): QmdSearchResult[] {
  const resultObj = result as Record<string, unknown> | null;
  if (!resultObj) return [];
  const results: QmdSearchResult[] = [];
  const pushDocs = (docs: unknown[]) => {
    for (const doc of docs) {
      const d = doc as Record<string, unknown>;
      results.push({
        docid: typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "",
        path: typeof d.file === "string"
          ? d.file
          : typeof d.path === "string"
          ? d.path
          : (typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "unknown"),
        snippet: typeof d.snippet === "string" ? d.snippet : "",
        score: typeof d.score === "number" ? d.score : 0,
        line: typeof d.line === "number" && Number.isFinite(d.line)
          ? Math.max(1, Math.floor(d.line))
          : undefined,
        explain: parseQmdExplain(d.explain),
        transport,
      });
    }
  };
  const topStructured = resultObj.structuredContent as Record<string, unknown> | undefined;
  const topDocs = topStructured?.results ?? topStructured?.documents;
  if (Array.isArray(topDocs)) pushDocs(topDocs);
  const content = resultObj.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const structured = item?.structuredContent;
      const docResults = structured?.results ?? structured?.documents;
      if (Array.isArray(docResults)) pushDocs(docResults);
      if (typeof item?.text === "string") {
        try {
          const parsed = JSON.parse(item.text);
          const textResults = parsed?.results ?? parsed?.documents;
          if (Array.isArray(textResults)) pushDocs(textResults);
        } catch {
          const existingKeys = new Set(results.map((r) => `${r.docid.toLowerCase()}|${r.path}`));
          const parsed = parseQmdMarkdownResultText(item.text, transport);
          for (const p of parsed) {
            const key = `${p.docid.toLowerCase()}|${p.path}`;
            if (!existingKeys.has(key)) {
              results.push(p);
              existingKeys.add(key);
            }
          }
        }
      }
    }
  }
  return results;
}

function parseQmdSearchStdout(
  stdout: string,
  transport: QmdSearchResult["transport"] = "subprocess",
): QmdSearchResult[] {
  const trimmedOut = stdout.trim();
  if (!trimmedOut || trimmedOut === "No results found.") return [];
  const parsed = JSON.parse(trimmedOut);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(
    (entry: Record<string, unknown>): QmdSearchResult => ({
      docid: (entry.docid as string) ?? "",
      path:
        (entry.file as string) ??
        (entry.path as string) ??
        (entry.docid as string) ??
        "unknown",
      snippet: (entry.snippet as string) ?? "",
      score: typeof entry.score === "number" ? entry.score : 0,
      line: typeof entry.line === "number" && Number.isFinite(entry.line)
        ? Math.max(1, Math.floor(entry.line))
        : undefined,
      explain: parseQmdExplain(entry.explain),
      transport,
    }),
  );
}

type SharedDaemonSessionEntry = {
  refs: number;
  session: QmdDaemonSession;
};

const SHARED_DAEMON_SESSIONS = new Map<string, SharedDaemonSessionEntry>();

function stableRuntimeEnvKey(runtimeEnv: QmdRuntimeEnv): string {
  return JSON.stringify(
    Object.keys(runtimeEnv)
      .sort()
      .map((key) => [key, runtimeEnv[key]]),
  );
}

function recordAutoUpgradeStatus(
  state: QmdGlobalState,
  targetKey: string,
  status: string,
): void {
  state.lastAutoUpgradeStatusByTarget[targetKey] = status;
  state.lastAutoUpgradeStatus = status;
}

function retainSharedDaemonSession(
  qmdPath: string,
  runtimeEnv: QmdRuntimeEnv = {},
  indexName?: string,
  cliVersion?: string | null,
): QmdDaemonSession {
  const normalizedPath = qmdPath.trim() || "qmd";
  const normalizedIndex = indexName?.trim() || "";
  const normalizedVersion = cliVersion?.trim() || "";
  const sessionKey = `${normalizedPath}\0${normalizedIndex}\0${normalizedVersion}\0${stableRuntimeEnvKey(runtimeEnv)}`;
  const existing = SHARED_DAEMON_SESSIONS.get(sessionKey);
  if (existing) {
    existing.refs += 1;
    return existing.session;
  }

  const session = new QmdDaemonSession(normalizedPath, runtimeEnv, normalizedIndex || undefined);
  SHARED_DAEMON_SESSIONS.set(sessionKey, {
    refs: 1,
    session,
  });
  return session;
}

async function releaseSharedDaemonSession(session: QmdDaemonSession | null): Promise<void> {
  if (!session) return;

  for (const [qmdPath, entry] of SHARED_DAEMON_SESSIONS.entries()) {
    if (entry.session !== session) continue;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      SHARED_DAEMON_SESSIONS.delete(qmdPath);
      await entry.session.close();
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// QmdClient
// ---------------------------------------------------------------------------

export class QmdClient implements SearchBackend {
  private available: boolean | null = null;
  private _lastUpdateFailAtMs: number | null = null;
  private lastEmbedFailAtMs: number | null = null;
  private lastUpdateRunAtMs: number | null = null;

  get lastUpdateFailedAtMs(): number | null {
    return this._lastUpdateFailAtMs;
  }

  get lastUpdateRanAtMs(): number | null {
    return this.lastUpdateRunAtMs;
  }

  resetUpdateThrottles(): void {
    this._lastUpdateFailAtMs = null;
    this.lastUpdateRunAtMs = null;
    const gs = getGlobalQmdState();
    gs.lastGlobalUpdateRunAtMs = null;
    gs.lastGlobalUpdateFailAtMs = null;
  }

  private readonly updateTimeoutMs: number;
  private readonly updateMinIntervalMs: number;
  private readonly slowLog?: { enabled: boolean; thresholdMs: number };
  private readonly configuredQmdPath?: string;
  private readonly qmdSupportedVersion: string;
  private readonly qmdAutoUpgradeEnabled: boolean;
  private readonly qmdAutoUpgradeCheckIntervalMs: number;
  private readonly qmdChunkStrategy?: QmdChunkStrategy;
  private readonly qmdCandidateLimit?: number;
  private readonly qmdQueryRerankEnabled: boolean;
  private readonly qmdIndexName?: string;
  private readonly qmdRuntimeEnv: QmdRuntimeEnv;
  private qmdPathSource: "auto-path" | "auto-fallback" | "configured" = "auto-path";
  private cliVersion: string | null = null;
  private lastCliProbeError: string | null = null;
  private qmdCapabilities: QmdCapabilities = resolveQmdCapabilities(null);

  // Daemon mode fields
  private daemonSession: QmdDaemonSession | null = null;
  private daemonAvailable = false;
  private daemonSessionPath: string | null = null;
  private lastDaemonCheckAtMs = 0;
  private readonly daemonEnabled: boolean;
  private readonly daemonRecheckIntervalMs: number;
  /** Consecutive transient daemon failures before invalidating the session. */
  private daemonTransientFailures = 0;
  private static readonly DAEMON_MAX_TRANSIENT_FAILURES = 3;

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
    opts?: QmdClientOptions,
  ) {
    this.slowLog = opts?.slowLog;
    this.updateTimeoutMs = opts?.updateTimeoutMs ?? 120_000;
    this.updateMinIntervalMs = Math.max(0, opts?.updateMinIntervalMs ?? 15 * 60_000);
    this.configuredQmdPath = opts?.qmdPath?.trim() ? opts.qmdPath.trim() : undefined;
    this.qmdSupportedVersion =
      parseQmdVersion(opts?.qmdSupportedVersion ?? null) !== null
        ? (opts?.qmdSupportedVersion ?? QMD_SUPPORTED_VERSION)
        : QMD_SUPPORTED_VERSION;
    this.qmdAutoUpgradeEnabled = opts?.qmdAutoUpgradeEnabled === true;
    this.qmdAutoUpgradeCheckIntervalMs = Math.max(
      60_000,
      Math.floor(opts?.qmdAutoUpgradeCheckIntervalMs ?? QMD_AUTO_UPGRADE_CHECK_INTERVAL_MS),
    );
    this.qmdChunkStrategy =
      opts?.qmdChunkStrategy === "auto" || opts?.qmdChunkStrategy === "regex"
        ? opts.qmdChunkStrategy
        : undefined;
    this.qmdCandidateLimit =
      typeof opts?.qmdCandidateLimit === "number" &&
      Number.isFinite(opts.qmdCandidateLimit) &&
      opts.qmdCandidateLimit > 0
        ? Math.floor(opts.qmdCandidateLimit)
        : undefined;
    this.qmdQueryRerankEnabled = opts?.qmdQueryRerankEnabled !== false;
    this.qmdIndexName = opts?.qmdIndexName?.trim() || undefined;
    this.qmdRuntimeEnv = this.buildRuntimeEnv(opts);
    if (this.configuredQmdPath) {
      this.qmdPath = this.configuredQmdPath;
      this.qmdPathSource = "configured";
    }
    this.daemonEnabled = Boolean(opts?.daemonUrl);
    this.daemonRecheckIntervalMs = opts?.daemonRecheckIntervalMs ?? 15_000;
  }

  private qmdPath: string = "qmd";

  private buildRuntimeEnv(opts?: QmdClientOptions): QmdRuntimeEnv {
    const env: QmdRuntimeEnv = {};
    if (opts?.qmdForceCpu === true) {
      env.QMD_FORCE_CPU = "1";
    }
    if (opts?.qmdGpuBackend) {
      env.QMD_LLAMA_GPU = opts.qmdGpuBackend;
    }
    if (
      typeof opts?.qmdEmbedParallelism === "number" &&
      Number.isFinite(opts.qmdEmbedParallelism) &&
      opts.qmdEmbedParallelism > 0
    ) {
      env.QMD_EMBED_PARALLELISM = String(Math.min(8, Math.max(1, Math.floor(opts.qmdEmbedParallelism))));
    }
    if (opts?.qmdEmbedModel?.trim()) {
      env.QMD_EMBED_MODEL = opts.qmdEmbedModel.trim();
    }
    if (opts?.qmdRerankModel?.trim()) {
      env.QMD_RERANK_MODEL = opts.qmdRerankModel.trim();
    }
    if (opts?.qmdGenerateModel?.trim()) {
      env.QMD_GENERATE_MODEL = opts.qmdGenerateModel.trim();
    }
    return env;
  }

  async probe(): Promise<boolean> {
    const cliOk = await this.probeCli();
    if (this.daemonEnabled) {
      await this.probeDaemon();
    }
    return cliOk || this.daemonAvailable;
  }

  private async probeDaemon(): Promise<boolean> {
    this.lastDaemonCheckAtMs = Date.now();
    const normalizedPath = this.qmdPath.trim() || "qmd";
    const daemonIndexName =
      this.qmdIndexName && this.qmdCapabilities.mcpIndexSelection
        ? this.qmdIndexName
        : undefined;
    const daemonSessionPath = `${normalizedPath}\0${daemonIndexName ?? ""}\0${this.cliVersion ?? ""}`;
    if (!this.daemonSession || this.daemonSessionPath !== daemonSessionPath) {
      await releaseSharedDaemonSession(this.daemonSession);
      this.daemonSession = retainSharedDaemonSession(
        normalizedPath,
        this.qmdRuntimeEnv,
        daemonIndexName,
        this.cliVersion,
      );
      this.daemonSessionPath = daemonSessionPath;
    }
    try {
      // Race start() against a short window: if the session is already initialized
      // this returns instantly; if the process is still loading its index we fail
      // fast and let the caller fall back gracefully. The underlying start() promise
      // continues running in the background so the process is NOT killed. On the
      // next recheck cycle (daemonRecheckIntervalMs=15s) start() returns true
      // immediately once the handshake has completed.
      const PROBE_QUICK_TIMEOUT_MS = 3_000;
      const ok = await Promise.race([
        this.daemonSession.start(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), PROBE_QUICK_TIMEOUT_MS)),
      ]);
      if (!ok) {
        const loading = this.daemonSession.isLoading();
        log.debug(`QMD daemon: stdio session not ready within ${PROBE_QUICK_TIMEOUT_MS}ms probe window${loading ? " (still loading)" : ""}`);
        this.daemonAvailable = false;
        return false;
      }
      log.info(`QMD daemon: stdio session active (collection=${this.collection})`);
      this.daemonAvailable = true;
      this.daemonTransientFailures = 0;
      return true;
    } catch (err) {
      log.debug(`QMD daemon: probe failed: ${err}`);
      this.daemonAvailable = false;
      return false;
    }
  }

  private async probeCli(): Promise<boolean> {
    const markProbeFailure = (err: unknown): void => {
      this.lastCliProbeError = err instanceof Error ? err.message : String(err);
    };
    const recordProbeSuccess = async (
      result: { stdout: string; stderr: string },
      qmdPath: string,
      source: typeof this.qmdPathSource,
    ): Promise<void> => {
      this.available = true;
      this.qmdPath = qmdPath;
      this.qmdPathSource = source;
      this.cliVersion = parseQmdVersionOutput(result.stdout, result.stderr);
      this.qmdCapabilities = resolveQmdCapabilities(this.cliVersion);
      this.lastCliProbeError = null;
      await this.maybeAutoUpgradeQmd();
    };

    if (this.configuredQmdPath) {
      try {
        const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, this.configuredQmdPath, undefined, this.qmdRuntimeEnv);
        await recordProbeSuccess(result, this.configuredQmdPath, "configured");
        return true;
      } catch (err) {
        markProbeFailure(err);
        // Do not hard-fail here: fall through to PATH/fallback probing.
        // This keeps recall healthy even when configured path is stale.
        this.logCliProbeWarning(
          `QMD: configured qmdPath failed (${this.configuredQmdPath}): ${this.lastCliProbeError}`,
        );
      }
    }

    // Try PATH first
    try {
      const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, "qmd", undefined, this.qmdRuntimeEnv);
      await recordProbeSuccess(result, "qmd", "auto-path");
      return true;
    } catch (err) {
      markProbeFailure(err);
      // Try fallback paths
      for (const fallbackPath of QMD_FALLBACK_PATHS) {
        try {
          const result = await runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, fallbackPath, undefined, this.qmdRuntimeEnv);
          await recordProbeSuccess(result, fallbackPath, "auto-fallback");
          log.info(`QMD: found at ${fallbackPath}`);
          return true;
        } catch (fallbackErr) {
          markProbeFailure(fallbackErr);
          // Continue to next fallback
        }
      }
      this.available = false;
      return false;
    }
  }

  private async maybeAutoUpgradeQmd(): Promise<void> {
    if (!this.qmdAutoUpgradeEnabled) return;
    const state = getGlobalQmdState();
    const targetKey = this.autoUpgradeTargetKey();
    const now = Date.now();
    const lastCheckAtMs = state.lastAutoUpgradeCheckByTargetMs[targetKey];
    if (
      Number.isFinite(lastCheckAtMs) &&
      now - lastCheckAtMs < this.qmdAutoUpgradeCheckIntervalMs
    ) {
      return;
    }
    state.lastAutoUpgradeCheckByTargetMs[targetKey] = now;
    state.lastAutoUpgradeCheckAtMs = now;

    const installed = parseQmdVersion(this.cliVersion);
    const supported = parseQmdVersion(this.qmdSupportedVersion);
    if (!installed || !supported) {
      const status = `skipped: unable to parse installed=${this.cliVersion ?? "unknown"} supported=${this.qmdSupportedVersion}`;
      recordAutoUpgradeStatus(state, targetKey, status);
      log.warn(`QMD auto-upgrade skipped: ${status}`);
      return;
    }
    if (compareQmdVersions(installed, supported) >= 0) {
      recordAutoUpgradeStatus(
        state,
        targetKey,
        `current: installed=${qmdVersionToString(installed)} supported=${qmdVersionToString(supported)}`,
      );
      return;
    }
    if (this.qmdPathSource === "configured") {
      const status = `skipped: configured qmdPath=${this.qmdPath}`;
      recordAutoUpgradeStatus(state, targetKey, status);
      log.warn(
        `QMD auto-upgrade skipped because qmdPath is explicitly configured (${this.qmdPath}); install ${QMD_PACKAGE_NAME}@${this.qmdSupportedVersion} manually for that path.`,
      );
      return;
    }

    const packageSpec = `${QMD_PACKAGE_NAME}@${this.qmdSupportedVersion}`;
    try {
      log.warn(
        `QMD auto-upgrade: installed=${qmdVersionToString(installed)} supported=${qmdVersionToString(supported)}; running npm install -g ${packageSpec}`,
      );
      await runProcessCommand(
        "npm",
        ["install", "-g", packageSpec],
        QMD_AUTO_UPGRADE_TIMEOUT_MS,
      );
      const postInstall = await this.probePostInstallQmdVersion(supported);
      this.qmdPath = postInstall.qmdPath;
      this.qmdPathSource = postInstall.source;
      this.cliVersion = postInstall.version;
      this.qmdCapabilities = resolveQmdCapabilities(this.cliVersion);
      await releaseSharedDaemonSession(this.daemonSession);
      this.daemonSession = null;
      this.daemonSessionPath = null;
      this.daemonAvailable = false;
      this.daemonTransientFailures = 0;
      const upgraded = parseQmdVersion(this.cliVersion);
      if (!upgraded || compareQmdVersions(upgraded, supported) < 0) {
        const status = `failed: post-install version=${this.cliVersion ?? "unknown"} target=${this.qmdSupportedVersion}`;
        recordAutoUpgradeStatus(state, targetKey, status);
        log.warn(`QMD auto-upgrade did not reach supported version: ${status}`);
        return;
      }
      recordAutoUpgradeStatus(
        state,
        targetKey,
        `upgraded: installed=${this.cliVersion ?? "unknown"} target=${this.qmdSupportedVersion}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordAutoUpgradeStatus(state, targetKey, `failed: ${msg}`);
      log.warn(`QMD auto-upgrade failed: ${msg}`);
    }
  }

  private async probePostInstallQmdVersion(supported: QmdVersionTuple): Promise<{
    qmdPath: string;
    source: "auto-path" | "auto-fallback";
    version: string | null;
  }> {
    let lastErr: unknown;
    let lastResult: { qmdPath: string; source: "auto-path" | "auto-fallback"; version: string | null } | null = null;
    for (const candidate of getQmdPostInstallProbeTargets(this.qmdPath, this.qmdPathSource)) {
      try {
        const result = await runQmd(
          ["--version"],
          QMD_PROBE_TIMEOUT_MS,
          candidate.qmdPath,
          undefined,
          this.qmdRuntimeEnv,
        );
        const postInstall = {
          ...candidate,
          version: parseQmdVersionOutput(result.stdout, result.stderr),
        };
        lastResult = postInstall;
        const parsed = parseQmdVersion(postInstall.version);
        if (parsed && compareQmdVersions(parsed, supported) >= 0) {
          return postInstall;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastResult) return lastResult;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private autoUpgradeTargetKey(): string {
    return JSON.stringify({
      path: this.qmdPath.trim() || "qmd",
      source: this.qmdPathSource,
      index: this.qmdIndexName ?? "",
      supportedVersion: this.qmdSupportedVersion,
      runtimeEnv: stableRuntimeEnvKey(this.qmdRuntimeEnv),
    });
  }

  private logCliProbeWarning(message: string): void {
    const state = getGlobalQmdState();
    const now = Date.now();
    const canWarn =
      state.lastCliWarnAtMs === null || now - state.lastCliWarnAtMs >= QMD_CLI_WARN_THROTTLE_MS;
    if (!canWarn) {
      log.debug(message);
      return;
    }
    state.lastCliWarnAtMs = now;
    if (this.daemonAvailable) {
      // Daemon mode is healthy; keep this as debug noise rather than warning.
      log.debug(message);
      return;
    }
    log.warn(message);
  }

  /** Re-probe daemon if it was down and recheck interval has elapsed. */
  private async maybeProbeDaemon(): Promise<void> {
    if (!this.daemonEnabled) return;
    // If daemon is marked healthy and session is active, nothing to do.
    if (this.daemonAvailable && this.daemonSession?.isActive()) return;
    // If recently checked and failed, respect the recheck interval.
    if (this.daemonAvailable === false) {
      const elapsed = Date.now() - this.lastDaemonCheckAtMs;
      if (elapsed < this.daemonRecheckIntervalMs) return;
    }
    this.daemonAvailable = false;
    await this.probeDaemon();
  }

  isAvailable(): boolean {
    return this.available === true || this.daemonAvailable;
  }

  /** Debug string for troubleshooting availability issues. */
  debugStatus(): string {
    const cliPath = this.available ? this.qmdPath : (this.configuredQmdPath ?? "unavailable");
    const cliVersion = this.cliVersion ?? "unknown";
    const status = this.getVersionStatus();
    const enabledFeatures = Object.entries(status.capabilities)
      .filter(([key, value]) => key !== "version" && key !== "parsedVersion" && value === true)
      .map(([key]) => key)
      .join(",");
    const globalState = getGlobalQmdState();
    const autoUpgradeStatus =
      globalState.lastAutoUpgradeStatusByTarget[this.autoUpgradeTargetKey()] ??
      globalState.lastAutoUpgradeStatus;
    const probeError = this.lastCliProbeError ? ` cliProbeError=${this.lastCliProbeError}` : "";
    return `cli=${this.available} daemon=${this.daemonAvailable} session=${!!this.daemonSession} cliPath=${cliPath} cliPathSource=${this.qmdPathSource} cliVersion=${cliVersion} supportedVersion=${status.supportedVersion} upgradeAvailable=${status.upgradeAvailable} qmdFeatures=${enabledFeatures || "none"}${autoUpgradeStatus ? ` autoUpgrade=${autoUpgradeStatus}` : ""}${probeError}`;
  }

  getVersionStatus(): QmdVersionStatus {
    const installed = parseQmdVersion(this.cliVersion);
    const supported = parseQmdVersion(this.qmdSupportedVersion) ?? parseQmdVersion(QMD_SUPPORTED_VERSION)!;
    const cmp = compareQmdVersions(installed, supported);
    return {
      installedVersion: this.cliVersion,
      supportedVersion: qmdVersionToString(supported),
      supported: installed !== null && cmp >= 0,
      newerThanSupported: installed !== null && cmp > 0,
      upgradeAvailable: installed !== null && cmp < 0,
      capabilities: this.qmdCapabilities,
    };
  }

  async doctor(): Promise<QmdDoctorReport> {
    if (!this.isAvailable()) {
      return { available: false, skipped: "qmd unavailable" };
    }
    if (!this.qmdCapabilities.doctor) {
      return {
        available: false,
        skipped: `qmd doctor requires qmd >=2.5.0; installed ${this.cliVersion ?? "unknown"}`,
      };
    }
    try {
      const { stdout } = await this.runQmdCommand(["doctor", "--json"], QMD_TIMEOUT_MS);
      const trimmed = stdout.trim();
      if (!trimmed) return { available: true, report: null };
      try {
        return { available: true, report: JSON.parse(trimmed) };
      } catch {
        return { available: true, raw: trimmed };
      }
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  isDaemonMode(): boolean {
    return this.daemonAvailable;
  }

  async dispose(): Promise<void> {
    await releaseSharedDaemonSession(this.daemonSession);
    this.daemonSession = null;
    this.daemonSessionPath = null;
    this.daemonAvailable = false;
    this.daemonTransientFailures = 0;
  }

  /**
   * Record a daemon search success — resets the transient failure counter.
   */
  private recordDaemonSuccess(): void {
    this.daemonTransientFailures = 0;
  }

  /**
   * Handle a non-timeout, non-cancellation daemon error.
   * Tolerates up to DAEMON_MAX_TRANSIENT_FAILURES consecutive failures
   * before invalidating the session. This prevents a single transient
   * error from pushing all concurrent searches through the subprocess
   * mutex for the full recheck interval.
   */
  private handleDaemonTransientError(label: string, err: unknown, durationMs: number): void {
    // If daemon was already marked unavailable by a concurrent call, don't
    // increment further — the counter will reset on the next successful probe.
    if (!this.daemonAvailable) {
      log.debug(`QMD daemon ${label} failed after ${durationMs}ms (daemon already unavailable, ignoring): ${err}`);
      return;
    }
    this.daemonTransientFailures += 1;
    if (this.daemonTransientFailures >= QmdClient.DAEMON_MAX_TRANSIENT_FAILURES) {
      log.debug(`QMD daemon ${label} failed after ${durationMs}ms (${this.daemonTransientFailures} consecutive failures, invalidating): ${err}`);
      this.daemonSession?.invalidate();
      this.daemonAvailable = false;
      this.daemonTransientFailures = 0;
    } else {
      log.debug(`QMD daemon ${label} failed after ${durationMs}ms (transient ${this.daemonTransientFailures}/${QmdClient.DAEMON_MAX_TRANSIENT_FAILURES}): ${err}`);
    }
  }

  private async runQmdCommand(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    const commandArgs =
      this.qmdIndexName && this.qmdCapabilities.mcpIndexSelection
        ? ["--index", this.qmdIndexName, ...args]
        : args;
    return runQmd(commandArgs, timeoutMs, this.qmdPath, signal, this.qmdRuntimeEnv);
  }

  private supportsIntentHints(): boolean {
    return this.qmdCapabilities.intentHints;
  }

  private supportsExplainTraces(): boolean {
    return this.qmdCapabilities.explainTraces;
  }

  private supportsCandidateLimit(): boolean {
    return this.qmdCapabilities.candidateLimit;
  }

  private supportsRerankToggle(): boolean {
    return this.qmdCapabilities.queryRerankToggle;
  }

  private supportsChunkStrategy(): boolean {
    return this.qmdCapabilities.chunkStrategy;
  }

  /**
   * QMD v2 (>= 2.0.0) uses a new MCP tool API:
   * - `search` and `vsearch` tools removed; only `query` tool exists
   * - `query` accepts `{ searches: [{ type, query }], collections?: string[] }`
   *   instead of `{ query: string, collection?: string }`
   * - `collection` (singular) → `collections` (plural array)
   */
  private isQmdV2(): boolean {
    return this.qmdCapabilities.v2McpQueryTool;
  }

  private resolveSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
    const normalized = normalizeSearchOptions(options);
    const withDefaults: SearchQueryOptions = { ...(normalized ?? {}) };
    if (this.qmdCandidateLimit !== undefined && withDefaults.candidateLimit === undefined) {
      withDefaults.candidateLimit = this.qmdCandidateLimit;
    }
    if (!this.qmdQueryRerankEnabled && withDefaults.rerank === undefined) {
      withDefaults.rerank = false;
    }
    if (this.qmdChunkStrategy && withDefaults.chunkStrategy === undefined) {
      withDefaults.chunkStrategy = this.qmdChunkStrategy;
    }
    const resolved: SearchQueryOptions = {};
    if (withDefaults.intent && this.supportsIntentHints()) {
      resolved.intent = withDefaults.intent;
    }
    if (withDefaults.explain === true && this.supportsExplainTraces()) {
      resolved.explain = true;
    }
    if (
      typeof withDefaults.candidateLimit === "number" &&
      withDefaults.candidateLimit > 0 &&
      this.supportsCandidateLimit()
    ) {
      resolved.candidateLimit = Math.floor(withDefaults.candidateLimit);
    }
    if (withDefaults.rerank === false && this.supportsRerankToggle()) {
      resolved.rerank = false;
    }
    if (withDefaults.chunkStrategy && this.supportsChunkStrategy()) {
      resolved.chunkStrategy = withDefaults.chunkStrategy;
    }
    if (this.qmdCapabilities.structuredSearches) {
      const structuredSearches = normalizeStructuredSearches(withDefaults.structuredSearches);
      if (structuredSearches.length > 0) {
        resolved.structuredSearches = structuredSearches;
      }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  resolveSupportedSearchOptions(options?: SearchQueryOptions): SearchQueryOptions | undefined {
    return this.resolveSearchOptions(options);
  }

  private addResolvedSearchOptionsToArgs(args: string[], options?: SearchQueryOptions): void {
    if (options?.intent) {
      args.push("--intent", options.intent);
    }
    if (options?.explain === true) {
      args.push("--explain");
    }
    if (typeof options?.candidateLimit === "number" && options.candidateLimit > 0) {
      args.push("--candidate-limit", String(Math.floor(options.candidateLimit)));
    }
    if (options?.rerank === false) {
      args.push("--no-rerank");
    }
    if (options?.chunkStrategy) {
      args.push("--chunk-strategy", options.chunkStrategy);
    }
  }

  private addQmdJsonOutputArgs(args: string[]): void {
    if (this.qmdCapabilities.outputFormatFlag) {
      args.push("--format", "json");
    } else {
      args.push("--json");
    }
  }

  private addResolvedSearchOptionsToMcpArgs(
    args: Record<string, unknown>,
    options?: SearchQueryOptions,
  ): void {
    if (options?.intent) {
      args.intent = options.intent;
    }
    if (options?.explain === true) {
      args.explain = true;
    }
    if (typeof options?.candidateLimit === "number" && options.candidateLimit > 0) {
      args.candidateLimit = Math.floor(options.candidateLimit);
    }
    if (options?.rerank === false) {
      args.rerank = false;
    }
    // QMD MCP query does not expose chunkStrategy even though CLI/SDK
    // search and embed do. Keep chunk strategy on CLI/embed paths only.
  }

  private buildEmbedArgs(collection: string, force = false): string[] {
    const args = ["embed"];
    if (force) args.push("-f");
    args.push("-c", collection);
    if (this.qmdChunkStrategy && this.qmdCapabilities.chunkStrategy) {
      args.push("--chunk-strategy", this.qmdChunkStrategy);
    }
    return args;
  }

  async search(
    query: string,
    collection?: string,
    maxResults?: number,
    options?: SearchQueryOptions,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) return [];

    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;
    const searchOptions = this.resolveSearchOptions(options);

    // Short-lived search result cache — avoids redundant daemon calls for
    // repeated queries within the same recall cycle (e.g., primary + hybrid
    // top-up, or conversation recall using the same collection).
    const optionsFingerprint = searchOptions ? JSON.stringify(searchOptions) : "";
    const cacheKey = createHash("sha256").update(`${col}:${n}:${optionsFingerprint}:${trimmed}`).digest("hex");
    const cached = getCachedQmdSearch(cacheKey);
    if (cached) {
      log.debug(`QMD search cache hit (${cached.length} results)`);
      return cached as QmdSearchResult[];
    }

    // Try daemon first (bypasses QMD_MUTEX — daemon handles its own concurrency)
    if (this.daemonAvailable) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.searchViaDaemon(trimmed, col, n, searchOptions, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon search aborted");
        }
        throw err;
      }
      // When the daemon is available, trust its outcome and skip the subprocess.
      // The subprocess runs `qmd query` (BM25 + LLM expansion) which hangs at
      // 99% CPU on large collections (75K+ files) making it strictly worse than
      // the daemon for this workload. Specifically:
      //   results !== null → daemon succeeded (even with 0 hits) → return as-is
      //   results === null → daemon timed-out or errored → still skip subprocess
      //                      because subprocess will also hang or timeout
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon search returned 0 results; skipping subprocess");
        }
        setCachedQmdSearch(cacheKey, results);
        return results;
      }
      // Daemon timed out or had a transient error — skip subprocess for large
      // collections. Return empty rather than hanging the caller.
      log.debug("QMD daemon search timed out/failed; skipping subprocess (daemon-only mode)");
      return [];
    }

    // If the daemon process is spawned but still loading (handshake not yet complete),
    // skip subprocess — it would add load and block under QMD_MUTEX without helping.
    // Return empty and let the next recheck cycle pick up the daemon once ready.
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD search: daemon loading, skipping subprocess");
      return [];
    }

    // Subprocess fallback (only reached when daemon is unavailable and not loading)
    const subprocessResults = await this.searchViaSubprocess(trimmed, col, n, searchOptions, execution?.signal);
    setCachedQmdSearch(cacheKey, subprocessResults);
    return subprocessResults;
  }

  async searchGlobal(
    query: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) return [];

    const n = maxResults ?? 6;
    const searchOptions = this.resolveSearchOptions();

    // Try daemon first
    if (this.daemonAvailable) {
      // Global search: no collection filter
      let results: QmdSearchResult[] | null;
      try {
        results = await this.searchViaDaemon(trimmed, undefined, n, searchOptions, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon global search aborted");
        }
        throw err;
      }
      // Same rationale as search() — trust daemon outcome, skip subprocess.
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon global search returned 0 results; skipping subprocess");
        }
        return results;
      }
      log.debug("QMD daemon global search timed out/failed; skipping subprocess (daemon-only mode)");
      return [];
    }

    // If the daemon is spawned but still loading, skip subprocess — same as search().
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD searchGlobal: daemon loading, skipping subprocess");
      return [];
    }

    // Subprocess fallback (only reached when daemon is unavailable and not loading)
    return this.searchGlobalViaSubprocess(trimmed, n, searchOptions, execution?.signal);
  }

  /**
   * BM25 keyword search (fast, ~0.3s). Uses `qmd search`.
   */
  async bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    // Try daemon first — BM25 via daemon is much faster than subprocess.
    if (this.daemonAvailable && this.daemonSession) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.bm25SearchViaDaemon(trimmed, col, n, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon bm25 aborted");
        }
        throw err;
      }
      // When daemon is available, trust its outcome and skip subprocess (same
      // rationale as search() — subprocess hangs at 99% CPU on 75K+ files).
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon bm25 returned 0 results; skipping subprocess");
        }
        return results;
      }
      log.debug("QMD daemon bm25 timed out/failed; skipping subprocess (daemon-only mode)");
      return [];
    }
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD bm25: daemon loading, skipping subprocess");
      return [];
    }
    return this.bm25SearchViaSubprocess(trimmed, col, n, execution?.signal);
  }

  /**
   * Vector similarity search (~3-4s). Uses `qmd vsearch`.
   */
  async vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) return [];
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

    // Try daemon first — keeps models warm, avoids cold subprocess loads.
    if (this.daemonAvailable && this.daemonSession) {
      let results: QmdSearchResult[] | null;
      try {
        results = await this.vsearchViaDaemon(trimmed, col, n, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon vsearch aborted");
        }
        throw err;
      }
      // When daemon is available, trust its outcome and skip subprocess (same
      // rationale as search() — subprocess hangs at 99% CPU on 75K+ files).
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon vsearch returned 0 results; skipping subprocess");
        }
        return results;
      }
      log.debug("QMD daemon vsearch timed out/failed; skipping subprocess (daemon-only mode)");
      return [];
    }
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD vsearch: daemon loading, skipping subprocess");
      return [];
    }
    return this.vsearchViaSubprocess(trimmed, col, n, execution?.signal);
  }

  /**
   * Hybrid search: runs BM25 + vector in parallel, merges/dedupes by path
   * keeping the best score and first non-empty snippet.
   */
  async hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions,
  ): Promise<QmdSearchResult[]> {
    const n = maxResults ?? this.maxResults;
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(trimmed, collection, n, execution),
      this.vectorSearch(trimmed, collection, n, execution),
    ]);

    // Merge by path, keeping best score
    const merged = new Map<string, QmdSearchResult>();
    for (const r of [...bm25Results, ...vectorResults]) {
      const key = r.path || r.docid;
      const existing = merged.get(key);
      if (!existing || r.score > existing.score) {
        merged.set(key, {
          ...r,
          snippet: r.snippet || existing?.snippet || "",
        });
      }
    }

    // Sort by score descending, take top N
    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  private async searchViaDaemon(
    query: string,
    collection: string | undefined,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    const v2 = this.isQmdV2();
    try {
      let args: Record<string, unknown>;
      if (v2) {
        // QMD v2: query tool expects { searches: [...], collections?: [...] }
        // The MCP tool is structured-only in 2.x; use lex+vec+hyde by default
        // to exercise QMD's RRF + rerank path and let callers override when
        // they have stronger query-document structure.
        const searches = buildDefaultStructuredSearches(query, options);
        args = { searches, limit: maxResults };
        if (collection) {
          args.collections = [collection];
        }
        this.addResolvedSearchOptionsToMcpArgs(args, options);
      } else {
        // QMD v1: query tool accepts { query, collection?, limit }
        args = { query, limit: maxResults };
        if (collection) {
          args.collection = collection;
        }
        this.addResolvedSearchOptionsToMcpArgs(args, options);
      }

      const result = await this.daemonSession.callTool("query", args, QMD_DAEMON_TIMEOUT_MS, signal);
      const durationMs = Date.now() - startedAtMs;

      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD daemon query: durationMs=${durationMs} collection=${collection ?? "global"} maxResults=${maxResults} queryChars=${query.length} v2=${v2}`,
        );
      }

      const results = parseMcpSearchResult(result, "daemon");

      log.debug(`QMD daemon search: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon search aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon search aborted");
      }
      // Timeout: don't invalidate session — daemon is still running, just slow.
      if (isDaemonTimeoutError(err)) {
        log.debug(`QMD daemon search timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      // Transient error: tolerate a few before invalidating.
      this.handleDaemonTransientError("search", err, durationMs);
      return null;
    }
  }

  private async bm25SearchViaDaemon(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    const v2 = this.isQmdV2();
    try {
      let result: unknown;
      if (v2) {
        // QMD v2: no `search` tool — use `query` with lex-only sub-query
        result = await this.daemonSession.callTool(
          "query",
          {
            searches: [{ type: "lex", query }],
            collections: [collection],
            limit: maxResults,
          },
          QMD_DAEMON_TIMEOUT_MS,
          signal,
        );
      } else {
        // QMD v1: dedicated `search` tool for BM25
        result = await this.daemonSession.callTool(
          "search",
          { query, limit: maxResults, collection },
          QMD_DAEMON_TIMEOUT_MS,
          signal,
        );
      }
      const durationMs = Date.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon bm25: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon bm25 aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon bm25 aborted");
      }
      if (isDaemonTimeoutError(err)) {
        log.debug(`QMD daemon bm25 timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      this.handleDaemonTransientError("bm25", err, durationMs);
      return null;
    }
  }

  private async vsearchViaDaemon(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = Date.now();
    const v2 = this.isQmdV2();
    try {
      let result: unknown;
      if (v2) {
        // QMD v2: no `vsearch` tool — use `query` with vec-only sub-query
        result = await this.daemonSession.callTool(
          "query",
          {
            searches: [{ type: "vec", query }],
            collections: [collection],
            limit: maxResults,
          },
          QMD_DAEMON_TIMEOUT_MS,
          signal,
        );
      } else {
        // QMD v1: dedicated `vsearch` tool for vector search
        result = await this.daemonSession.callTool(
          "vsearch",
          { query, limit: maxResults, collection },
          QMD_DAEMON_TIMEOUT_MS,
          signal,
        );
      }
      const durationMs = Date.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon vsearch: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return results;
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        log.debug(`QMD daemon vsearch aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon vsearch aborted");
      }
      if (isDaemonTimeoutError(err)) {
        log.debug(`QMD daemon vsearch timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      this.handleDaemonTransientError("vsearch", err, durationMs);
      return null;
    }
  }

  private async searchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const args = ["query", query, "-c", collection];
      this.addQmdJsonOutputArgs(args);
      args.push("-n", String(maxResults));
      this.addResolvedSearchOptionsToArgs(args, options);
      const { stdout } = await this.runQmdCommand(args, QMD_TIMEOUT_MS, signal);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD query: durationMs=${durationMs} collection=${collection} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      return parseQmdSearchStdout(stdout, "subprocess");
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess search aborted");
      }
      log.debug(`QMD search failed: ${err}`);
      return [];
    }
  }

  private async bm25SearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const args = ["search", query, "-c", collection];
      this.addQmdJsonOutputArgs(args);
      args.push("-n", String(maxResults));
      const { stdout } = await this.runQmdCommand(args, QMD_TIMEOUT_MS, signal);
      log.debug(`QMD bm25: ${Date.now() - startedAtMs}ms`);
      return parseQmdSearchStdout(stdout);
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess bm25 aborted");
      }
      log.debug(`QMD bm25 search failed: ${err}`);
      return [];
    }
  }

  private async vsearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await this.runQmdCommand(
        ["vsearch", query, "-c", collection, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        signal,
      );
      log.debug(`QMD vsearch: ${Date.now() - startedAtMs}ms`);
      return parseQmdSearchStdout(stdout);
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess vsearch aborted");
      }
      log.debug(`QMD vsearch failed: ${err}`);
      return [];
    }
  }

  private async searchGlobalViaSubprocess(
    query: string,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const args = ["query", query];
      this.addQmdJsonOutputArgs(args);
      args.push("-n", String(maxResults));
      this.addResolvedSearchOptionsToArgs(args, options);
      const { stdout } = await this.runQmdCommand(args, QMD_TIMEOUT_MS, signal);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD global query: durationMs=${durationMs} maxResults=${maxResults} queryChars=${query.length}`,
        );
      }

      return parseQmdSearchStdout(stdout);
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess global search aborted");
      }
      log.debug(`QMD global search failed: ${err}`);
      return [];
    }
  }

  async update(execution?: SearchExecutionOptions): Promise<void> {
    await this.runUpdateForCollection(
      this.collection,
      { perCollectionThrottle: false },
      execution?.signal,
    );
  }

  async updateCollection(
    collection: string,
    execution?: SearchExecutionOptions,
  ): Promise<void> {
    await this.runUpdateForCollection(
      collection,
      { perCollectionThrottle: true },
      execution?.signal,
    );
  }

  async updateCollectionStrict(
    collection: string,
    execution?: SearchExecutionOptions,
  ): Promise<void> {
    await this.runUpdateForCollection(
      collection,
      { perCollectionThrottle: true, strict: true },
      execution?.signal,
    );
  }

  updatesAllCollections(): boolean {
    return true;
  }

  private async runUpdateForCollection(
    collection: string,
    options: { perCollectionThrottle: boolean; strict?: boolean },
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.available === false) {
      if (options.strict) {
        throw new Error("QMD unavailable");
      }
      return;
    }
    const name = collection.trim();
    if (!name) {
      if (options.strict) {
        throw new Error("QMD collection name is required");
      }
      return;
    }
    const globalState = getGlobalQmdState();
    const now = Date.now();
    if (!options.strict && options.perCollectionThrottle) {
      if (
        globalState.lastGlobalUpdateFailAtMs &&
        now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed by global failure backoff");
        return;
      }
      const lastCollectionRun = globalState.lastUpdateByCollectionMs[name];
      if (
        Number.isFinite(lastCollectionRun) &&
        now - lastCollectionRun < this.updateMinIntervalMs
      ) {
        log.debug(`QMD update: suppressed by per-collection min-interval gate (${name})`);
        return;
      }
      const lastCollectionFail = globalState.lastUpdateFailByCollectionMs[name];
      if (
        Number.isFinite(lastCollectionFail) &&
        now - lastCollectionFail < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug(`QMD update: suppressed by per-collection failure backoff (${name})`);
        return;
      }
    } else if (!options.strict) {
      if (
        this.lastUpdateRunAtMs &&
        now - this.lastUpdateRunAtMs < this.updateMinIntervalMs
      ) {
        log.debug("QMD update: suppressed due to min-interval gate");
        return;
      }
      if (
        this._lastUpdateFailAtMs &&
        now - this._lastUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed due to recent failures (backoff)");
        return;
      }
      if (
        globalState.lastGlobalUpdateRunAtMs &&
        now - globalState.lastGlobalUpdateRunAtMs < this.updateMinIntervalMs
      ) {
        log.debug("QMD update: suppressed by global min-interval gate");
        return;
      }
      if (
        globalState.lastGlobalUpdateFailAtMs &&
        now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS
      ) {
        log.debug("QMD update: suppressed by global failure backoff");
        return;
      }
    }
    try {
      if (!globalState.warnedGlobalUpdateBehavior) {
        globalState.warnedGlobalUpdateBehavior = true;
        log.warn(
          "QMD update runs globally across collections in current CLI versions; Engram now rate-limits update calls to reduce gateway load.",
        );
      }
      const startedAtMs = Date.now();
      await this.runQmdCommand(["update", "-c", name], this.updateTimeoutMs, signal);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD update: durationMs=${durationMs}`);
      }
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastUpdateByCollectionMs[name] = at;
        globalState.lastGlobalUpdateRunAtMs = at;
      } else {
        this.lastUpdateRunAtMs = at;
        globalState.lastGlobalUpdateRunAtMs = at;
      }
      log.debug(`QMD update completed for collection=${name}`);
    } catch (err) {
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastUpdateFailByCollectionMs[name] = at;
        globalState.lastGlobalUpdateFailAtMs = at;
      } else {
        this._lastUpdateFailAtMs = at;
        globalState.lastGlobalUpdateFailAtMs = at;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD update failed for collection ${name}: ${msg}`);
      if (options.strict) {
        throw err;
      }
    }
  }

  async embed(): Promise<void> {
    if (this.available === false) return;
    const globalState = getGlobalQmdState();
    if (
      this.lastEmbedFailAtMs &&
      Date.now() - this.lastEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug("QMD embed: suppressed due to recent failures (backoff)");
      return;
    }
    if (
      globalState.lastGlobalEmbedRunAtMs &&
      Date.now() - globalState.lastGlobalEmbedRunAtMs < this.updateMinIntervalMs
    ) {
      log.debug("QMD embed: suppressed by global min-interval gate");
      return;
    }
    if (
      globalState.lastGlobalEmbedFailAtMs &&
      Date.now() - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug("QMD embed: suppressed by global failure backoff");
      return;
    }
    try {
      const startedAtMs = Date.now();
      await this.runQmdCommand(this.buildEmbedArgs(this.collection), 300_000);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD embed: durationMs=${durationMs}`);
      }
      globalState.lastGlobalEmbedRunAtMs = Date.now();
      log.debug("QMD embed completed");
    } catch (err) {
      if (isVectorDimensionMismatchError(err)) {
        try {
          log.warn("QMD embed hit a vector dimension mismatch; retrying with force re-embed");
          await this.runQmdCommand(this.buildEmbedArgs(this.collection, true), 300_000);
          globalState.lastGlobalEmbedRunAtMs = Date.now();
          this.lastEmbedFailAtMs = null;
          globalState.lastGlobalEmbedFailAtMs = null;
          log.warn("QMD embed recovered by forcing a full vector rebuild");
          return;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`QMD force re-embed failed after dimension mismatch: ${retryMsg}`);
        }
      }
      const now = Date.now();
      this.lastEmbedFailAtMs = now;
      globalState.lastGlobalEmbedFailAtMs = now;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD embed failed: ${msg}`);
    }
  }

  async embedCollection(collection: string): Promise<void> {
    if (this.available === false) return;
    const name = collection.trim();
    if (!name) return;
    const globalState = getGlobalQmdState();
    const now = Date.now();
    if (
      globalState.lastGlobalEmbedFailAtMs &&
      now - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug(`QMD embed: suppressed by global failure backoff (${name})`);
      return;
    }
    const lastCollectionRun = globalState.lastEmbedByCollectionMs[name];
    if (
      Number.isFinite(lastCollectionRun) &&
      now - lastCollectionRun < this.updateMinIntervalMs
    ) {
      log.debug(`QMD embed: suppressed by per-collection min-interval gate (${name})`);
      return;
    }
    const lastCollectionFail = globalState.lastEmbedFailByCollectionMs[name];
    if (
      Number.isFinite(lastCollectionFail) &&
      now - lastCollectionFail < QMD_EMBED_BACKOFF_MS
    ) {
      log.debug(`QMD embed: suppressed by per-collection failure backoff (${name})`);
      return;
    }
    try {
      await this.runQmdCommand(this.buildEmbedArgs(name), 300_000);
      const at = Date.now();
      globalState.lastEmbedByCollectionMs[name] = at;
      globalState.lastGlobalEmbedRunAtMs = at;
    } catch (err) {
      if (isVectorDimensionMismatchError(err)) {
        try {
          log.warn(`QMD embed for collection ${name} hit a vector dimension mismatch; retrying with force re-embed`);
          await this.runQmdCommand(this.buildEmbedArgs(name, true), 300_000);
          const recoveredAt = Date.now();
          globalState.lastEmbedByCollectionMs[name] = recoveredAt;
          globalState.lastGlobalEmbedRunAtMs = recoveredAt;
          delete globalState.lastEmbedFailByCollectionMs[name];
          globalState.lastGlobalEmbedFailAtMs = null;
          log.warn(`QMD embed for collection ${name} recovered by forcing a full vector rebuild`);
          return;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`QMD force re-embed failed for collection ${name}: ${retryMsg}`);
        }
      }
      const at = Date.now();
      globalState.lastEmbedFailByCollectionMs[name] = at;
      globalState.lastGlobalEmbedFailAtMs = at;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`QMD embed failed for collection ${name}: ${msg}`);
    }
  }

  async ensureCollection(
    memoryDir: string,
    collectionOrExecution?: string | SearchExecutionOptions,
    execution?: SearchExecutionOptions,
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const { collection, execution: effectiveExecution } = resolveEnsureCollectionArgs(
      collectionOrExecution,
      execution,
    );
    if (this.available === false && !this.daemonAvailable) return "unknown";
    // If only daemon is available (no CLI), skip collection check
    if (this.available === false) return "skipped";
    const targetCollection = collection ?? this.collection;
    try {
      const { stdout } = await this.runQmdCommand(["collection", "list"], QMD_TIMEOUT_MS, effectiveExecution?.signal);
      // Parse text output: "openclaw-engram (qmd://openclaw-engram/)"
      const collectionRegex = new RegExp(
        `^${escapeRegExp(targetCollection)}\\s+\\(qmd://`,
        "m",
      );
      if (collectionRegex.test(stdout)) {
        return "present";
      }
    } catch (err) {
      // Treat command/probe failures as unknown so callers do not disable features
      // permanently after a transient CLI or daemon hiccup.
      log.debug(
        `QMD collection check unavailable for "${targetCollection}" (will not disable features): ${err instanceof Error ? err.message : String(err)}`,
      );
      return "unknown";
    }

    log.info(
      `QMD collection "${targetCollection}" not found. ` +
        `Add it to ~/.config/qmd/index.yml pointing at ${memoryDir}`,
    );
    return "missing";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
