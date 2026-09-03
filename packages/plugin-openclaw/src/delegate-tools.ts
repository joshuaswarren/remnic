/**
 * Daemon-backed `memory_search` / `memory_get` tools for delegate mode.
 *
 * Embedded mode builds these over the in-process orchestrator
 * (`openclaw-tools/`). Delegate mode has no orchestrator, so search goes
 * through the daemon-backed capability manager — the SAME scoping,
 * authorization, and artifact-isolation path the host's own memory search
 * uses — and get reads the daemon's memory route.
 */

import path from "node:path";

import {
  type ActiveMemoryGetOutput,
  type ActiveMemoryMetadata,
  type ActiveMemorySearchOutput,
  collapseWhitespace,
  truncateCodePointSafe,
} from "@remnic/core";

import type { DelegateDaemonTarget } from "./bridge.js";
import { isHandleToken } from "@remnic/core/recall-handles";

import { getJson } from "./delegate-http.js";
import type { RemnicCapabilityRuntime } from "./memory-capability-types.js";
import { MemoryGetInputSchema, MemorySearchInputSchema } from "./openclaw-tools/shapes.js";
import { toolJsonResult } from "./openclaw-tools/tool-json-result.js";

const DEFAULT_SEARCH_RESULTS = 8;
/** Embedded parity (`recallForActiveMemory`): default snippet budget. */
const DEFAULT_SNIPPET_MAX_CHARS = 600;
/** The daemon's `memorySearchSchema` cap on `query`. */
const DAEMON_SEARCH_QUERY_MAX_CHARS = 2_048;
/** The daemon's `memoryGetSchema` cap on `memoryId` and `sessionKey`. */
const DAEMON_MEMORY_GET_MAX_CHARS = 512;

/** Embedded parity: finite limits floor into [1, 50]; anything else is the default. */
function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SEARCH_RESULTS;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function clampSnippetMaxChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SNIPPET_MAX_CHARS;
  return Math.max(1, Math.min(4_000, Math.floor(value)));
}

interface ToolContext {
  sessionKey?: string;
  agentId?: string;
}

function sessionKeyFor(params: Record<string, unknown>, ctx: ToolContext | undefined): string {
  if (typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim().length > 0) {
    return ctx.sessionKey;
  }
  return typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0 ? params.sessionKey : "default";
}

/**
 * The daemon's memory record, translated into the public active-memory get
 * shape the embedded tool returns. Its absolute `path` and raw frontmatter
 * stay behind: same contract in either bridge mode, and no filesystem
 * layout reaches the model.
 */
