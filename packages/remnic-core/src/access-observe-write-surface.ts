/**
 * Access observe/write surface (extracted from access-service.ts;
 * god-file decomposition, #1526 playbook: verbatim move + live selfDeps
 * wiring).
 *
 * Owns the write-side and operational surfaces of the access layer:
 *   - runObserve (turn ingestion incl. idempotency + scope resolution)
 *   - memoryStore / suggestionSubmit / memoryActionApply
 *   - work-layer task/project/board surfaces
 *   - briefing and QMD health (global + per-namespace)
 */

import { createHash } from "node:crypto";
import { throwIfAborted } from "./abort-error.js";
import {
  type CodingScopedWriteInput,
  ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
  type EngramAccessBriefingRequest,
  type EngramAccessBriefingResponse,
  type EngramAccessExtractionForceFlushRequest,
  type EngramAccessExtractionForceFlushResponse,
  EngramAccessInputError,
  type EngramAccessMemoryStoreRequest,
  type EngramAccessObserveRequest,
  type EngramAccessObserveResponse,
  type EngramAccessQmdCollectionState,
  type EngramAccessQmdHealthResponse,
  type EngramAccessSuggestionSubmitRequest,
  type EngramAccessWriteResponse,
  type MemoryScopePlan,
  NamespaceNotWritableError,
} from "./access-service.js";
import { FileCalendarSource, buildBriefing, parseBriefingFocus, parseBriefingWindow } from "./briefing.js";
import {
  resolveCompressionCapabilities,
  resolveNamespaceCapabilities,
  resolveObjectiveStateCapabilities,
} from "./capabilities.js";
import { lcmSessionKeyForNamespace } from "./coding/coding-namespace.js";
import {
  type ValidExplicitCapture,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
} from "./explicit-capture.js";
import { log } from "./logger.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import { recordObjectiveStateSnapshotsFromObservedMessages } from "./objective-state-writers.js";
import type { Orchestrator } from "./orchestrator.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import { displayErrorDetail } from "./runtime/better-sqlite.js";
import type { MemoryActionOutcome, MemoryActionType } from "./types.js";
import { exportWorkBoardMarkdown, exportWorkBoardSnapshot, importWorkBoardSnapshot } from "./work/board.js";
import { wrapWorkLayerContext } from "./work/boundary.js";
import { WorkStorage } from "./work/storage.js";
import { buildAccessWriteRequestFingerprint } from "./write-envelope.js";
import { type QuarantineOperation, WriteQuarantineStore } from "./write-quarantine.js";

export interface AccessObserveWriteSurfaceDeps {
  attachCodingContextAfterScopedWrite(
    request: CodingScopedWriteInput & { namespace?: string; sessionKey?: string }
  ): Promise<void>;
  handleIdempotentWrite<T extends { idempotencyReplay?: boolean }>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
    /**
     * Invoked exactly once, immediately before an ACTUAL (non-replay, non-skip)
     * write is committed — atomically with the idempotency miss determination.
     * The HTTP surface uses this to enforce the write rate limit against the
     * real write/miss (and the real resolved namespace), so a namespace-divergent
     * idempotency peek can never let a fresh write skip the quota check (#1434
     * Codex review). It is NOT called on dryRun (skip) or replay, preserving the
     * replay-bypasses-a-full-window behavior.
     */
    beforeExecute?: () => void | Promise<void>;
    execute: () => Promise<T>;
  }): Promise<T>;
  legacyResponseNamespaceForScope(scope: MemoryScopePlan): string;
  maybeAttachCodingContext(
    sessionKey: string | undefined,
    options: { cwd?: string; projectTag?: string }
  ): Promise<void>;
  namespaceQmdHealth(
    searchBackend: string,
    qmdEnabled: boolean,
    namespace: string,
    fallbackCollection: string
  ): Promise<EngramAccessQmdHealthResponse | null>;
  objectiveStateStoreLocationForNamespace(namespace: string): Promise<{
    memoryDir: string;
    objectiveStateStoreDir?: string;
  }>;
  readonly orchestrator: Orchestrator;
  qmdCollectionState(
    searchBackend: string,
    qmdEnabled: boolean,
    collection: string
  ): Promise<EngramAccessQmdCollectionState>;
  qmdProbeAvailable(searchBackend: string, qmdEnabled: boolean): Promise<boolean>;
  resolveCodingScopedWriteNamespace(
    request: CodingScopedWriteInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    }
  ): Promise<string>;
  resolveMemoryScopePlan(
    request: CodingScopedWriteInput & {
      namespace?: string;
      sessionKey?: string;
      authenticatedPrincipal?: string;
    }
  ): Promise<MemoryScopePlan>;
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  validateWriteCandidate(
    request: EngramAccessMemoryStoreRequest | EngramAccessSuggestionSubmitRequest,
    namespace: string
  ): ValidExplicitCapture;
  writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string
  ): string;
}

export class AccessObserveWriteSurface {
  private quarantineStoreInstance?: WriteQuarantineStore;

  constructor(private readonly deps: AccessObserveWriteSurfaceDeps) {}

  private quarantineStore(): WriteQuarantineStore {
    if (!this.quarantineStoreInstance) {
      this.quarantineStoreInstance = new WriteQuarantineStore(
        this.deps.orchestrator.config.memoryDir,
      );
    }
    return this.quarantineStoreInstance;
  }

