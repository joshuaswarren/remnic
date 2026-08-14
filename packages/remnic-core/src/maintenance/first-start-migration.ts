/**
 * First-start lifecycle migration (issue #686 retention-completion).
 *
 * When `lifecyclePolicyEnabled` is true but the memoryDir has never been
 * touched by the lifecycle policy (i.e. the state marker
 * `.lifecycle-init-done` does not exist), run a one-time, rate-limited
 * demotion sweep so the hot tier isn't flooded on the first real cron pass.
 *
 * Design constraints:
 *   - Capped at `FIRST_START_DEMOTION_CAP` (default 50) demotions per run
 *     so a large pre-existing corpus doesn't stall startup.
 *   - Resumable: subsequent invocations see the marker and skip.
 *   - The marker is written AFTER all mutations succeed so a crash during
 *     migration doesn't leave a false "done" marker (CLAUDE.md rule #12).
 *   - Dry-run mode reports candidates without mutating anything or writing
 *     the marker (safe to call from tests).
 */

import path from "node:path";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
  resolveMemoryLifecycleCapabilities,
  resolveQmdCapabilities,
  resolveUtilityLearningCapabilities} from "../capabilities.js";
import type { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import {
  decideTierTransition,
  type TierRoutingPolicy,
} from "../tier-routing.js";
import { TierMigrationExecutor } from "../tier-migration.js";
import type { SearchBackend } from "../search/port.js";
import {
  applyUtilityPromotionRuntimePolicy,
  loadUtilityRuntimeValues,
} from "../utility-runtime.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";

export const FIRST_START_DEMOTION_CAP = 50;
export const LIFECYCLE_INIT_DONE_MARKER = ".lifecycle-init-done";
const LIFECYCLE_QMD_REFRESH_PENDING_MARKER = ".lifecycle-qmd-refresh-pending";

type QmdRefreshPendingMarker = {
  createdAt: string;
  collection: string;
};

export interface FirstStartMigrationOptions {
  storage: StorageManager;
  config: PluginConfig;
  /** Override the per-run demotion cap (default: FIRST_START_DEMOTION_CAP). */
  demotionCap?: number;
  /** When true, report candidates but do not mutate or write the marker. */
  dryRun?: boolean;
  /** Optional QMD backend used to journal demotions and refresh tier collections. */
  qmd?: SearchBackend;
  /** Hot-tier QMD collection name. Defaults to config.qmdCollection. */
  hotCollection?: string;
  /** Cold-tier QMD collection name. Defaults to config.qmdColdCollection. */
  coldCollection?: string;
  /** Optional shutdown signal. When aborted, the migration stops without writing the done marker. */
  signal?: AbortSignal;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface FirstStartMigrationResult {
  skipped: boolean;
  skipReason?: string;
  dryRun: boolean;
  candidateCount: number;
  demotedCount: number;
  /** Number of individual demotion failures. When > 0, the init-done marker is
   *  NOT written so the next start can retry the failed demotions. */
  failureCount: number;
  cappedAt: number;
}

function markerPath(memoryDir: string): string {
  return path.join(memoryDir, "state", LIFECYCLE_INIT_DONE_MARKER);
}

function qmdRefreshPendingPath(memoryDir: string): string {
  return path.join(memoryDir, "state", LIFECYCLE_QMD_REFRESH_PENDING_MARKER);
}

async function markerExists(memoryDir: string): Promise<boolean> {
  try {
    await access(markerPath(memoryDir));
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(memoryDir: string, now: Date): Promise<void> {
  const p = markerPath(memoryDir);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ createdAt: now.toISOString() }), "utf-8");
}

async function readQmdRefreshPending(memoryDir: string): Promise<QmdRefreshPendingMarker | null> {
  try {
    const raw = await readFile(qmdRefreshPendingPath(memoryDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string" &&
      typeof (parsed as { collection?: unknown }).collection === "string" &&
      (parsed as { collection: string }).collection.length > 0
    ) {
      return parsed as QmdRefreshPendingMarker;
    }
    return null;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeQmdRefreshPending(memoryDir: string, now: Date, collection: string): Promise<void> {
  const p = qmdRefreshPendingPath(memoryDir);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ createdAt: now.toISOString(), collection }), "utf-8");
}

async function clearQmdRefreshPending(memoryDir: string): Promise<void> {
  await unlink(qmdRefreshPendingPath(memoryDir)).catch(() => {});
}

async function buildTierRoutingPolicy(config: PluginConfig): Promise<TierRoutingPolicy> {
  const basePolicy: TierRoutingPolicy = {
    enabled: resolveQmdCapabilities(config).qmdTierMigration,
    demotionMinAgeDays: config.qmdTierDemotionMinAgeDays,
    demotionValueThreshold: config.qmdTierDemotionValueThreshold,
    promotionValueThreshold: config.qmdTierPromotionValueThreshold,
  };
  const runtime = await loadUtilityRuntimeValues({
    memoryDir: config.memoryDir,
    memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(config).memoryUtilityLearning,
    promotionByOutcomeEnabled: resolveUtilityLearningCapabilities(config).promotionByOutcome,
  });
  return applyUtilityPromotionRuntimePolicy(basePolicy, runtime);
}

async function refreshQmdCollection(
  qmd: SearchBackend,
  collection: string,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof qmd.updateCollectionStrict === "function") {
    await qmd.updateCollectionStrict(collection, { signal });
    return;
  }
  await qmd.updateCollection(collection, { signal });
}

