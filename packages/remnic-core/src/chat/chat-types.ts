/**
 * Shared types for the conversational memory chat engine (issue #1583).
 *
 * The chat engine is a deliberately bounded tool-loop agent — NOT a general
 * assistant.  It exposes a fixed set of read-only and (confirmation-gated)
 * mutating tools, each a thin adapter over an existing access-service method.
 */

// ---------------------------------------------------------------------------
// LLM adapter — production signature (rule 33), stubbable for tests
// ---------------------------------------------------------------------------

/**
 * A single chat message in the LLM conversation.
 */
export interface ChatLlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool-call id when role === "tool" (correlates the result back). */
  toolCallId?: string;
}

/**
 * A tool-call request emitted by the LLM.  The engine parses these from the
 * LLM response and dispatches them through the tool registry.
 */
export interface ChatLlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Structured LLM response — either a text reply or a set of tool calls.
 * The adapter (stub or production) is responsible for parsing the raw model
 * output into this shape.
 */
export interface ChatLlmResponse {
  /** Assistant text reply (empty when only tool calls are present). */
  content: string;
  /** Tool calls to execute (empty for a final text reply). */
  toolCalls: ChatLlmToolCall[];
}

/**
 * Production-grade LLM adapter interface.  The stub implementation used in
 * tests drives scripted sequences; the production implementation wraps the
 * existing FallbackLlmClient routing chain so local Ollama/vLLM models are
 * fully supported (gotcha 1).
 */
export interface ChatLlmAdapter {
  /**
   * Send the conversation so far to the LLM and receive the next response.
   * Returns `null` when no model is available or the request fails (rule 13).
   */
  complete(
    messages: ChatLlmMessage[],
    options: {
      tools: ChatToolSchema[];
      model?: string;
      signal?: AbortSignal;
    },
  ): Promise<ChatLlmResponse | null>;
}

// ---------------------------------------------------------------------------
// Tool schema + execution
// ---------------------------------------------------------------------------

/**
 * JSON-Schema description of a chat tool, sent to the LLM so it knows what
 * tools are available and how to call them.
 */
export interface ChatToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Result of executing a chat tool.  Read-only tools return data; mutating
 * tools go through the confirmation protocol before they reach the executor.
 */
export interface ChatToolResult {
  /** Structured payload returned to the LLM as a tool message. */
  content: string;
  /** Whether the tool call was intercepted by the confirmation protocol. */
  pendingConfirmation?: boolean;
  /** Plan preview when pendingConfirmation is true. */
  planPreview?: string;
}

// ---------------------------------------------------------------------------
// Chat session — transcript + pending-plan state
// ---------------------------------------------------------------------------

/**
 * A single line in the persisted chat transcript (JSONL).
 */
export interface ChatTranscriptEntry {
  /** Monotonic sequence number within the session. */
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Tool-call id for tool messages. */
  toolCallId?: string;
  /** Tool name for tool messages. */
  toolName?: string;
}

/**
 * In-memory session state, backed by the JSONL transcript on disk.
 */
export interface ChatSessionState {
  id: string;
  /** Caller principal bound at creation (rule 42). */
  principal?: string;
  /** Session key for namespace resolution. */
  sessionKey?: string;
  /** Namespace override. */
  namespace?: string;
  /** Transcript entries loaded from disk. */
  transcript: ChatTranscriptEntry[];
  /** Plan ids confirmed by the user for exactly one apply. */
  confirmedPlanIds: Set<string>;
  /** The pending plan awaiting confirmation (if any). */
  pendingPlanId?: string;
  /** Creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Engine turn result
// ---------------------------------------------------------------------------

/**
 * What the engine returns for a single user message.
 */
export interface ChatTurnResult {
  /** The assistant's text reply (may be partial on budget exhaustion). */
  reply: string;
  /** The chat session id (existing or newly created). */
  chatSessionId: string;
  /** A pending plan awaiting user confirmation, if surfaced. */
  pendingPlan?: {
    planId: string;
    preview: string;
  };
  /** Tool calls that were skipped due to budget exhaustion. */
  skippedTools?: string[];
  /** Whether the reply is a tagged error (rule 13). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Chat config — re-exported from types.ts (canonical definition).
// DEFAULT_CHAT_CONFIG lives in chat-config.ts.
// ---------------------------------------------------------------------------

export type { ChatConfig } from "../types.js";
