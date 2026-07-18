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
import { existsSync } from "node:fs";
import path from "node:path";

import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "../search/port.js";
import {
  NamespaceSearchRouter,
  type NamespaceUpdateResult,
} from "../namespaces/search.js";
import type { NamespaceCatalog } from "../namespaces/catalog.js";
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
import { resolveHomeDir } from "../runtime/env.js";
import { log } from "../logger.js";
import { clearQmdResultCaches } from "../memory-cache.js";

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
  }

  /** Internal: run a single QMD maintenance pass under singleflight guard. */
  async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;

    let didUpdate = false;
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
        // Only a real per-namespace update makes new facts searchable; if every
        // namespace was skipped (throttle / lock_held) no index changed, so there
        // is nothing to invalidate and we keep the warm QMD caches (#1904, Codex).
        didUpdate = summary.ran > 0;
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
        didUpdate = true;
      }
      // A successful update+embed means newly-persisted facts are now searchable;
      // any cached pre-index QMD recall/search bundle is now stale. Clear ONLY the
      // QMD result caches (dir-scoped layers untouched) — but only when an index
      // actually changed, so a fully-skipped (throttled) pass keeps them warm
      // (#1904, Codex).
      if (didUpdate) clearQmdResultCaches();
    } finally {
      this.qmdMaintenanceInFlight = false;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
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
