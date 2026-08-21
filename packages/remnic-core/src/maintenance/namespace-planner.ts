import { resolveNamespaceCapabilities } from "../capabilities.js";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NamespaceCatalog, NamespaceKind, NamespaceRecord } from "../namespaces/catalog.js";
import { hasMemoryData } from "../namespaces/catalog.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";
import { resolveNamespaceStorageRoot } from "../namespaces/storage.js";
import { displayErrorDetail } from "../runtime/better-sqlite.js";
import type { PluginConfig } from "../types.js";
import { getConfiguredNamespaces } from "../scopes/scope-plan.js";
import { resolveConversationContextCapabilities } from "../capabilities.js";

export type NamespaceMaintenanceJobName = string;

export type NamespaceMaintenanceSkipReason =
  | "fanout_disabled"
  | "empty_root"
  | "branch_disabled"
  | "project_disabled"
  | "team_project_disabled"
  | "catalog_read_failed"
  | "unsafe_or_stale_root"
  | "budget_exhausted"
  | "lock_held"
  | "batch_lock_incomplete"
  | "throttled"
  | "job_failed";

export interface NamespaceMaintenancePlannerOptions {
  jobName: NamespaceMaintenanceJobName;
  catalog?: NamespaceCatalog;
  now?: Date;
  budgetMode?: "cycle" | "unbounded";
}

export interface NamespaceMaintenanceCandidate {
  namespace: string;
  kind: NamespaceKind;
  storageDir?: string;
  source: "configured" | "catalog";
  lastWriteAt?: string;
  lastMaintenanceAt?: string;
}

export interface NamespaceMaintenancePlan {
  jobName: NamespaceMaintenanceJobName;
  generatedAt: string;
  namespaces: NamespaceMaintenanceCandidate[];
  skipped: NamespaceMaintenanceSkippedNamespace[];
  budget: {
    maxNamespacesPerCycle: number;
    selected: number;
  };
}

export interface NamespaceMaintenanceSkippedNamespace {
  namespace: string;
  kind?: NamespaceKind;
  reason: NamespaceMaintenanceSkipReason;
  detail?: string;
}

export interface NamespaceMaintenanceRunStatus {
  namespace: string;
  jobName: NamespaceMaintenanceJobName;
  state: "ran" | "skipped" | "failed";
  reason?: NamespaceMaintenanceSkipReason;
  startedAt: string;
  completedAt: string;
  itemCount?: number;
  error?: string;
}

export interface NamespaceMaintenanceSummary {
  jobName: NamespaceMaintenanceJobName;
  generatedAt: string;
  ran: number;
  skipped: number;
  failed: number;
  statuses: NamespaceMaintenanceRunStatus[];
}

export interface NamespaceMaintenanceBatchRunResult {
  itemCount?: number;
  itemCounts?: Record<string, number> | Map<string, number>;
}

export interface NamespaceMaintenanceBatchRunOptions {
  requireAllLocks?: boolean;
  skipReasonForError?: (error: unknown) => NamespaceMaintenanceSkipReason | null | undefined;
}

interface LockHandle {
  path: string;
  touch(): Promise<void>;
  release(): Promise<void>;
}

const DEFAULT_MAX_NAMESPACES_PER_CYCLE = 20;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const LOCK_BASE = "maintenance-locks";
const STATUS_BASE = "namespace-maintenance-status";
const namespaceMaintenanceFs = { open, rm };

export function __setNamespaceMaintenanceFsForTest(overrides: Partial<typeof namespaceMaintenanceFs>): () => void {
  const previous = { ...namespaceMaintenanceFs };
  Object.assign(namespaceMaintenanceFs, overrides);
  return () => {
    Object.assign(namespaceMaintenanceFs, previous);
  };
}



function inferConfiguredKind(config: PluginConfig, namespace: string): NamespaceKind {
  if (namespace === config.defaultNamespace.trim()) return "default";
  if (namespace === config.sharedNamespace.trim()) return "shared";
  return "explicit";
}

function maxNamespacesPerCycle(config: PluginConfig): number {
  return Math.max(
    1,
    Math.floor(
      typeof config.maintenanceMaxNamespacesPerCycle === "number" &&
        Number.isFinite(config.maintenanceMaxNamespacesPerCycle)
        ? config.maintenanceMaxNamespacesPerCycle
        : DEFAULT_MAX_NAMESPACES_PER_CYCLE
    )
  );
}

