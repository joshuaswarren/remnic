/**
 * Cluster causal trajectories into candidate procedure memories (issue #519).
 */

import type { PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import type { CausalTrajectoryRecord } from "../causal-trajectory.js";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  readCausalTrajectoryRecords,
  filterTrajectoriesByLookbackDays,
} from "../causal-trajectory.js";
import { buildProcedurePersistBody, normalizeProcedureSteps, type ProcedureStep } from "./procedure-types.js";
import { clusterByKey } from "./reinforcement-core.js";
import { log } from "../logger.js";

/** Must match truncation on `procedure_cluster` structured attribute (dedupe + storage). */
const PROCEDURE_CLUSTER_ATTR_MAX = 500;
const PROCEDURE_CLUSTER_LOCK_STALE_MS = 120_000;
const PROCEDURE_CLUSTER_LOCK_TIMEOUT_MS = 30_000;

const inProcessClusterWriteLocks = new Map<string, Promise<void>>();

export interface ProcedureMiningResult {
  clustersProcessed: number;
  proceduresWritten: number;
  skippedReason?: string;
}

function clusterKey(record: CausalTrajectoryRecord): string {
  const goal = record.goal.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  const refs = [...(record.entityRefs ?? [])].map((r) => r.trim().toLowerCase()).sort();
  return `${goal}|${refs.join(",")}`;
}

