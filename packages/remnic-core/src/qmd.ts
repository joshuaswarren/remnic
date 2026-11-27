import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { abortError, isAbortError, throwIfAborted } from "./abort-error.js";
import { log } from "./logger.js";
import { clearQmdResultCaches, getCachedQmdSearch, setCachedQmdSearch } from "./memory-cache.js";
import { QmdDaemonSession } from "./qmd-daemon-session.js";
import { createInflightJoiner } from "./qmd-mcp-cancel.js";
import {
  QMD_PROBE_RETRY_BACKOFF_MS,
  QMD_PROBE_TIMEOUT_MS,
  QMD_SUPPORTED_VERSION,
  type QmdProbeFailureKind,
  classifyProbeFailure,
  compareQmdVersions,
  getQmdPostInstallProbeTargets,
  parseQmdVersion,
  parseQmdVersionOutput,
  qmdVersionToString,
  resolveQmdCapabilities,
  shouldAutoUpgradeQmd,
  autoUpgradeInstallsStockPackage,
  versionAtLeast,
} from "./qmd-preflight.js";
import { EMPTY_QMD_STATUS, type QmdStatusReport, embedQmdFiles, fetchQmdStatus } from "./qmd-status.js";
import { parseOperationalHealth, qmdHealthResponseSchema, UNKNOWN_OPERATIONAL_HEALTH } from "./qmd-health-metadata.js";
import { type CommandChildProcess, launchProcess } from "./runtime/child-process.js";
import { mergeEnv } from "./runtime/env.js";
import {
  type SearchBackend,
  type SearchDegradation,
  type SearchExecutionOptions,
  type SearchQueryOptions,
  type OperationalSearchHealth,
  resolveEnsureCollectionArgs,
} from "./search/port.js";
import type { QmdSearchExplain, QmdSearchResult } from "./types.js";
// Re-export version-check / probe-preflight helpers (moved to qmd-preflight.ts,
// issue #1841) so existing imports from "./qmd.js" keep resolving.
export {
  compareQmdVersions,
  getQmdPostInstallProbeTargets,
  parseQmdVersion,
  parseQmdVersionOutput,
  QMD_SUPPORTED_VERSION,
  resolveQmdCapabilities,
  shouldAutoUpgradeQmd,
  autoUpgradeInstallsStockPackage,
  versionAtLeast,
};

export interface QmdClientOptions {
  slowLog?: { enabled: boolean; thresholdMs: number };
  updateTimeoutMs?: number;
  updateMinIntervalMs?: number;
  qmdPath?: string;
  daemonUrl?: string;
  qmdStrictPath?: boolean;
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
  /** Daemon search plan; default "hybrid" preserves lex+vec+hyde. Issue #1335. */
  qmdSearchStrategy?: QmdSearchStrategy;
  /** Subprocess fallback command; default "query" keeps LLM expansion. Issue #1335. */
  qmdSubprocessStrategy?: QmdSubprocessStrategy;
  /** Override automatic qmd fallback probes; defaults to known install paths. */
  qmdFallbackPaths?: string[];
  /** Per-call daemon search timeout in ms; default 60000. Issue #1335/#3098. */
  qmdDaemonTimeoutMs?: number;
}

export type QmdVersionTuple = [number, number, number];
export type QmdChunkStrategy = "auto" | "regex";
export type QmdStructuredSearchType = "lex" | "vec" | "hyde";
/**
 * Daemon search plan. Issue #1335.
 * - "hybrid" → lex + vec + hyde (DEFAULT — full recall; runs an embedding pass
 *   plus a HyDE generate pass, which dominates latency on CPU-only models).
 * - "lex-vec" → lex + vec (drops the expensive HyDE generate leg).
 * - "lex" → lex only (BM25; fastest, no model inference).
 */
export type QmdSearchStrategy = "hybrid" | "lex-vec" | "lex";
/**
 * Subprocess fallback command (used only when the daemon is unavailable). Issue #1335.
 * - "query" → `qmd query` (DEFAULT — LLM query expansion + rerank; see CLAUDE.md
 *   gotcha #7, this is intentional and must remain the default).
 * - "search" → `qmd search` (BM25-only; fast, but no expansion/rerank).
 */
export type QmdSubprocessStrategy = "query" | "search";
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

export { parseQmdStatusOutput } from "./qmd-status.js";
export type { QmdStatusReport } from "./qmd-status.js";

const QMD_TIMEOUT_MS = 30_000;
const QMD_DAEMON_TIMEOUT_MS = 60_000;
const QMD_DAEMON_SLOW_QUERY_MS = 10_000;
const QMD_DAEMON_CONGESTION_WINDOW_MS = 60_000;
const QMD_UPDATE_BACKOFF_MS = 15 * 60 * 1000; // 15m
const QMD_EMBED_BACKOFF_MS = 60 * 60 * 1000; // 60m
const QMD_CLI_WARN_THROTTLE_MS = 15 * 60 * 1000; // 15m
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

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
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
  const base =
    intent && intent.trim().length > 0
      ? `A relevant Remnic memory for ${intent.trim()} would answer: ${query.trim()}`
      : `A relevant Remnic memory would answer: ${query.trim()}`;
  return base.length > QMD_STRUCTURED_HYDE_MAX_CHARS ? base.slice(0, QMD_STRUCTURED_HYDE_MAX_CHARS) : base;
}

export function buildDefaultStructuredSearches(
  query: string,
  options?: SearchQueryOptions,
  strategy: QmdSearchStrategy = "hybrid"
): QmdStructuredSearch[] {
  const explicit = normalizeStructuredSearches(options?.structuredSearches);
  if (explicit.length > 0) return explicit;
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lex: QmdStructuredSearch = { type: "lex", query: trimmed };
  if (strategy === "lex") return [lex];
  const vec: QmdStructuredSearch = { type: "vec", query: trimmed };
  if (strategy === "lex-vec") return [lex, vec];
  return [lex, vec, { type: "hyde", query: buildSyntheticHydeQuery(trimmed, options?.intent) }];
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
      : candidate.rrf &&
          typeof candidate.rrf === "object" &&
          typeof (candidate.rrf as Record<string, unknown>).totalScore === "number"
        ? ((candidate.rrf as Record<string, unknown>).totalScore as number)
        : undefined;
  const rrfObj =
    candidate.rrf && typeof candidate.rrf === "object" ? (candidate.rrf as Record<string, unknown>) : undefined;
  const parsed: QmdSearchExplain = {
    ftsScores: parseExplainScores(candidate.ftsScores),
    vectorScores: parseExplainScores(candidate.vectorScores),
    rrf,
    rrfRank: typeof rrfObj?.rank === "number" ? rrfObj.rank : undefined,
    rrfPositionScore: typeof rrfObj?.positionScore === "number" ? rrfObj.positionScore : undefined,
    rrfBaseScore: typeof rrfObj?.baseScore === "number" ? rrfObj.baseScore : undefined,
    rrfTopRankBonus: typeof rrfObj?.topRankBonus === "number" ? rrfObj.topRankBonus : undefined,
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
  qmdPath = "qmd",
  signal?: AbortSignal,
  runtimeEnv?: QmdRuntimeEnv
): Promise<{ stdout: string; stderr: string }> {
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
          await sleepWithSignal(1500 * attempt, signal);
          continue;
        }
        throw err;
      }
    }
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
  runtimeEnv?: QmdRuntimeEnv
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
  }
): Promise<{ stdout: string; stderr: string }> {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  const isSuccessExitCode = options.isSuccessExitCode ?? ((code: number | null) => code === 0);
  return new Promise((resolve, reject) => {
    throwIfAborted(options.signal, `${label} aborted before spawn`);
    const child = launchProcess(command, args, {
      env: mergeEnv({ NO_COLOR: "1", ...options.env }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
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
      killBoundedChild(child);
      reject(
        Object.assign(new Error(`${label} timed out after ${options.timeoutMs}ms`), {
          timedOut: true as const,
        })
      );
    }, options.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      killBoundedChild(child);
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
        reject(new Error(`${label} failed (code ${code}): ${truncateForLog(stderr || stdout)}`));
      }
    });
  });
}

function runProcessCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return runCommandWithTimeout(command, args, {
    timeoutMs,
    signal,
  });
}