function namespaceKindAllowed(config: PluginConfig, kind: NamespaceKind): boolean {
  switch (kind) {
    case "branch":
      return config.maintenanceIncludeBranchNamespaces === true;
    case "project":
      return config.maintenanceIncludeProjectNamespaces !== false;
    case "team-project":
      return config.maintenanceIncludeTeamProjectNamespaces !== false;
    default:
      return true;
  }
}

function disabledReasonForKind(kind: NamespaceKind): NamespaceMaintenanceSkipReason {
  if (kind === "branch") return "branch_disabled";
  if (kind === "project") return "project_disabled";
  if (kind === "team-project") return "team_project_disabled";
  return "fanout_disabled";
}

async function catalogRootIsLive(config: PluginConfig, record: NamespaceRecord): Promise<boolean> {
  if (typeof record.storageDir !== "string" || record.storageDir.length === 0) {
    return false;
  }
  try {
    const liveRoot = await resolveNamespaceStorageRoot(config, record.namespace);
    if (path.resolve(liveRoot) !== path.resolve(record.storageDir)) return false;
    return hasMemoryData(liveRoot);
  } catch {
    return false;
  }
}

function candidateSortKey(candidate: NamespaceMaintenanceCandidate): string {
  const write = candidate.lastWriteAt ?? "";
  return `${write}\u0000${candidate.namespace}`;
}

function candidatePriority(candidate: NamespaceMaintenanceCandidate): number {
  if (candidate.kind === "default") return 0;
  if (candidate.kind === "shared") return 1;
  if (candidate.source === "configured") return 2;
  if (candidate.kind === "team-project") return 3;
  if (candidate.kind === "project") return 4;
  if (candidate.kind === "branch") return 8;
  return 7;
}

function sortCandidates(a: NamespaceMaintenanceCandidate, b: NamespaceMaintenanceCandidate): number {
  const priority = candidatePriority(a) - candidatePriority(b);
  if (priority !== 0) return priority;
  const am = Date.parse(a.lastMaintenanceAt ?? "");
  const bm = Date.parse(b.lastMaintenanceAt ?? "");
  const aMaintained = Number.isFinite(am);
  const bMaintained = Number.isFinite(bm);
  if (aMaintained && bMaintained && am !== bm) return am - bm;
  if (aMaintained !== bMaintained) return aMaintained ? 1 : -1;
  const aw = Date.parse(a.lastWriteAt ?? "");
  const bw = Date.parse(b.lastWriteAt ?? "");
  const aValid = Number.isFinite(aw);
  const bValid = Number.isFinite(bw);
  if (aValid && bValid && aw !== bw) return bw - aw;
  if (aValid !== bValid) return aValid ? -1 : 1;
  const byKey = candidateSortKey(a).localeCompare(candidateSortKey(b));
  if (byKey !== 0) return byKey;
  return a.namespace.localeCompare(b.namespace);
}

