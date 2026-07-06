/**
 * Chat HTTP handler (issue #1583 PR 3; deferred items #1685 / #1687).
 *
 * Implements the HTTP backend for the admin console Chat pane:
 * - POST /engram/v1/chat/message — send a message, get a reply
 * - GET  /engram/v1/chat/events/:chatSessionId — SSE stream for replies
 *
 * Auth: same Bearer token as every other admin endpoint (loopback bearer).
 * Per-session isolation: every request verifies the session's principal
 * matches the caller (rule 42/47).
 *
 * Deferred items wired here (issues #1685 / #1687):
 *  - The HTTP message handler delegates to the shared `processChatMessage`
 *    (Thread 18) so session/engine/transcript construction is identical to
 *    the MCP surface, instead of re-implementing it.
 *  - Concurrent identical POSTs are coalesced by an in-flight dedup keyed on
 *    `chatSessionId + principal + message` so a double-submit processes
 *    exactly once (issue #1687 Thread 18 / #1685).
 *  - The SSE stream subscribes to live transcript appends and pushes new
 *    entries to connected clients (issue #1685 item 2 / #1687 Thread 8).
 *
 * This module is imported by access-http.ts with thin route registration —
 * the god-file ratchet (#1520) tracks access-http.ts LOC.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import type { EngramAccessService } from "../access-service.js";
import type { ChatConfig } from "./chat-types.js";
import type { ChatTurnResult } from "./chat-types.js";
import { processChatMessage } from "./chat-factory.js";
import {
  loadChatSession,
  sessionBelongsToPrincipal,
  subscribeChatTranscript,
} from "./chat-session.js";

export interface ChatHttpHandlerOptions {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
}

// ---------------------------------------------------------------------------
// In-flight request dedup (issue #1687 Thread 18 / #1685)
// ---------------------------------------------------------------------------

/**
 * Pending chat-message promises keyed by `chatSessionId:principal:messageHash`.
 * A concurrent identical POST joins the in-flight promise instead of
 * re-processing (no second LLM call, no second transcript append).  Entries
 * are always removed via `finally` so the map cannot leak across requests.
 *
 * Only requests targeting an existing `chatSessionId` are coalesced: when no
 * session id is supplied each request legitimately mints its own session, so
 * identical message bodies are genuinely distinct turns.
 */
const chatInFlight = new Map<string, Promise<ChatTurnResult>>();

function chatDedupFingerprint(chatSessionId: string, principal: string, message: string): string {
  // sha256 keeps the key bounded for long messages; the principal is part of
  // the key so two callers targeting the same session id can never share a
  // result (the wrong principal still independently hits access_denied).
  const messageHash = createHash("sha256").update(message, "utf8").digest("hex").slice(0, 32);
  return `${chatSessionId}:${principal}:${messageHash}`;
}

/**
 * Run `processChatMessage` with concurrent-identical-request coalescing.
 * Distinct messages (or distinct sessions / principals) never collide.
 */
