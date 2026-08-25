/**
 * Recall-entry coordinator — extracted from the orchestrator
 * (issue #1526, seam 28).
 *
 * Owns the public recall() entry surface: the init gate + timeout
 * fallback around recallInternal, recall failure logging/suppression,
 * recall result publication, and eval shadow-recall queueing.
 *
 * Behavior-preserving move (late-binding selfDeps wiring, seams 18–27).
 */

import { type CapabilitySet, type GraphConstructionCapabilitySet, type MemoryLifecycleCapabilitySet, resolveCapabilities, resolveEvalCapabilities, resolveGraphConstructionCapabilities, resolveNamespaceCapabilities, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import { type EvalShadowRecallRecord, recordEvalShadowRecall } from "../evals.js";
import { StorageManager } from "../index.js";
import { log } from "../logger.js";
import { resolvePrincipal } from "../namespaces/principal.js";
import { type RecallSectionAppendOptions, type RecallSectionBuckets } from "./recall-section-coordinator.js";
import { type RecallInvocationOptions, abortRecallError } from "./orchestrator-helpers.js";
import { ProfilingCollector } from "../profiling.js";
import { trustResultFor, type TrustStageResultItem } from "../trust-score-stage.js";
import type { RecallResultFormatter } from "./recall-result-formatter.js";
import type { IdentityInjectionMode, PluginConfig, QmdSearchResult } from "../types.js";
import { stateViewPacketActive } from "../recall-state-view-anchors.js";
import { resultStateViewKey, stateViewPacketKeys } from "../recall-state-view.js";
import { applyRecallStateViews } from "../recall-state-view-wire.js";
import { composeRecallContext } from "../recall-context-composition.js";
import {
  notifyContextComposition,
  recallFailureComposition,
} from "../recall-composition-decision.js";

export interface RecallEntryDeps {
  appendRecallSection(
    sectionBuckets: RecallSectionBuckets,
    sectionId: string,
    content: string,
    options?: RecallSectionAppendOptions,
  ): boolean;
  readonly config: PluginConfig;
  enqueueDirectAnswerObservation(
    prompt: string,
    sessionKey: string,
    namespaceOverride: string | undefined,
    principalOverride: string | undefined,
    caps: CapabilitySet,
    namespacesEnabled: boolean,
  ): void;
  evalShadowWriteChain: Promise<void>;
  extractMemoryIdsFromResults(results: QmdSearchResult[]): string[];
  recallResultFormatter: RecallResultFormatter;
  readonly initPromise: Promise<void> | null;
  lastRecallFailureAtMs: number;
  lastRecallFailureLogAtMs: number;
  logRecallFailure(err: unknown): void;
  readonly profiler: ProfilingCollector;
  recallInternal(
    prompt: string,
    sessionKey?: string,
    options?: RecallInvocationOptions,
    caps?: CapabilitySet,
    graphCaps?: GraphConstructionCapabilitySet,
    lifecycleCaps?: MemoryLifecycleCapabilitySet,
  ): Promise<string>;
  readonly storage: StorageManager;
  suppressedRecallFailures: number;
  trackRecallBackgroundWrite(promise: Promise<void>, label: string): void;
}

export class RecallEntryCoordinator {
  constructor(
    private readonly deps: RecallEntryDeps,
  ) {}

  async recall(
    prompt: string,
    sessionKey?: string,
    options: RecallInvocationOptions = {},
  ): Promise<string> {
    // Resolve the recall-operation capability gates ONCE, at the operation
    // entry, and thread the frozen set down (issue #1523). Never re-read the
    // migrated flags off `this.deps.config` mid-operation.
    const caps = resolveCapabilities(this.deps.config);
    const graphCaps = resolveGraphConstructionCapabilities(this.deps.config); // #1566 Cluster A
    const abortController = new AbortController();
    const onAbort = () => {
      abortController.abort();
    };
    if (options.abortSignal?.aborted) {
      abortController.abort();
    } else {
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const principal =
      typeof options.principalOverride === "string" &&
      options.principalOverride.length > 0
        ? options.principalOverride
        : resolvePrincipal(sessionKey, this.deps.config);
    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.config).namespaces;
    if (namespacesEnabled && !principal) {
      throw new Error("authentication required: namespaces are enabled and no principal was supplied");
    }

    // Wait for initialization to complete before attempting recall. The timeout
    // is configurable so OpenClaw's per-hook budget and Remnic's internal init
    // gate can stay aligned during cold starts.
    let initGateTimeoutHandle: NodeJS.Timeout | null = null;
    let onInitGateAbort: (() => void) | null = null;
    if (this.deps.initPromise) {
      const gateResult = await Promise.race([
        this.deps.initPromise.then(() => "ok" as const),
        new Promise<"timeout">((resolve) => {
          initGateTimeoutHandle = setTimeout(
            () => resolve("timeout"),
            this.deps.config.initGateTimeoutMs,
          );
        }),
        abortController.signal.aborted
          ? Promise.resolve("aborted" as const)
          : new Promise<"aborted">((resolve) => {
              onInitGateAbort = () => resolve("aborted");
              abortController.signal.addEventListener(
                "abort",
                onInitGateAbort,
                { once: true },
              );
            }),
      ]);
      if (initGateTimeoutHandle) clearTimeout(initGateTimeoutHandle);
      if (onInitGateAbort)
        abortController.signal.removeEventListener("abort", onInitGateAbort);
      if (gateResult === "aborted") {
        this.deps.logRecallFailure(abortRecallError("recall aborted before init"));
        return "";
      }
      if (gateResult === "timeout") {
        log.warn("recall: init gate timed out — proceeding without full init");
      }
    }

    // Secure-store lock gate (issue #690 PR 3/4).
    // If secure-store is enabled but the keyring holds no key for this
    // memory directory, reject recall with a clear human-readable error
    // rather than surfacing a cryptic SecureStoreLockedError from deep
    // inside the storage layer.
    if (resolveRecallAuxiliaryCapabilities(this.deps.config).secureStore && !this.deps.storage.isSecureStoreUnlocked()) {
      const lockedMsg =
        "[secure-store locked] Memory store is encrypted and locked. " +
        "Unlock the secure-store inside this daemon process, or restart the daemon through a secure-store aware launcher that installs the key.";
      log.warn("recall blocked: secure-store is locked");
      return lockedMsg;
    }

    // Keep outer recall timeout above worst-case serialized hybrid search:
    // QMD subprocess BM25 (30s) + vector (30s) can consume ~60s under contention.
    try {
      const recallPromise = this.deps.recallInternal(prompt, sessionKey, {
        ...options,
        abortSignal: abortController.signal,
      }, caps, graphCaps);
      const RECALL_TIMEOUT_MS = this.deps.config.recallOuterTimeoutMs ?? 75_000;
      if (RECALL_TIMEOUT_MS <= 0) {
        return await recallPromise;
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<string>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new Error("recall timeout"));
        }, RECALL_TIMEOUT_MS);
      });

      let recallResult: string;
      try {
        recallResult = await Promise.race([recallPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Observation-mode direct-answer tier (issue #518 slice 3c).
      // Runs after the user's recall already succeeded, fire-and-forget,
      // so annotation latency can never delay the caller's response.
      if (caps.recallDirectAnswer && sessionKey) {
        try {
          this.deps.enqueueDirectAnswerObservation(
            prompt,
            sessionKey,
            options.namespace?.trim() || undefined,
            options.principalOverride,
            caps,
            namespacesEnabled,
          );
        } catch (err) {
          log.debug(`direct-answer observation setup failed: ${err}`);
        }
      }

      return recallResult;
    } catch (err) {
      this.deps.logRecallFailure(err);
      // endTrace() is safe here: if no trace is active (disabled or already
      // closed by recallInternal's try/finally), it returns null immediately.
      this.deps.profiler.endTrace();
      // Caller-cancelled recalls stay quiet: the failure was the caller's
      // abort, not a recall degradation (issue #2972 contract).
      const missing = options.abortSignal?.aborted
        ? null
        : recallFailureComposition(err);
      if (!missing) return "";
      notifyContextComposition(options.onContextComposition, missing, (observerErr) => {
        log.warn("recall: context composition observer failed open", observerErr);
      });
      return composeRecallContext(missing);
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  logRecallFailure(err: unknown): void {
    const now = Date.now();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const LOG_WINDOW_MS = 60_000;
    const idleSinceLastFailureMs = now - this.deps.lastRecallFailureAtMs;
    this.deps.lastRecallFailureAtMs = now;
    if (idleSinceLastFailureMs >= LOG_WINDOW_MS) {
      this.deps.suppressedRecallFailures = 0;
    }

    if (now - this.deps.lastRecallFailureLogAtMs >= LOG_WINDOW_MS) {
      const suffix =
        this.deps.suppressedRecallFailures > 0
          ? ` (suppressed ${this.deps.suppressedRecallFailures} similar failures in last minute)`
          : "";
      log.warn(`recall timed out or failed: ${errorMsg}${suffix}`);
      this.deps.lastRecallFailureLogAtMs = now;
      this.deps.suppressedRecallFailures = 0;
      return;
    }

    this.deps.suppressedRecallFailures += 1;
    log.debug(`recall timed out or failed (suppressed): ${errorMsg}`);
  }

  queueEvalShadowRecall(
    record: Omit<EvalShadowRecallRecord, "schemaVersion">,
  ): void {
    if (!resolveEvalCapabilities(this.deps.config).evalHarness || !resolveEvalCapabilities(this.deps.config).evalShadowMode)
      return;
    this.deps.evalShadowWriteChain = this.deps.evalShadowWriteChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await recordEvalShadowRecall({
            memoryDir: this.deps.config.memoryDir,
            evalStoreDir: this.deps.config.evalStoreDir,
            record: {
              schemaVersion: 1,
              ...record,
            },
          });
        } catch (err) {
          log.debug(`eval shadow recall write failed: ${err}`);
        }
      });
    this.deps.trackRecallBackgroundWrite(
      this.deps.evalShadowWriteChain,
      "eval shadow recall write",
    );
  }

  publishRecallResults(options: {
    title: string;
    results: QmdSearchResult[];
    sectionBuckets: RecallSectionBuckets;
    retrievalQuery: string;
    sessionKey: string | undefined;
    identityInjection?: {
      mode: IdentityInjectionMode | "none";
      injectedChars: number;
      truncated: boolean;
    };
    /**
     * Issue #1577 — per-recall trust map. When present, quarantined items
     * are filtered from injection on EVERY recall path (hot QMD, embedding
     * fallback, cold archive, recent) so a faithfulness-contradicted memory
     * cannot sneak in via a branch that bypasses trust scoring. The map is
     * also threaded to formatQmdResultEntries for the epistemic hedge.
     */
    trustByPath?: Map<string, TrustStageResultItem> | null;
    /**
     * #1952 — per-request effective state-view flag (per-call `stateView`
     * OR `recallStateViews` config, gated on change intent), computed once
     * in recallInternal and threaded here. The inject seam uses this flag
     * instead of rereading live config so a per-call `stateView: true`
     * still labels/widens when the global flag is false.
     */
    stateViewActive?: boolean;
    /**
     * #1952 — historical recall pin (epoch ms) for this call. Under a
     * pin, annotation must not discard a predecessor whose successor is
     * absent due to the asOf validity filter; see applyRecallStateViews.
     */
    asOfMs?: number;
  }): void {
    const sectionId = "memories";
    const trustByPath = options.trustByPath ?? null;
    const injectable = applyRecallStateViews(
      trustByPath
        ? options.results.filter((r) => !trustResultFor(trustByPath, r)?.quarantined)
        : options.results,
      options.retrievalQuery,
      this.deps.config,
      options.stateViewActive === true,
      options.asOfMs,
    );
    if (injectable.length === 0) return;

    // #2928 — packet-atomic final budgeting: under packet semantics (state
    // view active, no historical asOf pin) rows of one supersession packet
    // share their canonical packet root key, so the section coordinator's
    // character/token cap admits or drops the packet as a unit.
    const packetKeys =
      stateViewPacketActive(options.stateViewActive === true, options.asOfMs)
        ? stateViewPacketKeys(injectable)
        : [];

    const formatted = this.deps.recallResultFormatter.formatQmdResultEntries(
      options.title,
      injectable,
      options.sessionKey,
      trustByPath,
    );
    this.deps.appendRecallSection(
      options.sectionBuckets,
      sectionId,
      formatted.heading,
    );
    for (const [index, entry] of formatted.entries.entries()) {
      const result = injectable[index];
      if (!result) continue;
      const memoryId = this.deps.extractMemoryIdsFromResults([result])[0];
      this.deps.appendRecallSection(
        options.sectionBuckets,
        sectionId,
        entry,
        {
          atomic: true,
          ...(memoryId ? { memoryId } : {}),
          ...(result.path ? { memoryPath: result.path } : {}),
          ...(result.namespace ? { memoryNamespace: result.namespace } : {}),
          ...(packetKeys[index] && resultStateViewKey(result)
            ? { packetKey: packetKeys[index] }
            : {}),
        },
      );
    }
  }
}