export async function planNamespaceMaintenance(
  config: PluginConfig,
  options: NamespaceMaintenancePlannerOptions
): Promise<NamespaceMaintenancePlan> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  // When namespaces are disabled, storageFor() collapses every namespace name
  // to config.memoryDir. Seeding all configured namespaces (default + shared +
  // policies) would make a mutating maintenance job process the SAME corpus
  // once per configured name. The #1500 contract is "namespaces disabled:
  // maintain the current default storage only," so collapse to the default.
  const configured = resolveNamespaceCapabilities(config).namespaces
    ? getConfiguredNamespaces(config)
    : [config.defaultNamespace.trim()].filter(Boolean);
  const byNamespace = new Map<string, NamespaceMaintenanceCandidate>();
  const skipped: NamespaceMaintenanceSkippedNamespace[] = [];

  for (const namespace of configured) {
    const kind = inferConfiguredKind(config, namespace);
    byNamespace.set(namespace, {
      namespace,
      kind,
      source: "configured",
    });
  }

  if (resolveNamespaceCapabilities(config).namespaces && resolveConversationContextCapabilities(config).maintenanceNamespaceFanout !== false) {
    const configuredSet = new Set(configured);
    try {
      const records = options.catalog?.enabled ? await options.catalog.listNamespaces() : [];
      for (const record of records) {
        const namespace = record.namespace.trim();
        if (!namespace) continue;
        const isConfigured = configuredSet.has(namespace);
        const kind = isConfigured ? inferConfiguredKind(config, namespace) : record.kind;
        if (!namespaceKindAllowed(config, kind)) {
          skipped.push({
            namespace,
            kind,
            reason: disabledReasonForKind(kind),
          });
          continue;
        }
        if (!isConfigured && !(await catalogRootIsLive(config, record))) {
          skipped.push({
            namespace,
            kind,
            reason: "unsafe_or_stale_root",
          });
          continue;
        }
        byNamespace.set(namespace, {
          namespace,
          kind,
          storageDir: record.storageDir,
          source: isConfigured ? "configured" : "catalog",
          lastWriteAt: record.lastWriteAt,
          lastMaintenanceAt: record.lastMaintenanceAt?.[options.jobName],
        });
      }
    } catch (error) {
      skipped.push({
        namespace: "*",
        reason: "catalog_read_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (resolveNamespaceCapabilities(config).namespaces) {
    skipped.push({
      namespace: "*",
      reason: "fanout_disabled",
    });
  }

  if (options.budgetMode !== "unbounded") {
    const latestStatusAtByNamespace = await readLatestStatusAtByNamespace(config, options.jobName);
    for (const candidate of byNamespace.values()) {
      if (!candidate.lastMaintenanceAt) {
        candidate.lastMaintenanceAt = latestStatusAtByNamespace.get(candidate.namespace);
      }
    }
  }

  const candidates = [...byNamespace.values()]
    .filter((candidate) => namespaceKindAllowed(config, candidate.kind))
    .sort(sortCandidates);

  const max = maxNamespacesPerCycle(config);
  const applyCycleBudget = options.budgetMode !== "unbounded";
  const selected = applyCycleBudget ? candidates.slice(0, max) : candidates;
  if (applyCycleBudget) {
    for (const candidate of candidates.slice(max)) {
      skipped.push({
        namespace: candidate.namespace,
        kind: candidate.kind,
        reason: "budget_exhausted",
      });
    }
  }

  return {
    jobName: options.jobName,
    generatedAt,
    namespaces: selected,
    skipped,
    budget: {
      maxNamespacesPerCycle: max,
      selected: selected.length,
    },
  };
}

function stablePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unnamed";
  if (sanitized.length <= 128 && sanitized === value) return sanitized;
  return `${sanitized.slice(0, 80)}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function namespacePathSegment(namespace: string): string {
  const token = namespaceIdentityToken(namespace);
  if (token.length <= 160) return token;
  return `ns-${createHash("sha256").update(namespace).digest("hex")}`;
}

function lockPath(config: PluginConfig, jobName: string, namespace: string): string {
  return path.join(
    config.memoryDir,
    "state",
    LOCK_BASE,
    stablePathSegment(jobName),
    `${namespacePathSegment(namespace)}.lock`
  );
}

function namespaceMaintenanceLockStaleMs(config: PluginConfig): number {
  if (
    typeof config.maintenanceNamespaceLockStaleMs === "number" &&
    Number.isFinite(config.maintenanceNamespaceLockStaleMs) &&
    config.maintenanceNamespaceLockStaleMs > 0
  ) {
    return Math.floor(config.maintenanceNamespaceLockStaleMs);
  }
  return DEFAULT_LOCK_STALE_MS;
}

function namespaceMaintenanceLockHeartbeatMs(config: PluginConfig): number {
  const staleMs = namespaceMaintenanceLockStaleMs(config);
  return Math.max(1, Math.min(30_000, Math.floor(staleMs / 3) || 1));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

async function withNamespaceMaintenanceLockHeartbeat<T>(
  config: PluginConfig,
  locks: LockHandle | LockHandle[],
  task: () => Promise<T>,
): Promise<T> {
  const activeLocks = Array.isArray(locks) ? locks : [locks];
  const interval = setInterval(() => {
    for (const lock of activeLocks) {
      void lock.touch().catch(() => undefined);
    }
  }, namespaceMaintenanceLockHeartbeatMs(config));
  interval.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
}

async function removeStaleLockDirectory(filePath: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(filePath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await namespaceMaintenanceFs.rm(path.join(filePath, entry.name), { force: true });
  }
  try {
    await rmdir(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function tryAcquireNamespaceMaintenanceLock(
  config: PluginConfig,
  jobName: string,
  namespace: string
): Promise<LockHandle | null> {
  const filePath = lockPath(config, jobName, namespace);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const lockId = randomUUID();
    await mkdir(filePath);
    const ownerPath = path.join(filePath, `${lockId}.json`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await namespaceMaintenanceFs.open(ownerPath, "wx");
      await handle.writeFile(
        `${JSON.stringify({
          lockId,
          pid: process.pid,
          jobName,
          namespace,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        "utf8"
      );
      await handle.close();
    } catch (setupError) {
      await handle?.close().catch(() => undefined);
      await namespaceMaintenanceFs.rm(ownerPath, { force: true }).catch(() => undefined);
      await rmdir(filePath).catch(() => undefined);
      throw setupError;
    }
    return {
      path: filePath,
      async touch() {
        try {
          const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as { lockId?: unknown };
          if (parsed.lockId === lockId) {
            const now = new Date();
            await utimes(ownerPath, now, now);
            await utimes(filePath, now, now);
          }
        } catch {}
      },
      async release() {
        try {
          const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as { lockId?: unknown };
          if (parsed.lockId === lockId) {
            await namespaceMaintenanceFs.rm(ownerPath, { force: true });
            await rmdir(filePath).catch(() => undefined);
          }
        } catch {}
      },
    };
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const staleMs =
        namespaceMaintenanceLockStaleMs(config);
      try {
        const s = await lstat(filePath);
        if (s.isSymbolicLink()) {
          return null;
        }
        if ((s.isFile() || s.isDirectory()) && Date.now() - s.mtimeMs > staleMs) {
          try {
            if (s.isDirectory()) {
              await removeStaleLockDirectory(filePath);
            } else {
              await namespaceMaintenanceFs.rm(filePath, { force: true });
            }
          } catch (removeError) {
            if (errorCode(removeError) === "ENOENT") {
              return tryAcquireNamespaceMaintenanceLock(config, jobName, namespace);
            }
            if (errorCode(removeError) === "ENOTEMPTY") {
              return null;
            }
            throw removeError;
          }
          return tryAcquireNamespaceMaintenanceLock(config, jobName, namespace);
        }
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") {
          return tryAcquireNamespaceMaintenanceLock(config, jobName, namespace);
        }
        throw statError;
      }
      return null;
    }
    throw error;
  }
}

