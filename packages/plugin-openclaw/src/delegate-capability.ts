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
/**
 * Ceiling on how many candidates one delegate search will ask the daemon for.
 *
 * A current daemon already excludes artifacts before its own cap, but this
 * side still drops artifacts (older daemons) and sub-`minScore` hits, so a
 * thinned page re-asks with a doubled limit. The bound is a daemon-safety
 * limit, NOT a stand-in for corpus exhaustion: only a short page or a
 * satisfied budget ends the loop sooner.
 */
const SEARCH_CANDIDATE_CAP = 25_000;

/**
 * The daemon-safety bound, mirroring the core search helper.
 *
 * ABSOLUTE rather than a multiple of the budget: scaling it made "the excluded
 * hits happen to rank first" indistinguishable from "there is nothing else",
 * so a request whose first `4 x budget` hits were artifacts returned short
 * without ever asking for the rank behind them. It still sits above the
 * caller's own budget, or a single filtered hit could never be replaced on a
 * large request.
 */
function searchCandidateCeiling(budget: number): number {
  return Math.max(SEARCH_CANDIDATE_CAP, budget * 2);
}
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
          // The gateway's own workspace is NOT a readable root here: health
          // validates `memoryDir` only, so a relative path absent from the
          // daemon corpus must not be served from a workspace the daemon
          // never searched or authorized.
          includeWorkspaceRoot: false,
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
    // Deliberately NOT seeded from the plugin's config: that describes this
    // plugin's own deployment, never the daemon's partitioning. Only a
    // successful probe can prove a flat corpus, and until one does, an absent
    // namespace fails closed.
  };
  let healthExpiresAt = 0;
  // Whether the live `healthExpiresAt` window came from a FAILURE. A
  // revalidating caller bypasses a successful posture cache, but must honor a
  // failure backoff: the posture is already unknown, so another immediate
  // probe cannot prove anything and would spend the hook budget on a daemon
  // that is down.
  let healthCacheIsFailure = false;
  // Whether ANY probe has settled. Until one has, the snapshot is all zeroes
  // and the synchronous `status()` reader would report a daemon posture that
  // was never observed.
  let healthEverResolved = false;
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
   * one a given session is scoped to, and not necessarily one the token may
   * read. Corpus containment proves physical co-location, never authorization.
   *
   * The host contract makes this decidable only one way: `readFile` and
   * `listArtifacts` carry NO session, so on a namespace-partitioned daemon
   * there is no scope to check them against — a per-registration fallback
   * would authorize one namespace's disk for sessions bound to another.
   * Search is unaffected: it carries `sessionKey` and the daemon enforces.
   *
   * So the local walk requires a daemon with exactly one corpus to walk.
   * Unknown namespacing (older build, or a token without health access) fails
   * closed the same way.
   */
  /**
   * A local file read must clear the daemon's OPERATION gate too.
   *
   * Corpus containment proves physical co-location and
   * `requireSingleCorpusNamespacing` proves there is only one namespace to
   * read — neither proves this token may read memories. A token granted
   * `memory_search` but not `memory_get` would otherwise open any known path
   * straight off disk, which is exactly the check delegating to the daemon is
   * supposed to preserve.
   */
  const requireLocalReadAuthorized = async (
    surface: string,
    operations: readonly string[],
  ): Promise<void> => {
    if (options.verifyNamespaceAuthorization === undefined) return;
    const namespace = health.defaultNamespace ?? "";
    const verdictKey = `${target.resolveAuthToken().token}\u0000${operations.join(",")}\u0000${namespace}`;
    if (!substitutedNamespaceVerdicts.has(verdictKey)) {
      substitutedNamespaceVerdicts.set(
        verdictKey,
        await options.verifyNamespaceAuthorization(namespace, undefined, operations),
      );
    }
    // `undefined` means the probe could not answer — a timeout, or an older
    // daemon with no authorization route. A local read bypasses the daemon
    // entirely, so an UNCONFIRMED verdict is not permission: fail closed,
    // exactly as an unconfirmed namespace posture already does.
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

  /**
   * The daemon default is a SUBSTITUTION, not something the caller asked for:
   * a session with no binding yet gets it silently. On a token restricted to
   * another namespace that turns the very first search into a 403 the host
   * sees as "memory is broken".
   *
   * So a substituted default is verified once against the daemon's own
   * namespace-aware authorization probe before it is used. An explicit scope
   * is the caller's own and is not second-guessed here — the daemon still
   * enforces it. A daemon that cannot answer the probe (older build) is
   * treated as before: unproven, not refused.
   */
  // Keyed by namespace AND token: daemon requests resolve credentials
  // dynamically, so caching a refusal against the namespace alone would keep
  // rejecting unbound searches locally after an operator swapped in a token
  // that IS authorized — recall and observe would recover, search would not.
  // A map (not `??=`) because "unknown" is a real verdict: re-probing it would
  // put a request in front of every search against an older daemon.
  const substitutedNamespaceVerdicts = new Map<string, boolean | undefined>();
  const resolveScopedNamespaceChecked = async (
    explicit?: string,
    timeoutMs?: number,
    healthIsFresh = true,
    operations?: readonly string[],
  ): Promise<string | undefined> => {
    // An unconfirmed snapshot cannot license an ABSENT namespace: the daemon
    // may have restarted partitioned since it was taken, and the flush would
    // fan out under the new posture. An explicit scope is the caller's own and
    // the daemon still enforces it.
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
      // Inside a shared deadline this must not start its own fixed-timeout
      // request: a flush that already spent most of its budget on capability
      // and binding work would overrun the hook before draining. But a
      // SUBSTITUTED default is an authorization fact, so running unverified is
      // not the safe degradation — refuse, exactly as an unconfirmed posture
      // refuses an absent namespace. A cached verdict still answers for free.
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
    // `NaN` would slip past every `<= 0` comparison and reach
    // `AbortSignal.timeout` as an invalid duration; a fraction would be
    // silently truncated. Both are caller bugs across an untyped boundary.
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || !Number.isFinite(timeoutMs))) {
      throw new Error(
        `delegate request rejected (timeoutMs must be a finite integer): ${String(timeoutMs)}`,
      );
    }
    if (now() < healthExpiresAt) {
      if (healthCacheIsFailure) return false;
      if (!revalidate) return true;
    }
    // A caller inside a shared deadline (the lifecycle flushes) passes what is
    // LEFT of it. Zero or less means the budget is already spent: starting a
    // fresh probe here would overrun the hook and get it abandoned before the
    // buffer drains, so the last known snapshot answers instead.
    if (timeoutMs !== undefined && timeoutMs <= 0) return false;
    if (healthInFlight !== undefined) {
      // An in-flight probe was started by whoever got here first, possibly on
      // the full health timeout. A caller inside a shared deadline must not
      // inherit that: it waits only for what it has left, then answers from
      // the current snapshot. The probe itself is left running for the caller
      // that owns it.
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
      // Losing the race means the snapshot on hand was never confirmed by this
      // call, so the caller must treat it as unproven rather than acting on a
      // posture the daemon may have changed.
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
          // A 200 carrying a non-record body is a protocol failure, not a
          // success: without a backoff every later refresh would re-fetch
          // immediately and hammer a persistently malformed daemon.
          throw new Error("daemon /engram/v1/health returned a malformed envelope");
        }
        // VERBATIM. The seeded snapshot covers the window before any probe
        // answers and the window where one is failing, but a daemon that
        // ANSWERED and stayed silent about its posture is genuinely unknown -
        // and the plugin's config describes its OWN deployment, not the
        // daemon's. Substituting it here would let a flat plugin config mark a
        // partitioned daemon `false`, permitting an absent namespace and
        // fanning `/memories/search` across everything the token can read. The
        // same substitution for `memoryDir` would compare the plugin's path to
        // itself and enable file-backed reads with no proof at all.
        health = readHealth(healthPayload);
        // One TTL for the whole snapshot. The posture does not need a shorter
        // one because an UNSCOPED request revalidates unconditionally rather
        // than trusting any cache window.
        healthExpiresAt = now() + HEALTH_CACHE_TTL_MS;
        healthCacheIsFailure = false;
        healthEverResolved = true;
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
        //
        // But the two SAFETY facts stop being proven the moment a probe fails:
        // a daemon that was flat may have restarted partitioned, and one that
        // served this corpus may now serve another. Holding the old values
        // through the backoff would let an unbound search fan out across a
        // freshly partitioned corpus, so both revert to unknown and fail
        // closed until a probe succeeds again.
        // `defaultNamespace` goes too: a partitioned daemon can change it
        // across a restart, and a stale one is NOT undefined, so it would slip
        // past the unknown-posture guard and bind a fresh session to the
        // previous tenant's namespace.
        health = {
          ...health,
          namespacesEnabled: undefined,
          defaultNamespace: undefined,
          memoryDir: undefined,
        };
        corpusShared = daemonIsLocal ? undefined : false;
        healthExpiresAt = now() + HEALTH_FAILURE_BACKOFF_MS;
        healthCacheIsFailure = true;
        // A failed probe settles the posture too: it is now KNOWN-unavailable
        // rather than never observed, and the backoff owns the retry.
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
    // An out-of-range budget is a caller bug, not something to reinterpret:
    // coercing a negative to 1, truncating a fraction, or dropping a
    // non-finite value to the daemon default all return a valid-looking page
    // for a budget nobody asked for. Zero is the one accepted edge, handled
    // below once the request has been authorized.
    if (
      opts?.maxResults !== undefined &&
      (!Number.isInteger(opts.maxResults) || opts.maxResults < 0)
    ) {
      throw new Error(
        `delegate search rejected (maxResults must be a non-negative integer): ${String(opts.maxResults)}`,
      );
    }
    // ONE deadline for the WHOLE call, opened before ANY network work: the
    // posture probe, the authorization probe, and every search page share it.
    // Opened after scope resolution instead, a slow `/health` could spend the
    // entire budget and each later request would still start a fresh one — a
    // 25-second search taking fifty.
    const searchDeadline = now() + options.searchTimeoutMs;
    const searchRemaining = (): number => searchDeadline - now();
    // Cap-after-filter (AGENTS.md retrieval contract): artifact paths and
    // minScore are dropped on this side, so asking the daemon for exactly
    // `maxResults` would let a few excluded hits shrink — or empty — a page
    // that has valid lower-ranked memories behind it.
    const requestedResults = typeof opts?.maxResults === "number" ? opts.maxResults : undefined;
    // An empty namespace means "the daemon's default", but the daemon reads an
    // ABSENT namespace as a principal-wide fan-out. Send the concrete default
    // health reports so a default-scoped session cannot see other namespaces.
    const searchScope = await options.resolveSearchNamespace(opts?.sessionKey);
    // The scope decides whether a posture probe is needed at all. An EXPLICIT
    // one is enforced by the daemon on the search endpoint, so a slow or dead
    // `/health` must not delay a search the daemon would serve; an ABSENT one
    // is decided by the posture, which is an authorization fact and must be
    // current. Resolving the scope first also means a cached manager costs at
    // most ONE probe here, never one eager plus one revalidating.
    const scopeIsFresh =
      searchScope === undefined ? await refreshHealth(searchRemaining(), true) : true;
    const namespace = await resolveScopedNamespaceChecked(
      searchScope,
      searchRemaining(),
      scopeIsFresh,
      ["memory_search"],
    );
    // Embedded returns an empty set for a zero budget, and forwarding 0 would
    // hit the daemon schema's `maxResults >= 1` — a 400 purely from switching
    // bridge mode. The short circuit lands HERE, after scope and authorization
    // resolution: shrinking the requested count must never be a way to get a
    // successful answer for a namespace the session may not read.
    if (opts?.maxResults === 0) return [];
    // Mirror the embedded manager: "vsearch" is vector ranking, "query" is the
    // ordinary search plan, anything else is the backend default.
    // Embedded defaults to "search" when the host passes no override, and an
    // omitted mode sends a flat corpus down the legacy direct-QMD path — a
    // different ranking for the same request. Always send one.
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
          // Same override mapping the embedded manager applies, so a host asking
          // for vector or lexical ranking gets the same semantics in either mode.
          mode: searchMode,
          ...(namespace === undefined ? {} : { namespace }),
        }),
        // What is LEFT of the shared budget, not a fresh one.
        signal: AbortSignal.timeout(remaining),
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
        //
        // Judged on the ROOT-RELATIVE citation, never the absolute hit: a
        // corpus that merely LIVES under a directory named `artifacts`
        // (`<root>/artifacts/remnic`) would otherwise lose every hit.
        const citation = sharedScope().relativizeToMemoryRoot(rawPath);
        if (isMemoryArtifactPath(citation)) continue;
        // A missing or non-finite score is a protocol failure, not a zero: it
        // would silently drop the hit under `minScore` and hand callers a
        // fabricated ranking without one.
        if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
          throw new Error("daemon /engram/v1/memories/search returned a malformed result entry");
        }
        const score = hit.score;
        if (typeof opts?.minScore === "number" && score < opts.minScore) continue;
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
      const ceiling = searchCandidateCeiling(budget);
      if (served >= ceiling) break;
      limit = Math.min(served * 2, ceiling);
    }
    return kept.slice(0, budget);
  };

  const readMemoryFile = async (params: RuntimeReadParams): Promise<RuntimeReadResult> => {
    // REVALIDATED, not merely refreshed. `corpusShared` is a safety fact, and
    // a daemon that restarts onto another corpus inside the cache window
    // produces no probe failure to invalidate it — the cached `true` would let
    // this return a file from the corpus that is no longer being served. The
    // failure backoff still applies, so a down daemon degrades immediately
    // rather than probing per read.
    await refreshHealth(undefined, true);
    requireSharedCorpus("readFile");
    requireSingleCorpusNamespacing("readFile");
    await requireLocalReadAuthorized("readFile", ["memory_get"]);
    const requestedPath = sharedScope().normalizeWorkspacePath(params.relPath);
    const absolutePath = await sharedScope().resolveReadablePath(params.relPath);
    const allLines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
    // `NaN` and `Infinity` are numbers: without the finite check `NaN` slices
    // from zero and silently returns the file's head, while `Infinity` returns
    // an empty page and is echoed back as the offset. Neither is the range the
    // caller asked for, so reject rather than serve a different one.
    // Clamping a negative to 1 or truncating a fraction returns valid-looking
    // content for a range the caller did not ask for, which across an untyped
    // host boundary is indistinguishable from a correct answer.
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
    resolveScopedNamespace: async (
      explicit?: string,
      timeoutMs?: number,
      operations?: readonly string[],
    ): Promise<string | undefined> => {
      // An explicit scope is the caller's OWN and the daemon enforces it on
      // the operation endpoint. It needs no health fact and no authorization
      // probe, so a cold cache must not spend the hook's deadline here — a
      // `/health` that eats the prompt budget would drop memory injection for
      // a recall the daemon was ready to serve.
      if (explicit !== undefined) {
        return await resolveScopedNamespaceChecked(explicit, timeoutMs, true, operations);
      }
      // An ABSENT scope is decided by the posture, which is an authorization
      // fact and must be current. The posture probe and the authorization
      // probe below share ONE deadline: billing each the full remaining budget
      // would overrun the hook before its own request runs.
      const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
      const fresh = await refreshHealth(timeoutMs, true);
      const remaining = deadline === undefined ? undefined : Math.floor(deadline - now());
      return await resolveScopedNamespaceChecked(undefined, remaining, fresh, operations);
    },
    runtime: {
      async getMemorySearchManager() {
        // `status()` is SYNCHRONOUS by the host's interface, so it can only
        // report what a probe has already established. The FIRST handout
        // therefore waits — an unprobed snapshot has nothing truthful to say.
        // Afterwards it never waits again: every operation that needs a
        // current posture refreshes on its own, so blocking per handout only
        // delays an explicitly scoped search that needs no posture at all, and
        // pays for two sequential probes on an unscoped one that revalidates.
        // A background refresh keeps the synchronous reader converging.
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
        // The listing walks the LOCAL corpus, so confirm the daemon still
        // serves it before trusting those files — revalidated for the same
        // reason `readFile` is: a restart onto another corpus inside the cache
        // window leaves no failure behind to notice. Health may also not have
        // been probed at all yet: this surface hangs off the capability
        // object, not off a manager.
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
