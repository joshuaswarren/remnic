
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

export interface ChatToolExecutor {
  memorySearch(query: string, maxResults?: number): Promise<string>;
  memoryGet(memoryId: string): Promise<string>;
  memoryTimeline(memoryId: string, limit?: number): Promise<string>;
  recallExplain(query: string): Promise<string>;
  entityGet(name: string): Promise<string>;
  stats(): Promise<string>;
  reviewList(runId?: string): Promise<string>;
  scopeInspect(): Promise<string>;
  correctionPlan(request: string): Promise<{ planId: string; preview: string }>;
  correctionApply(planId: string): Promise<string>;
  memoryPromote(memoryId: string): Promise<string>;
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

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
    if (
      isConfirmationMessage(userMessage) &&
      this.correctionAvailable
    ) {
      if (session.pendingPlanId) {
        const planId = session.pendingPlanId;
        session.confirmedPlanIds.add(planId);
        session.pendingPlanId = undefined;
        try {
          const applyResult = await this.executor.correctionApply(planId);
          session.confirmedPlanIds.delete(planId);
          return {
            reply: `Correction applied.\n\n${applyResult}`,
            chatSessionId: session.id,
            ...(session.pendingPromotionId ? {} : {}),
          };
        } catch (err) {
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

    const recentEntries = session.transcript
      .slice(-21)
      .filter((e) => e.role !== "system" || e.seq !== 0)
      .filter((e) => !(e.role === "system" && /^[a-z_]+:/.test(e.content)))
      .filter((e, _i, arr) => {
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

      if (!response) {
        return {
          reply: "[error] No LLM model is available. Configure a local or cloud model to use Remnic Chat.",
          chatSessionId: session.id,
          error: "no_llm_available",
        };
      }

      if (response.toolCalls.length === 0) {
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

      conversation.push({ role: "assistant", content: response.content });

      for (const tc of response.toolCalls) {
        if (toolCallCount >= this.maxToolCallsPerTurn) {
          skippedTools.push(tc.name);
          continue;
        }
        toolCallCount++;

        if (!this.allowedToolNames.has(tc.name)) {
          conversation.push({
            role: "tool",
            content: JSON.stringify({ error: `Tool '${tc.name}' is not available in this configuration.` }),
            toolCallId: tc.id,
          });
          continue;
        }

        if (MUTATING_TOOLS.has(tc.name as ChatToolName)) {
          if (tc.name === "correction_apply") {
            const planId = typeof tc.arguments.planId === "string" ? tc.arguments.planId : "";
            if (!session.confirmedPlanIds.has(planId)) {
              try {
                const plan = await this.executor.correctionPlan(
                  `retrieve plan ${planId}`,
                );
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
            session.confirmedPlanIds.delete(planId);
          }
        }

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

        let result: ChatToolResult;
        try {
          result = await this.executeTool(tc.name, tc.arguments, session);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { content: JSON.stringify({ error: msg }) };
        }

        conversation.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });

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

      if (skippedTools.length > 0) {
        conversation.push({
          role: "user",
          content: `[system] Tool budget exhausted (${this.maxToolCallsPerTurn} calls). ${skippedTools.length} tool(s) were skipped: ${skippedTools.join(", ")}. Please summarize what you found.`,
        });
        let summaryResponse;
        try {
          summaryResponse = await this.llm.complete(conversation, {
            tools: [], // No more tools — force a text reply.
            ...(this.model ? { model: this.model } : {}),
          });
        } catch {
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
// ---------------------------------------------------------------------------

function looksLikeMemoryAssertion(text: string): boolean {
  const lower = text.toLowerCase();
  const assertionPhrases = [
    "you remember",
    "i remember",
    "according to my memory",
    "your memory",
    "stored memory",
    "remnic remembers",
    "remnic knows",
  ];
  const hasAssertion = assertionPhrases.some((p) => lower.includes(p));
  const hasCitation = lower.includes("[id:") || lower.includes("memory id") || lower.includes("source:");
  return hasAssertion && !hasCitation;
}

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
