
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { AccessAuditAdapter, type AccessAuditResult } from "./access-audit.js";
import { throwIfAborted } from "./abort-error.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import { type BudgetDecision, type BudgetReservation, CrossNamespaceBudget, toBudgetWarning } from "./cross-namespace-budget.js";
import { lcmEvidenceIdentity } from "./lcm/evidence-identity.js";
import { normalizeProjectionTags } from "./memory-projection-format.js";
import { namespaceIdentityFromToken } from "./namespaces/identity.js";
import { canReadNamespace, defaultNamespaceForPrincipal, resolvePrincipal } from "./namespaces/principal.js";
import { resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { resolveScopePlan } from "./scopes/scope-plan.js";
import type { Orchestrator, RecallInvocationOptions } from "./orchestrator.js";
import { createRecallCorpusVersionCapture, mergeRecallCorpusVersions } from "./access-recall-corpus-versions.js";
import { decideDisclosureEscalation } from "./recall-disclosure-escalation.js";
import { assembleRecallResponse } from "./access-recall-response.js";
import { coerceIncludedMemories, type LastRecallSnapshot } from "./recall-state.js";
import type { RecallContextComposition } from "./recall-context-composition.js";
import { type TagMatchMode, applyTagFilter, normalizeTags, parseTagMatch } from "./recall-tag-filter.js";
import { type RecallXraySnapshot, estimateRecallTokens } from "./recall-xray.js";
import { lastRecallTimingsFor } from "./recall-timings.js";
import { SecureStoreLockedError } from "./secure-store/index.js";
import { StorageManager } from "./index.js";
import { DEFAULT_RECALL_DISCLOSURE, type MemoryFile, type RecallDisclosure, type RecallPlanMode, isRecallDisclosure } from "./types.js";
import { attributeRawExcerpts } from "./access-recall-excerpt-attribution.js";
import {
  EngramAccessInputError,
  shapeMemorySummary,
  type EngramAccessMemorySummary,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
  type EngramAccessSetCodingContextRequest,
} from "./access-service.js";
import { qmdCollectionPathParts, qmdResultPathCandidates } from "./orchestration/qmd-result-resolver.js";
export interface AccessRecallSurfaceDeps {
  readonly auditAdapter: AccessAuditAdapter | null;
  readonly budget: CrossNamespaceBudget;
  buildRecallDebug(
    snapshot: LastRecallSnapshot | null,
    namespace: string,
    includeDebug: boolean,
    sessionKey?: string,
  ): Promise<EngramAccessRecallResponse["debug"] | undefined>;
  buildRecallResponseFromXraySnapshot(options: {
    query: string;
    sessionKey?: string;
    snapshot: RecallXraySnapshot;
    storageCorpusVersionsAtRecallStart: Array<{ namespace: string; version: number | null }>;
    disclosure: RecallDisclosure;
    startedAt: number;
    requestedMode?: RecallPlanMode | "auto";
    normalizedMode?: RecallPlanMode;
    rawExcerptNamespace?: string;
    /**
     * Ordered, read-authorized LCM read session_id SET (#1505 fallback
     * unification). Threaded through to `serializeRecallResults` so the x-ray raw
     * disclosure path also finds excerpts archived at the coding read fallbacks.
     */
    rawExcerptSessionIds?: string[];
    /**
     * Force NO raw excerpts (#1505 thread NBHWz). Set when the IMPLICIT
     * raw-excerpt read gate found NO readable LCM namespace, so the x-ray
     * includeRecall path degrades to empty excerpts rather than falling back to
     * the write/overlay namespace the read gate excludes.
     */
    rawExcerptsSuppressed?: boolean;
  }): Promise<EngramAccessRecallResponse>;
  fetchRawExcerpts(
    disclosure: RecallDisclosure,
    context: {
      query: string;
      sessionKey?: string;
      namespace?: string;
      /**
       * Pre-resolved, ordered, read-authorized LCM read session_id SET (#1505
       * fallback unification). When supplied, raw disclosure queries each key in
       * order (primary coding overlay → read fallbacks) and merges rows, exactly
       * as the orchestrator recall path and `lcmSearch` do, so a branch-scoped
       * session finds excerpts archived at project/root scope. Already
       * read-gated by `resolveLcmReadSessionIds`, so an unauthorized
       * `<principal>-project-*` key is never present. Falls back to the legacy
       * single `namespace`-prefixed key when absent (sessionless / legacy
       * callers).
       */
      lcmSessionIds?: string[];
    } | null,
  ): Promise<EngramAccessMemorySummary["rawExcerpts"] | null>;
  maybeAttachCodingContext(
    sessionKey: string | undefined,
    options: { cwd?: string; projectTag?: string; authenticatedPrincipal?: string },
  ): Promise<void>;
  normalizeRecallMode(mode?: RecallPlanMode | "auto"): RecallPlanMode | undefined;
  readonly orchestrator: Orchestrator;
  resolveLcmReadSessionIds(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined,
  ): string[];
  resolveNamespace(namespace?: string): string;
  resolveRawExcerptReadNamespace(
    explicitNamespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal: string | undefined,
  ): string | undefined;
  resolveRecallNamespace(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string | undefined;
  resolveRequestPrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string | undefined;
  serializeMemorySummary(
    memory: MemoryFile,
    baseDir: string,
    disclosure?: RecallDisclosure,
    rawExcerpts?: EngramAccessMemorySummary["rawExcerpts"],
  ): EngramAccessMemorySummary;
  serializeRecallResults(
    snapshot: LastRecallSnapshot | null,
    disclosure: RecallDisclosure,
    rawContext?:
      | {
          query: string;
          sessionKey?: string;
          rawExcerptNamespace?: string;
          /**
           * Ordered, read-authorized LCM read session_id SET (#1505 fallback
           * unification). When supplied, raw disclosure queries each key (primary
           * coding overlay → read fallbacks) and merges rows so a branch-scoped
           * session finds excerpts archived at project/root scope. Already
           * read-gated, so no unauthorized overlay key is present. Omitted ⇒ the
           * legacy single `rawExcerptNamespace`-prefixed key (unchanged).
           */
          rawExcerptSessionIds?: string[];
          /**
           * Force NO raw excerpts even when `disclosure === "raw"` (#1505 thread
           * NBHWz). Set by callers when the IMPLICIT raw-excerpt read gate found
           * NO readable LCM namespace (a restrictive `default` READ policy with
           * no readable overlay/self namespace). The lookup must NOT fall back to
           * `snapshot.namespace` (the write/overlay namespace the read gate
           * excludes) — it returns empty excerpts so raw recall degrades
           * gracefully instead of leaking unreadable rows or throwing.
           */
          rawExcerptsSuppressed?: boolean;
        }
      | null,
  ): Promise<EngramAccessMemorySummary[]>;
  setCodingContext(request: EngramAccessSetCodingContextRequest): void;
  storageForAbsoluteRecallPath(
    memoryPath: string,
    primaryNamespace: string,
    recallNamespaces?: readonly string[],
  ): Promise<{ storage: StorageManager; dir: string } | null>;
}

export class AccessRecallSurface {
  constructor(
    private readonly deps: AccessRecallSurfaceDeps,
  ) {}

  async buildRecallResponseFromXraySnapshot(options: {
    query: string;
    sessionKey?: string;
    snapshot: RecallXraySnapshot;
    storageCorpusVersionsAtRecallStart: Array<{ namespace: string; version: number | null }>;
    disclosure: RecallDisclosure;
    startedAt: number;
    requestedMode?: RecallPlanMode | "auto";
    normalizedMode?: RecallPlanMode;
    /**
     * Read-authorization-gated namespace for the raw-excerpt LCM lookup (#1505
     * thread 2f7). Threaded through to `serializeRecallResults` so the
     * `includeRecall` x-ray path honours the SAME read gate as normal recall and
     * never attaches overlay transcript rows the gate excludes.
     */
    rawExcerptNamespace?: string;
    /**
     * Ordered, read-authorized LCM read session_id SET (#1505 fallback
     * unification). Threaded through to `serializeRecallResults` so the x-ray raw
     * disclosure path also finds excerpts archived at the coding read fallbacks.
     */
    rawExcerptSessionIds?: string[];
    /**
     * Force NO raw excerpts (#1505 thread NBHWz). Set when the IMPLICIT
     * raw-excerpt read gate found NO readable LCM namespace, so the x-ray
     * includeRecall path degrades to empty excerpts rather than falling back to
     * the write/overlay namespace the read gate excludes.
     */
    rawExcerptsSuppressed?: boolean;
  }): Promise<EngramAccessRecallResponse> {
    const memoryIds = options.snapshot.results.map((result) => result.memoryId);
    const includedMemories = options.snapshot.results.map((result) => ({
      id: result.memoryId,
      path: result.path,
    }));
    const namespace = options.snapshot.namespace
      ? this.deps.resolveNamespace(options.snapshot.namespace)
      : this.deps.orchestrator.config.defaultNamespace;
    const sourcesUsed = Array.from(
      new Set(options.snapshot.results.map((result) => result.servedBy)),
    );
    const snapshotForSerialization: LastRecallSnapshot = {
      sessionKey: options.sessionKey ?? "",
      recordedAt: new Date(options.snapshot.capturedAt).toISOString(),
      queryHash: createHash("sha256").update(options.query).digest("hex"),
      queryLen: options.query.length,
      memoryIds,
      namespace,
      recallNamespaces: [namespace],
      traceId: options.snapshot.traceId,
      plannerMode: options.normalizedMode,
      requestedMode: options.requestedMode !== "auto" ? options.requestedMode : undefined,
      sourcesUsed,
      budgetsApplied: {
        appliedTopK: memoryIds.length,
        recallBudgetChars: options.snapshot.budget.chars,
        maxMemoryTokens: this.deps.orchestrator.config.maxMemoryTokens,
        finalContextChars: options.snapshot.budget.used,
      },
      latencyMs: Date.now() - options.startedAt,
      timings: lastRecallTimingsFor(this.deps.orchestrator.lastRecall, options.sessionKey, options.snapshot.traceId),
      includedMemories,
    };
    const results = await this.deps.serializeRecallResults(
      snapshotForSerialization,
      options.disclosure,
      {
        query: options.query,
        ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
        ...(options.rawExcerptNamespace
          ? { rawExcerptNamespace: options.rawExcerptNamespace }
          : {}),
        ...(options.rawExcerptSessionIds !== undefined
          ? { rawExcerptSessionIds: options.rawExcerptSessionIds }
          : {}),
        ...(options.rawExcerptsSuppressed
          ? { rawExcerptsSuppressed: options.rawExcerptsSuppressed }
          : {}),
      },
    );
    const context = results
      .map((result) => {
        const content =
          typeof result.content === "string" && result.content.length > 0
            ? result.content
            : "";
        return content || result.preview;
      })
      .filter((text) => text.length > 0)
      .join("\n\n");

    return {
      query: options.query,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      namespace,
      context,
      count: memoryIds.length,
      memoryIds,
      results,
      recordedAt: snapshotForSerialization.recordedAt,
      traceId: options.snapshot.traceId,
      plannerMode: options.normalizedMode,
      fallbackUsed: sourcesUsed.some((source) => source !== "hybrid"),
      sourcesUsed,
      disclosure: options.disclosure,
      budgetsApplied: snapshotForSerialization.budgetsApplied,
      storageCorpusVersionsAtRecallStart: options.storageCorpusVersionsAtRecallStart,
      latencyMs: snapshotForSerialization.latencyMs,
      timings: snapshotForSerialization.timings,
    };
  }

  async serializeRecallResults(
    snapshot: LastRecallSnapshot | null,
    disclosure: RecallDisclosure,
    rawContext:
      | {
          query: string;
          sessionKey?: string;
          /**
           * Read-authorization-gated namespace for the raw-excerpt LCM lookup
           * (#1505 thread 2f7). When the caller supplies it, the raw lookup uses
           * THIS namespace prefix instead of `snapshot.namespace` (the
           * write/overlay namespace), so raw disclosure honours the SAME read
           * gate as normal recall + `lcmSearch`. Omitted ⇒ falls back to the
           * snapshot namespace (single-store / sessionless callers, unchanged).
           */
          rawExcerptNamespace?: string;
          /**
           * Ordered, read-authorized LCM read session_id SET (#1505 fallback
           * unification). When supplied, raw disclosure queries each key (primary
           * coding overlay → read fallbacks) and merges rows so a branch-scoped
           * session finds excerpts archived at project/root scope. Already
           * read-gated, so no unauthorized overlay key is present. Omitted ⇒ the
           * legacy single `rawExcerptNamespace`-prefixed key (unchanged).
           */
          rawExcerptSessionIds?: string[];
          /**
           * Force NO raw excerpts even when `disclosure === "raw"` (#1505 thread
           * NBHWz). Set by callers when the IMPLICIT raw-excerpt read gate found
           * NO readable LCM namespace (a restrictive `default` READ policy with
           * no readable overlay/self namespace). The lookup must NOT fall back to
           * `snapshot.namespace` (the write/overlay namespace the read gate
           * excludes) — it returns empty excerpts so raw recall degrades
           * gracefully instead of leaking unreadable rows or throwing.
           */
          rawExcerptsSuppressed?: boolean;
        }
      | null = null,
  ): Promise<EngramAccessMemorySummary[]> {
    if (!snapshot) return [];
    const namespace = snapshot.namespace ? this.deps.resolveNamespace(snapshot.namespace) : this.deps.orchestrator.config.defaultNamespace;
    const storage = await this.deps.orchestrator.getStorage(namespace);
    const storageDir = storage.dir;
    const recallNamespaces = Array.from(
      new Set(
        [
          namespace,
          ...(Array.isArray(snapshot.recallNamespaces)
            ? snapshot.recallNamespaces.map((ns) => this.deps.resolveNamespace(ns))
            : []),
          this.deps.orchestrator.config.defaultNamespace,
          this.deps.orchestrator.config.sharedNamespace,
          ...(this.deps.orchestrator.config.namespacePolicies ?? []).map((p) => p.name),
        ].filter((ns): ns is string => typeof ns === "string" && ns.length > 0),
      ),
    );
    const results: EngramAccessMemorySummary[] = [];
    const seen = new Set<string>();
    const collectionNamespaceFromPrefix = (collectionPrefix: string): string | null => {
      const baseCollection = this.deps.orchestrator.config.qmdCollection;
      if (collectionPrefix === baseCollection) return this.deps.orchestrator.config.defaultNamespace;
      const namespaceSuffix = collectionPrefix.startsWith(`${baseCollection}--`)
        ? collectionPrefix.slice(baseCollection.length + 2)
        : "";
      if (!namespaceSuffix) return null;

      const decoded = namespaceIdentityFromToken(namespaceSuffix);
      if (decoded !== null) return decoded || this.deps.orchestrator.config.defaultNamespace;
      if (namespaceSuffix.startsWith("ns--")) {
        const legacyNamespace = namespaceSuffix.slice("ns--".length).trim();
        return legacyNamespace || null;
      }
      return null;
    };
    const readResultPath = async (
      memoryPath: string,
      preferredNamespace?: string,
    ): Promise<{ memory: MemoryFile; baseDir: string } | null> => {
      const parts = qmdCollectionPathParts(memoryPath);
      const coldCollection =
        this.deps.orchestrator.config.qmdColdCollection ?? "openclaw-engram-cold";
      const collectionNamespace = parts ? collectionNamespaceFromPrefix(parts.collection) : null;
      const preferredAttempted = Boolean(
        preferredNamespace &&
          (!parts ||
            (collectionNamespace === null && parts.collection !== coldCollection)),
      );
      if (preferredAttempted) {
        try {
          const preferredStorage = await this.deps.orchestrator.getStorage(
            this.deps.resolveNamespace(preferredNamespace),
          );
          for (const candidate of qmdResultPathCandidates(
            preferredStorage.dir,
            memoryPath,
          )) {
            const memory = await preferredStorage.readMemoryByPath(candidate);
            if (memory) return { memory, baseDir: preferredStorage.dir };
          }
        } catch (err) {
          if (err instanceof SecureStoreLockedError) throw err;
        }
      }
      if (parts && parts.collection === coldCollection) {
        const storages: Array<{ storage: StorageManager; dir: string }> = [];
        const seenStorageDirs = new Set<string>();
        const addStorage = (candidateStorage: StorageManager): void => {
          const candidateDir = nodePath.resolve(candidateStorage.dir);
          if (seenStorageDirs.has(candidateDir)) return;
          seenStorageDirs.add(candidateDir);
          storages.push({ storage: candidateStorage, dir: candidateDir });
        };
        addStorage(storage);
        for (const recallNamespace of recallNamespaces) {
          try {
            addStorage(await this.deps.orchestrator.getStorage(recallNamespace));
          } catch {
            continue;
          }
        }
        for (const candidateStorage of storages) {
          try {
            const coldRoot = nodePath.join(candidateStorage.dir, "cold");
            for (const candidatePath of qmdResultPathCandidates(
              coldRoot,
              parts.relativePath,
            )) {
              const memory =
                await candidateStorage.storage.readMemoryByPath(candidatePath);
              if (memory) return { memory, baseDir: candidateStorage.dir };
            }
          } catch (err) {
            if (err instanceof SecureStoreLockedError) throw err;
            continue;
          }
        }
        return null;
      }


      if (parts && collectionNamespace) {
        try {
          const collectionStorage =
            await this.deps.orchestrator.getStorage(collectionNamespace);
          for (const candidate of qmdResultPathCandidates(
            collectionStorage.dir,
            parts.relativePath,
          )) {
            const memory = await collectionStorage.readMemoryByPath(candidate);
            if (memory) return { memory, baseDir: collectionStorage.dir };
          }
          return null;
        } catch (err) {
          if (err instanceof SecureStoreLockedError) throw err;
          return null;
        }
      }

      if (nodePath.isAbsolute(memoryPath)) {
        const ownerStorage = await this.deps.storageForAbsoluteRecallPath(
          memoryPath,
          namespace,
          recallNamespaces,
        );
        if (!ownerStorage) return null;
        for (const candidate of qmdResultPathCandidates(
          ownerStorage.dir,
          memoryPath,
        )) {
          const memory = await ownerStorage.storage.readMemoryByPath(candidate);
          if (memory) return { memory, baseDir: ownerStorage.dir };
        }
        return null;
      }

      // A preferred namespace was supplied but its file is missing/stale. For a
      if (preferredAttempted && !nodePath.isAbsolute(memoryPath)) return null;

      for (const candidate of qmdResultPathCandidates(storageDir, memoryPath)) {
        const memory = await storage.readMemoryByPath(candidate);
        if (memory) return { memory, baseDir: storageDir };
      }
      return null;
    };

    // Pre-fetch raw excerpts once when `disclosure === "raw"` so we don't
    // hit the LCM archive per-result (issue #677 PR 2/4).  Each excerpt is
    // attributed to the result whose provenance quote it contains (issue
    // #3546); excerpts no result claims stay anchored to the first result.
    // Namespace for the LCM `${namespace}:${sessionKey}` prefix: prefer the
    const rawExcerptsResult =
      rawContext?.rawExcerptsSuppressed === true
        ? // Implicit raw recall with NO readable LCM namespace (#1505 thread
          []
        : await this.deps.fetchRawExcerpts(
            disclosure,
            rawContext
              ? {
                  query: rawContext.query,
                  ...(rawContext.sessionKey
                    ? { sessionKey: rawContext.sessionKey }
                    : {}),
                  namespace: rawContext.rawExcerptNamespace ?? namespace,
                  ...(rawContext.rawExcerptSessionIds !== undefined
                    ? { lcmSessionIds: rawContext.rawExcerptSessionIds }
                    : {}),
                }
              : null,
          );
    const rawExcerpts = rawExcerptsResult ?? undefined;
    const pending: Array<{ memory: MemoryFile; baseDir: string }> = [];
    for (const included of coerceIncludedMemories(snapshot)) {
      const memoryPath = included.path;
      if (!memoryPath) continue;
      const memoryNamespace = included.namespace;
      const seenKey = `${memoryNamespace ?? ""}\0${memoryPath}`;
      if (seen.has(seenKey)) continue;
      const resolved = await readResultPath(memoryPath, memoryNamespace);
      if (!resolved) continue;
      const { memory, baseDir } = resolved;
      seen.add(seenKey);
      pending.push({ memory, baseDir });
    }

    if (pending.length === 0) {
      for (const memoryId of snapshot.memoryIds) {
        const memory = await storage.getMemoryById(memoryId);
        if (!memory || seen.has(memory.path)) continue;
        seen.add(memory.path);
        pending.push({ memory, baseDir: storageDir });
      }
    }

    const attributed = attributeRawExcerpts(
      pending.map((entry) => entry.memory),
      rawExcerpts,
    );
    for (const [index, entry] of pending.entries()) {
      results.push(
        this.deps.serializeMemorySummary(
          entry.memory,
          entry.baseDir,
          disclosure,
          attributed[index],
        ),
      );
    }
    return results;
  }


  /**
   * Fetch raw transcript excerpts from the LCM archive for `disclosure ===
   * "raw"` recalls (issue #677 PR 2/4).  Returns `null` for non-raw recall
   * depths, an empty array when LCM is disabled / not initialized / has no
   * matches, and an array of LCM-side excerpts otherwise.  Errors are
   * swallowed and treated as "no excerpts" so a failing LCM never breaks
   * the recall response.
   *
   * Namespace handling: LCM archival prefixes non-default-namespace
   * sessions with `${namespace}:${sessionKey}` (see `observe()` around
   * line 2498), so the lookup must mirror that prefix or raw recalls in
   * non-default namespaces miss their own excerpts.
   */
  async fetchRawExcerpts(
    disclosure: RecallDisclosure,
    context: {
      query: string;
      sessionKey?: string;
      namespace?: string;
      /**
       * Pre-resolved, ordered, read-authorized LCM read session_id SET (#1505
       * fallback unification). When supplied, raw disclosure queries each key in
       * order (primary coding overlay → read fallbacks) and merges rows, exactly
       * as the orchestrator recall path and `lcmSearch` do, so a branch-scoped
       * session finds excerpts archived at project/root scope. Already
       * read-gated by `resolveLcmReadSessionIds`, so an unauthorized
       * `<principal>-project-*` key is never present. Falls back to the legacy
       * single `namespace`-prefixed key when absent (sessionless / legacy
       * callers).
       */
      lcmSessionIds?: string[];
    } | null,
  ): Promise<EngramAccessMemorySummary["rawExcerpts"] | null> {
    if (disclosure !== "raw") return null;
    if (!context || !context.query) return [];
    if (!context.sessionKey) return [];
    const lcm = this.deps.orchestrator.lcmEngine;
    if (!lcm || !lcm.enabled) return [];
    try {
      const legacyKey =
        context.namespace &&
        context.namespace !== this.deps.orchestrator.config.defaultNamespace
          ? `${context.namespace}:${context.sessionKey}`
          : context.sessionKey;
      const lcmSessionIds = context.lcmSessionIds !== undefined ? context.lcmSessionIds : [legacyKey];
      const limit = 5;
      const seenRows = new Set<string>();
      const excerpts: NonNullable<EngramAccessMemorySummary["rawExcerpts"]> = [];
      const settledRows = await Promise.allSettled(
        lcmSessionIds.map(async (lcmSessionKey) =>
          lcm.searchContextFull(context.query, limit, lcmSessionKey),
        ),
      );
      for (const result of settledRows) {
        if (excerpts.length >= limit) break;
        if (result.status !== "fulfilled") continue;
        for (const r of result.value) {
          const dedupeKey = lcmEvidenceIdentity(r, r.session_id).id;
          if (seenRows.has(dedupeKey)) continue;
          seenRows.add(dedupeKey);
          excerpts.push({
            turnIndex: r.turn_index,
            role: r.role,
            content: r.content,
            sessionId: r.session_id,
          });
          if (excerpts.length >= limit) break;
        }
      }
      return excerpts;
    } catch {
      return [];
    }
  }

  async executeRecall(
    request: EngramAccessRecallRequest,
  ): Promise<{
    response: EngramAccessRecallResponse;
    budgetRecordPrincipal: string | null;
    reservation?: BudgetReservation;
  }> {
    const query = request.query;
    const callerProvidedDisclosure =
      request.disclosure !== undefined && request.disclosure !== null;
    const requestedDisclosure: RecallDisclosure = (() => {
      if (!callerProvidedDisclosure) {
        return DEFAULT_RECALL_DISCLOSURE;
      }
      if (!isRecallDisclosure(request.disclosure)) {
        throw new EngramAccessInputError(
          `disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
        );
      }
      return request.disclosure;
    })();
    if (request.codingContext !== undefined && request.sessionKey) {
      this.deps.setCodingContext({
        sessionKey: request.sessionKey,
        codingContext: request.codingContext,
        authenticatedPrincipal: request.authenticatedPrincipal, remote: true,
      });
    }
    if (request.codingContext === undefined && request.sessionKey) {
      await this.deps.maybeAttachCodingContext(request.sessionKey, {
        cwd: request.cwd, projectTag: request.projectTag,
        authenticatedPrincipal: request.authenticatedPrincipal,
      });
    }
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const namespaceOverride = this.deps.resolveRecallNamespace(
      request.namespace,
      request.sessionKey,
      authenticatedPrincipal,
    );
    const namespace = namespaceOverride ?? this.deps.orchestrator.config.defaultNamespace;
    const mode = this.deps.normalizeRecallMode(request.mode);
    const maybePrincipal = this.deps.resolveRequestPrincipal(request.sessionKey, authenticatedPrincipal);
    if (resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces && !maybePrincipal) {
      throw new EngramAccessInputError(
        "authentication required: namespaces are enabled and no principal was supplied",
      );
    }
    const principal = maybePrincipal ?? "default";
    const principalNamespace = defaultNamespaceForPrincipal(principal, this.deps.orchestrator.config);
    const profileCodingContext =
      request.sessionKey && typeof this.deps.orchestrator.getCodingContextForSession === "function"
        ? this.deps.orchestrator.getCodingContextForSession(request.sessionKey)
        : null;
    const profileCodingOverlay =
      !namespaceOverride &&
      profileCodingContext &&
      resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces &&
      this.deps.orchestrator.config.codingMode?.projectScope
        ? resolveCodingNamespaceOverlay(
            profileCodingContext,
            this.deps.orchestrator.config.codingMode,
            this.deps.orchestrator.config.defaultNamespace,
          )
        : null;
    const profilePlan = namespaceOverride
      ? null
      : resolveScopeProfilePlan({
          config: this.deps.orchestrator.config,
          principal,
          codingContext: profileCodingContext,
          codingOverlay: profileCodingOverlay,
        });
    const recallScopePlan = resolveScopePlan({
      config: this.deps.orchestrator.config,
      sessionKey: request.sessionKey,
      namespace: namespaceOverride,
      principalOverride: authenticatedPrincipal,
      codingContext: profileCodingContext,
      namespacesEnabled: resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces,
    });
    const modeSkipsBudget = mode === "no_recall";
    const effectiveNamespaces = recallScopePlan.readNamespaces;
    const budgetPrincipalNamespace = profilePlan?.baseNamespace ?? principalNamespace;
    let budgetDecision: BudgetDecision;
    let willReserveBudget = false;
    if (modeSkipsBudget) {
      budgetDecision = {
        allowed: true as const,
        reason: "allowed-same-namespace" as const,
        count: 0,
        limit: {
          softLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetSoftLimit ?? 10,
          hardLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetHardLimit ?? 30,
          windowMs: this.deps.orchestrator.config.recallCrossNamespaceBudgetWindowMs ?? 60_000,
        },
      };
    } else {
      let anyCrossNamespace = false;
      let denied: BudgetDecision | null = null;
      let crossNamespaceDecision: BudgetDecision | null = null;
      for (const ns of effectiveNamespaces) {
        const peek = this.deps.budget.peek({
          principal,
          principalNamespace: budgetPrincipalNamespace,
          queryNamespace: ns,
        });
        if (peek.reason !== "allowed-same-namespace") {
          anyCrossNamespace = true;
          crossNamespaceDecision ??= peek;
        }
        if (!peek.allowed) {
          denied = peek;
          break;
        }
      }
      if (denied) {
        budgetDecision = denied;
      } else if (anyCrossNamespace) {
        budgetDecision = crossNamespaceDecision ?? {
          allowed: true as const,
          reason: "allowed-under-soft" as const,
          count: 0,
          limit: {
            softLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetSoftLimit ?? 10,
            hardLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetHardLimit ?? 30,
            windowMs: this.deps.orchestrator.config.recallCrossNamespaceBudgetWindowMs ?? 60_000,
          },
        };
        willReserveBudget = true;
      } else {
        budgetDecision = {
          allowed: true as const,
          reason: "allowed-same-namespace" as const,
          count: 0,
          limit: {
            softLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetSoftLimit ?? 10,
            hardLimit: this.deps.orchestrator.config.recallCrossNamespaceBudgetHardLimit ?? 30,
            windowMs: this.deps.orchestrator.config.recallCrossNamespaceBudgetWindowMs ?? 60_000,
          },
        };
      }
      if (!budgetDecision.allowed) {
        throw new EngramAccessInputError(
          `recall denied: cross-namespace budget exceeded (${budgetDecision.count}/${budgetDecision.limit.hardLimit} in ${budgetDecision.limit.windowMs}ms window)`,
        );
      }
      this.deps.budget.gc();
    }
    const topK = Number.isFinite(request.topK) ? Math.max(0, Math.floor(request.topK ?? 0)) : undefined;
    let asOf: string | undefined;
    if (request.asOf !== undefined && request.asOf !== null) {
      if (typeof request.asOf !== "string" || request.asOf.trim().length === 0) {
        throw new EngramAccessInputError(
          "asOf must be a non-empty ISO 8601 timestamp string",
        );
      }
      const parsed = Date.parse(request.asOf);
      if (!Number.isFinite(parsed)) {
        throw new EngramAccessInputError(
          `asOf must be a parseable ISO 8601 timestamp (got: "${request.asOf}")`,
        );
      }
      asOf = request.asOf;
    }
    let contextComposition: RecallContextComposition | undefined;
    const recallOptions: RecallInvocationOptions = {
      namespace: namespaceOverride,
      topK,
      mode,
      onContextComposition: (composition) => {
        contextComposition = composition;
      },
      onRecallPlanResolved: createRecallCorpusVersionCapture(this.deps.orchestrator, request.abortSignal, (versions) => { storageCorpusVersionsAtRecallStart = mergeRecallCorpusVersions(storageCorpusVersionsAtRecallStart, versions); }, true, { deadlineMs: request.deadlineMs }),
      ...(authenticatedPrincipal ? { principalOverride: authenticatedPrincipal } : {}),
      ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
      ...(request.stateView !== undefined ? { stateView: request.stateView } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
      ...(request.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      ...(typeof request.queueWaitMs === "number" && request.queueWaitMs > 0
        ? { queueWaitMs: request.queueWaitMs }
        : {}),
    };
    if (request.searchOptions) recallOptions.searchOptions = request.searchOptions;
    if (request.deadlineMs !== undefined) recallOptions.deadlineMs = request.deadlineMs;
    const startedAt = Date.now();
    let reservedBudgetPrincipal: string | null = null;
    let reservedBudget: BudgetReservation | undefined;
    if (willReserveBudget) {
      const reserveDecision = this.deps.budget.record(principal);
      budgetDecision = reserveDecision;
      if (!reserveDecision.allowed) {
        throw new EngramAccessInputError(
          `recall denied: cross-namespace budget exceeded (${reserveDecision.count}/${reserveDecision.limit.hardLimit} in ${reserveDecision.limit.windowMs}ms window)`,
        );
      }
      reservedBudgetPrincipal = principal;
      reservedBudget = reserveDecision.reservation;
    }
    let storageCorpusVersionsAtRecallStart: Array<{ namespace: string; version: number | null }> = [];
    try {
      const context = await this.deps.orchestrator.recall(
        query,
        request.sessionKey,
        recallOptions,
      );
      const assembled = await assembleRecallResponse(this.deps, {
        request,
        context,
        contextComposition,
        storageCorpusVersionsAtRecallStart,
        query,
        mode,
        namespace,
        requestedDisclosure,
        callerProvidedDisclosure,
        topK,
        principal,
        authenticatedPrincipal,
        startedAt,
        budgetDecision,
        budgetRecordPrincipal: reservedBudgetPrincipal,
      });
      return { ...assembled, reservation: reservedBudget };
    } catch (err) {
      if (reservedBudget) this.deps.budget.release(reservedBudget);
      throw err;
    }
  }

  /**
   * Recall X-ray (issue #570).  Runs a recall with `xrayCapture: true`
   * and returns the resulting snapshot as structured JSON so every
   * surface (CLI / HTTP / MCP) gets the same payload.  Namespace scope
   * is enforced before the recall fires (CLAUDE.md rule 42 — read and
   * write paths must resolve through the same namespace layer) so an
   * unauthorized principal cannot capture an x-ray for a namespace it
   * cannot read.
   */
  async recallXray(request: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    budget?: number;
    authenticatedPrincipal?: string;
    sourceConnector?: string;
    /**
     * Disclosure depth used to shape per-result payload (issue #677
     * PR 3/4).  When set, each X-ray result is decorated with the
     * matching `disclosure` field and `estimatedTokens` computed from
     * the actual rendered content at that depth, so the renderer's
     * "Token spend by disclosure" summary reflects real spend rather
     * than staying empty when no caller wires the depth knob through.
     */
    disclosure?: RecallDisclosure;
    /**
     * Free-form recall tag filter (issue #689). Mirrors the field on
     * `EngramAccessRecallRequest`. When non-empty, the captured X-ray
     * snapshot's `results` are filtered down to memories whose
     * frontmatter tags satisfy `tagMatch` ("any" by default), and a
     * `tag-filter` entry is appended to `filters`.
     */
    tags?: string[];
    /** Match mode for `tags`. See `EngramAccessRecallRequest.tagMatch`. */
    tagMatch?: "any" | "all";
    /** Recall planner mode override. Mirrors `EngramAccessRecallRequest.mode`. */
    mode?: RecallPlanMode | "auto";
    /**
     * User-aware context scopes active for this recall. Forwarded into
     * provenance construction so boundary scopes are evaluated against
     * the caller's real context instead of an empty-context default.
     */
    currentContextScopes?: readonly unknown[];
    /**
     * Internal inspector affordance: include a recall-shaped response
     * derived from the same X-ray snapshot. Left off by default so the
     * regular X-ray API/CLI/MCP surfaces keep their existing payload shape.
     */
    includeRecall?: boolean;
    /** Cancel the capture before it starts and propagate cancellation to recall. */
    abortSignal?: AbortSignal;
  }): Promise<{
    snapshotFound: boolean;
    snapshot?: RecallXraySnapshot;
    recall?: EngramAccessRecallResponse;
  }> {
    const query = typeof request.query === "string" ? request.query : "";
    if (query.trim().length === 0) {
      throw new Error("recallXray: query is required and must be non-empty");
    }
    if (
      request.disclosure !== undefined &&
      !isRecallDisclosure(request.disclosure)
    ) {
      throw new EngramAccessInputError(
        `recallXray: disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
      );
    }

    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces;
    const requestedNamespace = request.namespace?.trim() ? this.deps.resolveNamespace(request.namespace) : undefined;
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const principal =
      authenticatedPrincipal
      || resolvePrincipal(request.sessionKey, this.deps.orchestrator.config);

    if (requestedNamespace) {
      if (
        !canReadNamespace(
          principal,
          requestedNamespace,
          this.deps.orchestrator.config,
        )
      ) {
        return { snapshotFound: false };
      }
    } else if (
      namespacesEnabled
      && !authenticatedPrincipal
      && !request.sessionKey?.trim()
    ) {
      return { snapshotFound: false };
    }

    let budgetOverride: number | undefined;
    if (request.budget !== undefined && request.budget !== null) {
      const parsed =
        typeof request.budget === "number"
          ? request.budget
          : Number(request.budget);
      if (
        !Number.isFinite(parsed)
        || parsed <= 0
        || !Number.isInteger(parsed)
      ) {
        throw new Error(
          `recallXray: budget expects a positive integer; got ${JSON.stringify(request.budget)}`,
        );
      }
      budgetOverride = parsed;
    }
    const mode = this.deps.normalizeRecallMode(request.mode);
    const disclosure = request.disclosure ?? DEFAULT_RECALL_DISCLOSURE;

    let recallStartedAt = Date.now();

    const recallSessionKey = request.sessionKey?.trim() || undefined;
    let storageCorpusVersionsAtRecallStart: Array<{ namespace: string; version: number | null }> = [];
    let xrayResponse: {
      snapshotFound: boolean;
      snapshot?: RecallXraySnapshot;
    } = { snapshotFound: false };

    {
      const {
        snapshot: rawSnapshot,
        recallStartedAt: capturedRecallStartedAt,
      } = await this.deps.orchestrator.recallWithXrayCapture(
        query,
        recallSessionKey,
        {
          ...(requestedNamespace ? { namespace: requestedNamespace } : {}),
          ...(budgetOverride !== undefined
            ? { budgetCharsOverride: budgetOverride }
            : {}),
          ...(mode !== undefined ? { mode } : {}),
          onRecallPlanResolved: createRecallCorpusVersionCapture(this.deps.orchestrator, request.abortSignal, (versions) => { storageCorpusVersionsAtRecallStart = mergeRecallCorpusVersions(storageCorpusVersionsAtRecallStart, versions); }, true),
          ...(authenticatedPrincipal
            ? { principalOverride: authenticatedPrincipal }
            : {}),
          ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
          ...(request.currentContextScopes !== undefined
            ? { currentContextScopes: request.currentContextScopes }
            : {}),
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        },
      );
      recallStartedAt = capturedRecallStartedAt;
<<<<<<< HEAD
      // Cancellation covers queueing + recall/capture. Post-capture shaping is
=======
      // Cancellation covers queueing, capture, and post-capture shaping:
      // a check sits at each mid-I/O boundary below (issue #3547).
>>>>>>> origin/main
      throwIfAborted(request.abortSignal, "recall X-ray aborted before postprocessing");
      const namespaceMismatch =
        requestedNamespace !== undefined &&
        rawSnapshot?.namespace !== requestedNamespace;
      if (!rawSnapshot) {
        xrayResponse = { snapshotFound: false };
      } else if (namespaceMismatch) {
        xrayResponse = { snapshotFound: false };
      } else {
        // see the "considered → admitted" delta.
        let snapshot = rawSnapshot;
        const xrayFilterTags = normalizeTags(request.tags);
        let xrayTagMatch: TagMatchMode | undefined;
        try {
          xrayTagMatch = parseTagMatch(request.tagMatch);
        } catch (err) {
          throw new EngramAccessInputError(
            err instanceof Error ? err.message : String(err),
          );
        }
        if (xrayFilterTags && xrayFilterTags.length > 0) {
          const namespace = snapshot.namespace
            ? this.deps.resolveNamespace(snapshot.namespace)
            : this.deps.orchestrator.config.defaultNamespace;
          const tagsByIndex = await Promise.all(
            snapshot.results.map(async (result) => {
              try {
                const storage = await this.deps.orchestrator.getStorage(namespace);
                const memory = await storage.readMemoryByPath(result.path);
                const t = memory?.frontmatter?.tags;
                return Array.isArray(t) ? normalizeProjectionTags(t) : [];
              } catch {
                return [];
              }
            }),
          );
          throwIfAborted(request.abortSignal, "recall X-ray aborted during tag filtering");
          const tagged = snapshot.results.map((result, index) => ({
            result,
            tags: tagsByIndex[index] ?? [],
          }));
          const { results: admittedTagged, trace } = applyTagFilter(tagged, {
            tags: xrayFilterTags,
            tagMatch: xrayTagMatch,
          });
          const admittedResults = admittedTagged.map((entry) => entry.result);
          const filters = trace ? [...snapshot.filters, trace] : snapshot.filters;
          snapshot = { ...snapshot, results: admittedResults, filters };
        }
        if (request.disclosure !== undefined) {
          const disclosure: RecallDisclosure = request.disclosure;
          const namespace = snapshot.namespace
            ? this.deps.resolveNamespace(snapshot.namespace)
            : this.deps.orchestrator.config.defaultNamespace;
          const trimmedSessionKey = request.sessionKey?.trim() || undefined;
          const rawExcerptNamespace =
            disclosure === "raw"
              ? this.deps.resolveRawExcerptReadNamespace(
                  request.namespace,
                  trimmedSessionKey,
                  authenticatedPrincipal,
                )
              : namespace;
          const xrayHasExplicitNamespace =
            typeof request.namespace === "string" &&
            request.namespace.trim().length > 0;
          const rawExcerptsSuppressed =
            disclosure === "raw" &&
            !xrayHasExplicitNamespace &&
            rawExcerptNamespace === undefined;
          const rawExcerptSessionIds =
            disclosure === "raw" && trimmedSessionKey && rawExcerptNamespace
              ? this.deps.resolveLcmReadSessionIds(
                  request.namespace,
                  rawExcerptNamespace,
                  trimmedSessionKey,
                  authenticatedPrincipal,
                )
              : undefined;
          throwIfAborted(request.abortSignal, "recall X-ray aborted before raw-excerpt fetch");
          const rawExcerpts =
            disclosure === "raw" && !rawExcerptsSuppressed
              ? await this.deps.fetchRawExcerpts(disclosure, {
                  query,
                  ...(trimmedSessionKey ? { sessionKey: trimmedSessionKey } : {}),
                  ...(rawExcerptNamespace
                    ? { namespace: rawExcerptNamespace }
                    : {}),
                  ...(rawExcerptSessionIds !== undefined
                    ? { lcmSessionIds: rawExcerptSessionIds }
                    : {}),
                })
              : disclosure === "raw"
                ? []
                : null;
          const rawExcerptText =
            rawExcerpts && rawExcerpts.length > 0
              ? rawExcerpts.map((e) => e.content).join("\n")
              : "";
<<<<<<< HEAD
=======
          // Pre-load every memory in parallel so we can:
          //   (a) re-attribute raw excerpts to the *first readable* result
          //       rather than always to index 0 (Cursor Low review on PR
          //       #699: a missing/unreadable result[0] orphaned the excerpt
          //       budget); and
          //   (b) include the metadata fields `shapeMemorySummary` actually
          //       emits at every depth (id, path, category, status, created,
          //       updated, tags, entityRef) in the token estimate, so the
          //       summary reflects real spend rather than only payload-body
          //       spend (Cursor Low review on PR #699).
          throwIfAborted(request.abortSignal, "recall X-ray aborted before result reads");
>>>>>>> origin/main
          const memoryByIndex = await Promise.all(
            snapshot.results.map(async (result) => {
              try {
                const storage = await this.deps.orchestrator.getStorage(namespace);
                return await storage.readMemoryByPath(result.path);
              } catch {
                return null;
              }
            }),
          );
          throwIfAborted(request.abortSignal, "recall X-ray aborted during result reads");
          const firstReadableIndex = memoryByIndex.findIndex((m) => m !== null);
          const baseDir =
            (await this.deps.orchestrator.getStorage(namespace)).dir;
          throwIfAborted(request.abortSignal, "recall X-ray aborted during result decoration");
          const decorated = snapshot.results.map((result, index) => {
            const memory = memoryByIndex[index];
            if (!memory) {
              return { ...result, disclosure };
            }
            const shaped = shapeMemorySummary(
              memory,
              baseDir,
              disclosure,
              disclosure === "raw" &&
              index === firstReadableIndex &&
              rawExcerpts &&
              rawExcerpts.length > 0
                ? rawExcerpts
                : undefined,
            );
            return {
              ...result,
              disclosure,
              estimatedTokens: estimateRecallTokens(JSON.stringify(shaped)),
            };
          });
          if (
            disclosure === "raw" &&
            firstReadableIndex === -1 &&
            rawExcerptText.length > 0 &&
            decorated.length > 0
          ) {
            decorated[0] = {
              ...decorated[0]!,
              disclosure,
              estimatedTokens: estimateRecallTokens(rawExcerptText),
            };
          }
          const decoratedSnapshot = { ...snapshot, results: decorated };
          xrayResponse = {
            snapshotFound: true,
            snapshot: decoratedSnapshot,
          };
        } else {
          xrayResponse = {
            snapshotFound: true,
            snapshot,
          };
        }
      }
    }

    if (
      request.includeRecall === true &&
      xrayResponse.snapshotFound === true &&
      xrayResponse.snapshot
    ) {
      const xrayRawExcerptNamespace =
        disclosure === "raw"
          ? this.deps.resolveRawExcerptReadNamespace(
              request.namespace,
              recallSessionKey,
              authenticatedPrincipal,
            )
          : undefined;
      const xrayHasExplicitNamespace =
        typeof request.namespace === "string" &&
        request.namespace.trim().length > 0;
      const xrayRawExcerptsSuppressed =
        disclosure === "raw" &&
        !xrayHasExplicitNamespace &&
        xrayRawExcerptNamespace === undefined;
      const xrayRawExcerptSessionIds =
        disclosure === "raw" && xrayRawExcerptNamespace && recallSessionKey
          ? this.deps.resolveLcmReadSessionIds(
              request.namespace,
              xrayRawExcerptNamespace,
              recallSessionKey,
              authenticatedPrincipal,
            )
          : undefined;
      throwIfAborted(request.abortSignal, "recall X-ray aborted before recall response build");
      const recallArgs: Parameters<
        AccessRecallSurfaceDeps["buildRecallResponseFromXraySnapshot"]
      >[0] = {
        query,
        sessionKey: recallSessionKey,
        snapshot: xrayResponse.snapshot,
        disclosure,
        startedAt: recallStartedAt,
        requestedMode: request.mode,
        normalizedMode: mode,
        storageCorpusVersionsAtRecallStart,
      };
      if (xrayRawExcerptNamespace) recallArgs.rawExcerptNamespace = xrayRawExcerptNamespace;
      if (xrayRawExcerptSessionIds !== undefined) recallArgs.rawExcerptSessionIds = xrayRawExcerptSessionIds;
      if (xrayRawExcerptsSuppressed) recallArgs.rawExcerptsSuppressed = xrayRawExcerptsSuppressed;
      const recallResponse = await this.deps.buildRecallResponseFromXraySnapshot(recallArgs);
      throwIfAborted(request.abortSignal, "recall X-ray aborted after recall response build");
      return { ...xrayResponse, recall: recallResponse };
    }
    return xrayResponse;
  }
}
