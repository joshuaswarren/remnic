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

function activeMemoryGetOutputFrom(record: unknown): ActiveMemoryGetOutput {
  if (typeof record !== "object" || record === null) {
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
      const deadline = Date.now() + options.timeoutMs;
      const { manager, error } = await options.runtime.getMemorySearchManager({
        cfg: undefined,
        agentId: ctx?.agentId ?? options.agentId,
      });
      if (!manager) throw new Error(error ?? "delegate memory search manager unavailable");
      spent(deadline, signal, "scope resolution");
      const limit = clampLimit(params.limit);
      const sessionKey = sessionKeyFor(params, ctx);
      const filters = params.filters && typeof params.filters === "object" ? (params.filters as Record<string, unknown>) : undefined;
      if (typeof filters?.namespace === "string" && filters.namespace.trim().length > 0) {
        throw new Error(
          `memory_search filters.namespace "${filters.namespace.trim()}" is not supported in delegate mode: the search is scoped to the session's own namespace`
        );
      }
      spent(deadline, signal, "search");
      const results = await manager.search(query.slice(0, DAEMON_SEARCH_QUERY_MAX_CHARS), {
        maxResults: limit + 1,
        sessionKey,
      });
      const output: ActiveMemorySearchOutput = {
        results: results.slice(0, limit).map((result) => ({
          id: path.basename(result.citation ?? result.path, ".md"),
          score: result.score,
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
      if (id.length > DAEMON_MEMORY_GET_MAX_CHARS) {
        return toolJsonResult({ error: "not_found" } satisfies ActiveMemoryGetOutput);
      }
      const sessionKey = sessionKeyFor(params, ctx);
      if (sessionKey.length > DAEMON_MEMORY_GET_MAX_CHARS) {
        throw new Error(`memory_get sessionKey exceeds the daemon's ${DAEMON_MEMORY_GET_MAX_CHARS}-char cap`);
      }
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

type AdoptableTool = { name: string; execute: (...args: never[]) => Promise<unknown> };
type DelegateToolOwner = {
  enabled: boolean;
  passive: boolean;
  installed: Set<string>;
  serve: Record<string, AdoptableTool>;
};

const SHARED_TOOL_SHAPES: Record<string, { description: string; parameters: unknown }> = {
  memory_search: {
    description: "Search Remnic memories for the OpenClaw active-memory surface.",
    parameters: MemorySearchInputSchema,
  },
  memory_get: {
    description: "Fetch one Remnic memory for the OpenClaw active-memory surface.",
    parameters: MemoryGetInputSchema,
  },
};

function installSharedTools(
  registerTool: (tool: Record<string, unknown>, opts?: { name?: string }) => void,
  owner: DelegateToolOwner,
  tools: readonly AdoptableTool[],
): void {
  for (const tool of tools) owner.serve[tool.name] = tool;
  for (const tool of tools) {
    if (owner.installed.has(tool.name)) continue;
    owner.installed.add(tool.name);
    const shape = SHARED_TOOL_SHAPES[tool.name];
    registerTool(
      {
        ...tool,
        ...(shape === undefined
          ? {}
          : { description: shape.description, parameters: shape.parameters, inputSchema: shape.parameters }),
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

export function registerDelegateTools(
  api: { registerTool?(tool: Record<string, unknown>, opts?: { name?: string }): void },
  options: DelegateToolWiring & { enabled: boolean; passive: boolean }
): void {
  if (typeof api.registerTool !== "function") return;
  const registerTool = api.registerTool.bind(api);
  const existing = delegateToolOwners.get(api);
  const owner: DelegateToolOwner = existing ?? {
    enabled: options.enabled,
    passive: options.passive,
    installed: new Set<string>(),
    serve: {},
  };
  if (existing === undefined) delegateToolOwners.set(api, owner);
  else if (existing.passive && !options.passive) {
    owner.enabled = options.enabled;
    owner.passive = options.passive;
  } else return;
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
