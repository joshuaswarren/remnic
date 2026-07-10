/**
 * Access LCM read-surface (extracted from access-service.ts; god-file
 * decomposition, #1526 playbook: verbatim move + live selfDeps wiring).
 *
 * Owns the LCM archive read path of the access layer: lcmSearch and the
 * read-authorization resolution trio (LCM read namespace, raw-excerpt
 * read namespace, and the ordered read-authorized LCM session-id set,
 * #1495/#1505 read gates).
 */

import { resolveNamespaceCapabilities } from "./capabilities.js";
import { combineNamespaces, lcmSessionKeyForNamespace, resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import { log } from "./logger.js";
import { canWriteNamespace, defaultNamespaceForPrincipal, recallNamespacesForPrincipal } from "./namespaces/principal.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  EngramAccessInputError,
  type EngramAccessLcmSearchRequest,
  type EngramAccessLcmSearchResponse,
} from "./access-service.js";

export interface AccessLcmSurfaceDeps {
  lcmSessionIdsForNamespaces(namespaces: string[], sessionKey: string): string[];
  readonly orchestrator: Orchestrator;
  resolveImplicitLcmReadFallbackNamespace(
    principal: string | undefined,
  ): string | undefined;
  resolveLcmReadNamespace(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKeyForOverlay: string | undefined,
    authenticatedPrincipal: string | undefined,
    purpose?: "read" | "write",
  ): string;
  resolveLcmReadSessionIds(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined,
  ): string[];
  resolveLcmReadSessionKey(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined,
    purpose?: "read" | "write",
  ): string;
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  resolveRequestPrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string | undefined;
  resolveScopeProfileLcmReadNamespaces(
    sessionKey: string | undefined,
    authenticatedPrincipal: string | undefined,
  ): string[] | null;
}

export class AccessLcmSurface {
  constructor(
    private readonly deps: AccessLcmSurfaceDeps,
  ) {}

