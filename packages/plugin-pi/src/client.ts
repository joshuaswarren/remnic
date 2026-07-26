import type { RemnicPiConfig } from "./config.js";

export interface RecallResponse {
  context?: string;
  results?: Array<{ id?: string; content?: string; score?: number; category?: string }>;
  count?: number;
}

export interface ObserveMessagePart {
  ordinal?: number;
  kind: "text" | "tool_call" | "tool_result" | "patch" | "file_read" | "file_write" | "step_start" | "step_finish" | "snapshot" | "retry";
  payload: Record<string, unknown>;
  toolName?: string | null;
  filePath?: string | null;
  createdAt?: string | null;
}

export interface ObserveMessage {
  role: "user" | "assistant";
  content: string;
  sourceFormat?: "pi";
  rawContent?: unknown;
  parts?: ObserveMessagePart[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Optional caller abort signal (e.g. shared breaker trip). */
  signal?: AbortSignal;
  /** Transient-retry budget for connection-level failures (socket close, ECONNRESET). */
  maxRetries?: number;
}

export interface ObserveOptions extends RequestOptions {
  /** Soft cap on a single observe POST body in bytes; oversize batches are chunked. */
  maxBytes?: number;
}

/**
 * Result of a startup namespace-writability preflight (issue #1888 part 3).
 * `not_writable` is a DEFINITIVE misconfiguration answer from the daemon (the
 * configured namespace resolves as non-writable for this principal), which the
 * client surfaces loudly. `indeterminate` means the daemon could not be reached
 * or answered unexpectedly (timeout, network, auth, 5xx) — the client must NOT
 * cry wolf about the namespace on those, since the answer is unknown.
 */
export type NamespacePreflightResult =
  | { readonly status: "writable"; readonly namespace: string }
  | { readonly status: "not_writable"; readonly reason: "not_writable" | "unsupported"; readonly namespace: string }
  | { readonly status: "indeterminate"; readonly detail: string };

export class RemnicHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable error code from the daemon's JSON error body (e.g. `not_ready`). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RemnicRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Remnic request timed out after ${timeoutMs}ms`);
    this.name = "RemnicRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class RemnicRequestAbortedError extends Error {
  constructor() {
    super("Remnic request aborted");
    this.name = "RemnicRequestAbortedError";
  }
}

interface ObserveBody {
  sessionKey: string;
  cwd: string;
  namespace?: string;
  skipExtraction: boolean;
  messages: ObserveMessage[];
}

const encoder = new TextEncoder();
const RETRY_BASE_DELAY_MS = 200;
const MAX_COOLDOWN_MS = 60_000;
const TRUNCATION_MARKER = "\n\n[Remnic observe truncated: payload exceeded client size cap]";

export class RemnicClient {
  private requestId = 0;
  // Circuit-breaker state: when the daemon is known-unreachable, observe/recall
  // callers skip fast instead of blocking every turn on a doomed request (#1626).
  private unreachableUntil = 0;
  private consecutiveFailures = 0;

  constructor(private readonly config: RemnicPiConfig) {}

  /** True when the daemon is not in a known-unreachable cooldown. */
  isReachable(): boolean {
    return Date.now() >= this.unreachableUntil;
  }

  /** Clear the circuit breaker — call after any successful daemon interaction. */
  markReachable(): void {
    this.consecutiveFailures = 0;
    this.unreachableUntil = 0;
  }

  /**
   * Enter (or extend) an unreachable cooldown. The cooldown grows exponentially
   * with consecutive failures (base, 2×base, 4×base, …) capped at 60 s, so a
   * flapping daemon is retried gently while a hard-down host backs off hard.
   */
  markUnreachable(baseCooldownMs: number): void {
    this.consecutiveFailures += 1;
    const factor = 2 ** Math.min(this.consecutiveFailures - 1, 4);
    const cooldown = Math.min(baseCooldownMs * factor, MAX_COOLDOWN_MS);
    this.unreachableUntil = Date.now() + cooldown;
  }

  async health(options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.request("GET", "/engram/v1/health", undefined, options);
  }