function activeMemoryGetOutputFrom(record: unknown): ActiveMemoryGetOutput {
  if (typeof record !== "object" || record === null) {
    // A miss is the daemon's 404 (handled by the caller); a 2xx without a
    // record is version skew or a corrupting proxy, not an absent memory.
    throw new Error("daemon memory route responded 2xx without a memory record");
  }
  const memory = record as { id?: unknown; content?: unknown; frontmatter?: unknown };
  if (typeof memory.id !== "string" || typeof memory.content !== "string") {
    throw new Error("daemon memory route returned a malformed memory record");
  }
  const frontmatter =
    typeof memory.frontmatter === "object" && memory.frontmatter !== null
      ? (memory.frontmatter as Record<string, unknown>)
      : {};
  const metadata: ActiveMemoryMetadata = {};
  if (frontmatter.category === "fact" || frontmatter.category === "preference") {
    metadata.type = frontmatter.category;
  }
  if (Array.isArray(frontmatter.tags) && typeof frontmatter.tags[0] === "string") {
    metadata.topic = frontmatter.tags[0];
  }
  if (typeof frontmatter.updated === "string") metadata.updatedAt = frontmatter.updated;
  if (typeof frontmatter.source === "string") metadata.sourceUri = frontmatter.source;
  return {
    id: memory.id,
    text: collapseWhitespace(memory.content),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function buildDelegateMemorySearchTool(options: {
  target: DelegateDaemonTarget;
  runtime: RemnicCapabilityRuntime;
  agentId: string;
  /** Embedded parity: `openclawToolSnippetMaxChars`, applied over the daemon's own cap. */
  snippetMaxChars?: number;
  timeoutMs: number;
}) {
  const spent = (deadline: number, signal: AbortSignal | undefined, stage: string): void => {
    if (signal?.aborted) throw new Error(`memory_search aborted before ${stage}`);
    if (deadline - Date.now() <= 0) throw new Error(`memory_search budget of ${options.timeoutMs}ms spent before ${stage}`);
  };
  return {
    name: "memory_search",
    description: "Search Remnic memories via the Remnic daemon (delegate).",
    parameters: MemorySearchInputSchema,
    inputSchema: MemorySearchInputSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, ctx?: ToolContext) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (query.length === 0) throw new Error("memory_search requires a non-empty query");
      // ONE budget for the whole invocation, opened before the manager is
      // acquired (a cold capability cache probes the daemon there). The
      // manager's own search deadline is the host contract's and cannot be
      // shortened per call, so what is checked here is that it never STARTS
      // after this budget is spent.
      const deadline = Date.now() + options.timeoutMs;
      const { manager, error } = await options.runtime.getMemorySearchManager({
        cfg: undefined,
        agentId: ctx?.agentId ?? options.agentId,
      });
      if (!manager) throw new Error(error ?? "delegate memory search manager unavailable");
      spent(deadline, signal, "scope resolution");
      // One extra hit tells whether the page was cut, which is what the
      // embedded tool reports as `truncated`. Fractions are schema-valid
      // (`Type.Number`), and the manager rejects a non-integer maxResults.
      const limit = clampLimit(params.limit);
      const sessionKey = sessionKeyFor(params, ctx);
      // Delegate searches are session-scoped: `manager.search` resolves the
      // session's namespace ITSELF, so a scope validated here can be rebound
      // before that resolution runs and the search would answer from the new
      // namespace while the caller asked for the old one — a cross-tenant
      // result for a credential that can read both. There is no way to carry a
      // validated scope into the search atomically, so the filter is refused
      // rather than honored approximately.
      const filters = params.filters && typeof params.filters === "object" ? (params.filters as Record<string, unknown>) : undefined;
      if (typeof filters?.namespace === "string" && filters.namespace.trim().length > 0) {
        throw new Error(
          `memory_search filters.namespace "${filters.namespace.trim()}" is not supported in delegate mode: the search is scoped to the session's own namespace`
        );
      }
      spent(deadline, signal, "search");
      // The daemon's search schema caps `query` at 2048 chars; embedded mode
      // accepts any length, so trim rather than turn a valid call into a 400.
      const results = await manager.search(query.slice(0, DAEMON_SEARCH_QUERY_MAX_CHARS), {
        maxResults: limit + 1,
        sessionKey,
      });
      // The public active-memory shape the embedded tool returns: `id` is the
      // `<id>.md` basename (the daemon's own `memoryIdFromPath` convention),
      // `text` the snippet under the configured budget. The manager's absolute
      // `path` stays internal — it names the operator's filesystem, which the
      // model has no use for.
      const output: ActiveMemorySearchOutput = {
        results: results.slice(0, limit).map((result) => ({
          id: path.basename(result.citation ?? result.path, ".md"),
          score: result.score,
          // Read per call: the owner's cap can change on an active takeover.
          text: truncateCodePointSafe(collapseWhitespace(result.snippet), clampSnippetMaxChars(options.snippetMaxChars)),
        })),
        truncated: results.length > limit,
      };
      return toolJsonResult(output);
    },
  };
}

