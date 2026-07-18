/**
 * Access recall read-surface (extracted from access-service.ts; god-file
 * decomposition follow-through of #1526, same playbook: verbatim move +
 * live selfDeps wiring so Object.create(prototype) fakes and instance
 * stubs keep working).
 *
 * Owns the recall read pipeline of the access layer:
 *   - executeRecall (budget/audit-gated recall + serialization)
 *   - recallXray (X-ray capture surface, #570)
 *   - serializeRecallResults / buildRecallResponseFromXraySnapshot
 *   - fetchRawExcerpts (raw-excerpt read gate)
 */

import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { AccessAuditAdapter, type AccessAuditResult } from "./access-audit.js";
import { throwIfAborted } from "./abort-error.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import { type BudgetDecision, CrossNamespaceBudget } from "./cross-namespace-budget.js";
import { lcmEvidenceIdentity } from "./lcm/evidence-identity.js";
import { normalizeProjectionTags } from "./memory-projection-format.js";
import { namespaceIdentityFromToken } from "./namespaces/identity.js";
import { canReadNamespace, defaultNamespaceForPrincipal, recallNamespacesForPrincipal, resolvePrincipal } from "./namespaces/principal.js";
import { expandScopeProfileReadNamespaces, resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import type { Orchestrator, RecallInvocationOptions } from "./orchestrator.js";
import { decideDisclosureEscalation } from "./recall-disclosure-escalation.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import { type TagMatchMode, applyTagFilter, normalizeTags, parseTagMatch } from "./recall-tag-filter.js";
import { type RecallXraySnapshot, estimateRecallTokens } from "./recall-xray.js";
import { SecureStoreLockedError } from "./secure-store/index.js";
import { StorageManager } from "./index.js";
import { DEFAULT_RECALL_DISCLOSURE, type MemoryFile, type RecallDisclosure, type RecallPlanMode, isRecallDisclosure } from "./types.js";
import {
  EngramAccessInputError,
  shapeMemorySummary,
  type EngramAccessMemorySummary,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
  type EngramAccessSetCodingContextRequest,
} from "./access-service.js";
// Canonical copies (access-service.ts still carries private duplicates for
// its remaining callers; dedupe tracked separately).
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
    options: { cwd?: string; projectTag?: string },
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
    const resultPaths = options.snapshot.results.map((result) => result.path);
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
      requestedMode:
        options.requestedMode && options.requestedMode !== "auto"
          ? options.requestedMode
          : undefined,
      sourcesUsed,
      budgetsApplied: {
        appliedTopK: memoryIds.length,
        recallBudgetChars: options.snapshot.budget.chars,
        maxMemoryTokens: this.deps.orchestrator.config.maxMemoryTokens,
        finalContextChars: options.snapshot.budget.used,
      },
      latencyMs: Date.now() - options.startedAt,
      resultPaths,
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
      latencyMs: snapshotForSerialization.latencyMs,
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
    ): Promise<{ memory: MemoryFile; baseDir: string } | null> => {
      const parts = qmdCollectionPathParts(memoryPath);
      const coldCollection =
        this.deps.orchestrator.config.qmdColdCollection ?? "openclaw-engram-cold";
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

      const collectionNamespace = parts
        ? collectionNamespaceFromPrefix(parts.collection)
        : null;

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

      for (const candidate of qmdResultPathCandidates(storageDir, memoryPath)) {
        const memory = await storage.readMemoryByPath(candidate);
        if (memory) return { memory, baseDir: storageDir };
      }
      return null;
    };

    // Pre-fetch raw excerpts once when `disclosure === "raw"` so we don't
    // hit the LCM archive per-result (issue #677 PR 2/4).  Excerpts are
    // attached to the first result; per-result attribution is reserved
    // for a future PR if/when the LCM index can be joined to memory ids.
    // Coerce `null` (non-raw disclosure) to `undefined` so the optional
    // serializer field is never explicitly `null`.
    // Namespace for the LCM `${namespace}:${sessionKey}` prefix: prefer the
    // caller-supplied READ-AUTHORIZATION-GATED `rawExcerptNamespace` (#1505
    // thread 2f7) so raw disclosure honours the same read gate as normal recall
    // + `lcmSearch` and never attaches `<principal>-project-*` overlay rows the
    // gate excludes. Fall back to the snapshot's resolved namespace only when no
    // gated namespace was threaded (sessionless / legacy callers) — unchanged.
    const rawExcerptsResult =
      rawContext?.rawExcerptsSuppressed === true
        ? // Implicit raw recall with NO readable LCM namespace (#1505 thread
          // NBHWz): emit empty excerpts rather than falling back to the
          // write/overlay `namespace` the read gate excludes.
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

    for (const memoryPath of snapshot.resultPaths ?? []) {
      if (!memoryPath || seen.has(memoryPath)) continue;
      const resolved = await readResultPath(memoryPath);
      if (!resolved) continue;
      const { memory, baseDir } = resolved;
      seen.add(memoryPath);
      results.push(
        this.deps.serializeMemorySummary(
          memory,
          baseDir,
          disclosure,
          // Attach the (possibly empty) raw excerpts to the first raw
          // result; subsequent results do not duplicate the array.
          results.length === 0 ? rawExcerpts : undefined,
        ),
      );
    }

    if (results.length > 0) return results;

    for (const memoryId of snapshot.memoryIds) {
      const memory = await storage.getMemoryById(memoryId);
      if (!memory || seen.has(memory.path)) continue;
      seen.add(memory.path);
      results.push(
        this.deps.serializeMemorySummary(
          memory,
          storageDir,
          disclosure,
          results.length === 0 ? rawExcerpts : undefined,
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
    // Privacy guard: raw disclosure must be session-scoped.  Without a
    // sessionKey, `lcm.searchContextFull(query, n, undefined)` searches
    // across every archived session in the LCM store and would return
    // excerpts from unrelated sessions (potentially crossing namespaces
    // via their `${namespace}:${sessionKey}` prefix encoding).  Treat a
    // missing sessionKey as "no excerpts" — callers asking for raw
    // disclosure outside a session get an empty list, not a leak.
    if (!context.sessionKey) return [];
    const lcm = this.deps.orchestrator.lcmEngine;
    if (!lcm || !lcm.enabled) return [];
    try {
      const legacyKey =
        context.namespace &&
        context.namespace !== this.deps.orchestrator.config.defaultNamespace
          ? `${context.namespace}:${context.sessionKey}`
          : context.sessionKey;
      const lcmSessionIds =
        context.lcmSessionIds !== undefined
          ? context.lcmSessionIds
          : [legacyKey];
      // Cap the excerpt fanout so recall responses stay bounded.  Five matches
      // is enough to anchor the model in the raw transcript without ballooning
      // token spend; raw is meant as the escape hatch, not the default. The cap
      // is applied across the MERGED result set so adding fallback keys never
      // inflates the excerpt budget.
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
      // CLAUDE.md rule 13: never let an external subsystem (LCM/SQLite)
      // crash the primary recall flow.
      return [];
    }
  }

  async executeRecall(
    request: EngramAccessRecallRequest,
  ): Promise<{
    response: EngramAccessRecallResponse;
    budgetRecordPrincipal: string | null;
  }> {
    const query = request.query;
    // Disclosure depth (issue #677).  Default to `"chunk"` when omitted so
    // pre-#677 callers see unchanged behavior.  Reject explicitly invalid
    // string values per CLAUDE.md rule 51 (do not silently fall back).
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
    // Attach any coding context shipped with the recall request BEFORE
    // namespace resolution so the overlay applies to this recall (issue #569).
    if (request.codingContext !== undefined && request.sessionKey) {
      this.deps.setCodingContext({
        sessionKey: request.sessionKey,
        codingContext: request.codingContext,
      });
    }
    // Auto-resolve coding context from cwd/projectTag when no explicit
    // codingContext was supplied (issue #569 wiring). This allows Claude
    // Code hooks and OpenClaw connectors to get project-scoped memory
    // transparently.
    if (request.codingContext === undefined && request.sessionKey) {
      await this.deps.maybeAttachCodingContext(request.sessionKey, {
        cwd: request.cwd,
        projectTag: request.projectTag,
      });
    }
    const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
    const namespaceOverride = this.deps.resolveRecallNamespace(
      request.namespace,
      request.sessionKey,
      authenticatedPrincipal,
    );
    const namespace = namespaceOverride ?? this.deps.orchestrator.config.defaultNamespace;
    // Normalize mode early so that no_recall / invalid modes skip budget
    // accounting (Codex P1: budget recorded before mode validation).
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
    // Skip budget checks for modes that never perform a cross-namespace read.
    const modeSkipsBudget = mode === "no_recall";
    // Derive the full set of namespaces the orchestrator will actually search.
    // When no explicit override is provided, `recallNamespacesForPrincipal()` may
    // expand to shared / policy-default namespaces.  Budget must be checked
    // against every cross-namespace entry in the effective set so that omitting
    // `namespace` cannot bypass the limiter (Cursor/Codex review feedback).
    //
    const legacyRecallNamespaces = Array.isArray(this.deps.orchestrator.config.defaultRecallNamespaces)
      ? recallNamespacesForPrincipal(principal, this.deps.orchestrator.config)
      : [];
    const effectiveNamespaces = namespaceOverride
      ? [namespaceOverride]
      : profilePlan
        ? expandScopeProfileReadNamespaces({
            profilePlan,
            principalSelfNamespace: profilePlan.baseNamespace,
            config: this.deps.orchestrator.config,
            principal,
            codingOverlay: profileCodingOverlay,
            legacyRecallNamespaces,
          })
        : legacyRecallNamespaces;
    const budgetPrincipalNamespace = profilePlan?.baseNamespace ?? principalNamespace;
    let budgetDecision: BudgetDecision;
    let recordBudgetAfterSuccess = false;
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
      // Peek at every effective namespace to determine whether ANY would be
      // cross-namespace WITHOUT recording side effects (Cursor review:
      // multi-count bug).  Record a single budget event only when at least
      // one effective namespace differs from the principal's self namespace,
      // and only after recall succeeds so retried transient failures do not
      // consume budget multiple times before a successful response can be
      // cached behind the request idempotency key.
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
        // The peek projected a denial — deny without recording so the
        // bucket is not inflated by rejected attempts.
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
        recordBudgetAfterSuccess = true;
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
      // Prune expired principal buckets to prevent unbounded Map growth from
      // high-cardinality / transient principals (Codex P2 review feedback).
      this.deps.budget.gc();
    }
    const topK = Number.isFinite(request.topK) ? Math.max(0, Math.floor(request.topK ?? 0)) : undefined;
    // Issue #680 — historical recall pin.  Validate at the input
    // boundary so a malformed `asOf` is rejected with a structured
    // 400 instead of silently flooring at NaN inside the orchestrator
    // (CLAUDE.md rule 51, gotcha #51).  Empty / undefined is fine —
    // means "no pin".
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
    const recallOptions: RecallInvocationOptions = {
      namespace: namespaceOverride,
      topK,
      mode,
      ...(authenticatedPrincipal ? { principalOverride: authenticatedPrincipal } : {}),
      ...(asOf !== undefined ? { asOf } : {}),
      ...(request.includeLowConfidence === true ? { includeLowConfidence: true } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      // Only surface a real wait: an uncontended recall (queueWaitMs 0) omits
      // the field so recall-timings stays additive and byte-identical to the
      // pre-#1906 uncontended path (acceptance: "record queueWaitMs ~0 or omit").
      ...(typeof request.queueWaitMs === "number" && request.queueWaitMs > 0
        ? { queueWaitMs: request.queueWaitMs }
        : {}),
    };
    const startedAt = Date.now();
    const context = await this.deps.orchestrator.recall(query, request.sessionKey, recallOptions);
    const snapshot = request.sessionKey
      ? this.deps.orchestrator.lastRecall.get(request.sessionKey)
      : null;
    const effectiveNamespace = snapshot?.namespace
      ? this.deps.resolveNamespace(snapshot.namespace)
      : namespace;
    // Auto-escalation policy (issue #677 PR 4/4).  When the operator
    // configured `recallDisclosureEscalation: "auto"` AND the caller
    // did not explicitly choose a disclosure level AND recall produced
    // a low-confidence result set (proxied by fill ratio: results
    // returned / topK requested), we escalate the default `chunk`
    // shape to `section` so the LLM gets richer context to compensate
    // for ambiguous retrieval.  Manual mode and explicit caller
    // disclosure both bypass the policy.  Documented in
    // `recall-disclosure-escalation.ts` and unit-tested there.
    // Confidence-proxy denominator: priority order is
    //   1. `snapshot.budgetsApplied.appliedTopK` (ALWAYS wins) — this is
    //      the limit the orchestrator actually applied after planner /
    //      minimal-mode / section-cap narrowing.  Codex P1 rounds 2+3
    //      on #705 emphasize that even a caller's explicit `request.topK`
    //      is wrong when the orchestrator caps below it (e.g. topK=50
    //      but appliedTopK=3 makes a 2-hit recall actually 0.67, not
    //      0.04).
    //   2. The caller's explicit `topK` when the snapshot lacks
    //      `budgetsApplied` (early-return paths, error cases).
    //   3. Config `qmdMaxResults` as a last-resort fallback.
    // Floor at observed-results so the ratio stays in [0, 1] even if
    // any of the signals drifts below the actual hit count.
    const resultsReturned = snapshot?.memoryIds?.length ?? 0;
    const appliedTopK = snapshot?.budgetsApplied?.appliedTopK;
    const configMaxResults =
      typeof this.deps.orchestrator.config.qmdMaxResults === "number" &&
      Number.isFinite(this.deps.orchestrator.config.qmdMaxResults) &&
      this.deps.orchestrator.config.qmdMaxResults > 0
        ? this.deps.orchestrator.config.qmdMaxResults
        : 0;
    const topKDenominator =
      typeof appliedTopK === "number" &&
      Number.isFinite(appliedTopK) &&
      appliedTopK > 0
        ? Math.max(appliedTopK, resultsReturned)
        : typeof topK === "number" && topK > 0
          ? Math.max(topK, resultsReturned)
          : Math.max(configMaxResults, resultsReturned, 1);
    // When the recall produced no snapshot (sessionless / namespace
    // mismatch / early-return path), there is no confidence signal to
    // base escalation on.  Pass `undefined` so the helper takes its
    // `no-top-k-confidence` branch instead of computing 0/N=0 and
    // forcing auto-escalation on every sessionless caller (Codex P2
    // review on PR #705).
    const topKConfidence =
      snapshot && topKDenominator > 0
        ? Math.min(1, resultsReturned / topKDenominator)
        : undefined;
    const escalationDecision = decideDisclosureEscalation({
      mode: this.deps.orchestrator.config.recallDisclosureEscalation,
      threshold: this.deps.orchestrator.config.recallDisclosureEscalationThreshold,
      originalDisclosure: requestedDisclosure,
      callerProvidedDisclosure,
      topKConfidence,
    });
    const disclosure = escalationDecision.effective;
    // Gate the raw-excerpt LCM read with the SAME read-authorization namespace
    // `lcmSearch` + the in-prompt LCM sections use (#1505 thread 2f7), so
    // `disclosure: "raw"` never attaches `<principal>-project-*` overlay rows
    // when the principal can WRITE but not READ its self base (or
    // `defaultRecallNamespaces` omits `self`). Computed ONLY for raw disclosure:
    // it is the sole consumer, and resolving the overlay on every chunk/section
    // recall would be wasted work — keeping non-raw recall byte-for-byte
    // unchanged.
    // Trim the sessionKey to match what `orchestrator.recall(...)` already does
    // (`request.sessionKey?.trim() || undefined`) and what the x-ray raw-excerpt
    // path uses (cursor "Raw excerpt key not trimmed"). A whitespace-padded key
    // otherwise drives recall under one identity but resolves the raw-excerpt
    // overlay namespace + LCM `session_id` under a DIFFERENT (untrimmed) prefix,
    // so excerpts are gated/queried inconsistently with recall and the x-ray path.
    const trimmedSessionKey = request.sessionKey?.trim() || undefined;
    const rawExcerptNamespace =
      disclosure === "raw"
        ? this.deps.resolveRawExcerptReadNamespace(
            request.namespace,
            trimmedSessionKey,
            authenticatedPrincipal,
          )
        : undefined;
    // `undefined` for an IMPLICIT raw recall means NO readable LCM namespace
    // exists (restrictive `default` READ policy, no readable overlay/self) —
    // suppress excerpts rather than fall back to the write/overlay namespace the
    // read gate excludes (#1505 thread NBHWz). An EXPLICIT namespace always
    // resolves (or throws) above, so suppression only applies to the implicit
    // path.
    const hasExplicitNamespace =
      typeof request.namespace === "string" &&
      request.namespace.trim().length > 0;
    const rawExcerptsSuppressed =
      disclosure === "raw" &&
      !hasExplicitNamespace &&
      rawExcerptNamespace === undefined;
    // Ordered, read-authorized LCM read key SET (#1505 fallback unification) so
    // raw disclosure finds excerpts a branch-scoped session archived at
    // project/root scope — exactly as recall + `lcmSearch` do. Only with a
    // concrete sessionKey; already read-gated.
    const rawExcerptSessionIds =
      disclosure === "raw" && rawExcerptNamespace && trimmedSessionKey
        ? this.deps.resolveLcmReadSessionIds(
            request.namespace,
            rawExcerptNamespace,
            trimmedSessionKey,
            authenticatedPrincipal,
          )
        : undefined;
    let results = await this.deps.serializeRecallResults(snapshot, disclosure, {
      query,
      sessionKey: trimmedSessionKey,
      ...(rawExcerptNamespace ? { rawExcerptNamespace } : {}),
      ...(rawExcerptSessionIds !== undefined ? { rawExcerptSessionIds } : {}),
      ...(rawExcerptsSuppressed ? { rawExcerptsSuppressed } : {}),
    });

    // Tag filter (issue #689). Applied post-recall, post-serialization so
    // the actual frontmatter tags are already loaded onto each result. When
    // `tags` is absent or empty the filter is a no-op; an invalid `tagMatch`
    // throws via `parseTagMatch` (CLAUDE.md rule 51).
    const filterTags = normalizeTags(request.tags);
    let tagMatchMode: TagMatchMode | undefined;
    try {
      tagMatchMode = parseTagMatch(request.tagMatch);
    } catch (err) {
      throw new EngramAccessInputError(
        err instanceof Error ? err.message : String(err),
      );
    }
    let effectiveContext = context;
    if (filterTags && filterTags.length > 0) {
      const beforeIds = results.map((r) => r.id);
      const { results: admitted } = applyTagFilter(results, {
        tags: filterTags,
        tagMatch: tagMatchMode,
      });
      results = admitted;
      // Codex P1: `context` was generated by orchestrator.recall(...)
      // BEFORE the tag filter ran, so it can contain memories that don't
      // match the requested tags. Surfaces consuming `context` (the
      // prompt-injection string) would leak excluded content into the
      // LLM. When the filter actually drops any result, rebuild context
      // from the admitted set so excluded content is unreachable through
      // any field of the response. The rebuilt context concatenates each
      // admitted result's available text (full content at section/raw
      // disclosure, otherwise the preview) — a different wire format
      // than the orchestrator's native context, but a strict subset
      // safe to inject.
      const admittedIds = new Set(results.map((r) => r.id));
      const droppedAny = beforeIds.some((id) => !admittedIds.has(id));
      if (droppedAny) {
        effectiveContext = results
          .map((r) => {
            const content =
              typeof (r as { content?: unknown }).content === "string"
                ? ((r as { content?: string }).content ?? "")
                : "";
            const preview =
              typeof (r as { preview?: unknown }).preview === "string"
                ? ((r as { preview?: string }).preview ?? "")
                : "";
            return content || preview;
          })
          .filter((s) => s.length > 0)
          .join("\n\n");
      }
    }
    const filteredMemoryIds = filterTags && filterTags.length > 0
      ? results.map((r) => r.id)
      : (snapshot?.memoryIds ?? []);
    const debug = await this.deps.buildRecallDebug(
      snapshot,
      effectiveNamespace,
      request.includeDebug === true,
      request.sessionKey,
    );

    // Fire-and-forget audit recording. Must never block or crash recall.
    let auditAnomalies: AccessAuditResult["anomalies"] | undefined;
    if (this.deps.auditAdapter) {
      try {
        const resolvedAgentId = principal ?? "__anonymous__";
        const auditEntry = {
          ts: new Date().toISOString(),
          sessionKey: request.sessionKey ?? "",
          agentId: resolvedAgentId,
          trigger: "access-surface",
          queryText: query,
          candidateMemoryIds: snapshot?.memoryIds ?? [],
          // Audit must reflect what was actually injected, not what
          // recall produced before the tag filter. Using `context`
          // (pre-filter) overstates injectedChars and can leak content
          // from excluded memories into the audit summary (cursor
          // Medium on PR #712).
          summary: effectiveContext.slice(0, 200) || null,
          injectedChars: effectiveContext.length,
          toggleState: "enabled" as const,
          latencyMs: Date.now() - startedAt,
          plannerMode: snapshot?.plannerMode ?? mode,
          requestedMode: mode,
          fallbackUsed: snapshot?.fallbackUsed ?? false,
        };
        const auditResult = await this.deps.auditAdapter.record(
          resolvedAgentId || "__anonymous__",
          auditEntry,
        );
        auditAnomalies = auditResult.anomalies;
      } catch {
        // Audit failures must never crash the recall path.
      }
    }

    return {
      response: {
        query,
        sessionKey: request.sessionKey,
        namespace: effectiveNamespace,
        context: effectiveContext,
        count: filterTags && filterTags.length > 0
          ? results.length
          : (snapshot?.memoryIds.length ?? results.length),
        memoryIds: filteredMemoryIds,
        results,
        recordedAt: snapshot?.recordedAt,
        traceId: snapshot?.traceId,
        plannerMode: snapshot?.plannerMode ?? mode,
        fallbackUsed: snapshot?.fallbackUsed ?? false,
        sourcesUsed: snapshot?.sourcesUsed ?? [],
        disclosure,
        budgetsApplied: snapshot?.budgetsApplied,
        auditAnomalies,
        budgetWarning: budgetDecision.reason === "warn-over-soft" ? budgetDecision : undefined,
        latencyMs: snapshot?.latencyMs ?? (Date.now() - startedAt),
        debug,
      },
      budgetRecordPrincipal: recordBudgetAfterSuccess ? principal : null,
    };
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
      // Match the CLI contract (CLAUDE.md rule 51): reject empty
      // input with an explicit error rather than silently producing
      // an empty snapshot.
      throw new Error("recallXray: query is required and must be non-empty");
    }
    // Validate disclosure UP FRONT — before recall executes, before
    // the xray queue mutex is acquired, before namespace resolution.
    // A bad value should fail fast rather than after we've burned
    // cycles on an irreversible recall (Cursor Medium review on PR
    // #699).
    if (
      request.disclosure !== undefined &&
      !isRecallDisclosure(request.disclosure)
    ) {
      throw new EngramAccessInputError(
        `recallXray: disclosure must be one of: chunk, section, raw (got: ${String(request.disclosure)})`,
      );
    }

    const namespacesEnabled = resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces;
    const requestedNamespace = request.namespace?.trim()
      ? this.deps.resolveNamespace(request.namespace)
      : undefined;
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
      // Namespaces enabled but no identity supplied — reject rather
      // than scanning the global namespace (CLAUDE.md rule 48:
      // least-privileged default).
      return { snapshotFound: false };
    }

    // Optional `--budget` override must be a positive integer.  Invalid
    // values throw rather than silently defaulting (CLAUDE.md rule 51).
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

    // Reset when the orchestrator-owned snapshot lock is actually acquired so
    // queue wait is not misreported as recall latency.
    let recallStartedAt = Date.now();

    const recallSessionKey = request.sessionKey?.trim() || undefined;
    let xrayResponse: {
      snapshotFound: boolean;
      snapshot?: RecallXraySnapshot;
    } = { snapshotFound: false };

    {
      // Capture through the orchestrator-owned critical section so every
      // consumer of its mutable snapshot slot shares the same queue. The
      // returned clone remains owned by this call after the lock is released.
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
          // When the caller supplies an authenticated principal, forward
          // it via the dedicated override channel so orchestrator-side
          // ACL decisions use the SAME principal the access-surface
          // pre-check above authorized.  Threading an
          // `authenticatedPrincipal` through `sessionKey` would be wrong:
          // `resolvePrincipal(sessionKey)` only maps configured raw
          // session keys and otherwise collapses to `"default"`, which
          // in namespace-enabled deployments produces false denials /
          // wrong-scope serving despite the pre-check passing
          // (CLAUDE.md rule 42).
          ...(authenticatedPrincipal
            ? { principalOverride: authenticatedPrincipal }
            : {}),
          ...(request.currentContextScopes !== undefined
            ? { currentContextScopes: request.currentContextScopes }
            : {}),
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        },
      );
      recallStartedAt = capturedRecallStartedAt;
      // Cancellation covers queueing + recall/capture. Post-capture shaping is
      // intentionally not wired for mid-I/O abort in this change, but do not
      // begin that work after the caller has already canceled.
      throwIfAborted(request.abortSignal, "recall X-ray aborted before postprocessing");
      // Re-check namespace after capture: the recall may have served
      // from a different namespace than the caller requested.  Drop
      // the snapshot rather than leak cross-tenant data (CLAUDE.md
      // rules 42 + 47).  The comparison is strict so a snapshot whose
      // namespace is `undefined` cannot bypass the scope the caller
      // asked for.
      const namespaceMismatch =
        requestedNamespace !== undefined &&
        rawSnapshot?.namespace !== requestedNamespace;
      if (!rawSnapshot) {
        xrayResponse = { snapshotFound: false };
      } else if (namespaceMismatch) {
        xrayResponse = { snapshotFound: false };
      } else {
        // Tag filter (issue #689). Mirrors `recall()` semantics — applied
        // post-capture by reading each result's frontmatter tags and
        // dropping non-matching results. Filter activity surfaces as a
        // `tag-filter` entry in `snapshot.filters` so X-ray consumers can
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
                // Normalize identically to the recall path
                // (`normalizeProjectionTags`): trim and drop empty strings
                // so X-ray tag matching stays consistent with the recall
                // surface. Without this, a frontmatter tag like " draft "
                // would match in recall but not in X-ray (cursor review).
                return Array.isArray(t) ? normalizeProjectionTags(t) : [];
              } catch {
                return [];
              }
            }),
          );
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
        // Decorate per-result disclosure + token estimate when the caller
        // wired a depth knob (issue #677 PR 3/4 — codex review on #699
        // flagged that the renderer's per-disclosure summary stays empty
        // until callers populate these fields).  Estimate tokens from
        // the actual rendered payload at the requested depth so the
        // summary reflects real spend; chunk uses the preview, section
        // and raw use full content.  Best-effort only — a missing
        // memory or read failure is silently dropped (CLAUDE.md rule 13).
        if (request.disclosure !== undefined) {
          // Disclosure already validated up front; pin to the narrowed
          // type here.  Re-validation inside the queue would be dead code.
          const disclosure: RecallDisclosure = request.disclosure;
          const namespace = snapshot.namespace
            ? this.deps.resolveNamespace(snapshot.namespace)
            : this.deps.orchestrator.config.defaultNamespace;
          // Pre-fetch raw excerpts ONCE so the first raw-disclosure
          // result's token estimate includes the LCM-side excerpt spend
          // that `shapeMemorySummary` actually attaches in the recall
          // response.  Without this, raw recalls systematically
          // undercounted spend on the first result (Cursor Medium review
          // on PR #699).  Excerpts are scoped to the same session +
          // namespace as the recall.
          // Trim sessionKey to match what `orchestrator.recall(...)`
          // already does (`request.sessionKey?.trim() || undefined`),
          // otherwise a whitespace-padded key drives recall under one
          // identity but probes LCM under a different prefix and
          // misses stored excerpts (Cursor Low review on PR #699).
          const trimmedSessionKey = request.sessionKey?.trim() || undefined;
          // Read-authorization-gated namespace for the raw-excerpt LCM lookup
          // (#1505 thread 2f7). NOT `snapshot.namespace` (the write/overlay
          // namespace), which would attach `<principal>-project-*` overlay rows
          // when the principal can WRITE but not READ its self base. Mirrors the
          // recall + `lcmSearch` read gate. Resolved ONLY for raw disclosure (its
          // sole consumer); the `namespace` above is still used for the
          // memory-FILE reads below (a separate, snapshot-scoped read), so non-raw
          // x-ray decoration stays byte-for-byte unchanged.
          const rawExcerptNamespace =
            disclosure === "raw"
              ? this.deps.resolveRawExcerptReadNamespace(
                  request.namespace,
                  trimmedSessionKey,
                  authenticatedPrincipal,
                )
              : namespace;
          // `undefined` for an IMPLICIT raw recall means NO readable LCM namespace
          // exists (restrictive `default` READ policy, no readable overlay/self)
          // — suppress excerpts rather than fall back to the write/overlay
          // namespace the read gate excludes (#1505 thread NBHWz).
          const xrayHasExplicitNamespace =
            typeof request.namespace === "string" &&
            request.namespace.trim().length > 0;
          const rawExcerptsSuppressed =
            disclosure === "raw" &&
            !xrayHasExplicitNamespace &&
            rawExcerptNamespace === undefined;
          // Ordered, read-authorized LCM read key SET (#1505 fallback
          // unification) so raw disclosure finds excerpts a branch-scoped session
          // archived at project/root scope — exactly as recall + `lcmSearch` do.
          // Only meaningful with a concrete sessionKey + a readable namespace;
          // already read-gated so no unauthorized overlay key is present.
          const rawExcerptSessionIds =
            disclosure === "raw" && trimmedSessionKey && rawExcerptNamespace
              ? this.deps.resolveLcmReadSessionIds(
                  request.namespace,
                  rawExcerptNamespace,
                  trimmedSessionKey,
                  authenticatedPrincipal,
                )
              : undefined;
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
          const firstReadableIndex = memoryByIndex.findIndex((m) => m !== null);
          const baseDir =
            (await this.deps.orchestrator.getStorage(namespace)).dir;
          const decorated = snapshot.results.map((result, index) => {
            const memory = memoryByIndex[index];
            if (!memory) {
              // Unreadable result: attach the disclosure tag anyway so
              // the per-disclosure summary classifies it correctly,
              // but skip the token estimate since we don't have the
              // content to measure.  Without the disclosure tag the
              // result silently flows into the `unspecified` bucket
              // even though the caller explicitly requested a depth
              // (Cursor Low review on PR #699).
              return { ...result, disclosure };
            }
            // Build a representative shaped summary so the estimate
            // counts every field `shapeMemorySummary` actually emits.
            // The serialized JSON form is a close-enough proxy for the
            // wire payload size.
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
          // Edge case: every result was unreadable but rawExcerpts
          // still has content — credit that spend to result[0] rather
          // than dropping it on the floor.  Without this, the raw row
          // in the per-disclosure summary under-reports spend whenever
          // every memory file is missing/unreadable.
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
      // Same read-authorization-gated raw-excerpt namespace the recall path uses
      // (#1505 thread 2f7), so the includeRecall x-ray path can't leak overlay
      // transcript rows via raw disclosure. Resolved ONLY for raw disclosure (the
      // sole consumer) so non-raw x-ray recall stays byte-for-byte unchanged. The
      // ordered LCM read key SET (#1505 fallback unification) adds the coding read
      // fallbacks so a branch-scoped session also finds excerpts at project/root
      // scope.
      const xrayRawExcerptNamespace =
        disclosure === "raw"
          ? this.deps.resolveRawExcerptReadNamespace(
              request.namespace,
              recallSessionKey,
              authenticatedPrincipal,
            )
          : undefined;
      // `undefined` for an IMPLICIT raw recall means NO readable LCM namespace
      // exists — suppress excerpts rather than fall back to the write/overlay
      // namespace the read gate excludes (#1505 thread NBHWz).
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
      return {
        ...xrayResponse,
        recall: await this.deps.buildRecallResponseFromXraySnapshot({
          query,
          sessionKey: recallSessionKey,
          snapshot: xrayResponse.snapshot,
          disclosure,
          startedAt: recallStartedAt,
          requestedMode: request.mode,
          normalizedMode: mode,
          ...(xrayRawExcerptNamespace
            ? { rawExcerptNamespace: xrayRawExcerptNamespace }
            : {}),
          ...(xrayRawExcerptSessionIds !== undefined
            ? { rawExcerptSessionIds: xrayRawExcerptSessionIds }
            : {}),
          ...(xrayRawExcerptsSuppressed
            ? { rawExcerptsSuppressed: xrayRawExcerptsSuppressed }
            : {}),
        }),
      };
    }
    return xrayResponse;
  }
}
