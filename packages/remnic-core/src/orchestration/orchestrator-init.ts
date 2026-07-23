/**
 * Orchestrator-init coordinator — extracted from the orchestrator
 * (issue #1526, seam 22).
 *
 * Owns the startup lifecycle:
 *   - initialize(): directory/storage/alias/policy bring-up and the
 *     init gate that recall() awaits
 *   - deferredInitialize(): background QMD probe, warmup, caches, cron
 *     wiring, and the deferredReady gate
 *   - startupSearchSync(): the initial search-index reconciliation
 *
 * Behavior-preserving move from orchestrator.ts. The async init ORDERING
 * is part of the gateway_start contract — the move keeps every await in
 * place and mutates the orchestrator's own gate fields (initPromise,
 * deferredReady, resolveDeferredReady, deferredInitAbort,
 * deferredSyncSucceeded, …) through live get/set accessors, so
 * stop/start reuse of one Orchestrator instance behaves identically.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { SmartBuffer } from "../buffer.js";
import { resolveIndexingCapabilities, resolveLocalLlmCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolveQmdCapabilities, resolveRecallAuxiliaryCapabilities, resolveUtilityLearningCapabilities } from "../capabilities.js";
import { CompoundingEngine } from "../compounding/engine.js";
import type { ConversationIndexBackend } from "../conversation-index/backend.js";
import type { CorrectionService } from "../correction/correction-service.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { ContentHashIndex, StorageManager } from "../index.js";
import { log } from "../logger.js";
import { migrateFromEngram } from "../migrate/from-engram.js";
import { NamespaceCatalog } from "../namespaces/catalog.js";
import { NamespaceSearchRouter } from "../namespaces/search.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { NegativeExampleStore } from "../negative.js";
import { MaintenanceScheduler } from "./maintenance.js";
import { PolicyRuntimeManager, type RuntimePolicyValues } from "../policy-runtime.js";
import { LastRecallStore, RecallHandleHistoryStore, TierMigrationStatusStore } from "../recall-state.js";
import { RelevanceStore } from "../relevance.js";
import { NoopSearchBackend } from "../search/noop-backend.js";
import type { SearchBackend } from "../search/port.js";
import { SessionObserverState } from "../session-observer-state.js";
import { SharedContextManager } from "../shared-context/manager.js";
import { HourlySummarizer } from "../summarizer.js";
import { TranscriptManager } from "../transcript.js";
import type { PluginConfig } from "../types.js";
import { type UtilityRuntimeValues, loadUtilityRuntimeValues } from "../utility-runtime.js";
import { WearablesService } from "../wearables/service.js";
import type { MeetingsService } from "../meetings/service.js";
import {
  COMPACTION_SIGNAL_MAX_AGE_MS,
  defaultWorkspaceDir,
  qmdStartupCollectionCheckWithTimeout,
} from "../orchestrator.js";

export interface OrchestratorInitDeps {
  readonly buffer: SmartBuffer;
  readonly compounding?: CompoundingEngine;
  readonly config: PluginConfig;
  configuredNamespaceList(): string[];
  contentHashIndex: ContentHashIndex | null;
  readonly conversationIndexBackend?: ConversationIndexBackend;
  deferredInitAbort: AbortController | null;
  deferredInitialize(signal: AbortSignal): Promise<void>;
  deferredReady: Promise<void>;
  deferredSyncSucceeded: boolean;
  disposeSearchBackendIfNeeded(): Promise<void>;
  readonly embeddingFallback: EmbeddingFallback;
  getWearablesService(): WearablesService;
  getMeetingsService(): Promise<MeetingsService>;
  readonly handleHistory: RecallHandleHistoryStore;
  readonly lastRecall: LastRecallStore;
  maintenanceNamespaces(
    jobName?: string,
    budgetMode?: "cycle" | "unbounded",
  ): Promise<string[]>;
  readonly maintenanceScheduler: MaintenanceScheduler;
  readonly namespaceCatalog: NamespaceCatalog;
  readonly namespaceSearchRouter: NamespaceSearchRouter;
  readonly negatives: NegativeExampleStore;
  passiveCorrectionService(): CorrectionService;
  readonly policyRuntime: PolicyRuntimeManager;
  qmd: SearchBackend;
  readonly relevance: RelevanceStore;
  resolveDeferredReady: (() => void) | null;
  resolveInit: (() => void) | null;
  runtimePolicyValues: RuntimePolicyValues | null;
  readonly sessionObserver: SessionObserverState;
  readonly sharedContext?: SharedContextManager;
  readonly storage: StorageManager;
  readonly storageRouter: NamespaceStorageRouter;
  readonly summarizer: HourlySummarizer;
  readonly tierMigrationStatus: TierMigrationStatusStore;
  readonly transcript: TranscriptManager;
  utilityRuntimeValues: UtilityRuntimeValues | null;
  validateLocalLlmModel(): Promise<void>;
  wearablesAutoSyncHandle: { stop(): Promise<void> } | null;
}

export class OrchestratorInitCoordinator {
  constructor(
    private readonly deps: OrchestratorInitDeps,
  ) {}

  async initialize(): Promise<void> {
    // Recreate the deferred-ready gate on every initialize() call.
    // The same Orchestrator instance may be reused across stop/start cycles
    // (src/index.ts does this). Without this reset, the second cycle's
    // `await orchestrator.deferredReady` resolves immediately (already settled
    // from the first cycle) while the new deferredInitialize() is still running.
    this.deps.deferredReady = new Promise<void>((resolve) => {
      this.deps.resolveDeferredReady = resolve;
    });

    try {
      await migrateFromEngram({
        quiet: true,
        logger: (message) => log.info(message),
      });
      await this.deps.storage.ensureDirectories();
      await this.deps.storage.loadAliases();
      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        const namespaces = new Set<string>([
          this.deps.config.defaultNamespace,
          this.deps.config.sharedNamespace,
          ...this.deps.config.namespacePolicies.map((p) => p.name),
        ]);
        for (const ns of namespaces) {
          const sm = await this.deps.storageRouter.storageFor(ns);
          await sm.ensureDirectories();
          await sm.loadAliases().catch(() => undefined);
        }
        // Explicitly seed the catalog with all configured namespaces at startup
        // (round 6, cursor Medium — NBLlR). The storageFor loop above fires the
        // router's onResolve hook, but a warm router cache (reused instance
        // across stop/start) can skip onResolve, leaving policy namespaces absent
        // from the live catalog until an operator runs `rebuild --apply`. This
        // call is cheap, idempotent, and best-effort: a catalog failure must
        // never break initialization (rule #13, #40).
        await this.deps.namespaceCatalog.registerConfiguredNamespaces().catch(() => undefined);
      }
      // #1713 Item 2: recover stale `applying` correction plans left behind
      // by a process that died mid-apply. Best-effort — a failure here must
      // never block initialization (rule 13). Runs for every configured
      // namespace since correction plans can exist in any of them.
      try {
        // #1713 Item 2 + P2 (cursor): sweep ALL known namespaces — configured
        // + catalog-discovered — so stale applying plans in derived namespaces
        // (coding-scoped, session-derived) are also recovered.
        const correctionNamespaces = new Set(this.deps.configuredNamespaceList());
        if (this.deps.namespaceCatalog.enabled) {
          try {
            for (const rec of await this.deps.namespaceCatalog.listNamespaces()) {
              correctionNamespaces.add(rec.namespace);
            }
          } catch { /* best-effort */ }
        }
        const recovered = await this.deps.passiveCorrectionService().recoverStaleApplyingPlans(
          [...correctionNamespaces],
        );
        if (recovered > 0) {
          log.info(`correction: recovered ${recovered} stale applying plan(s) on startup`);
        }
      } catch (staleErr) {
        log.debug(`correction: stale-plan recovery skipped: ${staleErr instanceof Error ? staleErr.message : String(staleErr)}`);
      }
      await this.deps.relevance.load();
      await this.deps.negatives.load();
      await this.deps.lastRecall.load();
      await this.deps.handleHistory.load();
      await this.deps.tierMigrationStatus.load();
      await this.deps.sessionObserver.load();
      this.deps.runtimePolicyValues = await this.deps.policyRuntime.loadRuntimeValues();
      this.deps.utilityRuntimeValues = await loadUtilityRuntimeValues({
        memoryDir: this.deps.config.memoryDir,
        memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(this.deps.config).memoryUtilityLearning,
        promotionByOutcomeEnabled: resolveUtilityLearningCapabilities(this.deps.config).promotionByOutcome,
      });

      // Initialize the content-hash dedup index from the corpus-AUTHORITATIVE
      // rebuild (issue #1909 review round 12) rather than a raw, possibly-stale
      // fact-hashes.txt load — the orchestrator dedup layer and StorageManager
      // share this one instance so a crash before a deferred batch save cannot
      // leave the restart's dedup blind to a durable fact.
      if (resolveRecallAuxiliaryCapabilities(this.deps.config).factDeduplication) {
        try {
          this.deps.contentHashIndex = await this.deps.storage.getAuthoritativeFactHashIndex();
          log.info(
            `content-hash dedup: rebuilt authoritative index with ${this.deps.contentHashIndex.size} hashes`,
          );
        } catch (err) {
          // PR #2016: the locked corpus rebuild could not run at init (transient
          // cross-process contention). Pre-warm with the shared instance instead
          // of failing init; the dedup consumers gate a MISS on
          // isFactContentHashAuthoritative() and confirm against the corpus until
          // a later rebuild acquires the lock.
          this.deps.contentHashIndex = await this.deps.storage.getSharedFactHashIndex();
          log.warn(
            `content-hash dedup: authoritative rebuild deferred at init (${err instanceof Error ? err.message : String(err)}); ` +
              `using the shared index, will retry the locked rebuild on next use`,
          );
        }
      }
      await this.deps.transcript.initialize();
      await this.deps.summarizer.initialize();
      if (this.deps.sharedContext) {
        await this.deps.sharedContext.ensureStructure();
      }
      if (this.deps.compounding) {
        await this.deps.compounding.ensureDirs();
      }

      // Buffer and compaction cleanup are fast and needed for basic operation —
      // load them before the init gate so turn buffering works immediately.
      try {
        await this.deps.buffer.load();
      } catch (bufErr) {
        log.error(
          `buffer.load() failed (init gate will still open): ${bufErr}`,
        );
        this.deps.buffer.resetToEmpty();
      }
      if (resolveRecallAuxiliaryCapabilities(this.deps.config).compactionReset) {
        try {
          const wsDir = this.deps.config.workspaceDir || defaultWorkspaceDir();
          const files = await readdir(wsDir).catch(() => [] as string[]);
          for (const f of files) {
            if (!f.startsWith(".compaction-reset-signal-")) continue;
            const fp = path.join(wsDir, f);
            const s = await stat(fp).catch(() => null);
            if (s && Date.now() - s.mtimeMs >= COMPACTION_SIGNAL_MAX_AGE_MS) {
              await unlink(fp).catch(() => {});
              log.debug(`initialize: removed stale compaction signal ${f}`);
            }
          }
        } catch (err) {
          log.debug("initialize: stale signal sweep failed:", err);
        }
      }

      // QMD probe + collection check: determines the final QMD state (real
      // client vs NoopSearchBackend). Must complete BEFORE the init gate opens
      // so that recall() — which awaits initPromise — always observes the final
      // QMD state. Without this ordering, a concurrent recall() could read
      // this.deps.qmd while it's still the real client, then get errors when
      // deferredInitialize() swaps it to NoopSearchBackend mid-query.
      try {
        const available = await this.deps.qmd.probe();
        if (available) {
          log.info(`Search backend: available ${this.deps.qmd.debugStatus()}`);
          // Ensure collections at startup for the catalog-union namespace set, not
          // just the configured set (issue #1499 sweep, same class as NHZEV): a
          // dynamic namespace that exists only in the persisted catalog must have
          // its QMD collection checked/ensured on boot so recall against it works
          // after a restart. `registerConfiguredNamespaces()` already seeded the
          // catalog above, so `maintenanceNamespaces()` is readable here; it falls
          // back to the configured set on any catalog read failure.
          const namespaces = resolveNamespaceCapabilities(this.deps.config).namespaces
            ? await this.deps.maintenanceNamespaces()
            : [this.deps.config.defaultNamespace];
          const states = await Promise.all(
            namespaces.map(async (namespace) => {
              const collectionCheckAbort = new AbortController();
              const state = await qmdStartupCollectionCheckWithTimeout(
                resolveNamespaceCapabilities(this.deps.config).namespaces
                  ? this.deps.namespaceSearchRouter.ensureNamespaceCollection(
                      namespace,
                      { signal: collectionCheckAbort.signal },
                    )
                  : this.deps.qmd.ensureCollection(
                      this.deps.config.memoryDir,
                      this.deps.config.qmdCollection,
                      { signal: collectionCheckAbort.signal },
                    ),
                collectionCheckAbort,
                namespace,
              );
              return { namespace, state };
            }),
          );
          const defaultState =
            states.find(
              (entry) => entry.namespace === this.deps.config.defaultNamespace,
            )?.state ?? "unknown";
          if (defaultState === "missing") {
            await this.deps.disposeSearchBackendIfNeeded();
            this.deps.qmd = new NoopSearchBackend();
            log.warn(
              "Search collection missing for Remnic memory store; disabling search retrieval for this runtime (fallback retrieval remains enabled)",
            );
          } else if (defaultState === "unknown") {
            log.warn(
              "Search collection check unavailable; keeping search retrieval enabled for fail-open behavior",
            );
          } else if (defaultState === "skipped") {
            log.debug(
              "Search collection check skipped (remote or daemon-only mode)",
            );
          }
          for (const entry of states) {
            if (entry.namespace === this.deps.config.defaultNamespace) continue;
            if (entry.state === "missing") {
              log.warn(
                `Search collection missing for namespace '${entry.namespace}'; namespace retrieval will fail open to non-search paths`,
              );
            }
          }
        } else if (this.deps.qmd instanceof NoopSearchBackend) {
          log.debug(`Search backend: noop (search intentionally disabled)`);
        } else {
          log.warn(`Search backend: not available ${this.deps.qmd.debugStatus()}`);
        }
      } catch (err) {
        log.error(`QMD probe/collection check failed (non-fatal): ${err}`);
      }

      // Open the init gate — essential state (storage, aliases, relevance,
      // transcript, summarizer, buffer) is loaded AND QMD state is finalized
      // (probe + collection check complete, NoopSearchBackend swap done if
      // needed). Warmup, sync, caches, and remaining heavy operations run in
      // the background after this point via deferredInitialize().
      if (this.deps.resolveInit) {
        this.deps.resolveInit();
        this.deps.resolveInit = null;
        log.info("init gate opened (essential state + QMD state loaded)");
      }

      // Deferred init: QMD sync, warmup, conversation index, caches, cron.
      // Runs in background so gateway_start returns fast. On low-power hardware
      // (Umbrel, RPi) QMD warmup/sync alone can take 30-60s and cause gateway
      // restart loops when they block the startup path. See issue #462.
      // Note: QMD probe + collection check (including NoopSearchBackend swap)
      // already ran above before the init gate, so this.deps.qmd is finalized.
      //
      // Capture the resolver by value so a concurrent re-initialize() cannot
      // overwrite this.deps.resolveDeferredReady before .finally() runs — that would
      // cause the first cycle's .finally() to resolve the *second* cycle's
      // promise prematurely while leaving the first cycle's promise pending.
      const resolveDeferred = this.deps.resolveDeferredReady;
      this.deps.resolveDeferredReady = null;
      this.deps.deferredInitAbort = new AbortController();
      this.deps.deferredInitialize(this.deps.deferredInitAbort.signal)
        .catch((err) => {
          log.error(`deferred initialization failed (non-fatal): ${err}`);
        })
        .finally(() => {
          resolveDeferred?.();
        });
    } catch (err) {
      // Resolve both gates so callers never hang on permanently-pending promises
      // after catching the initialize() error:
      //
      // - initPromise: recall(), generateDaySummary(), etc. await this as a
      //   readiness gate with a 15s timeout. Leaving it pending means every
      //   subsequent call pays that timeout penalty.
      //
      // - deferredReady: CLI callers await this for full QMD readiness. Without
      //   resolution it hangs forever since deferredInitialize() never ran.
      if (this.deps.resolveInit) {
        this.deps.resolveInit();
        this.deps.resolveInit = null;
      }
      if (this.deps.resolveDeferredReady) {
        this.deps.resolveDeferredReady();
        this.deps.resolveDeferredReady = null;
      }
      throw err;
    }
  }

  async deferredInitialize(signal: AbortSignal): Promise<void> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.deps.config);

    // Sync QMD index with current disk state so recall finds recently-written
    // facts. Without this, the index stays stale from the last extraction-
    // triggered update — which can be days ago if the daemon restarted without
    // new extractions. This is the root cause of "0 memories" recall results
    // despite thousands of facts on disk.
    if (this.deps.qmd.isAvailable() && resolveQmdCapabilities(this.deps.config).qmdMaintenance) {
      try {
        log.info("QMD startup sync: updating index to match current disk state");
        if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
          // Cover cataloged dynamic namespaces at startup too (NHZEV, codex P2):
          // a dynamic namespace written before a daemon restart must be synced on
          // boot, not only by the debounced runQmdMaintenance() path. Same union +
          // catalog-read-failure fallback as runQmdMaintenance.
          await this.deps.namespaceSearchRouter.updateNamespaces(
            await this.deps.maintenanceNamespaces(),
            { signal },
          );
        } else {
          await this.deps.qmd.update({ signal });
        }
        log.info("QMD startup sync: complete");
        this.deps.deferredSyncSucceeded = true;
      } catch (err) {
        log.warn(`QMD startup sync failed (non-fatal): ${err}`);
        // deferredSyncSucceeded stays false — server retry will attempt sync
      }
    } else if (!(this.deps.qmd.isAvailable())) {
      // QMD not available at deferred init time — server retry will handle it
    } else {
      // QMD available but maintenance disabled — consider sync not needed
      this.deps.deferredSyncSucceeded = true;
    }

    if (signal.aborted) return;

    // Warmup: run cheap searches to pre-load QMD embedding models and the
    // embedding-fallback JSON index so the first real recall is fast.
    const warmupPromises: Promise<void>[] = [];
    if (this.deps.qmd.isAvailable()) {
      const warmupNs = this.deps.config.defaultNamespace;
      log.info("QMD warmup: pre-loading models with a test search");
      warmupPromises.push(
        this.deps.qmd
          .search("warmup", warmupNs, 1, undefined, { signal })
          .then(() => {
            log.info("QMD warmup: complete");
          })
          .catch((err) => {
            log.debug(`QMD warmup search failed (non-fatal): ${err}`);
          }),
      );
    }
    if (resolveMemoryLifecycleCapabilities(this.deps.config).embeddingFallback) {
      warmupPromises.push(
        this.deps.embeddingFallback
          .isAvailable()
          .then((ok) => {
            log.info(
              `Embedding fallback warmup: ${ok ? "available" : "unavailable (no provider)"}`,
            );
          })
          .catch((err) => {
            log.debug(`Embedding fallback warmup failed (non-fatal): ${err}`);
          }),
      );
    }
    await Promise.all(warmupPromises);
    if (signal.aborted) return;

    // Pre-warm knowledge index, memory, and entity caches.
    // Awaited so callers of `deferredReady` can rely on warmups being complete
    // and shutdown sequencing does not race with in-flight cache builds.
    const cacheWarmups: Promise<void>[] = [];
    if (resolveRecallAuxiliaryCapabilities(this.deps.config).knowledgeIndex) {
      cacheWarmups.push(
        (async () => {
          try {
            const t0 = Date.now();
            await this.deps.storage.buildKnowledgeIndex(this.deps.config);
            log.info(`Knowledge Index warmup: complete in ${Date.now() - t0}ms`);
          } catch (err) {
            log.debug(`Knowledge Index warmup failed (non-fatal): ${err}`);
          }
        })(),
      );
    }
    cacheWarmups.push(this.deps.storage.readAllMemories().then(() => {}).catch(() => {}));
    cacheWarmups.push(this.deps.storage.readAllEntityFiles().then(() => {}).catch(() => {}));
    await Promise.all(cacheWarmups);
    if (signal.aborted) return;

    if (resolveIndexingCapabilities(this.deps.config).conversationIndex && this.deps.conversationIndexBackend) {
      try {
        const init = await this.deps.conversationIndexBackend.initialize();
        if (!init.enabled) {
          this.deps.config.conversationIndexEnabled = false;
        }
        if (init.logLevel === "info") {
          log.info(init.message);
        } else if (init.logLevel === "warn") {
          log.warn(init.message);
        } else {
          log.debug(init.message);
        }
      } catch (err) {
        log.error(`Conversation index initialization failed (non-fatal): ${err}`);
        this.deps.config.conversationIndexEnabled = false;
      }
    }

    if (signal.aborted) return;

    if (resolveLocalLlmCapabilities(this.deps.config).localLlm) {
      try {
        await this.deps.validateLocalLlmModel();
      } catch (err) {
        log.error(`Local LLM validation failed (non-fatal): ${err}`);
      }
    }

    if (signal.aborted) return;

    // Await cron auto-registration so callers that `await deferredReady` can
    // rely on cron jobs being registered when it resolves. Without this, the
    // fire-and-forget pattern lets deferredReady settle while cron writes are
    // still in flight. Errors are non-fatal — catch individually.
    // Auto-register every cron job in one pass. Each registration is gated
    // by its config flag inside the scheduler and individually non-fatal
    // (issue #1526 PR1 — moved to MaintenanceScheduler).
    await this.deps.maintenanceScheduler.autoRegisterCrons(signal);

    // First-start lifecycle migration (issue #686 retention-completion).
    // When lifecyclePolicyEnabled is true and the memoryDir has never been
    // touched by the lifecycle policy, run a one-time rate-limited demotion
    // sweep (capped at 50 demotions) so the hot tier isn't flooded on the
    // first real cron pass. Non-fatal — a failure here must not break init.
    if (signal.aborted) return;
    if (lifecycleCaps.lifecyclePolicy && resolveQmdCapabilities(this.deps.config).qmdTierMigration) {
      try {
        const { runFirstStartMigration } = await import("../maintenance/first-start-migration.js"
        );
        const result = await runFirstStartMigration({
          storage: this.deps.storage,
          config: this.deps.config,
          qmd: this.deps.qmd,
          hotCollection: this.deps.config.qmdCollection,
          coldCollection: this.deps.config.qmdColdCollection,
          signal,
        });
        if (!result.skipped) {
          log.info(
            `first-start lifecycle migration: demoted ${result.demotedCount} of ${result.candidateCount} candidates (cap=${result.cappedAt})`,
          );
        } else {
          log.debug(`first-start lifecycle migration skipped: ${result.skipReason}`);
        }
      } catch (err) {
        log.warn(`first-start lifecycle migration failed (non-fatal): ${err}`);
      }
    }

    // Wearables auto-sync: in-process periodic transcript refresh for
    // long-lived hosts (default on). Today's transcript keeps growing
    // while the wearable records; a once-per-local-day deep pass picks
    // up late uploads and provider re-processing. Static config gate —
    // sources can't appear at runtime, so checking once here is safe.
    // The timer is unref'd, so one-shot CLI runs exit naturally without
    // ever ticking; idempotent across stop/start cycles via the handle
    // guard. Non-fatal: a failure to start must not break init.
    if (signal.aborted) return;
    if (
      !this.deps.wearablesAutoSyncHandle &&
      this.deps.config.wearables.enabled &&
      this.deps.config.wearables.autoSyncEnabled &&
      Object.values(this.deps.config.wearables.sources).some((source) => source.enabled)
    ) {
      try {
        const { startWearablesAutoSync } = await import("../wearables/auto-sync.js");
        // Re-check after the await: destroy() may have aborted while
        // the import was in flight, having found no handle to stop —
        // starting now would leave a live interval on a destroyed
        // orchestrator (Cursor review on PR #1464). Handle creation
        // below is synchronous, so no further window exists.
        if (signal.aborted) return;
        this.deps.wearablesAutoSyncHandle = startWearablesAutoSync(
          {
            intervalMinutes: this.deps.config.wearables.autoSyncIntervalMinutes,
            days: this.deps.config.wearables.autoSyncDays,
            deepDays: this.deps.config.wearables.autoSyncDeepDays,
            ...(this.deps.config.wearables.timezone !== undefined
              ? { timezone: this.deps.config.wearables.timezone }
              : {}),
          },
          {
            // The shared wearables service fires its own meeting tail-step hook
            // (wired in workspace-ops), so both this auto-sync path and the
            // manual sync path rebuild affected meetings — no per-adapter fan-out.
            sync: (options) => this.deps.getWearablesService().sync(options),
            log: {
              info: (message) => log.info(message),
              warn: (message) => log.warn(message),
            },
          },
        );
        log.info(
          `wearables auto-sync started: every ${this.deps.config.wearables.autoSyncIntervalMinutes}m over ${this.deps.config.wearables.autoSyncDays}d (deep ${this.deps.config.wearables.autoSyncDeepDays}d daily)`,
        );
      } catch (err) {
        const { displayErrorDetail } = await import("../runtime/better-sqlite.js");
        log.warn(
          `wearables auto-sync failed to start (non-fatal): ${displayErrorDetail(err)}`,
        );
      }
    }

    log.info("orchestrator initialized (full — deferred steps complete)");
  }

  /**
   * Namespace-aware startup search sync. Re-probes QMD, ensures collections
   * (namespace-aware when namespacesEnabled), runs update, and warms up search.
   * Designed for server retry paths that run after the deferred init completes
   * when QMD was not available during initial startup.
   *
   * Accepts an optional AbortSignal so callers can interrupt the sync during
   * shutdown. The signal is checked between phases and forwarded into the QMD
   * update and warmup search calls so a long-running `qmd update` subprocess
   * is killed promptly rather than left in flight after `httpServer.stop()`.
   *
   * Returns true if the sync succeeded (QMD now available), false otherwise.
   */
  async startupSearchSync(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;

    const available = await this.deps.qmd.probe();
    if (!available) return false;
    if (signal?.aborted) {
      log.debug("startupSearchSync: aborted after probe");
      return false;
    }

    log.info(`startupSearchSync: backend now available ${this.deps.qmd.debugStatus()}`);

    // Clear namespace router cache so re-probe picks up newly available backends
    if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
      this.deps.namespaceSearchRouter.clearCache();
    }

    // Ensure collections — namespace-aware when enabled.
    // Use the catalog-union namespace set (issue #1499 sweep, same class as
    // NHZEV): this is the QMD startup-recovery sync that ensures collections AND
    // runs `updateNamespaces(...)` below over the SAME `namespaces` set. A dynamic
    // namespace that exists only in the persisted catalog must be ensured and
    // re-synced here too, otherwise after a backend-was-unavailable-at-boot
    // recovery its collection stays stale. Falls back to the configured set on any
    // catalog read failure.
    const namespaces = resolveNamespaceCapabilities(this.deps.config).namespaces
      ? await this.deps.maintenanceNamespaces()
      : [this.deps.config.defaultNamespace];

    const states = await Promise.all(
      namespaces.map(async (namespace) => ({
        namespace,
        state: resolveNamespaceCapabilities(this.deps.config).namespaces
          ? await this.deps.namespaceSearchRouter.ensureNamespaceCollection(namespace, { signal })
          : await this.deps.qmd.ensureCollection(this.deps.config.memoryDir, this.deps.config.qmdCollection, { signal }),
      })),
    );

    if (signal?.aborted) {
      log.debug("startupSearchSync: aborted after ensureCollection");
      return false;
    }

    const defaultState =
      states.find((e) => e.namespace === this.deps.config.defaultNamespace)?.state ?? "unknown";
    if (defaultState === "missing") {
      // Reset the real backend's available flag before replacing it with noop.
      // probe() set available=true earlier in this call; without this reset,
      // any code that captured a reference to the old backend (e.g. a concurrent
      // recall() that read this.deps.qmd before the reassignment) would observe
      // isAvailable()===true against a backend with a missing collection.
      if ("available" in this.deps.qmd) {
        (this.deps.qmd as any).available = false;
      }
      await this.deps.disposeSearchBackendIfNeeded();
      this.deps.qmd = new NoopSearchBackend();
      log.warn("startupSearchSync: search collection missing; disabling search (fallback retrieval remains enabled)");
      return false;
    }

    // Run index update — namespace-aware when enabled.
    // qmd.update() swallows errors internally, so we: (1) snapshot fail/run
    // timestamps, (2) reset throttles so the update isn't skipped by stale
    // backoff, and (3) verify timestamps after update to confirm it executed
    // and didn't fail silently.
    // The abort signal is forwarded into the QMD subprocess call so the
    // long-running `qmd update` process is killed promptly on shutdown.
    if (resolveQmdCapabilities(this.deps.config).qmdMaintenance) {
      try {
        const failTsBefore = "lastUpdateFailedAtMs" in this.deps.qmd
          ? (this.deps.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        const hasRunTs = "lastUpdateRanAtMs" in this.deps.qmd;
        if ("resetUpdateThrottles" in this.deps.qmd) {
          (this.deps.qmd as any).resetUpdateThrottles();
        }
        log.info("startupSearchSync: updating index to match current disk state");
        let namespacesUpdated = 0;
        if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
          namespacesUpdated = await this.deps.namespaceSearchRouter.updateNamespaces(
            namespaces,
            { signal },
          );
        } else {
          await this.deps.qmd.update({ signal });
        }
        if (signal?.aborted) {
          log.debug("startupSearchSync: aborted after update");
          return false;
        }
        const failTsAfter = "lastUpdateFailedAtMs" in this.deps.qmd
          ? (this.deps.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        const runTsAfter = hasRunTs
          ? (this.deps.qmd as any).lastUpdateRanAtMs as number | null
          : null;
        if (failTsAfter !== null && failTsAfter !== failTsBefore) {
          log.warn("startupSearchSync: update silently failed (detected via fail timestamp)");
          return false;
        }
        if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
          if (namespacesUpdated === 0) {
            log.warn("startupSearchSync: no namespace backends were eligible for update (all unavailable or collections missing)");
            return false;
          }
          log.info(`startupSearchSync: namespace updates succeeded (${namespacesUpdated}/${namespaces.length} namespaces updated)`);
        } else if (hasRunTs && runTsAfter === null) {
          log.warn("startupSearchSync: update was throttled/skipped (run timestamp is null after reset + update)");
          return false;
        }
        log.info("startupSearchSync: sync complete");
      } catch (err) {
        log.warn(`startupSearchSync: update failed: ${err}`);
        return false;
      }
    }

    // Warmup search to pre-load embedding models
    if (!signal?.aborted) {
      try {
        await this.deps.qmd.search("warmup", this.deps.config.defaultNamespace, 1, undefined, { signal });
        log.info("startupSearchSync: warmup complete");
      } catch (err) {
        log.debug(`startupSearchSync: warmup search failed (non-fatal): ${err}`);
      }
    }

    return true;
  }
}
