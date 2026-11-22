
import { createHash } from "node:crypto";
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
import { buildWithBriefingLocation, reapplyCategoryCoercion, splitCanonicalWriteRequest } from "./access-observe-write-category.js";
import { abortError } from "./abort-error.js";
import { withBriefingDeadline } from "./briefing-deadline.js";
import { extractionForceFlush } from "./access-extraction-force-flush.js";
import { forceFlushPreemptCall } from "./access-extraction-force-flush-preempt.js";
import { ObserveTranscriptPersister, observeTranscriptSessionKey } from "./access-observe-transcript.js";
import { createObserveStageTimer } from "./access-observe-stage-timing.js";
import { archiveObservedTurns } from "./access-observe-lcm-archive.js";
import { scopeObserveBufferAdmissionIdempotencyKey } from "./buffer-admission-idempotency.js";
import { recordObserveObjectiveState } from "./access-observe-objective-state.js";
import { FileCalendarSource, buildBriefing, parseBriefingFocus, parseBriefingWindow } from "./briefing.js";
import {
  resolveCompressionCapabilities,
  resolveNamespaceCapabilities,
  resolveObjectiveStateCapabilities,
  resolvePresentationCapabilities,
} from "./capabilities.js";
import { lcmSessionKeyForNamespace } from "./coding/coding-namespace.js";
import {
  type ValidExplicitCapture,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
} from "./explicit-capture.js";
import { log } from "./logger.js";
import { embeddingBacklogExceeds, isSearchHealthDegraded } from "./namespaces/search.js";
import { recordObjectiveStateSnapshotsFromObservedMessages } from "./objective-state-writers.js";
import type { Orchestrator } from "./orchestrator.js";
import { displayErrorDetail } from "./runtime/better-sqlite.js";
import type { MemoryActionOutcome, MemoryActionType } from "./types.js";
import { exportWorkBoardMarkdown, exportWorkBoardSnapshot, importWorkBoardSnapshot } from "./work/board.js";
import { wrapWorkLayerContext } from "./work/boundary.js";
import { WorkStorage } from "./work/storage.js";
import { buildAccessWriteRequestFingerprint } from "./write-envelope.js";
import { type QuarantineOperation, WriteQuarantineStore } from "./write-quarantine.js";
import { PendingObserveExtractionTracker, pendingObserveScopeHint } from "./access-observe-helpers.js";
export interface AccessObserveWriteSurfaceDeps {
  attachCodingContextAfterScopedWrite(
    request: CodingScopedWriteInput & { namespace?: string; sessionKey?: string }
  ): Promise<void>;
  handleIdempotentWrite<T extends { idempotencyReplay?: boolean }>(options: {
    operation: string;
    idempotencyKey?: string;
    requestFingerprint: unknown;
    skip?: boolean;
    beforeExecute?: () => void | Promise<void>;
    execute: () => Promise<T>;
  }): Promise<T>;
  legacyResponseNamespaceForScope(scope: MemoryScopePlan): string;
  maybeAttachCodingContext(
    sessionKey: string | undefined,
    options: { cwd?: string; projectTag?: string; authenticatedPrincipal?: string }
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
  cancelPendingObservePreparations?(sessionKey: string, scopeHint?: string): void;
  cancelPendingObserveExtractions?(
    sessionKey: string,
    principal?: string,
    namespace?: string,
    scopeHint?: string,
    reason?: Error,
  ): void;
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
  private readonly pendingObserveExtractions = new PendingObserveExtractionTracker();
  private readonly observeTranscriptPersister = new ObserveTranscriptPersister();

  public cancelPendingObservePreparations(sessionKey: string, scopeHint?: string): void {
    this.pendingObserveExtractions.cancelPreparations(sessionKey, scopeHint);
  }

  public cancelPendingObserveExtractions(
    sessionKey: string,
    principal?: string,
    namespace?: string,
    scopeHint?: string,
    reason?: Error,
  ): void {
    this.pendingObserveExtractions.cancel(sessionKey, principal, namespace, scopeHint, reason);
  }
  constructor(private readonly deps: AccessObserveWriteSurfaceDeps) {}

  private quarantineStore(): WriteQuarantineStore {
    if (!this.quarantineStoreInstance) {
      this.quarantineStoreInstance = new WriteQuarantineStore(this.deps.orchestrator.config.memoryDir);
    }
    return this.quarantineStoreInstance;
  }

  private async parkRejectedWrite(err: unknown, operation: QuarantineOperation, payload: unknown): Promise<void> {
    if (!(err instanceof NamespaceNotWritableError)) return;
    try {
      await this.quarantineStore().quarantine({
        operation,
        principal: err.principal,
        attemptedNamespace: err.attemptedNamespace,
        payload,
      });
      log.warn(
        `quarantine: parked rejected ${operation} write for principal=${err.principal ?? "-"} attemptedNamespace=${err.attemptedNamespace} (namespace not writable); replay after fixing config`
      );
    } catch (quarantineErr) {
      log.warn(
        `quarantine: failed to park rejected ${operation} write: ${quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr)}`
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
          (
            qmd as unknown as {
              status: () => Promise<{ pendingEmbeddings: number | null; oldestPendingAgeMs: number | null }>;
            }
          ).status(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000).unref?.()),
        ]);
        if (statusReport) {
          pendingEmbeddings = statusReport.pendingEmbeddings;
          oldestPendingAgeMs = statusReport.oldestPendingAgeMs;
        }
      } catch {
        /* status probe failed — non-fatal */
      }
    }
    if (embeddingBacklogExceeds(pendingEmbeddings, threshold)) {
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
      const backlogDegraded = embeddingBacklogExceeds(pending, threshold);
      const mode = !active ? "fallback" : health.daemonMode === true ? "daemon" : "cli";

      return {
        enabled: true,
        active,
        degraded: isSearchHealthDegraded({ ...health, pendingEmbeddings: pending }, threshold),
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

    const token =
      typeof request.since === "string" && request.since.trim().length > 0
        ? request.since.trim()
        : config.briefing.defaultWindow;
    const window = parseBriefingWindow(token);
    if (!window) {
      throw new EngramAccessInputError(`invalid briefing window: ${token}`);
    }

    const rawFocus = typeof request.focus === "string" ? request.focus.trim() : "";
    let focus = null;
    if (rawFocus.length > 0) {
      focus = parseBriefingFocus(rawFocus);
      if (!focus) {
        throw new EngramAccessInputError(`invalid briefing focus filter: ${request.focus}`);
      }
    }

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

    const result = await withBriefingDeadline(async (signal) => {
      const storage = await this.deps.orchestrator.getStorage(namespace);
      return buildWithBriefingLocation(request.includeLocation, storage.dir, window.from.toISOString(), config.location, () => buildBriefing({
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
        followupGenerator: config.openaiApiKey ? undefined : this.deps.orchestrator.briefingChainFollowupGenerator,
        abortSignal: signal,
      }));
    }, request.abortSignal);

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
    rawRequest: EngramAccessMemoryStoreRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    const request = rawRequest;
    const { canonical, categoryCoercion } = splitCanonicalWriteRequest(request);
    let namespace: string;
    try {
      namespace = await this.deps.resolveCodingScopedWriteNamespace(canonical);
    } catch (err) {
      if (request.dryRun !== true && request.suppressQuarantine !== true) {
        await this.parkRejectedWrite(err, "memory_store", request);
      }
      throw err;
    }
    const schemaVersion = canonical.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.deps.validateWriteCandidate(canonical, namespace);
      if (canonical.dryRun === true) {
        return reapplyCategoryCoercion<EngramAccessWriteResponse>({
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "memory_store",
          namespace,
          dryRun: true,
          accepted: true,
          queued: false,
          status: "validated",
          idempotencyKey: canonical.idempotencyKey?.trim() || undefined,
        }, categoryCoercion);
      }
      const result = await persistExplicitCapture(this.deps.orchestrator, candidate, "memory_store");
      await this.deps.attachCodingContextAfterScopedWrite(canonical);
      const blocked = result.tombstoneBlocked === true && result.duplicateOf === undefined;
      const response = reapplyCategoryCoercion<EngramAccessWriteResponse>({
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "memory_store",
        namespace,
        dryRun: false,
        accepted: true,
        queued: blocked,
        status: blocked ? "queued_for_review" : result.duplicateOf ? "duplicate" : "stored",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: canonical.idempotencyKey?.trim() || undefined,
      }, categoryCoercion);
      log.info(
        `access-write op=memory_store namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`
      );
      return response;
    };
    const response = await this.deps.handleIdempotentWrite({
      operation: "memory_store",
      idempotencyKey: canonical.idempotencyKey,
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: canonical.content,
        category: canonical.category,
        confidence: canonical.confidence,
        tags: canonical.tags,
        entityRef: canonical.entityRef,
        ttl: canonical.ttl,
        sourceReason: canonical.sourceReason,
        sourceConnector: canonical.sourceConnector,
      }),
      skip: canonical.dryRun === true,
      beforeExecute: hooks?.enforceWriteQuota,
      execute,
    });
    return reapplyCategoryCoercion(response, categoryCoercion);
  }

  async suggestionSubmit(
    rawRequest: EngramAccessSuggestionSubmitRequest,
    hooks?: { enforceWriteQuota?: () => void | Promise<void> }
  ): Promise<EngramAccessWriteResponse> {
    const request = rawRequest;
    const { canonical, categoryCoercion } = splitCanonicalWriteRequest(request);
    let namespace: string;
    try {
      namespace = await this.deps.resolveCodingScopedWriteNamespace(canonical);
    } catch (err) {
      if (request.dryRun !== true && request.suppressQuarantine !== true) {
        await this.parkRejectedWrite(err, "suggestion_submit", request);
      }
      throw err;
    }
    const schemaVersion = canonical.schemaVersion ?? ENGRAM_ACCESS_WRITE_SCHEMA_VERSION;
    if (schemaVersion !== ENGRAM_ACCESS_WRITE_SCHEMA_VERSION) {
      throw new EngramAccessInputError(`unsupported schemaVersion: ${schemaVersion}`);
    }
    const execute = async (): Promise<EngramAccessWriteResponse> => {
      const candidate = this.deps.validateWriteCandidate(canonical, namespace);
      if (canonical.dryRun === true) {
        return reapplyCategoryCoercion<EngramAccessWriteResponse>({
          schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
          operation: "suggestion_submit",
          namespace,
          dryRun: true,
          accepted: true,
          queued: true,
          status: "validated",
          idempotencyKey: canonical.idempotencyKey?.trim() || undefined,
        }, categoryCoercion);
      }
      const result = await queueExplicitCaptureForReview(
        this.deps.orchestrator,
        candidate,
        "suggestion_submit",
        new Error(canonical.sourceReason?.trim() || "submitted via engram suggestion_submit")
      );
      await this.deps.attachCodingContextAfterScopedWrite(canonical);
      const response = reapplyCategoryCoercion<EngramAccessWriteResponse>({
        schemaVersion: ENGRAM_ACCESS_WRITE_SCHEMA_VERSION,
        operation: "suggestion_submit",
        namespace,
        dryRun: false,
        accepted: true,
        queued: true,
        status: "queued_for_review",
        memoryId: result.id,
        duplicateOf: result.duplicateOf,
        idempotencyKey: canonical.idempotencyKey?.trim() || undefined,
      }, categoryCoercion);
      log.info(
        `access-write op=suggestion_submit namespace=${namespace} dryRun=false status=${response.status} memoryId=${response.memoryId ?? "-"} idempotency=${response.idempotencyKey ? "yes" : "no"}`
      );
      return response;
    };
    const response = await this.deps.handleIdempotentWrite({
      operation: "suggestion_submit",
      idempotencyKey: canonical.idempotencyKey,
      requestFingerprint: buildAccessWriteRequestFingerprint({
        schemaVersion,
        namespace,
        content: canonical.content,
        category: canonical.category,
        confidence: canonical.confidence,
        tags: canonical.tags,
        entityRef: canonical.entityRef,
        ttl: canonical.ttl,
        sourceReason: canonical.sourceReason,
        sourceConnector: canonical.sourceConnector,
      }),
      skip: canonical.dryRun === true,
      beforeExecute: hooks?.enforceWriteQuota,
      execute,
    });
    return reapplyCategoryCoercion(response, categoryCoercion);
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

    const observePreparation = this.pendingObserveExtractions.reserve(
      request.sessionKey,
      pendingObserveScopeHint(request)
    );
    const stageTimer = createObserveStageTimer();
    const timed = stageTimer.timed.bind(stageTimer);
    try {
      let scope: MemoryScopePlan;
      try {
        scope = await timed("scope", () => this.deps.resolveMemoryScopePlan(request));
      } catch (err) {
        if (request.suppressQuarantine !== true) {
          await this.parkRejectedWrite(err, "observe", request);
        }
        throw err;
      }
      const writeNamespace = scope.writeNamespace;
      observePreparation.setScope(scope.principal, writeNamespace);

      const namespace = this.deps.legacyResponseNamespaceForScope(scope);
      const shouldWriteObjectiveState =
        resolveObjectiveStateCapabilities(this.deps.orchestrator.config).objectiveStateMemory === true &&
        resolveObjectiveStateCapabilities(this.deps.orchestrator.config).objectiveStateSnapshotWrites === true;

      await timed("context", () =>
        this.deps.maybeAttachCodingContext(request.sessionKey, {
          cwd: request.cwd,
          projectTag: request.projectTag,
          authenticatedPrincipal: request.authenticatedPrincipal,
        })
      );

      const lcmSessionKey =
        lcmSessionKeyForNamespace(writeNamespace, request.sessionKey, this.deps.orchestrator.config.defaultNamespace) ??
        request.sessionKey;

      if (shouldWriteObjectiveState) {
        await timed("objective", () =>
          recordObserveObjectiveState(
            this.deps.orchestrator,
            this.deps.objectiveStateStoreLocationForNamespace,
            scope,
            request,
          ),
        );
      }

      const lcmArchived = await timed("lcm-accept", () =>
        archiveObservedTurns(this.deps.orchestrator.lcmEngine, lcmSessionKey, request.messages),
      );

      const transcriptPersisted = resolvePresentationCapabilities(this.deps.orchestrator.config).transcript
        ? await timed("transcript", () =>
            this.observeTranscriptPersister.persist(
              this.deps.orchestrator,
              observeTranscriptSessionKey(request.sessionKey, writeNamespace, this.deps.orchestrator.config),
              request.messages,
              request.sessionKey
            )
          )
        : false;

      let extractionQueued = false;
      if (request.skipExtraction !== true) {
        const turns = request.messages.map((m) => ({
          source: "openclaw" as const,
          sessionKey: request.sessionKey,
          role: m.role,
          content: m.content,
          parts: m.parts,
          rawContent: m.rawContent,
          sourceFormat: m.sourceFormat,
          timestamp: new Date().toISOString(),
          ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
        }));
        const writeNamespaceOverride = writeNamespace;
        const principalOverride =
          typeof scope.principal === "string" && scope.principal.length > 0 ? scope.principal : undefined;
        const observeAbortController = new AbortController();
        const preparationCancelled = observePreparation.isCancelled();
        if (preparationCancelled) {
          observeAbortController.abort(abortError("observe preparation cancelled"));
        }
        const trackedExtractionKey = this.pendingObserveExtractions.key(request.sessionKey, scope.principal, writeNamespace);
        const ingestOptions: NonNullable<Parameters<Orchestrator["ingestReplayBatch"]>[1]> = {
          archiveLcm: false,
          extractionMode: "buffered",
          writeNamespaceOverride,
          principalOverride,
          scopeProfileWritePlan: scope.scopeProfilePlan,
          codingContext: this.deps.orchestrator.getCodingContextForSession(request.sessionKey) ?? undefined,
          abortSignal: observeAbortController.signal,
        };
        const clientIdempotencyKey = request.idempotencyKey?.trim();
        if (clientIdempotencyKey) {
          ingestOptions.bufferAdmissionIdempotencyKey = scopeObserveBufferAdmissionIdempotencyKey({
            sessionKey: request.sessionKey,
            writeNamespace,
            principal: principalOverride,
            clientKey: clientIdempotencyKey,
          });
        }
        if (request.authenticatedPrincipal !== undefined && request.authenticatedPrincipal.trim().length > 0) {
          ingestOptions.sessionOwnerPrincipal = request.authenticatedPrincipal.trim();
        }
        if (!preparationCancelled) {
          ingestOptions.onExtractionQueued = (extraction: Promise<void>) => {
            extraction.catch((err) => {
              log.error(`access-observe background extraction failed: ${err}`);
            });
            this.pendingObserveExtractions.track(trackedExtractionKey, extraction, observeAbortController);
            extractionQueued = true;
          };
        }
        await timed("durable-buffer", () => this.deps.orchestrator.ingestReplayBatch(turns, ingestOptions));
        // A native trigger may leave the durable capture pending rather than queued.
      }

      stageTimer.logSlow(request.messages.length);
      log.info(
        `access-observe namespace=${namespace} effectiveNamespace=${writeNamespace} sessionKey=${request.sessionKey} messages=${request.messages.length} lcm=${lcmArchived} extraction=${extractionQueued} transcript=${transcriptPersisted}`
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
        transcriptPersisted,
      };
    } catch (err) {
      stageTimer.logFailed(request.messages.length);
      throw err;
    } finally {
      observePreparation.release();
    }
  }

  async extractionForceFlush(
    request: EngramAccessExtractionForceFlushRequest
  ): Promise<EngramAccessExtractionForceFlushResponse> {
    return forceFlushPreemptCall(this.deps, request, this.pendingObserveExtractions);
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
