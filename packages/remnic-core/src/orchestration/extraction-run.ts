/**
 * Extraction-run coordinator — extracted from the orchestrator
 * (issue #1526, seam 15).
 *
 * Owns the buffer→extract→persist pipeline orchestration:
 *   - `runExtraction` — the main extraction pipeline coordinator
 *     (normalize → threshold gate → namespace resolve → dedupe
 *     fingerprint → extract → validate → persist → post-write hooks)
 *   - dedupe support: `shouldQueueExtraction`,
 *     `buildExtractionFingerprint`, `normalizeExtractionFingerprintTurns`
 *   - `recordProcessedExtractionFingerprint` — meta recording
 *
 * The orchestrator constructs one instance and delegates the extraction
 * run to it. `persistExtraction`, `maybeCapturePassiveCorrections`, and
 * all post-write side-effect helpers arrive as injectable delegates so
 * the orchestrator keeps ownership of cross-subsystem routing and the
 * behavior-critical chokepoints it hosts.
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator keeps thin delegating methods so existing call sites
 * and tests that exercise the public API continue to work.
 */

import { createHash } from "node:crypto";
import type { StorageManager } from "../index.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { ExtractionEngine } from "../extraction.js";
import type { SmartBuffer } from "../buffer.js";
import type { ThreadingManager } from "../threading.js";
import type { BoxBuilder } from "../boxes.js";
import { resolvePrincipal, defaultNamespaceForPrincipal } from "../namespaces/principal.js";
import { resolveScopeProfilePlan, type ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import { resolveCodingNamespaceOverlay } from "../coding/coding-namespace.js";
import type { CodingContext } from "../types.js";
import {
  resolvePresentationCapabilities,
  resolveMemoryLifecycleCapabilities,
  type GraphConstructionCapabilitySet,
  type MemoryLifecycleCapabilitySet,
} from "../capabilities.js";
import { parseFlexibleIsoTimestamp } from "../utils/iso-timestamp.js";
import { log } from "../logger.js";
import type { PluginConfig, BufferTurn, ExtractionResult, MetaState, ExtractionFailureClass } from "../types.js";
import type { TierMigrationCycleSummary } from "../recall-state.js";

export interface ExtractionRunResult {
  status: "completed" | "skipped";
  reason?: string;
  persistedCount: number;
  durableOutputCount: number;
  postPersistMetadataFailed?: boolean;
}

export class ExtractionDeadlineError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`replay extraction deadline exceeded (${stage})`);
    this.name = "ExtractionDeadlineError";
    this.stage = stage;
  }
}


/** Dependencies injected by the orchestrator. All stable references or
 *  live accessors — lazy getters for anything tests reassign
 *  post-construction (buffer, extraction, storageRouter, threading). */
export interface ExtractionRunCoordinatorDeps {
  config: PluginConfig;
  getBuffer: () => SmartBuffer;
  getExtraction: () => Pick<ExtractionEngine, "extract">;
  getStorageRouter: () => Pick<NamespaceStorageRouter, "storageFor">;
  getThreading: () => Pick<ThreadingManager, "processTurn" | "updateThreadTitle">;

  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: { sessionKey?: string; principal?: string; validAt?: string; sourceConnector?: string },
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
    sourceText?: string,
    graphCaps?: GraphConstructionCapabilitySet,
    lifecycleCaps?: MemoryLifecycleCapabilitySet
  ) => Promise<{ persistedIds: string[]; memoryPathById: Map<string, string> }>;

  maybeCapturePassiveCorrections: (
    turns: readonly BufferTurn[],
    opts: {
      sessionKey: string;
      principal?: string;
      namespace: string;
      bufferKey: string;
      isLiveSession: boolean;
      abortSignal?: AbortSignal;
    }
  ) => Promise<void>;

  resolveSelfNamespace: (sessionKey?: string) => string;
  getCodingContextForSession: (sessionKey: string) => CodingContext | null;
  applyCodingNamespaceOverlay: (sessionKey: string, namespace: string) => string;
  boxBuilderFor: (storage: StorageManager) => Pick<BoxBuilder, "onExtraction">;
  appendPersistedThreadEpisodes: (threadId: string, ids: string[]) => Promise<void>;
  maybeScheduleConsolidation: (nonZero: boolean) => void;
  requestQmdMaintenance: () => void;
  runTierMigrationCycle: (
    storage: StorageManager,
    trigger: "extraction" | "maintenance" | "manual",
    options?: {
      dryRun?: boolean;
      limitOverride?: number;
      force?: boolean;
    }
  ) => Promise<TierMigrationCycleSummary>;
  getLastPersistExtractionDeferredCount: () => number;
  recordProcessedExtractionFingerprint: (
    storage: StorageManager,
    fingerprint: string,
    preloadedMeta?: Awaited<ReturnType<StorageManager["loadMeta"]>>
  ) => Promise<void>;
}

// Recall/extraction abort helpers live in orchestrator-helpers.ts since
// #1526 seam 25; this file previously carried duplicate copies
// (AGENTS.md rule 8 — no duplicated helpers).
import { raceRecallAbort, throwIfRecallAborted } from "./orchestrator-helpers.js";
import {
  capExtractionRetryStateEntries,
  computeExtractionRetryNextEligibleMs,
  deriveSourceConnector,
  deriveTopicsFromExtraction,
  EXTRACTION_RETRY_STATE_MAX_ENTRIES,
} from "./extraction-run-helpers.js";
import type { ExtractionResilienceStatus, ExtractionRetryStateEntry } from "./extraction-run-helpers.js";

export {
  capExtractionRetryStateEntries,
  computeExtractionRetryNextEligibleMs,
  deriveSourceConnector,
  deriveTopicsFromExtraction,
};
export type { ExtractionResilienceStatus };



/**
 * Coordinates the extraction run pipeline. Holds the dedupe fingerprint
 * cache (`recentExtractionFingerprints`) and delegates all side effects
 * to injected orchestrator methods.
 */
