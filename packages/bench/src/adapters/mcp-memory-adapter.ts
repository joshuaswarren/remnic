import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { MemCorrectSystemAdapter } from "../benchmarks/remnic/memcorrect/types.js";
import type {
  BenchMemoryAdapter,
  BenchPhaseControl,
  BenchRecallOptions,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";

export type McpBackendErrorCode = "backend_unusable" | "transport_failure" | "tool_failure" | "invalid_response";

export type McpBackendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: McpBackendErrorCode; detail: string; cause?: unknown };

export class McpMemoryBackendError extends Error {
  readonly code: McpBackendErrorCode;
  readonly detail: string;
  constructor(result: Extract<McpBackendResult<never>, { ok: false }>) {
    super(`${result.error}: ${result.detail}`, { cause: result.cause });
    this.name = "McpMemoryBackendError";
    this.code = result.error;
    this.detail = result.detail;
  }
}

export interface McpStdioTransportConfig {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpTransportConfig {
  type: "http";
  url: string;
  bearerToken?: string;
  headers?: Record<string, string>;
}

export type McpMemoryTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export type McpToolOperation = "store" | "recall" | "correct" | "reset";
export type McpArgumentSemantic = "namespace" | "sessionId" | "content" | "role" | "timestamp" | "query" | "limit";

export interface McpToolMappingEntry {
  name: string;
  /** Map semantic input names to the server tool's argument names. */
  arguments?: Partial<Record<McpArgumentSemantic, string>>;
  /** Optional dot path into structured/JSON output, e.g. `data.memories`. */
  resultPath?: string;
}

export type McpToolMappingValue = string | McpToolMappingEntry;
export type McpMemoryToolMapping = Partial<Record<McpToolOperation, McpToolMappingValue>>;

export interface McpListedTool {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolClient {
  listTools(control?: BenchPhaseControl): Promise<McpListedTool[]>;
  callTool(name: string, args: Record<string, unknown>, control?: BenchPhaseControl): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpMemoryAdapterOptions {
  transport: McpMemoryTransportConfig;
  tools?: McpMemoryToolMapping;
  /** Stable override for reproducible tests; production defaults are unique. */
  namespacePrefix?: string;
  label?: string;
  skipPreflight?: boolean;
  /** Bounds connection, discovery, and the conformance canary. */
  timeoutMs?: number;
  clientFactory?: (transport: McpMemoryTransportConfig, control?: BenchPhaseControl) => Promise<McpToolClient>;
}

export type McpConformanceResult =
  | {
      ok: true;
      value: { tools: Record<McpToolOperation, string>; namespace: string };
    }
  | { ok: false; error: "backend_unusable"; detail: string; cause?: unknown };

interface ResolvedTool {
  name: string;
  arguments: Partial<Record<McpArgumentSemantic, string>>;
  resultPath?: string;
  schemaProperties: string[];
}

const DEFAULT_TOOL_NAMES: Record<McpToolOperation, readonly string[]> = {
  store: ["store_memory", "add_memory", "memory_store", "create_memory"],
  recall: ["search_memory", "recall", "memory_search", "search_memories"],
  correct: ["correct_memory", "update_memory", "memory_correct", "update_memories"],
  reset: ["delete_memory", "clear_memories", "memory_delete", "reset_memory"],
};

const ARGUMENT_ALIASES: Record<McpArgumentSemantic, readonly string[]> = {
  namespace: ["namespace", "scope", "user_id", "userId", "run_id"],
  sessionId: ["sessionId", "session_id", "session", "conversation_id"],
  content: ["content", "text", "memory", "message", "correction"],
  role: ["role", "speaker"],
  timestamp: ["timestamp", "at", "created_at"],
  query: ["query", "search", "q", "text"],
  limit: ["limit", "top_k", "count", "max_results"],
};

const TOOL_OPERATIONS = Object.freeze([
  "store",
  "recall",
  "correct",
  "reset",
] as const satisfies readonly McpToolOperation[]);
const ARGUMENT_SEMANTICS = Object.freeze([
  "namespace",
  "sessionId",
  "content",
  "role",
  "timestamp",
  "query",
  "limit",
] as const satisfies readonly McpArgumentSemantic[]);
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

let namespaceCounter = 0;

function createNamespacePrefix(): string {
  namespaceCounter += 1;
  return `remnic-bench-${process.pid.toString(36)}-${Date.now().toString(36)}-${namespaceCounter.toString(36)}`;
}

class SdkMcpToolClient implements McpToolClient {
  private constructor(private readonly client: Client) {}