  async lcmSearch(request: EngramAccessLcmSearchRequest): Promise<EngramAccessLcmSearchResponse> {
    if (!request.query || typeof request.query !== "string" || request.query.trim().length === 0) {
      throw new EngramAccessInputError("query is required and must be a non-empty string");
    }

    const principal = this.deps.resolveRequestPrincipal(request.sessionKey, request.authenticatedPrincipal);
    const hasExplicitNamespace =
      typeof request.namespace === "string" &&
      request.namespace.trim().length > 0;
    // Resolve the readable base namespace WITHOUT pre-authorizing `default`
    // (#1505 thread NBHWz). An EXPLICIT namespace is still authorized strictly
    // via `resolveReadableNamespace` (explicit reads must pass the ACL — throws
    // on an unreadable explicit namespace). For an IMPLICIT read, derive the
    // fallback from the ALREADY read-authorized recall namespace set instead of
    // read-authorizing `config.defaultNamespace`: under a restrictive `default`
    // READ policy where the principal's self namespace is readable, normal recall
    // still succeeds via `recallNamespacesForPrincipal`, so `lcmSearch` must too
    // (the same defect class the raw-excerpt path fixes). `undefined` ⇒ no
    // readable LCM namespace exists, so return NO rows rather than throwing.
    const profileLcmReadNamespaces = hasExplicitNamespace
      ? null
      : this.deps.resolveScopeProfileLcmReadNamespaces(
          request.sessionKey,
          request.authenticatedPrincipal,
        );
    const namespace = hasExplicitNamespace
      ? this.deps.resolveReadableNamespace(request.namespace, principal)
      : profileLcmReadNamespaces !== null
        ? profileLcmReadNamespaces[0]
        : this.deps.resolveImplicitLcmReadFallbackNamespace(principal);

    if (!this.deps.orchestrator.lcmEngine || !this.deps.orchestrator.lcmEngine.enabled) {
      return {
        query: request.query,
        namespace: namespace ?? this.deps.orchestrator.config.defaultNamespace,
        results: [],
        count: 0,
        lcmEnabled: false,
      };
    }

    // An active scope profile with no readable layers is authoritative: search
    // no legacy/default LCM keys instead of falling back around the profile.
    if (profileLcmReadNamespaces !== null && profileLcmReadNamespaces.length === 0) {
      return {
        query: request.query,
        namespace: this.deps.orchestrator.config.defaultNamespace,
        results: [],
        count: 0,
        lcmEnabled: true,
      };
    }

    // No readable LCM namespace for an IMPLICIT read (restrictive `default` READ
    // policy, no readable overlay/self) ⇒ return NO rows instead of pre-
    // authorizing the denied default (#1505 thread NBHWz). Normal recall still
    // succeeds through the readable self namespace; LCM search degrades to empty.
    if (namespace === undefined) {
      return {
        query: request.query,
        namespace: this.deps.orchestrator.config.defaultNamespace,
        results: [],
        count: 0,
        lcmEnabled: true,
      };
    }

    const limit = Math.max(1, Math.min(request.limit ?? 10, 100));
    // Route the LCM read session_id AND prefix through the SAME overlay-aware
    // namespace `observe`'s write key and compaction use (#1505 round 3). A
    // project-scoped `observe` with no explicit namespace archived under the
    // coding-overlay namespace; deriving the prefix only from the readable
    // `namespace` (as before) would search the raw key and miss those turns.
    // The effective namespace is resolved ONCE from the real session
    // (`request.sessionKey`) — the prefix is a search fragment with no bound
    // coding context, so it inherits the same namespace. Collapses to the raw key
    // for single-store / no-overlay / explicit-default flows (existing behavior).
    const lcmReadNamespace = profileLcmReadNamespaces !== null
      ? profileLcmReadNamespaces[0] ?? this.deps.orchestrator.config.defaultNamespace
      : this.deps.resolveLcmReadNamespace(
          request.namespace,
          namespace,
          request.sessionKey,
          request.authenticatedPrincipal,
        );
    // Ordered, read-authorized LCM read key SET for a concrete `sessionKey`
    // (#1505 fallback unification + #1501 scope profiles). A branch-scoped
    // session whose rows were archived at project/root scope is found by querying
    // the primary overlay key first, then each fallback. When a scope profile is
    // active, the profile's expanded read namespace set is authoritative,
    // including the empty set.
    const lcmSessionKeyIds = request.sessionKey
      ? profileLcmReadNamespaces !== null
        ? this.deps.lcmSessionIdsForNamespaces(
            profileLcmReadNamespaces,
            request.sessionKey,
          )
        : this.deps.resolveLcmReadSessionIds(
            request.namespace,
            namespace,
            request.sessionKey,
            request.authenticatedPrincipal,
          )
      : [undefined];
    const lcmSessionPrefixes = request.sessionPrefix
      ? profileLcmReadNamespaces !== null && !request.sessionKey
        ? this.deps.lcmSessionIdsForNamespaces(
            profileLcmReadNamespaces,
            request.sessionPrefix,
          )
        : [
            lcmSessionKeyForNamespace(
              lcmReadNamespace,
              request.sessionPrefix,
              this.deps.orchestrator.config.defaultNamespace,
            ) ?? request.sessionPrefix,
          ]
      : [undefined];
    // SECURITY (#1495 P1 + codex P1 r2 "Require a scoped LCM filter before
    // archive searches"): a sessionless, prefixless `lcmSearch` issues
    // `searchContextFull(query, limit, undefined, undefined)`, an archive-wide
    // FTS scan over EVERY `session_id`, including the sentinel-framed
    // `<ns>`-scoped overlay/tenant rows. The LCM archive is keyed by the
    // `session_id` STRING and is NOT partitioned by namespace, so an unscoped
    // scan CANNOT be constrained to the caller's authorized namespace — neither
    // an explicit `namespace` nor a readable `default` confines its results to
    // rows the caller may read. The scan is therefore safe ONLY in single-store
    // mode (namespaces disabled, one shared archive owned by the caller). When
    // namespaces are ENABLED, an unscoped `lcmSearch` (no `sessionKey` AND no
    // `sessionPrefix`) must be SUPPRESSED — return EMPTY — regardless of an
    // explicit namespace or default-readability, so a caller authorized for
    // `default` (or for one explicit namespace) cannot read other namespaces'
    // transcript rows via the archive-wide scan (cross-tenant read leak). A
    // SCOPED call (sessionKey or sessionPrefix present) is unaffected: it carries
    // a namespace-framed `session_id` / prefix filter that already constrains the
    // search to the caller's authorized, read-gated namespace.
    const hasScopedSession =
      (typeof request.sessionKey === "string" &&
        request.sessionKey.length > 0) ||
      lcmSessionPrefixes.some((prefix) => typeof prefix === "string" && prefix.length > 0);
    if (!hasScopedSession && resolveNamespaceCapabilities(this.deps.orchestrator.config).namespaces === true) {
      return {
        query: request.query,
        namespace,
        results: [],
        count: 0,
        lcmEnabled: true,
      };
    }
    // Query each LCM read key in order, merging + deduping rows (by
    // sessionId+turnIndex) and preserving first-seen order, capped at `limit`.
    // Use allSettled so one corrupt/failed namespace key cannot discard sibling
    // results from other authorized profile namespaces.
    const seenRows = new Set<string>();
    const results: Array<{ sessionId: string; content: string; turnIndex: number }> = [];
    const lcmSearches: Array<{
      key: string | undefined;
      prefix: string | undefined;
      promise: Promise<Array<{ session_id: string; content: string; turn_index: number }>>;
    }> = [];
    for (const lcmSessionKey of lcmSessionKeyIds) {
      for (const lcmSessionPrefix of lcmSessionPrefixes) {
        lcmSearches.push({
          key: lcmSessionKey,
          prefix: lcmSessionPrefix,
          promise: this.deps.orchestrator.lcmEngine.searchContextFull(
            request.query,
            limit,
            lcmSessionKey,
            lcmSessionPrefix,
          ) as Promise<Array<{ session_id: string; content: string; turn_index: number }>>,
        });
      }
    }
    const settledSearches = await Promise.allSettled(
      lcmSearches.map((search) => search.promise),
    );
    for (let i = 0; i < settledSearches.length; i += 1) {
      if (results.length >= limit) break;
      const settled = settledSearches[i];
      if (!settled || settled.status === "rejected") {
        const failed = lcmSearches[i];
        log.warn(
          `lcmSearch: failed for key=${failed?.key ?? "<none>"} prefix=${failed?.prefix ?? "<none>"}: ${settled?.status === "rejected" ? settled.reason : "missing result"}`,
        );
        continue;
      }
      for (const r of settled.value) {
        const dedupeKey = `${r.session_id}\0${r.turn_index}`;
        if (seenRows.has(dedupeKey)) continue;
        seenRows.add(dedupeKey);
        results.push({
          sessionId: r.session_id,
          content: r.content,
          turnIndex: r.turn_index,
        });
        if (results.length >= limit) break;
      }
    }

    return {
      query: request.query,
      namespace,
      results,
      count: results.length,
      lcmEnabled: true,
    };
  }