  /**
   * Dead-letter a write the namespace ACL just rejected (issue #1888). Only
   * acts on {@link NamespaceNotWritableError}; other input errors pass through
   * untouched. Parking is best-effort — a quarantine failure is logged and
   * swallowed so it never masks or replaces the original loud rejection, which
   * the caller re-throws. The ACL placement is unchanged; the payload simply
   * stops being destroyed.
   */
  private async parkRejectedWrite(
    err: unknown,
    operation: QuarantineOperation,
    payload: unknown,
  ): Promise<void> {
    if (!(err instanceof NamespaceNotWritableError)) return;
    try {
      await this.quarantineStore().quarantine({
        operation,
        principal: err.principal,
        attemptedNamespace: err.attemptedNamespace,
        payload,
      });
      log.warn(
        `quarantine: parked rejected ${operation} write for principal=${err.principal ?? "-"} attemptedNamespace=${err.attemptedNamespace} (namespace not writable); replay after fixing config`,
      );
    } catch (quarantineErr) {
      log.warn(
        `quarantine: failed to park rejected ${operation} write: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`,
      );
    }
  }

  async qmdHealth(
    searchBackend: string,
    qmdEnabled: boolean,
    namespace: string,
    collection: string
  ): Promise<EngramAccessQmdHealthResponse> {
    if (searchBackend !== "qmd" || !qmdEnabled) {
      return {
        enabled: qmdEnabled,
        active: false,
        degraded: false,
        mode: searchBackend !== "qmd" ? "not-selected" : "disabled",
        collection,
        collectionState: "skipped",
        installedVersion: null,
        supportedVersion: null,
        supported: null,
        upgradeAvailable: null,
        doctorAvailable: null,
        debugStatus: searchBackend !== "qmd" ? `backend=${searchBackend}` : "backend=disabled",
        pendingEmbeddings: null,
        oldestPendingAgeMs: null,
        embeddingBacklogThreshold: this.deps.orchestrator.config.qmdEmbeddingBacklogThreshold,
      };
    }

    if (resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces === true) {
      const namespaceHealth = await this.deps.namespaceQmdHealth(searchBackend, qmdEnabled, namespace, collection);
      if (namespaceHealth) return namespaceHealth;
    }

    const qmd = this.deps.orchestrator.qmd;
    if (!qmd) {
      return {
        enabled: true,
        active: false,
        degraded: true,
        mode: "fallback",
        collection,
        collectionState: "unknown",
        installedVersion: null,
        supportedVersion: null,
        supported: null,
        upgradeAvailable: null,
        doctorAvailable: null,
        debugStatus: "backend=unavailable",
        pendingEmbeddings: null,
        oldestPendingAgeMs: null,
        embeddingBacklogThreshold: this.deps.orchestrator.config.qmdEmbeddingBacklogThreshold,
      };
    }
    const diagnosticAvailable = await this.deps.qmdProbeAvailable(searchBackend, qmdEnabled);
    const operationalAvailable = diagnosticAvailable || qmd.isAvailable();
    const collectionState = diagnosticAvailable
      ? await this.deps.qmdCollectionState(searchBackend, qmdEnabled, collection)
      : "unknown";
    const active = operationalAvailable && collectionState !== "missing";
    let degraded =
      searchBackend === "qmd" && qmdEnabled && (!active || !diagnosticAvailable || collectionState === "unknown");
    const debugStatus = qmd.debugStatus();
    const versionStatus =
      "getVersionStatus" in qmd && typeof qmd.getVersionStatus === "function" ? qmd.getVersionStatus() : null;
    const daemonMode =
      "isDaemonMode" in qmd && typeof qmd.isDaemonMode === "function" ? qmd.isDaemonMode() === true : false;
    const mode =
      searchBackend !== "qmd"
        ? "not-selected"
        : !qmdEnabled
          ? "disabled"
          : !active
            ? "fallback"
            : daemonMode
              ? "daemon"
              : "cli";

    const threshold = this.deps.orchestrator.config.qmdEmbeddingBacklogThreshold;
    let pendingEmbeddings: number | null = null;
    let oldestPendingAgeMs: number | null = null;
    let degradedReason: string | undefined;
    if (typeof (qmd as { status?: unknown }).status === "function") {
      try {
        const statusReport = await Promise.race([
          (qmd as unknown as { status: () => Promise<{ pendingEmbeddings: number | null; oldestPendingAgeMs: number | null }> }).status(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000).unref?.()),
        ]);
        if (statusReport) {
          pendingEmbeddings = statusReport.pendingEmbeddings;
          oldestPendingAgeMs = statusReport.oldestPendingAgeMs;
        }
      } catch { /* status probe failed — non-fatal */ }
    }
    if (threshold > 0 && pendingEmbeddings !== null && pendingEmbeddings > threshold) {
      degraded = true;
      degradedReason = `embedding-backlog: ${pendingEmbeddings} pending > threshold ${threshold}`;
    }

