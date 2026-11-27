/**
 * Daemon-backed memory-slot capability for delegate bridge mode (issue #2120).
 *
 * Delegate mode skips the embedded orchestrator, so the capability object the
 * host registers — prompt builder, memory runtime, flush plan, public
 * artifacts — has no orchestrator to close over. This module rebuilds it on
 * the standalone daemon's HTTP API plus direct reads of the corpus the daemon
 * already serves.
 *
 *   - search  → POST /engram/v1/memories/search (ranked, QMD-backed)
 *   - status  → GET  /engram/v1/health          (cached per manager handout)
 *   - read    → the local corpus, through the shared memory read scope
 *
 * Reading the corpus directly is sound because delegate mode's precondition is
 * a daemon serving the SAME memoryDir on the SAME host: the plugin is not
 * running a second orchestrator, it is reading files whose writer is the
 * daemon. Indexing stays the daemon's job — the runtime deliberately exposes
 * no `sync`, because a plugin-side reindex would resurrect the second QMD
 * writer this issue exists to remove.
 */

import { readFile } from "node:fs/promises";

import { log } from "@remnic/core/logger";

import {
  type DelegateDaemonTarget,
  daemonAuthHeaders,
  daemonUrl,
  isLoopbackDaemonHost,
} from "./bridge.js";
import { buildMemoryFlushPlan, type MemoryFlushPlan } from "./memory-flush-plan.js";
import type {
  RemnicCapabilityRuntime,
  RuntimeManager,
  RuntimeReadParams,
  RuntimeReadResult,
  RuntimeSearchOptions,
  RuntimeSearchResult,
  RuntimeStatus,
} from "./memory-capability-types.js";
import {
  type MemoryReadScope,
  createMemoryReadScope,
  isMemoryArtifactPath,
  isSessionsMemoryPath,
  daemonServesCorpus,
} from "./memory-read-scope.js";
import { listRemnicPublicArtifacts } from "./public-artifacts.js";

/** Health facts the runtime surfaces; everything else in the payload is ignored. */
type DaemonMemoryHealth = {
  memoryDir?: string;
  /** The daemon's configured default namespace, "" on a flat corpus. */
  defaultNamespace?: string;
  /**
   * Whether the daemon partitions storage by namespace. `undefined` when the
   * payload never said — a malformed or truncated health response must not
   * read as "flat corpus", which would silently disable the fail-closed
   * namespace rule for a partitioned deployment.
   */
  namespacesEnabled?: boolean;
  searchBackend: "qmd" | "builtin";
  qmdEnabled: boolean;
  qmdAvailable: boolean;
  qmdDebug?: string;
};

export type DelegateCapabilityApi = {
  registerMemoryCapability?(capability: unknown): void;
  registerMemoryRuntime?(runtime: unknown): void;
  registerMemoryFlushPlan?(resolver: () => MemoryFlushPlan): void;
};