function processChatMessageDedup(opts: {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
  message: string;
  chatSessionId?: string;
  principal?: string;
}): Promise<ChatTurnResult> {
  // No session id → no coalescing (each request creates its own session).
  if (!opts.chatSessionId) {
    return processChatMessage(opts);
  }
  const principal = opts.principal ?? "_";
  const fp = chatDedupFingerprint(opts.chatSessionId, principal, opts.message);
  const existing = chatInFlight.get(fp);
  if (existing) return existing;
  const pending = processChatMessage(opts).finally(() => {
    chatInFlight.delete(fp);
  });
  chatInFlight.set(fp, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// POST /engram/v1/chat/message
// ---------------------------------------------------------------------------

/**
 * Handle POST /engram/v1/chat/message.
 *
 * Body: `{ message: string, chatSessionId?: string }`
 * Response: `{ reply: string, chatSessionId: string, pendingPlan?: {...} }`
 *
 * Boundary checks (chat-disabled / missing message / no-LLM) run before
 * delegation so each maps to a precise HTTP status without spinning up a
 * session.  Session/engine work is delegated to `processChatMessage`
 * (Thread 18), wrapped in {@link processChatMessageDedup} for double-submit
 * protection.
 */
export async function handleChatMessage(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  opts: ChatHttpHandlerOptions,
  principal?: string,
): Promise<void> {
  if (!opts.config?.enabled) {
    respondJson(res, 404, { error: "chat_disabled", code: "chat_disabled" });
    return;
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message) {
    respondJson(res, 400, { error: "message is required", code: "input_error" });
    return;
  }

  if (!opts.service.fallbackLlmRef && !opts.service.localLlmRef) {
    respondJson(res, 503, {
      error: "No LLM model is available. Configure a local or cloud model.",
      code: "no_llm",
    });
    return;
  }

  const chatSessionId = typeof body.chatSessionId === "string" ? body.chatSessionId : undefined;

  let result: ChatTurnResult;
  try {
    result = await processChatMessageDedup({
      service: opts.service,
      config: opts.config,
      memoryDir: opts.memoryDir,
      message,
      ...(chatSessionId ? { chatSessionId } : {}),
      ...(principal ? { principal } : {}),
    });
  } catch (err) {
    // processChatMessage throws tagged errors for the session/LLM/engine
    // paths; map each back to its HTTP status.  Dedup coalescing means a
    // concurrent duplicate shares the same rejection.
    const code = err instanceof Error ? err.message : String(err);
    if (code === "chat_session_not_found") {
      respondJson(res, 404, { error: "chat_session_not_found", code: "chat_session_not_found" });
    } else if (code === "access_denied") {
      respondJson(res, 403, { error: "access_denied", code: "access_denied" });
    } else if (code === "chat_disabled") {
      respondJson(res, 404, { error: "chat_disabled", code: "chat_disabled" });
    } else if (code === "no_llm_available" || code === "engine_unavailable") {
      respondJson(res, 503, {
        error: "No LLM model is available. Configure a local or cloud model.",
        code: "no_llm",
      });
    } else {
      respondJson(res, 500, { error: "internal_error", code: "internal_error" });
    }
    return;
  }

  // Strip internal error details from the wire response (CodeQL — no stack
  // traces or internal messages leak to the client; keep only the tagged reply).
  const wireResult = result.error
    ? { reply: result.reply, chatSessionId: result.chatSessionId, ...(result.pendingPlan ? { pendingPlan: result.pendingPlan } : {}) }
    : result;
  respondJson(res, 200, wireResult);
}

// ---------------------------------------------------------------------------
// GET /engram/v1/chat/events/:chatSessionId (SSE)
// ---------------------------------------------------------------------------

/**
 * Handle GET /engram/v1/chat/events/:chatSessionId.
 *
 * SSE stream.  Sends the existing transcript as an initial burst, then keeps
 * the connection open and **pushes new transcript entries live** as they are
 * appended (issue #1685 item 2 / #1687 Thread 8) via the per-session pub/sub
 * in `chat-session.ts`.  A heartbeat is emitted every 25 s so proxies do not
 * time out.  A `retry:` directive asks reconnecting clients to wait 5 s, and
 * because the initial burst always replays the full transcript (entries carry
 * a monotonic `seq`), clients dedupe on reconnect — the stream is
 * reconnect-safe.
 */
export async function handleChatEventsSSE(
  req: IncomingMessage,
  res: ServerResponse,
  chatSessionId: string,
  opts: ChatHttpHandlerOptions,
  principal?: string,
): Promise<void> {
  if (!opts.config?.enabled) {
    respondJson(res, 404, { error: "chat_disabled", code: "chat_disabled" });
    return;
  }

  const session = await loadChatSession(opts.memoryDir, chatSessionId);
  if (!session) {
    respondJson(res, 404, { error: "chat_session_not_found", code: "chat_session_not_found" });
    return;
  }
  if (!sessionBelongsToPrincipal(session, principal)) {
    respondJson(res, 403, { error: "access_denied", code: "access_denied" });
    return;
  }

  // SSE headers.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Ask reconnecting clients to wait 5 s before retrying (reconnect-safe:
  // the initial burst below replays the full transcript on rejoin).
  res.write("retry: 5000\n\n");

  // Send the transcript as an initial burst.
  for (const entry of session.transcript) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // Push live entries: subscribe to the per-session pub/sub so any new
  // user/assistant line (appended by the HTTP/MCP/CLI path) is delivered to
  // this connection immediately.  Listener errors are swallowed inside
  // appendTranscriptEntry, so a write failure here is also guarded.
  const unsubscribe = subscribeChatTranscript(chatSessionId, (entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      // Connection closed — cleanup below.
    }
  });

  // Heartbeat. Unref'd so a lingering connection never blocks process
  // exit (rule 47 — no shared mutable objects keep the loop alive).
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);
    } catch {
      // Connection closed — clearInterval below.
    }
  }, 25_000);
  heartbeat.unref();

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch { /* already ended */ }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json, "utf8"),
  });
  res.end(json);
}