  /**
   * Startup namespace-writability preflight (issue #1888 part 3). Asks the
   * daemon — read-only, no write, no side effect — whether the configured
   * namespace resolves as writable for this client's (token-resolved)
   * principal. A `not_writable` answer is definitive and surfaced loudly; any
   * transport failure returns `indeterminate` so a flaky daemon never triggers
   * a false namespace-misconfig alarm.
   */
  async preflightNamespace(
    sessionKey: string | undefined,
    options: RequestOptions = {},
  ): Promise<NamespacePreflightResult> {
    const params = new URLSearchParams();
    if (this.config.namespace) params.set("namespace", this.config.namespace);
    if (sessionKey) params.set("session", sessionKey);
    // Check the op this client's ENABLED write path uses: automatic turn
    // capture (observe) when observation is on, else the explicit store op.
    params.set("op", this.config.observeEnabled ? "observe" : "memory_store");
    const qs = params.toString();
    const path = `/engram/v1/namespace/writable${qs ? `?${qs}` : ""}`;
    try {
      const payload = await this.request<{ ok?: unknown; reason?: unknown; namespace?: unknown }>(
        "GET",
        path,
        undefined,
        options,
      );
      // Both branches require the full contract before they are trusted: an
      // `ok:true` without a concrete namespace, or an `ok:false` without a known
      // reason + concrete namespace, is malformed → indeterminate, never a false
      // writable/not-writable verdict.
      if (
        payload?.ok === true &&
        typeof payload.namespace === "string" &&
        payload.namespace.length > 0
      ) {
        return { status: "writable", namespace: payload.namespace };
      }
      if (
        payload?.ok === false &&
        (payload.reason === "not_writable" || payload.reason === "unsupported") &&
        typeof payload.namespace === "string" &&
        payload.namespace.length > 0
      ) {
        return { status: "not_writable", reason: payload.reason, namespace: payload.namespace };
      }
      return { status: "indeterminate", detail: "unexpected preflight response shape" };
    } catch (err) {
      return { status: "indeterminate", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async recall(
    query: string,
    sessionKey: string,
    cwd: string,
    options: RequestOptions = {},
  ): Promise<RecallResponse> {
    // Recall is a read-only query; retry transient connection failures with the
    // same budget as observe (#1602). Default to the per-turn budget when the
    // caller omits timeoutMs so the retries share one deadline (like observe)
    // instead of each attempt reusing the full general request timeout (cursor
    // review). Callers that need more (e.g. the manual /remnic-recall command)
    // pass an explicit timeoutMs.
    const merged: RequestOptions = {
      ...options,
      timeoutMs: options.timeoutMs ?? this.config.turnRequestTimeoutMs,
      maxRetries: options.maxRetries ?? this.config.observeMaxRetries,
    };
    return this.requestWithRetry(
      "POST",
      "/engram/v1/recall",
      {
        query,
        sessionKey,
        cwd,
        namespace: this.config.namespace,
        topK: this.config.recallTopK,
        mode: this.config.recallMode,
      },
      merged,
    );
  }

  async recallExplain(sessionKey: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.requestWithRetry(
      "POST",
      "/engram/v1/recall/explain",
      {
        sessionKey,
        namespace: this.config.namespace,
      },
      options,
    );
  }

  async observe(
    sessionKey: string,
    cwd: string,
    messages: ObserveMessage[],
    options: ObserveOptions = {},
  ): Promise<Record<string, unknown>> {
    const maxBytes = options.maxBytes ?? this.config.observeMaxBytes;
    // Observe runs on the live turn hooks, so bound it by the per-turn budget
    // (#1626) regardless of how many chunks the payload splits into. A missing
    // override previously let single-chunk observe fall back to the 60s general
    // budget while multi-chunk used the 20s turn budget (cursor review). An
    // explicit override is honored so callers outside the turn (shutdown replay,
    // tests) can extend it.
    const turnBudgetMs = options.timeoutMs ?? this.config.turnRequestTimeoutMs;
    const retryOptions: RequestOptions = {
      timeoutMs: turnBudgetMs,
      maxRetries: options.maxRetries ?? this.config.observeMaxRetries,
    };
    const chunks = chunkObservePayload(this.config, sessionKey, cwd, messages, maxBytes);
    if (chunks.length === 1) {
      return this.requestWithRetry("POST", "/engram/v1/observe", chunks[0], retryOptions);
    }
    // Multiple chunks: send sequentially within the SAME per-turn deadline so
    // the TOTAL observe time stays under turnBudgetMs (not per-chunk), which
    // keeps it inside the host's ~30s handler budget (#1626). Each chunk is
    // retried independently on transient connection failures; observe is
    // dedupe-safe, so a partial failure just re-sends on the next turn.
    const deadline = Date.now() + turnBudgetMs;
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Remnic observe exceeded the per-turn budget of ${turnBudgetMs}ms across ${chunks.length} chunks (completed ${i})`,
        );
      }
      const chunkOptions: RequestOptions = { ...retryOptions, timeoutMs: remaining };
      const result = await this.requestWithRetry<Record<string, unknown>>(
        "POST",
        "/engram/v1/observe",
        chunks[i],
        chunkOptions,
      );
      if (result && typeof result === "object") {
        results.push(result);
      }
    }
    return mergeObserveResults(results);
  }

  async storeMemory(content: string, sessionKey: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.requestWithRetry("POST", "/engram/v1/memories", {
      content,
      category: "fact",
      sourceReason: "Captured from Pi via Remnic extension",
      sessionKey,
      namespace: this.config.namespace,
    }, options);
  }

  async lcmSearch(query: string, sessionKey: string, limit = 10): Promise<Record<string, unknown>> {
    return this.requestWithRetry("POST", "/engram/v1/lcm/search", {
      query,
      sessionKey,
      namespace: this.config.namespace,
      limit,
    });
  }

  async lcmCompactionFlush(sessionKey: string): Promise<Record<string, unknown>> {
    return this.requestWithRetry("POST", "/engram/v1/lcm/compaction/flush", {
      sessionKey,
      namespace: this.config.namespace,
    });
  }

  async lcmCompactionRecord(sessionKey: string, tokensBefore: number, tokensAfter: number): Promise<Record<string, unknown>> {
    return this.requestWithRetry("POST", "/engram/v1/lcm/compaction/record", {
      sessionKey,
      namespace: this.config.namespace,
      tokensBefore,
      tokensAfter,
    });
  }

  async contextCheckpoint(sessionKey: string, context: string): Promise<Record<string, unknown>> {
    return this.mcpTool("remnic.context_checkpoint", {
      sessionKey,
      context,
      namespace: this.config.namespace,
    });
  }

  async mcpListTools(options: RequestOptions = {}): Promise<McpTool[]> {
    const result = await this.mcpRequest("tools/list", {}, options);
    const tools = result.tools;
    return Array.isArray(tools) ? tools.filter(isMcpTool) : [];
  }

  async mcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.mcpRequest("tools/call", {
      name,
      arguments: args,
    });
  }

  /**
   * Single HTTP attempt with the configured timeout. No retry — retry of
   * transient connection failures lives in {@link requestWithRetry}.
   */
  private async request<T = Record<string, unknown>>(
    method: string,
    pathname: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    if (options.signal?.aborted) {
      throw new RemnicRequestAbortedError();
    }
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const override = options.timeoutMs;
    const timeoutMs =
      typeof override === "number" && Number.isFinite(override) && override > 0
        ? override
        : this.config.requestTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(`${this.config.remnicDaemonUrl}${pathname}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.config.authToken ? { Authorization: `Bearer ${this.config.authToken}` } : {}),
          "X-Engram-Client-Id": "pi",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = {};
      let parseError: unknown;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (err) {
          parseError = err;
        }
      }
      if (!response.ok) {
        const message = responseErrorMessage(response, text, payload, parseError);
        const code = responseErrorCode(payload, parseError);
        if (response.status === 413) {
          const bodyBytes = body === undefined ? 0 : jsonBytes(body);
          throw new RemnicHttpError(response.status, `${message} (observed body ${bodyBytes} bytes; cap via observeMaxBytes)`, code);
        }
        throw new RemnicHttpError(response.status, message, code);
      }
      if (parseError) {
        const reason = parseError instanceof Error ? parseError.message : String(parseError);
        throw new Error(`Invalid JSON response from Remnic daemon (${response.status} ${response.statusText || "OK"}): ${reason}`);
      }
      return payload as T;
    } catch (err) {
      if (timedOut) throw new RemnicRequestTimeoutError(timeoutMs);
      if (options.signal?.aborted) throw new RemnicRequestAbortedError();
      throw err;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Wrap {@link request} with a small bounded retry loop for transient
   * connection-level failures (socket close mid-request, ECONNRESET, EPIPE).
   * Timeouts (our own AbortController) and HTTP responses (4xx/5xx) are NOT
   * retried here — timeouts already burned the full budget, and HTTP errors
   * carry semantic meaning the caller must handle. Observe/recall are
   * dedupe-safe so retrying a transiently-failed POST is harmless (#1602).
   */
  private async requestWithRetry<T = Record<string, unknown>>(
    method: string,
    pathname: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 0;
    // Share ONE deadline across all attempts (including backoff sleeps) when the
    // caller passes a per-turn/per-operation budget, so a late transient failure
    // cannot burn a full timeout on every retry and overshoot the host's ~30s
    // handler window (#1602/#1626 — cursor + codex reviews). The first attempt
    // keeps the original timeoutMs verbatim (preserving error messages/timing);
    // only retries are tightened to the remaining budget.
    const budgetMs = options.timeoutMs;
    const hasDeadline = typeof budgetMs === "number" && Number.isFinite(budgetMs) && budgetMs > 0;
    const deadline = hasDeadline ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
    let attempt = 0;
    let attemptOptions = options;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.request<T>(method, pathname, body, attemptOptions);
      } catch (err) {
        if (attempt >= maxRetries || !isTransientNetworkError(err)) throw err;
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        if (hasDeadline) {
          // sleeping if the sleep alone would overshoot the remaining budget,
          // so a sub-backoff timeoutMs never blocks for the full backoff only
          // to then throw (cursor review).
          const remainingBeforeSleep = deadline - Date.now();
          if (remainingBeforeSleep <= delayMs) {
            throw new Error(
              `Remnic request exceeded the ${budgetMs}ms budget before retry ${attempt + 1} (${method} ${pathname})`,
            );
          }
        }
        await sleep(delayMs, options.signal);
        attempt += 1;
        if (hasDeadline) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error(
              `Remnic request exceeded the ${budgetMs}ms budget before retry ${attempt} (${method} ${pathname})`,
            );
          }
          attemptOptions = { ...options, timeoutMs: remaining };
        }
      }
    }
  }

  private async mcpRequest(
    method: string,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    this.requestId += 1;
    const payload = await this.request<Record<string, unknown>>("POST", "/mcp", {
      jsonrpc: "2.0",
      id: this.requestId,
      method,
      params,
    }, options);
    if (payload.error) {
      throw new Error(JSON.stringify(payload.error));
    }
    return (payload.result && typeof payload.result === "object" ? payload.result : payload) as Record<string, unknown>;
  }
}

