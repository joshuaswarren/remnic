import { canReadNamespace, defaultNamespaceForPrincipal } from "./namespaces/principal.js";
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
 * when the base collection must stay reachable, or `null` otherwise. ALL of:
 *
 *   - the default namespace is THIS principal's own self store — i.e. the
 *     principal has no dedicated namespace policy, so
 *     `defaultNamespaceForPrincipal` resolves to the configured default. On a
 *     multi-tenant scope-profile deployment every principal has its own
 *     policy; reaching into the default would read ANOTHER namespace, so the
 *     fallback must not fire (#2056 r2 / #1501 privateOnly);
 *   - the profile resolved `userGlobal` as a READABLE layer (not just listed
 *     it in `readOrder`). `serverShared` maps to `sharedNamespace`, not the
 *     default, and an unreadable resolved layer is a deliberate omission —
 *     neither may trigger this fallback (#2056 r2);
 *   - the profile's resolved self namespace is NOT already the default
 *     (otherwise it is already in the set);
 *   - the principal is authorized to read the default namespace.
 *
 * Pure and side-effect-free so callers can unit-test the decision directly.
 */
export function resolveMemorySearchDefaultFallback(options: {
  profilePlan: ResolvedScopeProfilePlan;
  config: PluginConfig;
  principal: string | undefined;
  /**
   * True only when the configured default namespace's storage root equals
   * `config.memoryDir` (the legacy flat-root layout), i.e. the bulk corpus
   * genuinely lives under the default namespace's base collection. This is
   * the explicit legacy-flat-root/migration signal — without it the fallback
   * must not fire, so a hosted scope-profile deployment (per-principal
   * self namespaces, default under `namespaces/<default>`) never reaches
   * into the default corpus (#2056 r4).
   */
  defaultAtFlatRoot: boolean;
}): string | null {
  const { profilePlan, config, principal, defaultAtFlatRoot } = options;
  // Defense-in-depth: principalSelfIsDefault is only ever true alongside
  // defaultAtFlatRoot on legacy flat-root deployments (a hosted scope-profile
  // principal with its own policy fails this even when default is at the flat
  // root). It is NOT redundant — it keeps a policy-having principal isolated
  // from the flat default corpus.
  const principalSelfIsDefault =
    defaultNamespaceForPrincipal(principal, config) === config.defaultNamespace;
  // readOrder must explicitly intend userGlobal (resolveScopeProfilePlan
  // always materializes a userGlobal layer even when readOrder omits it, so
  // the layer's presence alone is not consent), AND that layer must have
  // resolved readable (a listed-but-unreadable layer is a deliberate
  // omission). serverShared maps to sharedNamespace, not the default.
  const profileIntendsUserGlobal =
    profilePlan.profile.readOrder.includes("userGlobal");
  const userGlobalLayerReadable = profilePlan.layers.some(
    (layer) => layer.id === "userGlobal" && layer.readable && Boolean(layer.namespace),
  );
  const selfResolvedAwayFromDefault =
    profilePlan.baseNamespace !== config.defaultNamespace;
  if (
    defaultAtFlatRoot &&
    profileIntendsUserGlobal &&
    userGlobalLayerReadable &&
    principalSelfIsDefault &&
    selfResolvedAwayFromDefault &&
    canReadNamespace(principal, config.defaultNamespace, config)
  ) {
    return config.defaultNamespace;
  }
  return null;
}

/**
 * Issue #2018 r4: the explicit legacy-flat-root signal — the configured
 * default namespace's storage root equals `config.memoryDir`. Resolved from
 * storage (not inferred from config/policy shape) so a hosted scope-profile
 * deployment never reaches into the default corpus.
 */
export async function defaultNamespaceAtFlatRoot(
  getStorage: (namespace: string) => Promise<{ dir: string }>,
  config: { defaultNamespace: string; memoryDir: string },
): Promise<boolean> {
  const storage = await getStorage(config.defaultNamespace);
  return storage.dir === config.memoryDir;
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
