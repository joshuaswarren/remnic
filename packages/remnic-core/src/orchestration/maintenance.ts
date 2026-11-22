
import { resolveNamespaceCapabilities,
  resolveQmdCapabilities,resolveConsolidationCapabilities, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import { existsSync, type Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "../search/port.js";
import type { StorageManager } from "../index.js";
import {
  NamespaceSearchRouter,
  type NamespaceUpdateResult,
} from "../namespaces/search.js";
import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import {
  planNamespaceMaintenance,
  runNamespaceMaintenanceBatchPlan,
  type NamespaceMaintenancePlan,
  type NamespaceMaintenanceSkipReason,
} from "../maintenance/namespace-planner.js";
import {
  ensureContradictionScanCron,
  ensureDaySummaryCron,
  ensureGraphEdgeDecayCron,
  ensureNightlyGovernanceCron,
  ensurePatternReinforcementCron,
  ensureProceduralMiningCron,
  graphEdgeDecayCadenceToCronExpr,
} from "../maintenance/memory-governance-cron.js";
import { rebuildMemoryLifecycleLedger } from "../maintenance/rebuild-memory-lifecycle-ledger.js";
import { resolveDaySummaryCronModel } from "../maintenance/day-summary-cron.js";
import {
  createProjectionRebuildScheduleState,
  maybeRebuildMemoryProjectionScheduled,
  terminateScheduledProjectionRebuilds,
} from "./projection-rebuild-schedule.js";
import { drainPendingLifecycleAppendsForPath } from "./lifecycle-pending-fallback-drain.js";
import { QmdMaintenanceCompletion } from "./qmd-maintenance-completion.js";
import { STATE_FILE_MAX_DECRYPT_BYTES } from "../storage/secure-line-reader.js";
import { createCompoundingWeeklyCron, type CompoundingWeeklySchedulerHandle } from "../compounding/weekly-scheduler.js";
import { startLocationAutoSync, type LocationAutoSyncHandle } from "../location/scheduler.js";
import { ActivitySyncRegistrar } from "../activity/sync-registration.js";
import type { ActivitySyncRunSummary } from "../activity/runner.js";
import { resolveHomeDir } from "../runtime/env.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import {
  probeEncryptedRegularFileHeader,
  SECURE_STORE_ENVELOPE_OVERHEAD_BYTES,
} from "../secure-store/secure-fs.js";

function qmdMaintenanceSkipReasonForError(
  error: unknown,
): NamespaceMaintenanceSkipReason | null {
  const message = error instanceof Error ? error.message : String(error);
  return /^QMD (?:update|embed) skipped by .*min-interval gate$/.test(message)
    ? "throttled"
    : null;
}

export interface MaintenanceSchedulerDeps {
  config: PluginConfig;
  getQmd: () => SearchBackend;
  namespaceSearchRouter: NamespaceSearchRouter;
  namespaceCatalog: NamespaceCatalog;
  /**
   * Root storage (secure-store configured). Threaded so lifecycle-ledger
   * auto-compaction (#1910) rebuilds through the live secure context: encrypted
   * memories stay decryptable and the rewritten ledger stays encrypted at rest.
   * Omitted in focused tests, where compaction falls back to a fresh plaintext
   * StorageManager (the CLI-equivalent path).
   */
  getStorage?: () => StorageManager;
  /**
   * Resolve a namespace's (secure-store aware) storage. Threaded so
   * auto-compaction also bounds per-namespace lifecycle ledgers under
   * `memoryDir/namespaces/<token>/state/`, not just the root state path
   * (#1910). Consulted only when namespaces are enabled.
   */
  storageForNamespace?: (namespace: string) => Promise<StorageManager>;
  /**
   * Tail step (issue #1900): observe a durable activity sync tick so the
   * meetings builder can rebuild the affected day(s). Optional; omitted by
   * hosts that do not build meetings.
   */
  onActivitySynced?: (summary: ActivitySyncRunSummary) => void;
}

export class MaintenanceScheduler {
  private nonZeroExtractionsSinceConsolidation = 0;
  private lastConsolidationRunAtMs = 0;
  private consolidationRunPromise: Promise<unknown> | null = null;
  private disposed = false;

  private qmdMaintenanceTimer: NodeJS.Timeout | null = null;
  private qmdMaintenancePending = false;
  private qmdMaintenanceInFlight = false;
  private readonly qmdCompletion = new QmdMaintenanceCompletion();
  private readonly qmdCoveredNamespaces = new Set<string>();
  private lastQmdEmbedAtMs = 0;
  private lastQmdEmbedAtMsByNamespace = new Map<string, number>();

  private lifecycleCompactionInFlight = false;
  private lastLifecycleCompactionAtMs = 0;
  private lifecycleLedgerMaxBytes = STATE_FILE_MAX_DECRYPT_BYTES;

  private readonly projectionRebuild = createProjectionRebuildScheduleState();

  private readonly activityRegistrar: ActivitySyncRegistrar;
  private locationAutoSync: LocationAutoSyncHandle | null = null;
  private compoundingWeekly: CompoundingWeeklySchedulerHandle | null = null;


  constructor(private readonly deps: MaintenanceSchedulerDeps) {
    this.activityRegistrar = new ActivitySyncRegistrar({
      config: deps.config.activity,
      memoryDir: deps.config.memoryDir,
      qmdCollection: deps.config.qmdCollection,
      secureStoreEnabled: resolveRecallAuxiliaryCapabilities(deps.config).secureStore,
      getQmd: () => deps.getQmd(),
      requestReindexRetry: () => this.requestQmdMaintenanceForTool("activity-reindex-retry"),
      pluginConfig: deps.config,
      ...(deps.onActivitySynced ? { onSynced: deps.onActivitySynced } : {}),
    });
  }


  /**
   * Register every cron job the daemon should run, gated by its config flag.
   * Each registration is independent and non-fatal — a failure in one does
   * not block the others (mirrors the orchestrator's prior sequential try/
   * catch behavior exactly).
   *
   * Returns when all eligible registrations have completed so callers that
   * `await deferredReady` can rely on jobs.json being current.
   */
  async autoRegisterCrons(signal: AbortSignal): Promise<void> {
    if (resolveRecallAuxiliaryCapabilities(this.deps.config).daySummary) {
      try {
        await this.autoRegisterDaySummaryCron();
      } catch (err) {
        log.debug(`day-summary cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (this.deps.config.nightlyGovernanceCronAutoRegister) {
      try {
        await this.autoRegisterNightlyGovernanceCron();
      } catch (err) {
        log.debug(`nightly governance cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (this.deps.config.procedural?.proceduralMiningCronAutoRegister) {
      try {
        await this.autoRegisterProceduralMiningCron();
      } catch (err) {
        log.debug(`procedural mining cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (this.deps.config.contradictionScan?.enabled) {
      try {
        await this.autoRegisterContradictionScanCron();
      } catch (err) {
        log.debug(`contradiction scan cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (resolveConsolidationCapabilities(this.deps.config).patternReinforcement) {
      try {
        await this.autoRegisterPatternReinforcementCron();
      } catch (err) {
        log.debug(`pattern reinforcement cron auto-register failed (non-fatal): ${err}`);
      }
    }
    if (resolveConsolidationCapabilities(this.deps.config).graphEdgeDecay) {
      try {
        await this.autoRegisterGraphEdgeDecayCron();
      } catch (err) {
        log.debug(`graph edge decay cron auto-register failed (non-fatal): ${err}`);
      }
    }

    await this.activityRegistrar.register(signal);
    if (
      !signal.aborted &&
      this.deps.config.location.enabled &&
      this.deps.config.location.sources.some((source) => source.enabled)
    ) {
      this.locationAutoSync = startLocationAutoSync({
        config: this.deps.config.location,
        memoryDir: this.deps.config.memoryDir,
      });
    }
  }

  armCompoundingWeeklyCron(): boolean { if (this.disposed) return false; this.compoundingWeekly ??= createCompoundingWeeklyCron(this.deps); return this.compoundingWeekly !== null; }

  async autoRegisterDaySummaryCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");

    try {
      if (!existsSync(jobsPath)) {
        log.debug("day-summary cron: jobs.json not found, skipping auto-register");
        return;
      }

      const { model, fallbacks } = resolveDaySummaryCronModel(this.deps.config);

      const timezone =
        this.deps.config.daySummaryTimezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone;

      const result = await ensureDaySummaryCron(jobsPath, {
        timezone,
        ...(model ? { model } : {}),
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
      });
      if (result.created) {
        log.info(
          `day-summary cron auto-registered (${result.jobId}, 23:47 ${timezone}${model ? `, model: ${model}` : ""})`,
        );
      } else if (result.updated) {
        log.info(
          `day-summary cron reconciled (${result.jobId}, timezone: ${timezone}${model ? `, model: ${model}` : ""})`,
        );
      } else {
        log.debug("day-summary cron already up to date");
      }
    } catch (err) {
      log.debug(`day-summary cron auto-register error: ${err}`);
    }
  }

  async autoRegisterNightlyGovernanceCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");

    try {
      if (!existsSync(jobsPath)) {
        log.debug("nightly governance cron: jobs.json not found, skipping auto-register");
        return;
      }

      const created = await ensureNightlyGovernanceCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(
          `nightly governance cron auto-registered (${created.jobId}, 02:23 ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        );
      } else {
        log.debug("nightly governance cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`nightly governance cron auto-register error: ${err}`);
    }
  }

  async autoRegisterProceduralMiningCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("procedural mining cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensureProceduralMiningCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`procedural mining cron auto-registered (${created.jobId})`);
      } else {
        log.debug("procedural mining cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`procedural mining cron auto-register error: ${err}`);
    }
  }

  async autoRegisterContradictionScanCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("contradiction scan cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensureContradictionScanCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`contradiction scan cron auto-registered (${created.jobId})`);
      } else {
        log.debug("contradiction scan cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`contradiction scan cron auto-register error: ${err}`);
    }
  }

  async autoRegisterPatternReinforcementCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("pattern reinforcement cron: jobs.json not found, skipping auto-register");
        return;
      }
      const created = await ensurePatternReinforcementCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (created.created) {
        log.info(`pattern reinforcement cron auto-registered (${created.jobId})`);
      } else {
        log.debug("pattern reinforcement cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`pattern reinforcement cron auto-register error: ${err}`);
    }
  }

  async autoRegisterGraphEdgeDecayCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");
    try {
      if (!existsSync(jobsPath)) {
        log.debug("graph edge decay cron: jobs.json not found, skipping auto-register");
        return;
      }
      const scheduleExpr = graphEdgeDecayCadenceToCronExpr(
        this.deps.config.graphEdgeDecayCadenceMs,
      );
      const created = await ensureGraphEdgeDecayCron(jobsPath, {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scheduleExpr,
      });
      if (created.created) {
        log.info(`graph edge decay cron auto-registered (${created.jobId}, ${scheduleExpr})`);
      } else {
        log.debug("graph edge decay cron already exists, skipping auto-register");
      }
    } catch (err) {
      log.debug(`graph edge decay cron auto-register error: ${err}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────

  maybeScheduleConsolidation(
    nonZeroExtraction: boolean,
    runConsolidation: () => Promise<unknown>,
  ): void {
    if (nonZeroExtraction) this.nonZeroExtractionsSinceConsolidation += 1;
    if (
      this.deps.config.consolidationRequireNonZeroExtraction &&
      !nonZeroExtraction
    ) {
      return;
    }
    if (
      this.nonZeroExtractionsSinceConsolidation <
      this.deps.config.consolidateEveryN
    ) {
      return;
    }

    const now = Date.now();
    if (
      now - this.lastConsolidationRunAtMs <
      this.deps.config.consolidationMinIntervalMs
    ) {
      return;
    }
    if (this.disposed || this.consolidationRunPromise) return;

    this.lastConsolidationRunAtMs = now;
    this.nonZeroExtractionsSinceConsolidation = 0;
    this.consolidationRunPromise = Promise.resolve()
      .then(runConsolidation)
      .catch((err) => {
        log.error("background consolidation failed", err);
      })
      .finally(() => {
        this.consolidationRunPromise = null;
      });
  }

  isConsolidationInFlight(): boolean {
    return this.consolidationRunPromise !== null;
  }

  isQmdMaintenancePending(): boolean {
    return this.qmdMaintenancePending;
  }

  isQmdMaintenanceInFlight(): boolean {
    return this.qmdMaintenanceInFlight;
  }
  // ───────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────

  private requestQmdMaintenance(): boolean {
    if (!this.deps.getQmd().isAvailable()) return false;
    if (!resolveQmdCapabilities(this.deps.config).qmdMaintenance) return false;

    this.qmdMaintenancePending = true;
    if (this.qmdMaintenanceTimer) return true;

    this.qmdMaintenanceTimer = setTimeout(() => {
      this.qmdMaintenanceTimer = null;
      this.runQmdMaintenance().catch((err) =>
        log.debug(`background qmd maintenance failed: ${err}`),
      );
    }, this.deps.config.qmdMaintenanceDebounceMs);
    return true;
  }

  /**
   * Like a maintenance request, but resolves true only once a pass that started
   * after it completed successfully. False when nothing could be armed (QMD
   * unavailable or maintenance off), the pass failed, or dispose() abandoned it,
   * so a caller that must not lose the re-index keeps owing it.
   */
  requestQmdMaintenanceCompletion(namespace?: string): Promise<boolean> {
    if (this.disposed || !this.requestQmdMaintenance()) return Promise.resolve(false);
    return this.qmdCompletion.wait(namespace);
  }

  requestQmdMaintenanceForTool(reason: string): void {
    try {
      this.requestQmdMaintenance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`qmd maintenance request failed (${reason}): ${msg}`);
    }
    void this.maybeCompactMemoryLifecycleLedger().catch((err) =>
      log.debug(`lifecycle ledger auto-compaction check failed (non-fatal): ${err}`),
    );
    void maybeRebuildMemoryProjectionScheduled({
      config: this.deps.config,
      getStorage: this.deps.getStorage,
      state: this.projectionRebuild,
    }).catch((err) =>
      log.debug(`memory projection scheduled rebuild check failed (non-fatal): ${err}`),
    );
  }

  async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;
    const settle = this.qmdCompletion.claim();
    let served = false;
    let deferred = false;
    let ranNamespaces: Set<string> | undefined;

    try {
      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        const plan = await this.namespaceMaintenancePlan("qmd");
        const now = Date.now();
        const lastEmbedAtByNamespace = this.lastQmdEmbedAtMsByNamespace;
        const dueEmbedNamespaces = (namespaces: string[]): string[] => {
          if (!resolveQmdCapabilities(this.deps.config).qmdAutoEmbed) return [];
          return namespaces.filter(
            (namespace) =>
              now - (lastEmbedAtByNamespace.get(namespace) ?? 0) >=
              this.deps.config.qmdEmbedMinIntervalMs,
          );
        };
        const markEmbedded = (namespaces: string[]): void => {
          if (namespaces.length === 0) return;
          for (const namespace of namespaces) {
            lastEmbedAtByNamespace.set(namespace, now);
          }
          this.lastQmdEmbedAtMs = now;
        };
        const summary = await runNamespaceMaintenanceBatchPlan(
          this.deps.config,
          plan,
          async (candidates) => {
            const namespaces = candidates.map((candidate) => candidate.namespace);
            const embedNamespaces = dueEmbedNamespaces(namespaces);
            let result: NamespaceUpdateResult;
            try {
              result = await this.deps.namespaceSearchRouter.updateNamespacesDetailed(
                namespaces,
                undefined,
                { strict: true },
              );
            } catch (error) {
              if (
                embedNamespaces.length > 0 &&
                qmdMaintenanceSkipReasonForError(error) === "throttled"
              ) {
                await this.deps.namespaceSearchRouter.embedNamespaces(embedNamespaces, {
                  strict: true,
                });
                markEmbedded(embedNamespaces);
              }
              throw error;
            }
            if (result.backendCount <= 0) {
              throw new Error("no eligible QMD backend for selected namespaces");
            }
            if (result.eligibleNamespaces.length !== namespaces.length) {
              const eligible = new Set(result.eligibleNamespaces);
              const missing = namespaces.filter(
                (namespace) => !eligible.has(namespace),
              );
              throw new Error(
                `QMD backend ineligible for selected namespaces (${missing.length})`,
              );
            }
            if (embedNamespaces.length > 0) {
              await this.deps.namespaceSearchRouter.embedNamespaces(embedNamespaces, {
                strict: true,
              });
              markEmbedded(embedNamespaces);
            }
            return { itemCount: result.backendCount };
          },
          this.deps.namespaceCatalog,
          {
            skipReasonForError: qmdMaintenanceSkipReasonForError,
          },
        );
        const covered = this.qmdCoveredNamespaces;
        const ran = new Set<string>();
        ranNamespaces = ran;
        const before = covered.size;
        for (const status of summary.statuses) {
          if (status.state !== "ran") continue;
          covered.add(status.namespace);
          ran.add(status.namespace);
        }
        const uncovered = summary.statuses.some(
          (status) =>
            status.state === "skipped" &&
            (status.reason === "budget_exhausted" || status.reason === "lock_held") &&
            !covered.has(status.namespace),
        );
        const catalogReadFailed = plan.skipped.some((skip) => skip.reason === "catalog_read_failed");
        served = summary.ran > 0 && summary.failed === 0 && !uncovered && !catalogReadFailed;
        deferred = !served && summary.failed === 0 && !catalogReadFailed && covered.size > before && !this.disposed;
      } else {
        const qmd = this.deps.getQmd();
        if (qmd.updateCompleted) {
          try {
            served = await qmd.updateCompleted();
          } catch (err) {
            log.debug(`qmd maintenance update did not run: ${err}`);
          }
        } else if (qmd.updateStrict) {
          try {
            await qmd.updateStrict();
            served = true;
          } catch (err) {
            log.debug(`qmd maintenance update did not run: ${err}`);
          }
        } else {
          await qmd.update();
        }
        const now = Date.now();
        if (
          resolveQmdCapabilities(this.deps.config).qmdAutoEmbed &&
          now - this.lastQmdEmbedAtMs >= this.deps.config.qmdEmbedMinIntervalMs
        ) {
          await this.deps.getQmd().embed();
          this.lastQmdEmbedAtMs = now;
        }
      }
      // Note: a successful QMD update/embed clears the global QMD result caches
      // itself (QmdClient.runUpdateForCollection / runEmbedForCollection), so
      // this scheduler does not invalidate them here — every refresh path
      // (direct update, namespace router, wearable/OpenClaw sync) funnels through
      // the backend and clears centrally. A no-op pass (throttle/unavailable/
      // backoff) does not advance lastUpdateRanAtMs, so it leaves caches warm
      // (#1904, Codex/Cursor).
    } finally {
      settle(served, deferred, ranNamespaces);
      if (!deferred) this.qmdCoveredNamespaces.clear();
      this.qmdMaintenanceInFlight = false;
      if (deferred) this.qmdMaintenancePending = true;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
      // Lifecycle-ledger auto-compaction is triggered from
      // requestQmdMaintenanceForTool (every maintenance request, QMD or not),
      // so it does not need to be re-fired here (issue #1910).
    }
  }

  private async maybeCompactMemoryLifecycleLedger(): Promise<void> {
    const targets = await this.resolveLifecycleCompactionTargets();
    for (const target of targets) {
      await this.drainPendingForTarget(target);
    }

    const threshold = this.deps.config.memoryLifecycleLedgerCompactBytes;
    if (!(threshold > 0)) return; // 0 / negative / non-numeric disables compaction.
    if (this.lifecycleCompactionInFlight) return;
    const now = Date.now();
    if (
      now - this.lastLifecycleCompactionAtMs <
        this.deps.config.memoryLifecycleLedgerCompactMinIntervalMs &&
      !(await this.hasOverCapEncryptedLifecycleLedger(targets))
    ) {
      return;
    }
    if (this.lifecycleCompactionInFlight) return;
    this.lifecycleCompactionInFlight = true;
    try {
      let compacted = 0;
      let failed = 0;
      let deferred = 0;
      for (const target of targets) {
        const outcome = await this.compactLifecycleLedgerTarget(target, threshold);
        if (outcome === "compacted") compacted += 1;
        else if (outcome === "failed") failed += 1;
        else if (outcome === "deferred") deferred += 1;
      }
      if (compacted > 0 && failed === 0 && deferred === 0) {
        this.lastLifecycleCompactionAtMs = now;
      }
    } finally {
      this.lifecycleCompactionInFlight = false;
    }
  }

  private async hasOverCapEncryptedLifecycleLedger(
    targets: Array<{ memoryDir: string; storage?: StorageManager }>,
  ): Promise<boolean> {
    for (const target of targets) {
      const ledgerPath = path.join(target.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
      let size: number;
      try {
        size = (await stat(ledgerPath)).size;
      } catch {
        continue; // absent/unstattable — nothing to force here.
      }
      if (size < this.lifecycleLedgerMaxBytes) continue;
      try {
        if (await probeEncryptedRegularFileHeader(ledgerPath)) return true;
      } catch {
        continue; // probe failure — the normal compaction path reports it.
      }
    }
    return false;
  }

  private async drainPendingForTarget(
    target: { memoryDir: string; storage?: StorageManager },
  ): Promise<void> {
    if (target.storage) {
      await this.drainPendingLifecycleAppends(target.storage);
    } else {
      await drainPendingLifecycleAppendsForPath(target.memoryDir);
    }
  }

  private async drainPendingLifecycleAppends(storage: StorageManager | undefined): Promise<void> {
    if (!storage) return;
    try {
      await storage.drainPendingMemoryLifecycleEvents();
    } catch (err) {
      log.debug(`lifecycle pending drain failed (non-fatal): ${err}`);
    }
  }

  private async resolveLifecycleCompactionTargets(): Promise<
    Array<{ memoryDir: string; storage?: StorageManager }>
  > {
    const targets: Array<{ memoryDir: string; storage?: StorageManager }> = [];
    const seen = new Set<string>();
    const addTarget = (memoryDir: string, storage?: StorageManager): void => {
      const key = path.resolve(memoryDir);
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ memoryDir, storage });
    };

    const rootStorage = this.deps.getStorage?.();
    addTarget(rootStorage ? rootStorage.dir : this.deps.config.memoryDir, rootStorage);

    const resolveNamespaceStorage = this.deps.storageForNamespace;
    if (resolveNamespaceStorage && this.deps.namespaceCatalog?.enabled) {
      let records: NamespaceRecord[] = [];
      try {
        records = await this.deps.namespaceCatalog.listNamespaces();
      } catch (err) {
        log.debug(`lifecycle compaction: namespace enumeration failed (non-fatal): ${err}`);
      }
      for (const record of records) {
        const namespace = record.namespace.trim();
        if (!namespace) continue;
        try {
          const storage = await resolveNamespaceStorage(namespace);
          addTarget(storage.dir, storage);
        } catch (err) {
          log.debug(
            `lifecycle compaction: storage resolve failed for namespace ${namespace} (non-fatal): ${err}`,
          );
        }
      }
    }

    if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
      const namespacesBase = path.join(this.deps.config.memoryDir, "namespaces");
      let memoryDirReal: string;
      try {
        memoryDirReal = await realpath(this.deps.config.memoryDir);
        const baseStat = await lstat(namespacesBase);
        if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
          throw new Error("namespaces base is a symlink or not a directory");
        }
        assertPathInsideRoot(memoryDirReal, await realpath(namespacesBase), namespacesBase);
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) {
          log.debug(`lifecycle compaction: namespaces base rejected (non-fatal): ${err}`);
        }
        return targets;
      }
      let entries: Dirent[] = [];
      try {
        entries = await readdir(namespacesBase, { withFileTypes: true });
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) {
          log.debug(`lifecycle compaction: namespaces dir scan failed (non-fatal): ${err}`);
        }
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const childPath = path.join(namespacesBase, entry.name);
        try {
          assertPathInsideRoot(memoryDirReal, await realpath(childPath), childPath);
        } catch (err) {
          log.debug(`lifecycle compaction: skipping out-of-root namespace dir ${childPath}: ${err}`);
          continue;
        }
        const decodedNamespace = namespaceIdentityFromToken(entry.name);
        const routeNamespace =
          decodedNamespace !== null
            ? decodedNamespace
            : isSafeRouteNamespace(entry.name)
              ? entry.name
              : null;
        if (resolveNamespaceStorage && routeNamespace !== null) {
          try {
            const storage = await resolveNamespaceStorage(routeNamespace);
            if (path.resolve(storage.dir) === path.resolve(childPath)) {
              addTarget(storage.dir, storage);
              continue;
            }
            log.debug(
              `lifecycle compaction: fallback resolver routed ${childPath} to ${storage.dir}; `
              + "using keyless target",
            );
          } catch (err) {
            log.debug(
              `lifecycle compaction: fallback storage resolve failed for ${childPath} (non-fatal): ${err}`,
            );
          }
        }
        addTarget(childPath);
      }
    }
    return targets;
  }

  private async compactLifecycleLedgerTarget(
    target: { memoryDir: string; storage?: StorageManager },
    threshold: number,
  ): Promise<"skipped" | "compacted" | "failed" | "deferred"> {
    const ledgerPath = path.join(target.memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    let size = 0;
    try {
      size = (await stat(ledgerPath)).size;
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return "skipped"; // absent — nothing to compact yet.
      log.warn(
        `lifecycle ledger size check failed (non-fatal) for ${target.memoryDir}: ${err}`,
      );
      return "failed";
    }
    if (size < Math.min(threshold, this.lifecycleLedgerMaxBytes)) return "skipped";
    let encrypted: boolean;
    try {
      encrypted = await probeEncryptedRegularFileHeader(ledgerPath);
    } catch (err) {
      log.warn(`lifecycle ledger encryption probe failed (non-fatal) for ${ledgerPath}: ${err}`);
      return "failed";
    }
    const effectiveThreshold = encrypted
      ? Math.min(threshold, this.lifecycleLedgerMaxBytes)
      : threshold;
    if (size < effectiveThreshold) return "skipped";
    if (encrypted && !(target.storage?.isSecureStoreUnlocked() ?? false)) {
      log.warn(
        `lifecycle ledger at ${ledgerPath} is encrypted at rest but no unlocked secure `
        + `storage is available; deferring auto-compaction to avoid a plaintext rewrite. `
        + `Run 'remnic rebuild-memory-lifecycle-ledger --write' after unlocking.`,
      );
      return "deferred";
    }
    const replacementEncrypted =
      encrypted || (target.storage?.willEncryptStateWrites() ?? false);
    const plaintextBudget = replacementEncrypted
      ? this.lifecycleLedgerMaxBytes - SECURE_STORE_ENVELOPE_OVERHEAD_BYTES - 1
      : this.lifecycleLedgerMaxBytes - 1;
    try {
      const result = await rebuildMemoryLifecycleLedger({
        memoryDir: target.memoryDir,
        dryRun: false,
        storage: target.storage,
        preserveExistingEvents: true,
        maxLedgerBytes: plaintextBudget,
      });
      let rewrittenSize = 0;
      try {
        rewrittenSize = (await stat(ledgerPath)).size;
      } catch (err) {
        log.warn(`lifecycle ledger post-compaction size check failed (non-fatal) for ${target.memoryDir}: ${err}`);
        return "failed";
      }
      if (rewrittenSize >= this.lifecycleLedgerMaxBytes) {
        log.warn(
          `lifecycle ledger auto-compaction ineffective for ${target.memoryDir}: rewritten `
          + `ledger is ${rewrittenSize}B, still at/over the ${this.lifecycleLedgerMaxBytes}-byte `
          + `read/decrypt cap; leaving the throttle un-armed to retry.`,
        );
        return "failed";
      }
      if (result.rewritten === false) {
        log.debug(
          `lifecycle ledger already compact for ${target.memoryDir}: ${rewrittenSize}B, `
          + `no rewrite needed (throttle armed to avoid re-archiving an unchanged ledger).`,
        );
      } else {
        log.info(
          `lifecycle ledger auto-compacted (${target.memoryDir}): ${size}B -> `
          + `${rewrittenSize}B, ${result.rebuiltRows} rows `
          + `(${result.preservedAppendOnlyRows ?? 0} append-only preserved, `
          + `${result.archivedOverflowRows ?? 0} overflow archived), `
          + `backup=${result.backupPath ?? "none"}`,
        );
      }
      return "compacted";
    } catch (err) {
      log.warn(
        `lifecycle ledger auto-compaction failed (non-fatal) for ${target.memoryDir}: ${err}`,
      );
      return "failed";
    }
  }

  private async namespaceMaintenancePlan(
    jobName: string,
  ): Promise<NamespaceMaintenancePlan> {
    return planNamespaceMaintenance(this.deps.config, {
      jobName,
      catalog: this.deps.namespaceCatalog,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.disposed = true;
    terminateScheduledProjectionRebuilds(this.projectionRebuild);
    const consolidationDrain = this.consolidationRunPromise;
    const activityDrain = this.activityRegistrar.dispose();
    const locationDrain = this.locationAutoSync?.stop() ?? Promise.resolve();
    this.locationAutoSync = null; const weeklyDrain = this.compoundingWeekly?.stop() ?? Promise.resolve(); this.compoundingWeekly = null;
    if (this.qmdMaintenanceTimer) {
      clearTimeout(this.qmdMaintenanceTimer);
      this.qmdMaintenanceTimer = null;
    }
    this.qmdMaintenancePending = false;
    this.qmdCompletion.abandon();
    await activityDrain;
    await locationDrain; await weeklyDrain;
    if (this.qmdMaintenanceTimer) {
      clearTimeout(this.qmdMaintenanceTimer);
      this.qmdMaintenanceTimer = null;
    }
    this.qmdMaintenancePending = false;
    if (consolidationDrain) await consolidationDrain;
  }
}