export function buildDelegateMemoryGetTool(options: {
  target: DelegateDaemonTarget;
  serviceId: string;
  timeoutMs: number;
  /**
   * The session's remembered namespace, so get reads where search searched.
   * Given what is LEFT of the tool's deadline: scope resolution and the GET
   * share one budget.
   */
  resolveNamespace: (sessionKey: string, timeoutMs: number) => Promise<string | undefined>;
}) {
  return {
    name: "memory_get",
    description: "Fetch one Remnic memory via the Remnic daemon (delegate).",
    parameters: MemoryGetInputSchema,
    inputSchema: MemoryGetInputSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal, ctx?: ToolContext) {
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (id.length === 0) throw new Error("memory_get requires an id");
      // The daemon's `memoryGetSchema` caps both at 512 chars. No stored id is
      // that long, so embedded mode answers `not_found`; a session key that
      // long is a caller defect, named locally instead of as a daemon 400.
      if (id.length > DAEMON_MEMORY_GET_MAX_CHARS) {
        return toolJsonResult({ error: "not_found" } satisfies ActiveMemoryGetOutput);
      }
      const sessionKey = sessionKeyFor(params, ctx);
      if (sessionKey.length > DAEMON_MEMORY_GET_MAX_CHARS) {
        throw new Error(`memory_get sessionKey exceeds the daemon's ${DAEMON_MEMORY_GET_MAX_CHARS}-char cap`);
      }
      // The session binding decides the scope, never the model: a
      // model-supplied namespace may only restate it. The daemon default is
      // the SAME scope the session's search used, so an unbound session cannot
      // name another tenant's namespace to reach a known memory id.
      const deadline = Date.now() + options.timeoutMs;
      const namespace = await options.resolveNamespace(sessionKey, Math.max(1, deadline - Date.now()));
      const requested =
        typeof params.namespace === "string" && params.namespace.trim().length > 0
          ? params.namespace.trim()
          : undefined;
      if (requested !== undefined && requested !== namespace) {
        throw new Error(
          `memory_get namespace "${requested}" does not match the session's memory scope${namespace === undefined ? "" : ` "${namespace}"`}`
        );
      }
      const search = new URLSearchParams({ sessionKey });
      if (namespace !== undefined) search.set("namespace", namespace);
      const pathname = `/engram/v1/memories/${encodeURIComponent(id)}?${search}`;
      const response = await getJson(options.target, options.serviceId, pathname, Math.max(1, deadline - Date.now()));
      if (response.status === 404) return toolJsonResult({ error: "not_found" } satisfies ActiveMemoryGetOutput);
      // Embedded parity: an unresolvable `[m:xxxx]` handle is a MISS, not an
      // error (`getMemoryForActiveMemory` returns not_found when resolution
      // fails). The daemon reports that as a 400 input error, so only a
      // handle-shaped id gets the translation — other 400s still surface.
      if (response.status === 400 && isHandleToken(id)) {
        return toolJsonResult({ error: "not_found" } satisfies ActiveMemoryGetOutput);
      }
      if (response.status < 200 || response.status > 299) {
        throw new Error(`daemon ${pathname} responded ${response.status}`);
      }
      return toolJsonResult(activeMemoryGetOutputFrom(response.body?.memory));
    },
  };
}

/**
 * Apis that already carry the delegate `memory_search` / `memory_get` tools,
 * with the entry whose closures the tools consult. A passive entry (slot not
 * owned) registers them too, so an active sibling on the SAME api — the
 * canonical and legacy plugin ids load in either order — takes the wiring
 * over: otherwise the tools would keep reading the passive entry's binding
 * store while the active entry's hooks update its own.
 */
type AdoptableTool = { name: string; execute: (...args: never[]) => Promise<unknown> };
/**
 * Ownership of the `memory_search` / `memory_get` names on one api.
 *
 * Both bridge modes register through this record: the canonical and legacy
 * plugin ids register separately against one api and either can arrive first,
 * so whoever registers a name keeps its identity (the host exposes no
 * unregister, and a second `memory_search` is a name conflict) while the
 * ACTIVE slot owner decides what that name executes.
 */
type DelegateToolOwner = {
  enabled: boolean;
  passive: boolean;
  /** Tool names already registered on this api; a takeover adds what is missing. */
  installed: Set<string>;
  /**
   * What each registered name executes right now. The ACTIVE slot owner puts
   * its own implementations here, so a name registered by a passive sibling
   * (of either bridge mode) is repointed rather than registered twice.
   */
  serve: Record<string, AdoptableTool>;
};

/**
 * Register `tools` on the api under the shared ownership record: each name is
 * registered at most once, behind a wrapper that dispatches through
 * `owner.serve`, and the caller's implementations become what those names run.
 */
function installSharedTools(
  registerTool: (tool: Record<string, unknown>, opts?: { name?: string }) => void,
  owner: DelegateToolOwner,
  tools: readonly AdoptableTool[],
): void {
  for (const tool of tools) owner.serve[tool.name] = tool;
  for (const tool of tools) {
    if (owner.installed.has(tool.name)) continue;
    owner.installed.add(tool.name);
    registerTool(
      {
        ...tool,
        execute: async (...args: never[]) => {
          const serving = owner.serve[tool.name] ?? tool;
          if (!owner.enabled && tool.name !== "memory_search") {
            throw new Error(`${tool.name} is disabled: the memory slot owner set openclawToolsEnabled: false`);
          }
          return serving.execute(...args);
        },
      } as unknown as Record<string, unknown>,
      { name: tool.name },
    );
  }
}
const delegateToolOwners = new WeakMap<object, DelegateToolOwner>();

type DelegateToolWiring = {
  target: DelegateDaemonTarget;
  serviceId: string;
  runtime: RemnicCapabilityRuntime;
  agentId: string;
  snippetMaxChars?: number;
  timeoutMs: number;
  /** The session's remembered binding, else the registration scope. */
  resolveSearchNamespace: (sessionKey: unknown) => Promise<string | undefined>;
  /** The capability's resolver: the daemon's concrete default for an unbound session. */
  resolveScopedNamespace: (
    explicit: string | undefined,
    timeoutMs: number,
    operations: readonly string[]
  ) => Promise<string | undefined>;
};