  static async connect(config: McpMemoryTransportConfig, control?: BenchPhaseControl): Promise<SdkMcpToolClient> {
    const client = new Client({ name: "remnic-bench", version: "1.0.0" });
    const transport =
      config.type === "stdio"
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: config.env,
            stderr: "inherit",
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: {
              headers: {
                ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
                ...(config.headers ?? {}),
              },
            },
          });
    try {
      await client.connect(transport, { signal: control?.signal });
      return new SdkMcpToolClient(client);
    } catch (error) {
      await raceWithSignal(client.close(), AbortSignal.timeout(2_000), "MCP SDK client close").catch(() => {});
      throw error;
    }
  }

  async listTools(control?: BenchPhaseControl): Promise<McpListedTool[]> {
    const result = await this.client.listTools(undefined, { signal: control?.signal });
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, control?: BenchPhaseControl): Promise<McpToolCallResult> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal: control?.signal });
    if ("toolResult" in result) {
      return { structuredContent: { result: result.toolResult } };
    }
    return result as McpToolCallResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class McpMemoryBackend {
  readonly label: string;
  readonly namespacePrefix: string;
  private client?: McpToolClient;
  private resolvedTools?: Record<McpToolOperation, ResolvedTool>;
  private preflightResult?: McpConformanceResult;
  private readonly sessions = new Set<string>();
  private readonly messageCounts = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(private readonly options: McpMemoryAdapterOptions) {
    validateMcpToolMapping(options.tools);
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("MCP adapter timeoutMs must be a positive integer");
    }
    this.label = options.label ?? "mcp";
    this.namespacePrefix = options.namespacePrefix ?? createNamespacePrefix();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  }

  async preflight(control?: BenchPhaseControl): Promise<McpConformanceResult> {
    if (this.preflightResult) return this.preflightResult;
    try {
      this.preflightResult = await withTimeoutControl(
        this.timeoutMs,
        control,
        "MCP adapter preflight",
        async (boundedControl) => {
          await this.ensureResolved(boundedControl);
          const sessionId = "conformance";
          const oldToken = `canary-old-${this.namespacePrefix}`;
          const newToken = `canary-new-${this.namespacePrefix}`;
          await this.store(sessionId, [{ role: "user", content: oldToken }], boundedControl, true);
          const before = await this.recall(sessionId, oldToken, 4_000, boundedControl, true);
          if (!before.some((item) => item.includes(oldToken))) {
            throw new Error("stored canary was not returned by recall");
          }
          const applied = await this.correct(
            sessionId,
            `Correction: replace ${oldToken} with ${newToken}.`,
            undefined,
            boundedControl,
            true
          );
          if (!applied) {
            throw new Error("correction canary was explicitly refused (applied=false)");
          }
          const after = await this.recall(sessionId, newToken, 4_000, boundedControl, true);
          if (!after.some((item) => item.includes(newToken))) {
            throw new Error("corrected canary was not returned by recall");
          }
          if (after.some((item) => item.includes(oldToken))) {
            throw new Error("retired canary was still returned after correction");
          }
          await this.reset(sessionId, boundedControl, true);
          const deleted = await this.recall(sessionId, newToken, 4_000, boundedControl, true);
          if (deleted.some((item) => item.includes(newToken) || item.includes(oldToken))) {
            throw new Error("reset did not remove the conformance canary namespace");
          }
          return {
            ok: true,
            value: {
              tools: Object.fromEntries(
                Object.entries(this.resolvedTools!).map(([key, value]) => [key, value.name])
              ) as Record<McpToolOperation, string>,
              namespace: this.namespacePrefix,
            },
          };
        }
      );
    } catch (cause) {
      const conformanceSession = this.scopedSession("conformance");
      if (this.client && this.resolvedTools && this.sessions.has(conformanceSession)) {
        try {
          await withTimeoutControl(
            Math.min(this.timeoutMs, 2_000),
            undefined,
            "MCP conformance cleanup",
            (cleanupControl) => this.reset("conformance", cleanupControl, true)
          );
        } catch {
          // Preserve the original conformance failure.
        }
      }
      await this.closeClient();
      this.preflightResult = {
        ok: false,
        error: "backend_unusable",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
    }
    return this.preflightResult;
  }

  async assertUsable(control?: BenchPhaseControl): Promise<void> {
    if (this.options.skipPreflight) {
      await this.ensureResolved(control);
      return;
    }
    const result = await this.preflight(control);
    if (!result.ok) throw new McpMemoryBackendError(result);
  }

  async store(
    sessionId: string,
    messages: Message[],
    control?: BenchPhaseControl,
    duringPreflight = false
  ): Promise<void> {
    if (!duringPreflight) await this.assertUsable(control);
    const scoped = this.scopedSession(sessionId);
    this.sessions.add(scoped);
    for (const message of messages) {
      const payload = await this.invoke(
        "store",
        {
          namespace: this.namespacePrefix,
          sessionId: scoped,
          content: message.content,
          role: message.role,
          timestamp: message.timestamp,
        },
        control
      );
      if (!validateMutationAcknowledgement("store", payload)) {
        throw invalidResponse("store", "server returned a negative acknowledgement");
      }
      this.messageCounts.set(scoped, (this.messageCounts.get(scoped) ?? 0) + 1);
    }
  }

  async recall(
    sessionId: string,
    query: string,
    budgetChars = 16_000,
    control?: BenchPhaseControl,
    duringPreflight = false
  ): Promise<string[]> {
    if (!duringPreflight) await this.assertUsable(control);
    const raw = await this.invoke(
      "recall",
      {
        namespace: this.namespacePrefix,
        sessionId: this.scopedSession(sessionId),
        query,
        limit: 20,
      },
      control
    );
    const strings = validateRecallResponse(raw);
    const output: string[] = [];
    let used = 0;
    for (const value of strings) {
      if (used >= budgetChars) break;
      const remaining = budgetChars - used;
      output.push(value.slice(0, remaining));
      used += Math.min(value.length, remaining);
    }
    return output;
  }

  async correct(
    sessionId: string,
    text: string,
    at?: string,
    control?: BenchPhaseControl,
    duringPreflight = false
  ): Promise<boolean> {
    if (!duringPreflight) await this.assertUsable(control);
    const scoped = this.scopedSession(sessionId);
    this.sessions.add(scoped);
    const payload = await this.invoke(
      "correct",
      {
        namespace: this.namespacePrefix,
        sessionId: scoped,
        content: text,
        timestamp: at,
      },
      control
    );
    return validateMutationAcknowledgement("correct", payload);
  }

  async reset(sessionId?: string, control?: BenchPhaseControl, duringPreflight = false): Promise<void> {
    if (!duringPreflight) await this.assertUsable(control);
    const targets = sessionId ? [this.scopedSession(sessionId)] : [...this.sessions];
    for (const target of targets) {
      const payload = await this.invoke(
        "reset",
        {
          namespace: this.namespacePrefix,
          sessionId: target,
        },
        control
      );
      if (!validateMutationAcknowledgement("reset", payload)) {
        throw invalidResponse("reset", "server returned a negative acknowledgement");
      }
      this.sessions.delete(target);
      this.messageCounts.delete(target);
    }
  }

  getStats(sessionId?: string): MemoryStats {
    const targets = sessionId ? [this.scopedSession(sessionId)] : [...this.messageCounts.keys()];
    return {
      totalMessages: targets.reduce((sum, target) => sum + (this.messageCounts.get(target) ?? 0), 0),
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  }

  async destroy(): Promise<void> {
    try {
      if (this.client && this.resolvedTools) {
        await withTimeoutControl(Math.min(this.timeoutMs, 2_000), undefined, "MCP adapter cleanup", (cleanupControl) =>
          this.reset(undefined, cleanupControl, true)
        );
      }
    } finally {
      await this.closeClient();
    }
  }

  private scopedSession(sessionId: string): string {
    return `${this.namespacePrefix}:${sessionId}`;
  }

  private async ensureResolved(control?: BenchPhaseControl): Promise<void> {
    if (this.resolvedTools) return;
    let candidate: McpToolClient | undefined;
    try {
      const pendingClient = (this.options.clientFactory ?? SdkMcpToolClient.connect)(this.options.transport, control);
      candidate = await raceWithSignal(pendingClient, control?.signal, "MCP client connection", async (lateClient) => {
        await closeToolClient(lateClient, this.timeoutMs);
      });
      const listed = await raceWithSignal(candidate.listTools(control), control?.signal, "MCP tool discovery");
      const resolved = resolveTools(listed, this.options.tools);
      this.client = candidate;
      this.resolvedTools = resolved;
    } catch (cause) {
      if (candidate) await closeToolClient(candidate, this.timeoutMs);
      this.client = undefined;
      this.resolvedTools = undefined;
      throw new McpMemoryBackendError({
        ok: false,
        error: "transport_failure",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }
  }

  private async invoke(
    operation: McpToolOperation,
    values: Partial<Record<McpArgumentSemantic, unknown>>,
    control?: BenchPhaseControl
  ): Promise<unknown> {
    await this.ensureResolved(control);
    const tool = this.resolvedTools![operation];
    const args = buildArguments(tool, values);
    try {
      const result = await this.client!.callTool(tool.name, args, control);
      if (result.isError) {
        throw new Error(
          extractStrings(readToolPayload(result, tool.resultPath)).join("; ") || "MCP tool returned isError=true"
        );
      }
      return readToolPayload(result, tool.resultPath);
    } catch (cause) {
      if (cause instanceof McpMemoryBackendError) throw cause;
      throw new McpMemoryBackendError({
        ok: false,
        error: "tool_failure",
        detail: `${operation} tool ${tool.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.resolvedTools = undefined;
    if (client) await closeToolClient(client, this.timeoutMs);
  }
}

export interface McpBenchMemoryAdapter extends BenchMemoryAdapter {
  readonly label: string;
  readonly namespacePrefix: string;
  preflight(control?: BenchPhaseControl): Promise<McpConformanceResult>;
}

export async function createMcpMemoryAdapter(options: McpMemoryAdapterOptions): Promise<McpBenchMemoryAdapter> {
  const backend = new McpMemoryBackend(options);
  const adapter: McpBenchMemoryAdapter = {
    label: backend.label,
    namespacePrefix: backend.namespacePrefix,
    preflight: (control) => backend.preflight(control),
    store: (sessionId, messages, control) => backend.store(sessionId, messages, control),
    async recall(sessionId, query, budgetChars, _options?: BenchRecallOptions, control?: BenchPhaseControl) {
      return (await backend.recall(sessionId, query, budgetChars, control)).join("\n");
    },
    async search(query, limit, sessionId, control): Promise<SearchResult[]> {
      const recalled = await backend.recall(sessionId ?? "global", query, 64_000, control);
      return recalled.slice(0, limit).map((snippet, turnIndex) => ({
        turnIndex,
        role: "memory",
        snippet,
        sessionId: sessionId ?? "global",
      }));
    },
    async correct(sessionId, text, at, control) {
      return { applied: await backend.correct(sessionId, text, at, control) };
    },
    reset: (sessionId, control) => backend.reset(sessionId, control),
    getStats: async (sessionId) => backend.getStats(sessionId),
    destroy: () => backend.destroy(),
  };
  try {
    const preflight = await adapter.preflight();
    if (!preflight.ok) throw new McpMemoryBackendError(preflight);
    return adapter;
  } catch (error) {
    await backend.destroy();
    throw error;
  }
}

/** Create the packaged, deterministic, keyless stdio MCP demo adapter. */
export function createMcpDemoMemoryAdapter(
  options: Omit<McpMemoryAdapterOptions, "transport"> = {}
): Promise<McpBenchMemoryAdapter> {
  return createMcpMemoryAdapter({
    ...options,
    transport: resolveDemoTransport(),
  });
}

export interface McpMemCorrectAdapter extends MemCorrectSystemAdapter {
  readonly namespacePrefix: string;
  preflight(): Promise<McpConformanceResult>;
  destroy(): Promise<void>;
}

export async function createMcpMemCorrectAdapter(options: McpMemoryAdapterOptions): Promise<McpMemCorrectAdapter> {
  const backend = new McpMemoryBackend(options);
  const adapter: McpMemCorrectAdapter = {
    label: backend.label,
    namespacePrefix: backend.namespacePrefix,
    preflight: () => backend.preflight(),
    reset: () => backend.reset(),
    ingestTurn: (sessionKey, role, text, at) => backend.store(sessionKey, [{ role, content: text, timestamp: at }]),
    recall: (query, sessionKey) => backend.recall(sessionKey, query),
    correct: async (text, sessionKey, at) => {
      const applied = await backend.correct(sessionKey, text, at);
      if (!applied) {
        throw new McpMemoryBackendError({
          ok: false,
          error: "tool_failure",
          detail: "correct tool refused the correction (applied=false)",
        });
      }
    },
    runMaintenance: async () => {},
    destroy: () => backend.destroy(),
  };
  try {
    const preflight = await adapter.preflight();
    if (!preflight.ok) throw new McpMemoryBackendError(preflight);
    return adapter;
  } catch (error) {
    await backend.destroy();
    throw error;
  }
}

/** MemCorrect facade over the packaged deterministic demo MCP server. */
export function createMcpDemoMemCorrectAdapter(
  options: Omit<McpMemoryAdapterOptions, "transport"> = {}
): Promise<McpMemCorrectAdapter> {
  return createMcpMemCorrectAdapter({
    ...options,
    transport: resolveDemoTransport(),
  });
}

function resolveDemoTransport(): McpStdioTransportConfig {
  const packaged = fileURLToPath(new URL("./demo/mcp-memory-server.js", import.meta.url));
  const development = fileURLToPath(new URL("../../dist/demo/mcp-memory-server.js", import.meta.url));
  if (existsSync(packaged) || existsSync(development)) {
    return {
      type: "stdio",
      command: process.execPath,
      args: [existsSync(packaged) ? packaged : development],
    };
  }
  const source = fileURLToPath(new URL("../demo/mcp-memory-server.ts", import.meta.url));
  if (!existsSync(source)) {
    throw new Error("Packaged MCP demo server is missing from @remnic/bench");
  }
  return {
    type: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", source],
  };
}

export function validateMcpToolMapping(value: unknown): asserts value is McpMemoryToolMapping | undefined {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    throw new Error("MCP tool mapping must be a plain object");
  }
  for (const operation of Object.keys(value).sort()) {
    if (!(TOOL_OPERATIONS as readonly string[]).includes(operation)) {
      throw new Error(`MCP tool mapping contains unknown operation: ${operation}`);
    }
    const entry = value[operation];
    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        throw new Error(`MCP ${operation} tool name must be a non-empty string`);
      }
      continue;
    }
    if (!isPlainRecord(entry)) {
      throw new Error(`MCP ${operation} tool mapping must be a string or object`);
    }
    for (const key of Object.keys(entry).sort()) {
      if (key !== "name" && key !== "arguments" && key !== "resultPath") {
        throw new Error(`MCP ${operation} tool mapping contains unknown field: ${key}`);
      }
    }
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw new Error(`MCP ${operation} tool mapping requires a non-empty name`);
    }
    if (entry.resultPath !== undefined) {
      if (typeof entry.resultPath !== "string" || !isSafeResultPath(entry.resultPath)) {
        throw new Error(`MCP ${operation} resultPath must be a non-empty safe dot path`);
      }
    }
    if (entry.arguments !== undefined) {
      if (!isPlainRecord(entry.arguments)) {
        throw new Error(`MCP ${operation} arguments mapping must be a plain object`);
      }
      for (const semantic of Object.keys(entry.arguments).sort()) {
        if (!(ARGUMENT_SEMANTICS as readonly string[]).includes(semantic)) {
          throw new Error(`MCP ${operation} arguments contain unknown semantic: ${semantic}`);
        }
        const argumentName = entry.arguments[semantic];
        if (typeof argumentName !== "string" || argumentName.trim().length === 0) {
          throw new Error(`MCP ${operation} argument ${semantic} must map to a non-empty string`);
        }
      }
    }
  }
}

function resolveTools(
  listed: McpListedTool[],
  mapping: McpMemoryToolMapping = {}
): Record<McpToolOperation, ResolvedTool> {
  validateMcpToolMapping(mapping);
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  const resolved = {} as Record<McpToolOperation, ResolvedTool>;
  for (const operation of Object.keys(DEFAULT_TOOL_NAMES) as McpToolOperation[]) {
    const explicit = mapping[operation];
    const entry = typeof explicit === "string" ? { name: explicit } : explicit;
    const name = entry?.name ?? DEFAULT_TOOL_NAMES[operation].find((candidate) => byName.has(candidate));
    if (!name || !byName.has(name)) {
      const expected = entry?.name ?? DEFAULT_TOOL_NAMES[operation].join(", ");
      throw new Error(
        `missing ${operation} tool (expected ${expected}); server exposed ${[...byName.keys()].sort().join(", ") || "no tools"}`
      );
    }
    const tool = byName.get(name)!;
    resolved[operation] = {
      name,
      arguments: entry?.arguments ?? {},
      resultPath: entry?.resultPath,
      schemaProperties: Object.keys(tool.inputSchema?.properties ?? {}),
    };
    if (
      !resolveArgumentName(resolved[operation], "namespace") &&
      !resolveArgumentName(resolved[operation], "sessionId")
    ) {
      throw new Error(
        `unsafe ${operation} tool ${name}: operation requires a schema-declared namespace or sessionId argument mapping`
      );
    }
  }
  return resolved;
}

function buildArguments(
  tool: ResolvedTool,
  values: Partial<Record<McpArgumentSemantic, unknown>>
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [semantic, value] of Object.entries(values) as Array<[McpArgumentSemantic, unknown]>) {
    if (value === undefined) continue;
    const key = resolveArgumentName(tool, semantic);
    if (key) args[key] = value;
  }
  return args;
}

function resolveArgumentName(tool: ResolvedTool, semantic: McpArgumentSemantic): string | undefined {
  const explicit = tool.arguments[semantic];
  if (explicit !== undefined) {
    return tool.schemaProperties.includes(explicit) ? explicit : undefined;
  }
  return ARGUMENT_ALIASES[semantic].find((alias) => tool.schemaProperties.includes(alias));
}

function readToolPayload(result: McpToolCallResult, resultPath?: string): unknown {
  let value: unknown = result.structuredContent;
  if (value === undefined) {
    if (result.content === undefined) return undefined;
    const texts = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text!);
    if (texts.length === 1) {
      try {
        value = JSON.parse(texts[0]!);
      } catch {
        value = texts[0];
      }
    } else {
      value = texts;
    }
  }
  if (!resultPath) return value;
  for (const segment of resultPath.split(".")) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return undefined;
    }
    if (!value || typeof value !== "object" || !(segment in value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function extractStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(extractStrings);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const preferred of ["memories", "results", "items", "data", "content", "text", "memory"]) {
    if (preferred in record) {
      const found = extractStrings(record[preferred]);
      if (found.length > 0) return found;
    }
  }
  return Object.keys(record)
    .sort()
    .flatMap((key) => extractStrings(record[key]));
}

function validateRecallResponse(value: unknown): string[] {
  if (value === undefined || value === null) {
    throw invalidResponse("recall", "response did not contain a result payload");
  }
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const strings = value.flatMap(extractRecallItem);
    if (strings.length === 0) {
      throw invalidResponse("recall", "result array contained no recognizable memory text");
    }
    return strings;
  }
  if (!isPlainRecord(value)) {
    throw invalidResponse("recall", "result payload must be a string, array, or object");
  }
  for (const key of [
    "memories",
    "results",
    "items",
    "hits",
    "data",
    "payload",
    "result",
    "content",
    "text",
    "memory",
  ]) {
    if (!(key in value)) continue;
    const nested = value[key];
    if (Array.isArray(nested) && nested.length === 0) return [];
    if (typeof nested === "string" && nested.trim().length === 0) return [];
    const strings = extractRecallItem(nested);
    if (strings.length > 0) return strings;
    throw invalidResponse("recall", `response field ${key} contained no recognizable memory text`);
  }
  throw invalidResponse("recall", "response object contained no recognized result field");
}

function extractRecallItem(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(extractRecallItem);
  if (!isPlainRecord(value)) return [];
  for (const key of [
    "text",
    "content",
    "memory",
    "snippet",
    "value",
    "memories",
    "results",
    "items",
    "hits",
    "data",
    "payload",
    "result",
  ]) {
    if (key in value) return extractRecallItem(value[key]);
  }
  return [];
}

function validateMutationAcknowledgement(operation: "store" | "correct" | "reset", value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["ok", "true", "stored", "applied", "corrected", "deleted", "cleared"].includes(normalized)) {
      return true;
    }
    if (["false", "rejected", "not applied"].includes(normalized)) return false;
    throw invalidResponse(operation, "text response was not a recognized acknowledgement");
  }
  if (!isPlainRecord(value)) {
    throw invalidResponse(operation, "response did not contain a mutation acknowledgement");
  }
  const keys =
    operation === "store"
      ? ["stored", "created", "success", "ok"]
      : operation === "correct"
        ? ["applied", "corrected", "success", "ok"]
        : ["deleted", "cleared", "success", "ok"];
  for (const key of keys) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "boolean") {
      throw invalidResponse(operation, `acknowledgement field ${key} must be boolean`);
    }
    return value[key];
  }
  for (const wrapper of ["data", "payload", "result"]) {
    if (wrapper in value) return validateMutationAcknowledgement(operation, value[wrapper]);
  }
  throw invalidResponse(operation, "response object contained no recognized acknowledgement field");
}

function invalidResponse(operation: McpToolOperation, detail: string): McpMemoryBackendError {
  return new McpMemoryBackendError({
    ok: false,
    error: "invalid_response",
    detail: `${operation} tool returned an invalid response: ${detail}`,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeResultPath(value: string): boolean {
  const segments = value.split(".");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "__proto__" &&
        segment !== "prototype" &&
        segment !== "constructor" &&
        /^[A-Za-z0-9_-]+$/.test(segment)
    )
  );
}

async function withTimeoutControl<T>(
  timeoutMs: number,
  externalControl: BenchPhaseControl | undefined,
  label: string,
  operation: (control: BenchPhaseControl) => Promise<T>
): Promise<T> {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`${label} timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  const signal = externalControl?.signal
    ? AbortSignal.any([externalControl.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await raceWithSignal(operation({ signal }), signal, label);
  } finally {
    clearTimeout(timer);
  }
}

async function closeToolClient(client: McpToolClient, timeoutMs: number): Promise<void> {
  await raceWithSignal(client.close(), AbortSignal.timeout(Math.min(timeoutMs, 2_000)), "MCP client close").catch(
    () => {}
  );
}

async function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
  onLateSuccess?: (value: T) => Promise<void>
): Promise<T> {
  if (!signal) return promise;
  let aborted = signal.aborted;
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = () => {
      aborted = true;
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`));
    };
    if (signal.aborted) rejectForAbort();
    else {
      abortListener = rejectForAbort;
      signal.addEventListener("abort", rejectForAbort, { once: true });
    }
  });
  if (onLateSuccess) {
    void promise
      .then(async (value) => {
        if (aborted) await onLateSuccess(value);
      })
      .catch(() => {});
  }
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}