function isMcpTool(value: unknown): value is McpTool {
  return !!value && typeof value === "object" && "name" in value && typeof value.name === "string";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "This operation was aborted");
}

/**
 * Classify connection-level failures that are safe to retry: the request never
 * reached the daemon (or died mid-flight), so a retry is idempotent. Excludes
 * our own AbortController timeouts and HTTP responses (those carry meaning).
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isAbortError(err)) return false;
  if (err instanceof RemnicHttpError) return false;
  const lower = (err.message ?? "").toLowerCase();
  if (lower.includes("socket connection was closed")) return true;
  if (lower.includes("socket closed")) return true;
  if (lower.includes("econnreset")) return true;
  if (lower.includes("epipe")) return true;
  if (lower.includes("und_err_socket")) return true;
  if (lower.includes("fetch failed")) return true;
  const cause = err.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = cause.code;
    if (typeof code === "string" && (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET")) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RemnicRequestAbortedError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemnicRequestAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function buildObserveEnvelope(config: RemnicPiConfig, sessionKey: string, cwd: string, messages: ObserveMessage[]): ObserveBody {
  return {
    sessionKey,
    cwd,
    namespace: config.namespace,
    skipExtraction: config.observeSkipExtraction,
    messages,
  };
}

/**
 * Split an observe batch into POST bodies whose serialized JSON stays under
 * `maxBytes`. Single messages that alone exceed the per-message budget are
 * truncated with a marker rather than dropped, so large tool outputs still
 * leave a trace in memory (#1600).
 */