/**
 * Register the daemon-backed tools on a host that exposes `registerTool`.
 * Embedded mode builds these over the in-process orchestrator, delegate mode
 * over the daemon (tool-discovery hosts register in this mode and expose
 * nothing without them). The operator's `openclawToolsEnabled: false` opt-out
 * holds in both modes.
 */
export function registerDelegateTools(
  api: { registerTool?(tool: Record<string, unknown>, opts?: { name?: string }): void },
  options: DelegateToolWiring & { enabled: boolean; passive: boolean }
): void {
  if (typeof api.registerTool !== "function") return;
  const registerTool = api.registerTool.bind(api);
  // Once per api object: the canonical and legacy plugin ids both register
  // here, and a second `memory_search` on one api is a host tool-name
  // conflict, not a second tool. The tools read their wiring through the
  // owner record, so an active entry arriving after a passive one takes it
  // over — its opt-out included: the host exposes no unregister, so tools a
  // passive sibling already installed go inert. A disabled entry records
  // itself too: as the slot owner it is a tombstone a later enabled passive
  // sibling cannot bypass; as a passive entry it yields like any other.
  const existing = delegateToolOwners.get(api);
  const owner: DelegateToolOwner = existing ?? {
    enabled: options.enabled,
    passive: options.passive,
    installed: new Set<string>(),
    serve: {},
  };
  if (existing === undefined) delegateToolOwners.set(api, owner);
  else if (existing.passive && !options.passive) {
    // An ACTIVE delegate entry takes the names over from a passive sibling of
    // either mode: that sibling's implementations belong to a runtime which
    // does not own the memory slot.
    owner.enabled = options.enabled;
    owner.passive = options.passive;
  } else return;
  // `openclawToolsEnabled` is an ADAPTER toggle (see the manifest), not a
  // global tool opt-out: embedded mode answers it by registering its legacy
  // `memory_search` instead of the adapters, so a search surface always
  // survives. Delegate mode has no separate legacy implementation, so the
  // daemon-backed search stays registered and only `memory_get` — which
  // exists solely as an adapter — goes away with the flag.
  //
  // The SAME trusted scope path the capability's search takes: the session
  // binding, then the daemon's concrete default for an unbound session — never
  // an omitted namespace a scoped credential would refuse. The binding lookup
  // spends from the same budget as the daemon call.
  const resolveNamespace = (operation: string) => async (sessionKey: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    const bound = await options.resolveSearchNamespace(sessionKey);
    return options.resolveScopedNamespace(bound, Math.max(1, deadline - Date.now()), [operation]);
  };
  const tools: AdoptableTool[] = [buildDelegateMemorySearchTool(options)];
  if (owner.enabled) {
    tools.push(
      buildDelegateMemoryGetTool({
        target: options.target,
        serviceId: options.serviceId,
        timeoutMs: options.timeoutMs,
        resolveNamespace: resolveNamespace("memory_get"),
      }),
    );
  }
  installSharedTools(registerTool, owner, tools);
}

/**
 * Register the EMBEDDED runtime's memory tools through the same ownership
 * record the delegate path uses, and report which names the api now carries.
 *
 * Either bridge mode can register first on one api (canonical and legacy
 * plugin ids register separately, and a passive entry registers tools too).
 * One record means a name is registered exactly once, whoever arrives second
 * repoints it instead of colliding, and the ACTIVE entry decides what it runs.
 * The returned names are the ones the caller must NOT register itself —
 * including through its legacy fallback.
 */
export function registerEmbeddedTools(
  api: { registerTool?(tool: Record<string, unknown>, opts?: { name?: string }): void },
  options: { enabled: boolean; passive: boolean; tools: readonly AdoptableTool[] },
): string[] {
  if (typeof api.registerTool !== "function") return [];
  const registerTool = api.registerTool.bind(api);
  const existing = delegateToolOwners.get(api);
  const owner: DelegateToolOwner = existing ?? {
    enabled: options.enabled,
    passive: options.passive,
    installed: new Set<string>(),
    serve: {},
  };
  if (existing === undefined) delegateToolOwners.set(api, owner);
  // A PASSIVE entry never displaces what an ACTIVE owner is serving.
  else if (options.passive && !existing.passive) return [...owner.installed];
  else if (!options.passive) {
    owner.enabled = options.enabled;
    owner.passive = false;
  }
  installSharedTools(registerTool, owner, options.tools);
  return [...owner.installed];
}
