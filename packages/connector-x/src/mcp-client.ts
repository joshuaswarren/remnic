/**
 * Official X MCP client (Streamable HTTP, protocol 2025-06-18).
 *
 * Contract per https://docs.x.com (MCP, launched 2026-06-30): JSON-RPC
 * over HTTP POST; `initialize` hands back an `Mcp-Session-Id` response
 * header; response bodies may be plain JSON or SSE (`text/event-stream`,
 * `data:` lines). Reads bill against X API credits — `credits depleted`
 * (HTTP 402 or a 402-in-tool-result payload) maps to
 * XCreditsDepletedError so callers can skip the cycle cleanly instead
 * of erroring. Session `initialize`/`tools/list` are free.
 *
 * The API token is never logged and never included in thrown error
 * messages.
 */

import { setTimeout as sleepMs } from "node:timers/promises";

import { isXObject } from "./guards.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 8_000;
export const X_MCP_PROTOCOL_VERSION = "2025-06-18";
export const X_MCP_DEFAULT_URL = "https://api.x.com/mcp";

export class XMcpError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "XMcpError";
  }
}

/** Clean-skip signal: the account's X API credits are exhausted. */
export class XCreditsDepletedError extends Error {
  constructor() {
    super("X API credits depleted — skipping this sync cycle");
    this.name = "XCreditsDepletedError";
  }
}

export interface XMcpToolCallResult {
  isError: boolean;
  /** text blocks of result.content, in order. */
  texts: string[];
  raw: unknown;
}

export interface XMcpClientOptions {
  url?: string;
  /** Lazily supplies a valid bearer token (user-context OAuth2). */
  tokenProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  result: unknown;
  headers: Headers | null;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}

/** Parses an SSE body into decoded `data:` JSON values, in order. */
export function parseSseData(body: string): unknown[] {
  const values: unknown[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) continue;
    try {
      values.push(JSON.parse(payload));
    } catch {
      // Ignore keep-alives and non-JSON comments.
    }
  }
  return values;
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return "unexpected non-Error failure";
  if ("code" in err && typeof err.code === "string" && err.code.length > 0) {
    return `${err.name} (${err.code})`;
  }
  return err.name;
}

/** True when a tool-result body signals exhausted credits (docs + observed shape). */
export function looksLikeCreditsDepleted(text: string): boolean {
  return text.includes("credits depleted") || text.includes('"status":402');
}

