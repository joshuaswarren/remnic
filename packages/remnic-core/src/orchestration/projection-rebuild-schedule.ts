/**
 * Scheduled rebuild of the root memory projection (issue #2119).
 *
 * The projection (`state/memory-projection.sqlite`) is otherwise rebuild-only
 * (manual CLI / tests), so it goes stale as the lifecycle ledger grows and
 * timeline/browse consumers silently fall back to full-corpus scans. The
 * MaintenanceScheduler fires this alongside ledger compaction on every
 * maintenance request — interval-throttled, single-flighted, never awaited,
 * never throws.
 *
 * The rebuild runs in a forked child so the corpus and lifecycle ledger are
 * not allocated in the daemon heap. An unlocked secure store stays in-process:
 * the key is process-local and is never placed on the child's argv or env.
 * The child is killed on scheduler dispose and on parent exit. If the parent
 * dies without running those hooks, the child sees the IPC channel close and
 * stops before it publishes the projection.
 * When the daemon heap is already above `projectionRebuildHeapUsageLimit`,
 * the job is postponed with the failure backoff instead of starting.
 *
 * `projectionRebuildEnabled` gates it (via the lifecycle capabilities
 * resolver, default true); `projectionRebuildIntervalMs` is the cadence.
 *
 * Skipped when the projection was rebuilt within the interval. The freshness
 * check reads the on-disk `rebuiltAt` meta (not just an in-process timestamp)
 * so a daemon restart or an operator's cron `remnic rebuild-memory-projection`
 * both suppress a redundant rebuild. On a real rebuild it logs the lag it just
 * cured (age of the projection before the rebuild) plus the fresh row counts,
 * so operators can see the projection was drifting. Failures are non-fatal
 * and leave the throttle un-advanced to retry.
 *
 * Scope: the root memoryDir projection — the one `getMemoryTimeline` /
 * browse / current-state serve from `baseDir`. Per-namespace projections are
 * not yet scheduled here (they are still served by their own rebuild paths);
 * the fallback WARN surfaces staleness for any namespace that lags.
 */
import { existsSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import v8 from "node:v8";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { resolveMemoryLifecycleCapabilities } from "../capabilities.js";
import {
  rebuildMemoryProjection,
  type RebuildMemoryProjectionOptions,
} from "../maintenance/rebuild-memory-projection.js";
import { PROJECTION_REBUILD_RUNNER_FLAG } from "../maintenance/rebuild-memory-projection-runner.js";
import { readProjectionRebuiltAt } from "../maintenance/projection-support.js";
import { DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT } from "../projection-rebuild-config.js";
import { fullCorpusHeapPressure, type HeapLimitStatistics } from "./full-corpus-heap-guard.js";

type InjectedStorage = NonNullable<RebuildMemoryProjectionOptions["storage"]>;

export interface ProjectionRebuildScheduleState {
  inFlight: boolean;
  lastRebuildAtMs: number;
  /** Timestamp of the most recent FAILURE; gates a short retry backoff that is
   * separate from the success interval so a transient cause (e.g. a locked
   * secure store) retries promptly once cleared instead of waiting a full
   * interval. */
  lastFailureAtMs: number;
}

export interface ProjectionRebuildForkRequest {
  memoryDir: string;
  defaultNamespace: string;
  now: Date;
}

export interface ProjectionRebuildForkResult {
  currentRows: number;
  timelineRows: number;
  entityMentionRows: number;
}

/** Bounded retry cadence after a failure — short enough to self-heal promptly
 * once a transient cause clears, long enough to keep a persistently-failing
 * rebuild off every maintenance tick. */
const FAILURE_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Floor for a hung child. A short interval must not make this tighter:
 * a large corpus can legitimately run longer than 30 minutes. When the
 * configured interval is longer, the child may use that whole interval. */
const FORK_TIMEOUT_MS = 30 * 60 * 1000;

/** Hang cap for one scheduled fork. At least 30 minutes, otherwise the interval. */
export function projectionRebuildForkTimeoutMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs < FORK_TIMEOUT_MS) return FORK_TIMEOUT_MS;
  return intervalMs;
}

const activeProjectionRebuildChildren = new Set<ChildProcess>();
let parentExitHookInstalled = false;

function rememberProjectionRebuildChild(child: ChildProcess): void {
  activeProjectionRebuildChildren.add(child);
  const forget = () => {
    activeProjectionRebuildChildren.delete(child);
  };
  child.once("exit", forget);
  child.once("error", forget);
  if (!parentExitHookInstalled) {
    parentExitHookInstalled = true;
    process.on("exit", terminateScheduledProjectionRebuilds);
  }
}

