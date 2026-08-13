/**
 * Tier migration coordinator — extracted from the orchestrator (issue #1526).
 *
 * Owns the hot/cold tier-migration lifecycle for a single cycle:
 *   - gating (config flags, in-flight guard, min-interval throttle)
 *   - budget selection (compounding override or config default)
 *   - candidate scanning across hot + cold storage
 *   - promotion/demotion execution via TierMigrationExecutor
 *   - status recording through TierMigrationStatusStore
 *
 * The orchestrator constructs one instance and exposes it as the public
 * `tierMigrationCoordinator` field. CLI commands and maintenance paths call
 * `getStatus`/`runCycle` directly; the orchestrator keeps a private
 * `runTierMigrationCycle` wrapper for the extraction-run dependency.
 * Storage is passed per-call so extraction (which writes to a namespace-
 * scoped storage) and maintenance/manual (which use the default storage)
 * share one coordinator.
 */

import path from "node:path";

// StorageManager type comes from the package barrel (type-only) so this
// module does not add a direct storage.ts import (#1533 ratchet).
import type { StorageManager } from "../index.js";
import type { SearchBackend } from "../search/port.js";
import { TierMigrationExecutor } from "../tier-migration.js";
import { decideTierTransition, type MemoryTier } from "../tier-routing.js";
import {
  TierMigrationStatusStore,
  type TierMigrationCycleSummary,
  type TierMigrationStatusSnapshot,
} from "../recall-state.js";
import {
  type CompoundingEngine,
  defaultTierMigrationCycleBudget,
} from "../compounding/engine.js";
import {
  applyUtilityPromotionRuntimePolicy,
  type UtilityRuntimeValues,
} from "../utility-runtime.js";
import type { PluginConfig, MemoryFile } from "../types.js";
import { log } from "../logger.js";
import { resolveQmdCapabilities } from "../capabilities.js";
import { excludeSupportPassportPrivateMemories } from "../support-passport/card-projection.js";

/** Dependencies injected by the orchestrator. All stable references or live
 *  accessors (the orchestrator reassigns `qmd` to NoopSearchBackend and
 *  `utilityRuntimeValues` after async init, so those arrive as getters). */
export interface TierMigrationCoordinatorDeps {
  config: PluginConfig;
  /** Live accessor — the orchestrator reassigns this.qmd to NoopSearchBackend
   *  after construction when the collection is missing. */
  getQmd: () => SearchBackend;
  tierMigrationStatus: TierMigrationStatusStore;
  /** Live accessor — loaded asynchronously during init, null before that. */
  getUtilityRuntimeValues: () => UtilityRuntimeValues | null;
  /** Live accessor — undefined when compounding is disabled. */
  getCompounding: () => CompoundingEngine | undefined;
  /** Constructs the cold-tier StorageManager for a given parent memory dir.
   *  Injected so this module owns no direct storage.ts import (#1533). */
  createColdStorage: (parentDir: string) => StorageManager;
}

/**
 * Coordinates a single tier-migration cycle. Owns the in-flight guard and
 * last-run timestamp that previously lived as private orchestrator fields.
 */
export class TierMigrationCoordinator {
  private inFlight = false;
  private lastRunAtMs = 0;

  constructor(private readonly deps: TierMigrationCoordinatorDeps) {}

  /** Whether a migration cycle is currently executing (diagnostics). */
  isInFlight(): boolean {
    return this.inFlight;
  }

  /** Latest status snapshot (delegates to the status store). */
  getStatus(): TierMigrationStatusSnapshot {
    return this.deps.tierMigrationStatus.get();
  }