/** Extracts text blocks from an MCP tool-result content array. */
export function toolResultTexts(payload: Record<string, unknown>): string[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const texts: string[] = [];
  for (const block of content) {
    if (isXObject(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
}

export class XMcpClient {
  private readonly url: string;
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly protocolVersion: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private sessionId: string | null = null;
  private nextMessageId = 1;

  constructor(options: XMcpClientOptions) {
    if (typeof options.tokenProvider !== "function") {
      throw new XMcpError("XMcpClient requires a tokenProvider function");
    }
    this.url = stripTrailingSlashes(options.url ?? X_MCP_DEFAULT_URL);
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? sleepMs;
    this.protocolVersion = options.protocolVersion ?? X_MCP_PROTOCOL_VERSION;
    this.clientName = options.clientName ?? "remnic-connector-x";
    this.clientVersion = options.clientVersion ?? "1.0.0";
  }

  /**
   * Calls an MCP tool. Re-initializes once when the server rejects the
   * session id (e.g. expired session), then retries the call.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<XMcpToolCallResult> {
    return this.withSessionRetry(async () => {
      const { result } = await this.rpcMessage(
        {
          jsonrpc: "2.0",
          id: this.allocateId(),
          method: "tools/call",
          params: { name, arguments: args },
        },
        signal,
        true
      );
      if (!isXObject(result)) {
        throw new XMcpError(`tool ${name} returned a non-object result`);
      }
      const texts = toolResultTexts(result);
      const isError = result.isError === true;
      if (isError && looksLikeCreditsDepleted(texts.join("\n"))) {
        throw new XCreditsDepletedError();
      }
      return { isError, texts, raw: result };
    });
  }

  /** Best-effort session shutdown (MCP `DELETE`). */
  async close(): Promise<void> {
    if (this.sessionId === null) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${await this.tokenProvider()}`,
          "Mcp-Session-Id": sessionId,
        },
      });
    } catch {
      // Shutdown is advisory.
    }
  }

  private async withSessionRetry<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSession();
    try {
      return await operation();
    } catch (err) {
      if (err instanceof XMcpError && err.status === 404) {
        // Session expired server-side: drop it and retry once on a fresh session.
        this.sessionId = null;
        await this.ensureSession();
        return operation();
      }
      throw err;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.sessionId !== null) return;
    const initialized = await this.rpcMessage(
      {
        jsonrpc: "2.0",
        id: this.allocateId(),
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: this.clientName, version: this.clientVersion },
        },
      },
      signal,
      true
    );
    const sessionId = initialized.headers?.get("mcp-session-id");
    if (typeof sessionId === "string" && sessionId.length > 0) {
      this.sessionId = sessionId;
    }
    // Initialized notification: no id, no response body expected.
    await this.rpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, false);
  }

  private allocateId(): number {
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    return id;
  }

  private async rpcMessage(
    message: JsonRpcMessage,
    signal: AbortSignal | undefined,
    expectBody: boolean
  ): Promise<RpcResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${await this.tokenProvider()}`,
      };
      if (this.sessionId !== null) headers["Mcp-Session-Id"] = this.sessionId;

      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new XMcpError(`X MCP request failed after ${MAX_RETRIES + 1} attempts: ${describeNetworkError(err)}`);
      }

      if (response.status === 402) throw new XCreditsDepletedError();
      if (response.status === 401) {
        throw new XMcpError(
          "X MCP rejected the bearer token (401) — the OAuth2 token or refresh chain is broken; re-authorize",
          401
        );
      }
      if (response.status === 404 && this.sessionId !== null) {
        throw new XMcpError("X MCP session expired", 404);
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new XMcpError(`X MCP responded ${response.status}`, response.status);
        if (attempt < MAX_RETRIES) {
          await this.sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new XMcpError(`X MCP responded ${response.status}`, response.status);
      }
      if (!expectBody || response.status === 202) {
        return { result: null, headers: response.headers };
      }
      const body = await response.text();
      return {
        result: this.decodeBody(body, response.headers, message.id),
        headers: response.headers,
      };
    }
    throw lastError instanceof Error ? lastError : new XMcpError("X MCP request failed");
  }

  private decodeBody(body: string, headers: Headers, messageId: number | undefined): unknown {
    const contentType = headers.get("content-type") ?? "";
    let messages: unknown[];
    if (contentType.includes("text/event-stream")) {
      messages = parseSseData(body);
    } else {
      try {
        messages = [JSON.parse(body)];
      } catch {
        throw new XMcpError("X MCP returned a non-JSON body");
      }
    }
    const match = messages.find((entry) => isXObject(entry) && entry.id === messageId && entry.error === undefined);
    if (match === undefined) {
      const errorEntry = messages.find(
        (entry) => isXObject(entry) && entry.id === messageId && entry.error !== undefined
      );
      if (errorEntry !== undefined && isXObject(errorEntry)) {
        const rpcError = errorEntry.error;
        const detail =
          isXObject(rpcError) && typeof rpcError.message === "string"
            ? `${String(rpcError.code)}: ${rpcError.message}`
            : "unknown JSON-RPC error";
        if (looksLikeCreditsDepleted(detail)) throw new XCreditsDepletedError();
        throw new XMcpError(`X MCP tool call failed: ${detail}`);
      }
      throw new XMcpError("X MCP response carried no message for this request id");
    }
    if (isXObject(match) && "result" in match) return match.result;
    return match;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
}

function retryDelayMs(response: Response, attempt: number): number {
  const headerValue = response.headers.get("retry-after");
  if (headerValue !== null) {
    const parsed = Number(headerValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(parsed * 1_000));
    }
  }
  return backoffMs(attempt);
}
