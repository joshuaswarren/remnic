/**
 * OpenAI-compatible HTTP proxy for WeClone with Remnic memory injection.
 *
 * Intercepts POST /v1/chat/completions to inject recalled memories,
 * forwards all other requests transparently to the WeClone API.
 */

import * as http from "node:http";
import type { WeCloneConnectorConfig } from "./config.js";
import { formatMemoryBlock, type RecallResult } from "./format.js";
import {
  SingleSessionMapper,
  CallerIdSessionMapper,
  type SessionMapper,
  type ChatCompletionRequest,
} from "./session.js";

export interface WeCloneProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
  host: string;
}

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const DEFAULT_STREAM_OBSERVATION_MAX_BYTES = 1024 * 1024;

class BodyLimitExceededError extends Error {
  constructor(readonly limitBytes: number) {
    super(`body exceeds ${limitBytes} byte limit`);
    this.name = "BodyLimitExceededError";
  }
}

/**
 * Read the entire body of an IncomingMessage as a string (UTF-8).
 * Used for paths that need to parse JSON (e.g. chat completions).
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        exceeded = true;
        reject(new BodyLimitExceededError(maxBytes));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!exceeded) reject(err);
    });
  });
}

/**
 * Read the entire body of an IncomingMessage as raw bytes.
 * Used for the transparent proxy path to avoid corrupting binary/multipart uploads.
 */
function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        exceeded = true;
        reject(new BodyLimitExceededError(maxBytes));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!exceeded) reject(err);
    });
  });
}

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyLimitExceededError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function waitForResponseDrain(res: http.ServerResponse): Promise<"drain" | "closed"> {
  if (res.destroyed || res.writableEnded) return Promise.resolve("closed");
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve("drain");
    };
    const onClose = () => {
      cleanup();
      resolve("closed");
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
  });
}

export async function writeResponseChunkRespectingBackpressure(
  res: http.ServerResponse,
  chunk: Uint8Array,
): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  return (await waitForResponseDrain(res)) === "drain";
}

/**
 * Build a flat headers record from IncomingHttpHeaders,
 * normalizing array values to comma-separated strings.
 */
function flattenHeaders(
  raw: http.IncomingHttpHeaders
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    result[key] = Array.isArray(val) ? val.join(", ") : val;
  }
  return result;
}

function forwardRequestHeaders(
  headers: Record<string, string>,
  options: { reserializedJson?: boolean } = {}
): Record<string, string> {
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "host" || HOP_BY_HOP_REQUEST_HEADERS.has(lowerKey)) continue;
    if (lowerKey === "content-length") continue;
    if (options.reserializedJson && lowerKey === "content-type") continue;
    forwardHeaders[key] = value;
  }
  if (options.reserializedJson) {
    forwardHeaders["Content-Type"] = "application/json";
  }
  return forwardHeaders;
}

/**
 * Build standard headers for Remnic daemon requests.
 * Includes Authorization if an auth token is configured.
 */
function remnicHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

/**
 * Call Remnic daemon recall endpoint for the given session and query.
 */
