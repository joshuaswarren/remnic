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
import type { StorageManager } from "../storage.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import type { ExtractionEngine } from "../extraction.js";
import type { SmartBuffer } from "../buffer.js";
import type { ThreadingManager } from "../threading.js";
import type { BoxBuilder } from "../boxes.js";
import {
  resolvePrincipal,
  defaultNamespaceForPrincipal,
} from "../namespaces/principal.js";
import {
  resolveScopeProfilePlan,
  type ResolvedScopeProfilePlan,
} from "../namespaces/scope-profiles.js";
import { resolveCodingNamespaceOverlay } from "../coding/coding-namespace.js";
import type { CodingContext } from "../types.js";
import {
  resolvePresentationCapabilities,
  resolveMemoryLifecycleCapabilities,
  type GraphConstructionCapabilitySet,
  type MemoryLifecycleCapabilitySet,
} from "../capabilities.js";
import { throwIfAborted as sharedThrowIfAborted, abortError as sharedAbortError } from "../abort-error.js";
import { parseFlexibleIsoTimestamp } from "../utils/iso-timestamp.js";
import { log } from "../logger.js";
import type {
  PluginConfig,
  BufferTurn,
  ExtractionResult,
} from "../types.js";
import type { TierMigrationCycleSummary } from "../recall-state.js";

export interface ExtractionRunResult {
  status: "completed" | "skipped";
  reason?: string;
  persistedCount: number;
  durableOutputCount: number;
  postPersistMetadataFailed?: boolean;
}

/** Dependencies injected by the orchestrator. All stable references or
 *  live accessors — lazy getters for anything tests reassign
 *  post-construction (buffer, extraction, storageRouter, threading). */
export interface ExtractionRunCoordinatorDeps {
  config: PluginConfig;
  getBuffer: () => SmartBuffer;
  getExtraction: () => ExtractionEngine;
  getStorageRouter: () => NamespaceStorageRouter;
  getThreading: () => ThreadingManager;

  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
    sourceContext?: { sessionKey?: string; principal?: string; validAt?: string },
    baseNamespace?: string,
    scopeProfileWritePlan?: ResolvedScopeProfilePlan | null,
    sourceText?: string,
    graphCaps?: GraphConstructionCapabilitySet,
    lifecycleCaps?: MemoryLifecycleCapabilitySet,
  ) => Promise<string[]>;

  maybeCapturePassiveCorrections: (
    turns: readonly BufferTurn[],
    opts: {
      sessionKey: string;
      principal?: string;
      namespace: string;
      bufferKey: string;
      isLiveSession: boolean;
    },
  ) => Promise<void>;

  resolveSelfNamespace: (sessionKey?: string) => string;
  getCodingContextForSession: (sessionKey: string) => CodingContext | null;
  applyCodingNamespaceOverlay: (sessionKey: string, namespace: string) => string;
  boxBuilderFor: (storage: StorageManager) => BoxBuilder;
  appendPersistedThreadEpisodes: (
    threadId: string,
    ids: string[],
  ) => Promise<void>;
  maybeScheduleConsolidation: (nonZero: boolean) => void;
  requestQmdMaintenance: () => void;
  runTierMigrationCycle: (
    storage: StorageManager,
    trigger: "extraction" | "maintenance" | "manual",
    options?: {
      dryRun?: boolean;
      limitOverride?: number;
      force?: boolean;
    },
  ) => Promise<TierMigrationCycleSummary>;
  getLastPersistExtractionDeferredCount: () => number;
}

// Recall/extraction-specific abort helpers. Thin wrappers over the shared
// `abort-error.ts` module.
const abortRecallError = sharedAbortError;

function throwIfRecallAborted(
  signal?: AbortSignal,
  message = "recall aborted",
): void {
  sharedThrowIfAborted(signal, message);
}

