/**
 * Daemon-backed `memory_search` / `memory_get` tools for delegate mode.
 *
 * Embedded mode builds these over the in-process orchestrator
 * (`openclaw-tools/`). Delegate mode has no orchestrator, so search goes
 * through the daemon-backed capability manager — the SAME scoping,
 * authorization, and artifact-isolation path the host's own memory search
 * uses — and get reads the daemon's memory route.
 */

import type { DelegateDaemonTarget } from "./bridge.js";
import { getJson } from "./delegate-http.js";
import type { RemnicCapabilityRuntime } from "./memory-capability-types.js";
import { MemoryGetInputSchema, MemorySearchInputSchema } from "./openclaw-tools/shapes.js";
import { toolJsonResult } from "./openclaw-tools/tool-json-result.js";

const DEFAULT_SEARCH_RESULTS = 8;

interface ToolContext {
  sessionKey?: string;
  agentId?: string;
}

function sessionKeyFor(params: Record<string, unknown>, ctx: ToolContext | undefined): string {
  if (typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim().length > 0) {
    return ctx.sessionKey;
  }
  return typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0
    ? params.sessionKey
    : "default";
}

export function buildDelegateMemorySearchTool(options: {
  target: DelegateDaemonTarget;
  runtime: RemnicCapabilityRuntime;
  agentId: string;
}) {
  return {
    name: "memory_search",
    description: "Search Remnic memories via the Remnic daemon (delegate).",
    parameters: MemorySearchInputSchema,
    inputSchema: MemorySearchInputSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      ctx?: ToolContext,
    ) {
      const query =
        typeof params.query === "string" && params.query.trim().length > 0 ? params.query : null;
      if (!query) throw new Error("memory_search requires a non-empty query");
      const { manager, error } = await options.runtime.getMemorySearchManager({
        cfg: undefined,
        agentId: ctx?.agentId ?? options.agentId,
      });
      if (!manager) throw new Error(error ?? "delegate memory search manager unavailable");
      const results = await manager.search(query, {
        maxResults: typeof params.limit === "number" ? params.limit : DEFAULT_SEARCH_RESULTS,
        sessionKey: sessionKeyFor(params, ctx),
      });
      return toolJsonResult({
        query,
        count: results.length,
        results,
        remnic: { bridgeMode: "delegate", daemon: `${options.target.host}:${options.target.port}` },
      });
    },
  };
}

export function buildDelegateMemoryGetTool(options: {
  target: DelegateDaemonTarget;
  serviceId: string;
  timeoutMs: number;
  /** The session's remembered namespace, so get reads where search searched. */
  resolveNamespace: (sessionKey: string) => Promise<string | undefined>;
}) {
  return {
    name: "memory_get",
    description: "Fetch one Remnic memory via the Remnic daemon (delegate).",
    parameters: MemoryGetInputSchema,
    inputSchema: MemoryGetInputSchema,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      ctx?: ToolContext,
    ) {
      const id = typeof params.id === "string" && params.id.trim().length > 0 ? params.id : null;
      if (!id) throw new Error("memory_get requires an id");
      const sessionKey = sessionKeyFor(params, ctx);
      const namespace =
        typeof params.namespace === "string" && params.namespace.trim().length > 0
          ? params.namespace.trim()
          : await options.resolveNamespace(sessionKey);
      const search = new URLSearchParams({ sessionKey });
      if (namespace !== undefined) search.set("namespace", namespace);
      const pathname = `/engram/v1/memories/${encodeURIComponent(id)}?${search}`;
      const response = await getJson(options.target, options.serviceId, pathname, options.timeoutMs);
      if (response.status === 404) return toolJsonResult({ found: false, id });
      if (response.status < 200 || response.status > 299) {
        throw new Error(`daemon ${pathname} responded ${response.status}`);
      }
      return toolJsonResult(response.body);
    },
  };
}
