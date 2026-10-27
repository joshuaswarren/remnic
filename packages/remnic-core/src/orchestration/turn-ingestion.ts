/**
 * Turn-ingestion coordinator — extracted from the orchestrator
 * (issue #1526, seam 20).
 *
 * Owns the buffer-side entry points that feed the extraction pipeline:
 *   - processTurn (per-turn buffering + trigger-mode flush decisions)
 *   - observeSessionHeartbeat (heartbeat-driven extraction observer)
 *   - queueBufferedExtraction (dedupe-gated extraction queueing)
 *   - ingestReplayBatch / ingestBulkImportBatch (batch ingestion)
 *   - maybeCapturePassiveCorrections (passive correction capture)
 *
 * Behavior-preserving move from orchestrator.ts. The orchestrator keeps
 * thin delegating methods; every member the moved code consults flows
 * back through TurnIngestionDeps live accessors/arrows so prototype-call
 * tests (Orchestrator.prototype.processTurn.call(fake, …)) and instance
 * stubs keep working (same late-binding rule as seams 18/19).
 */

import { createHash, randomBytes } from "node:crypto";
import { abortError } from "../abort-error.js";
import { SmartBuffer } from "../buffer.js";
import type { ImportTurn } from "../bulk-import/types.js";
import { resolveNamespaceCapabilities, resolvePipelineProcessingCapabilities, resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import type { CorrectionService } from "../correction/correction-service.js";
import { type PassiveCaptureConfig, capturePassiveCorrections } from "../correction/passive-capture.js";
import { detectPassiveCorrections } from "../correction/passive-correction-detector.js";
import { shouldSkipImplicitExtraction } from "../explicit-capture.js";
import { StorageManager } from "../index.js";
import { LcmEngine } from "../lcm/index.js";
import { log } from "../logger.js";
import { ExtractionQueueCoordinator } from "./extraction-queue-coordinator.js";
import {
  ExtractionDeadlineError,
  ExtractionRunCoordinator,
  type ExtractionRunResult,
} from "./extraction-run.js";
import { stripHandles } from "../recall-handles.js";
import { type ReplayTurn, normalizeReplaySessionKey } from "../replay/types.js";
import { SessionObserverState } from "../session-observer-state.js";
import { CODEX_THREAD_KEY_PREFIX } from "../thread-key.js";
import { TranscriptManager } from "../transcript.js";
import type { BufferTurn, PluginConfig, SourceConnectorProvenance } from "../types.js";

import { groupTurnsByExtractionScope, bufferTurnsEqual } from "../buffer-turn-helpers.js";
import { resolveScopeProfilePlan, type ResolvedScopeProfilePlan, hasExplicitNamespacePolicy } from "../namespaces/scope-profiles.js";
import { resolveCodingNamespaceOverlay, combineNamespaces } from "../coding/coding-namespace.js";
import { canWriteNamespace, defaultNamespaceForPrincipal } from "../namespaces/principal.js";
import { resolvePrincipal } from "../namespaces/principal.js";
import {
  BulkImportBatchPartialFailureError,
  splitTurnsBySourceValidAt,
  targetSourceValidAtSortMs,
  type BulkImportBatchIngestResult,
} from "../orchestrator.js";

/**
 * #3251: raised by the buffered observe capture path when bounded admission
 * refuses a NEW session entry because the extraction buffer is at its entry
 * cap. The request was never accepted — no durable capture exists and no
 * previously accepted capture was evicted to make room.
 */
export class ReplayAdmissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayAdmissionRefusedError";
  }
}

export interface TurnIngestionDeps {
  readonly buffer: SmartBuffer;
  bulkImportWriteNamespace(): string;
  readonly config: PluginConfig;
  readonly extractionQueueCoordinator: ExtractionQueueCoordinator;
  getStorage(namespace?: string): Promise<StorageManager>;
  readonly heartbeatObserverChains: Map<string, Promise<void>>;
  readonly lcmEngine: LcmEngine | null;
  readonly passiveCorrectionDedup: Set<string>;
  passiveCorrectionService(): CorrectionService;
  readonly passiveCorrectionTelemetry: {
    detected: number;
    queued: number;
    autoApplied: number;
    suppressedReasonCounts: Record<string, number>;
  };
  queueBufferedExtraction(
    turnsToExtract: BufferTurn[],
    reason: "trigger_mode" | "heartbeat_observer",
    options?: {
      skipDedupeCheck?: boolean;
      clearBufferAfterExtraction?: boolean;
      clearMatchingTurns?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      extractionDeadlineMs?: number;
      failOnExtractionFailure?: boolean;
      onDurableCommit?: () => void;
      forceExtractionAttempt?: boolean;
      onTaskSettled?: (
        error?: unknown,
        result?: ExtractionRunResult,
      ) => void;
      bufferKey?: string;
      abortSignal?: AbortSignal;
      /**
       * Explicit namespace override for the write path (#460).  When set,
       * `runExtraction` writes to this namespace instead of deriving one
       * from `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))`.
       * Used by bulk-import to pin writes to a deterministic namespace
       * regardless of user-configured principal routing rules.
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance principal (#1495 thread 1). Forwarded to
       * `runExtraction` so access `observe` can record provenance under the
       * authenticated principal instead of `resolvePrincipal(sessionKey)`.
       */
      scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
      principalOverride?: string;
    },
  ): Promise<void>;
  resolveMemoryIdOrHandle(ref: string, sessionKey?: string): string;
  runExtraction(
    ...args: Parameters<ExtractionRunCoordinator["runExtraction"]>
  ): Promise<ExtractionRunResult>;
  readonly sessionObserver: SessionObserverState;
  shouldQueueExtraction(
    turns: BufferTurn[],
    options?: { commit?: boolean; bufferKey?: string },
  ): boolean;
  readonly transcript: TranscriptManager;
}

