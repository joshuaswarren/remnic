import { canReadNamespace, defaultNamespaceForPrincipal } from "./namespaces/principal.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { EngramAccessInputError } from "./access-errors.js";
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
 * The flat-root signal is resolved lazily via {@link defaultAtFlatRootProvider}
 * — the provider is only invoked once the cheap gates (readOrder consent,
 * resolved-layer readability, principal-self, self-resolved-away, ACL) all
 * pass, so a project-only / serverShared-only / unreadable-userGlobal
 * profile never touches the default store (#2056 r6).
 */
export async function resolveMemorySearchDefaultFallback(options: {
  profilePlan: ResolvedScopeProfilePlan;
  config: PluginConfig;
  principal: string | undefined;
  /**
   * True only when the configured default namespace's storage root equals
   * `config.memoryDir` (the legacy flat-root layout). Invoked ONLY after the
   * cheap gates pass, so ineligible profiles never probe the default store.
   */
  defaultAtFlatRootProvider: () => Promise<boolean>;
}): Promise<string | null> {
  const { profilePlan, config, principal } = options;
  // Defense-in-depth: principalSelfIsDefault is only ever true alongside a
  // flat-root default on legacy deployments (a hosted scope-profile principal
  // with its own policy fails this even when default is at the flat root). It
  // is NOT redundant — it keeps a policy-having principal isolated from the
  // flat default corpus.
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
    !(
      profileIntendsUserGlobal &&
      userGlobalLayerReadable &&
      principalSelfIsDefault &&
      selfResolvedAwayFromDefault &&
      canReadNamespace(principal, config.defaultNamespace, config)
    )
  ) {
    // Cheap gates failed — never probe the default store.
    return null;
  }
  const defaultAtFlatRoot = await options.defaultAtFlatRootProvider();
  return defaultAtFlatRoot ? config.defaultNamespace : null;
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
  mode?: "search" | "hybrid" | "bm25" | "vector";
  search(params: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    mode: "search" | "hybrid" | "bm25" | "vector";
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
    mode: options.mode ?? "search",
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

/**
 * Resolve results for a FLAT corpus (namespaces disabled).
 *
 * An explicit ranking mode routes through the namespace-aware search even
 * here, because that is the only path honoring it; the legacy direct-QMD calls
 * stay the default so nothing else moves.
 */
export async function runFlatCorpusMemorySearch<TResult>(options: {
  query: string;
  maxResults?: number;
  collection?: string;
  mode?: "search" | "hybrid" | "bm25" | "vector";
  searchAcrossNamespaces(params: {
    query: string;
    maxResults?: number;
    mode: "search" | "hybrid" | "bm25" | "vector";
  }): Promise<TResult[]>;
  searchGlobal(query: string, maxResults?: number): Promise<TResult[]>;
  search(query: string, collection: string | undefined, maxResults?: number): Promise<TResult[]>;
}): Promise<TResult[]> {
  const { query, maxResults, collection, mode } = options;
  if (mode) {
    // The mode-aware backend has no collection selector on a flat corpus, so
    // honoring the mode would silently search the default collection instead
    // of the requested one. Reject the combination rather than return
    // unrelated results (AGENTS.md pattern 39).
    if (collection) {
      throw new EngramAccessInputError(
        `mode is not supported together with collection on a flat corpus (got collection: ${collection})`,
      );
    }
    return options.searchAcrossNamespaces({ query, maxResults, mode });
  }
  return collection === "global"
    ? options.searchGlobal(query, maxResults)
    : options.search(query, collection, maxResults);
}

/**
 * Lower bound on the candidate ceiling for one generic memory search.
 *
 * The ceiling is a backend-safety bound, NOT a stand-in for corpus exhaustion:
 * the loop keeps doubling while the backend still returns full pages, so a
 * long run of excluded artifacts cannot make it give up early and report a
 * thin page. Only a short page (nothing left) or a satisfied budget ends it
 * sooner.
 */
const MEMORY_SEARCH_CANDIDATE_FLOOR = 1_000;

/**
 * The safety bound for one search, which must always sit ABOVE the caller's
 * budget: a fixed ceiling at or below it would stop the loop before a single
 * excluded hit could be replaced, so a request for 2000 with one artifact in
 * the first page would return 1999.
 */
function candidateCeiling(budget: number): number {
  return Math.max(MEMORY_SEARCH_CANDIDATE_FLOOR, budget * 4);
}

/**
 * Run a ranked memory search and apply the generic-recall path exclusions
 * BEFORE the user-facing cap.
 *
 * Artifact isolation is a retrieval contract, not a ranking preference:
 * artifacts flow only through the dedicated verbatim path. Filtering after the
 * backend's own cap would let a handful of top-ranked artifacts shrink - or
 * empty - a page that has valid memories right behind them, so the search runs
 * with candidate headroom and tops up until the post-filter budget is met or
 * the corpus is exhausted.
 */
export async function searchWithGenericExclusion<TResult extends { path: string }>(options: {
  budget: number;
  /**
   * `false` omits `maxResults` on the FIRST request, so a caller that named no
   * budget keeps the backend's own page size on the wire; the resolved budget
   * is still what the filtered page is measured against.
   */
  sendInitialLimit: boolean;
  search(limit: number | undefined): Promise<TResult[]>;
  isExcluded(memoryPath: string): boolean;
}): Promise<TResult[]> {
  const { budget } = options;
  if (budget <= 0) return [];
  let results: TResult[] = [];
  let limit: number | undefined = options.sendInitialLimit ? budget : undefined;
  for (;;) {
    const raw = await options.search(limit);
    results = raw.filter((hit) => !options.isExcluded(hit.path));
    if (results.length >= budget) break;
    // What the backend actually served this round: its own page size when we
    // named no limit.
    const served = limit ?? raw.length;
    // A short page means the corpus is exhausted - asking for more is wasted
    // work that returns the same rows.
    if (raw.length === 0 || raw.length < served) break;
    const ceiling = candidateCeiling(budget);
    if (served >= ceiling) break;
    limit = Math.min(served * 2, ceiling);
  }
  return results.slice(0, budget);
}

/**
 * The whole ranked memory-search path behind `POST /engram/v1/memories/search`
 * and the `memory_search` tool: pick the flat-corpus or namespace-aware
 * backend, then apply generic-recall exclusions before the caller's cap.
 */
export async function runScopedMemorySearch(options: {
  query: string;
  budget: number;
  /** `false` when the caller named no `maxResults`; see the helper below. */
  sendInitialLimit: boolean;
  /**
   * Authorize the scope. Runs BEFORE any budget decision so a zero budget - a
   * valid empty search - can never skip the namespace/principal gate and turn
   * an access error into a successful empty result.
   */
  authorizeScope(): Promise<void> | void;
  collection?: string;
  mode?: "search" | "hybrid" | "bm25" | "vector";
  namespacesEnabled: boolean;
  isExcluded(memoryPath: string): boolean;
  flatCorpus(
    limit: number | undefined,
  ): Promise<Array<{ path: string; score: number; snippet?: string }>>;
  namespaced(
    limit: number | undefined,
  ): Promise<Array<{ path: string; score: number; snippet?: string }>>;
}): Promise<Array<{ path: string; score: number; snippet: string }>> {
  await options.authorizeScope();
  const results = await searchWithGenericExclusion({
    budget: options.budget,
    sendInitialLimit: options.sendInitialLimit,
    isExcluded: options.isExcluded,
    search: (limit) =>
      options.namespacesEnabled ? options.namespaced(limit) : options.flatCorpus(limit),
  });
  return results.map((hit) => ({
    path: hit.path,
    score: hit.score,
    snippet: (hit.snippet ?? "").slice(0, 800),
  }));
}

/** Everything the ranked memory-search surface needs from the service. */
export interface ScopedMemorySearchDeps {
  namespacesEnabled: boolean;
  defaultBudget: number;
  isExcluded(memoryPath: string): boolean;
  /** Flat-corpus authorization; throws when the namespace is unreadable. */
  authorizeFlatCorpus(namespace: string | undefined, principal: string | undefined): void;
  /** Namespace-aware authorization; throws, else returns the search fan-out. */
  authorizeNamespaces(
    namespace: string | undefined,
    principal: string | undefined,
    collection: string | undefined,
  ): Promise<string[]>;
  searchAcrossNamespaces(params: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
  }): Promise<Array<{ path: string; score: number; snippet?: string }>>;
  searchGlobal(
    query: string,
    maxResults?: number,
  ): Promise<Array<{ path: string; score: number; snippet?: string }>>;
  search(
    query: string,
    collection?: string,
    maxResults?: number,
  ): Promise<Array<{ path: string; score: number; snippet?: string }>>;
}

/** The whole `memory_search` surface: validate, authorize, search, shape. */
export async function memorySearchThroughScope(
  deps: ScopedMemorySearchDeps,
  request: {
    query: string;
    namespace?: string;
    maxResults?: number;
    collection?: string;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    principal?: string;
  },
): Promise<{
  query: string;
  results: Array<{ path: string; score: number; snippet: string }>;
  count: number;
}> {
  const { query, namespace, maxResults, mode, principal } = request;
  const collection = request.collection?.trim();
  if (request.collection !== undefined && !collection) {
    throw new EngramAccessInputError("collection must be a non-empty string");
  }
  let searchNamespaces: string[] = [];
  const results = await runScopedMemorySearch({
    query, collection, mode,
    namespacesEnabled: deps.namespacesEnabled,
    isExcluded: deps.isExcluded,
    budget: maxResults ?? deps.defaultBudget,
    sendInitialLimit: maxResults !== undefined,
    authorizeScope: async () => {
      if (!deps.namespacesEnabled) return deps.authorizeFlatCorpus(namespace, principal);
      searchNamespaces = await deps.authorizeNamespaces(namespace, principal, collection);
    },
    flatCorpus: (limit) =>
      runFlatCorpusMemorySearch({
        query, maxResults: limit, collection, mode,
        searchAcrossNamespaces: (p) => deps.searchAcrossNamespaces(p),
        searchGlobal: (q, globalLimit) => deps.searchGlobal(q, globalLimit),
        search: (q, coll, searchLimit) => deps.search(q, coll, searchLimit),
      }),
    namespaced: (limit) =>
      runMemorySearchFanout({
        query, maxResults: limit, principal, collection, mode,
        requestedNamespace: namespace,
        namespaces: searchNamespaces,
        search: (p) => deps.searchAcrossNamespaces(p),
      }),
  });
  return { query, results, count: results.length };
}
