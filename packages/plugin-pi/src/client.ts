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

export class RemnicHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class RemnicClient {
  private requestId = 0;

  constructor(private readonly config: RemnicPiConfig) {}

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/engram/v1/health");
  }

  async recall(query: string, sessionKey: string, cwd: string): Promise<RecallResponse> {
    return this.request("POST", "/engram/v1/recall", {
      query,
      sessionKey,
      cwd,
      namespace: this.config.namespace,
      topK: this.config.recallTopK,
      mode: this.config.recallMode,
    });
  }

  async recallExplain(sessionKey: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/recall/explain", {
      sessionKey,
      namespace: this.config.namespace,
    });
  }

  async observe(sessionKey: string, cwd: string, messages: ObserveMessage[]): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/observe", {
      sessionKey,
      cwd,
      namespace: this.config.namespace,
      skipExtraction: this.config.observeSkipExtraction,
      messages,
    });
  }

  async storeMemory(content: string, sessionKey: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/memories", {
      content,
      category: "fact",
      sourceReason: "Captured from Pi via Remnic extension",
      sessionKey,
      namespace: this.config.namespace,
    });
  }

  async lcmSearch(query: string, sessionKey: string, limit = 10): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/lcm/search", {
      query,
      sessionKey,
      namespace: this.config.namespace,
      limit,
    });
  }

  async lcmCompactionFlush(sessionKey: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/lcm/compaction/flush", {
      sessionKey,
      namespace: this.config.namespace,
    });
  }

  async lcmCompactionRecord(sessionKey: string, tokensBefore: number, tokensAfter: number): Promise<Record<string, unknown>> {
    return this.request("POST", "/engram/v1/lcm/compaction/record", {
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

  async mcpListTools(): Promise<McpTool[]> {
    const result = await this.mcpRequest("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    return Array.isArray(tools) ? tools.filter(isMcpTool) : [];
  }

  async mcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.mcpRequest("tools/call", {
      name,
      arguments: args,
    });
  }

  private async request<T = Record<string, unknown>>(method: string, pathname: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
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
        throw new RemnicHttpError(response.status, responseErrorMessage(response, text, payload, parseError));
      }
      if (parseError) {
        const reason = parseError instanceof Error ? parseError.message : String(parseError);
        throw new Error(`Invalid JSON response from Remnic daemon (${response.status} ${response.statusText || "OK"}): ${reason}`);
      }
      return payload as T;
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`Remnic request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mcpRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requestId += 1;
    const payload = await this.request<Record<string, unknown>>("POST", "/mcp", {
      jsonrpc: "2.0",
      id: this.requestId,
      method,
      params,
    });
    if (payload.error) {
      throw new Error(JSON.stringify(payload.error));
    }
    return (payload.result && typeof payload.result === "object" ? payload.result : payload) as Record<string, unknown>;
  }
}

function isMcpTool(value: unknown): value is McpTool {
  return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "This operation was aborted");
}

function responseErrorMessage(response: Response, text: string, payload: unknown, parseError: unknown): string {
  if (!parseError && payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (snippet.length > 0) {
    return response.statusText ? `${response.statusText}: ${snippet}` : snippet;
  }
  return response.statusText || `HTTP ${response.status}`;
}