  /**
   * Resolve the effective LCM NAMESPACE a same-session operation must prefix
   * with (the namespace half of {@link resolveLcmReadSessionKey}). Split out so
   * `lcmSearch` can apply ONE namespace to BOTH its `sessionKey` and its
   * `sessionPrefix` — the prefix is a search fragment, not a real session, so its
   * own coding context can't be looked up; it must inherit the namespace resolved
   * from the real session (`sessionKeyForOverlay`).
   *
   * `purpose` selects the AUTHORIZATION gate applied before honouring the
   * coding overlay (#1505 round 3 + round 4, codex P2):
   *
   *  - `"read"` (`lcmSearch` / raw-excerpt recall): the overlay rows are only
   *    visible when the principal SELF base is in the READABLE RECALL SET — the
   *    same gate the orchestrator's `lcmReadNamespaceForSession` and the recall
   *    namespace set use (`recallNamespacesForPrincipal`, gated by both
   *    `defaultRecallNamespaces.includes("self")` AND `canReadNamespace`). A
   *    caller that passed the default read check must NOT receive
   *    `<principal>-project-*` rows the policy never granted (cross-tenant read
   *    leak). When the self base is not readable, keep the just-authorized
   *    namespace (collapses to the raw key on the default store).
   *
   *  - `"write"` (`lcmCompactionFlush` / `lcmCompactionRecord`): these are
   *    write/maintenance operations on the SAME queue `observe` just wrote, so
   *    the gate must mirror observe's WRITE authorization (`canWriteNamespace`
   *    on the self base), NOT readability. A principal that can WRITE but not
   *    READ its self namespace (or whose `defaultRecallNamespaces` omits `self`)
   *    archived under the overlay key via `observe`; gating compaction by
   *    readability would fall back to the default/raw key and leave that queue
   *    never flushed/recorded (round-4 codex P2). Write-authorized ⇒ overlay
   *    key, matching the observe write key (rule 42 read/write parity; rule 39
   *    identical gates across paths).
   */
  resolveLcmReadNamespace(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKeyForOverlay: string | undefined,
    authenticatedPrincipal: string | undefined,
    purpose: "read" | "write" = "read",
  ): string {
    const hasExplicitNamespace =
      typeof explicitNamespace === "string" && explicitNamespace.trim().length > 0;
    if (hasExplicitNamespace) return resolvedNamespace;
    // Mirror observe's write resolution: use the coding-overlay namespace when
    // one applies, else the default store. NOT the principal self base — an
    // unqualified observe archives under the default store, so a self-base prefix
    // here would target a queue observe never wrote to (#1495).
    const principal = this.deps.resolveRequestPrincipal(
      sessionKeyForOverlay,
      authenticatedPrincipal,
    );
    const base = defaultNamespaceForPrincipal(principal, this.deps.orchestrator.config);
    const overlaid = this.deps.orchestrator.applyCodingNamespaceOverlay(
      sessionKeyForOverlay,
      base,
    );
    // No overlay → the default store (raw sessionKey), as before.
    if (overlaid === base) return this.deps.orchestrator.config.defaultNamespace;
    // Overlay applied. Authorize access to the principal's `<principal>-project-*`
    // overlay base before switching the LCM key to it. The gate differs by
    // operation purpose (see the doc comment): reads use the readable-recall-set
    // gate (no cross-tenant read leak), writes use observe's write authorization
    // (so compaction targets the same overlay queue observe wrote to).
    const authorized =
      purpose === "write"
        ? canWriteNamespace(principal, base, this.deps.orchestrator.config)
        : recallNamespacesForPrincipal(
            principal,
            this.deps.orchestrator.config,
          ).includes(base);
    if (authorized) return overlaid;
    // Unauthorized overlay base. For READS, collapse to the DEFAULT STORE (the
    // raw sessionKey) EXACTLY like the orchestrator's `lcmReadNamespaceForSession`
    // (rule 39 / 42) — NOT the caller's `resolvedNamespace`, which for an implicit
    // read can be a readable recall namespace (e.g. `shared`). Returning that
    // would prefix LCM reads with `shared:sessionKey` while in-prompt recall uses
    // the raw `sessionKey`, diverging `lcmSearch`/raw disclosure from orchestrator
    // LCM reads (cursor "LCM read gate wrong fallback"). For an explicit read the
    // method already returned at the top, so this only affects implicit reads.
    // The (currently unused) write purpose preserves its prior `resolvedNamespace`
    // fallback for backward compatibility.
    if (purpose === "read") return this.deps.orchestrator.config.defaultNamespace;
    return resolvedNamespace;
  }