async function recallMemories(
  daemonUrl: string,
  sessionKey: string,
  query: string,
  authToken?: string
): Promise<RecallResult[]> {
  const url = `${daemonUrl}/engram/v1/recall`;
  const res = await fetch(url, {
    method: "POST",
    headers: remnicHeaders(authToken),
    body: JSON.stringify({ sessionKey, query }),
  });

  if (!res.ok) {
    throw new Error(`Remnic recall returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { results?: Array<{ preview?: string; content?: string; confidence?: number; category?: string }> };
  const memories: RecallResult[] = (data.results ?? []).map((r) => ({
    content: r.preview || r.content || "",
    confidence: r.confidence,
    category: r.category,
  }));
  return memories;
}

/**
 * Fire-and-forget observation to the Remnic daemon.
 * Errors are caught and silently discarded to avoid adding latency.
 */
function observeTurn(
  daemonUrl: string,
  sessionKey: string,
  userMessage: string,
  assistantMessage: string,
  authToken?: string
): void {
  const url = `${daemonUrl}/engram/v1/observe`;
  fetch(url, {
    method: "POST",
    headers: remnicHeaders(authToken),
    body: JSON.stringify({
      sessionKey,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: assistantMessage },
      ],
    }),
  }).catch(() => {
    // Intentionally swallowed -- observation must not affect the response path
  });
}

/**
 * Coerce an OpenAI chat message `content` into a plain text string.
 *
 * OpenAI chat messages can be either a string or an array of content
 * parts (e.g. `[{type:"text",text:"..."},{type:"image_url",...}]`) for
 * multimodal inputs. Recall/observe only operate on text, so we extract
 * and concatenate the `text` parts. Returns an empty string if no text
 * is present (e.g. image-only turn) so we skip recall rather than sending
 * non-string payloads to the Remnic daemon.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract the last user message's text content from a chat completion
 * messages array. Handles both string and multimodal array content.
 */
function lastUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractTextContent(messages[i].content);
    }
  }
  return "";
}

type ForwardedChatMessage = Record<string, unknown> & {
  role: string;
  content: unknown;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract the assistant reply from a WeClone chat completion response.
 */
function extractAssistantReply(responseBody: Record<string, unknown>): string {
  const choices = responseBody.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;
  if (choices && choices.length > 0) {
    return choices[0]?.message?.content ?? "";
  }
  return "";
}

/**
 * Strip trailing slashes from a URL without using a regex quantifier
 * on the same character, which CodeQL flags as polynomial ReDoS
 * (`js/polynomial-redos`). A simple loop is O(n) and cannot backtrack.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Parse a URL string into { origin, basePath } where `basePath` is the
 * configured path prefix (e.g. "/weclone/v1") with any trailing slashes
 * stripped. Falls back safely for malformed inputs.
 */
function splitBaseUrl(urlStr: string): { origin: string; basePath: string } {
  try {
    const parsed = new URL(urlStr);
    const basePath = stripTrailingSlashes(parsed.pathname);
    return { origin: parsed.origin, basePath };
  } catch {
    // Fallback: strip trailing path components without ReDoS-prone regex.
    // Split on the first "/" after the scheme.
    const schemeEnd = urlStr.indexOf("://");
    if (schemeEnd === -1) {
      return { origin: stripTrailingSlashes(urlStr), basePath: "" };
    }
    const afterScheme = urlStr.slice(schemeEnd + 3);
    const pathStart = afterScheme.indexOf("/");
    if (pathStart === -1) {
      return { origin: urlStr, basePath: "" };
    }
    const origin = urlStr.slice(0, schemeEnd + 3 + pathStart);
    const basePath = stripTrailingSlashes(afterScheme.slice(pathStart));
    return { origin, basePath };
  }
}

/**
 * Hop-by-hop request headers that must not be forwarded to upstream.
 * Per RFC 2616 §13.5.1 / RFC 7230 §6.1 these apply only to the
 * immediate transport connection. `proxy-authorization` is the most
 * critical — leaking it would send proxy credentials to the origin.
 *
 * `host` is deliberately excluded from this set because it is
 * always replaced (not just stripped) with the upstream origin
 * and is handled separately below.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers that must not be forwarded from the upstream response.
 * These are hop-by-hop headers that apply to a single transport connection
 * and would conflict with our fully-buffered response write.
 *
 * `content-encoding` is included because fetch() auto-decompresses the body.
 * When we buffer with arrayBuffer() and relay, the bytes are already decoded;
 * forwarding `content-encoding: gzip` would label decompressed bytes as gzip.
 */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "content-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/**
 * Forward a request transparently to the WeClone API.
 *
 * If the configured WeClone URL has a non-empty base path (e.g.
 * "https://host/weclone/v1"), the proxy forwards incoming request paths
 * such that "/v1/models" maps to "https://host/weclone/v1/models". For
 * URLs without a base path, paths map 1:1 to the upstream origin.
 *
 * The request body (if any) is forwarded as raw bytes via Uint8Array so
 * that multipart/binary uploads are not corrupted.
 *
 * Reads the full upstream response before writing to the client
 * to avoid partial-header or hanging-body issues.
 */
async function transparentProxy(
  weclone: { origin: string; basePath: string },
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
  res: http.ServerResponse,
  maxResponseBytes: number
): Promise<void> {
  // Map the client-facing path into an upstream path.
  //
  // The proxy exposes an OpenAI-compatible `/v1/...` surface. When the
  // configured `wecloneApiUrl` itself already ends in `/v1` (or any
  // path prefix), treat the configured prefix as the upstream mount
  // point and rewrite `/v1/<rest>` to `<basePath>/<rest>`.
  //
  // - basePath "" (no prefix): forward path as-is.
  // - basePath "/v1": "/v1/models" -> "/v1/models" (no change).
  // - basePath "/weclone/v1": "/v1/models" -> "/weclone/v1/models".
  //
  // Split off any query string so rewriting operates on the pathname only.
  const qIdx = path.indexOf("?");
  const rawPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const querySuffix = qIdx === -1 ? "" : path.slice(qIdx);
  let upstreamPathname = rawPath;
  if (weclone.basePath.length > 0) {
    if (rawPath === "/v1" || rawPath.startsWith("/v1/")) {
      upstreamPathname = `${weclone.basePath}${rawPath.slice(3)}`;
    } else if (!rawPath.startsWith(weclone.basePath)) {
      upstreamPathname = `${weclone.basePath}${rawPath}`;
    }
  }
  const targetUrl = `${weclone.origin}${upstreamPathname}${querySuffix}`;

  // Remove hop-by-hop request headers and replace host with upstream origin
  const forwardHeaders = forwardRequestHeaders(headers);

  const fetchInit: RequestInit = {
    method,
    headers: forwardHeaders,
  };
  if (body && method !== "GET" && method !== "HEAD") {
    // Copy into a plain ArrayBuffer so the forwarded request keeps the exact
    // byte payload while remaining compatible with this package's BodyInit
    // typing during declaration builds.
    const rawBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(rawBody).set(body);
    fetchInit.body = rawBody;
  }

  try {
    const upstream = await fetch(targetUrl, fetchInit);

    // Read full body before sending any headers to the client
    const responseBuffer = await readResponseBuffer(upstream, maxResponseBytes);

    // Build response headers, filtering hop-by-hop and setting Content-Length
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }
    responseHeaders["content-length"] = String(responseBuffer.length);

    res.writeHead(upstream.status, responseHeaders);
    res.end(responseBuffer);
  } catch (err) {
    if (err instanceof BodyLimitExceededError) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_response_too_large" }));
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_unreachable" }));
  }
}

/**
 * Create a WeClone proxy instance.
 */
export function createWeCloneProxy(config: WeCloneConnectorConfig): WeCloneProxy {
  // Normalize upstream URLs: strip trailing slashes to prevent double-slash
  // when appending path segments. Use a loop (not regex) to avoid the
  // polynomial-ReDoS class flagged by CodeQL for `/\/+$/`.
  const wecloneApiUrl = stripTrailingSlashes(config.wecloneApiUrl);
  const remnicDaemonUrl = stripTrailingSlashes(config.remnicDaemonUrl);
  // Pre-split the WeClone URL so transparentProxy and the chat path can
  // honor a configured base path (e.g. "/weclone/v1").
  const wecloneParts = splitBaseUrl(wecloneApiUrl);
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const streamObservationMaxBytes =
    config.streamObservationMaxBytes ?? DEFAULT_STREAM_OBSERVATION_MAX_BYTES;
  const proxyBindHost = config.proxyBindHost ?? "127.0.0.1";

  const sessionMapper: SessionMapper =
    config.sessionStrategy === "caller-id"
      ? new CallerIdSessionMapper()
      : new SingleSessionMapper();

  let server: http.Server | null = null;
  let resolvedPort = config.proxyPort;
  let resolvedHost = proxyBindHost;

  const requestHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    // Parse the request URL into a pathname (stripping query string and
    // normalizing trailing slash). Using pathname for route matching avoids
    // silently falling through when clients append query params like
    // `?api-version=2023-05-15` (common with Azure OpenAI-compatible SDKs).
    let pathname = url;
    const queryStart = url.indexOf("?");
    if (queryStart !== -1) pathname = url.slice(0, queryStart);
    // Normalize trailing slash for route matching only (not for forwarding).
    const normalizedPathname =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;

    // --- Health check ---
    if (normalizedPathname === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        wecloneApi: config.wecloneApiUrl,
      }));
      return;
    }

    // --- Chat completions with memory injection ---
    if (normalizedPathname === "/v1/chat/completions" && method === "POST") {
      let bodyStr: string;
      try {
        bodyStr = await readBody(req, maxRequestBytes);
      } catch (err) {
        if (err instanceof BodyLimitExceededError) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "request_body_too_large" }));
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", detail: "Could not read request body" }));
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(bodyStr) as unknown;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", detail: "Invalid JSON body" }));
        return;
      }
      if (!isPlainRecord(parsedJson)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "bad_request",
            detail: "JSON body must be an object",
          })
        );
        return;
      }
      const parsed = parsedJson as ChatCompletionRequest;

      const headers = req.headers as Record<string, string | string[] | undefined>;
      const sessionKey = sessionMapper.resolve(headers, parsed);
      // Validate `messages` is an array with object entries before use so
      // malformed payloads (`messages: "..."`, `messages: {}`, etc.) return
      // a structured 400 instead of surfacing as a 500 internal error.
      if (parsed.messages !== undefined && !Array.isArray(parsed.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "bad_request",
            detail: "messages must be an array",
          })
        );
        return;
      }
      // Messages may contain multimodal content-parts arrays; keep them
      // untyped and validate strings at each use site. Drop entries that
      // are not plain objects so downstream `.map()` cannot throw.
      const rawMessages: ForwardedChatMessage[] = [];
      for (const raw of parsed.messages ?? []) {
        if (raw === null || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        rawMessages.push({
          ...entry,
          role: typeof entry.role === "string" ? entry.role : "",
          content: entry.content,
        });
      }
      const query = lastUserMessage(rawMessages);

      // Recall memories (graceful degradation on failure)
      let memoryBlock = "";
      if (query.length > 0) {
        try {
          const memories = await recallMemories(
            remnicDaemonUrl,
            sessionKey,
            query,
            config.remnicAuthToken
          );
          memoryBlock = formatMemoryBlock(
            memories,
            config.memoryInjection.template,
            config.memoryInjection.maxTokens
          );
        } catch {
          // Remnic recall failed -- proceed without memory injection
        }
      }

      // Build the forwarded messages array. Only the *first* system message
      // is rewritten with injected memory (or, if no system exists, a
      // synthetic system message is prepended). Subsequent system messages
      // are forwarded verbatim so distinct system instructions are not
      // silently overwritten.
      const outMessages: ForwardedChatMessage[] = [];
      const firstSystemIdx = rawMessages.findIndex((m) => m.role === "system");
      const position = config.memoryInjection.position;

      if (memoryBlock.length === 0) {
        // No memory to inject — forward original messages unchanged.
        for (const m of rawMessages) outMessages.push(m);
      } else if (firstSystemIdx === -1) {
        // No existing system message: prepend a synthetic one.
        outMessages.push({ role: "system", content: memoryBlock });
        for (const m of rawMessages) outMessages.push(m);
      } else {
        for (let i = 0; i < rawMessages.length; i++) {
          const m = rawMessages[i];
          if (i === firstSystemIdx) {
            const existing = extractTextContent(m.content);
            outMessages.push({
              ...m,
              role: "system",
              content:
                position === "system-prepend"
                  ? `${memoryBlock}\n\n${existing}`
                  : `${existing}\n\n${memoryBlock}`,
            });
          } else {
            outMessages.push(m);
          }
        }
      }

      const modifiedBody = {
        ...parsed,
        ...(config.wecloneModelName ? { model: config.wecloneModelName } : {}),
        messages: outMessages,
      };

      // Forward to WeClone. If `wecloneApiUrl` has a path prefix (the
      // common `/v1` or custom mounts like `/weclone/v1`), forward to
      // `${basePath}/chat/completions`. If the configured URL has no
      // base path at all, default to the standard OpenAI `/v1/chat/completions`.
      // Preserve any query string on the incoming request (e.g. Azure's
      // `?api-version=...`) so version selectors and tenant hints reach
      // upstream unchanged.
      const chatBase = wecloneParts.basePath.length > 0
        ? wecloneParts.basePath
        : "/v1";
      const qIdx = url.indexOf("?");
      const querySuffix = qIdx === -1 ? "" : url.slice(qIdx);
      const targetUrl =
        `${wecloneParts.origin}${chatBase}/chat/completions${querySuffix}`;
      const forwardHeaders = forwardRequestHeaders(flattenHeaders(req.headers), {
        reserializedJson: true,
      });

      try {
        const upstream = await fetch(targetUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: JSON.stringify(modifiedBody),
        });

        // --- Streaming path ---
        if (parsed.stream === true) {
          // If upstream returned an error, pass through as-is (don't force SSE headers)
          if (!upstream.ok) {
            const errBody = await readResponseBuffer(upstream, maxResponseBytes);
            res.writeHead(upstream.status, {
              "content-type": upstream.headers.get("content-type") || "application/json",
            });
            res.end(errBody);
            return;
          }

          res.writeHead(upstream.status, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const reader = upstream.body?.getReader();
          if (!reader) {
            res.end();
            return;
          }
          let clientClosed = false;
          const onClientClose = () => {
            clientClosed = true;
            void reader.cancel().catch(() => {});
          };
          res.once("close", onClientClose);

          const decoder = new TextDecoder();
          let streamBuffer = "";
          let assistantContent = "";
          let observationTextBytes = 0;
          let observationDisabled = false;
          const disableObservationBuffer = () => {
            observationDisabled = true;
            streamBuffer = "";
            assistantContent = "";
            observationTextBytes = 0;
          };
          const appendObservationText = (text: string) => {
            const nextBytes = observationTextBytes + Buffer.byteLength(text, "utf8");
            if (nextBytes > streamObservationMaxBytes) {
              disableObservationBuffer();
              return;
            }
            observationTextBytes = nextBytes;
            assistantContent += text;
          };
          const consumeSseLine = (line: string) => {
            if (!line.startsWith("data: ") || line === "data: [DONE]") return;
            try {
              const event = JSON.parse(line.slice(6)) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = event.choices?.[0]?.delta?.content;
              if (delta) appendObservationText(delta);
            } catch {
              // Malformed SSE chunk -- skip
            }
          };
          try {
            while (true) {
              if (clientClosed) break;
              const { done, value } = await reader.read();
              if (done) break;
              const wrote = await writeResponseChunkRespectingBackpressure(res, value);
              if (!wrote) {
                clientClosed = true;
                await reader.cancel().catch(() => {});
                break;
              }
              if (observationDisabled) continue;

              if (
                Buffer.byteLength(streamBuffer, "utf8") + value.byteLength >
                streamObservationMaxBytes
              ) {
                disableObservationBuffer();
                continue;
              }

              streamBuffer += decoder.decode(value, { stream: true });
              const lines = streamBuffer.split("\n");
              streamBuffer = lines.pop() ?? "";
              for (const line of lines) {
                consumeSseLine(line);
              }
            }
          } finally {
            res.off("close", onClientClose);
            if (!res.destroyed && !res.writableEnded) {
              res.end();
            }
          }
          if (clientClosed) return;

          // Best-effort: reconstruct assistant content for observation
          try {
            if (!observationDisabled) {
              const tail = decoder.decode();
              if (tail) streamBuffer += tail;
              if (streamBuffer.length > 0) {
                for (const line of streamBuffer.split("\n")) {
                  consumeSseLine(line);
                }
              }
            }
            if (!observationDisabled && assistantContent.length > 0 && query.length > 0) {
              observeTurn(
                remnicDaemonUrl,
                sessionKey,
                query,
                assistantContent,
                config.remnicAuthToken
              );
            }
          } catch {
            // Observation reconstruction failed -- non-critical
          }
          return;
        }

        // --- Non-streaming path ---
        const responseBytes = await readResponseBuffer(upstream, maxResponseBytes);

        // Parse response for observation (best-effort)
        let assistantReply = "";
        try {
          const responseJson = JSON.parse(
            responseBytes.toString("utf-8")
          ) as Record<string, unknown>;
          assistantReply = extractAssistantReply(responseJson);
        } catch {
          // Non-JSON response -- skip observation
        }

        // Fire-and-forget observe
        if (query.length > 0 && assistantReply.length > 0) {
          observeTurn(remnicDaemonUrl, sessionKey, query, assistantReply, config.remnicAuthToken);
        }

        // Return upstream response to caller, stripping hop-by-hop headers
        const chatResponseHeaders: Record<string, string> = {};
        for (const [key, value] of upstream.headers.entries()) {
          if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
            chatResponseHeaders[key] = value;
          }
        }
        chatResponseHeaders["content-length"] = String(responseBytes.length);
        res.writeHead(upstream.status, chatResponseHeaders);
        res.end(responseBytes);
      } catch (err) {
        if (err instanceof BodyLimitExceededError) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream_response_too_large" }));
          return;
        }
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "upstream_unreachable",
        }));
      }
      return;
    }

    // --- All other paths: transparent proxy ---
    // Use raw bytes to avoid corrupting binary/multipart uploads.
    let body: Buffer | null = null;
    try {
      body = method !== "GET" && method !== "HEAD"
        ? await readRawBody(req, maxRequestBytes)
        : null;
    } catch (err) {
      if (err instanceof BodyLimitExceededError) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request_body_too_large" }));
        return;
      }
      throw err;
    }
    const flat = flattenHeaders(req.headers);
    await transparentProxy(wecloneParts, method, url, flat, body, res, maxResponseBytes);
  };

  return {
    get port() {
      return resolvedPort;
    },
    get host() {
      return resolvedHost;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          requestHandler(req, res).catch((_err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal_proxy_error" }));
            }
          });
        });

        server.on("error", reject);

        server.listen(config.proxyPort, proxyBindHost, () => {
          const addr = server!.address();
          if (typeof addr === "object" && addr !== null) {
            resolvedPort = addr.port;
            resolvedHost = addr.address;
          }
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => {
          server = null;
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