/**
 * Options for {@link TurnIngestionCoordinator.processTurn}.
 * Extends {@link SourceConnectorProvenance} to thread trusted connector identity.
 */
export interface TurnIngestionOptions extends SourceConnectorProvenance {
  bufferKey?: string;
  logicalSessionKey?: string;
  providerThreadId?: string | null;
  turnFingerprint?: string;
}

/**
 * Flush-plan recovery imports are compacted material the host already
 * summarized before appending it to the flush-plan file. Feeding those
 * turns through LCM observation again re-summarizes the same content
 * (issue #2457). The producer stamps both a dedicated `sourceLabel` and a
 * `:flush-plan[:chunk]`-shaped `sourceId`, so either marker identifies a
 * recovery turn; ordinary bulk-import turns never carry either.
 */
function isFlushPlanRecoveryTurn(
  turn: Pick<BufferTurn, "importProvenance">,
): boolean {
  const provenance = turn.importProvenance;
  if (provenance?.sourceLabel === "OpenClaw flush plan") return true;
  return (
    typeof provenance?.sourceId === "string" &&
    /:flush-plan(:\d+\/\d+)?$/.test(provenance.sourceId)
  );
}

export class TurnIngestionCoordinator {
  constructor(
    private readonly deps: TurnIngestionDeps,
  ) {}

  async processTurn(
    role: "user" | "assistant",
    content: string,
    sessionKey?: string,
    options: TurnIngestionOptions = {},
  ): Promise<void> {
    if (role !== "user" && role !== "assistant") {
      log.debug(`processTurn: ignoring unsupported role=${String(role)}`);
      return;
    }
    if (shouldSkipImplicitExtraction(this.deps.config)) {
      log.debug(
        "processTurn: skipping implicit extraction because captureMode=explicit",
      );
      return;
    }

    const bufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : typeof sessionKey === "string" && sessionKey.length > 0
          ? sessionKey
          : "default";
    const captureTimestamp = new Date().toISOString();
    // Issue #1582 hygiene §2 — strip any echoed `[m:xxxx]` handle before the
    // turn enters the extraction buffer so handles never become memory content
    // or get QMD-indexed (rule 23). Gated on the feature flag: when handles are
    // off none are ever injected, so there is nothing to strip and the buffer
    // stays byte-identical to the pre-#1582 path.
    const bufferedContent = this.deps.config.recallMemoryHandles
      ? stripHandles(content)
      : content;
    const turn: BufferTurn = {
      role,
      content: bufferedContent,
      timestamp: captureTimestamp,
      // #1578: anchor live-capture turns to wall-clock when bi-temporal is on;
      // replay/import turns carry sourceValidAt explicitly (codex P1).
      ...(this.deps.config.temporalBiTemporal
        ? { sourceValidAt: captureTimestamp }
        : {}),
      sessionKey,
      logicalSessionKey: options.logicalSessionKey ?? bufferKey,
      providerThreadId: options.providerThreadId ?? null,
      turnFingerprint: options.turnFingerprint,
      ...(options.sourceConnector ? { sourceConnector: options.sourceConnector } : {}),
    };

    const outcome =
      typeof this.deps.buffer.addTurnWithOutcome === "function"
        ? await this.deps.buffer.addTurnWithOutcome(bufferKey, turn)
        : { decision: await this.deps.buffer.addTurn(bufferKey, turn) };

    if (outcome.decision === "keep_buffering") return;
    if (!outcome.extractionTurns) return;
    if (outcome.extractionTurns.some((turn) => turn.acceptedCapture === true)) {
      // #3251: native triggers must not run mixed accepted scopes under one
      // policy — each scope group drains through the shared execution
      // boundary with its own pins.
      this.queueBufferedCaptureScopeGroups(outcome.extractionTurns, bufferKey, {});
      return;
    }
    await this.deps.queueBufferedExtraction(
      outcome.extractionTurns,
      "trigger_mode",
      { bufferKey },
    );
  }

