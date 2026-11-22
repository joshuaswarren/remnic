
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { combineNamespaces, lcmSessionKeyForNamespace, resolveCodingNamespaceOverlay } from "./coding/coding-namespace.js";
import { log } from "./logger.js";
import { lcmEvidenceIdentity } from "./lcm/evidence-identity.js";
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

    if (profileLcmReadNamespaces !== null && profileLcmReadNamespaces.length === 0) {
      return {
        query: request.query,
        namespace: this.deps.orchestrator.config.defaultNamespace,
        results: [],
        count: 0,
        lcmEnabled: true,
      };
    }

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
    const lcmReadNamespace = profileLcmReadNamespaces !== null
      ? profileLcmReadNamespaces[0] ?? this.deps.orchestrator.config.defaultNamespace
      : this.deps.resolveLcmReadNamespace(
          request.namespace,
          namespace,
          request.sessionKey,
          request.authenticatedPrincipal,
        );
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
    const seenRows = new Set<string>();
    const results: Array<{ sessionId: string; content: string; turnIndex: number }> = [];
    const lcmSearches: Array<{
      key: string | undefined;
      prefix: string | undefined;
      promise: Promise<
        Array<{
          id?: number;
          session_id: string;
          content: string;
          turn_index: number;
        }>
      >;
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
          ) as Promise<
            Array<{
              id?: number;
              session_id: string;
              content: string;
              turn_index: number;
            }>
          >,
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
        const dedupeKey = lcmEvidenceIdentity(r, r.session_id).id;
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
    const principal = this.deps.resolveRequestPrincipal(
      sessionKeyForOverlay,
      authenticatedPrincipal,
    );
    const base = defaultNamespaceForPrincipal(principal, this.deps.orchestrator.config);
    const overlaid = this.deps.orchestrator.applyCodingNamespaceOverlay(
      sessionKeyForOverlay,
      base,
    );
    if (overlaid === base) return this.deps.orchestrator.config.defaultNamespace;
    const authorized =
      purpose === "write"
        ? canWriteNamespace(principal, base, this.deps.orchestrator.config)
        : recallNamespacesForPrincipal(
            principal,
            this.deps.orchestrator.config,
          ).includes(base);
    if (authorized) return overlaid;
    if (purpose === "read") return this.deps.orchestrator.config.defaultNamespace;
    return resolvedNamespace;
  }

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
    const profileReadNamespaces = this.deps.resolveScopeProfileLcmReadNamespaces(
      sessionKey,
      authenticatedPrincipal,
    );
    if (profileReadNamespaces !== null) return profileReadNamespaces[0];

    const fallbackNamespace =
      this.deps.resolveImplicitLcmReadFallbackNamespace(principal);
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
    if (overlaid === base) return [primary];
    const selfReadableInRecall = recallNamespacesForPrincipal(
      principal,
      this.deps.orchestrator.config,
    ).includes(base);
    if (!selfReadableInRecall) return [primary];
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