  /**
   * Resolve the namespace the raw-disclosure excerpt lookup
   * ({@link fetchRawExcerpts}) must prefix its LCM `session_id` with (#1505
   * thread 2f7). Raw disclosure reads the SAME LCM archive `lcmSearch` and the
   * in-prompt LCM sections read, so it MUST pass through the identical
   * read-authorization gate — NOT `snapshot.namespace`, which records the
   * effective WRITE/overlay namespace (`<principal>-project-*`) even when the
   * principal can WRITE but not READ its self base (or `defaultRecallNamespaces`
   * omits `self`). Routing through `resolveLcmReadNamespace(..., "read")` makes
   * raw disclosure fall back to the default store exactly like normal recall +
   * `lcmSearch`, so it never attaches overlay transcript rows the read gate
   * excludes (cross-tenant read leak). Collapses to the default store / raw
   * sessionKey for single-store / no-overlay / explicit-default flows, so
   * single-user recall is byte-for-byte unchanged.
   *
   * Returns `undefined` when NO readable LCM namespace exists for an IMPLICIT
   * (no explicit `namespace`) raw recall — i.e. a restrictive `default` READ
   * policy denies the principal `default` AND no overlay/self namespace is
   * readable. In that case the caller emits NO excerpts rather than throwing
   * `namespace is not readable: default` (#1505 thread NBHWz): normal recall
   * still succeeds via `recallNamespacesForPrincipal`, so `disclosure: "raw"`
   * must degrade gracefully (empty excerpts), never pre-authorize `default`.
   *
   * IMPLICIT-namespace fallback selection derives from the ALREADY
   * read-authorized recall namespace set (`recallNamespacesForPrincipal` +
   * `canReadNamespace`) — the principal's self base when it is in the readable
   * recall set, else `config.defaultNamespace` ONLY when the principal may read
   * it. It NEVER pre-authorizes `default`. An EXPLICIT `namespace` is still
   * authorized strictly via `resolveReadableNamespace` (explicit reads must pass
   * the ACL — no behavior change).
   */
  resolveRawExcerptReadNamespace(
    explicitNamespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal: string | undefined,
  ): string | undefined {
    const principal = this.deps.resolveRequestPrincipal(
      sessionKey,
      authenticatedPrincipal,
    );
    const hasExplicitNamespace =
      typeof explicitNamespace === "string" &&
      explicitNamespace.trim().length > 0;
    if (hasExplicitNamespace) {
      // Explicit reads must pass the ACL — authorize strictly, exactly as
      // `lcmSearch` does (throws on an unreadable explicit namespace).
      const resolvedNamespace = this.deps.resolveReadableNamespace(
        explicitNamespace,
        principal,
      );
      return this.deps.resolveLcmReadNamespace(
        explicitNamespace,
        resolvedNamespace,
        sessionKey,
        authenticatedPrincipal,
        "read",
      );
    }
    // IMPLICIT raw recall: an active scope profile owns the same LCM read
    // namespace set used by recall and lcmSearch. Return the first profile
    // namespace as the legacy raw-excerpt namespace hint; the concrete ordered
    // key set is still produced by resolveLcmReadSessionIds(), which also treats
    // an empty profile read set as authoritative.
    const profileReadNamespaces = this.deps.resolveScopeProfileLcmReadNamespaces(
      sessionKey,
      authenticatedPrincipal,
    );
    if (profileReadNamespaces !== null) return profileReadNamespaces[0];

    // Otherwise derive the read fallback from the ALREADY read-authorized recall
    // namespace set — NEVER pre-authorize `default` (#1505 thread NBHWz). When
    // namespaces are disabled the default store is the only namespace and is
    // always readable (byte-for-byte single-user path).
    const fallbackNamespace =
      this.deps.resolveImplicitLcmReadFallbackNamespace(principal);
    // No readable LCM namespace at all ⇒ no excerpts (caller short-circuits).
    if (fallbackNamespace === undefined) return undefined;
    return this.deps.resolveLcmReadNamespace(
      explicitNamespace,
      fallbackNamespace,
      sessionKey,
      authenticatedPrincipal,
      "read",
    );
  }