  async ingestReplayBatch(
    turns: ReplayTurn[],
    options: {
      deadlineMs?: number;
      archiveLcm?: boolean;
      abortSignal?: AbortSignal;
      /**
       * Pin extraction writes to this namespace instead of deriving one from
       * `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))` + the
       * coding overlay (#1495). The access `observe` surface resolves a single
       * effective scope plan and passes its `writeNamespace` here so the
       * extracted memories land in the SAME namespace as LCM archival,
       * objective-state snapshots, and project-scoped recall — without relying
       * on re-deriving the namespace from a namespace-prefixed session key.
       * Same hook bulk-import uses (#460).
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance PRINCIPAL instead of deriving it from
       * `resolvePrincipal(turn.sessionKey)` (#1495 thread 1). The access
       * `observe` surface authenticates the caller at the transport layer and
       * passes its resolved principal here so extracted-memory provenance uses
       * the SAME identity the surface authorized — independent of storage
       * routing (`writeNamespaceOverride`) and of whatever `resolvePrincipal`
       * would parse from the raw session key. Mirrors the recall path's
       * `principalOverride` (issue #570 PR 4).
       */
      principalOverride?: string;
      /**
       * Forward the observe surface's resolved scope-profile write plan so
       * autoPromote gates see a plan instead of treating "explicit write
       * namespace, no plan" as non-promotable (#3051). Mirrors force-flush.
       */
      scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
      /**
       * Persist the authenticated principal that owns the replay session.
       * Access observe supplies this from the transport auth boundary; replay
       * and import callers leave it unset.
       */
      sessionOwnerPrincipal?: string;
      /**
       * #3251: "immediate" (default) keeps the pre-#3251 forced-queue
       * semantics. "buffered" is the access `observe` capture mode — turns
       * are capacity-admitted, scope-pinned, and made durable before this
       * promise resolves; extraction only queues on the buffer's native
       * trigger, and abort/deadline/restart leave the capture recoverable.
       */
      extractionMode?: "immediate" | "buffered";
      /** #3251: invoked per trigger-queued extraction promise (buffered mode). */
      onExtractionQueued?: (extraction: Promise<void>) => void;
      /**
       * #3251: the ALREADY-resolved native coding context for this capture
       * (buffered mode). Pinned on the durable turns so drains re-resolve
       * current policy for the SAME project binding.
       */
      codingContext?: import("../types.js").CodingContext;
    } = {},
  ): Promise<void> {
    if (!Array.isArray(turns) || turns.length === 0) return;
    if (shouldSkipImplicitExtraction(this.deps.config)) {
      log.debug(
        "ingestReplayBatch: skipping implicit extraction because captureMode=explicit",
      );
      return;
    }

    const bySession = new Map<string, BufferTurn[]>();
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const key = normalizeReplaySessionKey(turn.sessionKey);
      const list = bySession.get(key) ?? [];
      list.push({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sourceValidAt: turn.sourceValidAt,
        sessionKey: key,
        ...(options.sessionOwnerPrincipal ? { sessionOwnerPrincipal: options.sessionOwnerPrincipal } : {}),
        parts: turn.parts,
        rawContent: turn.rawContent,
        sourceFormat: turn.sourceFormat,
        sourceConnector: turn.sourceConnector,
        ...(turn.originRole ? { originRole: turn.originRole } : {}),
      });
      bySession.set(key, list);
    }

