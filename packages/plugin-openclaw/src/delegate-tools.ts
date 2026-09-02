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
  /** The session's memory scope, so a `filters.namespace` may only restate it. */
  resolveNamespace: (sessionKey: string, timeoutMs: number) => Promise<string | undefined>;
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
      // Delegate searches stay session-scoped (the manager resolves the scope
      // itself). A schema-valid `filters.namespace` is honored by the embedded
      // tool, so here it may restate that scope but never silently search
      // another one.
      const filters = params.filters && typeof params.filters === "object" ? (params.filters as Record<string, unknown>) : undefined;
      const requested = typeof filters?.namespace === "string" && filters.namespace.trim().length > 0 ? filters.namespace.trim() : undefined;
      if (requested !== undefined) {
        const scope = await options.resolveNamespace(sessionKey, Math.max(1, deadline - Date.now()));
        if (requested !== scope) {
          throw new Error(
            `memory_search filters.namespace "${requested}" does not match the session's memory scope${scope === undefined ? "" : ` "${scope}"`}`
          );
        }
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
const delegateToolOwners = new WeakMap<object, DelegateToolWiring & { enabled: boolean; passive: boolean }>();

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
  // Once per api object: the canonical and legacy plugin ids both register
  // here, and a second `memory_search` on one api is a host tool-name
  // conflict, not a second tool. The tools read their wiring through the
  // owner record, so an active entry arriving after a passive one takes it
  // over without re-registering — its opt-out included: the host exposes no
  // unregister, so tools a passive sibling already installed go inert.
  const existing = delegateToolOwners.get(api);
  if (existing !== undefined) {
    if (existing.passive && !options.passive) Object.assign(existing, options);
    return;
  }
  if (!options.enabled) return;
  const owner = { ...options };
  delegateToolOwners.set(api, owner);
  const gated = <T extends { name: string; execute: (...args: never[]) => Promise<unknown> }>(tool: T): T => ({
    ...tool,
    execute: async (...args: Parameters<T["execute"]>) => {
      if (!owner.enabled) throw new Error(`${tool.name} is disabled: the memory slot owner set openclawToolsEnabled: false`);
      return tool.execute(...args);
    },
  });
  // The SAME trusted scope path the capability's search takes: the session
  // binding, then the daemon's concrete default for an unbound session — never
  // an omitted namespace a scoped credential would refuse. The binding lookup
  // spends from the same budget as the daemon call.
  const resolveNamespace = (operation: string) => async (sessionKey: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    const bound = await owner.resolveSearchNamespace(sessionKey);
    return owner.resolveScopedNamespace(bound, Math.max(1, deadline - Date.now()), [operation]);
  };
  api.registerTool(
    gated(buildDelegateMemorySearchTool({
      get target() { return owner.target; },
      get runtime() { return owner.runtime; },
      get agentId() { return owner.agentId; },
      get snippetMaxChars() { return owner.snippetMaxChars; },
      get timeoutMs() { return owner.timeoutMs; },
      resolveNamespace: resolveNamespace("memory_search"),
    })),
  );
  api.registerTool(
    gated(buildDelegateMemoryGetTool({
      get target() { return owner.target; },
      get serviceId() { return owner.serviceId; },
      get timeoutMs() { return owner.timeoutMs; },
      resolveNamespace: resolveNamespace("memory_get"),
    })),
  );
}
