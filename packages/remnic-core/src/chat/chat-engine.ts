/**
 * Chat engine — the bounded tool-loop agent (issue #1583).
 *
 * Loop: user message → LLM (with tool schema) → execute tool calls → feed
 * results back → final reply.  Max `chat.maxToolCallsPerTurn` tool calls per
 * user turn; budget exhausted → reply with partial results + what was
 * skipped (rule 34 — never a silent stall).
 *
 * Confirmation protocol (the safety core): mutating tools
 * (correction_apply, memory_promote) are two-phase in the engine itself,
 * independent of the LLM's judgment.  The engine intercepts a mutation tool
 * call, checks the session's confirmedPlanIds set; absent → the engine
 * returns the plan preview to the user with a confirmation prompt; the
 * user's affirmative (exact-match: yes/y/apply/confirm — deterministic, not
 * LLM-interpreted) marks it confirmed for ONE apply.
 */

import { randomUUID } from "node:crypto";

import type {
  ChatLlmAdapter,
  ChatLlmMessage,
  ChatSessionState,
  ChatToolResult,
  ChatToolSchema,
  ChatTurnResult,
} from "./chat-types.js";
import { buildChatSystemPrompt } from "./chat-system-prompt.js";
import {
  buildChatToolSchemas,
  MUTATING_TOOLS,
  type ChatToolName,
} from "./chat-tools.js";

// ---------------------------------------------------------------------------
// Tool executor — delegates each tool to access-service (rule 22)
// ---------------------------------------------------------------------------

/**
 * The executor interface the engine calls for each tool.  Each implementation
 * is a thin adapter over the corresponding access-service method — zero new
 * business logic lives in the engine.
 */
