
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


    async correctionPlan(request: string): Promise<{ planId: string; preview: string }> {
      return {
        planId: `stub-${Date.now()}`,
        preview: `[Correction Contract (#1580) not yet available]\n\nRequested correction: "${request}"\n\nThe plan/apply pipeline is pending. Inspection tools are fully functional.`,
      };
    },

    async correctionApply(planId: string): Promise<string> {
      return JSON.stringify({
        applied: false,
        planId,
        reason: "Correction Contract (#1580) not yet available. No mutation was applied.",
      });
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