export class ExtractionRunCoordinator {
  private readonly recentExtractionFingerprints = new Map<string, number>();
  // Per-fingerprint extraction retry/backoff state (extraction hot-loop
  // hardening). Outer key = namespace, inner key = fingerprint. Hydrated lazily
  // from namespace-scoped meta so the hot path is a Map lookup; persisted back
  // to meta on change (restart-safe, cross-process coherent via the shared
  // meta.json). The breaker below is intentionally per-process in-memory
  // (mirrors local-llm.cooldownUntilMs); a restart clears it but the persisted
  // backoff still throttles, so a restart can't resurrect the hot loop.
  private readonly extractionRetryState = new Map<string, Map<string, ExtractionRetryStateEntry>>();
  private readonly hydratedRetryNamespaces = new Set<string>();
  private providerBreaker: {
    consecutiveFailures: number;
    openUntilMs: number;
    state: "closed" | "open" | "half_open";
    lastReason: string;
  } = { consecutiveFailures: 0, openUntilMs: 0, state: "closed", lastReason: "" };

  constructor(private readonly deps: ExtractionRunCoordinatorDeps) {}

  private get config(): PluginConfig {
    return this.deps.config;
  }

  // -------------------------------------------------------------------------
  // Source-valid-at helpers (moved from orchestrator.ts module scope)
  // -------------------------------------------------------------------------

  private latestSourceValidAtFromTurns(turns: readonly BufferTurn[]): string | undefined {
    let latestMs: number | null = null;
    for (const turn of turns) {
      if (turn.extractionContextOnly === true) continue;
      if (typeof turn.sourceValidAt !== "string") continue;
      const parsed = parseFlexibleIsoTimestamp(turn.sourceValidAt.trim());
      if (parsed === null) continue;
      if (latestMs === null || parsed > latestMs) {
        latestMs = parsed;
      }
    }
    return latestMs === null ? undefined : new Date(latestMs).toISOString();
  }

  // -------------------------------------------------------------------------
  // Extraction dedupe fingerprint helpers
  // -------------------------------------------------------------------------

  normalizeExtractionFingerprintTurns(turns: BufferTurn[]): string[] {
    if (!Array.isArray(turns) || turns.length === 0) return [];
    return turns
      .filter((turn) => turn.role === "user" || turn.role === "assistant")
      .map((turn) => {
        if (typeof turn.turnFingerprint === "string" && turn.turnFingerprint.length > 0) {
          return `fp:${turn.turnFingerprint}`;
        }
        return `${turn.role}:${(turn.content ?? "").replace(/\s+/g, " ").trim().slice(0, this.config.extractionMaxTurnChars)}`;
      })
      .filter((value) => value.length > 0);
  }

  buildExtractionFingerprint(turns: BufferTurn[], bufferKey: string): string | null {
    const normalized = this.normalizeExtractionFingerprintTurns(turns).join("\n");
    if (!normalized) return null;
    return createHash("sha256").update(`${bufferKey}\n${normalized}`).digest("hex");
  }