    return {
      enabled: qmdEnabled,
      active,
      degraded,
      mode,
      collection,
      collectionState,
      installedVersion: versionStatus?.installedVersion ?? null,
      supportedVersion: versionStatus?.supportedVersion ?? null,
      supported: versionStatus?.supported ?? null,
      upgradeAvailable: versionStatus?.upgradeAvailable ?? null,
      doctorAvailable: versionStatus?.capabilities?.doctor ?? null,
      debugStatus,
      pendingEmbeddings,
      oldestPendingAgeMs,
      embeddingBacklogThreshold: threshold,
      ...(degradedReason ? { degradedReason } : {}),
    };
  }

  async namespaceQmdHealth(
    searchBackend: string,
    qmdEnabled: boolean,
    namespace: string,
    fallbackCollection: string
  ): Promise<EngramAccessQmdHealthResponse | null> {
    if (searchBackend !== "qmd" || !qmdEnabled) return null;
    const searchHealthForNamespace = (
      this.deps.orchestrator as Orchestrator & {
        searchHealthForNamespace?: (
          namespace: string,
          execution?: { signal?: AbortSignal }
        ) => Promise<{
          collection: string;
          available: boolean;
          collectionState: EngramAccessQmdCollectionState;
          debugStatus: string;
          installedVersion: string | null;
          supportedVersion: string | null;
          supported: boolean | null;
          upgradeAvailable: boolean | null;
          doctorAvailable: boolean | null;
          daemonMode: boolean | null;
          pendingEmbeddings?: number | null;
          oldestPendingAgeMs?: number | null;
        }>;
      }
    ).searchHealthForNamespace;
    if (typeof searchHealthForNamespace !== "function") return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    timer.unref?.();
    try {
      const health = await searchHealthForNamespace.call(this.deps.orchestrator, namespace, {
        signal: controller.signal,
      });
      const active = health.available && health.collectionState !== "missing";
      const pending = health.pendingEmbeddings ?? null;
      const oldest = health.oldestPendingAgeMs ?? null;
      const threshold = this.deps.orchestrator.config.qmdEmbeddingBacklogThreshold;
      const backlogDegraded = threshold > 0 && pending !== null && pending > threshold;
      const degraded = !active || health.collectionState === "unknown" || backlogDegraded;
      const mode = !active ? "fallback" : health.daemonMode === true ? "daemon" : "cli";

      return {
        enabled: true,
        active,
        degraded,
        mode,
        collection: health.collection || fallbackCollection,
        collectionState: health.collectionState,
        installedVersion: health.installedVersion,
        supportedVersion: health.supportedVersion,
        supported: health.supported,
        upgradeAvailable: health.upgradeAvailable,
        doctorAvailable: health.doctorAvailable,
        debugStatus: health.debugStatus,
        pendingEmbeddings: pending,
        oldestPendingAgeMs: oldest,
        embeddingBacklogThreshold: threshold,
        ...(backlogDegraded && pending !== null
          ? { degradedReason: `embedding backlog ${pending} exceeds threshold ${threshold}` }
          : {}),
      };
    } catch (error) {
      const detail = displayErrorDetail(error) || "unknown";
      return {
        enabled: true,
        active: false,
        degraded: true,
        mode: "fallback",
        collection: fallbackCollection,
        collectionState: "unknown",
        installedVersion: null,
        supportedVersion: null,
        supported: null,
        upgradeAvailable: null,
        doctorAvailable: null,
        debugStatus: `backend=namespace-unavailable error=${detail}`,
        pendingEmbeddings: null,
        oldestPendingAgeMs: null,
        embeddingBacklogThreshold: this.deps.orchestrator.config.qmdEmbeddingBacklogThreshold,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a daily context briefing. Gracefully degrades when the OpenAI key
   * or Responses API is unavailable — never throws for LLM-related problems.
   */
  async briefing(request: EngramAccessBriefingRequest): Promise<EngramAccessBriefingResponse> {
    const config = this.deps.orchestrator.config;
    if (!config.briefing.enabled) {
      throw new EngramAccessInputError("briefing is disabled");
    }

    const namespace = this.deps.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.deps.orchestrator.getStorage(namespace);

    const token =
      typeof request.since === "string" && request.since.trim().length > 0
        ? request.since.trim()
        : config.briefing.defaultWindow;
    const window = parseBriefingWindow(token);
    if (!window) {
      throw new EngramAccessInputError(`invalid briefing window: ${token}`);
    }

    // Validate focus: only treat undefined / empty strings as "no filter".
    // Anything else that parses to null (e.g. "project:", "topic:") is malformed
    // and must be rejected so a templating miss never silently broadens the
    // briefing from a targeted project view to all memories.
    const rawFocus = typeof request.focus === "string" ? request.focus.trim() : "";
    let focus = null;
    if (rawFocus.length > 0) {
      focus = parseBriefingFocus(rawFocus);
      if (!focus) {
        throw new EngramAccessInputError(`invalid briefing focus filter: ${request.focus}`);
      }
    }

    // Reject unsupported format values explicitly.  Programmatic callers that
    // bypass CLI/MCP pre-validation (which already use validateBriefingFormat)
    // could otherwise send a typo like "jsno" and silently receive a response
    // in the default format, masking the client bug and breaking format-dependent
    // automation.  Only undefined / absent format falls through to the default.
    const SUPPORTED_FORMATS = ["markdown", "json"] as const;
    if (typeof request.format === "string" && !(SUPPORTED_FORMATS as readonly string[]).includes(request.format)) {
      throw new EngramAccessInputError(
        `unsupported briefing format: "${request.format}". Accepted: ${SUPPORTED_FORMATS.join(", ")}.`
      );
    }
    const format: "markdown" | "json" =
      request.format === "json" ? "json" : request.format === "markdown" ? "markdown" : config.briefing.defaultFormat;

    const maxFollowups =
      typeof request.maxFollowups === "number" && Number.isFinite(request.maxFollowups)
        ? Math.max(0, Math.min(10, Math.floor(request.maxFollowups)))
        : config.briefing.maxFollowups;

    const calendarSource = config.briefing.calendarSource
      ? new FileCalendarSource(config.briefing.calendarSource)
      : undefined;

    const result = await buildBriefing({
      storage,
      namespace,
      window,
      focus,
      calendarSource,
      maxFollowups,
      allowLlm: config.briefing.llmFollowups,
      openaiApiKey: config.openaiApiKey,
      openaiBaseUrl: config.openaiBaseUrl,
      model: config.model,
      // Without a direct OpenAI key, route follow-ups through the configured
      // LLM chain (gateway model source or local LLM) — same fallback every
      // other LLM feature uses. A configured key keeps its precedence so
      // existing deployments are unchanged.
      followupGenerator: config.openaiApiKey ? undefined : this.deps.orchestrator.briefingChainFollowupGenerator,
    });

    return {
      format,
      window: result.window,
      namespace,
      markdown: result.markdown,
      json: result.json,
      followupsUnavailableReason: result.followupsUnavailableReason,
    };
  }

  async memoryStore(
    request: EngramAccessMemoryStoreRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    let namespace: string;
    try {
      namespace = await this.deps.resolveCodingScopedWriteNamespace(request);
    } catch (err) {
      // A dry run is a no-persist validation, and a replay re-submit sets
      // suppressQuarantine so a still-unwritable target propagates instead of
      // re-parking (issue #1888): never dead-letter either.
      if (request.dryRun !== true && request.suppressQuarantine !== true) {
        await this.parkRejectedWrite(err, "memory_store", request);
      }
      throw err;
    }
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.deps.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "memory_store",
          namespace,
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await persistExplicitCapture(this.deps.orchestrator, candidate, "memory_store");
      // Seed the session's coding binding ONLY after a real write commits, and
      // only when the namespace came from project scoping (no explicit
      // namespace). This mirrors recall's maybeAttachCodingContext so a LATER
      // bare recall/write on the same session is scoped to the same project —
      // but never binds the session on a dryRun, replay/conflict, quota
      // rejection, or an explicit-namespace write (which bypasses the overlay),
      // since those don't reach this point or aren't project-scoped (Codex review).
      await this.deps.attachCodingContextAfterScopedWrite(request);
      // #1645 (review thread yG-): a tombstone-blocked capture is pending_review
      // (no active copy) — report it as queued_for_review so the HTTP/MCP caller
      // doesn't read it as a successfully stored active memory.
      const blocked = result.tombstoneBlocked === true && result.duplicateOf === undefined;
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "memory_store",
        namespace,
        dryRun: false,
        accepted: true,
        queued: blocked,
        status: blocked ? "queued_for_review" : result.duplicateOf ? "duplicate" : "stored",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=memory_store namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`
      );
      return response;
    };
    return this.deps.handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: request.idempotencyKey,
      // Shared builder (issue #1989 PR3): byte-parity with the historical
      // inline literal is asserted by access-fingerprint-parity.test.ts.
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
        sourceConnector: request.sourceConnector,
      }),
      skip: request.dryRun === true,
      beforeExecute: hooks?.enforceWriteQuota,
      execute,
    });
  }

  async suggestionSubmit(
    request: EngramAccessSuggestionSubmitRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    let namespace: string;
    try {
      namespace = await this.deps.resolveCodingScopedWriteNamespace(request);
    } catch (err) {
      // A dry run never persists, and a replay re-submit sets suppressQuarantine
      // so a still-unwritable target propagates instead of re-parking (#1888).
      if (request.dryRun !== true && request.suppressQuarantine !== true) {
        await this.parkRejectedWrite(err, "suggestion_submit", request);
      }
      throw err;
    }
    const schemaVersion = request.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.deps.validateWriteCandidate(request, namespace);
      if (request.dryRun === true) {
        return {
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "suggestion_submit",
          namespace,
          dryRun: true,
          accepted: true,
          queued: true,
          status: "validated",
          idempotencyKey: request.idempotencyKey?.trim() || undefined,
        };
      }
      const result = await queueExplicitCaptureForReview(
        this.deps.orchestrator,
        candidate,
        "suggestion_submit",
        new Error(request.sourceReason?.trim() || "submitted via engram suggestion_submit")
      );
      // Seed the session binding only after a real, project-scoped submit commits
      // (mirrors memory_store / recall; skips dryRun, replay, quota-reject, and
      // explicit-namespace writes — Codex review).
      await this.deps.attachCodingContextAfterScopedWrite(request);
      const response: EngramAccessWriteResponse = {
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "suggestion_submit",
        namespace,
        dryRun: false,
        accepted: true,
        queued: true,
        status: "queued_for_review",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: request.idempotencyKey?.trim() || undefined,
      };
      log.info(
        `access-write op=suggestion_submit namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`
      );
      return response;
    };
    return this.deps.handleIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: request.idempotencyKey,
      // Shared builder (issue #1989 PR3): byte-parity with the historical
      // inline literal is asserted by access-fingerprint-parity.test.ts.
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: request.content,
        category: request.category,
        confidence: request.confidence,
        tags: request.tags,
        entityRef: request.entityRef,
        ttl: request.ttl,
        sourceReason: request.sourceReason,
        sourceConnector: request.sourceConnector,
      }),
      skip: request.dryRun === true,
      beforeExecute: hooks?.enforceWriteQuota,
      execute,
    });
  }

  async runObserve(request: EngramAccessObserveRequest): Promise<EngramAccessObserveResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new EngramAccessInputError("messages is required and must be a non-empty array");
    }
    for (const msg of request.messages) {
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string" || typeof msg.content !== "string") {
        throw new EngramAccessInputError("each message must have a string 'role' and 'content'");
      }
      if (msg.role !== "user" && msg.role !== "assistant") {
        throw new EngramAccessInputError(`invalid message role: ${msg.role} (expected 'user' or 'assistant')`);
      }
    }

    // 1. Resolve the FULL effective scope plan BEFORE any session mutation
    //    (Codex P2 / Cursor "orphan context after overlay auth"). The plan is
    //    read-only and re-runs the SAME authorization as
    //    memory_store/suggestion_submit (rule 39): the explicit-namespace check
    //    AND the coding-overlay self-base `canWriteNamespace` check both run
    //    here. Because `maybeAttachCodingContext` has NOT run yet, the plan's
    //    overlay resolves from the per-call `cwd`/`projectTag` fallback
    //    (`resolveCodingContextFromOptions`) — identical to the context that
    //    would be attached — so the scope is the same either way. Running the
    //    plan first means an `observe` that ultimately throws on a non-writable
    //    self base leaves NO coding context bound to the session, matching how
    //    `memory_store` resolves its full scoped write namespace before any
    //    session mutation.
    let scope: MemoryScopePlan;
    try {
      scope = await this.deps.resolveMemoryScopePlan(request);
    } catch (err) {
      // A replay re-submit sets suppressQuarantine so a still-unwritable target
      // propagates instead of re-parking (#1888); observe has no dryRun path.
      if (request.suppressQuarantine !== true) {
        await this.parkRejectedWrite(err, "observe", request);
      }
      throw err;
    }
    const writeNamespace = scope.writeNamespace;

    // Backward-compatible BASE writable namespace (pre-#1495 response semantics)
    // for the legacy `namespace` response field. DERIVED from the already-resolved
    // scope plan — NOT a second writable-namespace resolution call
    // call (#1505 thread jvO). The fresh call re-authorized `undefined ⇒
    // config.defaultNamespace` a SECOND time; under a restrictive default-namespace
    // write policy that re-auth could REJECT an otherwise valid project-scoped
    // observe whose effective self/project write target the scope plan already
    // authorized (the same target memory_store/suggestion_submit accept). Worse,
    // that post-plan rejection fired AFTER `resolveMemoryScopePlan` may have seeded
    // the coding context, leaving an orphaned session binding behind. The plan is
    // the single authorization point (rule 22 / 39); the legacy field must reuse it
    // and never re-authorize. Pre-#1495 semantics were exactly
    // the writable-namespace resolver (overlay-agnostic): the explicit
    // namespace when supplied, else `config.defaultNamespace` for user-project
    // coding overlays. Hosted scope-profile layers such as `teamProject` report
    // their effective profile write namespace because there is no legacy
    // overlay-compatible base namespace for those writes.
    const namespace = this.deps.legacyResponseNamespaceForScope(scope);
    const shouldWriteObjectiveState =
      resolveObjectiveStateCapabilities(this.deps.orchestrator.config).objectiveStateMemory === true &&
      resolveObjectiveStateCapabilities(this.deps.orchestrator.config).objectiveStateSnapshotWrites === true;

    // 2. Auto-resolve coding context from cwd/projectTag so a LATER bare recall
    //    on the same session is project-scoped (rule 42: same namespace layer as
    //    recall). Done AFTER the scope plan authorized the write, so a rejected
    //    request never leaves orphaned context on the session.
    await this.deps.maybeAttachCodingContext(request.sessionKey, {
      cwd: request.cwd,
      projectTag: request.projectTag,
    });

    // Prefix sessionKey with the EFFECTIVE write namespace for LCM archival so
    // observed turns are scoped to the same namespace project-scoped recall
    // reads. The SAME `lcmSessionKeyForNamespace` helper is used by the
    // orchestrator recall readers and by compaction flush/record, so the LCM
    // write key and every read/flush key agree (#1495, rule 42). Only prefixes
    // when the namespace diverges from the default store; a single-store
    // deployment keeps the raw sessionKey unchanged.
    const lcmSessionKey =
      lcmSessionKeyForNamespace(writeNamespace, request.sessionKey, this.deps.orchestrator.config.defaultNamespace) ??
      request.sessionKey;

    // 4. Objective-state snapshots → the scope plan's objective-state namespace.
    //    For explicit-namespace and coding-overlay writes this equals
    //    writeNamespace; for an IMPLICIT write it is the principal SELF base
    //    (#928 contract, already auth-checked inside the scope plan), not the
    //    general default-store write namespace.
    if (shouldWriteObjectiveState) {
      try {
        const objectiveStateLocation = await this.deps.objectiveStateStoreLocationForNamespace(
          scope.objectiveStateNamespace
        );
        await recordObjectiveStateSnapshotsFromObservedMessages({
          memoryDir: objectiveStateLocation.memoryDir,
          objectiveStateStoreDir: objectiveStateLocation.objectiveStateStoreDir,
          objectiveStateMemoryEnabled: resolveObjectiveStateCapabilities(this.deps.orchestrator.config)
            .objectiveStateMemory,
          objectiveStateSnapshotWritesEnabled: resolveObjectiveStateCapabilities(this.deps.orchestrator.config)
            .objectiveStateSnapshotWrites,
          sessionKey: request.sessionKey,
          recordedAt: new Date().toISOString(),
          messages: request.messages,
        });
      } catch (err) {
        log.error(`access-observe objective-state snapshot write failed: ${err}`);
      }
    }

    // 5. LCM archival → effective write namespace.
    // lcmArchived in the response means "LCM archival was queued" (not
    // "completed"), matching extractionQueued semantics.  Both run async.
    let lcmArchived = false;
    if (this.deps.orchestrator.lcmEngine && this.deps.orchestrator.lcmEngine.enabled) {
      // Fire-and-forget: LCM archival writes to SQLite and builds summary
      // DAGs, which can take tens of seconds for large sessions.  Don't
      // block the HTTP response — the caller only needs acknowledgment.
      try {
        this.deps.orchestrator.lcmEngine.enqueueObserveMessages(lcmSessionKey, request.messages);
        lcmArchived = true;
      } catch (err) {
        log.error(`access-observe LCM enqueue failed: ${err}`);
      }
    }

    // 6. Extraction/replay → effective write namespace for STORAGE, ORIGINAL
    //    sessionKey for IDENTITY (provenance + threading).
    let extractionQueued = false;
    if (request.skipExtraction !== true) {
      const turns = request.messages.map((m) => ({
        source: "openclaw" as const,
        // Identity-vs-routing separation (#1505 thread 1, cursor): extraction
        // derives the provenance principal via `resolvePrincipal(turn.sessionKey)`
        // and threads `turn.sessionKey` into conversation threading. Feeding the
        // namespace-PREFIXED `lcmSessionKey` here mis-derived the principal to
        // `default` (a `<ns>:<key>` string matches no prefix/map rule and fails
        // the `agent:` heuristic). Pass the ORIGINAL sessionKey so identity is
        // correct; storage routing is pinned separately via
        // writeNamespaceOverride below, and the authenticated principal is pinned
        // via principalOverride.
        sessionKey: request.sessionKey,
        role: m.role,
        content: m.content,
        parts: m.parts,
        rawContent: m.rawContent,
        sourceFormat: m.sourceFormat,
        timestamp: new Date().toISOString(),
        ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
      }));
      // Pin extraction STORAGE to the effective namespace rather than letting the
      // orchestrator re-derive one from the session key + coding overlay — that
      // re-derivation would have to reparse identity and could miss the overlay
      // (the #1495 drift). Passing writeNamespaceOverride makes the extraction
      // target deterministic and identical to LCM/objective-state (rule 39).
      //
      // Pin WHENEVER namespaces are enabled, not only when writeNamespace differs
      // from the default store (#1505 round 3, codex "Pin default-store extraction
      // writes too"). For an unqualified/no-overlay observe by a principal that
      // HAS a self namespace, writeNamespace is `config.defaultNamespace` but an
      // unpinned `runExtraction` would fall back to
      // `defaultNamespaceForPrincipal(principal)` = the SELF namespace — diverging
      // from where LCM/objective-state/response wrote (`default`). Pinning the
      // resolved writeNamespace forces all side effects onto the one scope-plan
      // namespace. When namespaces are DISABLED the router collapses every
      // namespace to one store, so leaving the override undefined preserves the
      // existing single-store routing byte-for-byte.
      const writeNamespaceOverride =
        resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces === true ? writeNamespace : undefined;
      // Pin provenance PRINCIPAL to the scope plan's resolved principal (#1505
      // thread 1). The scope plan already applied auth precedence
      // (authenticatedPrincipal/principalOverride > resolvePrincipal(original
      // sessionKey)), so this is the same identity the surface authorized — never
      // a `default` fallback parsed from a prefixed key. Omitted when no principal
      // resolved (namespaces-disabled / unauthenticated single-store), preserving
      // existing behavior.
      const principalOverride =
        typeof scope.principal === "string" && scope.principal.length > 0 ? scope.principal : undefined;
      // Fire-and-forget: queue extraction in the background so the HTTP
      // response returns immediately. LCM archival (above) is also
      // enqueue-only; extraction involves LLM calls that can take
      // minutes under load and should not block the caller.
      //
      // Backpressure: the orchestrator's own extraction queue already
      // limits concurrency (one extraction at a time per session via
      // queueBufferedExtraction). Fire-and-forget here just decouples
      // the HTTP response from the queue drain.
      try {
        const extractionPromise = this.deps.orchestrator.ingestReplayBatch(turns, {
          archiveLcm: false,
          writeNamespaceOverride,
          principalOverride,
          ...(typeof request.authenticatedPrincipal === "string" && request.authenticatedPrincipal.trim().length > 0
            ? { sessionOwnerPrincipal: request.authenticatedPrincipal.trim() }
            : {}),
        });
        extractionPromise.catch((err) => {
          log.error(`access-observe background extraction failed: ${err}`);
        });
        extractionQueued = true;
      } catch (err) {
        // Synchronous enqueue failure (e.g. orchestrator disposed)
        log.error(`access-observe extraction enqueue failed: ${err}`);
      }
    }

    log.info(
      `access-observe namespace=${namespace} effectiveNamespace=${writeNamespace} sessionKey=${request.sessionKey} messages=${request.messages.length} lcm=${lcmArchived} extraction=${extractionQueued}`
    );

    return {
      accepted: request.messages.length,
      sessionKey: request.sessionKey,
      namespace,
      effectiveNamespace: writeNamespace,
      scopeDebug: {
        principal: scope.principal,
        explicitNamespace: scope.explicitNamespace,
        baseNamespace: scope.baseNamespace,
        writeNamespace: scope.writeNamespace,
        codingOverlayApplied: scope.codingOverlayApplied,
        readNamespaces: scope.readNamespaces,
        scopeProfile: scope.scopeProfile,
        writeLayer: scope.writeLayer,
        layers: scope.layers,
        promotionTargets: scope.promotionTargets,
      },
      lcmArchived,
      extractionQueued,
    };
  }

  async extractionForceFlush(
    request: EngramAccessExtractionForceFlushRequest,
  ): Promise<EngramAccessExtractionForceFlushResponse> {
    if (!request.sessionKey || typeof request.sessionKey !== "string" || request.sessionKey.trim().length === 0) {
      throw new EngramAccessInputError("sessionKey is required and must be a non-empty string");
    }
    if (
      request.deadlineMs !== undefined &&
      (!Number.isFinite(request.deadlineMs) || request.deadlineMs < 0)
    ) {
      throw new EngramAccessInputError("deadlineMs must be a finite non-negative number");
    }
    throwIfAborted(request.abortSignal, "extraction force-flush aborted");
    if (resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces === true) {
      const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
      const sessionPrincipal = resolvePrincipal(request.sessionKey, this.deps.orchestrator.config);
      if (
        !authenticatedPrincipal ||
        (sessionPrincipal !== undefined &&
          sessionPrincipal !== "default" &&
          sessionPrincipal !== authenticatedPrincipal)
      ) {
        throw new EngramAccessInputError("sessionKey is not owned by authenticated principal");
      }
    }

    const previousCodingContext = this.deps.orchestrator.getCodingContextForSession(request.sessionKey);
    let seededCodingContext: unknown = null;
    const captureSeededCodingContext = (): void => {
      if (previousCodingContext !== null || seededCodingContext !== null) return;
      const currentCodingContext = this.deps.orchestrator.getCodingContextForSession(request.sessionKey);
      if (currentCodingContext !== null) seededCodingContext = currentCodingContext;
    };
    const clearSeededCodingContext = (): void => {
      if (previousCodingContext !== null || seededCodingContext === null) return;
      if (this.deps.orchestrator.getCodingContextForSession(request.sessionKey) === seededCodingContext) {
        this.deps.orchestrator.setCodingContextForSession(request.sessionKey, null);
      }
    };

    try {
      const scope = await this.deps.resolveMemoryScopePlan(request);
      captureSeededCodingContext();
      throwIfAborted(request.abortSignal, "extraction force-flush aborted");
      if (typeof request.deadlineMs === "number" && request.deadlineMs <= Date.now()) {
        throw new EngramAccessInputError("extraction force-flush deadline exceeded before buffer drain");
      }

      if (!request.namespace?.trim()) {
        await this.deps.maybeAttachCodingContext(request.sessionKey, {
          cwd: request.cwd,
          projectTag: request.projectTag,
        });
        captureSeededCodingContext();
      }
      throwIfAborted(request.abortSignal, "extraction force-flush aborted");
      if (typeof request.deadlineMs === "number" && request.deadlineMs <= Date.now()) {
        throw new EngramAccessInputError("extraction force-flush deadline exceeded before buffer drain");
      }
      await this.deps.orchestrator.flushSession(request.sessionKey, {
        reason: "access_force_flush",
        abortSignal: request.abortSignal,
        failOnExtractionFailure: true,
        extractionDeadlineMs: request.deadlineMs,
        writeNamespaceOverride:
          resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces === true
            ? scope.writeNamespace
            : undefined,
        principalOverride:
          typeof scope.principal === "string" && scope.principal.length > 0
            ? scope.principal
            : undefined,
      });

      return {
        flushed: true,
        sessionKey: request.sessionKey,
        namespace: this.deps.legacyResponseNamespaceForScope(scope),
        effectiveNamespace: scope.writeNamespace,
      };
    } catch (error) {
      clearSeededCodingContext();
      if (error instanceof ExtractionDeadlineError) {
        throw new EngramAccessInputError(error.message);
      }
      throw error;
    }
  }

  async workTask(request: {
    action: "create" | "get" | "list" | "update" | "transition" | "delete";
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    owner?: string;
    assignee?: string;
    projectId?: string;
    tags?: string[];
    dueAt?: string;
  }): Promise<unknown> {
    const STATUSES = new Set(["todo", "in_progress", "blocked", "done", "cancelled"]);
    const PRIORITIES = new Set(["low", "medium", "high"]);
    const asStatus = (v?: string) =>
      v && STATUSES.has(v) ? (v as "todo" | "in_progress" | "blocked" | "done" | "cancelled") : undefined;
    const asPriority = (v?: string) => (v && PRIORITIES.has(v) ? (v as "low" | "medium" | "high") : undefined);

    const storage = new WorkStorage(this.deps.orchestrator.config.memoryDir);
    await storage.ensureDirectories();
    const action = request.action;

    if (action === "create") {
      if (!request.title?.trim()) throw new EngramAccessInputError("title is required for create");
      const task = await storage.createTask({
        title: request.title,
        description: request.description,
        status: asStatus(request.status),
        priority: asPriority(request.priority),
        owner: request.owner?.trim() || undefined,
        assignee: request.assignee?.trim() || undefined,
        projectId: request.projectId?.trim() || undefined,
        tags: request.tags,
        dueAt: request.dueAt?.trim() || undefined,
      });
      return { action, task };
    }
    if (action === "get") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for get");
      return { action, task: await storage.getTask(request.id) };
    }
    if (action === "list") {
      const tasks = await storage.listTasks({
        status: asStatus(request.status),
        owner: request.owner?.trim() || undefined,
        assignee: request.assignee?.trim() || undefined,
        projectId: request.projectId?.trim() || undefined,
      });
      return { action, count: tasks.length, tasks };
    }
    if (action === "update") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for update");
      const patch: Record<string, unknown> = {};
      if (request.title !== undefined) patch.title = request.title;
      if (request.description !== undefined) patch.description = request.description;
      const st = asStatus(request.status);
      if (st) patch.status = st;
      const pr = asPriority(request.priority);
      if (pr) patch.priority = pr;
      if (request.owner !== undefined) patch.owner = request.owner || null;
      if (request.assignee !== undefined) patch.assignee = request.assignee || null;
      if (request.projectId !== undefined) patch.projectId = request.projectId || null;
      if (request.tags) patch.tags = request.tags;
      if (request.dueAt !== undefined) patch.dueAt = request.dueAt || null;
      return { action, task: await storage.updateTask(request.id, patch as any) };
    }
    if (action === "transition") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for transition");
      const st = asStatus(request.status);
      if (!st) throw new EngramAccessInputError("valid status is required for transition");
      return { action, task: await storage.transitionTask(request.id, st) };
    }
    if (action === "delete") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for delete");
      return { action, deleted: await storage.deleteTask(request.id) };
    }
    throw new EngramAccessInputError(`Unsupported work_task action: ${action}`);
  }

  async workProject(request: {
    action: "create" | "get" | "list" | "update" | "delete" | "link_task";
    id?: string;
    name?: string;
    description?: string;
    status?: string;
    owner?: string;
    tags?: string[];
    taskId?: string;
    projectId?: string;
  }): Promise<unknown> {
    const STATUSES = new Set(["active", "on_hold", "completed", "archived"]);
    const asStatus = (v?: string) =>
      v && STATUSES.has(v) ? (v as "active" | "on_hold" | "completed" | "archived") : undefined;

    const storage = new WorkStorage(this.deps.orchestrator.config.memoryDir);
    await storage.ensureDirectories();
    const action = request.action;

    if (action === "create") {
      if (!request.name?.trim()) throw new EngramAccessInputError("name is required for create");
      const project = await storage.createProject({
        name: request.name,
        description: request.description,
        status: asStatus(request.status),
        owner: request.owner?.trim() || undefined,
        tags: request.tags,
      });
      return { action, project };
    }
    if (action === "get") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for get");
      return { action, project: await storage.getProject(request.id) };
    }
    if (action === "list") {
      const projects = await storage.listProjects();
      return { action, count: projects.length, projects };
    }
    if (action === "update") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for update");
      const patch: Record<string, unknown> = {};
      if (request.name !== undefined) patch.name = request.name;
      if (request.description !== undefined) patch.description = request.description;
      const st = asStatus(request.status);
      if (st) patch.status = st;
      if (request.owner !== undefined) patch.owner = request.owner || null;
      if (request.tags) patch.tags = request.tags;
      return { action, project: await storage.updateProject(request.id, patch as any) };
    }
    if (action === "delete") {
      if (!request.id?.trim()) throw new EngramAccessInputError("id is required for delete");
      return { action, deleted: await storage.deleteProject(request.id) };
    }
    if (action === "link_task") {
      if (!request.taskId?.trim() || !request.projectId?.trim()) {
        throw new EngramAccessInputError("taskId and projectId are required for link_task");
      }
      return { action, linked: await storage.linkTaskToProject(request.taskId, request.projectId) };
    }
    throw new EngramAccessInputError(`Unsupported work_project action: ${action}`);
  }

  async workBoard(request: {
    action: "export_markdown" | "export_snapshot" | "import_snapshot";
    projectId?: string;
    snapshotJson?: string;
    linkToMemory?: boolean;
  }): Promise<unknown> {
    const memoryDir = this.deps.orchestrator.config.memoryDir;
    await new WorkStorage(memoryDir).ensureDirectories();
    const action = request.action;
    const projectId = request.projectId?.trim() || undefined;

    if (action === "export_markdown") {
      const markdown = await exportWorkBoardMarkdown({ memoryDir, projectId });
      return { action, markdown: wrapWorkLayerContext(markdown, { linkToMemory: request.linkToMemory === true }) };
    }
    if (action === "export_snapshot") {
      const snapshot = await exportWorkBoardSnapshot({ memoryDir, projectId });
      return { action, snapshot };
    }
    if (action === "import_snapshot") {
      if (!request.snapshotJson?.trim())
        throw new EngramAccessInputError("snapshotJson is required for import_snapshot");
      const snapshot = JSON.parse(request.snapshotJson);
      const result = await importWorkBoardSnapshot({ memoryDir, snapshot, projectId });
      return { action, result };
    }
    throw new EngramAccessInputError(`Unsupported work_board action: ${action}`);
  }

  async memoryActionApply(request: {
    action: string;
    outcome?: string;
    reason?: string;
    memoryId?: string;
    namespace?: string;
    principal?: string;
    sessionKey?: string;
    content?: string;
    category?: string;
    linkTargetId?: string;
    linkType?: string;
    linkStrength?: number;
    artifactType?: string;
    execute?: boolean;
    sourcePrompt?: string;
    dryRun?: boolean;
  }): Promise<unknown> {
    const actionTypes = new Set<MemoryActionType>([
      "store_episode",
      "store_note",
      "update_note",
      "create_artifact",
      "summarize_node",
      "discard",
      "link_graph",
    ]);
    if (!actionTypes.has(request.action as MemoryActionType)) {
      throw new EngramAccessInputError(`memory_action_apply: invalid action ${JSON.stringify(request.action)}`);
    }

    if (resolveCompressionCapabilities(this.deps.orchestrator.config).contextCompressionActions !== true) {
      throw new EngramAccessInputError(
        "memory_action_apply is disabled; enable contextCompressionActionsEnabled to use this tool"
      );
    }

    const outcome = request.outcome ?? "skipped";
    if (outcome !== "applied" && outcome !== "skipped" && outcome !== "failed") {
      throw new EngramAccessInputError(
        `memory_action_apply: outcome must be "applied", "skipped", or "failed"; got ${JSON.stringify(outcome)}`
      );
    }

    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, request.sessionKey, request.principal);
    const inputSummaryParts = [
      request.content,
      request.category ? `category=${request.category}` : undefined,
      request.linkTargetId ? `linkTargetId=${request.linkTargetId}` : undefined,
      request.linkType ? `linkType=${request.linkType}` : undefined,
      typeof request.linkStrength === "number" ? `linkStrength=${request.linkStrength}` : undefined,
      request.artifactType ? `artifactType=${request.artifactType}` : undefined,
      typeof request.execute === "boolean" ? `execute=${request.execute}` : undefined,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

    const event = {
      action: request.action as MemoryActionType,
      outcome: outcome as MemoryActionOutcome,
      namespace: resolvedNs,
      actor: "access.memory_action_apply",
      subsystem: "access.memory_action_apply",
      reason: request.reason,
      memoryId: request.memoryId,
      sourceSessionKey: request.sessionKey,
      inputSummary: inputSummaryParts.length > 0 ? inputSummaryParts.join(" | ").slice(0, 500) : undefined,
      dryRun: request.dryRun === true,
      promptHash:
        typeof request.sourcePrompt === "string" && request.sourcePrompt.length > 0
          ? createHash("sha256").update(request.sourcePrompt).digest("hex")
          : undefined,
    };
    const preview = this.deps.orchestrator.previewMemoryActionEvent(event);
    if (request.dryRun === true) {
      return { recorded: false, dryRun: true, event: preview };
    }

    const recorded = await this.deps.orchestrator.appendMemoryActionEvent(event);
    return { recorded, event: preview };
  }
}