// Kill a bounded subprocess and its descendants. On POSIX the child runs
// detached (own process group), so a negative-pid signal reaches the whole
// tree. Fall back to a direct kill on Windows, missing pid, or when the
// group is already gone. Never throws — callers use it on best-effort paths.
function killBoundedChild(child: CommandChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Group already reaped or never became a leader — fall through.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited between the check and the kill.
  }
}

export { runCommandWithTimeout as runCommandWithTimeoutForTest };

/** Matches `#<hex-docid> <score>% <rest-of-line>` — rest is split in a second pass. */
const QMD_RESULT_LINE_RE = /^#([0-9a-fA-F]+)\s+(\d+)%\s+(.+)/;

const QMD_PATH_TITLE_RE = /^(.+?\.[a-zA-Z]{2,10})\s+-\s+(.*)$/;

function parseQmdMarkdownResultText(text: string, transport: QmdSearchResult["transport"]): QmdSearchResult[] {
  const results: QmdSearchResult[] = [];
  for (const line of text.split("\n")) {
    const m = QMD_RESULT_LINE_RE.exec(line.trim());
    if (!m) continue;
    const rest = m[3]; // "collection/path.md - Title with - dashes"
    const pathTitleSplit = QMD_PATH_TITLE_RE.exec(rest);
    if (!pathTitleSplit) continue;
    results.push({
      docid: m[1],
      path: pathTitleSplit[1] ?? "unknown",
      snippet: "",
      score: Number.parseInt(m[2], 10) / 100,
      transport,
    });
  }
  return results;
}