function statusBasePath(config: PluginConfig): string {
  return path.join(config.memoryDir, "state", STATUS_BASE);
}

function statusPath(config: PluginConfig, jobName: string, namespace: string): string {
  return path.join(statusBasePath(config), stablePathSegment(jobName), `${namespacePathSegment(namespace)}.json`);
}

function lastRanStatusPath(config: PluginConfig, jobName: string, namespace: string): string {
  return path.join(statusBasePath(config), stablePathSegment(jobName), `${namespacePathSegment(namespace)}.last-ran.json`);
}

function parseStatus(value: unknown): NamespaceMaintenanceRunStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<NamespaceMaintenanceRunStatus>;
  if (
    typeof v.namespace === "string" &&
    typeof v.jobName === "string" &&
    (v.state === "ran" || v.state === "skipped" || v.state === "failed") &&
    typeof v.startedAt === "string" &&
    typeof v.completedAt === "string"
  ) {
    return v as NamespaceMaintenanceRunStatus;
  }
  return null;
}

async function readLatestStatusAtByNamespace(config: PluginConfig, jobName: string): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  const latestMs = new Map<string, number>();
  for (const status of [...(await readStatusFiles(config)), ...(await readLastRanStatusFiles(config))]) {
    if (status.state !== "ran") continue;
    if (status.jobName !== jobName) continue;
    const completedAtMs = Date.parse(status.completedAt);
    if (!Number.isFinite(completedAtMs)) continue;
    const previousMs = latestMs.get(status.namespace);
    if (previousMs !== undefined && previousMs >= completedAtMs) continue;
    latestMs.set(status.namespace, completedAtMs);
    latest.set(status.namespace, status.completedAt);
  }
  return latest;
}

async function readStatusFile(filePath: string): Promise<NamespaceMaintenanceRunStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return parseStatus(parsed);
  } catch {
    return null;
  }
}

