/**
 * Chat HTTP handler (issue #1583 PR 3).
 *
 * Implements the HTTP backend for the admin console Chat pane:
 * - POST /engram/v1/chat/message — send a message, get a reply
 * - GET  /engram/v1/chat/events/:chatSessionId — SSE stream for replies
 *
 * Auth: same Bearer token as every other admin endpoint (loopback bearer).
 * Per-session isolation: every request verifies the session's principal
 * matches the caller (rule 42/47).
 *
 * This module is imported by access-http.ts with thin route registration —
 * the god-file ratchet (#1520) tracks access-http.ts LOC.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { EngramAccessService } from "../access-service.js";
import type { ChatConfig } from "./chat-types.js";
import type { ChatTurnResult } from "./chat-types.js";
import { ChatEngine } from "./chat-engine.js";
import { isConfirmationMessage } from "./chat-engine.js";
import { createProductionChatLlmAdapter } from "./chat-llm.js";
import { createChatExecutor } from "./chat-executor.js";
import {
  createChatSession,
  loadChatSession,
  appendTranscriptEntry,
  sessionBelongsToPrincipal,
} from "./chat-session.js";

export interface ChatHttpHandlerOptions {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
}

/**
 * Handle POST /engram/v1/chat/message.
 *
 * Body: `{ message: string, chatSessionId?: string }`
 * Response: `{ reply: string, chatSessionId: string, pendingPlan?: {...} }`
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

  const llm = opts.service.fallbackLlmRef ?? opts.service.localLlmRef;
  if (!llm) {
    respondJson(res, 503, {
      error: "No LLM model is available. Configure a local or cloud model.",
      code: "no_llm",
    });
    return;
  }

  const adapter = createProductionChatLlmAdapter(llm as {
    chatCompletion(
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; signal?: AbortSignal },
    ): Promise<{ content: string } | null>;
  });

  // Load or create session.
  const requestedSessionId = typeof body.chatSessionId === "string" ? body.chatSessionId : undefined;
  let session;
  if (requestedSessionId) {
    session = await loadChatSession(opts.memoryDir, requestedSessionId);
    if (!session) {
      respondJson(res, 404, { error: "chat_session_not_found", code: "chat_session_not_found" });
      return;
    }
    if (!sessionBelongsToPrincipal(session, principal)) {
      respondJson(res, 403, { error: "access_denied", code: "access_denied" });
      return;
    }
  } else {
    session = await createChatSession(opts.memoryDir, { principal });
  }

  const executor = createChatExecutor({
    service: opts.service,
    principal,
    ...(session.namespace ? { namespace: session.namespace } : {}),
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
  });

  const engine = new ChatEngine({
    llm: adapter,
    executor,
    maxToolCallsPerTurn: opts.config.maxToolCallsPerTurn,
    ...(opts.config.model ? { model: opts.config.model } : {}),
    correctionAvailable: false,
    scopeInspectAvailable: false,
  });

  await appendTranscriptEntry(opts.memoryDir, session.id, {
    role: "user",
    content: message,
  });

  const result: ChatTurnResult = await engine.processMessage(message, session);

  await appendTranscriptEntry(opts.memoryDir, session.id, {
    role: "assistant",
    content: result.reply,
  });

  respondJson(res, 200, result);
}

/**
 * Handle GET /engram/v1/chat/events/:chatSessionId.
 *
 * SSE stream.  Sends a heartbeat every 25s so proxies don't time out.
 * Currently streams the session transcript as an initial burst, then keeps
 * the connection open for future updates.
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

  // Send the transcript as an initial burst.
  for (const entry of session.transcript) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

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