export interface ChatToolExecutor {
  memorySearch(query: string, maxResults?: number): Promise<string>;
  memoryGet(memoryId: string): Promise<string>;
  memoryTimeline(memoryId: string, limit?: number): Promise<string>;
  recallExplain(query: string): Promise<string>;
  entityGet(name: string): Promise<string>;
  stats(): Promise<string>;
  reviewList(runId?: string): Promise<string>;
  scopeInspect(): Promise<string>;
  /**
   * Generate a correction plan.  Returns a JSON string with a planId and
   * a diff preview.  When the Correction Contract (#1580) is not merged,
   * this is a stub that returns a not-available marker.
   */
  correctionPlan(request: string): Promise<{ planId: string; preview: string }>;
  /**
   * Apply a correction plan.  Returns a JSON result string.
   */
  correctionApply(planId: string): Promise<string>;
  /**
   * Promote a memory's tier.  Returns a JSON result string.
   */
  memoryPromote(memoryId: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Engine options
// ---------------------------------------------------------------------------

export interface ChatEngineOptions {
  llm: ChatLlmAdapter;
  executor: ChatToolExecutor;
  maxToolCallsPerTurn: number;
  model?: string;
  /** Whether the Correction Contract (#1580) plan/apply is available. */
  correctionAvailable: boolean;
  /** Whether the scope resolver (#1494) is available. */
  scopeInspectAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Confirmation keywords — deterministic, not LLM-interpreted
// ---------------------------------------------------------------------------

// Exact-match confirmations. Unrecognized text keeps the conservative
// no-apply default, so this stays a small fixed set (issue #2198).
const CONFIRMATION_KEYWORDS: Record<string, true> = {
  yes: true,
  y: true,
  apply: true,
  confirm: true,
  "はい": true, // Japanese
  "sí": true, // Spanish
  ja: true, // German/Dutch
  "نعم": true, // Arabic
};

export function isConfirmationMessage(text: string): boolean {
  return CONFIRMATION_KEYWORDS[text.trim().toLowerCase()] === true;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ChatEngine {
  private readonly llm: ChatLlmAdapter;
  private readonly executor: ChatToolExecutor;
  private readonly maxToolCallsPerTurn: number;
  private readonly model?: string;
  private readonly correctionAvailable: boolean;
  private readonly scopeInspectAvailable: boolean;
  private readonly systemPrompt: string;
  private readonly toolSchemas: ChatToolSchema[];
  private readonly allowedToolNames: Set<string>;

  constructor(opts: ChatEngineOptions) {
    this.llm = opts.llm;
    this.executor = opts.executor;
    this.maxToolCallsPerTurn = opts.maxToolCallsPerTurn;
    this.model = opts.model;
    this.correctionAvailable = opts.correctionAvailable;
    this.scopeInspectAvailable = opts.scopeInspectAvailable;
    this.systemPrompt = buildChatSystemPrompt({
      correctionAvailable: opts.correctionAvailable,
    });
    this.toolSchemas = buildChatToolSchemas({
      correctionAvailable: opts.correctionAvailable,
      scopeInspectAvailable: opts.scopeInspectAvailable,
    });
    // Pre-compute the set of allowed tool names for fast lookup (cursor HIGH —
    // executeTool must not run a tool that's not in the active schema set).
    this.allowedToolNames = new Set(this.toolSchemas.map((t) => t.function.name));
  }

  /**
   * Process a single user message.  The session state is mutated in place
   * (confirmedPlanIds, pendingPlanId) — the caller persists the transcript.
   */
  async processMessage(
    userMessage: string,
    session: ChatSessionState,
  ): Promise<ChatTurnResult> {
    // ── Confirmation fast-path ──────────────────────────────────────────
    // If there is a pending plan and the user's message is an exact-match
    // confirmation keyword, mark the plan confirmed and apply it directly
    // (bypassing the LLM — deterministic, not LLM-interpreted).
    if (
      isConfirmationMessage(userMessage) &&
      this.correctionAvailable
    ) {
      // Confirm + apply a pending correction plan.
      if (session.pendingPlanId) {
        const planId = session.pendingPlanId;
        session.confirmedPlanIds.add(planId);
        session.pendingPlanId = undefined;
        try {
          const applyResult = await this.executor.correctionApply(planId);
          // Consume the one-time confirmation on success so a later
          // tool-loop correction_apply cannot re-apply the same plan id
          // (cursor Medium: stale confirm allowed re-apply).
          session.confirmedPlanIds.delete(planId);
          return {
            reply: `Correction applied.\n\n${applyResult}`,
            chatSessionId: session.id,
            ...(session.pendingPromotionId ? {} : {}),
          };
        } catch (err) {
          // Roll back: the plan was NOT applied — restore the pending state
          // so the user can retry (cursor HIGH OlACo).
          session.confirmedPlanIds.delete(planId);
          session.pendingPlanId = planId;
          const msg = err instanceof Error ? err.message : String(err);
          return {
            reply: "[error] Failed to apply the correction. Please try again or re-request the plan.",
            chatSessionId: session.id,
            error: msg,
          };
        }
      }
      // Confirm + apply a pending memory promotion.
      if (session.pendingPromotionId) {
        const memoryId = session.pendingPromotionId;
        session.pendingPromotionId = undefined;
        try {
          const promoteResult = await this.executor.memoryPromote(memoryId);
          return {
            reply: `Memory promoted.\n\n${promoteResult}`,
            chatSessionId: session.id,
          };
        } catch (err) {
          // Roll back: the promotion was NOT applied — restore pending state.
          session.pendingPromotionId = memoryId;
          const msg = err instanceof Error ? err.message : String(err);
          return {
            reply: "[error] Failed to promote the memory. Please try again.",
            chatSessionId: session.id,
            error: msg,
          };
        }
      }
    }

    // ── Normal tool-loop ────────────────────────────────────────────────
    // Build the transcript context, filtering out:
    //  - the system header (seq === 0)
    //  - internal state markers (pending_plan:/pending_promotion:/plan_applied:)
    //  - the last user entry if it matches userMessage (the caller already
    //    appended it to the transcript before calling processMessage — adding
    //    it again below would duplicate it in the prompt).
    const recentEntries = session.transcript
      .slice(-21)
      .filter((e) => e.role !== "system" || e.seq !== 0)
      .filter((e) => !(e.role === "system" && /^[a-z_]+:/.test(e.content)))
      .filter((e, _i, arr) => {
        // Drop the last user entry if it duplicates the current message.
        if (e.role === "user" && e.content === userMessage) {
          const lastUser = [...arr].reverse().find((x) => x.role === "user");
          return e !== lastUser;
        }
        return true;
      });
    const conversation: ChatLlmMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...recentEntries.map((e) => ({
        role: e.role as "user" | "assistant" | "tool",
        content: e.content,
        ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}),
      })),
      { role: "user", content: userMessage },
    ];

    let toolCallCount = 0;
    const skippedTools: string[] = [];
    let pendingPlan: { planId: string; preview: string } | undefined;

    for (;;) {
      let response;
      try {
        response = await this.llm.complete(conversation, {
          tools: this.toolSchemas,
          ...(this.model ? { model: this.model } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          reply: "[error] The model request failed. Check your model configuration and retry.",
          chatSessionId: session.id,
          error: msg,
        };
      }

      // LLM outage (rule 13) — tagged error reply.
      if (!response) {
        return {
          reply: "[error] No LLM model is available. Configure a local or cloud model to use Remnic Chat.",
          chatSessionId: session.id,
          error: "no_llm_available",
        };
      }

      // No tool calls → final reply.
      if (response.toolCalls.length === 0) {
        // Citation guard: if the reply asserts memory content without tool
        // results in this turn, append a citation-missing warning.
        let reply = response.content;
        if (toolCallCount === 0 && looksLikeMemoryAssertion(reply)) {
          reply += "\n\n⚠️ The above assertion was not grounded in a tool result this turn. Please verify with memory_search or memory_get.";
        }
        return {
          reply,
          chatSessionId: session.id,
          ...(pendingPlan ? { pendingPlan } : {}),
          ...(skippedTools.length > 0 ? { skippedTools } : {}),
        };
      }

      // Push the assistant response content once for this LLM turn (not per
      // tool call — avoids duplicate assistant messages in the conversation).
      conversation.push({ role: "assistant", content: response.content });

      // Execute each tool call (budget-limited).
      for (const tc of response.toolCalls) {
        if (toolCallCount >= this.maxToolCallsPerTurn) {
          skippedTools.push(tc.name);
          continue;
        }
        toolCallCount++;

        // ── Tool-schema gate (cursor HIGH OlCjs — must run before mutating-tool
        // interception so disabled tools like correction_apply/memory_promote
        // are rejected before any confirmation flow or executor call).
        if (!this.allowedToolNames.has(tc.name)) {
          conversation.push({
            role: "tool",
            content: JSON.stringify({ error: `Tool '${tc.name}' is not available in this configuration.` }),
            toolCallId: tc.id,
          });
          continue;
        }

        // ── Confirmation protocol for mutating tools ──────────────────
        if (MUTATING_TOOLS.has(tc.name as ChatToolName)) {
          if (tc.name === "correction_apply") {
            const planId = typeof tc.arguments.planId === "string" ? tc.arguments.planId : "";
            if (!session.confirmedPlanIds.has(planId)) {
              // Not confirmed — return the plan preview for user confirmation.
              // The plan was generated by a prior correction_plan call; fetch it.
              try {
                const plan = await this.executor.correctionPlan(
                  `retrieve plan ${planId}`,
                );
                // Bind the REQUESTED planId so the confirmation fast-path applies
                // the exact plan shown (not an executor re-minted id).
                pendingPlan = { planId, preview: plan.preview };
                session.pendingPlanId = planId;
                conversation.push({
                  role: "tool",
                  content: JSON.stringify({
                    intercepted: true,
                    message: "This mutation requires confirmation. The plan preview has been shown to the user.",
                  }),
                  toolCallId: tc.id,
                });
                return {
                  reply: formatPlanPreview(plan.preview),
                  chatSessionId: session.id,
                  pendingPlan,
                };
              } catch {
                conversation.push({
                  role: "tool",
                  content: JSON.stringify({ error: "Plan not found or expired." }),
                  toolCallId: tc.id,
                });
                continue;
              }
            }
            // Confirmed — consume the one-time confirmation.
            session.confirmedPlanIds.delete(planId);
          }
        }

        // ── memory_promote confirmation (mutating tool) ─────────────────
        // memory_promote is NEVER executed directly in the tool loop — it can
        // only be applied via the confirmation fast-path at the top of
        // processMessage (cursor HIGH: prevent bypass via repeated tool calls).
        if (tc.name === "memory_promote" && this.correctionAvailable) {
          const memoryId = typeof tc.arguments.memoryId === "string" ? tc.arguments.memoryId : "";
          session.pendingPromotionId = memoryId;
          conversation.push({
            role: "tool",
            content: JSON.stringify({
              intercepted: true,
              message: `Memory promotion requires confirmation. Reply 'apply' to promote memory '${memoryId}'.`,
            }),
            toolCallId: tc.id,
          });
          return {
            reply: `I want to promote memory \`${memoryId}\`. Reply **apply** to confirm this promotion, or **cancel** to discard it.`,
            chatSessionId: session.id,
          };
        }

        // ── Execute the tool ───────────────────────────────────────────
        let result: ChatToolResult;
        try {
          result = await this.executeTool(tc.name, tc.arguments, session);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { content: JSON.stringify({ error: msg }) };
        }

        // Feed the tool result back into the conversation.
        conversation.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });

        // If a correction_plan surfaced, track the pending plan.
        if (tc.name === "correction_plan" && this.correctionAvailable) {
          try {
            const parsed = JSON.parse(result.content) as { planId?: string; preview?: string };
            if (parsed.planId && parsed.preview) {
              pendingPlan = { planId: parsed.planId, preview: parsed.preview };
              session.pendingPlanId = parsed.planId;
            }
          } catch {
            // The plan result might be a stub — that's fine.
          }
        }
      }

      // If we hit the budget and there are still tool calls, report partial.
      if (skippedTools.length > 0) {
        // Ask the LLM for a final summary with what we have.
        conversation.push({
          role: "user",
          content: `[system] Tool budget exhausted (${this.maxToolCallsPerTurn} calls). ${skippedTools.length} tool(s) were skipped: ${skippedTools.join(", ")}. Please summarize what you found.`,
        });
        // One more LLM call for the summary, then we're done.
        let summaryResponse;
        try {
          summaryResponse = await this.llm.complete(conversation, {
            tools: [], // No more tools — force a text reply.
            ...(this.model ? { model: this.model } : {}),
          });
        } catch {
          // Budget-exhaustion summary is best-effort — don't mask the partial
          // results with a transport error (kilo review, Thread 16).
          summaryResponse = null;
        }
        const summaryText = summaryResponse?.content ?? "I reached my tool-call budget. Here is what I found so far, but some queries were skipped.";
        return {
          reply: summaryText,
          chatSessionId: session.id,
          ...(pendingPlan ? { pendingPlan } : {}),
          skippedTools,
        };
      }
    }
  }

  /**
   * Execute a single tool by name, delegating to the executor.
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    _session: ChatSessionState,
  ): Promise<ChatToolResult> {
    switch (name as ChatToolName) {
      case "memory_search": {
        const query = typeof args.query === "string" ? args.query : "";
        const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
        return { content: await this.executor.memorySearch(query, maxResults) };
      }
      case "memory_get": {
        const memoryId = typeof args.memoryId === "string" ? args.memoryId : "";
        return { content: await this.executor.memoryGet(memoryId) };
      }
      case "memory_timeline": {
        const memoryId = typeof args.memoryId === "string" ? args.memoryId : "";
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return { content: await this.executor.memoryTimeline(memoryId, limit) };
      }
      case "recall_explain": {
        const query = typeof args.query === "string" ? args.query : "";
        return { content: await this.executor.recallExplain(query) };
      }
      case "entity_get": {
        const entityName = typeof args.name === "string" ? args.name : "";
        return { content: await this.executor.entityGet(entityName) };
      }
      case "stats": {
        return { content: await this.executor.stats() };
      }
      case "correction_plan": {
        const request = typeof args.request === "string" ? args.request : "";
        const plan = await this.executor.correctionPlan(request);
        return { content: JSON.stringify(plan) };
      }
      case "correction_apply": {
        const planId = typeof args.planId === "string" ? args.planId : "";
        return { content: await this.executor.correctionApply(planId) };
      }
      case "memory_promote": {
        const memoryId = typeof args.memoryId === "string" ? args.memoryId : "";
        return { content: await this.executor.memoryPromote(memoryId) };
      }
      case "review_list": {
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        return { content: await this.executor.reviewList(runId) };
      }
      case "scope_inspect": {
        return { content: await this.executor.scopeInspect() };
      }
      default:
        return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: does the reply look like it's asserting stored memory content
 * without citing a tool result?  This is intentionally simple — flag, don't
 * police perfectly (per the issue's pitfall note).
 */
function looksLikeMemoryAssertion(text: string): boolean {
  const lower = text.toLowerCase();
  // Phrases that indicate a memory assertion.
  const assertionPhrases = [
    "you remember",
    "i remember",
    "according to my memory",
    "your memory",
    "stored memory",
    "remnic remembers",
    "remnic knows",
  ];
  // Only flag if there's an assertion AND no citation marker.
  const hasAssertion = assertionPhrases.some((p) => lower.includes(p));
  const hasCitation = lower.includes("[id:") || lower.includes("memory id") || lower.includes("source:");
  return hasAssertion && !hasCitation;
}

/**
 * Format a plan preview for display to the user.
 */
function formatPlanPreview(preview: string): string {
  return [
    "Here is the correction plan I generated:",
    "",
    "```diff",
    preview,
    "```",
    "",
    "Reply **apply** to confirm and apply this correction.",
    "Reply **cancel** to discard it.",
  ].join("\n");
}
