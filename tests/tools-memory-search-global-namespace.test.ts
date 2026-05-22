import test from "node:test";
import assert from "node:assert/strict";

import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

test("memory_search global collection applies namespace before maxResults limiting", async () => {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };
  let qmdGlobalCalled = false;
  let namespaceSearchParams: Record<string, unknown> | undefined;
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      openclawToolsEnabled: false,
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    qmd: {
      searchGlobal: async () => {
        qmdGlobalCalled = true;
        return [
          { path: "/memory/namespaces/a/high.md", score: 0.99, snippet: "wrong namespace" },
        ];
      },
    },
    searchAcrossNamespaces: async (params: Record<string, unknown>) => {
      namespaceSearchParams = params;
      return [
        { path: "/memory/namespaces/b/lower.md", score: 0.61, snippet: "right namespace" },
      ];
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
    },
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      listSessionKeys: async () => [],
    },
    sharedContext: null,
    compounding: null,
    appendMemoryActionEvent: async () => true,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
  };

  registerTools(api as any, orchestrator as any);
  const search = tools.get("memory_search");
  assert.ok(search);

  const result = await search.execute("search-1", {
    query: "incident",
    collection: "global",
    namespace: "b",
    maxResults: 1,
  });

  assert.equal(qmdGlobalCalled, false);
  assert.deepEqual(namespaceSearchParams, {
    query: "incident",
    namespaces: ["b"],
    maxResults: 1,
    mode: "search",
  });
  assert.match(toolText(result), /right namespace/);
});