async function readStatusFiles(config: PluginConfig): Promise<NamespaceMaintenanceRunStatus[]> {
  if (typeof config.memoryDir !== "string" || config.memoryDir.length === 0) {
    return [];
  }
  const root = statusBasePath(config);
  const statuses: NamespaceMaintenanceRunStatus[] = [];
  let jobDirs: Dirent[];
  try {
    jobDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return statuses;
  }
  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    let files: Dirent[];
    try {
      files = await readdir(path.join(root, jobDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      if (file.name.endsWith(".last-ran.json")) continue;
      const status = await readStatusFile(path.join(root, jobDir.name, file.name));
      if (status) statuses.push(status);
    }
  }
  return statuses;
}

async function readLastRanStatusFiles(config: PluginConfig): Promise<NamespaceMaintenanceRunStatus[]> {
  if (typeof config.memoryDir !== "string" || config.memoryDir.length === 0) {
    return [];
  }
  const root = statusBasePath(config);
  const statuses: NamespaceMaintenanceRunStatus[] = [];
  let jobDirs: Dirent[];
  try {
    jobDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return statuses;
  }
  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    let files: Dirent[];
    try {
      files = await readdir(path.join(root, jobDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".last-ran.json")) continue;
      const status = await readStatusFile(path.join(root, jobDir.name, file.name));
      if (status) statuses.push(status);
    }
  }
  return statuses;
}

async function writeStatusPayload(target: string, status: NamespaceMaintenanceRunStatus): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = {
    version: 1,
    ...status,
  };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

async function writeStatusFile(config: PluginConfig, status: NamespaceMaintenanceRunStatus): Promise<void> {
  await writeStatusPayload(statusPath(config, status.jobName, status.namespace), status);
  if (status.state === "ran") {
    await writeStatusPayload(lastRanStatusPath(config, status.jobName, status.namespace), status);
  }
}

async function recordNamespaceMaintenanceStatusSafely(
  config: PluginConfig,
  status: NamespaceMaintenanceRunStatus
): Promise<void> {
  try {
    await writeStatusFile(config, status);
  } catch {
    // Observability must not fail the maintenance operation.
  }
}

function maintenanceErrorDetail(error: unknown): string {
  return displayErrorDetail(error) || "Error";
}

export async function readNamespaceMaintenanceStatuses(config: PluginConfig): Promise<NamespaceMaintenanceRunStatus[]> {
  return (await readStatusFiles(config)).sort((a, b) => {
    const byJob = a.jobName.localeCompare(b.jobName);
    if (byJob !== 0) return byJob;
    return a.namespace.localeCompare(b.namespace);
  });
}

/**
 * Read the last SUCCESSFUL run status per job+namespace (the
 * `<namespace>.last-ran.json` files written only when state === "ran").
 *
 * The latest status file (`<namespace>.json`) is overwritten on every run,
 * so after a successful run followed by a skip (budget/lock/cadence) the
 * latest file shows "skipped" and the prior success is invisible. Merging
 * these last-ran records into the health summary lets `lastRunAt` and run
 * history reflect the most recent successful maintenance (review #1622).
 */
export async function readNamespaceMaintenanceLastRanStatuses(
  config: PluginConfig,
): Promise<NamespaceMaintenanceRunStatus[]> {
  return (await readLastRanStatusFiles(config)).sort((a, b) => {
    const byJob = a.jobName.localeCompare(b.jobName);
    if (byJob !== 0) return byJob;
    return a.namespace.localeCompare(b.namespace);
  });
}

export type NamespaceMaintenancePlanRunnerResult = {
  itemCount?: number;
  /**
   * When `true`, the runner performed NO work for this namespace (e.g. the
   * job's own cadence gate throttled it). The planner records the namespace
   * as `state: "skipped"` with the given reason and does NOT touch the
   * catalog's `lastMaintenanceAt`, so a throttled namespace is not falsely
   * reported as maintained. Without this signal a runner that resolves
   * without throwing is always recorded as `state: "ran"`.
   */
  skipped?: boolean;
  skipReason?: string;
} | undefined;

