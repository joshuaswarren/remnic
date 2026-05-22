import assert from "node:assert/strict";
import test from "node:test";

import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function buildHarness() {
  const tools = new Map<string, RegisteredTool>();
  const observedLimits: number[] = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      contextCompressionActionsEnabled: false,
    },
    profiler: {
      isEnabled: true,
      getRecentTraces(limit: number) {
        observedLimits.push(limit);
        return [];
      },
      getStats() {
        return { byKind: {}, bySpan: {} };
      },
      identifyBottleneck() {
        return null;
      },
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
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

  registerTools(api as never, orchestrator as never);
  return { tools, observedLimits };
}

test("profiling report tools clamp limit to the documented 1-20 range", async () => {
  const { tools, observedLimits } = buildHarness();
  const remnicTool = tools.get("remnic_profiling_report");
  const legacyTool = tools.get("engram_profiling_report");
  assert.ok(remnicTool);
  assert.ok(legacyTool);

  await remnicTool.execute("profile-1", { format: "json", limit: 0 });
  await remnicTool.execute("profile-2", { format: "json", limit: -1 });
  await legacyTool.execute("profile-3", { format: "json", limit: 0 });
  await legacyTool.execute("profile-4", { format: "json", limit: 21 });

  assert.deepEqual(observedLimits, [1, 1, 1, 20]);
});