  /**
   * Run one tier-migration cycle. Behavior-preserving move of the
   * orchestrator's former `runTierMigrationCycle`.
   */
  async runCycle(
    storage: StorageManager,
    trigger: "extraction" | "maintenance" | "manual",
    options?: {
      dryRun?: boolean;
      limitOverride?: number;
      force?: boolean;
    },
  ): Promise<TierMigrationCycleSummary> {
    const { config, tierMigrationStatus } = this.deps;
    const dryRun = options?.dryRun === true;
    const persistSkipped = options?.force === true || trigger === "manual";
    if (!resolveQmdCapabilities(config).qmdTierMigration && options?.force !== true) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "tier_migration_disabled",
      };
      if (persistSkipped) await tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (
      trigger === "maintenance" &&
      !resolveQmdCapabilities(config).qmdTierAutoBackfill &&
      options?.force !== true
    ) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "maintenance_backfill_disabled",
      };
      if (persistSkipped) await tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (this.inFlight) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "migration_in_flight",
      };
      if (persistSkipped) await tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const budgetTrigger = trigger === "manual" ? "maintenance" : trigger;
    const budget =
      this.deps.getCompounding()?.tierMigrationCycleBudget(budgetTrigger) ??
      defaultTierMigrationCycleBudget(config, budgetTrigger);
    const limit =
      options?.limitOverride !== undefined
        ? Math.max(0, Math.floor(options.limitOverride))
        : budget.limit;
    const nowMs = Date.now();
    if (
      options?.force !== true &&
      nowMs - this.lastRunAtMs < budget.minIntervalMs
    ) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        skipped: "min_interval",
      };
      if (persistSkipped) await tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const policy = applyUtilityPromotionRuntimePolicy(
      {
        enabled: resolveQmdCapabilities(config).qmdTierMigration,
        demotionMinAgeDays: config.qmdTierDemotionMinAgeDays,
        demotionValueThreshold: config.qmdTierDemotionValueThreshold,
        promotionValueThreshold: config.qmdTierPromotionValueThreshold,
      },
      this.deps.getUtilityRuntimeValues(),
    );

    this.inFlight = true;
    try {
      const coldStorage = this.deps.createColdStorage(
        path.join(storage.dir, "cold"),
      );
      const [allHotMemories, allColdMemories] = await Promise.all([
        storage.readAllMemories(),
        coldStorage.readAllMemories(),
      ]);
      const hotMemories = excludeSupportPassportPrivateMemories(allHotMemories);
      const coldMemories = excludeSupportPassportPrivateMemories(allColdMemories);
      const now = new Date();
      const scanLimit = Math.max(0, Math.floor(budget.scanLimit));
      const hotScanLimit = Math.min(
        hotMemories.length,
        Math.ceil(scanLimit * 0.75),
      );
      const coldScanLimit = Math.min(
        coldMemories.length,
        Math.max(0, scanLimit - hotScanLimit),
      );
      const toTimestamp = (memory: MemoryFile): number =>
        Date.parse(memory.frontmatter.updated ?? memory.frontmatter.created);
      const hotCandidates = hotMemories
        .map((memory) => ({ memory, tier: "hot" as MemoryTier }))
        .sort((a, b) => toTimestamp(a.memory) - toTimestamp(b.memory))
        .slice(0, hotScanLimit);
      const coldCandidates = coldMemories
        .map((memory) => ({ memory, tier: "cold" as MemoryTier }))
        .sort((a, b) => toTimestamp(b.memory) - toTimestamp(a.memory))
        .slice(0, coldScanLimit);
      const candidates = [...hotCandidates, ...coldCandidates];

      const migration = new TierMigrationExecutor({
        storage,
        qmd: this.deps.getQmd(),
        hotCollection: config.qmdCollection,
        coldCollection:
          config.qmdColdCollection ?? `${config.qmdCollection}-cold`,
        autoEmbed: resolveQmdCapabilities(config).qmdAutoEmbed,
      });

      let migrated = 0;
      let promoted = 0;
      let demoted = 0;
      for (const candidate of candidates) {
        if (migrated >= limit) break;
        const decision = decideTierTransition(
          candidate.memory,
          candidate.tier,
          policy,
          now,
        );
        if (!decision.changed) continue;

        if (!dryRun) {
          const res = await migration.migrateMemory({
            memory: candidate.memory,
            fromTier: candidate.tier,
            toTier: decision.nextTier,
            reason: `${trigger}:${decision.reason}`,
          });
          if (!res.changed) continue;
        }
        migrated += 1;
        if (decision.nextTier === "cold") demoted += 1;
        if (decision.nextTier === "hot") promoted += 1;
      }

      if (!dryRun) this.lastRunAtMs = Date.now();
      log.debug(
        `tier migration cycle completed: trigger=${trigger} scanned=${candidates.length} migrated=${migrated} limit=${limit}${dryRun ? " dryRun=true" : ""}`,
      );
      const summary: TierMigrationCycleSummary = {
        trigger,
        scanned: candidates.length,
        migrated,
        promoted,
        demoted,
        limit,
        dryRun,
      };
      const shouldPersistCycle = trigger === "manual" || migrated > 0;
      if (shouldPersistCycle) await tierMigrationStatus.recordCycle(summary);
      return summary;
    } catch (err) {
      this.lastRunAtMs = Date.now();
      log.warn(`tier migration cycle failed (${trigger}, fail-open): ${err}`);
      const failed: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        errorCount: 1,
      };
      await tierMigrationStatus.recordCycle(failed);
      return failed;
    } finally {
      this.inFlight = false;
    }
  }
}
