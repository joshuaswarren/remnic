/**
 * Session-context coordinator — extracted from the orchestrator
 * (issue #1526, seam 28).
 *
 * Owns per-session binding surfaces and session-facing service glue:
 *   - peer-id and coding-context bindings (incl. namespace overlay)
 *   - LCM read-namespace resolution for a session
 *   - session flush, passive-correction service construction
 *   - day-summary generation and deep-sleep governance triggers
 *
 * Behavior-preserving move (late-binding selfDeps wiring, seams 18–27).
 */

import { SmartBuffer } from "../buffer.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { combineNamespaces, resolveCodingNamespaceOverlay } from "../coding/coding-namespace.js";
import { createCorrectionService } from "../correction/correction-access-wiring.js";
import type { CorrectionService } from "../correction/correction-service.js";
import { ExtractionEngine } from "../extraction.js";
import { StorageManager } from "../index.js";
import { LocalLlmClient } from "../local-llm.js";
import { log } from "../logger.js";
import { canWriteNamespace, defaultNamespaceForPrincipal, recallNamespacesForPrincipal, resolvePrincipal } from "../namespaces/principal.js";
import type { ExtractionRunResult } from "./extraction-run.js";
import type { EntitySynthesisCoordinator } from "./entity-synthesis-coordinator.js";
import type { BufferTurn, CodingContext, DaySummaryResult, MemoryFile, PluginConfig } from "../types.js";
import {
  Orchestrator,
} from "../orchestrator.js";

export interface SessionContextDeps {
  readonly _codingContextBySession: Map<string, CodingContext>;
  /** Defensive init for Object.create(prototype) fakes — creates the session-binding maps on the orchestrator. */
  ensureSessionBindingMaps(): void;
  _passiveCorrectionService: CorrectionService | null;
  readonly _peerIdBySession: Map<string, string>;
  applyCodingNamespaceOverlay(sessionKey: string | undefined, baseNamespace: string): string;
  readonly buffer: SmartBuffer;
  readonly config: PluginConfig;
  readonly extraction: ExtractionEngine;
  getCodingContextForSession(sessionKey: string | undefined): CodingContext | null;
  readonly initPromise: Promise<void> | null;
  readonly localLlm: LocalLlmClient;
  readonly entitySynthesisCoordinator: EntitySynthesisCoordinator;
  queueBufferedExtraction(
    turnsToExtract: BufferTurn[],
    reason: "trigger_mode" | "heartbeat_observer",
    options?: {
      skipDedupeCheck?: boolean;
      clearBufferAfterExtraction?: boolean;
      skipCharThreshold?: boolean;
      skipUserTurnThreshold?: boolean;
      extractionDeadlineMs?: number;
      failOnExtractionFailure?: boolean;
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
    },
  ): Promise<void>;
  resolvePrincipal(sessionKey?: string): string | undefined;
  readonly storage: StorageManager;
  storageDirNamespace(storageDir: string): string;
  /** The orchestrator itself — passiveCorrectionService constructs the CorrectionService against it. */
  readonly orchestratorSelf: Orchestrator;
}

export class SessionContextCoordinator {
  constructor(
    private readonly deps: SessionContextDeps,
  ) {}