/**
 * Run the first-start migration sweep.  No-ops when:
 *   - `lifecyclePolicyEnabled` is false, or
 *   - `qmdTierMigrationEnabled` is false (no tier migration configured), or
 *   - the state marker already exists (already ran).
 *
 * Returns a structured result describing what happened.
 */
export async function runFirstStartMigration(
  options: FirstStartMigrationOptions,
): Promise<FirstStartMigrationResult> {
  const {
    storage,
    config,
    demotionCap = FIRST_START_DEMOTION_CAP,
    dryRun = false,
    qmd,
    signal,
  } = options;
  const now = (options.now ?? (() => new Date()))();
  const lifecycleCaps = resolveMemoryLifecycleCapabilities(config);
  const abortedResult = (candidateCount = 0, demotedCount = 0, failureCount = 0): FirstStartMigrationResult => ({
    skipped: candidateCount === 0 && demotedCount === 0 && failureCount === 0,
    skipReason: candidateCount === 0 && demotedCount === 0 && failureCount === 0 ? "aborted" : undefined,
    dryRun,
    candidateCount,
    demotedCount,
    failureCount,
    cappedAt: demotionCap,
  });

  if (signal?.aborted) {
    return abortedResult();
  }

  if (!lifecycleCaps.lifecyclePolicy) {
    return {
      skipped: true,
      skipReason: "lifecyclePolicyEnabled is false",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  if (!resolveQmdCapabilities(config).qmdTierMigration) {
    return {
      skipped: true,
      skipReason: "qmdTierMigrationEnabled is false",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  if (await markerExists(config.memoryDir)) {
    return {
      skipped: true,
      skipReason: "lifecycle-init-done marker already present",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  if (signal?.aborted) {
    return abortedResult();
  }

  const policy = await buildTierRoutingPolicy(config);
  if (signal?.aborted) {
    return abortedResult();
  }

  const hotMemories = excludeSupportPassportPrivateMemories(await storage.readAllMemories());
  if (signal?.aborted) {
    return abortedResult();
  }

  // Find hot memories that should be demoted to cold
  const demotionCandidates = hotMemories.filter((m) => {
    const decision = decideTierTransition(m, "hot", policy, now);
    return decision.changed && decision.nextTier === "cold";
  });

  const candidateCount = demotionCandidates.length;
  // Apply cap
  const batch = demotionCandidates.slice(0, demotionCap);

  if (dryRun) {
    return {
      skipped: false,
      dryRun: true,
      candidateCount,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  let demotedCount = 0;
  let failureCount = 0;
  let qmdRefreshPendingForRun = false;
  const executor = qmd
    ? new TierMigrationExecutor({
        storage,
        qmd,
        hotCollection: options.hotCollection ?? config.qmdCollection ?? "openclaw-engram",
        coldCollection: options.coldCollection ?? config.qmdColdCollection ?? "openclaw-engram-cold",
      })
    : null;
  const coldCollection = options.coldCollection ?? config.qmdColdCollection ?? "openclaw-engram-cold";

  for (const memory of batch) {
    if (signal?.aborted) {
      return abortedResult(candidateCount, demotedCount, failureCount);
    }
    try {
      const result = executor
        ? await executor.migrateMemory({
            memory,
            fromTier: "hot",
            toTier: "cold",
            reason: "first-start-lifecycle-migration",
          })
        : await storage.migrateMemoryToTier(memory, "cold");
      if (result.changed) {
        demotedCount += 1;
      }
    } catch {
      const targetPath = storage.buildTierMemoryPath(memory, "cold");
      const [targetExists, sourceExists] = await Promise.all([
        pathExists(targetPath),
        pathExists(memory.path),
      ]);
      const movedToCold = targetExists && !sourceExists;
      if (movedToCold) {
        if (!qmd) {
          demotedCount += 1;
          continue;
        }
        try {
          await refreshQmdCollection(qmd, coldCollection, signal);
          demotedCount += 1;
          continue;
        } catch {
          qmdRefreshPendingForRun = true;
          try {
            await writeQmdRefreshPending(config.memoryDir, now, coldCollection);
          } catch {
            // The end-of-run retry below still gets a chance to repair the QMD
            // state before we decide whether the init marker is safe to write.
          }
          demotedCount += 1;
          continue;
        }
      }
      // Non-fatal — individual migration failures are counted but do not abort
      // the sweep. We track them so the marker is only written when ALL
      // attempted demotions succeeded (CLAUDE.md rule #12: don't write a
      // success marker after a partial failure).
      failureCount += 1;
    }
  }

  // Write marker AFTER all mutations succeed (CLAUDE.md rule #12).
  // If any demotion failed, skip the marker so the next start retries.
  if (signal?.aborted) {
    return abortedResult(candidateCount, demotedCount, failureCount);
  }
  const persistedQmdRefreshPending = qmd ? await readQmdRefreshPending(config.memoryDir) : null;
  const hasPersistedQmdRefreshPending = persistedQmdRefreshPending?.collection === coldCollection;
  if (qmd && persistedQmdRefreshPending && persistedQmdRefreshPending.collection !== coldCollection) {
    failureCount += 1;
  }
  if (qmd && (qmdRefreshPendingForRun || hasPersistedQmdRefreshPending)) {
    try {
      await refreshQmdCollection(qmd, coldCollection, signal);
      await clearQmdRefreshPending(config.memoryDir);
    } catch {
      failureCount += 1;
    }
  }
  if (failureCount === 0) {
    await writeMarker(config.memoryDir, now);
  }

  return {
    skipped: false,
    dryRun: false,
    candidateCount,
    demotedCount,
    failureCount,
    cappedAt: demotionCap,
  };
}
