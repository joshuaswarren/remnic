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
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "../search/port.js";
import type { StorageManager } from "../index.js";
import {
  NamespaceSearchRouter,
  type NamespaceUpdateResult,
} from "../namespaces/search.js";
import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
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
import { resolveHomeDir } from "../runtime/env.js";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";

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
  async autoRegisterCrons(_signal: AbortSignal): Promise<void> {
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
   * The min-interval throttle timestamp advances ONLY after real, fully
   * successful compaction work (Cursor Medium): a failed target leaves the
   * throttle un-advanced so it stays eligible on the next maintenance pass,
   * while `lifecycleCompactionInFlight` still prevents overlapping runs.
   */
  private async maybeCompactMemoryLifecycleLedger(): Promise<void> {
    const threshold = this.deps.config.memoryLifecycleLedgerCompactBytes;
    if (!(threshold > 0)) return; // 0 / negative / non-numeric disables compaction.
    if (this.lifecycleCompactionInFlight) return;
    const now = Date.now();
    if (
      now - this.lastLifecycleCompactionAtMs <
      this.deps.config.memoryLifecycleLedgerCompactMinIntervalMs
    ) {
      return;
    }
    this.lifecycleCompactionInFlight = true;
    try {
      let compacted = 0;
      let failed = 0;
      for (const target of await this.resolveLifecycleCompactionTargets()) {
        const outcome = await this.compactLifecycleLedgerTarget(target, threshold);
        if (outcome === "compacted") compacted += 1;
        else if (outcome === "failed") failed += 1;
      }
      // Arm the throttle only when at least one ledger was actually compacted and
      // nothing failed. A below-threshold no-op (compacted === 0) or any failure
      // leaves the throttle where it was so the next pass retries.
      if (compacted > 0 && failed === 0) {
        this.lastLifecycleCompactionAtMs = now;
      }
    } finally {
      this.lifecycleCompactionInFlight = false;
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
      let entries: Dirent[] = [];
      try {
        entries = await readdir(namespacesBase, { withFileTypes: true });
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) {
          log.debug(`lifecycle compaction: namespaces dir scan failed (non-fatal): ${err}`);
        }
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        addTarget(path.join(namespacesBase, entry.name));
      }
    }
    return targets;
  }

  /**
   * Compact one lifecycle ledger when it is at/over `threshold`. Returns
   * `"skipped"` (absent or below threshold), `"compacted"` (rewritten), or
   * `"failed"` (rebuild threw — kept non-fatal and eligible to retry).
   */
  private async compactLifecycleLedgerTarget(
    target: { memoryDir: string; storage?: StorageManager },
    threshold: number,
  ): Promise<"skipped" | "compacted" | "failed"> {
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
    if (size < threshold) return "skipped";
    try {
      const result = await rebuildMemoryLifecycleLedger({
        memoryDir: target.memoryDir,
        dryRun: false,
        storage: target.storage,
        // Background compaction must not lose append-only history that
        // frontmatter cannot reconstruct (issue #1910) — unlike the manual
        // CLI repair rebuild, which reconstructs purely from frontmatter.
        preserveExistingEvents: true,
      });
      log.info(
        `lifecycle ledger auto-compacted (${target.memoryDir}): ${size}B -> `
        + `${result.rebuiltRows} rows `
        + `(${result.preservedAppendOnlyRows ?? 0} append-only preserved), `
        + `backup=${result.backupPath ?? "none"}`,
      );
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
   * Clear any pending debounce timer. Called from the orchestrator's
   * destroy() so a late tick does not fire on a torn-down instance.
   */
  dispose(): void {
    if (this.qmdMaintenanceTimer) {
      clearTimeout(this.qmdMaintenanceTimer);
      this.qmdMaintenanceTimer = null;
    }
    this.qmdMaintenancePending = false;
  }
}
