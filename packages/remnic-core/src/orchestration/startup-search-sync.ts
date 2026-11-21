/**
 * The post-ready startup search sync (#3518, #3525): probe, catalog-union
 * namespace discovery, collection ensure, the missing-collection noop swap,
 * and the corpus-wide `qmd update` plus warm-up search. Extracted from
 * orchestrator-init.ts so the coordinator stays under the structural-ratchet
 * ceiling; every collaborator arrives through the host interface so the
 * runner holds no orchestrator internals.
 *
 * Two shared-flight contracts live here:
 *  - `ensureStartupSearchBackend`: concurrent callers join one backend
 *    bring-up so nobody observes the mid-run half-finished state (#3518).
 *  - `startupSearchSync` / `joinStartupSearchSync`: post-ready fire, CLI
 *    one-shots and the server retry loop join one corpus update (#3525).
 *    The flight is owned by its own controller — never the initiating
 *    caller's signal — and cancels when the epoch retires or the last live
 *    caller aborts (#3527 review).
 */
import { resolveNamespaceCapabilities, resolveQmdCapabilities } from "../capabilities.js";
import { log } from "../logger.js";
import { NoopSearchBackend } from "../search/noop-backend.js";
import type { OrchestratorInitDeps } from "./orchestrator-init.js";

/** Outcome of one backend bring-up: probe, catalog-union discovery, per-namespace
 * collection ensure, and the missing-collection noop swap. "ready" carries the
 * epoch and discovery the full sync needs for its corpus update. "degraded" is
 * the probed-available backend whose collection check answered "unknown" — the
 * ensure is unverified, so neither sync may claim success. */
type StartupBackendEnsure =
  | { state: "ready"; epoch: number; discovery: { namespaces: string[]; complete: boolean } }
  | { state: "unavailable" | "missing" | "degraded" | "retired" };

type StartupBackendEnsureFlight = {
  epoch: number;
  promise: Promise<StartupBackendEnsure>;
  controller: AbortController;
  liveCallers: number;
  cleanup: Array<() => void>;
};

type StartupSyncFlight = {
  epoch: number;
  promise: Promise<boolean>;
  controller: AbortController;
  liveCallers: number;
  cleanup: Array<() => void>;
};

/** The epoch and namespace primitives the runner borrows from the
 *  orchestrator lifecycle — injected as bound functions so no private
 *  coordinator member is exposed. */
export interface StartupSearchSyncHost {
  deps: OrchestratorInitDeps;
  currentOrNewStartupEpoch(): number | null;
  isCurrentStartupEpoch(epoch: number): boolean;
  linkedEpochAbortController(
    epoch: number,
    externalSignal?: AbortSignal,
  ): { controller: AbortController; dispose(): void };
  probeForStartupEpoch(epoch: number, externalSignal?: AbortSignal): Promise<boolean>;
  startupNamespaces(epoch: number): Promise<{ namespaces: string[]; complete: boolean }>;
}

export class StartupSearchSyncRunner {
  private startupBackendEnsureFlight: StartupBackendEnsureFlight | undefined;
  private startupSyncInFlight: StartupSyncFlight | undefined;

