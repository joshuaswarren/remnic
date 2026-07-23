/**
 * Maintenance scheduler — extracted from the orchestrator (issue #1526 PR1).
 *
 * Owns the WHEN of memory maintenance:
 *   - cron auto-registration (writes jobs.json entries the OpenClaw cron
 *     daemon picks up)
 *   - debounced + singleflight QMD index maintenance (re-index + embed
 *     after writes)
 *   - consolidation scheduling trigger (count + interval gated)
 *
 * Does NOT own the WHAT — the actual job runners (runSemanticConsolidation,
 * runPatternReinforcement, runDeepSleepGovernanceNow, runConsolidation)
 * remain on the orchestrator because they need the full LLM + extraction
 * dependency surface. The scheduler invokes consolidation through a
 * callback so the orchestrator stays the source of truth for that work.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps thin delegating methods so existing tests that stub
 * `orchestrator.requestQmdMaintenance` etc. continue to work.
 */

import { resolveNamespaceCapabilities,
  resolveQmdCapabilities,resolveConsolidationCapabilities, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import { existsSync, type Dirent } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
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
import {
  drainPendingLifecycleLedgerIfAny,
  pendingLifecycleLedgerDir,
  type LifecyclePendingIo,
} from "../storage/memory-lifecycle-ledger-access.js";
import { STATE_FILE_MAX_DECRYPT_BYTES } from "../storage/secure-line-reader.js";
import { ActivitySyncScheduler } from "../activity/scheduler.js";
import { refreshActivityIndex } from "../activity/reindex.js";
import { resolveHomeDir } from "../runtime/env.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { assertPathInsideRoot, listContainedSpillFiles } from "../utils/path-containment.js";
import {
  probeEncryptedRegularFileHeader,
  SECURE_STORE_ENVELOPE_OVERHEAD_BYTES,
} from "../secure-store/secure-fs.js";

/** Reason a QMD maintenance pass was skipped, used for status recording. */
function qmdMaintenanceSkipReasonForError(
  error: unknown,
): NamespaceMaintenanceSkipReason | null {
  const message = error instanceof Error ? error.message : String(error);
  return /^QMD (?:update|embed) skipped by .*min-interval gate$/.test(message)
    ? "throttled"
    : null;
}

/** Dependencies injected by the orchestrator. All stable references. */
export interface MaintenanceSchedulerDeps {
  config: PluginConfig;
  /** Live accessor — the orchestrator can reassign its qmd backend after
   *  construction (e.g. swap to NoopSearchBackend when the collection is
   *  missing), and the scheduler must always observe the current backend. */
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
}

/**
 * Schedules and debounces memory maintenance work. Owns the cadence +
 * singleflight state that previously lived as private orchestrator fields.
 *
 * The orchestrator constructs one instance in its constructor and delegates
 * the public scheduling entrypoints to it. Job execution stays on the
 * orchestrator (LLM-heavy) and is invoked through callbacks.
 */
export class MaintenanceScheduler {
  // ── Consolidation scheduling state ──
  private nonZeroExtractionsSinceConsolidation = 0;
  private lastConsolidationRunAtMs = 0;
  private consolidationInFlight = false;

  // ── QMD maintenance scheduling state ──
  private qmdMaintenanceTimer: NodeJS.Timeout | null = null;
  private qmdMaintenancePending = false;
  private qmdMaintenanceInFlight = false;
  private lastQmdEmbedAtMs = 0;
  private lastQmdEmbedAtMsByNamespace = new Map<string, number>();

  // ── Lifecycle-ledger auto-compaction state (issue #1910) ──
  private lifecycleCompactionInFlight = false;
  private lastLifecycleCompactionAtMs = 0;
  // Upper bound on a rewritten ledger; a preserving compaction is bounded to
  // this so it can never leave the ledger over the whole-file read/decrypt cap
  // (#2033). Defaults to the decrypt cap; overridable in focused tests to drive
  // the bounding + post-write verification deterministically without a 400MB
  // fixture.
  private lifecycleLedgerMaxBytes = STATE_FILE_MAX_DECRYPT_BYTES;

  // ── Activity (screen-capture) sync scheduler (issue #1900) ──
  private activitySyncScheduler: ActivitySyncScheduler | null = null;

  constructor(private readonly deps: MaintenanceSchedulerDeps) {}

  // ───────────────────────────────────────────────────────────────────────
  // Cron auto-registration
  // ───────────────────────────────────────────────────────────────────────

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

    // Activity (screen-capture) in-process sync scheduler (issue #1900).
    // Master default-off: start() arms nothing unless config.activity.enabled.
    // This is the parser -> scheduler -> durable-sync wire; the OpenClaw cron
    // daemon is not involved (host-agnostic, no OpenClaw import).
    // If teardown aborted deferred init while an earlier registration awaited,
    // dispose() has already run (with activitySyncScheduler still null), so
    // arming a timer now would leave an interval that never gets stopped.
    if (signal.aborted) return;
    try {
      this.activitySyncScheduler = new ActivitySyncScheduler({
        config: this.deps.config.activity,
        memoryDir: this.deps.config.memoryDir,
        intervalMs: this.deps.config.activity.autoSyncIntervalMinutes * 60_000,
        // Force a real, strict index refresh after each digest write (rule 31):
        // updateCollectionStrict bypasses the fail-open min-interval gate and
        // throws on a genuine failure rather than reporting a fake success, so a
        // freshly written digest is actually searchable. Reuses the core search
        // seam wearables use; no OpenClaw/host adapter.
        reindexSearch: () => refreshActivityIndex(this.deps.getQmd(), this.deps.config.qmdCollection),
      });
      this.activitySyncScheduler.start();
      // Close the race where abort fires between the guard above and start().
      if (signal.aborted) void this.activitySyncScheduler.stop();
    } catch (err) {
      log.debug(`activity sync scheduler start failed (non-fatal): ${err}`);
    }
  }

  async autoRegisterDaySummaryCron(): Promise<void> {
    const home = resolveHomeDir();
    const jobsPath = path.join(home, ".openclaw", "cron", "jobs.json");

    try {
      if (!existsSync(jobsPath)) {
        log.debug("day-summary cron: jobs.json not found, skipping auto-register");
        return;
      }

      // Resolve an OpenClaw cron-routing model only in gateway mode. In plugin
      // mode, summaryModel is a direct-client model id for Remnic's own LLM
      // calls and may be unroutable as an OpenClaw agentTurn model.
      const rawSummaryModel = this.deps.config.summaryModel;
      const taskPrimary = this.deps.config.taskModelChain?.primary;
      const isGateway = this.deps.config.modelSource === "gateway";
      const model = isGateway ? (rawSummaryModel || taskPrimary || undefined) : undefined;
      // Attach task-chain fallbacks only when the model matches the task-chain
      // primary. If summaryModel is a distinct override, its fallbacks would
      // be unrelated to the task chain. Also append gateway default models as
      // tail fallbacks (de-duped) so a task-chain outage doesn't stop the cron
      // before reaching the gateway default chain. Mirrors hourly cron pattern.
      const fallbacks: string[] = [];
      if (model && taskPrimary && model === taskPrimary) {
        const seen = new Set<string>(model ? [model] : []);
        const addUnique = (value: string | undefined) => {
          if (typeof value !== "string") return;
          const trimmed = value.trim();
          if (trimmed.length > 0 && !seen.has(trimmed)) {
            seen.add(trimmed);
            fallbacks.push(trimmed);
          }
        };
        for (const fb of this.deps.config.taskModelChain?.fallbacks ?? []) addUnique(fb);
        const gwDefaults = this.deps.config.gatewayConfig?.agents?.defaults?.model;
        addUnique(gwDefaults?.primary);
        if (Array.isArray(gwDefaults?.fallbacks)) {
          for (const fb of gwDefaults.fallbacks) addUnique(fb);
        }
      }

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
  // Consolidation scheduling
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Maybe trigger a background consolidation pass after an extraction.
   * Counted + interval gated so a burst of extractions does not fan into a
   * burst of consolidation passes. The consolidation runner itself is
   * passed in as a callback because it lives on the orchestrator (LLM +
   * storage dependency surface) and is not owned by this module.
   */
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
    if (this.consolidationInFlight) return;

    this.consolidationInFlight = true;
    this.lastConsolidationRunAtMs = now;
    this.nonZeroExtractionsSinceConsolidation = 0;
    runConsolidation()
      .catch((err) => log.error("background consolidation failed", err))
      .finally(() => {
        this.consolidationInFlight = false;
      });
  }

  /** Whether a background consolidation pass is currently running. Exposed so
   *  the orchestrator's waitForConsolidationIdle can poll idle state without
   *  owning the cadence state (issue #1526 PR1). */
  isConsolidationInFlight(): boolean {
    return this.consolidationInFlight;
  }

  /** Whether a debounced QMD maintenance pass is armed and waiting for the
   *  debounce timer. Exposed so drain/teardown diagnostics (e.g. the bench
   *  adapter) can observe scheduler idle state after the #1526 PR1 extraction
   *  moved this flag off the orchestrator. */
  isQmdMaintenancePending(): boolean {
    return this.qmdMaintenancePending;
  }

  /** Whether a QMD maintenance pass is currently running (singleflight guard).
   *  Exposed for drain/teardown diagnostics (see isQmdMaintenancePending). */
  isQmdMaintenanceInFlight(): boolean {
    return this.qmdMaintenanceInFlight;
  }
  // ───────────────────────────────────────────────────────────────────────
  // QMD maintenance scheduling (debounced + singleflight)
  // ───────────────────────────────────────────────────────────────────────

  /** Internal: queue a debounced QMD maintenance pass. */
  private requestQmdMaintenance(): void {
    if (!this.deps.getQmd().isAvailable()) return;
    if (!resolveQmdCapabilities(this.deps.config).qmdMaintenance) return;

    this.qmdMaintenancePending = true;
    if (this.qmdMaintenanceTimer) return;

    this.qmdMaintenanceTimer = setTimeout(() => {
      this.qmdMaintenanceTimer = null;
      this.runQmdMaintenance().catch((err) =>
        log.debug(`background qmd maintenance failed: ${err}`),
      );
    }, this.deps.config.qmdMaintenanceDebounceMs);
  }

  /**
   * Public entrypoint for tool-driven QMD maintenance requests.
   * Routes through existing debounced/singleflight maintenance controls.
   */
  requestQmdMaintenanceForTool(reason: string): void {
    try {
      this.requestQmdMaintenance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`qmd maintenance request failed (${reason}): ${msg}`);
    }
    // Lifecycle-ledger auto-compaction (#1910) must run independently of QMD.
    // When QMD is unavailable or its maintenance capability is off,
    // requestQmdMaintenance() short-circuits and runQmdMaintenance() never
    // fires — so a compaction check living only in that path would never run.
    // Fire it here on every maintenance request (throttled, size-gated,
    // single-flighted, never awaited, never throws) so a QMD-off deployment
    // still bounds the lifecycle ledger.
    void this.maybeCompactMemoryLifecycleLedger().catch((err) =>
      log.debug(`lifecycle ledger auto-compaction check failed (non-fatal): ${err}`),
    );
  }

  /** Internal: run a single QMD maintenance pass under singleflight guard. */
  async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;

    try {
      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        // Include cataloged dynamic namespaces, not just the configured set
        // (NGnei), but run through the namespace-aware maintenance planner so
        // each namespace is budgeted, lock-protected, and status-recorded
        // independently (issue #1500).
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
        await runNamespaceMaintenanceBatchPlan(
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
      } else {
        await this.deps.getQmd().update();
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
      this.qmdMaintenanceInFlight = false;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
      // Lifecycle-ledger auto-compaction is triggered from
      // requestQmdMaintenanceForTool (every maintenance request, QMD or not),
      // so it does not need to be re-fired here (issue #1910).
    }
  }

  /**
   * Size-gated, throttled, single-flighted auto-compaction of the lifecycle
   * ledger (issue #1910). Compacts the root ledger AND every namespace ledger
   * (`memoryDir/namespaces/<token>/state/`) when namespaces are enabled, each
   * through the existing `rebuildMemoryLifecycleLedger` so the
   * archive-then-atomic-write discipline is reused verbatim. `0` disables.
   *
   * Before compacting, drain EVERY target's durable pending-append spill (the
   * root ledger AND each namespace ledger) so a lifecycle event that spilled
   * while a prior long rewrite held the lock is folded back into its ledger and
   * cannot be silently lost (issue #2033). Draining is independent of both the
   * compaction threshold and the min-interval throttle: targets are enumerated
   * through the same safe (symlink/containment-checked) resolver and every
   * eligible queue is drained BEFORE any throttle return, so a namespace spill
   * created after the previous pass never waits out the whole interval.
   * Encrypted-store safety is preserved — a keyed target drains through its
   * secure StorageManager, a filesystem-fallback target only through a plaintext
   * context that refuses encrypted ledgers/spills. Work stays bounded: one
   * target enumeration plus a bounded per-queue drain.
   *
   * The min-interval throttle timestamp advances ONLY after real, fully
   * successful compaction work: a failed OR deferred target leaves the throttle
   * un-advanced so it stays eligible on the next maintenance pass, while
   * `lifecycleCompactionInFlight` still prevents overlapping runs. A "deferred"
   * target is oversized but could not be compacted because its encrypted ledger
   * has no unlocked secure store — arming the throttle for it would suppress the
   * retry of that still-oversized ledger for the whole interval (#2033).
   *
   * The min-interval throttle is bypassed for one case: an encrypted ledger
   * already at/over the whole-file decrypt cap is unreadable, so it must be
   * clamped on the next pass rather than wait out the interval. Ordinary
   * below-cap (or plaintext) targets stay throttled (#2033).
   */
  private async maybeCompactMemoryLifecycleLedger(): Promise<void> {
    // Enumerate every lifecycle target (root + namespaces) through the safe,
    // containment-checked resolver, and fold each one's durable pending spill
    // back into its ledger BEFORE any threshold or throttle return (#2033). A
    // spill created after the previous pass must land promptly even while
    // compaction is throttled or disabled; draining is bounded per queue and
    // never bypasses encrypted-store safety.
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
      // Throttled: no ordinary target is due yet. The exception is an encrypted
      // ledger already at/over the whole-file decrypt cap — it is unreadable, so
      // the global min-interval must not defer clamping it for a whole interval.
      // The guard above lets such a target through immediately (compaction then
      // clamps it via the cap-aware effective threshold) while ordinary
      // below-cap targets stay throttled (#2033).
      return;
    }
    // The over-cap probe above awaits, so a second maintenance request can pass
    // the early `lifecycleCompactionInFlight` guard and reach here during that
    // await. Recheck the guard immediately before claiming it — otherwise two
    // racing requests both see an over-cap ledger and run duplicate 400MB-class
    // compactions/backups back-to-back (#2033). The set below is synchronous
    // with this recheck (no await between), so exactly one caller wins.
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
      // Arm the throttle only when at least one ledger actually compacted AND
      // nothing failed AND nothing was deferred. A below-threshold no-op
      // (compacted === 0), any failure, or a deferred oversized ledger (locked
      // encrypted store, still pending) leaves the throttle where it was so the
      // next pass retries the untouched targets (#2033).
      if (compacted > 0 && failed === 0 && deferred === 0) {
        this.lastLifecycleCompactionAtMs = now;
      }
    } finally {
      this.lifecycleCompactionInFlight = false;
    }
  }

  /**
   * True when any lifecycle target's ledger is encrypted at rest AND its
   * on-disk size is at/over the whole-file decrypt cap. Such a ledger is already
   * unreadable (the secure reader refuses at/over the cap), so it must reach the
   * bounded compaction path on the next maintenance pass regardless of the
   * global min-interval throttle — otherwise the throttle could keep an
   * unreadable ledger un-clamped for a whole interval (#2033). Ordinary
   * below-cap or plaintext targets never match, so the throttle still governs
   * them. A stat/probe failure yields "no forced target" and is left to the
   * normal compaction path, which classifies it as failed and retries.
   */
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

  /**
   * Drain one compaction target's durable pending spill. A catalog-backed
   * target folds through its secure StorageManager; a filesystem-fallback
   * target (no storage) folds through a path-scoped plaintext context that
   * refuses encrypted ledgers/spills so a keyless drain never downgrades an
   * encrypted ledger (issue #2033).
   */
  private async drainPendingForTarget(
    target: { memoryDir: string; storage?: StorageManager },
  ): Promise<void> {
    if (target.storage) {
      await this.drainPendingLifecycleAppends(target.storage);
    } else {
      await this.drainPendingLifecycleAppendsForPath(target.memoryDir);
    }
  }

  /** Drain a target's durable pending lifecycle-append spill into its ledger
   *  (issue #2033); non-fatal and a fast no-op when nothing is pending. */
  private async drainPendingLifecycleAppends(storage: StorageManager | undefined): Promise<void> {
    if (!storage) return;
    try {
      await storage.drainPendingMemoryLifecycleEvents();
    } catch (err) {
      log.debug(`lifecycle pending drain failed (non-fatal): ${err}`);
    }
  }

  /**
   * Drain a filesystem-fallback target's pending lifecycle-append spill when no
   * secure StorageManager is available (catalog-disabled namespace; issue
   * #2033). Uses the safe path-scoped PLAINTEXT context this fallback already
   * operates in: a keyless drain can only fold plaintext spills into a plaintext
   * ledger, so it refuses when the ledger or ANY spill is encrypted at rest,
   * leaving those pending for a keyed (catalog-path) drain — exactly mirroring
   * the fallback compaction's encrypted-ledger deferral. Non-fatal; a fast
   * no-op when nothing is pending. The shared spill lister enforces the symlink/
   * containment guard on every spill file it reads or deletes.
   */
  private async drainPendingLifecycleAppendsForPath(memoryDir: string): Promise<void> {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    // Enumerate spills through the SAME guarded lister the actual drain uses
    // (listContainedSpillFiles): it rejects a symlinked/non-directory spill dir
    // and skips any symlink/FIFO/device/escaping entry, returning only regular
    // files contained in the dir. Never raw-readdir + open() an untrusted name:
    // opening a FIFO would block until a writer appears and a symlink would
    // redirect the probe outside the dir (#2033). Enumerate BOTH live `*.jsonl`
    // spills and crash-orphaned `*.jsonl.claimed` files: a drain that died
    // between claiming a spill (rename to `.claimed`) and committing it leaves
    // the ONLY copy of those rows as a claimed orphan. Gating solely on live
    // spills would early-return here whenever the pending dir holds nothing but
    // orphans, stranding those rows forever; proceeding lets
    // drainPendingLifecycleLedgerIfAny -> recoverOrphanedClaims restore and
    // re-commit them under the ledger lock (#2033).
    let spillFiles: string[];
    let claimedOrphans: string[];
    try {
      spillFiles = await listContainedSpillFiles(spillDir);
      claimedOrphans = await listContainedSpillFiles(spillDir, ".jsonl.claimed");
    } catch (err) {
      log.debug(`fallback lifecycle pending scan failed (non-fatal) for ${memoryDir}: ${err}`);
      return;
    }
    if (spillFiles.length === 0 && claimedOrphans.length === 0) return;
    // The pending encryption state is authoritative only UNDER the ledger lock:
    // drainPendingLifecycleLedgerIfAny waits for the lock and re-enumerates the
    // pending dir, so a secure-store writer that spills an encrypted file — or a
    // keyed compaction that rewrites the ledger encrypted — while this fallback
    // waits would defeat any pre-lock probe (#2033). Probe each file at the
    // moment of use inside the held lock instead: readSecure refuses an
    // encrypted spill (the fold reads each spill lazily and propagates the throw
    // BEFORE claiming that spill, leaving it intact) and the append refuses a
    // ledger that became encrypted (the fold rolls the claims back). Either way
    // the plaintext IO
    // never reads or writes ciphertext; the keyed catalog-path drain handles the
    // deferred rows.
    const io: LifecyclePendingIo = {
      writeSecure: async (filePath, payload) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, payload, "utf-8");
      },
      readSecure: async (filePath) => {
        if (await probeEncryptedRegularFileHeader(filePath)) {
          throw new Error(`fallback lifecycle drain deferred: encrypted spill at ${filePath}`);
        }
        return readFile(filePath, "utf-8");
      },
    };
    try {
      await drainPendingLifecycleLedgerIfAny(
        ledgerPath,
        io,
        async (payload) => {
          if (await probeEncryptedRegularFileHeader(ledgerPath)) {
            throw new Error(`fallback lifecycle drain deferred: ledger became encrypted at ${ledgerPath}`);
          }
          await appendFile(ledgerPath, payload, "utf-8");
        },
        async () => {
          await mkdir(path.dirname(ledgerPath), { recursive: true });
        },
      );
    } catch (err) {
      log.debug(`fallback lifecycle pending drain failed (non-fatal) for ${memoryDir}: ${err}`);
    }
  }

  /**
   * Enumerate the lifecycle ledgers to consider for compaction: the root
   * (through the secure-configured root storage when available) plus every
   * cataloged namespace ledger when namespaces are enabled. Deduplicated by
   * resolved storage dir so a namespace that collapses onto the root is not
   * compacted twice. Namespace resolution failures are non-fatal.
   */
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

    // Filesystem fallback (codex P2): when namespaces are enabled but the
    // catalog is disabled (namespaceCatalogEnabled=false) — or a namespace is
    // not yet cataloged — the catalog walk above finds nothing, yet per-namespace
    // ledgers still grow under <memoryDir>/namespaces/<token>/state/. Scan that
    // base directly so those ledgers are still bounded. Deduped by resolved dir,
    // so a namespace already added via the catalog is not compacted twice.
    if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
      const namespacesBase = path.join(this.deps.config.memoryDir, "namespaces");
      // Symlink/traversal containment (issue #2033 codex P2): a symlinked
      // <memoryDir>/namespaces (or a symlinked child) must not redirect the scan
      // — and later backup/ledger rewrites — outside memoryDir. Resolve the
      // memory root and the scan base through realpath, reject a symlinked or
      // escaping base, and skip any symlinked/escaping child, mirroring the
      // memory-store walkers' hardening (utils/path-containment).
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
        // Resolve the namespace's secure-store-aware storage so an encrypted
        // fallback ledger compacts through the correct root key/context instead
        // of deferring forever behind a keyless plaintext StorageManager (#2033
        // thread PRRT_kwDORJXyws6SE5fv). The on-disk dir name is EITHER a
        // namespace identity TOKEN (ns-<hex>) OR a legacy raw namespace dir name
        // written before tokenization (namespaces/<name>/). Decode a token back
        // to its canonical namespace; treat a non-token dir as a raw namespace
        // only when it is a safe route namespace (isSafeRouteNamespace), so a
        // garbage/traversal dir name is never handed to the resolver. Passing the
        // raw token to the resolver would re-tokenize an already-tokenized value
        // and (for namespaces longer than 30 bytes) exceed the router's 64-char
        // safe-route limit, so the resolver throws and the encrypted over-cap
        // ledger defers forever — hence decode first. Resolve the route namespace
        // and accept the keyed storage only when it roots at THIS dir: the secure
        // store keys one master key per memory ROOT (not per namespace), the
        // router routes a token to namespaces/<token>/ and an existing legacy raw
        // name to its namespaces/<name>/ root, so a correct resolve returns THIS
        // childPath; anything else is an unexpected re-route we refuse (keeping
        // namespace isolation and never compacting the wrong ledger). A dir that
        // neither decodes nor is a safe raw namespace, or no resolver wired
        // (focused tests / plaintext deployments), leaves the keyless target
        // standing: the rebuild chokepoint still refuses to downgrade an
        // encrypted ledger, so plaintext behavior holds.
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

  /**
   * Compact one lifecycle ledger when it is at/over `threshold`. Returns
   * `"skipped"` (absent or below threshold — nothing to do), `"compacted"`
   * (rewritten and verified under the read/decrypt cap), `"failed"`
   * (rebuild/probe threw, or the rewritten ledger is STILL over the cap — an
   * ineffective compaction — non-fatal, retried next pass), or `"deferred"`
   * (oversized but its encrypted ledger cannot be rewritten because no unlocked
   * secure store is available — real work still pending, so the caller must NOT
   * arm the throttle). #2033: a deferred/failed target is distinct from a genuine
   * no-op so one namespace compacting cannot suppress retries for another, and
   * an over-cap rewrite never arms the throttle.
   */
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
    // #2033 finding (1): an encrypted ledger becomes unreadable once its on-disk
    // size reaches the whole-file decrypt cap (the reader refuses at/over it), so
    // the effective compaction trigger for an encrypted target is clamped to that
    // cap even when the configured threshold is LARGER — otherwise a ledger that
    // grows past the cap but stays below a bigger threshold would never compact
    // and stay permanently unreadable. Plaintext streaming is unaffected at any
    // size, so a plaintext target keeps the configured threshold. The cheap
    // pre-check skips anything below the smaller of the two before paying for the
    // extra lstat/open the encryption probe costs.
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
    // No plaintext rewrite of an encrypted-at-rest ledger (#2033): rebuilding an
    // encrypted ledger without an unlocked secure StorageManager would either
    // fail the preserve-read (locked store) or downgrade the ledger to plaintext.
    // Report "deferred" (NOT "skipped"): the ledger is over threshold and still
    // needs compaction, so the throttle must stay un-armed and retry once a key
    // is available — a "skipped" here would let another target's success arm the
    // throttle and suppress this pending work for the whole interval (#2033).
    if (encrypted && !(target.storage?.isSecureStoreUnlocked() ?? false)) {
      log.warn(
        `lifecycle ledger at ${ledgerPath} is encrypted at rest but no unlocked secure `
        + `storage is available; deferring auto-compaction to avoid a plaintext rewrite. `
        + `Run 'remnic rebuild-memory-lifecycle-ledger --write' after unlocking.`,
      );
      return "deferred";
    }
    // #2033 findings (2)+(4): the rewrite budget bounds the PLAINTEXT payload, but
    // an encrypted-at-rest target adds a fixed secure-store envelope on disk.
    // Reserve that envelope (plus one byte) from the plaintext budget so the
    // encrypted file lands STRICTLY below the reader's refusal cap and the
    // post-write check — which stats the on-disk (encrypted) size against the cap
    // — cannot fail forever on a plaintext budget that equals the cap (the
    // endless-retry bug). Base this on whether the REPLACEMENT will be encrypted
    // (the storage write mode), NOT only on the current file header: a
    // plaintext ledger rewritten under `secureStoreEncryptOnWrite` with the key
    // set becomes encrypted, so it needs the reserve even though its current
    // header is plaintext (#2033 write-mode finding).
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
        // Background compaction must not lose append-only history that
        // frontmatter cannot reconstruct (issue #1910); the manual CLI repair
        // rebuild now preserves and bounds identically (#2033).
        preserveExistingEvents: true,
        // Bound the PLAINTEXT rewrite to a budget that reserves the secure-store
        // envelope, so the on-disk ledger (plaintext, or plaintext+envelope when
        // encrypted) is strictly below the read/decrypt cap; overflow lands in
        // the verbatim backup (#2033 findings 2+4).
        maxLedgerBytes: plaintextBudget,
      });
      // Verify the rewritten ledger is actually bounded. A compaction that left
      // the ledger at/over the read/decrypt cap is ineffective (the ledger would
      // be unreadable) — report "failed" so the throttle stays un-armed and the
      // next pass retries rather than declaring success (#2033).
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
        // No-op pass (#2033 thread PRRT_kwDORJXyws6SExst): a preserving rebuild
        // would reproduce the current ledger byte-for-byte, so it skipped the
        // backup+rewrite. The ledger stays over the trigger but under the cap;
        // report "compacted" so the throttle still arms (nothing more can be
        // done until the ledger grows), which stops the periodic re-archive/
        // rewrite churn the review flagged — the archive no longer grows.
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

  /** Build the namespace-aware maintenance plan for one job. */
  private async namespaceMaintenancePlan(
    jobName: string,
  ): Promise<NamespaceMaintenancePlan> {
    return planNamespaceMaintenance(this.deps.config, {
      jobName,
      catalog: this.deps.namespaceCatalog,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Clear any pending debounce timer and drain the activity sync scheduler.
   * Called from the orchestrator's destroy() so a late tick does not fire on a
   * torn-down instance and no in-flight activity tick keeps writing after
   * teardown. Async: awaits the scheduler's abort+drain before resolving.
   */
  async dispose(): Promise<void> {
    // stop() aborts the in-flight sync and clears its timer synchronously;
    // capture the drain and await it at the end so the rest of teardown runs
    // concurrently while the aborted tick unwinds.
    const activityDrain = this.activitySyncScheduler?.stop();
    if (this.qmdMaintenanceTimer) {
      clearTimeout(this.qmdMaintenanceTimer);
      this.qmdMaintenanceTimer = null;
    }
    this.qmdMaintenancePending = false;
    await activityDrain;
  }
}