/** SIGKILL every scheduled rebuild child. Used on dispose and parent exit. */
export function terminateScheduledProjectionRebuilds(): void {
  for (const child of activeProjectionRebuildChildren) {
    child.kill("SIGKILL");
  }
}

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "NODE_OPTIONS",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "windir",
  "PATHEXT",
  "COMSPEC",
  "NODE_PATH",
] as const;

export function createProjectionRebuildScheduleState(): ProjectionRebuildScheduleState {
  return { inFlight: false, lastRebuildAtMs: 0, lastFailureAtMs: 0 };
}

/**
 * Environment for the rebuild child. Only runtime locators are copied.
 * API keys, tokens, and secure-store unlock material are not passed.
 */
export function projectionRebuildChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function projectionRebuildRunnerPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  const candidates = [
    path.join(dir, "..", "maintenance", "rebuild-memory-projection-runner.ts"),
    path.join(dir, "..", "maintenance", "rebuild-memory-projection-runner.js"),
    path.join(dir, "maintenance", "rebuild-memory-projection-runner.js"),
    path.join(dir, "rebuild-memory-projection-runner.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("projection rebuild runner was not found next to the maintenance bundle");
}

function runnerExecArgv(runnerPath: string): string[] {
  const argv: string[] = [];
  const source = process.execArgv;
  for (let index = 0; index < source.length; index += 1) {
    const arg = source[index] ?? "";
    if (arg === "--inspect" || arg === "--inspect-brk" || arg === "--inspect-port") {
      if (arg === "--inspect-port") index += 1;
      continue;
    }
    if (arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk=") || arg.startsWith("--inspect-port=")) {
      continue;
    }
    argv.push(arg);
  }
  if (runnerPath.endsWith(".ts") && !argv.some((arg) => arg === "tsx" || arg.includes(`${path.sep}tsx`))) {
    argv.unshift("--import", "tsx");
  }
  return argv;
}

function isRunnerSuccess(message: unknown): message is ProjectionRebuildForkResult & { ok: true } {
  if (!message || typeof message !== "object") return false;
  const row = message as Record<string, unknown>;
  return row.ok === true
    && typeof row.currentRows === "number"
    && typeof row.timelineRows === "number"
    && typeof row.entityMentionRows === "number";
}

/** Fork the projection rebuild. Arguments are path, namespace, and timestamp only. */
export async function forkProjectionRebuild(
  request: ProjectionRebuildForkRequest,
  options?: {
    timeoutMs?: number;
    spawnChild?: () => ChildProcess;
    /** Invoked after exit listeners are attached. Tests use this to disconnect. */
    onChild?: (child: ChildProcess) => void;
  },
): Promise<ProjectionRebuildForkResult> {
  const timeoutMs = options?.timeoutMs ?? FORK_TIMEOUT_MS;
  const child = options?.spawnChild
    ? options.spawnChild()
    : spawnProjectionRebuildChild(request);
  rememberProjectionRebuildChild(child);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error, result?: ProjectionRebuildForkResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else if (result) resolve(result);
      else reject(new Error("projection rebuild runner returned no result"));
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`projection rebuild runner timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("message", (message: unknown) => {
      if (isRunnerSuccess(message)) {
        finish(undefined, message);
        return;
      }
      const error = message && typeof message === "object" && "error" in message
        ? String((message as { error?: unknown }).error ?? "projection rebuild runner failed")
        : "projection rebuild runner failed";
      finish(new Error(error));
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`projection rebuild runner exited ${code ?? "null"}`));
      }
    });
    options?.onChild?.(child);
  });
}

function spawnProjectionRebuildChild(request: ProjectionRebuildForkRequest): ChildProcess {
  const runnerPath = projectionRebuildRunnerPath();
  const nowIso = request.now.toISOString();
  return fork(
    runnerPath,
    [PROJECTION_REBUILD_RUNNER_FLAG, request.memoryDir, request.defaultNamespace, nowIso],
    {
      execArgv: runnerExecArgv(runnerPath),
      env: projectionRebuildChildEnv(process.env),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
}

function storageIsUnlocked(storage: InjectedStorage | undefined): boolean {
  if (!storage || typeof storage.isSecureStoreUnlocked !== "function") return false;
  return storage.isSecureStoreUnlocked();
}

export async function maybeRebuildMemoryProjectionScheduled(opts: {
  config: PluginConfig;
  /** The daemon's live root storage, when available (secure-store unlock). */
  getStorage?: () => InjectedStorage | undefined;
  state: ProjectionRebuildScheduleState;
  /** Test seam. Production forks {@link forkProjectionRebuild}. */
  forkRebuild?: (
    request: ProjectionRebuildForkRequest,
    options?: { timeoutMs?: number },
  ) => Promise<ProjectionRebuildForkResult>;
  /** Test seam. Production reads `v8.getHeapStatistics()`. */
  heapStatistics?: () => HeapLimitStatistics;
}): Promise<void> {
  const { config, state } = opts;
  if (!resolveMemoryLifecycleCapabilities(config).projectionRebuild) return;
  if (state.inFlight) return;
  const intervalMs = config.projectionRebuildIntervalMs;
  const now = Date.now();
  if (now - state.lastRebuildAtMs < intervalMs) return;
  if (now - state.lastFailureAtMs < FAILURE_RETRY_BACKOFF_MS) return;

  const rootStorage = opts.getStorage?.();
  const memoryDir = rootStorage ? rootStorage.dir : config.memoryDir;

  // On-disk freshness check: survives restarts and cross-process CLI rebuilds.
  const rebuiltAt = readProjectionRebuiltAt(memoryDir);
  const rebuiltAtMs = rebuiltAt ? Date.parse(rebuiltAt) : Number.NaN;
  if (Number.isFinite(rebuiltAtMs) && now - rebuiltAtMs < intervalMs) {
    // Fresh already — adopt its timestamp so the next pass short-circuits on
    // the cheap in-process guard without re-opening the projection each time.
    state.lastRebuildAtMs = rebuiltAtMs;
    return;
  }

  const heapLimit = config.projectionRebuildHeapUsageLimit ?? DEFAULT_PROJECTION_REBUILD_HEAP_USAGE_LIMIT;
  const heapStats = (opts.heapStatistics ?? (() => v8.getHeapStatistics()))();
  const pressure = fullCorpusHeapPressure(heapStats, heapLimit);
  if (pressure.postpone) {
    state.lastFailureAtMs = Date.now();
    log.warn(
      `memory projection scheduled rebuild postponed for ${memoryDir}: `
      + `heap used ${heapStats.used_heap_size} of limit ${heapStats.heap_size_limit} `
      + `(ratio ${pressure.ratio.toFixed(3)}) exceeds projectionRebuildHeapUsageLimit ${heapLimit}`,
    );
    return;
  }

  const forkRebuild = opts.forkRebuild ?? forkProjectionRebuild;
  const unlocked = storageIsUnlocked(rootStorage);
  state.inFlight = true;
  try {
    const result = unlocked
      ? await rebuildMemoryProjection({
        memoryDir,
        // Reuse the daemon's live storage so secure-store deployments rebuild
        // through the unlocked instance instead of a fresh locked one.
        ...(rootStorage ? { storage: rootStorage } : {}),
        defaultNamespace: config.defaultNamespace,
        dryRun: false,
        now: new Date(now),
      })
      : await forkRebuild({
        memoryDir,
        defaultNamespace: config.defaultNamespace || "default",
        now: new Date(now),
      }, { timeoutMs: projectionRebuildForkTimeoutMs(intervalMs) });
    state.lastRebuildAtMs = Date.now();
    const lag = Number.isFinite(rebuiltAtMs)
      ? `${Math.max(0, Math.round((now - rebuiltAtMs) / 60_000))}m stale`
      : "never previously built";
    log.info(
      `memory projection rebuilt (scheduled) for ${memoryDir}: was ${lag}; `
      + `${result.currentRows} current, ${result.timelineRows} timeline, `
      + `${result.entityMentionRows} entity-mention rows`,
    );
  } catch (err) {
    // Non-fatal. Arm a SHORT backoff (not the full success interval) so a
    // transient cause (locked secure store, momentarily-unavailable storage)
    // retries promptly once it clears, while a persistently-failing rebuild
    // still stays off every maintenance tick. lastRebuildAtMs is left as-is so
    // the success interval is not falsely advanced.
    state.lastFailureAtMs = Date.now();
    log.warn(`memory projection scheduled rebuild failed (non-fatal) for ${memoryDir}: ${err}`);
  } finally {
    state.inFlight = false;
  }
}
