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
  if (typeof record !== "object" || record === null) return { error: "not_found" };
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
}) {
  const snippetMaxChars = clampSnippetMaxChars(options.snippetMaxChars);
  return {
    name: "memory_search",
    description: "Search Remnic memories via the Remnic daemon (delegate).",
    parameters: MemorySearchInputSchema,
    inputSchema: MemorySearchInputSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal, ctx?: ToolContext) {
      const query = typeof params.query === "string" && params.query.trim().length > 0 ? params.query : null;
      if (!query) throw new Error("memory_search requires a non-empty query");
      const { manager, error } = await options.runtime.getMemorySearchManager({
        cfg: undefined,
        agentId: ctx?.agentId ?? options.agentId,
      });
      if (!manager) throw new Error(error ?? "delegate memory search manager unavailable");
      // One extra hit tells whether the page was cut, which is what the
      // embedded tool reports as `truncated`. Fractions are schema-valid
      // (`Type.Number`), and the manager rejects a non-integer maxResults.
      const limit = clampLimit(params.limit);
      // The daemon's search schema caps `query` at 2048 chars; embedded mode
      // accepts any length, so trim rather than turn a valid call into a 400.
      const results = await manager.search(query.slice(0, DAEMON_SEARCH_QUERY_MAX_CHARS), {
        maxResults: limit + 1,
        sessionKey: sessionKeyFor(params, ctx),
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
          text: truncateCodePointSafe(collapseWhitespace(result.snippet), snippetMaxChars),
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
      const id = typeof params.id === "string" && params.id.trim().length > 0 ? params.id : null;
      if (!id) throw new Error("memory_get requires an id");
      const sessionKey = sessionKeyFor(params, ctx);
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

/** Apis that already carry the delegate `memory_search` / `memory_get` tools. */
const delegateToolApis = new WeakSet<object>();

/**
 * Register the daemon-backed tools on a host that exposes `registerTool`.
 * Embedded mode builds these over the in-process orchestrator, delegate mode
 * over the daemon (tool-discovery hosts register in this mode and expose
 * nothing without them). The operator's `openclawToolsEnabled: false` opt-out
 * holds in both modes.
 */
export function registerDelegateTools(
  api: { registerTool?(tool: Record<string, unknown>, opts?: { name?: string }): void },
  options: {
    target: DelegateDaemonTarget;
    serviceId: string;
    enabled: boolean;
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
  }
): void {
  if (!options.enabled || typeof api.registerTool !== "function") return;
  // Once per api object: the canonical and legacy plugin ids both register
  // here, and a second `memory_search` on one api is a host tool-name
  // conflict, not a second tool.
  if (delegateToolApis.has(api)) return;
  delegateToolApis.add(api);
  api.registerTool(
    buildDelegateMemorySearchTool({
      target: options.target,
      runtime: options.runtime,
      agentId: options.agentId,
      snippetMaxChars: options.snippetMaxChars,
    })
  );
  api.registerTool(
    buildDelegateMemoryGetTool({
      target: options.target,
      serviceId: options.serviceId,
      timeoutMs: options.timeoutMs,
      // The SAME trusted scope path search takes: the session binding, then
      // the daemon's concrete default for an unbound session — never an
      // omitted namespace a scoped credential would refuse. The binding
      // lookup spends from the same budget as the daemon call.
      resolveNamespace: async (sessionKey, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        const bound = await options.resolveSearchNamespace(sessionKey);
        return options.resolveScopedNamespace(bound, Math.max(1, deadline - Date.now()), ["memory_get"]);
      },
    })
  );
}