export function chunkObservePayload(
  config: RemnicPiConfig,
  sessionKey: string,
  cwd: string,
  messages: ObserveMessage[],
  maxBytes: number,
): ObserveBody[] {
  const envelopeOverhead = jsonBytes(buildObserveEnvelope(config, sessionKey, cwd, []));
  const messageBudget = maxBytes - envelopeOverhead;
  if (messageBudget <= 0) {
    // The envelope overhead alone meets/exceeds the cap, so no valid body can
    // fit — return a single chunk and let the daemon reject it visibly (this is
    // a degenerate/misconfigured cap, not the common case). A small-but-positive
    // budget (<=1024) is NOT degenerate: truncate/pack normally so oversized
    // messages are shrunk to fit instead of bypassing the #1600 safeguards
    // (cursor review).
    return [buildObserveEnvelope(config, sessionKey, cwd, messages)];
  }
  const chunks: ObserveMessage[][] = [];
  let current: ObserveMessage[] = [];
  let currentSize = 0;
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
  };
  for (const message of messages) {
    const size = jsonBytes(message);
    if (size > messageBudget) {
      flush();
      chunks.push([truncateObserveMessage(message, messageBudget)]);
      continue;
    }
    // Account for the JSON array comma separator before this message when it is
    // not the first in the chunk, so the serialized body never overshoots the
    // cap (review: cursor).
    if (current.length > 0 && currentSize + 1 + size > messageBudget) {
      flush();
    }
    if (current.length > 0) currentSize += 1;
    current.push(message);
    currentSize += size;
  }
  flush();
  if (chunks.length === 0) {
    return [buildObserveEnvelope(config, sessionKey, cwd, [])];
  }
  return chunks.map((msgs) => buildObserveEnvelope(config, sessionKey, cwd, msgs));
}

