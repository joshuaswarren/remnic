
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { SmartBuffer } from "../buffer.js";
import { resolveIndexingCapabilities, resolveLocalLlmCapabilities, resolveMemoryLifecycleCapabilities, resolveNamespaceCapabilities, resolveQmdCapabilities, resolveRecallAuxiliaryCapabilities, resolveUtilityLearningCapabilities } from "../capabilities.js";
import { CompoundingEngine } from "../compounding/engine.js";
import type { ConversationIndexBackend } from "../conversation-index/backend.js";
import type { CorrectionService } from "../correction/correction-service.js";
import { EmbeddingFallback } from "../embedding-fallback.js";
import { ContentHashIndex, StorageManager } from "../index.js";
import { assertExternalWikiRootOutsideMemoryDirCanonical } from "../external-wiki-guard.js";
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
import { StartupSearchSyncRunner } from "./startup-search-sync.js";
import type { SearchBackend } from "../search/port.js";
import { SessionObserverState } from "../session-observer-state.js";
import { SharedContextManager } from "../shared-context/manager.js";
import { HourlySummarizer } from "../summarizer.js";
import { TranscriptManager } from "../transcript.js";
import type { PluginConfig } from "../types.js";
import { type UtilityRuntimeValues, loadUtilityRuntimeValues } from "../utility-runtime.js";
import { WearablesService } from "../wearables/service.js";
import { startupDiscoveryWithTimeout } from "./startup-collection-checks.js";
import type { SearchCollectionState } from "./orchestrator-helpers.js";
import type { MeetingsService } from "../meetings/service.js";
import {
  COMPACTION_SIGNAL_MAX_AGE_MS,
  defaultWorkspaceDir,
  qmdStartupCollectionCheckWithTimeout,
  qmdStartupCollectionChecksWithTimeout,
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
  getWearablesService(namespace?: string): WearablesService;
  getMeetingsService(namespace?: string): Promise<MeetingsService>;
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
  private nextStartupEpoch = 0;
  private activeStartupEpoch: number | null = null;
  private startupClosed = false;
  private maintenanceNamespacesFlight:
    | { epoch: number; promise: Promise<string[]> }
    | undefined;
  private correctionCatalogFlight:
    | { epoch: number; promise: Promise<Awaited<ReturnType<NamespaceCatalog["listNamespaces"]>>> }
    | undefined;
  private recoveredCorrectionNamespaces = new Set<string>();
  private correctionRecoveryChain: Promise<void> = Promise.resolve();
  private startupEpochAbort:
    | { epoch: number; controller: AbortController }
    | undefined;
  private readonly startupStorageWrites = new Set<Promise<void>>();
  private readonly startupWarmups = new Set<Promise<void>>();
  private startupDefaultCollection: { epoch: number; state: SearchCollectionState } | undefined;

  constructor(
    private readonly deps: OrchestratorInitDeps,
  ) {}

  retireStartupEpoch(): void {
    this.startupEpochAbort?.controller.abort();
    this.startupEpochAbort = undefined;
    this.startupClosed = true;
    this.activeStartupEpoch = null;
  }

  private async initializeStorage(storage: StorageManager): Promise<void> {
    const write = storage.ensureDirectories({ waitForEntityMigration: false });
    this.startupStorageWrites.add(write);
    try {
      await write;
    } finally {
      this.startupStorageWrites.delete(write);
    }
  }

  async drainStartupWarmups(): Promise<void> {
    await Promise.allSettled([...this.startupWarmups]);
  }

  async drainEntityMigrations(): Promise<void> {
    await Promise.allSettled([...this.startupStorageWrites]);
    const drains = [this.deps.storage.drainEntityCanonicalIdMigration()];
    this.deps.storageRouter.forEachCachedStorage((storage) => {
      drains.push(storage.drainEntityCanonicalIdMigration());
    });
    await Promise.all(drains);
  }

  private beginStartupEpoch(): number {
    this.startupEpochAbort?.controller.abort();
    this.startupEpochAbort = undefined;
    this.deps.deferredInitAbort?.abort();
    this.deps.deferredInitAbort = null;
    this.deps.deferredSyncSucceeded = false;
    const epoch = ++this.nextStartupEpoch;
    this.startupEpochAbort = { epoch, controller: new AbortController() };
    this.activeStartupEpoch = epoch;
    this.startupClosed = false;
    this.maintenanceNamespacesFlight = undefined;
    this.correctionCatalogFlight = undefined;
    this.startupDefaultCollection = undefined;
    this.recoveredCorrectionNamespaces = new Set<string>();
    this.correctionRecoveryChain = Promise.resolve();
    return epoch;
  }

  private currentOrNewStartupEpoch(): number | null {
    if (this.startupClosed) return null;
    return this.activeStartupEpoch ?? this.beginStartupEpoch();
  }

  private isCurrentStartupEpoch(epoch: number): boolean {
    return !this.startupClosed && this.activeStartupEpoch === epoch;
  }

  private startupEpochSignal(epoch: number): AbortSignal | undefined {
    return this.startupEpochAbort?.epoch === epoch
      ? this.startupEpochAbort.controller.signal
      : undefined;
  }

  private linkedEpochAbortController(
    epoch: number,
    externalSignal?: AbortSignal,
  ): { controller: AbortController; dispose(): void } {
    const controller = new AbortController();
    const signals = [this.startupEpochSignal(epoch), externalSignal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const abort = () => controller.abort();
    for (const signal of signals) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    return {
      controller,
      dispose: () => {
        for (const signal of signals) signal.removeEventListener("abort", abort);
      },
    };
  }

  private async probeForStartupEpoch(
    epoch: number,
    externalSignal?: AbortSignal,
  ): Promise<boolean> {
    const abort = this.linkedEpochAbortController(epoch, externalSignal);
    try {
      if (!this.isCurrentStartupEpoch(epoch) || abort.controller.signal.aborted) return false;
      return await this.deps.qmd.probe({ signal: abort.controller.signal });
    } finally {
      abort.dispose();
    }
  }

  private maintenanceNamespacesFlightFor(epoch: number): Promise<string[]> {
    if (this.maintenanceNamespacesFlight?.epoch === epoch) {
      return this.maintenanceNamespacesFlight.promise;
    }
    const promise = Promise.resolve().then(() => {
      if (!this.isCurrentStartupEpoch(epoch)) return [];
      return this.deps.maintenanceNamespaces();
    });
    this.maintenanceNamespacesFlight = { epoch, promise };
    void promise.catch(() => {
      if (
        this.isCurrentStartupEpoch(epoch) &&
        this.maintenanceNamespacesFlight?.epoch === epoch &&
        this.maintenanceNamespacesFlight.promise === promise
      ) {
        this.maintenanceNamespacesFlight = undefined;
      }
    });
    return promise;
  }

  private correctionCatalogFlightFor(
    epoch: number,
  ): Promise<Awaited<ReturnType<NamespaceCatalog["listNamespaces"]>>> {
    if (!this.isCurrentStartupEpoch(epoch)) {
      return Promise.resolve([]);
    }
    if (this.correctionCatalogFlight?.epoch === epoch) {
      return this.correctionCatalogFlight.promise;
    }
    const promise = Promise.resolve().then(() => {
      if (!this.isCurrentStartupEpoch(epoch)) return [];
      return this.deps.namespaceCatalog.listNamespaces();
    });
    this.correctionCatalogFlight = { epoch, promise };
    return promise;
  }

  private enqueueCorrectionRecovery(epoch: number, namespaces: Iterable<string>): Promise<void> {
    if (!this.isCurrentStartupEpoch(epoch)) return Promise.resolve();
    const unrecovered = [...new Set(namespaces)].filter(
      (namespace) => !this.recoveredCorrectionNamespaces.has(namespace),
    );
    if (unrecovered.length === 0) return this.correctionRecoveryChain;
    for (const namespace of unrecovered) this.recoveredCorrectionNamespaces.add(namespace);

    this.correctionRecoveryChain = this.correctionRecoveryChain.then(async () => {
      if (!this.isCurrentStartupEpoch(epoch)) return;
      try {
        const recovered = await this.deps.passiveCorrectionService().recoverStaleApplyingPlans(
          unrecovered,
        );
        if (recovered > 0) {
          log.info(`correction: recovered ${recovered} stale applying plan(s) on startup`);
        }
      } catch (staleErr) {
        log.debug(`correction: stale-plan recovery skipped: ${staleErr instanceof Error ? staleErr.message : String(staleErr)}`);
      }
    });
    return this.correctionRecoveryChain;
  }

  private async startupNamespaces(epoch: number): Promise<{ namespaces: string[]; complete: boolean }> {
    if (!this.isCurrentStartupEpoch(epoch)) {
      return { namespaces: this.deps.configuredNamespaceList(), complete: false };
    }
    if (!resolveNamespaceCapabilities(this.deps.config).namespaces) {
      return { namespaces: [this.deps.config.defaultNamespace], complete: true };
    }
    const discovery = await startupDiscoveryWithTimeout(
      () => this.maintenanceNamespacesFlightFor(epoch),
      this.deps.configuredNamespaceList(),
    );
    return { namespaces: discovery.value, complete: discovery.complete };
  }

  async initialize(): Promise<void> {
    const epoch = this.beginStartupEpoch();
    let resolveDeferred: (() => void) | undefined;
    this.deps.deferredReady = new Promise<void>((resolve) => {
      resolveDeferred = () => resolve();
      this.deps.resolveDeferredReady = resolveDeferred;
    });
    const settleOwnDeferredReady = () => {
      if (this.deps.resolveDeferredReady === resolveDeferred) {
        this.deps.resolveDeferredReady = null;
      }
      resolveDeferred?.();
    };
    const exitIfStale = () => {
      if (this.isCurrentStartupEpoch(epoch)) return false;
      if (this.startupClosed && this.deps.resolveInit) {
        this.deps.resolveInit();
        this.deps.resolveInit = null;
      }
      settleOwnDeferredReady();
      return true;
    };

    try {
      await migrateFromEngram({
        quiet: true,
        logger: (message) => log.info(message),
      });
      await this.deps.storage.loadAliases();
      if (exitIfStale()) return;
      await this.initializeStorage(this.deps.storage);
      await Promise.all(
        this.deps.config.externalWikis.map((wiki) =>
          assertExternalWikiRootOutsideMemoryDirCanonical(
            this.deps.config.memoryDir,
            wiki.rootDir,
          ),
        ),
      );
      if (resolveNamespaceCapabilities(this.deps.config).namespaces) {
        const namespaces = new Set<string>([
          this.deps.config.defaultNamespace,
          this.deps.config.sharedNamespace,
          ...this.deps.config.namespacePolicies.map((p) => p.name),
        ]);
        for (const ns of namespaces) {
          const sm = await this.deps.storageRouter.storageFor(ns);
          await sm.loadAliases().catch(() => undefined);
          if (exitIfStale()) return;
          await this.initializeStorage(sm);
        }
        await this.deps.namespaceCatalog.registerConfiguredNamespaces().catch(() => undefined);
      }
      try {
        const correctionNamespaces = new Set(this.deps.configuredNamespaceList());
        if (this.deps.namespaceCatalog.enabled) {
          try {
            const catalogFlight = this.correctionCatalogFlightFor(epoch);
            const catalogDiscovery = await startupDiscoveryWithTimeout(
              () => catalogFlight,
              [],
            );
            for (const rec of catalogDiscovery.value) {
              correctionNamespaces.add(rec.namespace);
            }
            if (!catalogDiscovery.complete) {
              void catalogFlight.then(
                (records) => {
                  if (!this.isCurrentStartupEpoch(epoch)) return;
                  void this.enqueueCorrectionRecovery(
                    epoch,
                    records.map((record) => record.namespace),
                  );
                },
                () => undefined,
              );
            }
          } catch { /* best-effort */ }
        }
        await this.enqueueCorrectionRecovery(epoch, correctionNamespaces);
      } catch (staleErr) {
        log.debug(`correction: stale-plan recovery skipped: ${staleErr instanceof Error ? staleErr.message : String(staleErr)}`);
      }
      if (exitIfStale()) return;
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

      if (resolveRecallAuxiliaryCapabilities(this.deps.config).factDeduplication) {
        try {
          this.deps.contentHashIndex = await this.deps.storage.getAuthoritativeFactHashIndex();
          log.info(
            `content-hash dedup: rebuilt authoritative index with ${this.deps.contentHashIndex.size} hashes`,
          );
        } catch (err) {
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

      try {
        const available = await this.probeForStartupEpoch(epoch);
        if (available) {
          log.info(`Search backend: available ${this.deps.qmd.debugStatus()}`);
          const namespaceCapabilities = resolveNamespaceCapabilities(this.deps.config).namespaces;
          const discovery = await this.startupNamespaces(epoch);
          if (!this.isCurrentStartupEpoch(epoch)) {
            log.debug("startup collection check skipped for a retired startup epoch");
          } else {
            const checks = discovery.namespaces.map(async (namespace) => {
              const epochAbort = this.linkedEpochAbortController(epoch);
              try {
                const state = await qmdStartupCollectionCheckWithTimeout(
                  namespaceCapabilities
                    ? this.deps.namespaceSearchRouter.ensureNamespaceCollection(
                        namespace,
                        { signal: epochAbort.controller.signal },
                      )
                    : this.deps.qmd.ensureCollection(
                        this.deps.config.memoryDir,
                        this.deps.config.qmdCollection,
                        { signal: epochAbort.controller.signal },
                      ),
                  epochAbort.controller,
                  namespace,
                );
                return { namespace, state };
              } finally {
                epochAbort.dispose();
              }
            });
            const states = await qmdStartupCollectionChecksWithTimeout(checks, discovery.namespaces);
            if (!this.isCurrentStartupEpoch(epoch)) {
              log.debug("startup collection-check batch completed for a retired startup epoch");
            } else {
              const defaultState =
                states.find(
                  (entry) => entry.namespace === this.deps.config.defaultNamespace,
                )?.state ?? "unknown";
              this.startupDefaultCollection = { epoch, state: defaultState };
              if (defaultState === "missing") {
                await this.deps.disposeSearchBackendIfNeeded();
                if (!this.isCurrentStartupEpoch(epoch)) {
                  log.debug("startup collection-check disposal completed for a retired startup epoch");
                } else {
                  this.deps.qmd = new NoopSearchBackend();
                  log.warn(
                    "Search collection missing for Remnic memory store; disabling search retrieval for this runtime (fallback retrieval remains enabled)",
                  );
                }
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
      if (exitIfStale()) return;

      if (this.deps.resolveInit) {
        this.deps.resolveInit();
        this.deps.resolveInit = null;
        log.info("init gate opened (essential state + QMD state loaded)");
      }

      if (this.deps.resolveDeferredReady === resolveDeferred) {
        this.deps.resolveDeferredReady = null;
      }
      this.deps.deferredInitAbort = new AbortController();
      this.deps.deferredInitialize(this.deps.deferredInitAbort.signal)
        .catch((err) => {
          log.error(`deferred initialization failed (non-fatal): ${err}`);
        })
        .finally(async () => {
          await this.drainEntityMigrations();
          settleOwnDeferredReady();
        });
    } catch (err) {
      //
      if ((this.isCurrentStartupEpoch(epoch) || this.startupClosed) && this.deps.resolveInit) {
        this.deps.resolveInit();
        this.deps.resolveInit = null;
      }
      settleOwnDeferredReady();
      throw err;
    }
  }

  async deferredInitialize(signal: AbortSignal): Promise<void> {
    const epoch = this.currentOrNewStartupEpoch();
    if (epoch === null) return;
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.deps.config);

    //
    if (this.deps.qmd.isAvailable() && !resolveQmdCapabilities(this.deps.config).qmdMaintenance) {
      const collection = this.startupDefaultCollection;
      if (
        collection?.epoch === epoch &&
        (collection.state === "present" || collection.state === "skipped")
      ) {
        this.deps.deferredSyncSucceeded = true;
      }
    }
    // Otherwise the flag stays false and the retry loop owns the

    // But only remnic-server runs a retry loop (#3525): the OpenClaw service,
    // `remnic` CLI invocations, and the bench adapter drive Orchestrator
    // directly, so their index would go stale after the update left this
    // awaited path. Fire the same startupSearchSync once the ready mark
    // settles — registered now so a deferred-init failure still gets the
    // update — and record the success in the shared flag, so a server retry
    // that races in sees the same bookkeeping either direction. Only the
    // sync run itself joins startupWarmups: the deferredReady-derived outer
    // promise would make drainStartupWarmups() wait on the ready gate that
    // destroy() must not touch, while the abort signal already cancels the
    // run.
    void this.deps.deferredReady.then(async () => {
      if (signal.aborted
          || !resolveQmdCapabilities(this.deps.config).qmdMaintenance
          || this.deps.deferredSyncSucceeded) return;
      try {
        const sync = this.startupSearchSync(signal);
        const tracked = sync.then(() => undefined, () => undefined);
        this.startupWarmups.add(tracked);
        void tracked.then(() => this.startupWarmups.delete(tracked));
        // deferredSyncSucceeded is published by the shared run itself when it
        // completes for a current epoch — including a run this fire joined —
        // so no duplicate `qmd update` can be queued behind a success.
        await sync;
      } catch (err) {
        log.warn(`post-ready QMD sync failed (non-fatal): ${err}`);
      }
    });

    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;

    const factHashWarm = (async () => {
      const storage = await this.deps.storageRouter.storageFor(this.deps.config.defaultNamespace);
      await storage.isFactContentHashAuthoritative();
    })().catch((err) => {
      log.debug(`fact-hash index startup warm-up failed (non-fatal): ${err}`);
    });
    this.startupWarmups.add(factHashWarm);
    void factHashWarm.finally(() => this.startupWarmups.delete(factHashWarm));

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
    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;

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
    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;

    if (resolveIndexingCapabilities(this.deps.config).conversationIndex && this.deps.conversationIndexBackend) {
      try {
        const init = await this.deps.conversationIndexBackend.initialize();
        if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
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
        if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
        log.error(`Conversation index initialization failed (non-fatal): ${err}`);
        this.deps.config.conversationIndexEnabled = false;
      }
    }

    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;

    if (resolveLocalLlmCapabilities(this.deps.config).localLlm) {
      try {
        await this.deps.validateLocalLlmModel();
      } catch (err) {
        log.error(`Local LLM validation failed (non-fatal): ${err}`);
      }
    }

    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;

    await this.deps.maintenanceScheduler.autoRegisterCrons(signal);

    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
    if (lifecycleCaps.lifecyclePolicy && resolveQmdCapabilities(this.deps.config).qmdTierMigration) {
      try {
        const { runFirstStartMigration } = await import("../maintenance/first-start-migration.js"
        );
        if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
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

    if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
    if (
      !this.deps.wearablesAutoSyncHandle &&
      this.deps.config.wearables.enabled &&
      this.deps.config.wearables.autoSyncEnabled &&
      Object.values(this.deps.config.wearables.sources).some((source) => source.enabled)
    ) {
      try {
        const { startWearablesAutoSync } = await import("../wearables/auto-sync.js");
        if (signal.aborted || !this.isCurrentStartupEpoch(epoch)) return;
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
   * Readiness level of startupSearchSync (#3518): probe, catalog-union
   * collection ensure, and the missing-collection noop swap — WITHOUT the
   * corpus-wide index update. The awaited ready path and the warm-up gate use
   * this so readiness waits only on the probe, the collection and the model
   * warm-up; the corpus update runs after ready under the server retry loop
   * via startupSearchSync. Returns true when the backend is usable for
   * warm-up search, false while unavailable, retired, or noop-disposed.
   */
  async startupSearchReadySync(signal?: AbortSignal): Promise<boolean> {
    return this.searchSync().startupSearchReadySync(signal);
  }

  /**
   * Freshness-dependent one-shot entry point (#3525): joins the shared
   * startupSearchSync when this lifecycle still owes a corpus sync, so a
   * caller that needs a fresh index — the `remnic` one-shot diagnostic
   * commands, an OpenClaw boot — waits for the same update the post-ready
   * fire started instead of querying a stale index and aborting the run in
   * flight. Resolves true when the index is already synced or no sync is
   * owed (maintenance disabled); false when the joined sync failed.
   */
  async joinStartupSearchSync(signal?: AbortSignal): Promise<boolean> {
    return this.searchSync().joinStartupSearchSync(signal);
  }

  /**
   * Namespace-aware startup search sync. Re-probes QMD, ensures collections
   * (namespace-aware when namespacesEnabled), runs update, and warms up search.
   * Designed for server retry paths that run after the deferred init completes
   * when QMD was not available during initial startup — and, since #3518, for
   * the post-ready corpus update the deferred path no longer awaits.
   *
   * Accepts an optional AbortSignal so callers can interrupt the sync during
   * shutdown. The signal is checked between phases and forwarded into the QMD
   * update and warmup search calls so a long-running `qmd update` subprocess
   * is killed promptly rather than left in flight after `httpServer.stop()`.
   *
   * Returns true if the sync succeeded (QMD now available), false otherwise.
   */
  async startupSearchSync(signal?: AbortSignal): Promise<boolean> {
    return this.searchSync().startupSearchSync(signal);
  }

  private searchSyncRunner: StartupSearchSyncRunner | undefined;
  private searchSync(): StartupSearchSyncRunner {
    this.searchSyncRunner ??= new StartupSearchSyncRunner({
      deps: this.deps,
      currentOrNewStartupEpoch: () => this.currentOrNewStartupEpoch(),
      isCurrentStartupEpoch: (epoch) => this.isCurrentStartupEpoch(epoch),
      linkedEpochAbortController: (epoch, signal) => this.linkedEpochAbortController(epoch, signal),
      probeForStartupEpoch: (epoch, signal) => this.probeForStartupEpoch(epoch, signal),
      startupNamespaces: (epoch) => this.startupNamespaces(epoch),
    });
    return this.searchSyncRunner;
  }
}
