/**
 * Chat engine factory + message processor (issue #1583).
 *
 * Wires the LLM adapter, executor, and engine from config + access-service.
 * Used by all three surfaces (CLI, HTTP, MCP) so they share identical
 * engine construction and session lifecycle.
 */

import type { EngramAccessService } from "../access-service.js";
import type { FallbackLlmClient } from "../fallback-llm.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { ChatConfig, ChatTurnResult } from "./chat-types.js";
import { ChatEngine } from "./chat-engine.js";
import { createProductionChatLlmAdapter } from "./chat-llm.js";
import { createChatExecutor } from "./chat-executor.js";
import {
  createChatSession,
  loadChatSession,
  appendTranscriptEntry,
  sessionBelongsToPrincipal,
  markPendingPlan,
  markPlanResolved,
  markPendingPromotion,
  markPromotionResolved,
} from "./chat-session.js";

export interface ChatEngineFactoryOptions {
  service: EngramAccessService;
  config: ChatConfig;
  fallbackLlm: FallbackLlmClient | null;
  localLlm: LocalLlmClient | null;
  principal?: string;
  namespace?: string;
  sessionKey?: string;
}

/**
 * Create a {@link ChatEngine} from the factory options.  Returns `null` when
 * no LLM client is available.  The engine uses the fallback LLM chain first
 * (cloud/gateway), then the local LLM chain — both fully supported (gotcha 1).
 */
export function createChatEngine(opts: ChatEngineFactoryOptions): ChatEngine | null {
  const llmClient = opts.fallbackLlm ?? opts.localLlm;
  if (!llmClient) return null;

  const adapter = createProductionChatLlmAdapter(llmClient as {
    chatCompletion(
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; signal?: AbortSignal },
    ): Promise<{ content: string } | null>;
  });

  const executor = createChatExecutor({
    service: opts.service,
    principal: opts.principal,
    namespace: opts.namespace,
    sessionKey: opts.sessionKey,
  });

  return new ChatEngine({
    llm: adapter,
    executor,
    maxToolCallsPerTurn: opts.config.maxToolCallsPerTurn,
    ...(opts.config.model ? { model: opts.config.model } : {}),
    correctionAvailable: false,
    scopeInspectAvailable: false,
  });
}

/**
 * Process a single chat message end-to-end.  Shared by MCP and HTTP surfaces
 * so session lifecycle, transcript persistence, and error handling are
 * identical across transports.
 *
 * Throws when chat is disabled or no LLM is available.
 */
export async function processChatMessage(opts: {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
  message: string;
  chatSessionId?: string;
  principal?: string;
}): Promise<ChatTurnResult> {
  if (!opts.config?.enabled) {
    throw new Error("chat_disabled");
  }
  if (!opts.service.fallbackLlmRef && !opts.service.localLlmRef) {
    throw new Error("no_llm_available");
  }

  // Load or create the session FIRST so the engine inherits the session's
  // namespace/sessionKey scope (rule 42 — every tool call flows with that
  // identity; the executor must not use a different scope than the session).
  let session;
  if (opts.chatSessionId) {
    session = await loadChatSession(opts.memoryDir, opts.chatSessionId);
    if (!session) throw new Error("chat_session_not_found");
    if (!sessionBelongsToPrincipal(session, opts.principal)) {
      throw new Error("access_denied");
    }
  } else {
    session = await createChatSession(opts.memoryDir, { principal: opts.principal });
  }

  const engine = createChatEngine({
    service: opts.service,
    config: opts.config as ChatConfig,
    fallbackLlm: opts.service.fallbackLlmRef,
    localLlm: opts.service.localLlmRef,
    principal: opts.principal,
    ...(session.namespace ? { namespace: session.namespace } : {}),
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
  });
  if (!engine) {
    throw new Error("engine_unavailable");
  }

  await appendTranscriptEntry(opts.memoryDir, session.id, {
    role: "user",
    content: opts.message,
  });

  const result = await engine.processMessage(opts.message, session);

  await appendTranscriptEntry(opts.memoryDir, session.id, {
    role: "assistant",
    content: result.reply,
  });

  // Persist pending-plan/promotion state so a later turn can confirm it
  // (append-only — loadChatSession scans for the latest unresolved marker).
  if (result.pendingPlan?.planId) {
    await markPendingPlan(opts.memoryDir, session.id, result.pendingPlan.planId);
  } else if (session.pendingPromotionId) {
    await markPendingPromotion(opts.memoryDir, session.id, session.pendingPromotionId);
  } else {
    // Turn resolved any pending state — record the resolution.
    await markPlanResolved(opts.memoryDir, session.id, "resolved");
  }

  return result;
}