function clusterKeyHash(cluster: string): string {
  return createHash("sha256").update(cluster).digest("hex");
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireClusterWriteLock(memoryDir: string, clusterHash: string): Promise<() => Promise<void>> {
  const lockRoot = path.join(path.resolve(memoryDir), "state", "procedure-miner-locks");
  const lockDir = path.join(lockRoot, `${clusterHash}.lock`);
  await mkdir(lockRoot, { recursive: true });

  const startedAt = Date.now();
  let attempts = 0;
  while (true) {
    try {
      await mkdir(lockDir);
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) throw err;
    }

    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > PROCEDURE_CLUSTER_LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }

    if (Date.now() - startedAt > PROCEDURE_CLUSTER_LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for procedure cluster write lock ${clusterHash}`);
    }

    attempts += 1;
    await sleep(Math.min(250, 25 * attempts));
  }
}

async function withClusterWriteLock<T>(
  memoryDir: string,
  clusterHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const inProcessKey = `${path.resolve(memoryDir)}:${clusterHash}`;
  const previous = inProcessClusterWriteLocks.get(inProcessKey) ?? Promise.resolve();
  let releaseInProcess!: () => void;
  const current = previous.catch(() => undefined).then(
    () =>
      new Promise<void>((resolve) => {
        releaseInProcess = resolve;
      }),
  );
  inProcessClusterWriteLocks.set(inProcessKey, current);

  await previous.catch(() => undefined);
  let releaseDisk: (() => Promise<void>) | null = null;
  try {
    releaseDisk = await acquireClusterWriteLock(memoryDir, clusterHash);
    return await fn();
  } finally {
    try {
      if (releaseDisk) await releaseDisk();
    } finally {
      releaseInProcess();
      if (inProcessClusterWriteLocks.get(inProcessKey) === current) {
        inProcessClusterWriteLocks.delete(inProcessKey);
      }
    }
  }
}

function successRate(group: CausalTrajectoryRecord[]): number {
  if (group.length === 0) return 0;
  const ok = group.filter((g) => g.outcomeKind === "success" || g.outcomeKind === "partial").length;
  return ok / group.length;
}

/** Derive ordered pseudo-steps from trajectory text (v1 heuristic; no tool-call array on records). */
function pseudoStepsFromCluster(group: CausalTrajectoryRecord[]): ProcedureStep[] {
  const sentences: string[] = [];
  const pushUnique = (raw: string) => {
    const t = raw.trim();
    if (t.length < 8) return;
    if (!sentences.includes(t)) sentences.push(t);
  };
  for (const g of group) {
    const parts = [g.actionSummary, g.observationSummary, g.outcomeSummary]
      .join(" ")
      .split(/[.!?]\s+|;|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    for (const p of parts) pushUnique(p);
    if (sentences.length >= 5) break;
  }
  if (sentences.length < 2 && group[0]) {
    pushUnique(`${group[0].goal.trim()} — confirm prerequisites and context.`);
    pushUnique("Execute the planned actions, then record the outcome.");
  }
  return sentences.slice(0, 6).map((intent, i) => ({
    order: i + 1,
    intent,
  }));
}

async function hasExistingClusterWrite(
  storage: StorageManager,
  cluster: string,
): Promise<boolean> {
  const clusterKey = cluster.slice(0, PROCEDURE_CLUSTER_ATTR_MAX);
  const clusterHash = clusterKeyHash(cluster);
  const memories = await storage.readAllMemories();
  for (const m of memories) {
    if (m.frontmatter.category !== "procedure") continue;
    const h = m.frontmatter.structuredAttributes?.procedure_cluster_hash;
    if (typeof h === "string") {
      if (h === clusterHash) return true;
      continue;
    }
    const c = m.frontmatter.structuredAttributes?.procedure_cluster;
    if (c === clusterKey) return true;
  }
  return false;
}

/**
 * Mine recurring successful trajectories into `procedure` memories (pending_review
 * by default; active when auto-promotion thresholds are met).
 */
export async function runProcedureMining(options: {
  memoryDir: string;
  storage: StorageManager;
  config: PluginConfig;
}): Promise<ProcedureMiningResult> {
  const cfg = options.config.procedural;
  if (!cfg?.enabled) {
    return { clustersProcessed: 0, proceduresWritten: 0, skippedReason: "procedural_disabled" };
  }
  if (cfg.minOccurrences <= 0) {
    return { clustersProcessed: 0, proceduresWritten: 0, skippedReason: "minOccurrences_zero" };
  }

  const trajectoryDir =
    typeof options.config.causalTrajectoryStoreDir === "string" &&
    options.config.causalTrajectoryStoreDir.trim().length > 0
      ? options.config.causalTrajectoryStoreDir.trim()
      : undefined;
  const { trajectories } = await readCausalTrajectoryRecords({
    memoryDir: options.memoryDir,
    causalTrajectoryStoreDir: trajectoryDir,
  });
  const recent = filterTrajectoriesByLookbackDays(trajectories, cfg.lookbackDays);

  const clusters = clusterByKey(recent, clusterKey);

  let clustersProcessed = 0;
  let proceduresWritten = 0;

  for (const [key, group] of clusters) {
    if (group.length < cfg.minOccurrences) continue;
    const rate = successRate(group);
    if (rate < cfg.successFloor) continue;

    clustersProcessed += 1;

    const steps = normalizeProcedureSteps(pseudoStepsFromCluster(group));
    if (steps.length < 2) continue;

    const title = `When you work on goals like: ${group[0].goal.trim().slice(0, 140)}`;
    const body = buildProcedurePersistBody(title, steps);
    const clusterHash = clusterKeyHash(key);

    const promote =
      cfg.autoPromoteEnabled === true && group.length >= cfg.autoPromoteOccurrences && rate >= cfg.successFloor;

    const wrote = await withClusterWriteLock(options.memoryDir, clusterHash, async () => {
      if (await hasExistingClusterWrite(options.storage, key)) {
        log.debug(`procedure-miner: skip duplicate cluster key=${key.slice(0, 40)}…`);
        return false;
      }

      await options.storage.writeMemory("procedure", body, {
        source: "procedure-miner",
        status: promote ? "active" : "pending_review",
        tags: ["procedure-miner", "causal-trajectory"],
        structuredAttributes: {
          procedure_cluster: key.slice(0, PROCEDURE_CLUSTER_ATTR_MAX),
          procedure_cluster_hash: clusterHash,
          trajectory_ids: group
            .map((g) => g.trajectoryId)
            .join(",")
            .slice(0, 1900),
          trajectory_count: String(group.length),
          success_rate: rate.toFixed(4),
        },
      });
      return true;
    });
    if (wrote) proceduresWritten += 1;
  }

  return { clustersProcessed, proceduresWritten };
}