const decoder = new TextDecoder();

function truncateObserveMessage(message: ObserveMessage, budgetBytes: number): ObserveMessage {
  // A truncated observe keeps ONLY role + a content marker, dropping rawContent
  // and parts. Live Pi turns carry the full original message in rawContent and
  // parsed parts; those fields dominate the serialized size and would keep the
  // chunk over the cap (defeating #1600), so they are removed — the daemon
  // extracts from content. JSON-escape-aware: measures ACTUAL jsonBytes of each
  // candidate so escaping (\n -> \\\\n) can't overshoot.
  const slim: ObserveMessage = { role: message.role, content: "" };
  const markerOnly = jsonBytes({ ...slim, content: TRUNCATION_MARKER });
  if (markerOnly > budgetBytes) {
    // Pathological: even the marker alone doesn't fit. Keep it anyway so the
    // turn isn't silently dropped.
    return { role: message.role, content: TRUNCATION_MARKER };
  }
  const fullContent = message.content + TRUNCATION_MARKER;
  if (jsonBytes({ ...slim, content: fullContent }) <= budgetBytes) {
    return { role: message.role, content: fullContent };
  }
  // Binary-search the largest content slice whose slim message fits. Slicing by
  // encoded bytes keeps multi-byte sequences intact where possible; the decoder
  // replaces any dangling tail with the replacement char.
  const encoded = encoder.encode(message.content);
  let lo = 0;
  let hi = encoded.length;
  while (lo < hi) {
    const mid = hi - Math.floor((hi - lo) / 2);
    const candidate = decoder.decode(encoded.subarray(0, mid)) + TRUNCATION_MARKER;
    if (jsonBytes({ ...slim, content: candidate }) <= budgetBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const truncated = lo > 0 ? decoder.decode(encoded.subarray(0, lo)) : "";
  return { role: message.role, content: truncated + TRUNCATION_MARKER };
}

function mergeObserveResults(results: Record<string, unknown>[]): Record<string, unknown> {
  if (results.length === 0) return {};
  if (results.length === 1) return results[0];
  const merged: Record<string, unknown> = {};
  let countSum = 0;
  let hasCount = false;
  for (const result of results) {
    for (const key of Object.keys(result)) {
      const value = result[key];
      if (key === "count" && typeof value === "number" && Number.isFinite(value)) {
        countSum += value;
        hasCount = true;
      } else {
        merged[key] = value;
      }
    }
  }
  if (hasCount) merged.count = countSum;
  return merged;
}

function responseErrorMessage(response: Response, text: string, payload: unknown, parseError: unknown): string {
  if (!parseError && payload && typeof payload === "object") {
    if ("error" in payload && typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error;
    }
    if ("message" in payload && typeof payload.message === "string" && payload.message.trim().length > 0) {
      return payload.message;
    }
  }

  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (snippet.length > 0) {
    return response.statusText ? `${response.statusText}: ${snippet}` : snippet;
  }
  return response.statusText || `HTTP ${response.status}`;
}

function responseErrorCode(payload: unknown, parseError: unknown): string | undefined {
  if (parseError || !payload || typeof payload !== "object") return undefined;
  if ("code" in payload && typeof payload.code === "string" && payload.code.trim().length > 0) {
    return payload.code;
  }
  return undefined;
}
