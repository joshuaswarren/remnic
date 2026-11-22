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
 *    `memoryDir + chatSessionId + principal + message` so a double-submit
 *    processes exactly once (issue #1687 Thread 18 / #1685). The memoryDir
 *    scopes the key per store (AGENTS.md State Scoping); an absent principal
 *    is encoded distinctly so it can never alias a real principal string.
 *  - The SSE stream subscribes to live transcript appends and pushes new
 *    entries to connected clients (issue #1685 item 2 / #1687 Thread 8).
 *    Subscription is established before the transcript snapshot is read so no
 *    concurrent append is missed (cursor Bugbot race fix); the burst drains
 *    the buffer only after switching to live mode so no buffered entry is
 *    dropped. The disconnect cleanup is registered immediately and guarded
 *    by a `closed` flag so an early close cannot leak the heartbeat or write
 *    to an ended response.
 *
 * This module is imported by access-http.ts with thin route registration —
 * the god-file ratchet (#1520) tracks access-http.ts LOC.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import type { EngramAccessService } from "../access-service.js";
import type { ChatConfig, ChatTranscriptEntry, ChatTurnResult } from "./chat-types.js";
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
  /**
   * Optional hook the host server supplies so the SSE handler can register
   * its disconnect cleanup with the server's stop() set (cursor Medium
   * review). Returns an unregister function the handler calls on normal
   * client disconnect. When omitted, cleanup runs only on req 'close'.
   */
  registerSseCleanup?: (cleanup: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Pending chat-message promises keyed by
 * `memoryDir:chatSessionId:principal:messageHash`.  A concurrent identical
 * POST joins the in-flight promise instead of re-processing (no second LLM
 * call, no second transcript append).  Entries are always removed via
 * `finally` so the map cannot leak across requests.
 *
 * The memoryDir is part of the key so two Remnic stores in one process
 * cannot share a promise (AGENTS.md State Scoping).  Only requests targeting
 * an existing `chatSessionId` are coalesced: when no session id is supplied
 * each request legitimately mints its own session, so identical message
 * bodies are genuinely distinct turns.
 */
const chatInFlight = new Map<string, Promise<ChatTurnResult>>();

function principalFingerprintComponent(principal: string | undefined): string {
  return principal === undefined ? "\x00absent" : `\x01${principal}`;
}

function chatDedupFingerprint(memoryDir: string, chatSessionId: string, principal: string | undefined, message: string): string {
  const messageHash = createHash("sha256").update(message, "utf8").digest("hex").slice(0, 32);
  return `${memoryDir}:${chatSessionId}:${principalFingerprintComponent(principal)}:${messageHash}`;
}

function processChatMessageDedup(opts: {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
  message: string;
  chatSessionId?: string;
  principal?: string;
}): Promise<ChatTurnResult> {
  if (!opts.chatSessionId) {
    return processChatMessage(opts);
  }
  const fp = chatDedupFingerprint(opts.memoryDir, opts.chatSessionId, opts.principal, opts.message);
  const existing = chatInFlight.get(fp);
  if (existing) return existing;
  const pending = processChatMessage(opts).finally(() => {
    chatInFlight.delete(fp);
  });
  chatInFlight.set(fp, pending);
  return pending;
}

// ---------------------------------------------------------------------------
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
    const code = err instanceof Error ? err.message : String(err);
    if (code === "chat_session_not_found") {
      respondJson(res, 404, { error: "chat_session_not_found", code: "chat_session_not_found" });
    } else if (code === "access_denied") {
      respondJson(res, 403, { error: "access_denied", code: "access_denied" });
    } else if (code === "chat_session_expired") {
      respondJson(res, 410, { error: "chat_session_expired", code: "chat_session_expired" });
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

  const wireResult = {
    reply: result.reply,
    chatSessionId: result.chatSessionId,
    ...(result.pendingPlan
      ? {
          pendingPlan: {
            planId: result.pendingPlan.planId,
            preview: result.pendingPlan.preview,
          },
        }
      : {}),
    ...(result.skippedTools
      ? { skippedTools: result.skippedTools.filter((name): name is string => typeof name === "string") }
      : {}),
  };
  respondJson(res, 200, wireResult);
}

// ---------------------------------------------------------------------------
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
 * a strictly-monotonic `seq`), clients dedupe on reconnect — the stream is
 * reconnect-safe.
 *
 * Race-free ordering (cursor Bugbot): the subscription is established BEFORE
 * the transcript snapshot is read; entries appended concurrently during the
 * snapshot read are buffered, then the buffer is drained AFTER switching to
 * live mode (so an append landing between the drain and the mode switch is
 * never dropped — cursor review). Every write goes through a `closed`-guarded
 * helper so a disconnect during the burst cannot write to an ended response
 * (cursor/kilo review). The disconnect cleanup is registered immediately and
 * guarded by `closed` so an early close cannot leak the heartbeat.
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

  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const writeSse = (chunk: string): boolean => {
    if (closed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  const pending: ChatTranscriptEntry[] = [];
  let bursting = true;
  const unsubscribe = subscribeChatTranscript(opts.memoryDir, chatSessionId, (entry) => {
    if (closed) return;
    if (bursting) {
      pending.push(entry);
      return;
    }
    writeSse(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const doCleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    try { res.end(); } catch { /* already ended */ }
  };
  const unregisterServerCleanup = opts.registerSseCleanup?.(doCleanup) ?? ((): void => {});
  req.on("close", () => {
    doCleanup();
    unregisterServerCleanup();
  });

  const session = await loadChatSession(opts.memoryDir, chatSessionId);
  if (closed) return;
  if (!session) {
    unsubscribe();
    unregisterServerCleanup();
    respondJson(res, 404, { error: "chat_session_not_found", code: "chat_session_not_found" });
    return;
  }
  if (!sessionBelongsToPrincipal(session, principal)) {
    unsubscribe();
    unregisterServerCleanup();
    respondJson(res, 403, { error: "access_denied", code: "access_denied" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeSse("retry: 5000\n\n");

  const deliveredSeqs = new Set<number>();
  for (const entry of session.transcript) {
    writeSse(`data: ${JSON.stringify(entry)}\n\n`);
    deliveredSeqs.add(entry.seq);
  }

  bursting = false;
  for (const entry of pending) {
    if (!deliveredSeqs.has(entry.seq)) {
      writeSse(`data: ${JSON.stringify(entry)}\n\n`);
    }
  }

  if (closed) return;
  heartbeat = setInterval(() => {
    writeSse(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`);
  }, 25_000);
  heartbeat.unref?.();
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json, "utf8"),
  });
  res.end(json);
}
