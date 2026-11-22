
import type { EngramAccessService } from "../access-service.js";
import type { ChatToolExecutor } from "./chat-engine.js";

export interface ChatExecutorBindings {
  service: EngramAccessService;
  principal?: string;
  namespace?: string;
  sessionKey?: string;
}

export function createChatExecutor(bindings: ChatExecutorBindings): ChatToolExecutor {
  const { service, principal, namespace, sessionKey } = bindings;
  const correctionScope: Parameters<EngramAccessService["correctionListPending"]>[0] = {};
  if (namespace) correctionScope.namespace = namespace;
  if (sessionKey) correctionScope.sessionKey = sessionKey;
  if (principal) correctionScope.principal = principal;

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

    // ── Correction tools — Correction Contract (#1580) ─────────────────
    // Thin adapters over the service's plan/apply pipeline. The engine's
    // confirmation interception asks for a pending plan's preview via the
    // "retrieve plan <id>" sentinel; that is a lookup, not a new plan.

    async correctionPlan(request: string): Promise<{ planId: string; preview: string }> {
      const retrieve = /^retrieve plan (\S+)$/i.exec(request.trim());
      if (retrieve) {
        const pending = await service.correctionListPending(correctionScope);
        const plan = pending.find((p) => p.planId === retrieve[1]);
        if (!plan) {
          throw new Error(`Correction plan ${retrieve[1]} not found or expired.`);
        }
        return { planId: plan.planId, preview: plan.diff };
      }
      const plan = await service.correctionPlan({
        text: request,
        ...correctionScope,
      });
      return { planId: plan.planId, preview: plan.diff };
    },

    async correctionApply(planId: string): Promise<string> {
      // The engine's confirmation protocol is the explicit consent; pass it
      // through as confirm so the apply gate sees a confirmed call.
      const outcome = await service.correctionApply(planId, {
        confirm: true,
        ...correctionScope,
      });
      return JSON.stringify(outcome);
    },

    async memoryPromote(memoryId: string): Promise<string> {
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
