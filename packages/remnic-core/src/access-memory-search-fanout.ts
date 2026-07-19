import { canReadNamespace } from "./namespaces/principal.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { log } from "./logger.js";
import type { SearchDegradation, SearchExecutionOptions } from "./search/port.js";
import type { PluginConfig } from "./types.js";

/**
 * Issue #2018: `memory_search` has no sessionKey, so — unlike recall — it
 * cannot resolve a coding overlay. With scope profiles active and no overlay,
 * `expandScopeProfileReadNamespaces` derives a per-principal self namespace.
 * On a legacy flat-root deployment the corpus still lives under the configured
 * DEFAULT namespace's base collection, which that derived set excludes, so
 * every query silently returned 0.
 *
 * Returns the configured default namespace to merge into the profile read set
 * when the base collection must stay reachable, or `null` when a deliberately
 * narrow profile (#1501 project-only lockdown) or the read ACL says otherwise.
 *
 * Conditions for including the default namespace:
 *   - the profile intends a global/shared read layer (`readOrder` includes
 *     `userGlobal` or `serverShared`), so a project-only lockdown is honored;
 *   - the profile resolved the principal's self namespace AWAY from the
 *     configured default (otherwise it is already in the set);
 *   - the principal is authorized to read the default namespace.
 *
 * Pure and side-effect-free so callers can unit-test the decision directly.
 */
export function resolveMemorySearchDefaultFallback(options: {
  profilePlan: ResolvedScopeProfilePlan;
  config: PluginConfig;
  principal: string | undefined;
}): string | null {
  const { profilePlan, config, principal } = options;
  const profileAllowsGlobalLayer =
    profilePlan.profile.readOrder.includes("userGlobal") ||
    profilePlan.profile.readOrder.includes("serverShared");
  const selfResolvedAwayFromDefault =
    profilePlan.baseNamespace !== config.defaultNamespace;
  if (
    profileAllowsGlobalLayer &&
    selfResolvedAwayFromDefault &&
    canReadNamespace(principal, config.defaultNamespace, config)
  ) {
    return config.defaultNamespace;
  }
  return null;
}

/**
 * Merge the {@link resolveMemorySearchDefaultFallback} result into a profile
 * read-namespace set without duplicates. Returns the original set unchanged
 * when no fallback applies.
 */
export function mergeMemorySearchDefaultFallback(
  profileNamespaces: string[],
  fallback: string | null,
): string[] {
  if (!fallback || profileNamespaces.includes(fallback)) return profileNamespaces;
  return [...profileNamespaces, fallback];
}


/**
 * Run a memory_search namespace fanout with the observability required by
 * issue #2018: a silent empty fanout is surfaced as a warning (never silently
 * empty), and per-namespace backend degradations — which memory_search
 * previously swallowed — are collected and warned so a missing collection
 * looks different from a genuine no-matches.
 *
 * `search` is injected so this stays free of the orchestrator type.
 */
export async function runMemorySearchFanout<TResult>(options: {
  query: string;
  namespaces: string[];
  maxResults?: number;
  principal?: string;
  requestedNamespace?: string;
  collection?: string;
  search(params: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    mode: "search";
    execution: SearchExecutionOptions;
  }): Promise<TResult[]>;
}): Promise<TResult[]> {
  const { query, namespaces, maxResults, principal, requestedNamespace, collection } = options;
  if (namespaces.length === 0) {
    log.warn("memory_search resolved zero readable namespaces", {
      principal: principal ?? null,
      requestedNamespace: requestedNamespace ?? null,
      collection: collection ?? null,
    });
    return [];
  }
  log.debug("memory_search fanout", {
    principal: principal ?? null,
    namespaces,
    collection: collection ?? null,
  });
  const degradations: SearchDegradation[] = [];
  const results = await options.search({
    query,
    namespaces,
    maxResults,
    mode: "search",
    execution: {
      onDegradation: (degradation) => degradations.push(degradation),
    },
  });
  if (degradations.length > 0) {
    log.warn("memory_search backend degradation", {
      principal: principal ?? null,
      degradations,
    });
  }
  return results;
}