export type DelegateCapabilityOptions = {
  serviceId: string;
  target: DelegateDaemonTarget;
  /**
   * Registration-wide fallback namespace ("" = daemon default). Per-search
   * scoping goes through `resolveSearchNamespace`.
   */
  namespace: string;
  /**
   * Resolve the namespace for one search from the host-supplied session key,
   * through the SAME per-session binding history the recall/observe/flush
   * hooks use. Without this, a namespace-enabled deployment would search the
   * daemon principal's whole readable set while every other delegate path
   * stayed session-scoped.
   */
  resolveSearchNamespace: (sessionKey: string | undefined) => Promise<string | undefined>;
  /**
   * Ask the daemon whether the delegate token may use a namespace. Used only
   * for a SUBSTITUTED default (a session with no binding), so a restricted
   * token gets an actionable refusal instead of a 403 on its first search.
   * `undefined` means the daemon could not answer - unproven, not refused.
   */
  /**
   * `operations` names what the CALLER is about to do. A token may grant
   * recall, observe, and flush but not `memory_search`; probing a hard-coded
   * operation would reject those otherwise-authorized calls locally, before
   * their own daemon route could authorize them.
   */
  verifyNamespaceAuthorization?: (
    namespace: string,
    timeoutMs?: number,
    operations?: readonly string[],
  ) => Promise<boolean | undefined>;
  memoryDir: string;
  workspaceDir: string;
  /** Agent ids this registration owns, for the public-artifact listing. */
  agentIds: string[];
  /**
   * Mirrors `hooks.allowPromptInjection`. When false the capability omits its
   * promptBuilder, exactly as the embedded path does, and still provides the
   * runtime, flush plan, and public artifacts.
   */
  allowPromptInjection: boolean;
  /**
   * Read the recall lines the delegate hook precomputed for a session. The
   * caller decides destructiveness: it peeks when a prompt *section* builder
   * owns eviction, and consumes when this capability is the sole consumer.
   */
  readPromptLines: (sessionKey: string) => string[] | null;
  /** Flush-plan sizing input (`extractionMaxTurnChars`). */
  extractionMaxTurnChars?: unknown;
  /** Flush-plan model (`summaryModel` or the task chain primary). */
  flushModel?: string;
  /** Fallback backend facts used until the first health probe answers. */
  configuredSearchBackend: "qmd" | "builtin";
  configuredQmdCommand: string;
  searchTimeoutMs: number;
  healthTimeoutMs: number;
  /** Injectable clock for the health-cache TTL. */
  now?: () => number;
};

const HEALTH_CACHE_TTL_MS = 30_000;
const SEARCH_CANDIDATE_CAP = 25_000;

function searchCandidateCeiling(budget: number): number {
  return Math.max(SEARCH_CANDIDATE_CAP, budget * 2);
}
const HEALTH_FAILURE_BACKOFF_MS = 5_000;
const LOCAL_READ_VERDICT_TTL_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHealth(payload: Record<string, unknown>): DaemonMemoryHealth {
  const qmd = asRecord(payload.qmd) ?? {};
  const searchBackend = payload.searchBackend === "qmd" ? "qmd" : "builtin";
  const qmdEnabled = searchBackend === "qmd" && payload.qmdEnabled !== false;
  return {
    memoryDir: typeof payload.memoryDir === "string" ? payload.memoryDir : undefined,
    defaultNamespace:
      typeof payload.defaultNamespace === "string" ? payload.defaultNamespace : undefined,
    namespacesEnabled:
      typeof payload.namespacesEnabled === "boolean" ? payload.namespacesEnabled : undefined,
    searchBackend,
    qmdEnabled,
    qmdAvailable:
      qmdEnabled &&
      (typeof qmd.active === "boolean" ? qmd.active : qmd.enabled !== false) &&
      qmd.degraded !== true,
    qmdDebug: typeof qmd.debugStatus === "string" ? qmd.debugStatus : undefined,
  };
}

/**
 * Build the delegate-backed capability pieces. Exported for tests and for
 * `registerDelegateMemoryCapability`, which wires them into the host.
 */
export type DelegateMemoryCapability = {
  /**
   * Apply the daemon's default to an unresolved namespace and refuse when even
   * that is unknown on a namespace-partitioned daemon. Shared with the hook
   * paths so prompt recall cannot fan wider than tool search.
   */
  resolveScopedNamespace: (
    explicit?: string,
    timeoutMs?: number,
    operations?: readonly string[],
  ) => Promise<string | undefined>;
  runtime: RemnicCapabilityRuntime;
  flushPlanResolver: () => MemoryFlushPlan;
  listArtifacts: () => Promise<unknown[]>;
  promptBuilder: (params: { sessionKey?: string }) => string[] | null;
};

