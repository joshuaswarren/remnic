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
/**
 * Ceiling on how many candidates one delegate search will ask the daemon for.
 *
 * A current daemon already excludes artifacts before its own cap, but this
 * side still drops artifacts (older daemons) and sub-`minScore` hits, so a
 * thinned page re-asks with a doubled limit. The bound is a daemon-safety
 * limit, NOT a stand-in for corpus exhaustion: only a short page or a
 * satisfied budget ends the loop sooner.
 */
const SEARCH_CANDIDATE_CEILING = 1_000;
// A failing probe backs off instead of retrying on every hook, so a daemon
// that is down or rejecting the token cannot turn each turn into a request.
const HEALTH_FAILURE_BACKOFF_MS = 5_000;

/**
 * Narrow an unvalidated JSON value to a readable record. A type guard rather
 * than a cast: daemon payloads are external input, so every field read below
 * is `unknown` until its own `typeof` check passes.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHealth(payload: Record<string, unknown>): DaemonMemoryHealth {
  const qmd = asRecord(payload.qmd) ?? {};
  // The daemon reports `searchBackend` explicitly; anything other than the two
  // known values is treated as builtin rather than trusted blindly.
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
    // `active && !degraded` is the daemon's own "search will actually answer"
    // signal. A missing `active` means an older daemon, so fall back to
    // `enabled` rather than reporting a false outage.
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
  resolveScopedNamespace: (explicit?: string) => Promise<string | undefined>;
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
  // The read scope and the artifact listing are rooted on the directory the
  // DAEMON reports, not the plugin's configured corpus root. Health returns the
  // namespace-resolved storage dir, so scanning the root instead would miss the
  // active namespace's files while publishing flat-root files for the wrong
  // scope. `daemonServesCorpus` has already proved that directory belongs to
  // the configured corpus, so the root remains the trust anchor.
  let daemonScope: { dir: string; scope: MemoryReadScope } | undefined;
  const sharedScope = (): MemoryReadScope => {
    const dir = health.memoryDir ?? options.memoryDir;
    if (daemonScope?.dir !== dir) {
      daemonScope = {
        dir,
        scope: createMemoryReadScope({
          // The daemon's own directory comes first, so a relative hit resolves
          // in the frame the daemon returned it in...
          memoryDir: dir,
          workspaceDir: options.workspaceDir,
          // ...and the corpus ROOT stays readable, so a session bound to a
          // NON-default namespace can still open the absolute hits its own
          // search returns from `<root>/namespaces/<other>`.
          additionalRoots: [options.memoryDir],
        }),
      };
    }
    return daemonScope.scope;
  };

  // Seeded from the plugin's own config so `status()` never reports a false
  // outage before the first probe answers; the daemon's health overwrites it.
  let health: DaemonMemoryHealth = {
    memoryDir: options.memoryDir,
    searchBackend: options.configuredSearchBackend,
    qmdEnabled: options.configuredSearchBackend === "qmd",
    qmdAvailable: options.configuredSearchBackend === "qmd",
  };
  let healthExpiresAt = 0;
  let healthInFlight: Promise<void> | undefined;
  let lastHealthFailure: string | undefined;
  // Local reads and artifact listing are only valid while the daemon serves
  // the SAME corpus this plugin is configured for. Until health confirms it,
  // and after any mismatch, the file-backed surfaces refuse rather than read a
  // different same-named local file. `undefined` = not yet confirmed.
  // Locality is knowable without a probe, and it is decisive: canonicalizing
  // two path strings ON THIS HOST proves nothing about a remote daemon that
  // happens to use the same absolute pathname. Settle it up front so a remote
  // target reports the accurate reason instead of "not confirmed yet".
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

  /**
   * File-backed surfaces walk ONE local directory: the `memoryDir` health
   * reports. The daemon answers `/engram/v1/health` without a namespace, so
   * that directory is the DEFAULT namespace's storage — not necessarily the
   * one this capability is scoped to, and not necessarily one the token may
   * read. Corpus containment proves physical co-location, never authorization.
   *
   * So the local walk is allowed only when there is exactly one corpus to walk
   * (namespaces disabled) or the scope resolves to the very namespace health
   * described. Anything else would publish another namespace's facts,
   * entities, and artifacts while omitting the session's own.
   */
  const requireHealthNamespaceScope = async (surface: string): Promise<void> => {
    if (health.namespacesEnabled === false) return;
    const scoped = await options.resolveSearchNamespace(undefined);
    const resolved = scoped ?? health.defaultNamespace;
    if (resolved !== undefined && resolved === health.defaultNamespace) return;
    throw new Error(
      `delegate ${surface} unavailable: the daemon reports the ${health.defaultNamespace ?? "unknown"} namespace's storage, but this session is scoped to ${resolved ?? "an unresolved namespace"} — a local walk cannot be authorized for it`,
    );
  };

  /**
   * refreshHealth deliberately swallows probe failures, so a transient or
   * legacy response can leave both the caller's namespace and the daemon
   * default undefined. On a namespace-partitioned daemon an absent namespace
   * means "fan out across everything the principal can read", which is outside
   * the session's scope — refuse instead of widening it. A flat corpus has
   * nothing to widen to, so it proceeds unscoped.
   */
  const requireScopedNamespace = (explicit?: string): string | undefined => {
    const namespace = explicit ?? health.defaultNamespace;
    // `false` is the only value that makes an absent namespace safe. `true`
    // and `undefined` (never reported, or a probe that failed) both mean the
    // scope cannot be proven, so both refuse.
    if (namespace === undefined && health.namespacesEnabled !== false) {
      throw new Error(
        "delegate request unavailable: the daemon's default namespace is unknown, so the session scope cannot be resolved",
      );
    }
    return namespace;
  };

  // `status()` is synchronous in the host contract, so the async probe runs in
  // getMemorySearchManager (which IS async) and status() reads the snapshot.
  const refreshHealth = async (): Promise<void> => {
    if (now() < healthExpiresAt) return;
    if (healthInFlight !== undefined) return healthInFlight;
    healthInFlight = (async () => {
      try {
        const response = await fetch(daemonUrl(target, "/engram/v1/health"), {
          headers: daemonAuthHeaders(target),
          signal: AbortSignal.timeout(options.healthTimeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`daemon /engram/v1/health responded ${response.status}`);
        }
        const payload: unknown = await response.json();
        const healthPayload = asRecord(payload);
        if (!healthPayload) {
          // A 200 carrying a non-record body is a protocol failure, not a
          // success: without a backoff every later refresh would re-fetch
          // immediately and hammer a persistently malformed daemon.
          throw new Error("daemon /engram/v1/health returned a malformed envelope");
        }
        health = readHealth(healthPayload);
        healthExpiresAt = now() + HEALTH_CACHE_TTL_MS;
        lastHealthFailure = undefined;
        // Path identity is decided by canonicalizing two strings ON THIS
        // HOST, so it proves nothing about a REMOTE daemon that happens to
        // use the same absolute pathname. Explicit `delegate` may target a
        // remote daemon; the file-backed surfaces may not follow it there.
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
        // Keep the last known snapshot and retry after a backoff. Memory must
        // never break the turn, and a persistent failure must not log per hook.
        healthExpiresAt = now() + HEALTH_FAILURE_BACKOFF_MS;
        const message = `[${serviceId}] delegate capability health probe failed: ${String(err)}`;
        if (message !== lastHealthFailure) {
          lastHealthFailure = message;
          log.warn(message);
        }
      } finally {
        healthInFlight = undefined;
      }
    })();
    return healthInFlight;
  };

  const search = async (
    query: string,
    opts?: RuntimeSearchOptions,
  ): Promise<RuntimeSearchResult[]> => {
    // Embedded returns an empty set for a zero budget; forwarding 0 would hit
    // the daemon schema's `maxResults >= 1` and turn a valid no-results request
    // into a 400 purely by switching bridge mode.
    if (opts?.maxResults === 0) return [];
    // A cached manager can outlive the probe that handed it out. Without this,
    // a single transient health failure sticks a namespace refusal on every
    // later search while recall/observe recover on their next scoped call.
    await refreshHealth();
    // Cap-after-filter (AGENTS.md retrieval contract): artifact paths and
    // minScore are dropped on this side, so asking the daemon for exactly
    // `maxResults` would let a few excluded hits shrink — or empty — a page
    // that has valid lower-ranked memories behind it.
    const requestedResults =
      typeof opts?.maxResults === "number" && Number.isFinite(opts.maxResults)
        ? Math.max(1, Math.floor(opts.maxResults))
        : undefined;
    // An empty namespace means "the daemon's default", but the daemon reads an
    // ABSENT namespace as a principal-wide fan-out. Send the concrete default
    // health reports so a default-scoped session cannot see other namespaces.
    const namespace = requireScopedNamespace(
      await options.resolveSearchNamespace(opts?.sessionKey),
    );
    // Mirror the embedded manager: "vsearch" is vector ranking, "query" is the
    // ordinary search plan, anything else is the backend default.
    // Embedded defaults to "search" when the host passes no override, and an
    // omitted mode sends a flat corpus down the legacy direct-QMD path — a
    // different ranking for the same request. Always send one.
    const searchMode = opts?.qmdSearchModeOverride === "vsearch" ? "vector" : "search";
    const fetchPage = async (limit: number | undefined): Promise<unknown[]> => {
      const response = await fetch(daemonUrl(target, "/engram/v1/memories/search"), {
        method: "POST",
        headers: { ...daemonAuthHeaders(target), "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          ...(limit === undefined ? {} : { maxResults: limit }),
          // Same override mapping the embedded manager applies, so a host asking
          // for vector or lexical ranking gets the same semantics in either mode.
          mode: searchMode,
          ...(namespace === undefined ? {} : { namespace }),
        }),
        signal: AbortSignal.timeout(options.searchTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`daemon /engram/v1/memories/search responded ${response.status}`);
      }
      const payload: unknown = await response.json();
      const body = asRecord(payload);
      if (!Array.isArray(body?.results)) {
        // A 200 with no usable `results` is a protocol or version failure.
        // Returning [] would make it indistinguishable from a valid empty
        // search and quietly report that no memories exist (AGENTS.md #22).
        throw new Error("daemon /engram/v1/memories/search returned a malformed envelope");
      }
      return body.results;
    };
    const keep = (rawResults: unknown[]): RuntimeSearchResult[] => {
      const kept: RuntimeSearchResult[] = [];
      for (const raw of rawResults) {
        const hit = asRecord(raw);
        // A hit without a string `path` is a version-skewed or corrupt daemon.
        // Synthesizing `memory-N` would present that as a real memory the host
        // could then try to open (AGENTS.md #22: a protocol failure must not
        // masquerade as data).
        if (!hit || typeof hit.path !== "string" || hit.path.trim() === "") {
          throw new Error("daemon /engram/v1/memories/search returned a malformed result entry");
        }
        const rawPath = hit.path;
        // Artifact isolation: the same exclusion the embedded runtime applies.
        // A current daemon already dropped these before its own cap; this
        // keeps the guarantee against an older one.
        if (isMemoryArtifactPath(rawPath)) continue;
        const score = typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 0;
        if (
          typeof opts?.minScore === "number" &&
          Number.isFinite(opts.minScore) &&
          score < opts.minScore
        ) {
          continue;
        }
        const citation = sharedScope().relativizeToMemoryRoot(rawPath);
        kept.push({
          // Absolute, so a follow-up readFile is unambiguous when the same
          // relative path exists under more than one allowed root.
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
    // A caller that named no budget keeps the daemon's own page size on the
    // wire, and the FIRST page it serves fixes the budget once. Recomputing it
    // per round would let the target grow with every doubled request, so a
    // default page of 10 could return 80 rows while never "reaching" it.
    let kept: RuntimeSearchResult[] = [];
    let budget = requestedResults;
    let limit: number | undefined = requestedResults;
    for (;;) {
      const rawResults = await fetchPage(limit);
      kept = keep(rawResults);
      budget ??= rawResults.length;
      if (kept.length >= budget) break;
      // What the daemon actually served this round. A short page means it has
      // nothing left, so asking again just replays the same rows.
      const served = limit ?? rawResults.length;
      if (rawResults.length === 0 || rawResults.length < served) break;
      if (served >= SEARCH_CANDIDATE_CEILING) break;
      limit = Math.min(served * 2, SEARCH_CANDIDATE_CEILING);
    }
    return kept.slice(0, budget);
  };

  const readMemoryFile = async (params: RuntimeReadParams): Promise<RuntimeReadResult> => {
    // Same reason as `search`: a cached manager can outlive its probe, and a
    // stale "corpus not confirmed" must not stick past a recovered daemon.
    await refreshHealth();
    requireSharedCorpus("readFile");
    await requireHealthNamespaceScope("readFile");
    const requestedPath = sharedScope().normalizeWorkspacePath(params.relPath);
    const absolutePath = await sharedScope().resolveReadablePath(params.relPath);
    const allLines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
    const from = typeof params.from === "number" ? Math.max(1, Math.floor(params.from)) : 1;
    const lines =
      typeof params.lines === "number" && Number.isFinite(params.lines)
        ? Math.max(1, Math.floor(params.lines))
        : undefined;
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
    // No `sync`: indexing belongs to the daemon in delegate mode. Omitting the
    // optional member is honest — the host will not call what is not offered.
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
    resolveScopedNamespace: async (explicit?: string): Promise<string | undefined> => {
      await refreshHealth();
      return requireScopedNamespace(explicit);
    },
    runtime: {
      async getMemorySearchManager() {
        await refreshHealth();
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
        // The listing walks the LOCAL corpus, so confirm the daemon serves it
        // before trusting those files. Health may not have been probed yet:
        // this surface hangs off the capability object, not off a manager.
        await refreshHealth();
        requireSharedCorpus("publicArtifacts");
        await requireHealthNamespaceScope("publicArtifacts");
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
  // Always BUILT, even when the host registers none of it: the caller reuses
  // `daemonDefaultNamespace` so the hook paths scope exactly like search.
  const built = createDelegateMemoryCapability(options);
  const hasUnified = typeof api.registerMemoryCapability === "function";
  const hasRuntime = typeof api.registerMemoryRuntime === "function";
  const hasFlushPlan = typeof api.registerMemoryFlushPlan === "function";
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
  if (hasRuntime) api.registerMemoryRuntime?.(built.runtime);
  if (hasFlushPlan) api.registerMemoryFlushPlan?.(built.flushPlanResolver);

  const surface = hasUnified
    ? "memory capability with publicArtifacts provider"
    : "split memory runtime/flush-plan surfaces";
  const builder = options.allowPromptInjection
    ? " and promptBuilder"
    : " (promptBuilder omitted — injection disabled by policy)";
  log.info(`[${options.serviceId}] delegate: registered daemon-backed ${surface}${builder}`);
  return built;
}
