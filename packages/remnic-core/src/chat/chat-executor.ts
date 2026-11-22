/**
 * Production chat-tool executor (issue #1583).
 *
 * Each method is a thin adapter over the corresponding EngramAccessService
 * method — zero new business logic (rule 22).  The executor carries the
 * session's principal/namespace/sessionKey so every tool call flows through
 * access-service with the caller's identity (rule 42).
 *
 * Correction tools (correction_plan / correction_apply) delegate to the
 * Correction Contract (#1580 / PR #1664) — EngramAccessService's
 * correctionPlan / correctionApply / correctionListPending.
 */

import type { EngramAccessService } from "../access-service.js";
import type { CorrectionPlan } from "../correction/index.js";
import type { ChatToolExecutor } from "./chat-engine.js";

export interface ChatExecutorBindings {
  service: EngramAccessService;
  principal?: string;
  namespace?: string;
  sessionKey?: string;
}

/** Render the plan's human-readable preview: diff plus decision context. */
function formatPlanPreview(plan: CorrectionPlan): string {
  const meta = [
    `classification: ${plan.classification}`,
    `confidence: ${plan.confidence.toFixed(2)}`,
    plan.affected.length > 0 ? `affected: ${plan.affected.length}` : undefined,
    plan.warnings.length > 0 ? `warnings: ${plan.warnings.join("; ")}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return `${plan.diff}\n\n${meta.join("\n")}`;
}

/**
 * Create a production executor bound to the caller's identity.
 */
export function createChatExecutor(bindings: ChatExecutorBindings): ChatToolExecutor {
  const { service, principal, namespace, sessionKey } = bindings;

  return {
    async memorySearch(query: string, maxResults?: number): Promise<string> {
      const result = await service.memorySearch({
        query,
        ...(namespace ? { namespace } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(principal ? { principal } : {}),
      });
      return JSON.stringify(result);
    },

    async memoryGet(memoryId: string): Promise<string> {
      const result = await service.memoryGet(memoryId, namespace, principal, sessionKey);
      return JSON.stringify(result);
    },

    async memoryTimeline(memoryId: string, limit?: number): Promise<string> {
      const result = await service.memoryTimeline(memoryId, namespace, limit ?? 200, principal);
      return JSON.stringify(result);
    },

    async recallExplain(query: string): Promise<string> {
      const result = await service.recallExplain({
        ...(sessionKey ? { sessionKey } : {}),
        ...(namespace ? { namespace } : {}),
        ...(principal ? { authenticatedPrincipal: principal } : {}),
        ...(query ? { query } : {}),
      });
      return JSON.stringify(result);
    },

    async entityGet(name: string): Promise<string> {
      const result = await service.entityGet(name, namespace, principal);
      return JSON.stringify(result);
    },

    async stats(): Promise<string> {
      const [profile, entities, questions] = await Promise.all([
        service.memoryProfile(namespace, principal),
        service.memoryEntitiesList(namespace, principal),
        service.memoryQuestions(namespace, principal),
      ]);
      return JSON.stringify({ profile, entities, questions });
    },

    async reviewList(runId?: string): Promise<string> {
      const result = await service.reviewQueue(runId, namespace, principal);
      return JSON.stringify(result);
    },

    async scopeInspect(): Promise<string> {
      return JSON.stringify({
        namespace: namespace ?? "default",
        principal: principal ?? "default",
        sessionKey: sessionKey ?? undefined,
      });
    },

    // ── Correction tools — the Correction Contract (#1580 / PR #1664) ────
    // Thin adapters over EngramAccessService.correctionPlan / correctionApply
    // (the CorrectionService).  The engine, CLI, and MCP tool all consume this
    // interface, so the contract is honored in one place.

    async correctionPlan(request: string): Promise<{ planId: string; preview: string }> {
      const scope = {
        ...(namespace ? { namespace } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(principal ? { principal } : {}),
      };
      // The engine asks for a previously-planned correction via the
      // "retrieve plan <id>" convention (confirmation fast-path).  Serve it
      // from listPending so the preview shown is the real plan, not a
      // freshly-minted one.
      const retrieveMatch = /^retrieve plan (\S+)\s*$/i.exec(request.trim());
      if (retrieveMatch) {
        const planId = retrieveMatch[1];
        const pending = await service.correctionListPending(scope);
        const found = pending.find((p) => p.planId === planId);
        if (!found) throw new Error("Plan not found or expired.");
        return { planId: found.planId, preview: formatPlanPreview(found) };
      }
      const plan = await service.correctionPlan({ text: request, ...scope });
      return { planId: plan.planId, preview: formatPlanPreview(plan) };
    },

    async correctionApply(planId: string): Promise<string> {
      // The engine runs correctionApply only after the user confirms the plan
      // (session.confirmedPlanIds), so the service-level confirm gate is met.
      const outcome = await service.correctionApply(planId, {
        confirm: true,
        ...(namespace ? { namespace } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(principal ? { principal } : {}),
      });
      return JSON.stringify(outcome);
    },

    async memoryPromote(memoryId: string): Promise<string> {
      // Delegate to the existing memoryPromote service method if available.
      try {
        const serviceWithPromote = service as EngramAccessService & {
          memoryPromote?: (memoryId: string, namespace?: string, principal?: string) => Promise<unknown>;
        };
        if (typeof serviceWithPromote.memoryPromote === "function") {
          const result = await serviceWithPromote.memoryPromote(memoryId, namespace, principal);
          return JSON.stringify(result);
        }
      } catch {
        // Fall through to stub.
      }
      return JSON.stringify({
        promoted: false,
        memoryId,
        reason: "Memory promotion is not available in this build.",
      });
    },
  };
}