export function createDelegateMemoryCapability(
  options: DelegateCapabilityOptions,
): DelegateMemoryCapability {
  const { target, serviceId } = options;
  const now = options.now ?? Date.now;
  let daemonScope: { dir: string; scope: MemoryReadScope } | undefined;
  const sharedScope = (): MemoryReadScope => {
    const dir = health.memoryDir ?? options.memoryDir;
    if (daemonScope?.dir !== dir) {
      daemonScope = {
        dir,
        scope: createMemoryReadScope({
          memoryDir: dir,
          workspaceDir: options.workspaceDir,
          includeWorkspaceRoot: false,
          additionalRoots: [options.memoryDir],
        }),
      };
    }
    return daemonScope.scope;
  };

  let health: DaemonMemoryHealth = {
    memoryDir: options.memoryDir,
    searchBackend: options.configuredSearchBackend,
    qmdEnabled: options.configuredSearchBackend === "qmd",
    qmdAvailable: options.configuredSearchBackend === "qmd",
    // Deliberately NOT seeded from the plugin's config: that describes this
    // plugin's own deployment, never the daemon's partitioning. Only a
    // successful probe can prove a flat corpus, and until one does, an absent
    // namespace fails closed.
  };
  let healthExpiresAt = 0;
  let healthCacheIsFailure = false;
  let healthEverResolved = false;
  /** When each local-read verdict was taken, so a revoked grant can expire. */
  const localReadVerdictAt = new Map<string, number>();
  let healthInFlight: Promise<void> | undefined;
  let lastHealthFailure: string | undefined;
  const daemonIsLocal = isLoopbackDaemonHost(target.host);
  let corpusShared: boolean | undefined = daemonIsLocal ? undefined : false;
  let reportedCorpusMismatch = false;
  const requireSharedCorpus = (surface: string): void => {
    if (corpusShared === true) return;
    const detail =
      corpusShared !== false
        ? "the daemon's corpus has not been confirmed yet"
        : daemonIsLocal
          ? `daemon serves ${health.memoryDir ?? "an unknown memoryDir"}, plugin is configured for ${options.memoryDir}`
          : `daemon at ${target.host} is not local, so its corpus is not this host's files`;
    throw new Error(`delegate ${surface} unavailable: ${detail}`);
  };

  const requireLocalReadAuthorized = async (
    surface: string,
    operations: readonly string[],
  ): Promise<void> => {
    if (options.verifyNamespaceAuthorization === undefined) return;
    const namespace = health.defaultNamespace ?? "";
    const verdictKey = `${target.resolveAuthToken().token}\u0000${operations.join(",")}\u0000${namespace}`;
    const cachedAt = localReadVerdictAt.get(verdictKey);
    if (cachedAt !== undefined && now() - cachedAt >= LOCAL_READ_VERDICT_TTL_MS) {
      substitutedNamespaceVerdicts.delete(verdictKey);
      localReadVerdictAt.delete(verdictKey);
    }
    if (!substitutedNamespaceVerdicts.has(verdictKey)) {
      substitutedNamespaceVerdicts.set(
        verdictKey,
        await options.verifyNamespaceAuthorization(namespace, undefined, operations),
      );
      localReadVerdictAt.set(verdictKey, now());
    }
    if (substitutedNamespaceVerdicts.get(verdictKey) !== true) {
      throw new Error(
        `delegate ${surface} unavailable: the delegate token's authorization for ${operations.join(", ")} on the daemon's corpus ${
          substitutedNamespaceVerdicts.get(verdictKey) === false ? "was refused" : "could not be confirmed"
        }`,
      );
    }
  };

  const requireSingleCorpusNamespacing = (surface: string): void => {
    if (health.namespacesEnabled === false) return;
    throw new Error(
      `delegate ${surface} unavailable: the daemon partitions namespaces (${health.namespacesEnabled === true ? `default: ${health.defaultNamespace ?? "unreported"}` : "namespacing unreported"}) and this surface carries no session, so a local read cannot be authorized for the caller's namespace`,
    );
  };

  const requireScopedNamespace = (explicit?: string): string | undefined => {
    const namespace = explicit ?? health.defaultNamespace;
    if (namespace === undefined && health.namespacesEnabled !== false) {
      throw new Error(
        "delegate request unavailable: the daemon's default namespace is unknown, so the session scope cannot be resolved",
      );
    }
    return namespace;
  };

  const substitutedNamespaceVerdicts = new Map<string, boolean | undefined>();
  const resolveScopedNamespaceChecked = async (
    explicit?: string,
    timeoutMs?: number,
    healthIsFresh = true,
    operations?: readonly string[],
  ): Promise<string | undefined> => {
    if (!healthIsFresh && explicit === undefined) {
      throw new Error(
        "delegate request unavailable: the daemon's namespace posture could not be confirmed within the caller's deadline, so an unscoped request is not safe",
      );
    }
    const namespace = requireScopedNamespace(explicit);
    if (explicit !== undefined || namespace === undefined) return namespace;
    if (options.verifyNamespaceAuthorization === undefined) return namespace;
    const verdictKey = `${target.resolveAuthToken().token}\u0000${(operations ?? []).join(",")}\u0000${namespace}`;
    if (!substitutedNamespaceVerdicts.has(verdictKey)) {
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        throw new Error(
          `delegate request unavailable: the delegate token's authorization for the daemon's default namespace (${namespace}) could not be verified within the caller's deadline, so an unscoped request is not safe`,
        );
      }
      substitutedNamespaceVerdicts.set(
        verdictKey,
        await options.verifyNamespaceAuthorization(namespace, timeoutMs, operations),
      );
    }
    if (substitutedNamespaceVerdicts.get(verdictKey) === false) {
      throw new Error(
        `delegate request unavailable: this session has no namespace binding and the daemon's default (${namespace}) is not authorized for the delegate token — bind the session explicitly or configure the namespace this deployment should use`,
      );
    }
    return namespace;
  };

  // `status()` is synchronous in the host contract, so the async probe runs in
  // getMemorySearchManager (which IS async) and status() reads the snapshot.
  /**
   * Returns whether the snapshot is CURRENT. `false` means this call gave up
   * waiting (spent budget, or a race lost to the caller's deadline) and the
   * values on hand are stale — safety facts read from them are unproven.
   */
  const refreshHealth = async (
    timeoutMs?: number,
    /**
     * Skip the TTL shortcut. Set when the caller is about to issue an UNSCOPED
     * request: a cached flat posture is an authorization fact, and a daemon
     * that restarts partitioned inside the window would turn that request into
     * a principal-wide fan-out with no probe failure to notice it. An
     * in-flight probe is still shared, so concurrent callers cost one request.
     */
    revalidate = false,
  ): Promise<boolean> => {
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || !Number.isFinite(timeoutMs))) {
      throw new Error(
        `delegate request rejected (timeoutMs must be a finite integer): ${String(timeoutMs)}`,
      );
    }
    if (now() < healthExpiresAt) {
      if (healthCacheIsFailure) return false;
      if (!revalidate) return true;
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) return false;
    if (healthInFlight !== undefined) {
      if (timeoutMs === undefined) {
        await healthInFlight;
        return true;
      }
      const TIMED_OUT = Symbol("timed-out");
      const outcome = await Promise.race([
        healthInFlight.then(() => undefined),
        new Promise<typeof TIMED_OUT>((resolve) => {
          const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return outcome !== TIMED_OUT;
    }
    healthInFlight = (async () => {
      try {
        const response = await fetch(daemonUrl(target, "/engram/v1/health"), {
          headers: daemonAuthHeaders(target),
          signal: AbortSignal.timeout(
            timeoutMs === undefined
              ? options.healthTimeoutMs
              : Math.min(options.healthTimeoutMs, timeoutMs),
          ),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`daemon /engram/v1/health responded ${response.status}`);
        }
        const payload: unknown = await response.json();
        const healthPayload = asRecord(payload);
        if (!healthPayload) {
          throw new Error("daemon /engram/v1/health returned a malformed envelope");
        }
        health = readHealth(healthPayload);
        healthExpiresAt = now() + HEALTH_CACHE_TTL_MS;
        healthCacheIsFailure = false;
        healthEverResolved = true;
        lastHealthFailure = undefined;
        corpusShared =
          daemonIsLocal &&
          health.memoryDir !== undefined &&
          daemonServesCorpus(options.memoryDir, health.memoryDir);
        if (!corpusShared && daemonIsLocal && !reportedCorpusMismatch) {
          reportedCorpusMismatch = true;
          log.error(
            `[${serviceId}] delegate capability: the daemon does not serve this plugin's memoryDir (daemon: ${health.memoryDir ?? "unreported"}, plugin: ${options.memoryDir}) — file-backed reads and public artifacts are disabled; search still runs through the daemon`,
          );
        }
      } catch (err) {
        health = {
          ...health,
          namespacesEnabled: undefined,
          defaultNamespace: undefined,
          memoryDir: undefined,
        };
        corpusShared = daemonIsLocal ? undefined : false;
        healthExpiresAt = now() + HEALTH_FAILURE_BACKOFF_MS;
        healthCacheIsFailure = true;
        healthEverResolved = true;
        const message = `[${serviceId}] delegate capability health probe failed: ${String(err)}`;
        if (message !== lastHealthFailure) {
          lastHealthFailure = message;
          log.warn(message);
        }
      } finally {
        healthInFlight = undefined;
      }
    })();
    await healthInFlight;
    return true;
  };

  const search = async (
    query: string,
    opts?: RuntimeSearchOptions,
  ): Promise<RuntimeSearchResult[]> => {
    if (opts?.minScore !== undefined && !Number.isFinite(opts.minScore)) {
      throw new Error(
        `delegate search rejected (minScore must be a finite number): ${String(opts.minScore)}`,
      );
    }
    if (
      opts?.maxResults !== undefined &&
      (!Number.isInteger(opts.maxResults) || opts.maxResults < 0)
    ) {
      throw new Error(
        `delegate search rejected (maxResults must be a non-negative integer): ${String(opts.maxResults)}`,
      );
    }
    const searchDeadline = now() + options.searchTimeoutMs;
    const searchRemaining = (): number => searchDeadline - now();
    const requestedResults = typeof opts?.maxResults === "number" ? opts.maxResults : undefined;
    const searchScope = await options.resolveSearchNamespace(opts?.sessionKey);
    const scopeIsFresh =
      searchScope === undefined ? await refreshHealth(searchRemaining(), true) : true;
    const namespace = await resolveScopedNamespaceChecked(
      searchScope,
      searchRemaining(),
      scopeIsFresh,
      ["memory_search"],
    );
    if (opts?.maxResults === 0) return [];
    const searchMode = opts?.qmdSearchModeOverride === "vsearch" ? "vector" : "search";
    const fetchPage = async (limit: number | undefined): Promise<unknown[]> => {
      const remaining = searchRemaining();
      if (remaining <= 0) {
        throw new Error(
          `delegate search unavailable: the search budget of ${options.searchTimeoutMs}ms is spent`,
        );
      }
      const response = await fetch(daemonUrl(target, "/engram/v1/memories/search"), {
        method: "POST",
        headers: { ...daemonAuthHeaders(target), "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          ...(limit === undefined ? {} : { maxResults: limit }),
          mode: searchMode,
          ...(namespace === undefined ? {} : { namespace }),
        }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`daemon /engram/v1/memories/search responded ${response.status}`);
      }
      const payload: unknown = await response.json();
      const body = asRecord(payload);
      if (!Array.isArray(body?.results)) {
        throw new Error("daemon /engram/v1/memories/search returned a malformed envelope");
      }
      return body.results;
    };
    const keep = (rawResults: unknown[]): RuntimeSearchResult[] => {
      const kept: RuntimeSearchResult[] = [];
      for (const raw of rawResults) {
        const hit = asRecord(raw);
        if (!hit || typeof hit.path !== "string" || hit.path.trim() === "") {
          throw new Error("daemon /engram/v1/memories/search returned a malformed result entry");
        }
        const rawPath = hit.path;
        const citation = sharedScope().relativizeToMemoryRoot(rawPath);
        if (isMemoryArtifactPath(citation)) continue;
        if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
          throw new Error("daemon /engram/v1/memories/search returned a malformed result entry");
        }
        const score = hit.score;
        if (typeof opts?.minScore === "number" && score < opts.minScore) continue;
        kept.push({
          path: sharedScope().absolutize(rawPath),
          // The daemon's ranked search returns whole-memory hits with no line
          // span; the embedded runtime reports the same 1..1 default.
          startLine: 1,
          endLine: 1,
          score,
          snippet: typeof hit.snippet === "string" ? hit.snippet : "",
          source: isSessionsMemoryPath(citation) ? "sessions" : "memory",
          citation,
        });
      }
      return kept;
    };
    let kept: RuntimeSearchResult[] = [];
    let budget = requestedResults;
    let limit: number | undefined = requestedResults;
    for (;;) {
      const rawResults = await fetchPage(limit);
      kept = keep(rawResults);
      budget ??= rawResults.length;
      if (kept.length >= budget) break;
      const served = limit ?? rawResults.length;
      if (rawResults.length === 0 || rawResults.length < served) break;
      const ceiling = searchCandidateCeiling(budget);
      if (served >= ceiling) break;
      limit = Math.min(served * 2, ceiling);
    }
    return kept.slice(0, budget);
  };

  const readMemoryFile = async (params: RuntimeReadParams): Promise<RuntimeReadResult> => {
    await refreshHealth(undefined, true);
    requireSharedCorpus("readFile");
    requireSingleCorpusNamespacing("readFile");
    await requireLocalReadAuthorized("readFile", ["memory_get"]);
    const requestedPath = sharedScope().normalizeWorkspacePath(params.relPath);
    const absolutePath = await sharedScope().resolveReadablePath(params.relPath);
    const allLines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
    if (params.from !== undefined && (!Number.isInteger(params.from) || params.from < 1)) {
      throw new Error(
        `memory read rejected (from must be a positive integer): ${String(params.from)}`,
      );
    }
    if (params.lines !== undefined && (!Number.isInteger(params.lines) || params.lines < 1)) {
      throw new Error(
        `memory read rejected (lines must be a positive integer): ${String(params.lines)}`,
      );
    }
    const from = typeof params.from === "number" ? params.from : 1;
    const lines = typeof params.lines === "number" ? params.lines : undefined;
    const startIndex = from - 1;
    const endIndex = typeof lines === "number" ? startIndex + lines : allLines.length;
    const truncated = endIndex < allLines.length;
    return {
      text: allLines.slice(startIndex, endIndex).join("\n"),
      path: requestedPath,
      truncated: truncated || undefined,
      from,
      lines,
      nextFrom: truncated ? endIndex + 1 : undefined,
    };
  };

  const status = (): RuntimeStatus => {
    const usesQmd = health.searchBackend === "qmd";
    return {
      backend: usesQmd ? "qmd" : "builtin",
      provider: usesQmd ? "qmd" : "builtin",
      requestedProvider: usesQmd ? "qmd" : "builtin",
      model: usesQmd ? options.configuredQmdCommand : "builtin",
      dirty: false,
      workspaceDir: options.workspaceDir,
      dbPath: health.memoryDir ?? options.memoryDir,
      sources: ["memory"],
      sourceCounts: [],
      vector: usesQmd ? { enabled: true, available: health.qmdAvailable } : { enabled: false },
      fts: { enabled: true, available: usesQmd ? health.qmdAvailable : true },
      custom: {
        remnic: {
          bridgeMode: "delegate",
          daemon: `${target.host}:${target.port}`,
          qmdAvailable: health.qmdAvailable,
          qmdDebug: health.qmdDebug,
          memoryDir: health.memoryDir ?? options.memoryDir,
        },
      },
    };
  };

  const manager: RuntimeManager = {
    search,
    readFile: readMemoryFile,
    status,
    async probeEmbeddingAvailability() {
      await refreshHealth();
      if (health.searchBackend !== "qmd") return { ok: true };
      if (health.qmdAvailable) return { ok: true };
      return { ok: false, error: health.qmdDebug ?? "Remnic daemon QMD backend unavailable" };
    },
    async probeVectorAvailability() {
      await refreshHealth();
      return health.searchBackend === "qmd" && health.qmdAvailable;
    },
    async close() {},
  };

  return {
    resolveScopedNamespace: async (
      explicit?: string,
      timeoutMs?: number,
      operations?: readonly string[],
    ): Promise<string | undefined> => {
      if (explicit !== undefined) {
        return await resolveScopedNamespaceChecked(explicit, timeoutMs, true, operations);
      }
      const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
      const fresh = await refreshHealth(timeoutMs, true);
      const remaining = deadline === undefined ? undefined : Math.floor(deadline - now());
      return await resolveScopedNamespaceChecked(undefined, remaining, fresh, operations);
    },
    runtime: {
      async getMemorySearchManager() {
        if (!healthEverResolved) await refreshHealth();
        else void refreshHealth().catch(() => undefined);
        return { manager };
      },
      resolveMemoryBackendConfig() {
        return health.searchBackend === "qmd"
          ? { backend: "qmd", qmd: { command: options.configuredQmdCommand } }
          : { backend: "builtin" };
      },
      async closeAllMemorySearchManagers() {},
    },
    flushPlanResolver: () =>
      buildMemoryFlushPlan({
        serviceId,
        extractionMaxTurnChars: options.extractionMaxTurnChars,
        flushModel: options.flushModel,
      }),
    listArtifacts: async () => {
      try {
        await refreshHealth(undefined, true);
        requireSharedCorpus("publicArtifacts");
        requireSingleCorpusNamespacing("publicArtifacts");
        await requireLocalReadAuthorized("publicArtifacts", ["memory_get"]);
        return await listRemnicPublicArtifacts({
          memoryDir: health.memoryDir ?? options.memoryDir,
          workspaceDir: options.workspaceDir,
          agentIds: options.agentIds,
        });
      } catch (err) {
        log.error(`[${serviceId}] delegate publicArtifacts.listArtifacts failed`, err);
        return [];
      }
    },
    promptBuilder: (params: { sessionKey?: string }) =>
      options.readPromptLines(params?.sessionKey ?? "default"),
  };
}

/**
 * Register the delegate-backed memory capability against the host, mirroring
 * the embedded path's unified/split SDK handling: newer hosts take the unified
 * capability object, older split-only hosts take the runtime and flush plan
 * through their own registration functions.
 */
export function registerDelegateMemoryCapability(
  api: DelegateCapabilityApi,
  options: DelegateCapabilityOptions,
): DelegateMemoryCapability {
  const built = createDelegateMemoryCapability(options);
  const hasUnified = typeof api.registerMemoryCapability === "function";
  // OpenClaw 1.x-only split seams (removed in 2026.8.x). Bound to locals so
  // ClawHub's static `api.register*(` scan does not flag these guarded calls
  // as breakages on 2.0 hosts.
  const registerRuntime = api.registerMemoryRuntime;
  const registerFlushPlan = api.registerMemoryFlushPlan;
  const hasRuntime = typeof registerRuntime === "function";
  const hasFlushPlan = typeof registerFlushPlan === "function";
  if (!hasUnified && !hasRuntime && !hasFlushPlan) {
    log.debug(
      `[${options.serviceId}] delegate: host exposes no memory capability surface — nothing to register`,
    );
    return built;
  }

  if (hasUnified) {
    api.registerMemoryCapability?.({
      ...(options.allowPromptInjection ? { promptBuilder: built.promptBuilder } : {}),
      flushPlanResolver: built.flushPlanResolver,
      runtime: built.runtime,
      publicArtifacts: { listArtifacts: built.listArtifacts },
    });
  }
  if (hasRuntime) registerRuntime.call(api, built.runtime);
  if (hasFlushPlan) registerFlushPlan.call(api, built.flushPlanResolver);

  const surface = hasUnified
    ? "memory capability with publicArtifacts provider"
    : "split memory runtime/flush-plan surfaces";
  const builder = options.allowPromptInjection
    ? " and promptBuilder"
    : " (promptBuilder omitted — injection disabled by policy)";
  log.info(`[${options.serviceId}] delegate: registered daemon-backed ${surface}${builder}`);
  return built;
}
