/**
 * @remnic/hermes-provider
 *
 * Typed HTTP client for the Remnic memory API.
 *
 * Usage:
 *   const client = new HermesClient({ baseUrl: "http://127.0.0.1:4318", authToken: "secret" });
 *   const health = await client.health();
 *   const memories = await client.recall("what did I work on last week?");
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HermesClientOptions {
  /** Base URL of the Engram HTTP server (e.g. "http://127.0.0.1:4318") */
  baseUrl: string;
  /** Bearer token for authentication */
  authToken: string;
  /** Default namespace for requests (optional) */
  namespace?: string;
  /** Default session key (optional) */
  sessionKey?: string;
  /** Max retries for server errors (default: 3) */
  maxRetries?: number;
  /** Base delay in ms between retries (default: 100) */
  retryBaseDelayMs?: number;
  /** Request timeout in ms (default: 5000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface EngramAccessHealthResponse {
  ok: boolean;
  memoryDir: string;
  namespacesEnabled: boolean;
  defaultNamespace: string;
  searchBackend: string;
  qmdEnabled: boolean;
  nativeKnowledgeEnabled: boolean;
  projectionAvailable: boolean;
}

export interface EngramAccessRecallResponse {
  context?: string;
  results?: Array<{ id: string; content: string; score?: number; category?: string }>;
  count?: number;
  traceId?: string;
  plannerMode?: string;
  fallbackUsed?: boolean;
  sourcesUsed?: string[];
  budgetsApplied?: Record<string, unknown>;
  latencyMs?: number;
}

export interface EngramAccessObserveResponse {
  accepted: number;
  sessionKey: string;
  namespace?: string;
  lcmArchived?: boolean;
  extractionQueued?: boolean;
}

export interface EngramAccessWriteResponse {
  memoryId?: string;
  status: string;
  dryRun?: boolean;
  idempotencyReplay?: boolean;
  path?: string;
  duplicateOf?: string;
  idempotencyKey?: string;
}

export interface EngramAccessEntityListResponse {
  entities: Array<{ name: string; type: string; factCount?: number }>;
  total: number;
}

export interface EngramAccessEntityGetResponse {
  found: boolean;
  entity?: { name: string; type: string; observations?: string[] };
}

export interface EngramAccessMemoryBrowseResponse {
  memories: Array<Record<string, unknown>>;
  total: number;
}

export interface EngramAccessMemoryGetResponse {
  found: boolean;
  memory?: Record<string, unknown>;
}

export interface EngramAccessLcmSearchResponse {
  query: string;
  namespace?: string;
  results: Array<{ sessionId?: string; content?: string; turnIndex?: number }>;
  count: number;
  lcmEnabled: boolean;
}

export interface RecallOptions {
  sessionKey?: string;
  namespace?: string;
  topK?: number;
  mode?: "auto" | "no_recall" | "minimal" | "full" | "graph_mode";
  includeDebug?: boolean;
  idempotencyKey?: string;
}

export interface ObserveOptions {
  namespace?: string;
  skipExtraction?: boolean;
}

export type MessagePartSourceFormat =
  | "openai"
  | "anthropic"
  | "openclaw"
  | "pi"
  | "lossless-claw"
  | "remnic";

export type LcmMessagePartKind =
  | "text"
  | "tool_call"
  | "tool_result"
  | "patch"
  | "file_read"
  | "file_write"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "retry";

export interface ObserveMessagePart {
  ordinal?: number;
  kind: LcmMessagePartKind;
  payload: Record<string, unknown>;
  toolName?: string | null;
  filePath?: string | null;
  createdAt?: string | null;
}

export interface ObserveMessage {
  role: "user" | "assistant";
  content: string;
  sourceFormat?: MessagePartSourceFormat;
  rawContent?: unknown;
  parts?: ObserveMessagePart[];
}

export interface MemoryStoreRequest {
  content: string;
  category?: string;
  confidence?: number;
  tags?: string[];
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
  sessionKey?: string;
  namespace?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
  schemaVersion?: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class HermesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
  }
}

function hasNonEmptyIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HermesClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly defaultNamespace?: string;
  private readonly defaultSessionKey?: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: HermesClientOptions) {
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;
    this.authToken = options.authToken;
    this.defaultNamespace = options.namespace;
    this.defaultSessionKey = options.sessionKey;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  // -----------------------------------------------------------------------
  // Core methods
  // -----------------------------------------------------------------------

  async health(): Promise<EngramAccessHealthResponse> {
    return this.request<EngramAccessHealthResponse>("GET", "/engram/v1/health");
  }

  async recall(query: string, options?: RecallOptions): Promise<EngramAccessRecallResponse> {
    const body: Record<string, unknown> = {
      query,
    };
    const sk = options?.sessionKey ?? this.defaultSessionKey;
    if (sk) body.sessionKey = sk;
    const ns = options?.namespace ?? this.defaultNamespace;
    if (ns) body.namespace = ns;
    if (options?.topK !== undefined) body.topK = options.topK;
    if (options?.mode) body.mode = options.mode;
    if (options?.includeDebug !== undefined) body.includeDebug = options.includeDebug;
    if (options?.idempotencyKey) body.idempotencyKey = options.idempotencyKey;
    return this.request<EngramAccessRecallResponse>("POST", "/engram/v1/recall", body, {
      noRetry: !options?.idempotencyKey,
    });
  }

  async observe(
    sessionKey: string,
    messages: ObserveMessage[],
    options?: ObserveOptions,
  ): Promise<EngramAccessObserveResponse> {
    const body: Record<string, unknown> = {
      sessionKey,
      messages,
      namespace: options?.namespace ?? this.defaultNamespace,
      skipExtraction: options?.skipExtraction ?? false,
    };
    return this.request<EngramAccessObserveResponse>("POST", "/engram/v1/observe", body, { noRetry: true });
  }

  async store(request: MemoryStoreRequest): Promise<EngramAccessWriteResponse> {
    const body: Record<string, unknown> = {
      ...request,
      namespace: request.namespace ?? this.defaultNamespace,
      sessionKey: request.sessionKey ?? this.defaultSessionKey,
    };
    return this.request<EngramAccessWriteResponse>("POST", "/engram/v1/memories", body, {
      noRetry: !hasNonEmptyIdempotencyKey(request.idempotencyKey),
    });
  }

  async submitSuggestion(request: MemoryStoreRequest): Promise<EngramAccessWriteResponse> {
    const body: Record<string, unknown> = {
      ...request,
      namespace: request.namespace ?? this.defaultNamespace,
      sessionKey: request.sessionKey ?? this.defaultSessionKey,
    };
    return this.request<EngramAccessWriteResponse>("POST", "/engram/v1/suggestions", body, {
      noRetry: !hasNonEmptyIdempotencyKey(request.idempotencyKey),
    });
  }

  // -----------------------------------------------------------------------
  // Browse / read methods
  // -----------------------------------------------------------------------

  async getEntities(options?: {
    namespace?: string;
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<EngramAccessEntityListResponse> {
    const params: Record<string, unknown> = {
      namespace: options?.namespace ?? this.defaultNamespace,
    };
    if (options?.query) params.q = options.query;
    if (options?.limit !== undefined) params.limit = options.limit;
    if (options?.offset !== undefined) params.offset = options.offset;
    return this.request<EngramAccessEntityListResponse>(
      "GET",
      `/engram/v1/entities${this.queryString(params)}`,
    );
  }

  async getEntity(name: string, options?: { namespace?: string }): Promise<EngramAccessEntityGetResponse> {
    try {
      return await this.request<EngramAccessEntityGetResponse>(
        "GET",
        `/engram/v1/entities/${encodeURIComponent(name)}${this.queryString({ namespace: options?.namespace ?? this.defaultNamespace })}`,
      );
    } catch (err) {
      // 404 is a valid "not found" response for entity lookups
      if (err instanceof HermesError && err.status === 404) {
        return { found: false };
      }
      throw err;
    }
  }

  async getMemories(options?: {
    query?: string;
    status?: string;
    category?: string;
    namespace?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  }): Promise<EngramAccessMemoryBrowseResponse> {
    const params: Record<string, unknown> = {
      namespace: options?.namespace ?? this.defaultNamespace,
    };
    // The HTTP API uses `q` for the search query parameter
    if (options?.query) params.q = options.query;
    if (options?.status) params.status = options.status;
    if (options?.category) params.category = options.category;
    if (options?.sort) params.sort = options.sort;
    if (options?.limit !== undefined) params.limit = options.limit;
    if (options?.offset !== undefined) params.offset = options.offset;
    return this.request<EngramAccessMemoryBrowseResponse>(
      "GET",
      `/engram/v1/memories${this.queryString(params)}`,
    );
  }

  async getMemory(id: string, options?: { namespace?: string }): Promise<EngramAccessMemoryGetResponse> {
    try {
      return await this.request<EngramAccessMemoryGetResponse>(
        "GET",
        `/engram/v1/memories/${encodeURIComponent(id)}${this.queryString({ namespace: options?.namespace ?? this.defaultNamespace })}`,
      );
    } catch (err) {
      // 404 is a valid "not found" response, not an error
      if (err instanceof HermesError && err.status === 404) {
        return { found: false };
      }
      throw err;
    }
  }

  async lcmSearch(
    query: string,
    options?: { sessionKey?: string; namespace?: string; limit?: number },
  ): Promise<EngramAccessLcmSearchResponse> {
    const body: Record<string, unknown> = {
      query,
      sessionKey: options?.sessionKey ?? this.defaultSessionKey,
      namespace: options?.namespace ?? this.defaultNamespace,
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    };
    return this.request<EngramAccessLcmSearchResponse>("POST", "/engram/v1/lcm/search", body);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private queryString(params?: Record<string, unknown>): string {
    if (!params) return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, options?: { noRetry?: boolean }): Promise<T> {
    // Skip retries for state-mutating writes to prevent duplicate side effects.
    // Read-only POST endpoints (recall, lcm/search) are safe to retry.
    const isMutating = options?.noRetry === true;
    const maxAttempts = isMutating ? 1 : this.maxRetries + 1;
    let lastError: Error | null = null;
    let lastRateLimitError: HermesError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
          "Authorization": `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
        };

        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        timeout = undefined;

        // Success responses
        if (response.ok) {
          if (response.status === 204) return {} as T;
          return (await response.json()) as T;
        }

        // Rate-limited — back off and retry
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          let waitMs = this.retryBaseDelayMs * 4;
          if (retryAfter) {
            const trimmedRetryAfter = retryAfter.trim();
            const parsed = /^[0-9]+$/.test(trimmedRetryAfter)
              ? Number(trimmedRetryAfter)
              : Number.NaN;
            // Only use the RFC seconds form when the entire header is digits.
            // Date-like or malformed values such as "60 seconds" are ignored
            // so parseInt() cannot turn a prefix into a long sleep.
            if (Number.isFinite(parsed) && parsed > 0) {
              waitMs = parsed * 1000;
            }
          }
          const errorBody = await response.json().catch(() => ({ error: "rate_limited", code: "rate_limited" })) as { error: string; code?: string };
          lastRateLimitError = new HermesError(429, errorBody.code ?? "rate_limited", errorBody.error);
          if (attempt >= maxAttempts - 1) {
            throw lastRateLimitError;
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // Client errors — do not retry
        if (response.status >= 400 && response.status < 500) {
          const error = await this.parseErrorResponse(response);
          throw new HermesError(
            response.status,
            error.code ?? `http_${response.status}`,
            error.error,
            error.details,
          );
        }

        // Server error — retry
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      } catch (err) {
        if (timeout !== undefined) clearTimeout(timeout);
        if (err instanceof HermesError) throw err;
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new Error(`request timed out after ${this.timeoutMs}ms`);
          continue;
        }
        lastError = err as Error;
        continue;
      }
    }

    // If we exhausted retries due to rate limiting, throw the preserved 429 error
    if (lastRateLimitError) throw lastRateLimitError;
    throw lastError ?? new Error("request failed after retries");
  }

  private async parseErrorResponse(response: Response): Promise<{
    error: string;
    code?: string;
    details?: Array<{ field: string; message: string }>;
  }> {
    try {
      const parsed = await response.json() as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const error = parsed as Record<string, unknown>;
        return {
          error: typeof error.error === "string" && error.error.trim() ? error.error : response.statusText || `HTTP ${response.status}`,
          code: typeof error.code === "string" && error.code.trim() ? error.code : undefined,
          details: Array.isArray(error.details)
            ? error.details.filter((detail): detail is { field: string; message: string } => (
              detail !== null
              && typeof detail === "object"
              && typeof (detail as { field?: unknown }).field === "string"
              && typeof (detail as { message?: unknown }).message === "string"
            ))
            : undefined,
        };
      }
    } catch {
      // Preserve the HTTP status for non-JSON or empty 4xx responses.
    }
    return {
      error: response.statusText || `HTTP ${response.status}`,
      code: `http_${response.status}`,
    };
  }
}