  shouldQueueExtraction(turns: BufferTurn[], options: { commit?: boolean; bufferKey?: string } = {}): boolean {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
    if (!lifecycleCaps.extractionDedupe) return true;
    if (!Array.isArray(turns) || turns.length === 0) return false;

    const bufferKey = options.bufferKey ?? turns[0]?.sessionKey ?? "default";
    const fingerprint = this.buildExtractionFingerprint(turns, bufferKey);
    if (!fingerprint) return false;
    const now = Date.now();
    const seenAt = this.recentExtractionFingerprints.get(fingerprint);
    if (seenAt && now - seenAt < this.config.extractionDedupeWindowMs) {
      log.debug("extraction dedupe: skipped duplicate buffered turn set");
      return false;
    }

    if (options.commit !== false) {
      this.recentExtractionFingerprints.set(fingerprint, now);
    }
    // Keep this cache bounded to avoid unbounded growth.
    if (options.commit !== false && this.recentExtractionFingerprints.size > 200) {
      const entries = Array.from(this.recentExtractionFingerprints.entries()).sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, entries.length - 200)) {
        this.recentExtractionFingerprints.delete(key);
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Processed-fingerprint recording
  // -------------------------------------------------------------------------

  async recordProcessedExtractionFingerprint(
    storage: StorageManager,
    fingerprint: string,
    preloadedMeta?: Awaited<ReturnType<StorageManager["loadMeta"]>>
  ): Promise<void> {
    const meta = preloadedMeta ?? (await storage.loadMeta());
    const observedAt = new Date().toISOString();
    const seen = new Map(
      (meta.processedExtractionFingerprints ?? []).map((entry) => [entry.fingerprint, entry.observedAt])
    );
    seen.set(fingerprint, observedAt);
    meta.processedExtractionFingerprints = Array.from(seen.entries())
      .map(([value, at]) => ({ fingerprint: value, observedAt: at }))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .slice(-500);
    if (!preloadedMeta) {
      await storage.saveMeta(meta);
    }
  }

  // -------------------------------------------------------------------------
  // Extraction retry/backoff + circuit breaker (extraction hot-loop hardening)
  // -------------------------------------------------------------------------

  /** Lazily hydrate the in-memory retry-state mirror for a namespace from meta.
   *  One-time per namespace per coordinator; the hot path is then a Map lookup.
   *  Cross-process coherence: a fresh coordinator hydrates from the shared
   *  meta.json, so a failure persisted by another process is honored here. */
  private hydrateRetryStateFromMeta(namespace: string, meta: MetaState): void {
    if (this.hydratedRetryNamespaces.has(namespace)) return;
    this.hydratedRetryNamespaces.add(namespace);
    const nsMap = this.extractionRetryState.get(namespace) ?? new Map<string, ExtractionRetryStateEntry>();
    for (const entry of meta.extractionRetryState ?? []) {
      const nextEligibleAtMs = Date.parse(entry.nextEligibleAt);
      const firstFailedAtMs = Date.parse(entry.firstFailedAt);
      nsMap.set(entry.fingerprint, {
        attempts: entry.attempts,
        nextEligibleAtMs: Number.isFinite(nextEligibleAtMs) ? nextEligibleAtMs : 0,
        firstFailedAtMs: Number.isFinite(firstFailedAtMs) ? firstFailedAtMs : Date.now(),
        lastFailureClass: entry.lastFailureClass,
      });
    }
    this.extractionRetryState.set(namespace, nsMap);
  }

  private logBreakerTransition(state: "closed" | "open" | "half_open"): void {
    // Once per state change (not per attempt) — AGENTS.md observability rule.
    log.warn("extraction: provider circuit breaker transition", {
      state,
      consecutiveFailures: this.providerBreaker.consecutiveFailures,
      lastReason: this.providerBreaker.lastReason,
      openUntilMs: this.providerBreaker.openUntilMs,
    });
  }

  /** True while the breaker suppresses non-forced attempts. Flips an expired
   *  `open` breaker to `half_open`, which allows exactly one probe (the next
   *  non-forced attempt) because the extraction queue is a serial drain. */
  private isProviderBreakerOpen(now: number): boolean {
    if (now < this.providerBreaker.openUntilMs) return true;
    if (this.providerBreaker.state === "open") {
      this.providerBreaker.state = "half_open";
      this.logBreakerTransition("half_open");
    }
    return false;
  }

  private onProviderFailure(cls: ExtractionFailureClass, now: number): void {
    this.providerBreaker.consecutiveFailures += 1;
    const trip =
      cls === "auth_config" ||
      // A failed half-open probe re-opens immediately (standard breaker
      // semantics). Without this, an auth_config-opened breaker (which trips
      // below the threshold) would get stuck half_open after a transient
      // probe failure and stop suppressing (cursor review).
      this.providerBreaker.state === "half_open" ||
      this.providerBreaker.consecutiveFailures >= this.config.extractionBreakerFailureThreshold;
    if (!trip) return;
    const cooldown =
      cls === "auth_config"
        ? this.config.extractionBreakerAuthCooldownMs
        : this.config.extractionBreakerCooldownMs;
    this.providerBreaker.openUntilMs = now + Math.max(0, cooldown);
    this.providerBreaker.lastReason = cls;
    if (this.providerBreaker.state !== "open") {
      this.providerBreaker.state = "open";
      this.logBreakerTransition("open");
    }
  }

  private resetProviderBreakerOnSuccess(): void {
    const wasDisturbed =
      this.providerBreaker.state !== "closed" ||
      this.providerBreaker.consecutiveFailures > 0 ||
      this.providerBreaker.openUntilMs > 0;
    if (!wasDisturbed) return;
    const wasOpen = this.providerBreaker.state !== "closed";
    this.providerBreaker.consecutiveFailures = 0;
    this.providerBreaker.openUntilMs = 0;
    this.providerBreaker.lastReason = "";
    this.providerBreaker.state = "closed";
    if (wasOpen) this.logBreakerTransition("closed");
  }

  /** Rebuild `meta.extractionRetryState` from the in-memory namespace mirror,
   *  bounded to the newest entries, and prune the mirror to match. */
  private persistRetryStateToMeta(namespace: string, meta: MetaState): void {
    const nsMap = this.extractionRetryState.get(namespace);
    const entries = nsMap
      ? Array.from(nsMap.entries()).map(([fingerprint, st]) => ({
          fingerprint,
          attempts: st.attempts,
          nextEligibleAt: new Date(st.nextEligibleAtMs).toISOString(),
          firstFailedAt: new Date(st.firstFailedAtMs).toISOString(),
          lastFailureClass: st.lastFailureClass,
        }))
      : [];
    const capped = capExtractionRetryStateEntries(entries, EXTRACTION_RETRY_STATE_MAX_ENTRIES);
    meta.extractionRetryState = capped;
    if (nsMap && capped.length < nsMap.size) {
      const kept = new Set(capped.map((e) => e.fingerprint));
      for (const key of Array.from(nsMap.keys())) {
        if (!kept.has(key)) nsMap.delete(key);
      }
    }
  }
  /** Record an extraction failure into per-fingerprint backoff state + breaker,
   *  persisting to namespace meta. Fail-open: never throws upward. */
  private async recordExtractionFailure(
    storage: StorageManager,
    namespace: string,
    fingerprint: string,
    cls: ExtractionFailureClass,
    meta: MetaState,
    now: number,
  ): Promise<void> {
    try {
      this.hydrateRetryStateFromMeta(namespace, meta);
      const nsMap = this.extractionRetryState.get(namespace) ?? new Map<string, ExtractionRetryStateEntry>();
      const prev = nsMap.get(fingerprint);
      const attempts = (prev?.attempts ?? 0) + 1;
      const firstFailedAtMs = prev?.firstFailedAtMs ?? now;
      let nextEligibleAtMs: number;
      if (cls === "parse_empty" && attempts > this.config.extractionParseEmptyMaxAttempts) {
        // parse_empty exhausted its attempt budget → long-park (still never
        // marked processed). A dead gateway also yields unparseable output.
        nextEligibleAtMs = now + Math.max(0, this.config.extractionRetryMaxBackoffMs);
      } else {
        nextEligibleAtMs = computeExtractionRetryNextEligibleMs(
          attempts,
          this.config.extractionRetryScheduleMs,
          this.config.extractionRetryMaxBackoffMs,
          this.config.extractionRetryJitterRatio,
          now,
        );
      }
      nsMap.set(fingerprint, { attempts, nextEligibleAtMs, firstFailedAtMs, lastFailureClass: cls });
      this.extractionRetryState.set(namespace, nsMap);
      this.onProviderFailure(cls, now);
      this.persistRetryStateToMeta(namespace, meta);
      await storage.saveMeta(meta);
    } catch (err) {
      // Fail-open: recording failure state must never crash observe/recall.
      log.warn("runExtraction: failed to record extraction retry state (non-fatal)", err);
    }
  }

  /** Delete a fingerprint's retry entry from the mirror + meta. Returns whether
   *  meta changed (so the caller can decide to persist). Does not touch the
   *  breaker — callers pair this with `resetProviderBreakerOnSuccess`. */
  private clearExtractionRetryEntry(namespace: string, fingerprint: string, meta: MetaState): boolean {
    const nsMap = this.extractionRetryState.get(namespace);
    if (!nsMap?.has(fingerprint)) return false;
    nsMap.delete(fingerprint);
    this.persistRetryStateToMeta(namespace, meta);
    return true;
  }

  /** Live in-process resilience snapshot (breaker + backoff population). */
  getExtractionResilienceStatus(): ExtractionResilienceStatus {
    let backoffFingerprintCount = 0;
    for (const nsMap of this.extractionRetryState.values()) {
      backoffFingerprintCount += nsMap.size;
    }
    return {
      breaker: {
        state: this.providerBreaker.state,
        openUntilMs: this.providerBreaker.openUntilMs,
        consecutiveFailures: this.providerBreaker.consecutiveFailures,
        lastReason: this.providerBreaker.lastReason,
      },
      backoffFingerprintCount,
    };
  }

  // -------------------------------------------------------------------------
  // Main extraction pipeline
  // -------------------------------------------------------------------------

  async runExtraction(
    turns: BufferTurn[],
    options: {
      clearBufferAfterExtraction?: boolean;
      clearMatchingTurns?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      deadlineMs?: number;
      bufferKey?: string;
      abortSignal?: AbortSignal;
      failOnExtractionFailure?: boolean;
      /**
       * Explicit namespace override for the write path (#460).  When set,
       * extraction writes go to this namespace instead of the one derived
       * from `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))`.
       * The resolved `principal` is still threaded into memory metadata
       * for provenance; only the storage target is overridden.
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance principal instead of deriving it from
       * `resolvePrincipal(sessionKey)` (#1495 thread 1). When set, this is the
       * identity an access surface already authenticated; used so observed-turn
       * provenance is correct even though `turn.sessionKey` is the ORIGINAL
       * (un-prefixed) key and storage is pinned via `writeNamespaceOverride`.
       */
      principalOverride?: string;
      /**
       * Force the extractor call, bypassing the retry-backoff / circuit-breaker
       * gate (extraction hot-loop hardening). Set by explicit flush paths
       * (before_reset / session flush / replay / bulk import) that already pass
       * `skipDedupeCheck: true` — AGENTS.md rule 18. A forced attempt still
       * records its failure into retry-state/breaker.
       */
      forceExtractionAttempt?: boolean;
    } = {}
  ): Promise<ExtractionRunResult> {
    log.debug(`running extraction on ${turns.length} turns`);
    const clearBufferAfterExtraction = options.clearBufferAfterExtraction ?? true;
    const clearMatchingTurns = options.clearMatchingTurns === true;
    const skipCharThreshold = options.skipCharThreshold ?? false;
    const skipUserTurnThreshold = options.skipUserTurnThreshold ?? false;
    const deadlineMs =
      typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs) ? options.deadlineMs : undefined;
    const bufferKey = options.bufferKey ?? turns[0]?.sessionKey ?? "default";
    const throwIfDeadlineExceeded = (stage: string): void => {
      if (typeof deadlineMs === "number" && Date.now() >= deadlineMs) {
        throw new ExtractionDeadlineError(stage);
      }
    };
    const throwIfAborted = (stage: string): void => {
      throwIfRecallAborted(options.abortSignal, `extraction aborted (${stage})`);
    };
    const runPassiveCapture = async (
      captureTurns: readonly BufferTurn[],
      captureOptions: {
        sessionKey: string;
        principal?: string;
        namespace: string;
        bufferKey: string;
        isLiveSession: boolean;
      },
    ): Promise<void> => {
      const deadlineController =
        typeof deadlineMs === "number" && Number.isFinite(deadlineMs) ? new AbortController() : undefined;
      const captureSignal = deadlineController
        ? options.abortSignal
          ? AbortSignal.any([options.abortSignal, deadlineController.signal])
          : deadlineController.signal
        : options.abortSignal;
      let deadlineTimer: NodeJS.Timeout | undefined;
      if (deadlineController && typeof deadlineMs === "number") {
        const scheduleDeadlineAbort = (): void => {
          const remainingMs = deadlineMs - Date.now();
          if (remainingMs <= 0) {
            deadlineController.abort();
            return;
          }
          deadlineTimer = setTimeout(
            () => {
              if (Date.now() >= deadlineMs) {
                deadlineController.abort();
              } else {
                scheduleDeadlineAbort();
              }
            },
            Math.min(remainingMs, 2_147_483_647),
          );
        };
        scheduleDeadlineAbort();
      }
      try {
        await raceRecallAbort(
          this.deps.maybeCapturePassiveCorrections(captureTurns, {
            ...captureOptions,
            ...(captureSignal ? { abortSignal: captureSignal } : {}),
          }),
          captureSignal,
          "extraction aborted (during_passive_capture)",
        );
      } catch (error) {
        if (typeof deadlineMs === "number" && Date.now() >= deadlineMs) {
          throw new ExtractionDeadlineError("during_passive_capture");
        }
        throw error;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    };
    const clearBuffer = async (options?: { ignoreAbort?: boolean }) => {
      if (options?.ignoreAbort !== true) {
        throwIfDeadlineExceeded("before_clear_buffer");
        throwIfAborted("before_clear_buffer");
      }
      if (clearBufferAfterExtraction) {
        await this.deps
          .getBuffer()
          .clearAfterExtraction(bufferKey, turns, clearMatchingTurns ? { allowNonPrefix: true } : undefined);
      }
    };

    // Skip extraction for cron job sessions - these are system operations, not user conversations
    const sessionKey = turns[0]?.sessionKey ?? "";
    if (sessionKey.includes(":cron:")) {
      log.debug(`skipping extraction for cron session: ${sessionKey}`);
      await clearBuffer();
      return {
        status: "skipped",
        reason: "cron_session",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }

    const normalizedTurns = turns
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({
        ...t,
        content: t.content.trim().slice(0, this.config.extractionMaxTurnChars),
      }))
      .filter((t) => t.content.length > 0);
    const targetTurns = normalizedTurns.filter((turn) => turn.extractionContextOnly !== true);
    if (targetTurns.length === 0) {
      log.debug("skipping extraction: no non-context turns after normalization");
      // Context-only turns may still contain corrections (review: "context-only
      // turns skip capture"). Scan normalizedTurns before clearing the buffer.
      if (normalizedTurns.length > 0) {
        throwIfDeadlineExceeded("before_context_only_capture");
        const capturePrincipal =
          typeof options.principalOverride === "string" && options.principalOverride.length > 0
            ? options.principalOverride
            : resolvePrincipal(sessionKey, this.config);
        const captureNamespace =
          typeof options.writeNamespaceOverride === "string" && options.writeNamespaceOverride.length > 0
            ? options.writeNamespaceOverride
            : this.deps.resolveSelfNamespace(sessionKey);
        await runPassiveCapture(normalizedTurns as BufferTurn[], {
          sessionKey,
          principal: capturePrincipal,
          namespace: captureNamespace,
          bufferKey,
          isLiveSession: clearBufferAfterExtraction,
        });
        throwIfDeadlineExceeded("before_context_only_clear");
      }
      await clearBuffer();
      return { status: "skipped", reason: "empty_normalized_turns", persistedCount: 0, durableOutputCount: 0 };
    }
    const sourceValidAt = this.latestSourceValidAtFromTurns(targetTurns);
    throwIfDeadlineExceeded("before_extract");
    throwIfAborted("before_extract");

    const userTurns = targetTurns.filter((t) => t.role === "user");
    const totalChars = targetTurns.reduce((sum, t) => sum + t.content.length, 0);
    const belowCharThreshold = totalChars < this.config.extractionMinChars;
    const belowUserTurnThreshold = !skipUserTurnThreshold && userTurns.length < this.config.extractionMinUserTurns;
    if ((!skipCharThreshold && belowCharThreshold) || belowUserTurnThreshold) {
      log.debug(`skipping extraction: below threshold (totalChars=${totalChars}, userTurns=${userTurns.length})`);
      // Passive correction capture runs even when extraction is skipped for
      // being below the char/user-turn threshold (review: "skipped extraction
      // skips capture"). A short correction like "stop using Vim" is under
      // extractionMinChars but is exactly the high-value case this feature
      // exists for. The write namespace resolves through the SAME scope-profile
      // plan as the full extraction path so corrections target the active
      // profile's write layer, not just resolveSelfNamespace (review:
      // "below-threshold wrong namespace"). The ACL in passiveCorrectionService
      // authorizes the actual plan/apply.
      {
        const capturePrincipal =
          typeof options.principalOverride === "string" && options.principalOverride.length > 0
            ? options.principalOverride
            : resolvePrincipal(sessionKey, this.config);
        const captureWO =
          typeof options.writeNamespaceOverride === "string" && options.writeNamespaceOverride.length > 0
            ? options.writeNamespaceOverride
            : undefined;
        const captureCodingCtx = sessionKey ? this.deps.getCodingContextForSession(sessionKey) : null;
        const captureCodingOv = resolveCodingNamespaceOverlay(
          captureCodingCtx,
          this.config.codingMode,
          this.config.defaultNamespace
        );
        const captureScopePlan = resolveScopeProfilePlan({
          config: this.config,
          principal: capturePrincipal,
          codingContext: captureCodingCtx,
          codingOverlay: captureCodingOv,
        });
        const captureNamespace =
          captureWO ?? captureScopePlan?.writeNamespace ?? this.deps.resolveSelfNamespace(sessionKey);
        await runPassiveCapture(normalizedTurns as BufferTurn[], {
          sessionKey,
          principal: capturePrincipal,
          namespace: captureNamespace,
          bufferKey,
          isLiveSession: clearBufferAfterExtraction,
        });
      }
      await clearBuffer();
      return {
        status: "skipped",
        reason: "below_threshold",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }

    // Provenance principal honours the access-surface override (#1495 thread 1,
    // mirroring the recall path's `principalOverride`, issue #570 PR 4). Access
    // surfaces that authenticated the caller at the transport layer pass their
    // resolved principal so provenance uses the SAME identity the surface
    // authorized, instead of `resolvePrincipal(sessionKey)` — which on a
    // namespace-prefixed key would collapse to `default`. The ORIGINAL,
    // un-prefixed session key still drives threading.
    const principal =
      typeof options.principalOverride === "string" && options.principalOverride.length > 0
        ? options.principalOverride
        : resolvePrincipal(sessionKey, this.config);
    // Write path — explicit callers still win. Otherwise, an active hosted
    // scope profile owns the extraction write target so hook-captured turns land
    // in the same layer that profile recall searches. Without a profile, preserve
    // the existing coding-agent overlay behavior (issue #569).
    const explicitWriteNamespace =
      typeof options.writeNamespaceOverride === "string" && options.writeNamespaceOverride.length > 0
        ? options.writeNamespaceOverride
        : undefined;
    const codingContextForWrite = sessionKey ? this.deps.getCodingContextForSession(sessionKey) : null;
    const codingOverlayForWrite = resolveCodingNamespaceOverlay(
      codingContextForWrite,
      this.config.codingMode,
      this.config.defaultNamespace
    );
    const scopeProfileGatePlan = resolveScopeProfilePlan({
      config: this.config,
      principal,
      codingContext: codingContextForWrite,
      codingOverlay: codingOverlayForWrite,
    });
    const scopeProfileWritePlan = explicitWriteNamespace ? null : scopeProfileGatePlan;
    if (scopeProfileWritePlan) {
      const selectedLayer = scopeProfileWritePlan.layers.find((layer) => layer.id === scopeProfileWritePlan.writeLayer);
      const writeNamespaceReadable = scopeProfileWritePlan.readNamespaces.includes(
        scopeProfileWritePlan.writeNamespace
      );
      if (!selectedLayer?.writable || !writeNamespaceReadable) {
        log.warn(
          `runExtraction: skipping scope profile ${scopeProfileWritePlan.profileId} because write layer ${scopeProfileWritePlan.writeLayer} is not writable inside the profile read stack`
        );
        await clearBuffer();
        return {
          status: "skipped",
          reason: "scope_profile_no_writable_layer",
          persistedCount: 0,
          durableOutputCount: 0,
        };
      }
    }
    const selfNamespace =
      explicitWriteNamespace ??
      scopeProfileWritePlan?.writeNamespace ??
      this.deps.applyCodingNamespaceOverlay(sessionKey, defaultNamespaceForPrincipal(principal, this.config));
    const extractionDeadlineController =
      typeof deadlineMs === "number" && Number.isFinite(deadlineMs)
        ? new AbortController()
        : undefined;
    const extractionAbortSignal = extractionDeadlineController
      ? options.abortSignal
        ? AbortSignal.any([options.abortSignal, extractionDeadlineController.signal])
        : extractionDeadlineController.signal
      : options.abortSignal;
    let extractionDeadlineTimer: NodeJS.Timeout | undefined;
    const clearExtractionDeadlineTimer = (): void => {
      if (extractionDeadlineTimer) {
        clearTimeout(extractionDeadlineTimer);
        extractionDeadlineTimer = undefined;
      }
    };
    const runDeadlineAware = async <T>(operation: () => Promise<T>, phase: string): Promise<T> => {
      try {
        return await raceRecallAbort(
          operation(),
          extractionDeadlineController?.signal,
          `extraction aborted (${phase})`,
        );
      } catch (error) {
        clearExtractionDeadlineTimer();
        if (typeof deadlineMs === "number" && Date.now() >= deadlineMs) {
          throw new ExtractionDeadlineError(phase);
        }
        throw error;
      }
    };
    if (extractionDeadlineController && typeof deadlineMs === "number") {
      const deadline = deadlineMs;
      const maxTimerDelayMs = 2_147_483_647;
      const scheduleDeadlineAbort = (): void => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          extractionDeadlineController.abort();
          return;
        }
        extractionDeadlineTimer = setTimeout(() => {
          if (Date.now() >= deadline) {
            extractionDeadlineController.abort();
          } else {
            scheduleDeadlineAbort();
          }
        }, Math.min(remainingMs, maxTimerDelayMs));
      };
      scheduleDeadlineAbort();
    }
    const storage = await runDeadlineAware(
      () => this.deps.getStorageRouter().storageFor(selfNamespace),
      "during_storage",
    );
    const shouldPersistProcessedFingerprint = targetTurns.some((turn) => turn.persistProcessedFingerprint === true);
    const extractionFingerprint = this.buildExtractionFingerprint(targetTurns, bufferKey);
    let meta = extractionFingerprint && shouldPersistProcessedFingerprint
      ? await runDeadlineAware(() => storage.loadMeta(), "during_load_meta")
      : null;
    if (
      extractionFingerprint &&
      shouldPersistProcessedFingerprint &&
      (meta?.processedExtractionFingerprints ?? []).some((entry) => entry.fingerprint === extractionFingerprint)
    ) {
      await runDeadlineAware(() => clearBuffer(), "during_clear_buffer");
      clearExtractionDeadlineTimer();
      return {
        status: "skipped",
        reason: "processed_fingerprint",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }

    // Extraction retry/backoff + circuit-breaker gate (extraction hot-loop
    // hardening). Suppresses re-attempts of a recently-failed fingerprint and
    // short-circuits every fingerprint while the provider breaker is open, so a
    // failing LLM endpoint is not hammered once per observe. Forced flushes and
    // fail-closed callers bypass the gate (rule 18) but still record failures.
    // On a suppressed attempt the buffer is deliberately NOT cleared, so no
    // extractable turn is dropped — it is retried after cooldown/nextEligibleAt.
    const forcedExtractionAttempt =
      options.failOnExtractionFailure === true || options.forceExtractionAttempt === true;
    // Resolve the gate through the shared lifecycle capability plan (issue
    // #1523) rather than reading the raw config flag at each call site.
    const extractionRetryEnabled = resolveMemoryLifecycleCapabilities(this.config).extractionRetry;
    if (extractionFingerprint && !forcedExtractionAttempt && extractionRetryEnabled) {
      try {
        meta ??= await runDeadlineAware(() => storage.loadMeta(), "during_retry_gate");
        this.hydrateRetryStateFromMeta(selfNamespace, meta);
        const nowMs = Date.now();
        let suppressReason: "provider_circuit_open" | "extraction_backoff" | null = null;
        if (this.isProviderBreakerOpen(nowMs)) {
          suppressReason = "provider_circuit_open";
        } else {
          const st = this.extractionRetryState.get(selfNamespace)?.get(extractionFingerprint);
          if (st && nowMs < st.nextEligibleAtMs) suppressReason = "extraction_backoff";
        }
        if (suppressReason) {
          // Passive correction capture is local and must not be delayed by a
          // provider cooldown. It remains fail-open.
          try {
            await runDeadlineAware(
              () => runPassiveCapture(normalizedTurns as BufferTurn[], {
                sessionKey,
                principal,
                namespace: selfNamespace,
                bufferKey,
                isLiveSession: clearBufferAfterExtraction,
              }),
              "during_passive_capture",
            );
          } catch (captureErr) {
            if (captureErr instanceof ExtractionDeadlineError) throw captureErr;
            log.warn("runExtraction: passive correction capture failed on suppressed attempt (non-fatal)", captureErr);
          }
          clearExtractionDeadlineTimer();
          return { status: "skipped", reason: suppressReason, persistedCount: 0, durableOutputCount: 0 };
        }
      } catch (err) {
        if (err instanceof ExtractionDeadlineError) throw err;
        // Fail-open: a gate error must never block extraction.
        log.warn("runExtraction: extraction retry gate check failed; proceeding (fail-open)", err);
      }
    }

    // Pass existing entity names so the LLM can reuse them instead of inventing variants.
    const existingEntities = await runDeadlineAware(
      () => storage.listEntityNames(),
      "during_list_entity_names",
    );
    let result: ExtractionResult;
    try {
      result = await raceRecallAbort(
        this.deps.getExtraction().extract(normalizedTurns, existingEntities, extractionAbortSignal),
        extractionAbortSignal,
        "extraction aborted (during_extract)",
      );
    } catch (error) {
      if (typeof deadlineMs === "number" && Date.now() >= deadlineMs) {
        throw new ExtractionDeadlineError("during_extract");
      }
      throw error;
    } finally {
      if (extractionDeadlineTimer) {
        clearTimeout(extractionDeadlineTimer);
        extractionDeadlineTimer = undefined;
      }
    }
    throwIfDeadlineExceeded("before_persist");
    throwIfAborted("before_persist");

    // Defensive: validate extraction result before processing. Explicit
    // fail-closed callers, such as flush-plan import, must not observe
    // malformed extractor output as a successful skip.
    if (!result) {
      log.warn("runExtraction: extraction returned null/undefined");
      if (options.failOnExtractionFailure) {
        throw new Error("extraction failed: invalid_extraction_result");
      }
      await clearBuffer();
      return {
        status: "skipped",
        reason: "invalid_extraction_result",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }
    const invalidExtractionResultFields = [
      ["facts", result.facts],
      ["entities", result.entities],
      ["questions", result.questions],
      ["profileUpdates", result.profileUpdates],
    ]
      .filter(([, value]) => !Array.isArray(value))
      .map(([field]) => field);
    if (invalidExtractionResultFields.length > 0) {
      log.warn("runExtraction: extraction returned invalid collection fields", {
        invalidFields: invalidExtractionResultFields,
        resultKeys: typeof result === "object" && result !== null ? Object.keys(result) : [],
      });
      if (options.failOnExtractionFailure) {
        throw new Error("extraction failed: invalid_extraction_result");
      }
      await clearBuffer();
      return {
        status: "skipped",
        reason: "invalid_extraction_result",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }
    const extractionFailure =
      typeof result.extractionFailure === "string" && result.extractionFailure.trim().length > 0
        ? result.extractionFailure
        : undefined;
    let recordedRetryFailure = false;
    // Record failure into backoff/breaker state, or heal on success. Runs for
    // every result path (empty and durable), before the fail-closed throw, so a
    // forced flush still records its failure (rule 18). Gated by
    // extractionRetryEnabled so a disabled feature restores prior behavior.
    if (extractionFingerprint && extractionRetryEnabled) {
      if (extractionFailure) {
        try {
          meta ??= await storage.loadMeta();
          await this.recordExtractionFailure(
            storage,
            selfNamespace,
            extractionFingerprint,
            result.extractionFailureClass ?? "provider_retryable",
            meta,
            Date.now(),
          );
          // The buffer is retained below so the backoff gate can re-attempt
          // these turns after nextEligibleAt — clearing would orphan the
          // retry state.
          recordedRetryFailure = true;
        } catch (err) {
          // Fail-open (codex review): retry bookkeeping is best-effort — a
          // corrupt or locked meta store must not reject the extraction task.
          // With no backoff recorded there is nothing to retain for, so the
          // pre-#1908 clear-buffer behavior applies below.
          log.warn("runExtraction: failed to load meta for retry bookkeeping (non-fatal)", err);
        }
      } else {
        // Provider responded without failure → breaker heals; clear any
        // parked backoff for this fingerprint so it proceeds normally.
        this.resetProviderBreakerOnSuccess();
        try {
          meta ??= await storage.loadMeta();
          // Hydrate the in-memory mirror from persisted meta before clearing.
          // A forced flush (forceExtractionAttempt) bypasses the retry gate and
          // never hydrated, so without this a stale persisted backoff entry
          // would survive a successful forced flush and keep blocking normal
          // extraction until the timer expired (cursor/codex review).
          this.hydrateRetryStateFromMeta(selfNamespace, meta);
          if (this.clearExtractionRetryEntry(selfNamespace, extractionFingerprint, meta)) {
            await storage.saveMeta(meta);
          }
        } catch (err) {
          log.warn("runExtraction: failed to persist cleared retry state (non-fatal)", err);
        }
      }
    }
    if (options.failOnExtractionFailure && extractionFailure) {
      throw new Error(`extraction failed: ${extractionFailure}`);
    }
    if (
      result.facts.length === 0 &&
      result.entities.length === 0 &&
      result.questions.length === 0 &&
      result.profileUpdates.length === 0
    ) {
      log.debug("runExtraction: extraction produced no durable outputs; skipping persistence");
      if (extractionFailure) {
        log.warn(
          "runExtraction: extraction reported failure with no durable outputs; not marking fingerprint processed",
          { extractionFailure }
        );
      }
      if (extractionFingerprint && shouldPersistProcessedFingerprint && !extractionFailure) {
        meta ??= await storage.loadMeta();
        await this.deps.recordProcessedExtractionFingerprint(storage, extractionFingerprint, meta);
        meta.extractionCount += 1;
        meta.lastExtractionAt = new Date().toISOString();
        await storage.saveMeta(meta);
      }
      // Correction-only turns that meet char/user-turn thresholds but yield
      // zero facts still need passive capture (review: "empty extraction skips
      // capture"). selfNamespace/principal already resolved above.
      await runPassiveCapture(normalizedTurns as BufferTurn[], {
        sessionKey,
        principal,
        namespace: selfNamespace,
        bufferKey,
        isLiveSession: clearBufferAfterExtraction,
      });
      if (recordedRetryFailure) {
        // Retain the failed turns so the backoff gate can re-attempt them after
        // nextEligibleAt. Clearing here would lose the data the retry state
        // points at (cursor high + codex P1). Trigger/forced paths already
        // retain via clearBufferAfterExtraction=false; this covers the normal
        // live-session path. Overflow is bounded by MAX_BUFFER_ENTRY_COUNT
        // with a loud eviction log.
        log.debug("runExtraction: retaining buffer for backoff retry after failure");
      } else {
        await clearBuffer();
      }
      return { status: "skipped", reason: "empty_extraction_result", persistedCount: 0, durableOutputCount: 0 };
    }

    let threadIdForExtraction: string | null = null;
    if (resolvePresentationCapabilities(this.config).threading && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      try {
        threadIdForExtraction = await this.deps.getThreading().processTurn(lastTurn, []);
      } catch (err) {
        // Fail-open: threading errors must not block memory persistence.
        log.warn("[threading] processTurn failed before persistence (non-fatal)", err);
      }
    }

    const { persistedIds } = await this.deps.persistExtraction(
      result,
      storage,
      threadIdForExtraction,
      { sessionKey, principal, validAt: sourceValidAt, sourceConnector: deriveSourceConnector(targetTurns as BufferTurn[]) },
      // Pass the KNOWN base namespace (NHIdx) so the catalog write touch records the
      // real namespace rather than a guess decoded from the storage dir.
      selfNamespace,
      scopeProfileGatePlan,
      // Verbatim source turns for the faithfulness gate (#1576) so it can
      // locate a quote per fact when #1575 spans are absent.
      normalizedTurns
        .map((t) => t.content)
        .join("\n\n")
    );
    let postPersistMetadataFailed = false;
    meta ??= await storage.loadMeta();
    if (extractionFingerprint && shouldPersistProcessedFingerprint) {
      try {
        await this.deps.recordProcessedExtractionFingerprint(storage, extractionFingerprint, meta);
      } catch (error) {
        log.warn(
          "runExtraction: failed to persist processed extraction fingerprint; continuing with buffer clear",
          error
        );
        postPersistMetadataFailed = true;
      }
    }
    // Persist extraction counters and processed fingerprints before running
    // follow-on helpers so replay dedupe survives any later non-essential
    // failure. If this aggregate meta write fails, still clear the buffer:
    // the durable memories are already written and replaying the same turns
    // would duplicate them.
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(result?.facts) ? result.facts.length : 0;
    meta.totalEntities += Array.isArray(result?.entities) ? result.entities.length : 0;
    try {
      await storage.saveMeta(meta);
    } catch (error) {
      log.warn(
        "runExtraction: failed to save extraction metadata after durable persistence; continuing with buffer clear",
        error
      );
      postPersistMetadataFailed = true;
    }

    const durableOutputCount =
      result.facts.length + result.entities.length + result.questions.length + result.profileUpdates.length;

    // Buffer retention for defer verdicts (issue #562, PR 2). When the judge
    // deferred at least one candidate, retain the tail of the current turn
    // window so the next extraction pass has the surrounding context that
    // may disambiguate the deferred fact. Non-defer runs clear the slot.
    //
    // Gated on:
    //   - `clearBufferAfterExtraction` — replay / bulk-import paths call
    //     `runExtraction` with this false and do not operate on live buffer
    //     state. Writing retention there would create synthetic buffer
    //     entries and cross-contaminate future live extractions.
    //   - NOT `extractionJudgeShadow` — in shadow mode the judge is only
    //     advisory; facts are still persisted regardless of verdict, so
    //     retaining the turn window on top of a persisted write would both
    //     waste buffer space and cause the same facts to re-enter the
    //     pipeline on the next pass.
    try {
      if (clearBufferAfterExtraction && !this.config.extractionJudgeShadow) {
        const deferredCount = this.deps.getLastPersistExtractionDeferredCount();
        if (deferredCount > 0 && normalizedTurns.length > 0) {
          await this.deps.getBuffer().retainDeferredTurns(bufferKey, normalizedTurns as BufferTurn[], 10);
        } else {
          await this.deps.getBuffer().retainDeferredTurns(bufferKey, [], 0);
        }
      }
    } catch (err) {
      // Fail-open: retention is a nice-to-have. If it fails the judge will
      // still cap deferrals and convert to reject on the next pass.
      log.debug(
        `extraction-judge: defer retention failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await clearBuffer({ ignoreAbort: true });

    // Passive correction capture (issue #1581) — detect corrections expressed
    // passively in the extracted turns and route to the Correction Contract.
    // Runs AFTER persistence + buffer clear so a capture failure never blocks
    // the extraction return. `clearBufferAfterExtraction` gates live-session
    // auto-apply (replay/import → queue-only).
    try {
      await runPassiveCapture(normalizedTurns as BufferTurn[], {
        sessionKey,
        principal,
        namespace: selfNamespace,
        bufferKey,
        isLiveSession: clearBufferAfterExtraction,
      });
    } catch (captureErr) {
      log.debug("runExtraction: post-persist passive correction capture failed (non-fatal)", captureErr);
    }

    // Build memory box from this extraction (v8.0 Phase 2A)
    // Topics are derived from the current extraction's facts and entities only —
    // not from readAllMemories() — so box topics accurately reflect the current
    // session window and the call is free of expensive full-corpus I/O.
    if (resolvePresentationCapabilities(this.config).memoryBoxes && persistedIds.length > 0) {
      const extractionTopics = deriveTopicsFromExtraction(result);
      // Derive episodic metadata from buffer turns (REMem-inspired)
      const firstUserTurn = turns.find((t) => t.role === "user");
      const boxGoal = firstUserTurn?.content?.slice(0, 100)?.trim() || undefined;
      await this.deps
        .boxBuilderFor(storage)
        .onExtraction({
          topics: extractionTopics,
          memoryIds: persistedIds,
          timestamp: new Date().toISOString(),
          goal: boxGoal,
        })
        .catch((err) => log.warn("[boxes] onExtraction failed (non-fatal)", err));
    }

    // Batch-append persisted IDs so non-fact memories (entities/questions) are
    // always attached to the thread. The helper excludes pending_review ids (#1635).
    if (resolvePresentationCapabilities(this.config).threading && threadIdForExtraction && persistedIds.length > 0) {
      await this.deps.appendPersistedThreadEpisodes(threadIdForExtraction, persistedIds);
    }

    // Thread title update for the already-established thread context.
    if (resolvePresentationCapabilities(this.config).threading && threadIdForExtraction) {
      const conversationContent = turns.map((t) => t.content).join(" ");
      try {
        await this.deps.getThreading().updateThreadTitle(threadIdForExtraction, conversationContent);
      } catch (err) {
        log.warn("[threading] updateThreadTitle failed after persistence (non-fatal)", err);
      }
    }

    // Check if consolidation is needed (debounced + non-zero gated).
    const nonZeroExtraction = durableOutputCount > 0;
    try {
      // The increment of nonZeroExtractionsSinceConsolidation moved into
      // the scheduler with the rest of the cadence state (issue #1526 PR1).
      this.deps.maybeScheduleConsolidation(nonZeroExtraction);
    } catch (err) {
      log.warn("runExtraction: consolidation scheduling failed after persistence (non-fatal)", err);
    }

    try {
      this.deps.requestQmdMaintenance();
    } catch (err) {
      log.warn("runExtraction: QMD maintenance scheduling failed after persistence (non-fatal)", err);
    }

    try {
      await this.deps.runTierMigrationCycle(storage, "extraction");
    } catch (err) {
      log.warn("runExtraction: tier migration failed after persistence (non-fatal)", err);
    }

    return {
      status: "completed",
      persistedCount: persistedIds.length,
      durableOutputCount,
      postPersistMetadataFailed,
    };
  }
}