  constructor(private readonly host: StartupSearchSyncHost) {}

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
    const ensured = await this.ensureStartupSearchBackend(signal);
    return ensured.state === "ready";
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
    if (
      !resolveQmdCapabilities(this.host.deps.config).qmdMaintenance
      || this.host.deps.deferredSyncSucceeded
    ) return true;
    return this.startupSearchSync(signal);
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
    if (signal?.aborted) return false;
    const epoch = this.host.currentOrNewStartupEpoch();
    if (epoch === null) return false;
    // The post-ready fire (#3525), a freshness-dependent CLI joiner and the
    // server retry loop can all arrive while a call is in flight: join it
    // rather than spawn a second `qmd update` over the same index. Only the
    // current epoch's flight joins — a retired cycle's dying call would hand
    // the joiner its false. The shared run is owned by the flight's
    // controller, never the initiating caller's signal (#3527): it cancels
    // when the epoch retires or every live caller's signal has aborted, and
    // each caller's own signal decides its own wait.
    let flight = this.startupSyncInFlight;
    if (
      !flight ||
      flight.epoch !== epoch ||
      flight.controller.signal.aborted
    ) {
      const controller = new AbortController();
      // Normalize an operational failure on the shared run before any caller
      // joins it: a caller without a signal (the local CLI) must get false and
      // keep its stale-index warning and cleanup, not a rejection (#3527).
      const run = this.runStartupSearchSync(controller.signal).catch((err) => {
        log.warn(`startupSearchSync: shared sync failed: ${err}`);
        return false;
      });
      const next: StartupSyncFlight = {
        epoch,
        promise: run,
        controller,
        liveCallers: 0,
        cleanup: [],
      };
      this.startupSyncInFlight = next;
      const settle = () => {
        if (this.startupSyncInFlight === next) this.startupSyncInFlight = undefined;
        for (const remove of next.cleanup) remove();
      };
      void run.then(settle);
      // A completed sync publishes success for its epoch directly — not only
      // through the post-ready .then() — so a joiner, a server retry or an
      // abortDeferredInit() that lands first never re-runs `qmd update`.
      void run.then((synced) => {
        if (synced && !controller.signal.aborted && this.host.isCurrentStartupEpoch(epoch)) {
          this.host.deps.deferredSyncSucceeded = true;
        }
      });
      flight = next;
    }
    // Each caller holds the shared run open until its own signal aborts; the
    // last live caller's abort cancels the run for everyone.
    flight.liveCallers += 1;
    if (signal) {
      const held = flight;
      return new Promise<boolean>((resolve) => {
        const onCallerAbort = () => {
          held.liveCallers -= 1;
          if (held.liveCallers <= 0) held.controller.abort();
          resolve(false);
        };
        signal.addEventListener("abort", onCallerAbort, { once: true });
        held.cleanup.push(() => signal.removeEventListener("abort", onCallerAbort));
        void held.promise.then((result) => {
          signal.removeEventListener("abort", onCallerAbort);
          resolve(result);
        });
      });
    }
    return flight.promise;
  }

  private async runStartupSearchSync(signal?: AbortSignal): Promise<boolean> {
    const ensured = await this.ensureStartupSearchBackend(signal);
    if (ensured.state !== "ready") return false;
    const { epoch, discovery } = ensured;
    // A caller whose own signal aborted must not dispatch update work even
    // when joined callers kept the shared ensure alive to a ready result.
    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
      log.debug("startupSearchSync: aborted or retired after the shared backend ensure");
      return false;
    }
    const namespaces = discovery.namespaces;

    // Run index update — namespace-aware when enabled.
    // qmd.update() swallows errors internally, so we: (1) snapshot fail/run
    // timestamps, (2) reset throttles so the update isn't skipped by stale
    // backoff, and (3) verify timestamps after update to confirm it executed
    // and didn't fail silently.
    // The abort signal is forwarded into the QMD subprocess call so the
    // long-running `qmd update` process is killed promptly on shutdown.
    if (resolveQmdCapabilities(this.host.deps.config).qmdMaintenance) {
      try {
        // SAFETY: guarded by the `in` check — the concrete QMD backend's fail
        // timestamp is an internal the SearchBackend interface does not declare.
        const failTsBefore = "lastUpdateFailedAtMs" in this.host.deps.qmd
          ? (this.host.deps.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        const hasRunTs = "lastUpdateRanAtMs" in this.host.deps.qmd;
        if ("resetUpdateThrottles" in this.host.deps.qmd) {
          // SAFETY: guarded by the `in` check — the concrete backend's throttle
          // reset is an internal the SearchBackend interface does not declare.
          (this.host.deps.qmd as any).resetUpdateThrottles();
        }
        log.info("startupSearchSync: updating index to match current disk state");
        const updateAbort = this.host.linkedEpochAbortController(epoch, signal);
        let namespaceUpdate: { backendCount: number; eligibleNamespaces: string[] } | null = null;
        try {
          if (resolveNamespaceCapabilities(this.host.deps.config).namespaces) {
            namespaceUpdate = await this.host.deps.namespaceSearchRouter.updateNamespacesDetailed(
              namespaces,
              { signal: updateAbort.controller.signal },
            );
          } else {
            await this.host.deps.qmd.update({ signal: updateAbort.controller.signal });
          }
        } finally {
          updateAbort.dispose();
        }
        if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
          log.debug("startupSearchSync: aborted or retired after update");
          return false;
        }
        // SAFETY: both casts read the concrete backend's update timestamps,
        // guarded by their `in` checks; SearchBackend does not declare them.
        const failTsAfter = "lastUpdateFailedAtMs" in this.host.deps.qmd
          ? (this.host.deps.qmd as any).lastUpdateFailedAtMs as number | null
          : null;
        // SAFETY: guarded by hasRunTs (the `in` check before the update) — the
        // run timestamp is a concrete-backend internal not on SearchBackend.
        const runTsAfter = hasRunTs
          ? (this.host.deps.qmd as any).lastUpdateRanAtMs as number | null
          : null;
        if (failTsAfter !== null && failTsAfter !== failTsBefore) {
          log.warn("startupSearchSync: update silently failed (detected via fail timestamp)");
          return false;
        }
        if (namespaceUpdate !== null) {
          if (namespaceUpdate.backendCount === 0) {
            log.warn("startupSearchSync: no namespace backends were eligible for update (all unavailable or collections missing)");
            return false;
          }
          // The router skips a namespace whose backend is unavailable or whose
          // collection is missing. Name each one so a partial update is never
          // reported as full coverage (#3527). It does not fail the sync: a
          // missing collection has no index to refresh, and a false here would
          // re-run the corpus update on every server retry.
          const eligible = new Set(namespaceUpdate.eligibleNamespaces);
          const skipped = namespaces.filter((namespace) => !eligible.has(namespace));
          if (skipped.length > 0) {
            log.warn(`startupSearchSync: skipped namespaces with no available backend or collection: ${skipped.join(", ")}`);
          }
          log.info(`startupSearchSync: namespace updates succeeded (${eligible.size}/${namespaces.length} namespaces updated)`);
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
    if (!signal?.aborted && this.host.isCurrentStartupEpoch(epoch)) {
      const warmupAbort = this.host.linkedEpochAbortController(epoch, signal);
      try {
        await this.host.deps.qmd.search(
          "warmup",
          this.host.deps.config.defaultNamespace,
          1,
          undefined,
          { signal: warmupAbort.controller.signal },
        );
        log.info("startupSearchSync: warmup complete");
      } catch (err) {
        log.debug(`startupSearchSync: warmup search failed (non-fatal): ${err}`);
      } finally {
        warmupAbort.dispose();
      }
    }

    // A retired epoch's warmup settles without throwing: re-check before
    // publishing success, so a stale run cannot mark a replacement
    // lifecycle as synced (#3527 review).
    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) return false;
    return discovery.complete;
  }

  /**
   * The shared readiness half of the startup sync: probe, catalog-union
   * namespace discovery, per-namespace collection ensure, and the
   * missing-collection noop swap. `startupSearchReadySync` exposes this for
   * the awaited ready path; `startupSearchSync` layers the corpus update and
   * warm-up search on top for the post-ready retry loop (#3518). Concurrent
   * callers join one in-flight `runStartupSearchBackend` so nobody observes
   * the mid-run state where probe() has already flipped isAvailable() (#3518
   * second read).
   */
  private ensureStartupSearchBackend(
    signal?: AbortSignal,
  ): Promise<StartupBackendEnsure> {
    if (signal?.aborted) return Promise.resolve({ state: "retired" });
    // Share one backend bring-up across concurrent callers (#3518 second
    // read): probe() flips isAvailable() before the collection ensure and the
    // missing-collection noop swap finish, so a readiness caller arriving
    // mid-run must await the SAME run — never observe the half-finished state
    // or start a second probe/ensure. Three boundaries keep the sharing safe
    // (#3518 third read): the flight is joined only while its epoch is still
    // current and it has not been abandoned, so a caller after a lifecycle
    // restart runs its own ensure instead of inheriting "retired"; and the
    // shared run aborts only when its epoch retires or every participating
    // caller's signal has aborted — never because one caller's per-attempt
    // timeout fired while other callers still hold it.
    let flight = this.startupBackendEnsureFlight;
    if (
      !flight ||
      !this.host.isCurrentStartupEpoch(flight.epoch) ||
      flight.controller.signal.aborted
    ) {
      const epoch = this.host.currentOrNewStartupEpoch();
      if (epoch === null) return Promise.resolve({ state: "retired" });
      const controller = new AbortController();
      const run = this.runStartupSearchBackend(epoch, controller.signal);
      const next: StartupBackendEnsureFlight = {
        epoch,
        promise: run,
        controller,
        liveCallers: 0,
        cleanup: [],
      };
      this.startupBackendEnsureFlight = next;
      // run.then(clear, clear) clears the flight on settle in both directions
      // without creating a second derived promise that could reject
      // unhandled; settle also removes every registered caller listener.
      const settle = () => {
        if (this.startupBackendEnsureFlight === next) {
          this.startupBackendEnsureFlight = undefined;
        }
        for (const remove of next.cleanup) remove();
      };
      run.then(settle, settle);
      flight = next;
    }
    // Each caller holds the shared run open until its own signal aborts; the
    // last live caller's abort cancels the run for everyone.
    flight.liveCallers += 1;
    if (signal) {
      const held = flight;
      // An aborted caller releases its slot and settles its own wait as
      // "retired" — it must not stay parked on the shared run while live
      // callers keep it going.
      return new Promise<StartupBackendEnsure>((resolve, reject) => {
        const onCallerAbort = () => {
          held.liveCallers -= 1;
          if (held.liveCallers <= 0) held.controller.abort();
          resolve({ state: "retired" });
        };
        signal.addEventListener("abort", onCallerAbort, { once: true });
        held.cleanup.push(() => signal.removeEventListener("abort", onCallerAbort));
        held.promise.then(
          (result) => {
            signal.removeEventListener("abort", onCallerAbort);
            resolve(result);
          },
          (err) => {
            signal.removeEventListener("abort", onCallerAbort);
            reject(err);
          },
        );
      });
    }
    return flight.promise;
  }

  private async runStartupSearchBackend(
    epoch: number,
    signal?: AbortSignal,
  ): Promise<StartupBackendEnsure> {
    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
      return { state: "retired" };
    }

    const available = await this.host.probeForStartupEpoch(epoch, signal);
    if (!available) return { state: "unavailable" };
    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
      log.debug("startupSearchSync: aborted or retired after probe");
      return { state: "retired" };
    }

    log.info(`startupSearchSync: backend now available ${this.host.deps.qmd.debugStatus()}`);

    // Clear namespace router cache so re-probe picks up newly available backends
    if (resolveNamespaceCapabilities(this.host.deps.config).namespaces) {
      this.host.deps.namespaceSearchRouter.clearCache();
    }

    // Ensure collections — namespace-aware when enabled.
    // Use the catalog-union namespace set (issue #1499 sweep, same class as
    // NHZEV): this is the QMD startup-recovery sync that ensures collections AND
    // lets `startupSearchSync` run `updateNamespaces(...)` over the SAME
    // `namespaces` set. A dynamic namespace that exists only in the persisted
    // catalog must be ensured and re-synced here too, otherwise after a
    // backend-was-unavailable-at-boot recovery its collection stays stale.
    // Falls back to the configured set on any catalog read failure.
    const discovery = await this.host.startupNamespaces(epoch);
    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
      log.debug("startupSearchSync: aborted or retired after namespace discovery");
      return { state: "retired" };
    }
    const namespaces = discovery.namespaces;

    const states = await Promise.all(
      namespaces.map(async (namespace) => {
        const epochAbort = this.host.linkedEpochAbortController(epoch, signal);
        try {
          return {
            namespace,
            state: resolveNamespaceCapabilities(this.host.deps.config).namespaces
              ? await this.host.deps.namespaceSearchRouter.ensureNamespaceCollection(
                  namespace,
                  { signal: epochAbort.controller.signal },
                )
              : await this.host.deps.qmd.ensureCollection(
                  this.host.deps.config.memoryDir,
                  this.host.deps.config.qmdCollection,
                  { signal: epochAbort.controller.signal },
                ),
          };
        } finally {
          epochAbort.dispose();
        }
      }),
    );

    if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
      log.debug("startupSearchSync: aborted or retired after ensureCollection");
      return { state: "retired" };
    }

    const defaultState =
      states.find((e) => e.namespace === this.host.deps.config.defaultNamespace)?.state ?? "unknown";
    if (defaultState === "missing") {
      await this.host.deps.disposeSearchBackendIfNeeded();
      if (signal?.aborted || !this.host.isCurrentStartupEpoch(epoch)) {
        log.debug("startupSearchSync: aborted or retired while disposing a missing backend");
        return { state: "retired" };
      }
      // Reset the real backend's available flag before replacing it with noop.
      // probe() set available=true earlier in this call; without this reset,
      // any code that captured a reference to the old backend (e.g. a concurrent
      // recall() that read this.host.deps.qmd before the reassignment) would observe
      // isAvailable()===true against a backend with a missing collection.
      if ("available" in this.host.deps.qmd) {
        // SAFETY: the concrete backend owns `available`; the SearchBackend interface does not declare it.
        (this.host.deps.qmd as any).available = false;
      }
      this.host.deps.qmd = new NoopSearchBackend();
      log.warn("startupSearchSync: search collection missing; disabling search (fallback retrieval remains enabled)");
      return { state: "missing" };
    }

    // "unknown" means the collection check could not determine the state
    // (timeout, cancelled auto-create, failed recheck). Retrieval stays
    // fail-open on the probed backend, but the ensure is unverified: neither
    // the readiness sync nor the full sync may claim success — the next
    // attempt re-checks, and the warm-up gate counts this as degraded
    // rather than warmed (#3518 third read). Explicit "skipped" (remote or
    // daemon-only modes that run no local check) still counts as ready.
    if (defaultState === "unknown") {
      log.warn(
        "startupSearchSync: collection check could not verify the default collection; the sync stays unready until a retry verifies it",
      );
      return { state: "degraded" };
    }

    return { state: "ready", epoch, discovery };
  }
}