  /**
   * Effective namespace a same-session LCM/structured-history READER must use
   * to find what the access `observe` surface WROTE (#1495 thread 2).
   *
   * This MUST mirror the `observe` scope plan's write-namespace resolution, NOT
   * `resolveSelfNamespace`: when no coding overlay applies, `observe` archives
   * under `config.defaultNamespace` (an unqualified observed turn is NOT moved
   * to the principal self namespace — identical to
   * `resolveCodingScopedWriteNamespace`/`memory_store`, rule 39). Only when a
   * coding overlay actually changes the namespace does the writer (and so the
   * reader) use the overlaid `project-*` namespace. Returning the self base for
   * the no-overlay case would prefix the read key with a namespace the writer
   * never used, so the reader would miss its own evidence.
   *
   * Honours the access-surface `principalOverride` (#1505 thread 2, codex): when
   * a recall supplies an authenticated principal NOT encoded in the raw
   * `sessionKey`, `observe` archived LCM under THAT principal's base namespace.
   * Deriving the base from `resolvePrincipal(sessionKey)` alone could fall back
   * to `default`, so principal `alice` observing `sess-1` would write under
   * `alice` but READ under `default`. Threading the override here keeps the read
   * base identical to the write base.
   *
   * READ-AUTHORIZATION gate (#1505 round 3, codex P2 "Gate LCM recall keys by
   * readable namespaces"): the overlay LCM read key is a `<principal>-project-*`
   * sub-namespace of the principal SELF base. The normal recall namespace set
   * below only substitutes the coding overlay when the principal SELF base is
   * actually in the readable recall set (`recallNamespacesForPrincipal` — gated
   * by `defaultRecallNamespaces.includes("self")` AND `canReadNamespace`). If a
   * principal can WRITE but not READ its self namespace (or `defaultRecall-
   * Namespaces` omits `self`), QMD/file recall never touches those overlay rows,
   * so neither may the LCM read key. When the self base is NOT readable, fall
   * back to the default store — exactly what an unqualified, unauthorized recall
   * resolves to — rather than injecting overlay rows the rest of recall excludes
   * (rule 42 read/write parity; rule 48 least-privilege).
   */
  lcmReadNamespaceForSession(
    sessionKey?: string,
    principalOverride?: string,
  ): string {
    const principal =
      typeof principalOverride === "string" && principalOverride.length > 0
        ? principalOverride
        : this.deps.resolvePrincipal(sessionKey);
    const base = defaultNamespaceForPrincipal(principal, this.deps.config);
    const overlaid = this.deps.applyCodingNamespaceOverlay(sessionKey, base);
    // No overlay → collapse to the default store so the LCM key is the raw
    // sessionKey, exactly what an unqualified observe archived under.
    if (overlaid === base) return this.deps.config.defaultNamespace;
    // Overlay applied. Only honour it when the principal SELF base is in the
    // readable recall set (same gate the recall namespace set uses to
    // substitute the overlay). Otherwise the overlay rows are unauthorized for
    // this reader — fall back to the default store so the LCM read matches
    // what QMD/file recall would surface.
    const selfReadableInRecall = recallNamespacesForPrincipal(
      principal,
      this.deps.config,
    ).includes(base);
    return selfReadableInRecall ? overlaid : this.deps.config.defaultNamespace;
  }

  /**
   * Attach a coding-agent context to a session (issue #569). Called by the
   * Claude Code / Codex / Cursor connectors at session start after
   * `resolveGitContext(cwd)`. The context is consulted by the recall path
   * and the write path so that memories route to a project- (and optionally
   * branch-) scoped namespace.
   *
   * Pass `null` to clear.
   */
  setCodingContextForSession(sessionKey: string, codingContext: CodingContext | null): void {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    // Defensive init — `Object.create(Orchestrator.prototype)` stubs in
    // legacy tests skip class-field initializers. The init runs on the
    // ORCHESTRATOR via deps (PR #1802 review: writing here would create
    // the map on the coordinator while reads keep going through deps).
    this.deps.ensureSessionBindingMaps();
    if (codingContext === null) {
      this.deps._codingContextBySession.delete(sessionKey);
      return;
    }
    this.deps._codingContextBySession.set(sessionKey, codingContext);
  }

  /**
   * Read-only accessor for the coding context attached to a session. Returns
   * `null` when none is set. Used by `remnic doctor` and by tests.
   *
   * Defensive `_codingContextBySession` lookup — legacy orchestrator-flush
   * tests use `Object.create(Orchestrator.prototype)` which does not run
   * class-field initializers, so the Map may be undefined on stubs.
   */
  getCodingContextForSession(sessionKey: string | undefined): CodingContext | null {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return null;
    return this.deps._codingContextBySession?.get(sessionKey) ?? null;
  }

  /**
   * Shared helper used by both the recall path and the write path (rule 42).
   *
   * Given a base namespace computed from the principal, returns the overlaid
   * coding namespace when the session has a coding context AND
   * `codingMode.projectScope` is true AND `namespacesEnabled` is true.
   * Otherwise returns `baseNamespace` unchanged — CLAUDE.md #30 escape hatch.
   *
   * Principal isolation (CLAUDE.md rule 42): the overlay is COMBINED with
   * the principal-derived `baseNamespace` rather than replacing it, so two
   * principals working in the same repository do not share memories through
   * a common `project-*` namespace.
   *
   * Namespaces-disabled gate: when `namespacesEnabled` is false, the
   * storage router maps every namespace to the same `memoryDir`. Returning
   * `project-*` in that mode would create apparent route separation with
   * no actual storage isolation — a false-isolation trap. In that mode we
   * return `baseNamespace` unchanged so coding mode degrades to the existing
   * unscoped behavior.
   *
   * @internal
   */
  applyCodingNamespaceOverlay(sessionKey: string | undefined, baseNamespace: string): string {
    if (!resolveNamespaceCapabilities(this.deps.config).namespaces) return baseNamespace;
    const codingContext = this.deps.getCodingContextForSession(sessionKey);
    const overlay = resolveCodingNamespaceOverlay(codingContext, this.deps.config.codingMode, this.deps.config.defaultNamespace);
    if (!overlay) return baseNamespace;
    return combineNamespaces(baseNamespace, overlay.namespace);
  }