    // #3251: the buffered capture ignores pre-aborted signals — cancellation
    // applies to extraction, never to durable admission. The abort pre-check
    // below guards only the immediate (forced-queue) path.
    if (options.extractionMode === "buffered") {
      return this.ingestReplayBatchBuffered(bySession, options);
    }

    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : new Error("ingestReplayBatch aborted");
    }

    const replaySlices: Array<{
      bufferKey: string;
      order: number;
      targetValidAtMs: number;
      turns: BufferTurn[];
    }> = [];
    for (const [key, sessionTurns] of bySession.entries()) {
      if (sessionTurns.length === 0) continue;
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : new Error("ingestReplayBatch aborted");
      }
      if (options.archiveLcm !== false && this.deps.lcmEngine?.enabled) {
        await this.deps.lcmEngine.observeMessages(
          key,
          sessionTurns.map((turn) => ({
            role: turn.role,
            content: turn.content,
            parts: turn.parts,
            rawContent: turn.rawContent,
            sourceFormat: turn.sourceFormat,
          })),
        );
      }
      for (const sessionSlice of splitTurnsBySourceValidAt(sessionTurns)) {
        replaySlices.push({
          bufferKey: key,
          order: replaySlices.length,
          targetValidAtMs: targetSourceValidAtSortMs(sessionSlice),
          turns: sessionSlice,
        });
      }
    }

    const replayTasks = replaySlices
      .sort((a, b) => {
        if (a.targetValidAtMs < b.targetValidAtMs) return -1;
        if (a.targetValidAtMs > b.targetValidAtMs) return 1;
        if (a.order === b.order) return 0;
        return a.order < b.order ? -1 : 1;
      })
      .map(
        ({ bufferKey, turns: sessionSlice }) =>
          new Promise<void>((resolve, reject) => {
            void this.deps.queueBufferedExtraction(sessionSlice, "trigger_mode", {
              skipDedupeCheck: true,
              forceExtractionAttempt: true,
              clearBufferAfterExtraction: false,
              skipCharThreshold: true,
              skipUserTurnThreshold: true,
              bufferKey,
              extractionDeadlineMs: options.deadlineMs,
              abortSignal: options.abortSignal,
              writeNamespaceOverride: options.writeNamespaceOverride,
              principalOverride: options.principalOverride,
              scopeProfileWritePlan: options.scopeProfileWritePlan,
              onTaskSettled: (err) => (err ? reject(err) : resolve()),
            }).catch(reject);
          }),
      );
    if (replayTasks.length > 0) {
      const settled = await Promise.allSettled(replayTasks);
      const firstRejected = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (firstRejected) {
        throw firstRejected.reason;
      }
    }
  }

  /** #3251 buffered capture: durable scope-pinned admission; await settles at durability. */
  private async ingestReplayBatchBuffered(
    bySession: Map<string, BufferTurn[]>,
    options: {
      deadlineMs?: number;
      archiveLcm?: boolean;
      abortSignal?: AbortSignal;
      writeNamespaceOverride?: string;
      principalOverride?: string;
      scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
      codingContext?: import("../types.js").CodingContext;
      onExtractionQueued?: (extraction: Promise<void>) => void;
    },
  ): Promise<void> {
    // #3251: resolve the original actual storage target ONCE at method entry,
    // BEFORE any LCM archival or buffer admission. Explicit override is
    // authoritative; otherwise namespaces OFF → the collapsed default store;
    // namespaces ON → the plan's writeNamespace. Reject before any side
    // effect if neither is available.
    const resolvedWriteTarget =
      options.writeNamespaceOverride ??
      (resolveNamespaceCapabilities(this.deps.config).namespaces === true
        ? options.scopeProfileWritePlan?.writeNamespace
        : this.deps.config.defaultNamespace);
    if (!resolvedWriteTarget) {
      throw new ReplayAdmissionRefusedError(
        "accepted capture requires an explicit storage target (writeNamespaceOverride or scopeProfileWritePlan.writeNamespace)",
      );
    }
    for (const [bufferKey, sessionTurns] of bySession) {
      // No top-level abort check: cancellation applies to the background
      // extraction, never to the durable capture or save barrier (#3251).
      if (options.archiveLcm !== false && this.deps.lcmEngine?.enabled) {
        await this.deps.lcmEngine.observeMessages(
          bufferKey,
          sessionTurns.map((turn) => ({
            role: turn.role,
            content: turn.content,
            parts: turn.parts,
            rawContent: turn.rawContent,
            sourceFormat: turn.sourceFormat,
          })),
        );
      }
      for (const turn of sessionTurns) {
        const pinned: BufferTurn = { ...turn, acceptedCapture: true, writeNamespaceOverride: resolvedWriteTarget };
        if (options.codingContext) pinned.codingContext = options.codingContext;
        if (options.principalOverride) pinned.principalOverride = options.principalOverride;
        if (options.scopeProfileWritePlan) pinned.scopeProfileWritePlan = options.scopeProfileWritePlan;
        const outcome = await this.deps.buffer.addTurnBounded(bufferKey, pinned);
        if (outcome === null) {
          throw new ReplayAdmissionRefusedError(
            `durable observe capture refused: extraction buffer at entry capacity for ${bufferKey}`,
          );
        }
        if (outcome.decision !== "keep_buffering" && outcome.extractionTurns) {
          this.queueBufferedCaptureScopeGroups(outcome.extractionTurns, bufferKey, options);
        }
      }
      // Acceptance durability barrier (#1909 seam): surfaces storage failures
      // BEFORE the caller can report acceptance. Not abort-gated.
      await this.deps.buffer.flushPendingSave({ throwOnFailure: true });
    }
  }

  /**
   * Buffer-approved captures skip threshold/dedupe rechecks, not provider retry cooldowns.
   * Scope and staleness are enforced at the shared queueBufferedExtraction boundary.
   */
  private queueBufferedCaptureScopeGroups(
    extractionTurns: BufferTurn[],
    bufferKey: string,
    options: {
      deadlineMs?: number;
      abortSignal?: AbortSignal;
      writeNamespaceOverride?: string;
      principalOverride?: string;
      scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
      codingContext?: import("../types.js").CodingContext;
      onExtractionQueued?: (extraction: Promise<void>) => void;
    },
  ): void {
    for (const group of groupTurnsByExtractionScope(extractionTurns)) {
      const groupIsAccepted = group.turns.some((turn) => turn.acceptedCapture === true);
      if (!groupIsAccepted) {
        // Native groups keep their own routing; skipped accepted prefixes require identity clearing.
        void this.deps.queueBufferedExtraction(group.turns, "trigger_mode", {
          bufferKey,
          clearMatchingTurns: true,
        }).catch((err) => log.error(`native trigger extraction failed: ${err}`));
        continue;
      }
      // Accepted groups use ONLY their own pins — no fallback to the
      // triggering observe's scope.
      const extraction = new Promise<void>((resolve, reject) => {
        void this.deps.queueBufferedExtraction(group.turns, "trigger_mode", {
          bufferKey,
          clearBufferAfterExtraction: true,
          clearMatchingTurns: true,
          skipDedupeCheck: true,
          skipCharThreshold: true,
          skipUserTurnThreshold: true,
          abortSignal: options.abortSignal,
          extractionDeadlineMs: options.deadlineMs,
          writeNamespaceOverride: group.writeNamespaceOverride,
          principalOverride: group.principalOverride,
          // #3251: accepted groups with no plan pin dispatch null (explicit
          // none) — not undefined which would re-resolve the CURRENT profile.
          scopeProfileWritePlan: group.scopeProfileWritePlan ?? null,
          onTaskSettled: (err) => (err ? reject(err) : resolve()),
        }).catch(reject);
      });
      if (options.onExtractionQueued) options.onExtractionQueued(extraction);
      else extraction.catch((err) => log.error(`buffered capture extraction failed: ${err}`));
    }
  }

  /**
   * Ingest a batch of bulk-import turns (#460). Like ingestReplayBatch, this
   * normalizes user/assistant turns into the extraction buffer and awaits
   * settlement, but it intentionally bypasses the captureMode="explicit"
   * gate because bulk-import is itself an explicit user action — the user
   * ran `bulk-import --source <name> --file ...` and would be surprised to
   * see the command silently no-op when capture is otherwise restricted.
   *
   * Turns with role="other" are skipped (not supported by the extraction
   * pipeline).
   *
   * Two design decisions worth calling out:
   *
   * - **sessionKey is truthy and per-batch-unique.**
   *   `ThreadingManager.shouldStartNewThread` only applies the session-key
   *   boundary check when `turn.sessionKey` is truthy (threading.ts:82);
   *   with an empty string, imported turns could attach to the current
   *   live thread or merge across unrelated import batches. A unique
   *   `bulk-import:batch:<timestamp>-<rand>` key forces a fresh thread per
   *   batch without matching common prefix/map rules in
   *   `principalFromSessionKeyRules`. (Catch-all regex rules could still
   *   remap the principal, but that only affects metadata provenance —
   *   see the next point for why write routing is unaffected.)
   *
   * - **writeNamespaceOverride pins the storage target.**
   *   We pass `writeNamespaceOverride: this.deps.bulkImportWriteNamespace()` to
   *   `queueBufferedExtraction`, which tells `runExtraction` to skip
   *   `defaultNamespaceForPrincipal` and write directly into the
   *   orchestrator's declared bulk-import write namespace. This keeps
   *   writes deterministic even when namespace policies named `"default"`
   *   exist alongside a different `config.defaultNamespace`, and also
   *   guards against regex-catch-all principal rules steering bulk-import
   *   into an unexpected tenant.
   *
   * Per-invocation namespace routing (letting callers target a namespace
   * other than `bulkImportWriteNamespace()`) is a separate feature tracked
   * as a follow-up — the hook is the `writeNamespaceOverride` option, but
   * the CLI surface does not yet expose a `--namespace` flag.
   */
  async ingestBulkImportBatch(
    turns: ImportTurn[],
    options: {
      deadlineMs?: number;
      failOnExtractionFailure?: boolean;
      includeSourceValidAtContext?: boolean;
    } = {},
  ): Promise<BulkImportBatchIngestResult> {
    if (!Array.isArray(turns) || turns.length === 0) {
      return {
        attemptedTurnCount: 0,
        extractionCount: 0,
        persistedCount: 0,
        durableOutputCount: 0,
        skippedCount: 0,
        failedCount: 0,
        postPersistMetadataFailureCount: 0,
        processedTurnCount: 0,
      };
    }

    // Per-batch unique sessionKey keeps threading honest without matching
    // typical prefix/map routing rules.  Combined with writeNamespaceOverride
    // below, the storage target is independent of principal resolution.
    // Uses crypto.randomBytes (not Math.random) so CodeQL does not flag a
    // security-context insecure-randomness use even though this value never
    // leaves the process; the bytes just need to be collision-resistant
    // across concurrent bulk-import batches.
    const shouldUseStableBatchKey = turns.some(
      (turn) =>
        turn.persistProcessedFingerprint === true ||
        (typeof turn.turnFingerprint === "string" &&
          turn.turnFingerprint.length > 0),
    );
    const stableBatchFingerprint = shouldUseStableBatchKey
      ? createHash("sha256")
        .update(
          turns
            .map((turn) =>
              [
                turn.role,
                typeof turn.turnFingerprint === "string" &&
                turn.turnFingerprint.length > 0
                  ? turn.turnFingerprint
                  : turn.content.replace(/\s+/g, " ").trim(),
              ].join(":"),
            )
            .join("\n"),
        )
        .digest("hex")
        .slice(0, 32)
      : undefined;
    const sessionKey = stableBatchFingerprint
      ? `bulk-import:batch:${stableBatchFingerprint}`
      : `bulk-import:batch:${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

    const sessionTurns: BufferTurn[] = [];
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      sessionTurns.push({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sourceValidAt: turn.timestamp,
        sessionKey,
        parts: turn.parts,
        rawContent: turn.rawContent,
        sourceFormat: turn.sourceFormat,
        importProvenance: turn.importProvenance,
        turnFingerprint: turn.turnFingerprint,
        persistProcessedFingerprint: turn.persistProcessedFingerprint === true,
        ...(turn.sourceConnector ? { sourceConnector: turn.sourceConnector } : {}),
        ...(turn.originRole ? { originRole: turn.originRole } : {}),
      });
    }
    if (sessionTurns.length === 0) {
      return {
        attemptedTurnCount: 0,
        extractionCount: 0,
        persistedCount: 0,
        durableOutputCount: 0,
        skippedCount: 0,
        failedCount: 0,
        postPersistMetadataFailureCount: 0,
        processedTurnCount: 0,
      };
    }

    // Skip LCM only when every turn is flush-plan recovery material; a mixed
    // batch keeps the ordinary observe path (issue #2457). Extraction and
    // persistence below are unaffected either way.
    const skipLcmObservation = sessionTurns.every(isFlushPlanRecoveryTurn);
    if (!skipLcmObservation && this.deps.lcmEngine?.enabled) {
      await this.deps.lcmEngine.observeMessages(
        sessionKey,
        sessionTurns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          parts: turn.parts,
          rawContent: turn.rawContent,
          sourceFormat: turn.sourceFormat,
        })),
      );
    }

    const sessionSlices = splitTurnsBySourceValidAt(sessionTurns, {
      includeContext: options.includeSourceValidAtContext !== false,
    });
    const results: ExtractionRunResult[] = [];
    let processedTurnCount = 0;
    let firstRejected: unknown;
    for (const sessionSlice of sessionSlices) {
      try {
        const result = await new Promise<ExtractionRunResult>(
          (resolve, reject) => {
            void this.deps.queueBufferedExtraction(sessionSlice, "trigger_mode", {
              skipDedupeCheck: true,
              forceExtractionAttempt: true,
              clearBufferAfterExtraction: false,
              skipCharThreshold: true,
              skipUserTurnThreshold: true,
              bufferKey: sessionKey,
              extractionDeadlineMs: options.deadlineMs,
              failOnExtractionFailure: options.failOnExtractionFailure === true,
              writeNamespaceOverride: this.deps.bulkImportWriteNamespace(),
              onTaskSettled: (err, result) =>
                err
                  ? reject(err)
                  : resolve(
                      result ?? {
                        status: "skipped",
                        reason: "missing_extraction_result",
                        persistedCount: 0,
                        durableOutputCount: 0,
                      },
                    ),
            }).catch(reject);
          },
        );
        results.push(result);
        processedTurnCount += sessionSlice.filter(
          (turn) => turn.extractionContextOnly !== true,
        ).length;
      } catch (err) {
        firstRejected = err;
        break;
      }
    }
    const rejectedCount = firstRejected ? 1 : 0;
    const ingestResult: BulkImportBatchIngestResult = {
      attemptedTurnCount: sessionTurns.length,
      extractionCount: results.length,
      persistedCount: results.reduce(
        (sum, result) => sum + result.persistedCount,
        0,
      ),
      durableOutputCount: results.reduce(
        (sum, result) => sum + result.durableOutputCount,
        0,
      ),
      skippedCount: results.filter((result) => result.status === "skipped").length,
      failedCount: rejectedCount,
      postPersistMetadataFailureCount: results.filter(
        (result) => result.postPersistMetadataFailed === true,
      ).length,
      processedTurnCount:
        rejectedCount === 0 ? sessionTurns.length : processedTurnCount,
    };
    if (firstRejected) {
      if (processedTurnCount > 0) {
        throw new BulkImportBatchPartialFailureError(
          "bulk import failed after partial processing",
          ingestResult,
          firstRejected,
        );
      }
      throw firstRejected;
    }
    return ingestResult;
  }

  async observeSessionHeartbeat(
    sessionKey: string,
    options: { bufferKey?: string } = {},
  ): Promise<void> {
    if (resolvePipelineProcessingCapabilities(this.deps.config).sessionObserver !== true) return;
    if (!sessionKey || sessionKey.length === 0) return;

    const bufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : sessionKey;
    const previous =
      this.deps.heartbeatObserverChains.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const turns = this.deps.buffer.getTurns(bufferKey);
        if (turns.length === 0) return;
        const normalizedSessionKey = normalizeReplaySessionKey(sessionKey);
        const allowSharedSessionBuffer = bufferKey.startsWith(
          CODEX_THREAD_KEY_PREFIX,
        );
        if (
          !allowSharedSessionBuffer &&
          turns.some(
            (turn) =>
              turn.sessionKey &&
              normalizeReplaySessionKey(turn.sessionKey) !== normalizedSessionKey,
          )
        ) {
          log.debug(
            `heartbeat observer skipped: mixed-session buffer contents for ${bufferKey}`,
          );
          return;
        }
        if (!this.deps.shouldQueueExtraction(turns, {
          commit: false,
          bufferKey,
        })) {
          log.debug(
            `heartbeat observer skipped: extraction dedupe for ${bufferKey}`,
          );
          return;
        }
        const footprint =
          await this.deps.transcript.estimateSessionFootprint(sessionKey);
        const decision = await this.deps.sessionObserver.observe({
          sessionKey,
          totalBytes: footprint.bytes,
          totalTokens: footprint.tokens,
        });
        if (!decision.triggered) return;
        log.debug(
          `heartbeat observer trigger: session=${sessionKey} deltaBytes=${decision.deltaBytes} deltaTokens=${decision.deltaTokens}`,
        );
        if (turns.some((turn) => turn.acceptedCapture === true)) {
          // #3251: heartbeat triggers must not run mixed accepted scopes
          // under one policy — per-scope groups via the shared boundary.
          this.queueBufferedCaptureScopeGroups(turns, bufferKey, {});
          return;
        }
        await this.deps.queueBufferedExtraction(turns, "heartbeat_observer", {
          bufferKey,
        });
      });

    this.deps.heartbeatObserverChains.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.deps.heartbeatObserverChains.get(sessionKey) === next) {
        this.deps.heartbeatObserverChains.delete(sessionKey);
      }
    }
  }

  async queueBufferedExtraction(
    turnsToExtract: BufferTurn[],
    reason: "trigger_mode" | "heartbeat_observer",
    options: {
      skipDedupeCheck?: boolean;
      clearBufferAfterExtraction?: boolean;
      clearMatchingTurns?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      extractionDeadlineMs?: number;
      failOnExtractionFailure?: boolean;
      onDurableCommit?: () => void;
      forceExtractionAttempt?: boolean;
      onTaskSettled?: (
        error?: unknown,
        result?: ExtractionRunResult,
      ) => void;
      bufferKey?: string;
      abortSignal?: AbortSignal;
      /**
       * Explicit namespace override for the write path (#460).  When set,
       * `runExtraction` writes to this namespace instead of deriving one
       * from `defaultNamespaceForPrincipal(resolvePrincipal(sessionKey))`.
       * Used by bulk-import to pin writes to a deterministic namespace
       * regardless of user-configured principal routing rules.
       */
      writeNamespaceOverride?: string;
      /**
       * Pin the provenance principal (#1495 thread 1). Forwarded to
       * `runExtraction` so access `observe` can record provenance under the
       * authenticated principal instead of `resolvePrincipal(sessionKey)`.
       */
      principalOverride?: string;
      scopeProfileWritePlan?: ResolvedScopeProfilePlan | null;
    } = {},
  ): Promise<void> {
    const bufferKey = options.bufferKey ?? turnsToExtract[0]?.sessionKey ?? "default";
    if (
      !options.skipDedupeCheck &&
      !this.deps.shouldQueueExtraction(turnsToExtract, { bufferKey })
    ) {
      log.debug(`extraction dedupe skip: preserving buffer (${reason})`);
      options.onTaskSettled?.(undefined, {
        status: "skipped",
        reason: "dedupe",
        persistedCount: 0,
        durableOutputCount: 0,
      });
      return;
    }

    const extractionDeadlineMs =
      typeof options.extractionDeadlineMs === "number" &&
      Number.isFinite(options.extractionDeadlineMs)
        ? options.extractionDeadlineMs
        : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const clearQueueWaitTimer = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    let abortHandler: (() => void) | undefined;
    const clearAbortListener = (): void => {
      if (abortHandler && options.abortSignal) {
        options.abortSignal.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
    };
    const settleTask = (
      error?: unknown,
      result?: ExtractionRunResult,
    ): boolean => {
      if (settled) return false;
      settled = true;
      clearQueueWaitTimer();
      clearAbortListener();
      options.onTaskSettled?.(error, result);
      return true;
    };
    if (options.abortSignal) {
      const signal = options.abortSignal;
      abortHandler = () => settleTask(signal.reason ?? abortError("extraction aborted (queue_wait)"));
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) {
        settleTask(signal.reason ?? abortError("extraction aborted (queue_wait)"));
        return;
      }
    }

    if (typeof extractionDeadlineMs === "number") {
      const deadline = extractionDeadlineMs;
      const maxTimerDelayMs = 2_147_483_647;
      const scheduleQueueWaitTimeout = (): void => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          settleTask(new ExtractionDeadlineError("queue_wait"));
          return;
        }
        timeout = setTimeout(() => {
          if (Date.now() >= deadline) {
            settleTask(new ExtractionDeadlineError("queue_wait"));
          } else {
            scheduleQueueWaitTimeout();
          }
        }, Math.min(remainingMs, maxTimerDelayMs));
      };
      scheduleQueueWaitTimeout();
    }

    const failClosed = options.failOnExtractionFailure === true;
    const accepted = this.deps.extractionQueueCoordinator.enqueue(async () => {
      const preempt = new AbortController();
      if (!failClosed) this.deps.extractionQueueCoordinator.beginPreemptable(() => preempt.abort());
      const abortSignal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, preempt.signal])
        : preempt.signal;
      try {
      if (settled) return;
      if (
        typeof extractionDeadlineMs === "number" &&
        extractionDeadlineMs <= Date.now()
      ) {
        settleTask(new ExtractionDeadlineError("queue_wait"));
        return;
      }
      clearQueueWaitTimer();
      try {
        // #3251 shared execution boundary for accepted captures (trigger and
        // flush drains both converge here): re-read the live buffer so a
        // concurrent drain that already took these turns skips the LLM work,
        // and re-resolve a pinned plan against CURRENT config — revoke skips
        // WITHOUT clearing, and the plan is never retargeted.
        let effectiveTurns = turnsToExtract;
        let effectiveScopePlan = options.scopeProfileWritePlan;
        if (effectiveTurns.some((turn) => turn.acceptedCapture === true)) {
          const liveTurns = this.deps.buffer
            .getTurns(bufferKey)
            .filter((live) => effectiveTurns.some((snapshotted) => bufferTurnsEqual(live, snapshotted)));
          if (liveTurns.length === 0) {
            settleTask(undefined, {
              status: "skipped",
              reason: "already_drained",
              persistedCount: 0,
              durableOutputCount: 0,
            });
            return;
          }
          effectiveTurns = liveTurns;
          // Pinned-namespace guard (#3251): if namespaces are now DISABLED, a
          // non-default pinned namespace can no longer be honored as a
          // separate store — skip + preserve rather than silently flattening
          // the capture into the default store.
          const namespacesOn = resolveNamespaceCapabilities(this.deps.config).namespaces === true;
          const acceptedTurn = effectiveTurns.find((turn) => turn.acceptedCapture === true);
          const pinnedNamespace = acceptedTurn?.writeNamespaceOverride;
          // #3251: policy-preserving skips reject when the caller demands
          // failure (forceflush) so retained cleanup never deletes preserved
          // captures; background triggers soft-skip and keep the data.
          const policySkipError = (reason: string): Error | undefined =>
            options.failOnExtractionFailure === true
              ? new Error(`accepted capture preserved: ${reason} (${bufferKey})`)
              : undefined;
          if (
            !namespacesOn &&
            pinnedNamespace !== undefined &&
            pinnedNamespace !== this.deps.config.defaultNamespace
          ) {
            const err = policySkipError("pinned_namespace_unavailable");
            if (err) { settleTask(err); return; }
            settleTask(undefined, {
              status: "skipped",
              reason: "pinned_namespace_unavailable",
              persistedCount: 0,
              durableOutputCount: 0,
            });
            return;
          }
          // Current-policy write re-auth for pinned namespaces (#3251): the
          // grant at capture time may have been revoked. Project-derived
          // namespaces honor native base-inheritance (never blanket
          // canWriteNamespace on the combined name); explicit-policy and
          // default pins re-check directly — default may be revoked too.
          const firstSessionKey = effectiveTurns[0]?.sessionKey ?? "";
          const principal =
            options.principalOverride !== undefined && options.principalOverride.length > 0
              ? options.principalOverride
              : resolvePrincipal(firstSessionKey, this.deps.config);
          if (namespacesOn && pinnedNamespace !== undefined && !effectiveScopePlan) {
            const originalContext = acceptedTurn?.codingContext ?? null;
            const overlay = originalContext
              ? resolveCodingNamespaceOverlay(
                  originalContext,
                  this.deps.config.codingMode,
                  this.deps.config.defaultNamespace,
                )
              : null;
            const baseNamespace = defaultNamespaceForPrincipal(principal, this.deps.config);
            const projectNamespace =
              overlay && this.deps.config.codingMode
                ? combineNamespaces(baseNamespace, overlay.namespace)
                : undefined;
            const writeAuthorized =
              projectNamespace === pinnedNamespace
                ? hasExplicitNamespacePolicy(pinnedNamespace, this.deps.config)
                  ? canWriteNamespace(principal, pinnedNamespace, this.deps.config)
                  : canWriteNamespace(principal, baseNamespace, this.deps.config)
                : canWriteNamespace(principal, pinnedNamespace, this.deps.config);
            if (!writeAuthorized) {
              const err = policySkipError("namespace_write_revoked");
              if (err) { settleTask(err); return; }
              settleTask(undefined, {
                status: "skipped",
                reason: "namespace_write_revoked",
                persistedCount: 0,
                durableOutputCount: 0,
              });
              return;
            }
          }
          if (effectiveScopePlan) {
            // #3251: re-resolve with the ORIGINAL coding binding (stored
            // natively on the turn) so project-scoped captures re-authorize
            // against CURRENT policy without losing their project identity.
            const originalContext = acceptedTurn?.codingContext ?? null;
            const codingOverlay = originalContext
              ? resolveCodingNamespaceOverlay(
                  originalContext,
                  this.deps.config.codingMode,
                  this.deps.config.defaultNamespace,
                )
              : null;
            const fresh = resolveScopeProfilePlan({
              config: this.deps.config,
              principal,
              codingContext: originalContext,
              codingOverlay,
            });
            const identityHolds =
              fresh !== null &&
              fresh.profileId === effectiveScopePlan.profileId &&
              fresh.writeLayer === effectiveScopePlan.writeLayer &&
              fresh.writeNamespace === effectiveScopePlan.writeNamespace;
            if (!identityHolds) {
              const err = policySkipError("scope_profile_revoked");
              if (err) { settleTask(err); return; }
              settleTask(undefined, {
                status: "skipped",
                reason: "scope_profile_revoked",
                persistedCount: 0,
                durableOutputCount: 0,
              });
              return;
            }
            effectiveScopePlan = fresh;
          }
        }
        const result = await this.deps.runExtraction(effectiveTurns, {
          clearBufferAfterExtraction:
            options.clearBufferAfterExtraction ?? true,
          clearMatchingTurns: options.clearMatchingTurns === true,
          skipCharThreshold: options.skipCharThreshold ?? false,
          skipUserTurnThreshold: options.skipUserTurnThreshold ?? false,
          deadlineMs: extractionDeadlineMs,
          bufferKey,
          onDurableCommit: options.onDurableCommit,
          abortSignal,
          failOnExtractionFailure: options.failOnExtractionFailure === true,
          writeNamespaceOverride: options.writeNamespaceOverride,
          principalOverride: options.principalOverride,
          scopeProfileWritePlan: effectiveScopePlan,
          forceExtractionAttempt: options.forceExtractionAttempt === true,
        });
        settleTask(undefined, result);
      } catch (err) {
        if (settleTask(err)) {
          throw err;
        }
      }
      } finally {
        if (!failClosed) this.deps.extractionQueueCoordinator.endPreemptable();
      }
    }, { front: failClosed });
    if (!accepted) {
      settleTask(new Error("extraction queue is stopped"));
      return;
    }

    log.debug(`queued extraction from ${reason}`);
  }

  /**
   * Passive correction capture (issue #1581) — detects corrections expressed
   * passively in conversation turns and routes them to the Correction Contract
   * (#1580). Called from `runExtraction` after persistence completes.
   *
   * Thin wiring: delegates ALL correction logic to the detector + capture
   * modules + the CorrectionService. This method only checks gates, calls the
   * detector, and routes results. Fail-open: capture errors never block the
   * extraction return path.
   */
  async maybeCapturePassiveCorrections(
    turns: readonly BufferTurn[],
    opts: {
      sessionKey: string;
      principal?: string;
      namespace: string;
      bufferKey: string;
      isLiveSession: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<void> {
    const mode = this.deps.config.correctionCaptureMode;
    if (mode === "off") return;
    if (!resolveRecallAuxiliaryCapabilities(this.deps.config).correction) return;

    try {
      const corrections = detectPassiveCorrections(
        turns.map((t) => ({ role: t.role, content: t.content })),
      );
      if (corrections.length === 0) return;

      // Replay/import: force queue-only mode even if config says auto.
      const effectiveMode = opts.isLiveSession ? mode : "queue";
      const captureConfig: PassiveCaptureConfig = {
        mode: effectiveMode,
        confidenceFloor: this.deps.config.correctionCaptureConfidenceFloor,
        autoApplyMaxAffected: this.deps.config.correctionCaptureAutoApplyMaxAffected,
      };

      const service = this.deps.passiveCorrectionService();
      const result = await capturePassiveCorrections(
        corrections,
        {
          correctionEnabled: resolveRecallAuxiliaryCapabilities(this.deps.config).correction,
          isLiveSession: opts.isLiveSession,
          bufferKey: opts.bufferKey,
          sessionKey: opts.sessionKey,
          principal: opts.principal,
          namespace: opts.namespace,
          abortSignal: opts.abortSignal,
        },
        captureConfig,
        {
          planCorrection: (req, planOpts) => service.plan(req, planOpts),
          applyCorrection: (planId, applyOpts) => service.apply(planId, applyOpts),
          storageDir: async (ns) => (await this.deps.getStorage(ns)).dir,
          // Resolve `[m:xxxx]` handles to concrete memory ids via the single
          // shared helper (#1582). Returns null on miss/ambiguity so the
          // capture loop drops the handle and the planner falls back to text
          // search (review: "memory handles not resolved").
          resolveHandle: (ref, sessionKey) => {
            try {
              return this.deps.resolveMemoryIdOrHandle(ref, sessionKey);
            } catch {
              return null;
            }
          },
        },
        this.deps.passiveCorrectionDedup,
      );

      // Accumulate telemetry
      this.deps.passiveCorrectionTelemetry.detected += result.telemetry.detected;
      this.deps.passiveCorrectionTelemetry.queued += result.telemetry.queued;
      this.deps.passiveCorrectionTelemetry.autoApplied += result.telemetry.autoApplied;
      for (const [reason, count] of Object.entries(result.telemetry.suppressedReasons)) {
        this.deps.passiveCorrectionTelemetry.suppressedReasonCounts[reason] =
          (this.deps.passiveCorrectionTelemetry.suppressedReasonCounts[reason] ?? 0) + count;
      }
    } catch (err) {
      // Fail-open: passive capture never blocks extraction.
      log.debug(
        `passive-correction: capture failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Named option contract for `TurnIngestionCoordinator.ingestReplayBatch` (#3251). */
export type IngestReplayBatchOptions = Parameters<TurnIngestionCoordinator["ingestReplayBatch"]>[1];