  resolveLcmReadSessionIds(
    explicitNamespace: string | undefined,
    resolvedNamespace: string,
    sessionKey: string,
    authenticatedPrincipal: string | undefined,
  ): string[] {
    const primary = this.deps.resolveLcmReadSessionKey(
      explicitNamespace,
      resolvedNamespace,
      sessionKey,
      authenticatedPrincipal,
      "read",
    );
    const hasExplicitNamespace =
      typeof explicitNamespace === "string" &&
      explicitNamespace.trim().length > 0;
    // Explicit namespace → no overlay fallbacks (the overlay never applies to an
    // explicit read). Single key, unchanged.
    if (hasExplicitNamespace) return [primary];

    const profileReadNamespaces = this.deps.resolveScopeProfileLcmReadNamespaces(
      sessionKey,
      authenticatedPrincipal,
    );
    if (profileReadNamespaces !== null) {
      return this.deps.lcmSessionIdsForNamespaces(profileReadNamespaces, sessionKey);
    }

    const principal = this.deps.resolveRequestPrincipal(
      sessionKey,
      authenticatedPrincipal,
    );
    const base = defaultNamespaceForPrincipal(
      principal,
      this.deps.orchestrator.config,
    );
    const overlaid = this.deps.orchestrator.applyCodingNamespaceOverlay(
      sessionKey,
      base,
    );
    // No overlay → single default-store key, unchanged.
    if (overlaid === base) return [primary];
    // Overlay present but self base unreadable → the "read" gate already
    // collapsed `primary` to the default store; do NOT add overlay fallbacks
    // (they would be unauthorized `<principal>-project-*` keys). Single key.
    const selfReadableInRecall = recallNamespacesForPrincipal(
      principal,
      this.deps.orchestrator.config,
    ).includes(base);
    if (!selfReadableInRecall) return [primary];
    // Self base readable → overlay rows authorized. Append one LCM key per coding
    // read fallback (project → root), combined with the principal base for
    // isolation — the SAME ordered set the orchestrator recall path searches.
    const overlay = resolveCodingNamespaceOverlay(
      this.deps.orchestrator.getCodingContextForSession(sessionKey),
      this.deps.orchestrator.config.codingMode,
      this.deps.orchestrator.config.defaultNamespace,
    );
    const fallbackNamespaces = (overlay?.readFallbacks ?? []).map((fallback) =>
      combineNamespaces(base, fallback),
    );
    const out = [primary];
    const seen = new Set<string>([primary]);
    for (const ns of fallbackNamespaces) {
      const key =
        lcmSessionKeyForNamespace(
          ns,
          sessionKey,
          this.deps.orchestrator.config.defaultNamespace,
        ) ?? sessionKey;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }
}