function parseMcpSearchResult(result: unknown, transport: QmdSearchResult["transport"] = "daemon"): QmdSearchResult[] {
  const resultObj = result as Record<string, unknown> | null;
  if (!resultObj) return [];
  const results: QmdSearchResult[] = [];
  const pushDocs = (docs: unknown[]) => {
    for (const doc of docs) {
      const d = doc as Record<string, unknown>;
      results.push({
        docid: typeof d.docid === "string" ? d.docid.replace(/^#/, "") : "",
        path:
          typeof d.file === "string"
            ? d.file
            : typeof d.path === "string"
              ? d.path
              : typeof d.docid === "string"
                ? d.docid.replace(/^#/, "")
                : "unknown",
        snippet: typeof d.snippet === "string" ? d.snippet : "",
        score: typeof d.score === "number" ? d.score : 0,
        line: typeof d.line === "number" && Number.isFinite(d.line) ? Math.max(1, Math.floor(d.line)) : undefined,
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
  transport: QmdSearchResult["transport"] = "subprocess"
): QmdSearchResult[] {
  const trimmedOut = stdout.trim();
  if (!trimmedOut || trimmedOut === "No results found.") return [];
  const parsed = JSON.parse(trimmedOut);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(
    (entry: Record<string, unknown>): QmdSearchResult => ({
      docid: (entry.docid as string) ?? "",
      path: (entry.file as string) ?? (entry.path as string) ?? (entry.docid as string) ?? "unknown",
      snippet: (entry.snippet as string) ?? "",
      score: typeof entry.score === "number" ? entry.score : 0,
      line:
        typeof entry.line === "number" && Number.isFinite(entry.line) ? Math.max(1, Math.floor(entry.line)) : undefined,
      explain: parseQmdExplain(entry.explain),
      transport,
    })
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
      .map((key) => [key, runtimeEnv[key]])
  );
}

function recordAutoUpgradeStatus(state: QmdGlobalState, targetKey: string, status: string): void {
  state.lastAutoUpgradeStatusByTarget[targetKey] = status;
  state.lastAutoUpgradeStatus = status;
}

function retainSharedDaemonSession(
  qmdPath: string,
  runtimeEnv: QmdRuntimeEnv = {},
  indexName?: string,
  cliVersion?: string | null
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

export const sharedDaemonSessionCountForTest = (): number => SHARED_DAEMON_SESSIONS.size;
export { retainSharedDaemonSession as retainSharedDaemonSessionForTest };
export { releaseSharedDaemonSession as releaseSharedDaemonSessionForTest };

const DAEMON_CONGESTED_UNTIL = new WeakMap<QmdDaemonSession, number>();

type DaemonInflightHandle = { since: number };
type DaemonInflightWatch = { settle: () => void };
const DAEMON_INFLIGHT_CALLS = new WeakMap<QmdDaemonSession, DaemonInflightHandle[]>();

export const daemonCongestionForTest = {
  get: (session: QmdDaemonSession): number => DAEMON_CONGESTED_UNTIL.get(session) ?? 0,
  set: (session: QmdDaemonSession, untilMs: number): void => {
    DAEMON_CONGESTED_UNTIL.set(session, untilMs);
  },
  inflightCalls: (session: QmdDaemonSession): number =>
    (DAEMON_INFLIGHT_CALLS.get(session) ?? []).length,
};

type DaemonSearchToolArgs = {
  searches?: { type: string; query: string }[];
  query?: string;
  collections?: string[];
  collection?: string;
  limit: number;
  intent?: string;
  explain?: boolean;
  candidateLimit?: number;
  rerank?: boolean;
};


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
    this.lastEmbedFailAtMs = null;
    const gs = getGlobalQmdState();
    gs.lastGlobalUpdateRunAtMs = null;
    gs.lastGlobalUpdateFailAtMs = null;
    gs.lastGlobalEmbedRunAtMs = null;
    gs.lastGlobalEmbedFailAtMs = null;
    gs.lastEmbedByCollectionMs = {};
    gs.lastEmbedFailByCollectionMs = {};
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
  private readonly qmdSearchStrategy: QmdSearchStrategy;
  private readonly qmdSubprocessStrategy: QmdSubprocessStrategy;
  private readonly qmdFallbackPaths: string[];
  private readonly qmdStrictPath: boolean;
  private readonly daemonTimeoutMs: number;
  private readonly qmdRuntimeEnv: QmdRuntimeEnv;
  private qmdPathSource: "auto-path" | "auto-fallback" | "configured" = "auto-path";
  private cliVersion: string | null = null;
  private lastCliProbeError: string | null = null;
  private qmdCapabilities: QmdCapabilities = resolveQmdCapabilities(null);

  private daemonSession: QmdDaemonSession | null = null;
  private daemonGeneration = 0;
  private readonly daemonSearchJoiner = createInflightJoiner<{
    results: QmdSearchResult[];
    degraded: boolean;
  } | null>();
  private daemonAvailable = false;
  private daemonSessionPath: string | null = null;
  private lastDaemonCheckAtMs = 0;
  private readonly daemonEnabled: boolean;
  private readonly daemonRecheckIntervalMs: number;
  private daemonTransientFailures = 0;
  private shouldDegradeDaemonSearch(): boolean {
    const session = this.daemonSession;
    if (!session) return false;
    const now = performance.now();
    if (now < (DAEMON_CONGESTED_UNTIL.get(session) ?? 0)) return true;
    return (DAEMON_INFLIGHT_CALLS.get(session) ?? []).some(
      (call) => now - call.since >= this.daemonSlowQueryMs,
    );
  }

  private daemonSlowQueryMs = QMD_DAEMON_SLOW_QUERY_MS;
  private daemonCongestionWindowMs = QMD_DAEMON_CONGESTION_WINDOW_MS;
  private static readonly DAEMON_MAX_TRANSIENT_FAILURES = 3;

  constructor(
    private readonly collection: string,
    private readonly maxResults: number,
    opts?: QmdClientOptions
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
      Math.floor(opts?.qmdAutoUpgradeCheckIntervalMs ?? QMD_AUTO_UPGRADE_CHECK_INTERVAL_MS)
    );
    this.qmdChunkStrategy =
      opts?.qmdChunkStrategy === "auto" || opts?.qmdChunkStrategy === "regex" ? opts.qmdChunkStrategy : undefined;
    this.qmdCandidateLimit =
      typeof opts?.qmdCandidateLimit === "number" &&
      Number.isFinite(opts.qmdCandidateLimit) &&
      opts.qmdCandidateLimit > 0
        ? Math.floor(opts.qmdCandidateLimit)
        : undefined;
    this.qmdQueryRerankEnabled = opts?.qmdQueryRerankEnabled !== false;
    this.qmdIndexName = opts?.qmdIndexName?.trim() || undefined;
    this.qmdSearchStrategy =
      opts?.qmdSearchStrategy === "lex" || opts?.qmdSearchStrategy === "lex-vec" ? opts.qmdSearchStrategy : "hybrid";
    this.qmdSubprocessStrategy = opts?.qmdSubprocessStrategy === "search" ? "search" : "query";
    this.qmdFallbackPaths = opts?.qmdFallbackPaths
      ? opts.qmdFallbackPaths.map((candidate) => candidate.trim()).filter(Boolean)
      : QMD_FALLBACK_PATHS;
    this.qmdStrictPath = opts?.qmdStrictPath === true;
    this.daemonTimeoutMs =
      typeof opts?.qmdDaemonTimeoutMs === "number" && Number.isFinite(opts.qmdDaemonTimeoutMs)
        ? Math.max(1_000, Math.floor(opts.qmdDaemonTimeoutMs))
        : QMD_DAEMON_TIMEOUT_MS;
    this.qmdRuntimeEnv = this.buildRuntimeEnv(opts);
    if (this.configuredQmdPath) {
      this.qmdPath = this.configuredQmdPath;
      this.qmdPathSource = "configured";
    }
    this.daemonEnabled = Boolean(opts?.daemonUrl);
    this.daemonRecheckIntervalMs = opts?.daemonRecheckIntervalMs ?? 15_000;
  }

  private qmdPath = "qmd";

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

  async probe(execution?: SearchExecutionOptions): Promise<boolean> {
    if (execution?.signal?.aborted) return false;
    const cliOk = await this.probeCli({ signal: execution?.signal });
    if (execution?.signal?.aborted) return false;
    if (this.daemonEnabled) {
      await this.probeDaemon();
    }
    return cliOk || this.daemonAvailable;
  }

  async checkAvailability(execution?: SearchExecutionOptions): Promise<boolean> {
    const cliAvailable = await this.probeCli({
      allowAutoUpgrade: false,
      preserveStateOnFailure: true,
      signal: execution?.signal,
    });
    if (this.daemonAvailable && this.daemonSession?.isActive()) {
      return true;
    }
    if (this.daemonAvailable) {
      this.daemonAvailable = false;
      this.lastDaemonCheckAtMs = 0;
    }
    return cliAvailable;
  }

  private async probeDaemon(): Promise<boolean> {
    this.lastDaemonCheckAtMs = Date.now();
    const normalizedPath = this.qmdPath.trim() || "qmd";
    const daemonIndexName = this.qmdIndexName && this.qmdCapabilities.mcpIndexSelection ? this.qmdIndexName : undefined;
    const daemonSessionPath = `${normalizedPath}\0${daemonIndexName ?? ""}\0${this.cliVersion ?? ""}`;
    if (!this.daemonSession || this.daemonSessionPath !== daemonSessionPath) {
      this.daemonGeneration++;
      await releaseSharedDaemonSession(this.daemonSession);
      this.daemonSession = retainSharedDaemonSession(
        normalizedPath,
        this.qmdRuntimeEnv,
        daemonIndexName,
        this.cliVersion
      );
      this.daemonSessionPath = daemonSessionPath;
    }
    try {
      const PROBE_QUICK_TIMEOUT_MS = 3_000;
      const ok = await Promise.race([
        this.daemonSession.start(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), PROBE_QUICK_TIMEOUT_MS)),
      ]);
      if (!ok) {
        const loading = this.daemonSession.isLoading();
        log.debug(
          `QMD daemon: stdio session not ready within ${PROBE_QUICK_TIMEOUT_MS}ms probe window${loading ? " (still loading)" : ""}`
        );
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

  private runVersionProbe(qmdPath: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return runQmd(["--version"], QMD_PROBE_TIMEOUT_MS, qmdPath, signal, this.qmdRuntimeEnv);
  }

  private async probeCli(
    options: {
      allowAutoUpgrade?: boolean;
      preserveStateOnFailure?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<boolean> {
    const priorState =
      options.preserveStateOnFailure === true
        ? {
            available: this.available,
            qmdPath: this.qmdPath,
            qmdPathSource: this.qmdPathSource,
            cliVersion: this.cliVersion,
            lastCliProbeError: this.lastCliProbeError,
            qmdCapabilities: this.qmdCapabilities,
          }
        : null;
    const restorePriorState = (): void => {
      if (!priorState) return;
      this.available = priorState.available;
      this.qmdPath = priorState.qmdPath;
      this.qmdPathSource = priorState.qmdPathSource;
      this.cliVersion = priorState.cliVersion;
      this.lastCliProbeError = priorState.lastCliProbeError;
      this.qmdCapabilities = priorState.qmdCapabilities;
    };
    let configuredProbeFailure: string | null = null;
    const markProbeFailure = (err: unknown): void => {
      this.lastCliProbeError = err instanceof Error ? err.message : String(err);
    };
    const restoreConfiguredProbeFailure = (): void => {
      if (!this.configuredQmdPath || !configuredProbeFailure) return;
      this.qmdPath = this.configuredQmdPath;
      this.qmdPathSource = "configured";
      this.lastCliProbeError = configuredProbeFailure;
    };
    const recordProbeSuccess = async (
      result: { stdout: string; stderr: string },
      qmdPath: string,
      source: typeof this.qmdPathSource
    ): Promise<void> => {
      if (options.signal?.aborted) return;
      this.available = true;
      this.qmdPath = qmdPath;
      this.qmdPathSource = source;
      this.cliVersion = parseQmdVersionOutput(result.stdout, result.stderr);
      this.qmdCapabilities = resolveQmdCapabilities(this.cliVersion);
      this.lastCliProbeError = null;
      if (options.allowAutoUpgrade !== false && !options.signal?.aborted) {
        await this.maybeAutoUpgradeQmd(options.signal);
      }
    };

    if (this.configuredQmdPath) {
      const configuredPath = this.configuredQmdPath;
      let failureKind: QmdProbeFailureKind = "other";
      let retries = 0;
      let callerCancelled = false;
      for (let attempt = 0; attempt <= QMD_PROBE_RETRY_BACKOFF_MS.length; attempt += 1) {
        try {
          const result = await this.runVersionProbe(configuredPath, options.signal);
          await recordProbeSuccess(result, configuredPath, "configured");
          return true;
        } catch (err) {
          markProbeFailure(err);
          configuredProbeFailure = this.lastCliProbeError;
          if (isCallerCancellation(err, options.signal)) {
            callerCancelled = true;
            break;
          }
          failureKind = classifyProbeFailure(err);
          if (failureKind === "transient" && attempt < QMD_PROBE_RETRY_BACKOFF_MS.length) {
            try {
              await sleepWithSignal(QMD_PROBE_RETRY_BACKOFF_MS[attempt] ?? 500, options.signal);
            } catch {
              callerCancelled = true;
              break;
            }
            retries += 1;
            continue;
          }
          break;
        }
      }
      if (!callerCancelled) {
        if (failureKind === "transient") {
          this.logCliProbeWarning(
            `QMD: qmdPath ${configuredPath} version check timed out (host may be under load); retried ${retries} time${retries === 1 ? "" : "s"}`
          );
        } else if (failureKind === "missing") {
          this.logCliProbeWarning(
            `QMD: configured qmdPath not found or not executable (${configuredPath}): ${this.lastCliProbeError}`
          );
        } else {
          this.logCliProbeWarning(`QMD: configured qmdPath failed (${configuredPath}): ${this.lastCliProbeError}`);
        }
      }
    }
    if (this.configuredQmdPath && this.qmdStrictPath) {
      if (priorState) {
        restorePriorState();
      } else {
        this.available = false;
        restoreConfiguredProbeFailure();
      }
      return false;
    }

    try {
      const result = await this.runVersionProbe("qmd", options.signal);
      await recordProbeSuccess(result, "qmd", "auto-path");
      return true;
    } catch (err) {
      markProbeFailure(err);
      for (const fallbackPath of this.qmdFallbackPaths) {
        try {
          const result = await this.runVersionProbe(fallbackPath, options.signal);
          await recordProbeSuccess(result, fallbackPath, "auto-fallback");
          log.info(`QMD: found at ${fallbackPath}`);
          return true;
        } catch (fallbackErr) {
          markProbeFailure(fallbackErr);
        }
      }
      if (priorState) {
        restorePriorState();
      } else {
        this.available = false;
        restoreConfiguredProbeFailure();
      }
      return false;
    }
  }

  private async maybeAutoUpgradeQmd(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !this.qmdAutoUpgradeEnabled) return;
    const state = getGlobalQmdState();
    const targetKey = this.autoUpgradeTargetKey();
    const now = Date.now();
    const lastCheckAtMs = state.lastAutoUpgradeCheckByTargetMs[targetKey];
    if (Number.isFinite(lastCheckAtMs) && now - lastCheckAtMs < this.qmdAutoUpgradeCheckIntervalMs) {
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
        `current: installed=${qmdVersionToString(installed)} supported=${qmdVersionToString(supported)}`
      );
      return;
    }
    if (this.qmdPathSource === "configured") {
      const status = `skipped: configured qmdPath=${this.qmdPath}`;
      recordAutoUpgradeStatus(state, targetKey, status);
      log.warn(
        `QMD auto-upgrade skipped because qmdPath is explicitly configured (${this.qmdPath}); install ${QMD_PACKAGE_NAME}@${this.qmdSupportedVersion} manually for that path.`
      );
      return;
    }

    if (!autoUpgradeInstallsStockPackage(this.qmdSupportedVersion)) {
      const status = `skipped: ${this.qmdSupportedVersion} needs the pinned patched build, not stock npm`;
      recordAutoUpgradeStatus(state, targetKey, status);
      log.warn(
        `QMD auto-upgrade skipped: ${QMD_PACKAGE_NAME}@${this.qmdSupportedVersion} from npm lacks the patches Remnic needs and would migrate the index before a backup; follow docs/qmd-2.8.3.md.`
      );
      return;
    }

    if (signal?.aborted) return;
    const packageSpec = `${QMD_PACKAGE_NAME}@${this.qmdSupportedVersion}`;
    try {
      log.warn(
        `QMD auto-upgrade: installed=${qmdVersionToString(installed)} supported=${qmdVersionToString(supported)}; running npm install -g ${packageSpec}`
      );
      await runProcessCommand("npm", ["install", "-g", packageSpec], QMD_AUTO_UPGRADE_TIMEOUT_MS, signal);
      if (signal?.aborted) return;
      const postInstall = await this.probePostInstallQmdVersion(supported, signal);
      if (signal?.aborted) return;
      this.daemonGeneration++;
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
        `upgraded: installed=${this.cliVersion ?? "unknown"} target=${this.qmdSupportedVersion}`
      );
    } catch (err) {
      if (signal?.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      recordAutoUpgradeStatus(state, targetKey, `failed: ${msg}`);
      log.warn(`QMD auto-upgrade failed: ${msg}`);
    }
  }

  private async probePostInstallQmdVersion(
    supported: QmdVersionTuple,
    signal?: AbortSignal,
  ): Promise<{
    qmdPath: string;
    source: "auto-path" | "auto-fallback";
    version: string | null;
  }> {
    let lastErr: unknown;
    let lastResult: { qmdPath: string; source: "auto-path" | "auto-fallback"; version: string | null } | null = null;
    for (const candidate of getQmdPostInstallProbeTargets(this.qmdPath, this.qmdPathSource)) {
      if (signal?.aborted) throw new Error("QMD auto-upgrade post-install probe aborted");
      try {
        const result = await runQmd(
          ["--version"],
          QMD_PROBE_TIMEOUT_MS,
          candidate.qmdPath,
          signal,
          this.qmdRuntimeEnv
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
    const canWarn = state.lastCliWarnAtMs === null || now - state.lastCliWarnAtMs >= QMD_CLI_WARN_THROTTLE_MS;
    if (!canWarn) {
      log.debug(message);
      return;
    }
    state.lastCliWarnAtMs = now;
    if (this.daemonAvailable) {
      log.debug(message);
      return;
    }
    log.warn(message);
  }

  private async maybeProbeDaemon(): Promise<void> {
    if (!this.daemonEnabled) return;
    if (this.daemonAvailable && this.daemonSession?.isActive()) return;
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
      globalState.lastAutoUpgradeStatusByTarget[this.autoUpgradeTargetKey()] ?? globalState.lastAutoUpgradeStatus;
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

  operationalHealthIdentity(): object | null {
    return this.daemonEnabled && this.daemonAvailable
      ? this.daemonSession?.activeProcessIdentity() ?? null : null;
  }

  async readOperationalHealth(
    memoryDir: string,
    execution?: SearchExecutionOptions,
  ): Promise<OperationalSearchHealth | undefined> {
    if (execution?.signal?.aborted) return UNKNOWN_OPERATIONAL_HEALTH;
    const session = this.daemonSession;
    if (!this.daemonEnabled || !this.daemonAvailable || !session?.isActive()) return undefined;
    if (!this.getVersionStatus().supported) return UNKNOWN_OPERATIONAL_HEALTH;
    const processIdentity = session.activeProcessIdentity();
    const generation = this.daemonGeneration;
    const sessionPath = this.daemonSessionPath;
    const binary = this.qmdPath;
    const version = this.cliVersion;
    const index = this.qmdIndexName;
    const collection = this.collection;
    const selectedIndex = index && this.qmdCapabilities.mcpIndexSelection ? index : "";
    const expectedPath = `${binary.trim() || "qmd"}\0${selectedIndex.trim()}\0${version?.trim() ?? ""}`;
    const runtimeEnvKey = stableRuntimeEnvKey(this.qmdRuntimeEnv);
    const ownershipKey = `${expectedPath}\0${runtimeEnvKey}`;
    const owner = SHARED_DAEMON_SESSIONS.get(ownershipKey);
    if (sessionPath !== expectedPath || owner?.session !== session || owner.refs <= 0) {
      return UNKNOWN_OPERATIONAL_HEALTH;
    }
    const capabilities = this.qmdCapabilities;
    const beforeEnv = mergeEnv({ NO_COLOR: "1", ...this.qmdRuntimeEnv });
    const environmentKey = stableRuntimeEnvKey(beforeEnv);
    const beforeCwd = process.cwd();
    const deadline = performance.now() + 5_000;
    const isCurrent = () => {
      try {
        return !execution?.signal?.aborted && performance.now() < deadline &&
          processIdentity !== null && this.daemonGeneration === generation &&
          this.daemonSession === session && this.daemonAvailable &&
          session.activeProcessIdentity() === processIdentity &&
          this.daemonSessionPath === sessionPath && this.qmdPath === binary &&
          this.cliVersion === version && this.qmdCapabilities === capabilities &&
          this.qmdIndexName === index && this.collection === collection &&
          SHARED_DAEMON_SESSIONS.get(ownershipKey) === owner && owner.session === session && owner.refs > 0 &&
          stableRuntimeEnvKey(this.qmdRuntimeEnv) === runtimeEnvKey &&
          stableRuntimeEnvKey(mergeEnv({ NO_COLOR: "1", ...this.qmdRuntimeEnv })) === environmentKey &&
          process.cwd() === beforeCwd;
      } catch {
        return false;
      }
    };
    try {
      const capability = session.getHealthMetadataCapability();
      if (!isCurrent()) return UNKNOWN_OPERATIONAL_HEALTH;
      if (capability === "absent") return undefined;
      if (capability !== "available") return UNKNOWN_OPERATIONAL_HEALTH;
      const result = await session.callTool(
        "status", {}, Math.max(1, deadline - performance.now()), execution?.signal,
      );
      const snapshot = parseOperationalHealth(
        qmdHealthResponseSchema.safeParse(result).data, collection, memoryDir, beforeEnv,
        mergeEnv({ NO_COLOR: "1", ...this.qmdRuntimeEnv }), beforeCwd, process.cwd(),
      );
      return { ...(isCurrent() ? snapshot : UNKNOWN_OPERATIONAL_HEALTH), isCurrent };
    } catch {
      return { ...UNKNOWN_OPERATIONAL_HEALTH, isCurrent };
    }
  }

  async status(): Promise<QmdStatusReport> {
    if (!this.isAvailable()) {
      return { ...EMPTY_QMD_STATUS, error: "qmd unavailable" };
    }
    if (!this.qmdCapabilities.safeStatusDeviceProbe) {
      return { ...EMPTY_QMD_STATUS, error: "qmd status device probe is unsafe for this version" };
    }
    if (!this.getVersionStatus().supported) {
      return { ...EMPTY_QMD_STATUS, error: "qmd version is unsupported" };
    }
    return fetchQmdStatus((args, timeoutMs) => this.runQmdCommand(args, timeoutMs), this.collection, QMD_TIMEOUT_MS);
  }

  async collectionStatus(collection: string): Promise<Pick<QmdStatusReport, "totalFiles">> {
    if (!this.isAvailable() || !this.qmdCapabilities.safeStatusDeviceProbe) {
      return { totalFiles: null };
    }
    const report = await fetchQmdStatus(
      (args, timeoutMs) => this.runQmdCommand(args, timeoutMs),
      collection,
      QMD_TIMEOUT_MS
    );
    return { totalFiles: report.totalFiles };
  }

  isDaemonMode(): boolean {
    return this.daemonAvailable;
  }

  async dispose(): Promise<void> {
    this.daemonGeneration++;
    const session = this.daemonSession;
    this.daemonSession = null;
    this.daemonSessionPath = null;
    this.daemonAvailable = false;
    this.daemonTransientFailures = 0;
    await releaseSharedDaemonSession(session);
  }

  private recordDaemonSuccess(): void {
    this.daemonTransientFailures = 0;
  }

  private markDaemonCongested(durationMs: number, reason: "slow query" | "timeout"): void {
    if (this.daemonSession) {
      DAEMON_CONGESTED_UNTIL.set(this.daemonSession, performance.now() + this.daemonCongestionWindowMs);
    }
    log.info(
      `QMD daemon congested (${reason}, ${durationMs}ms): lex-only searches for ${this.daemonCongestionWindowMs}ms`
    );
  }

  /**
   * Watch one daemon call (#3499): register the call's start time on the
   * session so siblings see an in-flight slow call once it passes the
   * threshold. `settle` removes the handle on success, failure, and
   * cancellation; call it in a `finally`.
   */
  private watchDaemonCall(session: QmdDaemonSession): DaemonInflightWatch {
    const handle: DaemonInflightHandle & DaemonInflightWatch = {
      since: performance.now(),
      settle: () => {
        const live = DAEMON_INFLIGHT_CALLS.get(session);
        const index = live ? live.indexOf(handle) : -1;
        if (live && index >= 0) live.splice(index, 1);
      },
    };
    const calls = DAEMON_INFLIGHT_CALLS.get(session) ?? [];
    calls.push(handle);
    DAEMON_INFLIGHT_CALLS.set(session, calls);
    return handle;
  }

  private handleDaemonTransientError(label: string, err: unknown, durationMs: number): void {
    if (!this.daemonAvailable) {
      log.debug(`QMD daemon ${label} failed after ${durationMs}ms (daemon already unavailable, ignoring): ${err}`);
      return;
    }
    this.daemonTransientFailures += 1;
    if (this.daemonTransientFailures >= QmdClient.DAEMON_MAX_TRANSIENT_FAILURES) {
      log.debug(
        `QMD daemon ${label} failed after ${durationMs}ms (${this.daemonTransientFailures} consecutive failures, invalidating): ${err}`
      );
      this.daemonSession?.invalidate();
      this.daemonAvailable = false;
      this.daemonTransientFailures = 0;
    } else {
      log.debug(
        `QMD daemon ${label} failed after ${durationMs}ms (transient ${this.daemonTransientFailures}/${QmdClient.DAEMON_MAX_TRANSIENT_FAILURES}): ${err}`
      );
    }
  }

  private async runQmdCommand(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    const commandArgs =
      this.qmdIndexName && this.qmdCapabilities.mcpIndexSelection ? ["--index", this.qmdIndexName, ...args] : args;
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

  private addResolvedSearchOptionsToMcpArgs(args: Record<string, unknown>, options?: SearchQueryOptions): void {
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
    execution?: SearchExecutionOptions
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) {
      this.notifyDegradation(execution?.onDegradation, "backend_unavailable");
      return [];
    }

    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;
    const searchOptions = this.resolveSearchOptions(options);

    const optionsFingerprint = searchOptions ? JSON.stringify(searchOptions) : "";
    const strategyFingerprint = `${this.qmdSearchStrategy}:${this.qmdSubprocessStrategy}`;
    const makeCacheKey = (planFingerprint: string) =>
      createHash("sha256")
        .update(`${strategyFingerprint}:${planFingerprint}:${col}:${n}:${optionsFingerprint}:${trimmed}`)
        .digest("hex");
    const degrade = this.daemonAvailable && this.shouldDegradeDaemonSearch();
    const cacheKey = makeCacheKey(degrade ? "deg" : "std");
    const cached = getCachedQmdSearch(cacheKey);
    if (cached) {
      log.debug(`QMD search cache hit (${cached.length} results)`);
      return cached as QmdSearchResult[];
    }

    if (this.daemonAvailable) {
      let outcome: { results: QmdSearchResult[]; degraded: boolean } | null;
      try {
        outcome = await this.daemonSearchJoiner.join(cacheKey, execution?.signal, (sharedSignal) =>
          this.searchViaDaemon(trimmed, col, n, searchOptions, sharedSignal, degrade)
        );
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon search aborted");
        }
        throw err;
      }
      if (outcome !== null) {
        const { results, degraded } = outcome;
        if (results.length === 0) {
          log.debug("QMD daemon search returned 0 results; skipping subprocess");
        }
        setCachedQmdSearch(makeCacheKey(degraded ? "deg" : "std"), results);
        return results;
      }
      log.warn("QMD daemon search timed out/failed; skipping subprocess (daemon-only mode)");
      this.notifyDegradation(execution?.onDegradation, "daemon_timeout");
      return [];
    }

    if (this.daemonSession?.isLoading()) {
      log.debug("QMD search: daemon loading, skipping subprocess");
      this.notifyDegradation(execution?.onDegradation, "daemon_loading");
      return [];
    }

    let subprocessDegraded = false;
    const subprocessResults = await this.searchViaSubprocess(
      trimmed,
      col,
      n,
      searchOptions,
      execution?.signal,
      (degradation) => {
        subprocessDegraded = true;
        this.notifyDegradation(execution?.onDegradation, degradation.code, degradation.detail);
      }
    );
    if (!subprocessDegraded) {
      setCachedQmdSearch(cacheKey, subprocessResults);
    }
    return subprocessResults;
  }

  async searchGlobal(
    query: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) {
      this.notifyDegradation(execution?.onDegradation, "backend_unavailable");
      return [];
    }

    const n = maxResults ?? 6;
    const searchOptions = this.resolveSearchOptions();

    if (this.daemonAvailable) {
      let outcome: { results: QmdSearchResult[]; degraded: boolean } | null;
      try {
        outcome = await this.searchViaDaemon(trimmed, undefined, n, searchOptions, execution?.signal);
      } catch (err) {
        if (isCallerCancellation(err, execution?.signal)) {
          throw isAbortError(err) ? err : abortError("QMD daemon global search aborted");
        }
        throw err;
      }
      if (outcome !== null) {
        if (outcome.results.length === 0) {
          log.debug("QMD daemon global search returned 0 results; skipping subprocess");
        }
        return outcome.results;
      }
      log.warn("QMD daemon global search timed out/failed; skipping subprocess (daemon-only mode)");
      this.notifyDegradation(execution?.onDegradation, "daemon_timeout");
      return [];
    }

    if (this.daemonSession?.isLoading()) {
      log.debug("QMD searchGlobal: daemon loading, skipping subprocess");
      this.notifyDegradation(execution?.onDegradation, "daemon_loading");
      return [];
    }

    return this.searchGlobalViaSubprocess(trimmed, n, searchOptions, execution?.signal, execution?.onDegradation);
  }

  /**
   * BM25 keyword search (fast, ~0.3s). Uses `qmd search`.
   */
  async bm25Search(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) {
      this.notifyDegradation(execution?.onDegradation, "backend_unavailable");
      return [];
    }
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

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
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon bm25 returned 0 results; skipping subprocess");
        }
        return results;
      }
      log.warn("QMD daemon bm25 timed out/failed; skipping subprocess (daemon-only mode)");
      this.notifyDegradation(execution?.onDegradation, "daemon_timeout");
      return [];
    }
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD bm25: daemon loading, skipping subprocess");
      this.notifyDegradation(execution?.onDegradation, "daemon_loading");
      return [];
    }
    return this.bm25SearchViaSubprocess(trimmed, col, n, execution?.signal, execution?.onDegradation);
  }

  /**
   * Vector similarity search (~3-4s). Uses `qmd vsearch`.
   */
  async vectorSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<QmdSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    await this.maybeProbeDaemon();
    if (!this.isAvailable()) {
      this.notifyDegradation(execution?.onDegradation, "backend_unavailable");
      return [];
    }
    const col = collection ?? this.collection;
    const n = maxResults ?? this.maxResults;

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
      if (results !== null) {
        if (results.length === 0) {
          log.debug("QMD daemon vsearch returned 0 results; skipping subprocess");
        }
        return results;
      }
      log.warn("QMD daemon vsearch timed out/failed; skipping subprocess (daemon-only mode)");
      this.notifyDegradation(execution?.onDegradation, "daemon_timeout");
      return [];
    }
    if (this.daemonSession?.isLoading()) {
      log.debug("QMD vsearch: daemon loading, skipping subprocess");
      this.notifyDegradation(execution?.onDegradation, "daemon_loading");
      return [];
    }
    return this.vsearchViaSubprocess(trimmed, col, n, execution?.signal, execution?.onDegradation);
  }

  /**
   * Hybrid search: runs BM25 + vector in parallel, merges/dedupes by path
   * keeping the best score and first non-empty snippet.
   */
  async hybridSearch(
    query: string,
    collection?: string,
    maxResults?: number,
    execution?: SearchExecutionOptions
  ): Promise<QmdSearchResult[]> {
    const n = maxResults ?? this.maxResults;
    const trimmed = query.trim();
    if (!trimmed) return [];

    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25Search(trimmed, collection, n, execution),
      this.vectorSearch(trimmed, collection, n, execution),
    ]);

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

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, n);
  }

  private async searchViaDaemon(
    query: string,
    collection: string | undefined,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
    degrade = this.shouldDegradeDaemonSearch(),
  ): Promise<{ results: QmdSearchResult[]; degraded: boolean } | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    if (degrade) {
      const degraded = await this.bm25SearchViaDaemon(query, collection, maxResults, signal, options);
      return degraded === null ? null : { results: degraded, degraded: true };
    }

    const startedAtMs = performance.now();
    const v2 = this.isQmdV2();
    let watch: DaemonInflightWatch | undefined;
    try {
      let args: Record<string, unknown>;
      let usesModels = true; // The v1 tool chooses its own search legs.
      if (v2) {
        const searches = buildDefaultStructuredSearches(query, options, this.qmdSearchStrategy);
        args = { searches, limit: maxResults };
        if (collection) {
          args.collections = [collection];
        }
        this.addResolvedSearchOptionsToMcpArgs(args, options);
        usesModels = args.rerank !== false || searches.some(({ type }) => type !== "lex");
      } else {
        // QMD v1: query tool accepts { query, collection?, limit }
        args = { query, limit: maxResults };
        if (collection) {
          args.collection = collection;
        }
        this.addResolvedSearchOptionsToMcpArgs(args, options);
      }

      if (usesModels) watch = this.watchDaemonCall(this.daemonSession);
      const result = await this.daemonSession.callTool("query", args, this.daemonTimeoutMs, signal);
      const durationMs = performance.now() - startedAtMs;

      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD daemon query: durationMs=${durationMs} collection=${collection ?? "global"} maxResults=${maxResults} queryChars=${query.length} v2=${v2}`
        );
      }

      const results = parseMcpSearchResult(result, "daemon");

      if (durationMs >= this.daemonSlowQueryMs) {
        this.markDaemonCongested(durationMs, "slow query");
      }

      log.debug(`QMD daemon search: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return { results, degraded: false };
    } catch (err) {
      const durationMs = performance.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        if (durationMs >= this.daemonSlowQueryMs) {
          this.markDaemonCongested(durationMs, "slow query");
        }
        log.debug(`QMD daemon search aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon search aborted");
      }
      if (isDaemonTimeoutError(err)) {
        this.markDaemonCongested(durationMs, "timeout");
        log.debug(`QMD daemon search timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      this.handleDaemonTransientError("search", err, durationMs);
      return null;
    } finally {
      watch?.settle();
    }
  }

  private async bm25SearchViaDaemon(
    query: string,
    collection: string | undefined,
    maxResults: number,
    signal?: AbortSignal,
    options?: SearchQueryOptions
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    const startedAtMs = performance.now();
    const v2 = this.isQmdV2();
    try {
      let result: unknown;
      if (v2) {
        // QMD v2: no `search` tool — use `query` with lex-only sub-query.
        // No `collections` arg means a global (all-collections) search.
        const args: DaemonSearchToolArgs = {
          searches: [{ type: "lex", query }],
          limit: maxResults,
        };
        if (collection) {
          args.collections = [collection];
        }
        this.addResolvedSearchOptionsToMcpArgs(args, options);
        args.rerank = false;
        result = await this.daemonSession.callTool("query", args, this.daemonTimeoutMs, signal);
      } else {
        // QMD v1: dedicated `search` tool for BM25
        const args: DaemonSearchToolArgs = { query, limit: maxResults };
        if (collection) {
          args.collection = collection;
        }
        result = await this.daemonSession.callTool("search", args, this.daemonTimeoutMs, signal);
      }
      const durationMs = performance.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      log.debug(`QMD daemon bm25: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return results;
    } catch (err) {
      const durationMs = performance.now() - startedAtMs;
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
    signal?: AbortSignal
  ): Promise<QmdSearchResult[] | null> {
    if (!this.daemonSession || !this.daemonAvailable) return null;

    if (this.shouldDegradeDaemonSearch()) {
      return this.bm25SearchViaDaemon(query, collection, maxResults, signal);
    }

    const startedAtMs = performance.now();
    const v2 = this.isQmdV2();
    const watch = this.watchDaemonCall(this.daemonSession);
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
          this.daemonTimeoutMs,
          signal
        );
      } else {
        // QMD v1: dedicated `vsearch` tool for vector search
        result = await this.daemonSession.callTool(
          "vsearch",
          { query, limit: maxResults, collection },
          this.daemonTimeoutMs,
          signal
        );
      }
      const durationMs = performance.now() - startedAtMs;
      const results = parseMcpSearchResult(result);
      if (durationMs >= this.daemonSlowQueryMs) {
        this.markDaemonCongested(durationMs, "slow query");
      }
      log.debug(`QMD daemon vsearch: ${results.length} results in ${durationMs}ms (v2=${v2})`);
      this.recordDaemonSuccess();
      return results;
    } catch (err) {
      const durationMs = performance.now() - startedAtMs;
      if (isCallerCancellation(err, signal)) {
        if (durationMs >= this.daemonSlowQueryMs) {
          this.markDaemonCongested(durationMs, "slow query");
        }
        log.debug(`QMD daemon vsearch aborted/cancelled after ${durationMs}ms`);
        throw isAbortError(err) ? err : abortError("QMD daemon vsearch aborted");
      }
      if (isDaemonTimeoutError(err)) {
        this.markDaemonCongested(durationMs, "timeout");
        log.debug(`QMD daemon vsearch timed out after ${durationMs}ms, falling back to subprocess`);
        return null;
      }
      this.handleDaemonTransientError("vsearch", err, durationMs);
      return null;
    } finally {
      watch.settle();
    }
  }

  private notifyDegradation(
    onDegradation: SearchExecutionOptions["onDegradation"],
    code: SearchDegradation["code"],
    detail?: string
  ): void {
    if (!onDegradation) return;
    try {
      onDegradation({ backend: "qmd", code, ...(detail !== undefined ? { detail } : {}) });
    } catch (err) {
      log.debug(`QMD degradation observer threw: ${err}`);
    }
  }

  private degradationDetail(err: unknown, sensitive?: string[]): string {
    let message = String(err instanceof Error ? err.message : err);
    for (const value of sensitive ?? []) {
      if (typeof value !== "string" || value.length === 0) continue;
      message = message.split(value).join("<query>");
      for (const fragment of value.split("\n")) {
        const trimmed = fragment.trim();
        if (trimmed.length >= 4) {
          message = message.split(trimmed).join("<query>");
        }
      }
    }
    const firstLine = message.split("\n")[0] ?? "";
    const redacted = firstLine.replace(/(?:~|\/|[A-Za-z]:\\)[^\s'"`]+/g, "<path>");
    return redacted.length > 160 ? `${redacted.slice(0, 159)}…` : redacted;
  }

  private async searchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
    onDegradation?: SearchExecutionOptions["onDegradation"]
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    if (this.qmdSubprocessStrategy === "search") {
      return this.bm25SearchViaSubprocess(query, collection, maxResults, signal, onDegradation);
    }

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
          `SLOW QMD query: durationMs=${durationMs} collection=${collection} maxResults=${maxResults} queryChars=${query.length}`
        );
      }

      return parseQmdSearchStdout(stdout, "subprocess");
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess search aborted");
      }
      const detail = this.degradationDetail(err, [query]);
      log.warn(`QMD subprocess search failed (returning empty): ${detail}`);
      this.notifyDegradation(onDegradation, "subprocess_error", detail);
      return [];
    }
  }

  private async bm25SearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
    onDegradation?: SearchExecutionOptions["onDegradation"]
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
      const detail = this.degradationDetail(err, [query]);
      log.warn(`QMD bm25 subprocess search failed (returning empty): ${detail}`);
      this.notifyDegradation(onDegradation, "subprocess_error", detail);
      return [];
    }
  }

  private async vsearchViaSubprocess(
    query: string,
    collection: string,
    maxResults: number,
    signal?: AbortSignal,
    onDegradation?: SearchExecutionOptions["onDegradation"]
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];
    const startedAtMs = Date.now();
    try {
      const { stdout } = await this.runQmdCommand(
        ["vsearch", query, "-c", collection, "--json", "-n", String(maxResults)],
        QMD_TIMEOUT_MS,
        signal
      );
      log.debug(`QMD vsearch: ${Date.now() - startedAtMs}ms`);
      return parseQmdSearchStdout(stdout);
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess vsearch aborted");
      }
      const detail = this.degradationDetail(err, [query]);
      log.warn(`QMD vsearch subprocess failed (returning empty): ${detail}`);
      this.notifyDegradation(onDegradation, "subprocess_error", detail);
      return [];
    }
  }

  private async searchGlobalViaSubprocess(
    query: string,
    maxResults: number,
    options?: SearchQueryOptions,
    signal?: AbortSignal,
    onDegradation?: SearchExecutionOptions["onDegradation"]
  ): Promise<QmdSearchResult[]> {
    if (this.available === false) return [];

    const startedAtMs = Date.now();
    try {
      const bm25 = this.qmdSubprocessStrategy === "search";
      const args = bm25 ? ["search", query] : ["query", query];
      this.addQmdJsonOutputArgs(args);
      args.push("-n", String(maxResults));
      if (!bm25) {
        this.addResolvedSearchOptionsToArgs(args, options);
      }
      const { stdout } = await this.runQmdCommand(args, QMD_TIMEOUT_MS, signal);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(
          `SLOW QMD global ${bm25 ? "search" : "query"}: durationMs=${durationMs} maxResults=${maxResults} queryChars=${query.length}`
        );
      }

      return parseQmdSearchStdout(stdout);
    } catch (err) {
      if (isCallerCancellation(err, signal)) {
        throw isAbortError(err) ? err : abortError("QMD subprocess global search aborted");
      }
      const detail = this.degradationDetail(err, [query]);
      log.warn(`QMD global subprocess search failed (returning empty): ${detail}`);
      this.notifyDegradation(onDegradation, "subprocess_error", detail);
      return [];
    }
  }

  async update(execution?: SearchExecutionOptions): Promise<void> {
    await this.runUpdateForCollection(this.collection, { perCollectionThrottle: false }, execution?.signal);
  }

  async updateStrict(execution?: SearchExecutionOptions): Promise<void> {
    await this.runUpdateForCollection(
      this.collection,
      { perCollectionThrottle: false, strict: true },
      execution?.signal
    );
  }

  async updateCollection(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    await this.runUpdateForCollection(collection, { perCollectionThrottle: true }, execution?.signal);
  }

  async updateCollectionStrict(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    await this.runUpdateForCollection(
      collection,
      { perCollectionThrottle: true, strict: true, force: true },
      execution?.signal
    );
  }

  updatesAllCollections(): boolean {
    return true;
  }

  private async runUpdateForCollection(
    collection: string,
    options: { perCollectionThrottle: boolean; strict?: boolean; force?: boolean },
    signal?: AbortSignal
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
    if (!options.force && options.perCollectionThrottle) {
      if (globalState.lastGlobalUpdateFailAtMs && now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS) {
        log.debug("QMD update: suppressed by global failure backoff");
        if (options.strict) throw new Error("QMD update skipped by global failure backoff");
        return;
      }
      const lastCollectionRun = globalState.lastUpdateByCollectionMs[name];
      if (Number.isFinite(lastCollectionRun) && now - lastCollectionRun < this.updateMinIntervalMs) {
        log.debug(`QMD update: suppressed by per-collection min-interval gate (${name})`);
        if (options.strict) throw new Error("QMD update skipped by per-collection min-interval gate");
        return;
      }
      const lastCollectionFail = globalState.lastUpdateFailByCollectionMs[name];
      if (Number.isFinite(lastCollectionFail) && now - lastCollectionFail < QMD_UPDATE_BACKOFF_MS) {
        log.debug(`QMD update: suppressed by per-collection failure backoff (${name})`);
        if (options.strict) throw new Error("QMD update skipped by per-collection failure backoff");
        return;
      }
    } else if (!options.force) {
      if (this.lastUpdateRunAtMs && now - this.lastUpdateRunAtMs < this.updateMinIntervalMs) {
        log.debug("QMD update: suppressed due to min-interval gate");
        if (options.strict) throw new Error("QMD update skipped by min-interval gate");
        return;
      }
      if (this._lastUpdateFailAtMs && now - this._lastUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS) {
        log.debug("QMD update: suppressed due to recent failures (backoff)");
        if (options.strict) throw new Error("QMD update skipped by recent failure backoff");
        return;
      }
      if (globalState.lastGlobalUpdateRunAtMs && now - globalState.lastGlobalUpdateRunAtMs < this.updateMinIntervalMs) {
        log.debug("QMD update: suppressed by global min-interval gate");
        if (options.strict) throw new Error("QMD update skipped by global min-interval gate");
        return;
      }
      if (globalState.lastGlobalUpdateFailAtMs && now - globalState.lastGlobalUpdateFailAtMs < QMD_UPDATE_BACKOFF_MS) {
        log.debug("QMD update: suppressed by global failure backoff");
        if (options.strict) throw new Error("QMD update skipped by global failure backoff");
        return;
      }
    }
    try {
      if (!globalState.warnedGlobalUpdateBehavior) {
        globalState.warnedGlobalUpdateBehavior = true;
        log.warn(
          "QMD update runs globally across collections in current CLI versions; Engram now rate-limits update calls to reduce gateway load."
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
      clearQmdResultCaches();
      log.debug(`QMD update completed for collection=${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/database is locked|SQLITE_BUSY/i.test(msg)) {
        const at = Date.now();
        if (options.perCollectionThrottle) {
          globalState.lastUpdateFailByCollectionMs[name] = at;
          globalState.lastGlobalUpdateFailAtMs = at;
        } else {
          this._lastUpdateFailAtMs = at;
          globalState.lastGlobalUpdateFailAtMs = at;
        }
      }
      log.warn(`QMD update failed for collection ${name}: ${msg}`);
      if (options.strict) {
        throw err;
      }
    }
  }

  async embed(): Promise<void> {
    await this.runEmbedForCollection(this.collection, { perCollectionThrottle: false });
  }

  async embedStrict(): Promise<void> {
    await this.runEmbedForCollection(this.collection, { perCollectionThrottle: false, strict: true });
  }

  async embedCollection(collection: string): Promise<void> {
    await this.runEmbedForCollection(collection, { perCollectionThrottle: true });
  }

  async embedCollectionStrict(collection: string): Promise<void> {
    await this.runEmbedForCollection(collection, { perCollectionThrottle: true, strict: true });
  }

  async embedFiles(filePaths: string[]): Promise<boolean> {
    if (this.available === false || filePaths.length === 0) {
      return false;
    }
    const result = await embedQmdFiles(
      (args, timeoutMs) => this.runQmdCommand(args, timeoutMs),
      this.collection,
      filePaths,
      300_000,
      this.buildEmbedArgs(this.collection)
    );
    if (result.ok) clearQmdResultCaches();
    return result.ok;
  }

  private async runEmbedForCollection(
    collection: string,
    options: { perCollectionThrottle: boolean; strict?: boolean }
  ): Promise<void> {
    if (this.available === false) {
      if (options.strict) throw new Error("QMD unavailable");
      return;
    }
    const name = collection.trim();
    if (!name) {
      if (options.strict) throw new Error("QMD collection name is required");
      return;
    }
    const globalState = getGlobalQmdState();
    const now = Date.now();
    if (options.perCollectionThrottle) {
      if (globalState.lastGlobalEmbedFailAtMs && now - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS) {
        log.debug(`QMD embed: suppressed by global failure backoff (${name})`);
        if (options.strict) throw new Error("QMD embed skipped by global failure backoff");
        return;
      }
      const lastCollectionRun = globalState.lastEmbedByCollectionMs[name];
      if (Number.isFinite(lastCollectionRun) && now - lastCollectionRun < this.updateMinIntervalMs) {
        log.debug(`QMD embed: suppressed by per-collection min-interval gate (${name})`);
        if (options.strict) throw new Error("QMD embed skipped by per-collection min-interval gate");
        return;
      }
      const lastCollectionFail = globalState.lastEmbedFailByCollectionMs[name];
      if (Number.isFinite(lastCollectionFail) && now - lastCollectionFail < QMD_EMBED_BACKOFF_MS) {
        log.debug(`QMD embed: suppressed by per-collection failure backoff (${name})`);
        if (options.strict) throw new Error("QMD embed skipped by per-collection failure backoff");
        return;
      }
    } else {
      if (this.lastEmbedFailAtMs && now - this.lastEmbedFailAtMs < QMD_EMBED_BACKOFF_MS) {
        log.debug("QMD embed: suppressed due to recent failures (backoff)");
        if (options.strict) throw new Error("QMD embed skipped by recent failure backoff");
        return;
      }
      if (globalState.lastGlobalEmbedRunAtMs && now - globalState.lastGlobalEmbedRunAtMs < this.updateMinIntervalMs) {
        log.debug("QMD embed: suppressed by global min-interval gate");
        if (options.strict) throw new Error("QMD embed skipped by global min-interval gate");
        return;
      }
      if (globalState.lastGlobalEmbedFailAtMs && now - globalState.lastGlobalEmbedFailAtMs < QMD_EMBED_BACKOFF_MS) {
        log.debug("QMD embed: suppressed by global failure backoff");
        if (options.strict) throw new Error("QMD embed skipped by global failure backoff");
        return;
      }
    }
    try {
      const startedAtMs = Date.now();
      await this.runQmdCommand(this.buildEmbedArgs(name), 300_000);
      const durationMs = Date.now() - startedAtMs;
      if (this.slowLog?.enabled && durationMs >= this.slowLog.thresholdMs) {
        log.warn(`SLOW QMD embed: durationMs=${durationMs}`);
      }
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastEmbedByCollectionMs[name] = at;
      }
      globalState.lastGlobalEmbedRunAtMs = at;
      clearQmdResultCaches();
      log.debug(`QMD embed completed for collection=${name}`);
    } catch (err) {
      let failure: unknown = err;
      if (isVectorDimensionMismatchError(err)) {
        try {
          log.warn(`QMD embed for collection ${name} hit a vector dimension mismatch; retrying with force re-embed`);
          await this.runQmdCommand(this.buildEmbedArgs(name, true), 300_000);
          const recoveredAt = Date.now();
          if (options.perCollectionThrottle) {
            globalState.lastEmbedByCollectionMs[name] = recoveredAt;
            delete globalState.lastEmbedFailByCollectionMs[name];
          } else {
            this.lastEmbedFailAtMs = null;
          }
          globalState.lastGlobalEmbedRunAtMs = recoveredAt;
          globalState.lastGlobalEmbedFailAtMs = null;
          clearQmdResultCaches();
          log.warn(`QMD embed for collection ${name} recovered by forcing a full vector rebuild`);
          return;
        } catch (retryErr) {
          failure = retryErr;
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`QMD force re-embed failed for collection ${name}: ${retryMsg}`);
        }
      }
      const at = Date.now();
      if (options.perCollectionThrottle) {
        globalState.lastEmbedFailByCollectionMs[name] = at;
      } else {
        this.lastEmbedFailAtMs = at;
      }
      globalState.lastGlobalEmbedFailAtMs = at;
      const msg = failure instanceof Error ? failure.message : String(failure);
      log.warn(`QMD embed failed for collection ${name}: ${msg}`);
      if (options.strict) {
        throw failure;
      }
    }
  }

  supportsAdditionalCollections(): boolean {
    return true;
  }

  async collectionRoot(collection: string, execution?: SearchExecutionOptions): Promise<string | null> {
    const { stdout } = await this.runQmdCommand(
      ["collection", "show", collection],
      QMD_TIMEOUT_MS,
      execution?.signal
    );
    const match = stdout.match(/^\s*Path:\s*(.+?)\s*$/m);
    return match?.[1]?.trim() || null;
  }

  async excludeCollectionFromGlobalSearch(collection: string, execution?: SearchExecutionOptions): Promise<void> {
    await this.runQmdCommand(["collection", "exclude", collection], QMD_TIMEOUT_MS, execution?.signal);
  }

  async deleteCollection(collection: string, execution?: SearchExecutionOptions): Promise<boolean> {
    if (collection === this.collection) {
      throw new Error("Refusing to delete the primary QMD collection");
    }
    await this.runQmdCommand(["collection", "remove", collection], QMD_TIMEOUT_MS, execution?.signal);
    return true;
  }

  async checkCollection(
    collectionOrExecution?: string | SearchExecutionOptions,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const { collection, execution: effectiveExecution } = resolveEnsureCollectionArgs(collectionOrExecution, execution);
    if (this.available === false && !this.daemonAvailable) return "unknown";
    if (this.available === false) return "skipped";
    const targetCollection = collection ?? this.collection;
    try {
      const { stdout } = await this.runQmdCommand(["collection", "list"], QMD_TIMEOUT_MS, effectiveExecution?.signal);
      const collectionRegex = new RegExp(`^${escapeRegExp(targetCollection)}\\s+\\(qmd://`, "m");
      if (collectionRegex.test(stdout)) {
        return "present";
      }
      return "missing";
    } catch (err) {
      log.debug(
        `QMD collection check unavailable for "${targetCollection}" (will not disable features): ${err instanceof Error ? err.message : String(err)}`
      );
      return "unknown";
    }
  }

  async ensureCollection(
    memoryDir: string,
    collectionOrExecution?: string | SearchExecutionOptions,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const { collection, execution: effectiveExecution } = resolveEnsureCollectionArgs(collectionOrExecution, execution);
    const targetCollection = collection ?? this.collection;
    const collectionState = await this.checkCollection(targetCollection, effectiveExecution);
    if (collectionState !== "missing") return collectionState;

    try {
      await this.runQmdCommand(
        ["collection", "add", memoryDir, "--name", targetCollection],
        QMD_TIMEOUT_MS,
        effectiveExecution?.signal
      );
      log.info(`QMD collection "${targetCollection}" auto-created at ${memoryDir}`);
      return "present";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCallerCancellation(err, effectiveExecution?.signal)) {
        log.debug(
          `QMD collection auto-create for "${targetCollection}" was cancelled; keeping collection state unknown`
        );
        return "unknown";
      }
      const postCreateState = await this.checkCollection(targetCollection, effectiveExecution);
      if (postCreateState === "present") {
        log.info(`QMD collection "${targetCollection}" is present after auto-create failure; continuing`);
        return "present";
      }
      if (/\balready exists\b|\bexists already\b/i.test(msg)) {
        log.info(`QMD collection "${targetCollection}" already exists after concurrent auto-create; continuing`);
        return "present";
      }
      if (postCreateState !== "missing") return postCreateState;
      log.warn(`QMD collection "${targetCollection}" not found and auto-create failed: ${msg}`);
      return "missing";
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
