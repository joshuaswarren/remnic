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
  /** Whether the daemon partitions storage by namespace at all. */
  namespacesEnabled: boolean;
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
    namespacesEnabled: payload.namespacesEnabled === true,
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
    namespacesEnabled: false,
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
  let corpusShared: boolean | undefined;
  let reportedCorpusMismatch = false;
  const requireSharedCorpus = (surface: string): void => {
    if (corpusShared === true) return;
    const detail =
      corpusShared === false
        ? `daemon serves ${health.memoryDir ?? "an unknown memoryDir"}, plugin is configured for ${options.memoryDir}`
        : "the daemon's corpus has not been confirmed yet";
    throw new Error(`delegate ${surface} unavailable: ${detail}`);
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
    if (namespace === undefined && health.namespacesEnabled) {
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
        if (healthPayload) {
          health = readHealth(healthPayload);
          healthExpiresAt = now() + HEALTH_CACHE_TTL_MS;
          lastHealthFailure = undefined;
          corpusShared =
            health.memoryDir !== undefined &&
            daemonServesCorpus(options.memoryDir, health.memoryDir);
          if (!corpusShared && !reportedCorpusMismatch) {
            reportedCorpusMismatch = true;
            log.error(
              `[${serviceId}] delegate capability: the daemon does not serve this plugin's memoryDir (daemon: ${health.memoryDir ?? "unreported"}, plugin: ${options.memoryDir}) — file-backed reads and public artifacts are disabled; search still runs through the daemon`,
            );
          }
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
    const response = await fetch(daemonUrl(target, "/engram/v1/memories/search"), {
      method: "POST",
      headers: { ...daemonAuthHeaders(target), "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        ...(typeof opts?.maxResults === "number" ? { maxResults: opts.maxResults } : {}),
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
    const results: RuntimeSearchResult[] = [];
    const rawResults = body.results;
    for (const [index, raw] of rawResults.entries()) {
      const hit = asRecord(raw);
      if (!hit) continue;
      const rawPath = typeof hit.path === "string" ? hit.path : `memory-${index + 1}`;
      // Artifact isolation: the same exclusion the embedded runtime applies.
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
      results.push({
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
    return results;
  };

  const readMemoryFile = async (params: RuntimeReadParams): Promise<RuntimeReadResult> => {
    requireSharedCorpus("readFile");
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