  /**
   * Register a peer ID for a session so recall can inject the peer's
   * profile into context (issue #679 PR 3/5). Pass `null` to clear.
   *
   * Connectors and the `before_agent_start` hook call this when the
   * session's counter-party is known. The ID is validated against
   * `PEER_ID_PATTERN` before storing.
   *
   * Fail-closed (Codex P1 review): an invalid peerId clears any
   * previously registered mapping for the session rather than silently
   * keeping stale data. This prevents a malformed metadata update from
   * mixing one peer's profile context into another session.
   *
   * Defensive init (Cursor review + rule 16): `Object.create(
   * Orchestrator.prototype)` stubs in legacy tests skip class-field
   * initializers, so `_peerIdBySession` may be undefined. Mirror the
   * same guard used by `setCodingContextForSession`.
   */
  setPeerIdForSession(sessionKey: string, peerId: string | null): void {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return;
    // Defensive init — mirrors setCodingContextForSession (rule 16);
    // runs on the orchestrator via deps (PR #1802 review).
    this.deps.ensureSessionBindingMaps();
    if (peerId === null) {
      this.deps._peerIdBySession.delete(sessionKey);
      return;
    }
    // Basic pattern guard — full validation lives in peers/storage.ts.
    // Invalid input is fail-closed: clear the existing mapping so stale
    // peer context can't bleed in after a bad metadata update (Codex P1).
    if (
      typeof peerId !== "string" ||
      peerId.length === 0 ||
      peerId.length > 64 ||
      !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(peerId)
    ) {
      log.warn(`setPeerIdForSession: invalid peerId — clearing session mapping`);
      this.deps._peerIdBySession.delete(sessionKey);
      return;
    }
    this.deps._peerIdBySession.set(sessionKey, peerId);
  }