async function raceRecallAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message = "recall aborted",
): Promise<T> {
  throwIfRecallAborted(signal, message);
  if (!signal) return promise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(abortRecallError(message));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function deriveTopicsFromExtraction(result: ExtractionResult): string[] {
  const topics = new Set<string>();
  for (const fact of result.facts ?? []) {
    for (const tag of fact.tags ?? []) {
      if (tag && tag.length >= 2) topics.add(tag.toLowerCase());
    }
    if (fact.entityRef) topics.add(fact.entityRef.toLowerCase());
    if (fact.category) topics.add(fact.category);
  }
  for (const entity of (result as any).entities ?? []) {
    if (typeof entity.name === "string" && entity.name.length >= 2) {
      topics.add(entity.name.toLowerCase());
    }
  }
  return [...topics].slice(0, 16);
}

/**
 * Coordinates the extraction run pipeline. Holds the dedupe fingerprint
 * cache (`recentExtractionFingerprints`) and delegates all side effects
 * to injected orchestrator methods.
 */
export class ExtractionRunCoordinator {
  private readonly recentExtractionFingerprints = new Map<string, number>();

  constructor(
    private readonly deps: ExtractionRunCoordinatorDeps,
  ) {}

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


  private sourceValidAtMs(turn: BufferTurn): number | null {
    if (typeof turn.sourceValidAt !== "string") return null;
    return parseFlexibleIsoTimestamp(turn.sourceValidAt.trim());
  }


  // -------------------------------------------------------------------------
  // Extraction dedupe fingerprint helpers
  // -------------------------------------------------------------------------

  private normalizeExtractionFingerprintTurns(turns: BufferTurn[]): string[] {
    if (!Array.isArray(turns) || turns.length === 0) return [];
    return turns
      .filter((turn) => turn.role === "user" || turn.role === "assistant")
      .map((turn) => {
        if (
          typeof turn.turnFingerprint === "string" &&
          turn.turnFingerprint.length > 0
        ) {
          return `fp:${turn.turnFingerprint}`;
        }
        return `${turn.role}:${(turn.content ?? "").replace(/\s+/g, " ").trim().slice(0, this.config.extractionMaxTurnChars)}`;
      })
      .filter((value) => value.length > 0);
  }


  private buildExtractionFingerprint(
    turns: BufferTurn[],
    bufferKey: string,
  ): string | null {
    const normalized = this.normalizeExtractionFingerprintTurns(turns).join("\n");
    if (!normalized) return null;
    return createHash("sha256")
      .update(`${bufferKey}\n${normalized}`)
      .digest("hex");
  }



  shouldQueueExtraction(
    turns: BufferTurn[],
    options: { commit?: boolean; bufferKey?: string } = {},
  ): boolean {
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
    if (
      options.commit !== false &&
      this.recentExtractionFingerprints.size > 200
    ) {
      const entries = Array.from(
        this.recentExtractionFingerprints.entries(),
      ).sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, entries.length - 200)) {
        this.recentExtractionFingerprints.delete(key);
      }
    }

    return true;
  }


  // -------------------------------------------------------------------------
  // Processed-fingerprint recording
  // -------------------------------------------------------------------------

  private async recordProcessedExtractionFingerprint(
    storage: StorageManager,
    fingerprint: string,
    preloadedMeta?: Awaited<ReturnType<StorageManager["loadMeta"]>>,
  ): Promise<void> {
    const meta = preloadedMeta ?? (await storage.loadMeta());
    const observedAt = new Date().toISOString();
    const seen = new Map(
      (meta.processedExtractionFingerprints ?? []).map((entry) => [
        entry.fingerprint,
        entry.observedAt,
      ]),
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
  // Main extraction pipeline
  // -------------------------------------------------------------------------

  async runExtraction(
    turns: BufferTurn[],
    options: {
      clearBufferAfterExtraction?: boolean;
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
    } = {},
  ): Promise<ExtractionRunResult> {
    log.debug(`running extraction on ${turns.length} turns`);
    const clearBufferAfterExtraction =
      options.clearBufferAfterExtraction ?? true;
    const skipCharThreshold = options.skipCharThreshold ?? false;
    const skipUserTurnThreshold = options.skipUserTurnThreshold ?? false;
    const deadlineMs =
      typeof options.deadlineMs === "number" &&
      Number.isFinite(options.deadlineMs)
        ? options.deadlineMs
        : undefined;
    const bufferKey = options.bufferKey ?? turns[0]?.sessionKey ?? "default";
    const throwIfDeadlineExceeded = (stage: string): void => {
      if (typeof deadlineMs === "number" && Date.now() > deadlineMs) {
        throw new Error(`replay extraction deadline exceeded (${stage})`);
      }
    };
    const throwIfAborted = (stage: string): void => {
      throwIfRecallAborted(options.abortSignal, `extraction aborted (${stage})`);
    };
    const clearBuffer = async (options?: { ignoreAbort?: boolean }) => {
      if (options?.ignoreAbort !== true) {
        throwIfAborted("before_clear_buffer");
      }
      if (clearBufferAfterExtraction) {
        await this.deps.getBuffer().clearAfterExtraction(bufferKey, turns);
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
      .filter(
        (t) =>
          (t.role === "user" || t.role === "assistant") &&
          typeof t.content === "string",
      )
      .map((t) => ({
        ...t,
        content: t.content.trim().slice(0, this.config.extractionMaxTurnChars),
      }))
      .filter((t) => t.content.length > 0);
    const targetTurns = normalizedTurns.filter(
      (turn) => turn.extractionContextOnly !== true,
    );
    if (targetTurns.length === 0) {
      log.debug("skipping extraction: no non-context turns after normalization");
      // Context-only turns may still contain corrections (review: "context-only
      // turns skip capture"). Scan normalizedTurns before clearing the buffer.
      if (normalizedTurns.length > 0) {
        await this.deps.maybeCapturePassiveCorrections(normalizedTurns as BufferTurn[], { sessionKey, principal: resolvePrincipal(sessionKey, this.config), namespace: this.deps.resolveSelfNamespace(sessionKey), bufferKey, isLiveSession: clearBufferAfterExtraction });
      }
      await clearBuffer();
      return { status: "skipped", reason: "empty_normalized_turns", persistedCount: 0, durableOutputCount: 0 };
    }
    const sourceValidAt = this.latestSourceValidAtFromTurns(targetTurns);
    throwIfDeadlineExceeded("before_extract");
    throwIfAborted("before_extract");

    const userTurns = targetTurns.filter((t) => t.role === "user");
    const totalChars = targetTurns.reduce(
      (sum, t) => sum + t.content.length,
      0,
    );
    const belowCharThreshold = totalChars < this.config.extractionMinChars;
    const belowUserTurnThreshold =
      !skipUserTurnThreshold &&
      userTurns.length < this.config.extractionMinUserTurns;
    if ((!skipCharThreshold && belowCharThreshold) || belowUserTurnThreshold) {
      log.debug(
        `skipping extraction: below threshold (totalChars=${totalChars}, userTurns=${userTurns.length})`,
      );
      await clearBuffer();
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
        const captureWO = typeof options.writeNamespaceOverride === "string" && options.writeNamespaceOverride.length > 0
          ? options.writeNamespaceOverride : undefined;
        const captureCodingCtx = sessionKey ? this.deps.getCodingContextForSession(sessionKey) : null;
        const captureCodingOv = resolveCodingNamespaceOverlay(captureCodingCtx, this.config.codingMode, this.config.defaultNamespace);
        const captureScopePlan = resolveScopeProfilePlan({ config: this.config, principal: capturePrincipal, codingContext: captureCodingCtx, codingOverlay: captureCodingOv });
        const captureNamespace = captureWO ?? captureScopePlan?.writeNamespace ?? this.deps.resolveSelfNamespace(sessionKey);
        await this.deps.maybeCapturePassiveCorrections(normalizedTurns as BufferTurn[], {
          sessionKey, principal: capturePrincipal, namespace: captureNamespace, bufferKey, isLiveSession: clearBufferAfterExtraction,
        });
      }
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
      typeof options.principalOverride === "string" &&
      options.principalOverride.length > 0
        ? options.principalOverride
        : resolvePrincipal(sessionKey, this.config);
    // Write path — explicit callers still win. Otherwise, an active hosted
    // scope profile owns the extraction write target so hook-captured turns land
    // in the same layer that profile recall searches. Without a profile, preserve
    // the existing coding-agent overlay behavior (issue #569).
    const explicitWriteNamespace =
      typeof options.writeNamespaceOverride === "string" &&
      options.writeNamespaceOverride.length > 0
        ? options.writeNamespaceOverride
        : undefined;
    const codingContextForWrite = sessionKey
      ? this.deps.getCodingContextForSession(sessionKey)
      : null;
    const codingOverlayForWrite = resolveCodingNamespaceOverlay(
      codingContextForWrite,
      this.config.codingMode,
      this.config.defaultNamespace,
    );
    const scopeProfileGatePlan = resolveScopeProfilePlan({
      config: this.config,
      principal,
      codingContext: codingContextForWrite,
      codingOverlay: codingOverlayForWrite,
    });
    const scopeProfileWritePlan = explicitWriteNamespace ? null : scopeProfileGatePlan;
    if (scopeProfileWritePlan) {
      const selectedLayer = scopeProfileWritePlan.layers.find(
        (layer) => layer.id === scopeProfileWritePlan.writeLayer,
      );
      const writeNamespaceReadable = scopeProfileWritePlan.readNamespaces.includes(
        scopeProfileWritePlan.writeNamespace,
      );
      if (!selectedLayer?.writable || !writeNamespaceReadable) {
        log.warn(
          `runExtraction: skipping scope profile ${scopeProfileWritePlan.profileId} because write layer ${scopeProfileWritePlan.writeLayer} is not writable inside the profile read stack`,
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
      this.deps.applyCodingNamespaceOverlay(
        sessionKey,
        defaultNamespaceForPrincipal(principal, this.config),
      );
    const storage = await this.deps.getStorageRouter().storageFor(selfNamespace);
    const shouldPersistProcessedFingerprint = targetTurns.some(
      (turn) => turn.persistProcessedFingerprint === true,
    );
    const extractionFingerprint = this.buildExtractionFingerprint(
      targetTurns,
      bufferKey,
    );
    let meta =
      extractionFingerprint && shouldPersistProcessedFingerprint
        ? await storage.loadMeta()
        : null;
    if (
      extractionFingerprint &&
      shouldPersistProcessedFingerprint &&
      (meta?.processedExtractionFingerprints ?? []).some(
        (entry) => entry.fingerprint === extractionFingerprint,
      )
    ) {
      log.debug(
        `runExtraction: skipping already-processed extraction fingerprint for ${bufferKey}`,
      );
      await clearBuffer();
      return {
        status: "skipped",
        reason: "processed_fingerprint",
        persistedCount: 0,
        durableOutputCount: 0,
      };
    }

    // Pass existing entity names so the LLM can reuse them instead of inventing variants
    const existingEntities = await storage.listEntityNames();
    const result = await raceRecallAbort(
      this.deps.getExtraction().extract(
        normalizedTurns,
        existingEntities,
      ),
      options.abortSignal,
      "extraction aborted (during_extract)",
    );
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
      log.warn(
        "runExtraction: extraction returned invalid collection fields",
        {
          invalidFields: invalidExtractionResultFields,
          resultKeys:
            typeof result === "object" && result !== null
              ? Object.keys(result)
              : [],
        },
      );
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
      typeof result.extractionFailure === "string" &&
      result.extractionFailure.trim().length > 0
        ? result.extractionFailure
        : undefined;
    if (options.failOnExtractionFailure && extractionFailure) {
      throw new Error(`extraction failed: ${extractionFailure}`);
    }
    if (
      result.facts.length === 0 &&
      result.entities.length === 0 &&
      result.questions.length === 0 &&
      result.profileUpdates.length === 0
    ) {
      log.debug(
        "runExtraction: extraction produced no durable outputs; skipping persistence",
      );
      if (extractionFailure) {
        log.warn(
          "runExtraction: extraction reported failure with no durable outputs; not marking fingerprint processed",
          { extractionFailure },
        );
      }
      if (
        extractionFingerprint &&
        shouldPersistProcessedFingerprint &&
        !extractionFailure
      ) {
        meta ??= await storage.loadMeta();
        await this.recordProcessedExtractionFingerprint(
          storage,
          extractionFingerprint,
          meta,
        );
        meta.extractionCount += 1;
        meta.lastExtractionAt = new Date().toISOString();
        await storage.saveMeta(meta);
      }
      // Correction-only turns that meet char/user-turn thresholds but yield
      // zero facts still need passive capture (review: "empty extraction skips
      // capture"). selfNamespace/principal already resolved above.
      await this.deps.maybeCapturePassiveCorrections(normalizedTurns as BufferTurn[], { sessionKey, principal, namespace: selfNamespace, bufferKey, isLiveSession: clearBufferAfterExtraction });
      await clearBuffer();
      return { status: "skipped", reason: "empty_extraction_result", persistedCount: 0, durableOutputCount: 0 };
    }

    let threadIdForExtraction: string | null = null;
    if (resolvePresentationCapabilities(this.config).threading && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      try {
        threadIdForExtraction = await this.deps.getThreading().processTurn(lastTurn, []);
      } catch (err) {
        // Fail-open: threading errors must not block memory persistence.
        log.warn(
          "[threading] processTurn failed before persistence (non-fatal)",
          err,
        );
      }
    }

    const persistedIds = await this.deps.persistExtraction(
      result,
      storage,
      threadIdForExtraction,
      { sessionKey, principal, validAt: sourceValidAt },
      // Pass the KNOWN base namespace (NHIdx) so the catalog write touch records the
      // real namespace rather than a guess decoded from the storage dir.
      selfNamespace,
      scopeProfileGatePlan,
      // Verbatim source turns for the faithfulness gate (#1576) so it can
      // locate a quote per fact when #1575 spans are absent.
      normalizedTurns.map((t) => t.content).join("\n\n"),
    );
    let postPersistMetadataFailed = false;
    meta ??= await storage.loadMeta();
    if (extractionFingerprint && shouldPersistProcessedFingerprint) {
      try {
        await this.recordProcessedExtractionFingerprint(
          storage,
          extractionFingerprint,
          meta,
        );
      } catch (error) {
        log.warn(
          "runExtraction: failed to persist processed extraction fingerprint; continuing with buffer clear",
          error,
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
    meta.totalMemories += Array.isArray(result?.facts)
      ? result.facts.length
      : 0;
    meta.totalEntities += Array.isArray(result?.entities)
      ? result.entities.length
      : 0;
    try {
      await storage.saveMeta(meta);
    } catch (error) {
      log.warn(
        "runExtraction: failed to save extraction metadata after durable persistence; continuing with buffer clear",
        error,
      );
      postPersistMetadataFailed = true;
    }

    const durableOutputCount =
      result.facts.length +
      result.entities.length +
      result.questions.length +
      result.profileUpdates.length;

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
      if (
        clearBufferAfterExtraction &&
        !this.config.extractionJudgeShadow
      ) {
        const deferredCount = this.deps.getLastPersistExtractionDeferredCount();
        if (deferredCount > 0 && normalizedTurns.length > 0) {
          await this.deps.getBuffer().retainDeferredTurns(
            bufferKey,
            normalizedTurns as BufferTurn[],
            10,
          );
        } else {
          await this.deps.getBuffer().retainDeferredTurns(bufferKey, [], 0);
        }
      }
    } catch (err) {
      // Fail-open: retention is a nice-to-have. If it fails the judge will
      // still cap deferrals and convert to reject on the next pass.
      log.debug(
        `extraction-judge: defer retention failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await clearBuffer({ ignoreAbort: true });

    // Passive correction capture (issue #1581) — detect corrections expressed
    // passively in the extracted turns and route to the Correction Contract.
    // Runs AFTER persistence + buffer clear so a capture failure never blocks
    // the extraction return. `clearBufferAfterExtraction` gates live-session
    // auto-apply (replay/import → queue-only).
    await this.deps.maybeCapturePassiveCorrections(normalizedTurns as BufferTurn[], {
      sessionKey,
      principal,
      namespace: selfNamespace,
      bufferKey,
      isLiveSession: clearBufferAfterExtraction,
    });

    // Build memory box from this extraction (v8.0 Phase 2A)
    // Topics are derived from the current extraction's facts and entities only —
    // not from readAllMemories() — so box topics accurately reflect the current
    // session window and the call is free of expensive full-corpus I/O.
    if (resolvePresentationCapabilities(this.config).memoryBoxes && persistedIds.length > 0) {
      const extractionTopics = deriveTopicsFromExtraction(result);
      // Derive episodic metadata from buffer turns (REMem-inspired)
      const firstUserTurn = turns.find((t) => t.role === "user");
      const boxGoal =
        firstUserTurn?.content?.slice(0, 100)?.trim() || undefined;
      await this.deps.boxBuilderFor(storage)
        .onExtraction({
          topics: extractionTopics,
          memoryIds: persistedIds,
          timestamp: new Date().toISOString(),
          goal: boxGoal,
        })
        .catch((err) =>
          log.warn("[boxes] onExtraction failed (non-fatal)", err),
        );
    }

    // Batch-append persisted IDs so non-fact memories (entities/questions) are
    // always attached to the thread. The helper excludes pending_review ids (#1635).
    if (
      resolvePresentationCapabilities(this.config).threading &&
      threadIdForExtraction &&
      persistedIds.length > 0
    ) {
      await this.deps.appendPersistedThreadEpisodes(
        threadIdForExtraction,
        persistedIds,
      );
    }

    // Thread title update for the already-established thread context.
    if (resolvePresentationCapabilities(this.config).threading && threadIdForExtraction) {
      const conversationContent = turns.map((t) => t.content).join(" ");
      try {
        await this.deps.getThreading().updateThreadTitle(
          threadIdForExtraction,
          conversationContent,
        );
      } catch (err) {
        log.warn(
          "[threading] updateThreadTitle failed after persistence (non-fatal)",
          err,
        );
      }
    }

    // Check if consolidation is needed (debounced + non-zero gated).
    const nonZeroExtraction = durableOutputCount > 0;
    try {
      // The increment of nonZeroExtractionsSinceConsolidation moved into
      // the scheduler with the rest of the cadence state (issue #1526 PR1).
      this.deps.maybeScheduleConsolidation(nonZeroExtraction);
    } catch (err) {
      log.warn(
        "runExtraction: consolidation scheduling failed after persistence (non-fatal)",
        err,
      );
    }

    try {
      this.deps.requestQmdMaintenance();
    } catch (err) {
      log.warn(
        "runExtraction: QMD maintenance scheduling failed after persistence (non-fatal)",
        err,
      );
    }

    try {
      await this.deps.runTierMigrationCycle(storage, "extraction");
    } catch (err) {
      log.warn(
        "runExtraction: tier migration failed after persistence (non-fatal)",
        err,
      );
    }

    return {
      status: "completed",
      persistedCount: persistedIds.length,
      durableOutputCount,
      postPersistMetadataFailed,
    };
  }
}