export async function runNamespaceMaintenancePlan(
  config: PluginConfig,
  plan: NamespaceMaintenancePlan,
  runner: (candidate: NamespaceMaintenanceCandidate) => Promise<NamespaceMaintenancePlanRunnerResult>,
  catalog?: NamespaceCatalog
): Promise<NamespaceMaintenanceSummary> {
  const statuses: NamespaceMaintenanceRunStatus[] = [];

  for (const skipped of plan.skipped) {
    if (skipped.namespace === "*") continue;
    const now = new Date().toISOString();
    const status: NamespaceMaintenanceRunStatus = {
      namespace: skipped.namespace,
      jobName: plan.jobName,
      state: "skipped",
      reason: skipped.reason,
      startedAt: now,
      completedAt: now,
    };
    statuses.push(status);
    await recordNamespaceMaintenanceStatusSafely(config, status);
  }

  for (const candidate of plan.namespaces) {
    const startedAt = new Date().toISOString();
    const lock = await tryAcquireNamespaceMaintenanceLock(config, plan.jobName, candidate.namespace);
    if (!lock) {
      const completedAt = new Date().toISOString();
      const status: NamespaceMaintenanceRunStatus = {
        namespace: candidate.namespace,
        jobName: plan.jobName,
        state: "skipped",
        reason: "lock_held",
        startedAt,
        completedAt,
      };
      statuses.push(status);
      await recordNamespaceMaintenanceStatusSafely(config, status);
      continue;
    }
    try {
      const result = await withNamespaceMaintenanceLockHeartbeat(config, lock, () => runner(candidate));
      const completedAt = new Date().toISOString();
      if (result?.skipped) {
        // The runner performed no work (e.g. the job's own cadence gate
        // throttled this namespace). Record skipped WITHOUT touching the
        // catalog's lastMaintenanceAt so a throttled namespace is not
        // falsely reported as maintained.
        const status: NamespaceMaintenanceRunStatus = {
          namespace: candidate.namespace,
          jobName: plan.jobName,
          state: "skipped",
          reason: (result.skipReason ?? "throttled") as NamespaceMaintenanceSkipReason,
          startedAt,
          completedAt,
        };
        statuses.push(status);
        await recordNamespaceMaintenanceStatusSafely(config, status);
      } else {
        const status: NamespaceMaintenanceRunStatus = {
          namespace: candidate.namespace,
          jobName: plan.jobName,
          state: "ran",
          startedAt,
          completedAt,
          itemCount: result?.itemCount,
        };
        statuses.push(status);
        await recordNamespaceMaintenanceStatusSafely(config, status);
        try {
          await catalog?.markMaintenance(candidate.namespace, plan.jobName, new Date(completedAt));
        } catch {
          // Catalog maintenance touches are best-effort status metadata.
        }
      }
    } catch (error) {
      const completedAt = new Date().toISOString();
      const status: NamespaceMaintenanceRunStatus = {
        namespace: candidate.namespace,
        jobName: plan.jobName,
        state: "failed",
        reason: "job_failed",
        startedAt,
        completedAt,
        error: maintenanceErrorDetail(error),
      };
      statuses.push(status);
      await recordNamespaceMaintenanceStatusSafely(config, status);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  return {
    jobName: plan.jobName,
    generatedAt: new Date().toISOString(),
    ran: statuses.filter((s) => s.state === "ran").length,
    skipped: statuses.filter((s) => s.state === "skipped").length,
    failed: statuses.filter((s) => s.state === "failed").length,
    statuses,
  };
}

export async function runNamespaceMaintenanceBatchPlan(
  config: PluginConfig,
  plan: NamespaceMaintenancePlan,
  runner: (candidates: NamespaceMaintenanceCandidate[]) => Promise<NamespaceMaintenanceBatchRunResult | undefined>,
  catalog?: NamespaceCatalog,
  options: NamespaceMaintenanceBatchRunOptions = {}
): Promise<NamespaceMaintenanceSummary> {
  const statuses: NamespaceMaintenanceRunStatus[] = [];

  for (const skipped of plan.skipped) {
    if (skipped.namespace === "*") continue;
    const now = new Date().toISOString();
    const status: NamespaceMaintenanceRunStatus = {
      namespace: skipped.namespace,
      jobName: plan.jobName,
      state: "skipped",
      reason: skipped.reason,
      startedAt: now,
      completedAt: now,
    };
    statuses.push(status);
    await recordNamespaceMaintenanceStatusSafely(config, status);
  }

  const acquired: Array<{
    candidate: NamespaceMaintenanceCandidate;
    lock: LockHandle;
    startedAt: string;
  }> = [];

  try {
    for (const candidate of plan.namespaces) {
      const startedAt = new Date().toISOString();
      const lock = await tryAcquireNamespaceMaintenanceLock(config, plan.jobName, candidate.namespace);
      if (!lock) {
        const completedAt = new Date().toISOString();
        const status: NamespaceMaintenanceRunStatus = {
          namespace: candidate.namespace,
          jobName: plan.jobName,
          state: "skipped",
          reason: "lock_held",
          startedAt,
          completedAt,
        };
        statuses.push(status);
        await recordNamespaceMaintenanceStatusSafely(config, status);
        continue;
      }
      acquired.push({ candidate, lock, startedAt });
    }
  } catch (error) {
    await Promise.all(acquired.map(({ lock }) => lock.release().catch(() => undefined)));
    throw error;
  }

  if (options.requireAllLocks && acquired.length > 0 && acquired.length < plan.namespaces.length) {
    for (const { candidate, startedAt } of acquired) {
      const completedAt = new Date().toISOString();
      const status: NamespaceMaintenanceRunStatus = {
        namespace: candidate.namespace,
        jobName: plan.jobName,
        state: "skipped",
        reason: "batch_lock_incomplete",
        startedAt,
        completedAt,
      };
      statuses.push(status);
      await recordNamespaceMaintenanceStatusSafely(config, status);
    }
    await Promise.all(acquired.map(({ lock }) => lock.release().catch(() => undefined)));
    return {
      jobName: plan.jobName,
      generatedAt: new Date().toISOString(),
      ran: statuses.filter((s) => s.state === "ran").length,
      skipped: statuses.filter((s) => s.state === "skipped").length,
      failed: statuses.filter((s) => s.state === "failed").length,
      statuses,
    };
  }

  if (acquired.length === 0) {
    return {
      jobName: plan.jobName,
      generatedAt: new Date().toISOString(),
      ran: statuses.filter((s) => s.state === "ran").length,
      skipped: statuses.filter((s) => s.state === "skipped").length,
      failed: statuses.filter((s) => s.state === "failed").length,
      statuses,
    };
  }

  try {
    const result = await withNamespaceMaintenanceLockHeartbeat(
      config,
      acquired.map(({ lock }) => lock),
      () => runner(acquired.map(({ candidate }) => candidate)),
    );
    for (const { candidate, startedAt } of acquired) {
      const completedAt = new Date().toISOString();
      const status: NamespaceMaintenanceRunStatus = {
        namespace: candidate.namespace,
        jobName: plan.jobName,
        state: "ran",
        startedAt,
        completedAt,
        itemCount: itemCountForNamespace(result, candidate.namespace),
      };
      statuses.push(status);
      await recordNamespaceMaintenanceStatusSafely(config, status);
      try {
        await catalog?.markMaintenance(candidate.namespace, plan.jobName, new Date(completedAt));
      } catch {
        // Catalog maintenance touches are best-effort status metadata.
      }
    }
  } catch (error) {
    const skipReason = options.skipReasonForError?.(error);
    for (const { candidate, startedAt } of acquired) {
      const completedAt = new Date().toISOString();
      const status: NamespaceMaintenanceRunStatus = skipReason
        ? {
            namespace: candidate.namespace,
            jobName: plan.jobName,
            state: "skipped",
            reason: skipReason,
            startedAt,
            completedAt,
          }
        : {
            namespace: candidate.namespace,
            jobName: plan.jobName,
            state: "failed",
            reason: "job_failed",
            startedAt,
            completedAt,
            error: maintenanceErrorDetail(error),
          };
      statuses.push(status);
      await recordNamespaceMaintenanceStatusSafely(config, status);
    }
  } finally {
    await Promise.all(acquired.map(({ lock }) => lock.release().catch(() => undefined)));
  }

  return {
    jobName: plan.jobName,
    generatedAt: new Date().toISOString(),
    ran: statuses.filter((s) => s.state === "ran").length,
    skipped: statuses.filter((s) => s.state === "skipped").length,
    failed: statuses.filter((s) => s.state === "failed").length,
    statuses,
  };
}

function itemCountForNamespace(
  result: NamespaceMaintenanceBatchRunResult | undefined,
  namespace: string,
): number | undefined {
  const itemCounts = result?.itemCounts;
  if (itemCounts instanceof Map) return itemCounts.get(namespace);
  if (itemCounts && Object.prototype.hasOwnProperty.call(itemCounts, namespace)) {
    return itemCounts[namespace];
  }
  return result?.itemCount;
}