  /**
   * Return the peer ID registered for a session, or `null` when none
   * is set. Used by `recallInternal` to inject the peer profile section.
   * Defensive `_peerIdBySession` lookup — legacy orchestrator-flush tests
   * use `Object.create(Orchestrator.prototype)` which skips class-field
   * initializers, so the Map may be undefined on stubs.
   */
  getPeerIdForSession(sessionKey: string | undefined): string | null {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) return null;
    return this.deps._peerIdBySession?.get(sessionKey) ?? null;
  }

  async runDeepSleepGovernanceNow(options?: {
    dryRun?: boolean;
    storage?: StorageManager;
  }): Promise<{ scannedMemories: number; appliedActionCount: number; notes?: string }> {
    const targetStorage = options?.storage ?? this.deps.storage;
    const { runMemoryGovernance } = await import("../maintenance/memory-governance.js");
    const { summarizeGovernanceResultForDreams } = await import("../maintenance/dreams-ledger.js");
    const govResult = await runMemoryGovernance({
      memoryDir: targetStorage.dir,
      mode: options?.dryRun === true ? "shadow" : "apply",
    });
    if (options?.dryRun !== true) {
      try {
        await this.deps.entitySynthesisCoordinator.processQueue(
          this.deps.storageDirNamespace(targetStorage.dir),
          5,
        );
      } catch (error) {
        log.debug(`deep-sleep governance: entity synthesis refresh failed after apply: ${error}`);
      }
    }
    return summarizeGovernanceResultForDreams(govResult, options?.dryRun === true);
  }

  async generateDaySummary(
    memories: string | MemoryFile[],
  ): Promise<DaySummaryResult | null> {
    if (this.deps.initPromise) {
      let initGateTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.deps.initPromise.catch(() => undefined),
          new Promise((resolve) => {
            initGateTimeoutHandle = setTimeout(
              resolve,
              this.deps.config.initGateTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (initGateTimeoutHandle) clearTimeout(initGateTimeoutHandle);
      }
    }
    return this.deps.extraction.generateDaySummary(memories);
  }

  async flushSession(
    sessionKey: string,
    options: {
      reason: string;
      abortSignal?: AbortSignal;
      bufferKey?: string;
    },
  ): Promise<void> {
    // Force any pending debounced buffer save to land durably BEFORE we read
    // and (via clearBufferAfterExtraction below) clear turns (issue #1909, PR
    // #2016). In steady-state buffering a `keep_buffering` turn only SCHEDULES a
    // trailing-edge save (see SmartBuffer.scheduleSave), so the newest turns
    // live only in memory behind an unref'd timer. This lifecycle drain
    // (before_reset / session_end / explicit flush) queues extraction with
    // clearBufferAfterExtraction; if that extraction fails or times out and the
    // host then exits, the debounce timer never fires and those turns are lost.
    // Flushing first makes the in-memory turns durable, so a failed or aborted
    // extraction leaves them on disk for re-extraction on next startup.
    // Durability-preserving AND fail-closed: pass throwOnFailure so a failed
    // durable save stops this lifecycle drain BEFORE any extraction runs
    // (issue #1909, PR #2016). flushPendingSave still retains the pending state
    // and re-arms a background retry on write failure, but it now rethrows so
    // flushSession rejects instead of clearing turns behind a non-durable save.
    // Without this, a force-drain could queue extraction with
    // clearBufferAfterExtraction on turns that never reached disk; if extraction
    // then failed and the host exited, the turn was lost.
    if (typeof this.deps.buffer.flushPendingSave === "function") {
      await this.deps.buffer.flushPendingSave({ throwOnFailure: true });
    }
    const explicitBufferKey =
      typeof options.bufferKey === "string" && options.bufferKey.length > 0
        ? options.bufferKey
        : null;
    const discoveredBufferKeys =
      explicitBufferKey ||
      typeof sessionKey !== "string" ||
      sessionKey.length === 0 ||
      typeof this.deps.buffer.findBufferKeysForSession !== "function"
        ? []
        : await this.deps.buffer.findBufferKeysForSession(sessionKey);
    const bufferKeys = explicitBufferKey
      ? [explicitBufferKey]
      : discoveredBufferKeys.length > 0
        ? discoveredBufferKeys
        : typeof sessionKey === "string" && sessionKey.length > 0
          ? [sessionKey]
          : ["default"];
    for (const bufferKey of bufferKeys) {
      const turns = this.deps.buffer.getTurns(bufferKey);
      if (turns.length === 0) continue;
      await new Promise<void>((resolve, reject) => {
        void this.deps.queueBufferedExtraction(turns, "trigger_mode", {
            bufferKey,
            clearBufferAfterExtraction: true,
            skipDedupeCheck: true,
            forceExtractionAttempt: true,
            abortSignal: options.abortSignal,
            onTaskSettled: (error) => (error ? reject(error) : resolve()),
          })
          .catch(reject);
      });
    }
  }

  /** Lazily construct the CorrectionService for passive capture. Stateless
   *  across requests (per #1580 design); cached for the orchestrator's life. */
  passiveCorrectionService(): CorrectionService {
    if (this.deps._passiveCorrectionService) return this.deps._passiveCorrectionService;
    this.deps._passiveCorrectionService = createCorrectionService({
      orchestrator: this.deps.orchestratorSelf,
      // Session-scoped write ACL (review: "passive capture bypasses write
      // ACL"). A correction detected in session S plans only against S readable
      // namespaces and applies only to writable ones (rule 42) — passive
      // capture never becomes a cross-tenant mutation vector. Mirrors the
      // access-service createCorrectionService wiring rather than bypassing it.
      resolveAuthorizedNamespace: async (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.deps.config);
        const ns = req.namespace ?? defaultNamespaceForPrincipal(principal, this.deps.config);
        if (!canWriteNamespace(principal, ns, this.deps.config)) {
          throw new Error(
            `passive correction: namespace "${ns}" is not writable for principal ${principal ?? "(none)"}`,
          );
        }
        return ns;
      },
      resolveReadableNamespaces: (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.deps.config);
        return recallNamespacesForPrincipal(principal, this.deps.config);
      },
      canWriteNamespace: async (req) => {
        const principal = req.principal || resolvePrincipal(req.sessionKey, this.deps.config);
        return canWriteNamespace(principal, req.namespace, this.deps.config);
      },
      llmComplete: async ({ system, user }) => {
        const llmResult = await this.deps.localLlm.chatCompletion(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { operation: "correction-classify", priority: "background" },
        );
        if (!llmResult) {
          throw new Error(
            "passive correction classify+draft: local LLM unavailable (disabled or in cooldown)",
          );
        }
        return llmResult.content;
      },
    });
    return this.deps._passiveCorrectionService;
  }
}
