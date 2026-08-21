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
  return result.content.map((item) => item.text).join("\n");
}

function dreamsPhasesConfig(deepSleepEnabled: boolean, deepSleepEnabledExplicitlySet = false) {
  return {
    lightSleep: {
      enabled: true,
      cadenceMs: 0,
      promoteHeatThreshold: 0.55,
      staleDecayThreshold: 0.65,
      archiveDecayThreshold: 0.85,
      filterStaleEnabled: false,
    },
    rem: {
      enabled: false,
      cadenceMs: 168 * 3_600_000,
      similarityThreshold: 0.8,
      minClusterSize: 3,
      maxPerRun: 100,
      minIntervalMs: 10 * 60_000,
    },
    deepSleep: {
      enabled: deepSleepEnabled,
      enabledExplicitlySet: deepSleepEnabledExplicitlySet,
      cadenceMs: 24 * 3_600_000,
      versioningEnabled: false,
      versioningMaxPerPage: 50,
    },
  };
}

test("memory_governance_run tool is gated by dreams.phases.deepSleep.enabled", async () => {
  const tools = new Map<string, RegisteredTool>();
  let storageCalls = 0;
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      dreamsPhases: dreamsPhasesConfig(false, true),
      openclawToolsEnabled: true,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      contextCompressionActionsEnabled: false,
      identityContinuityEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {},
    getStorageForNamespace: async () => {
      storageCalls += 1;
      return { dir: "/tmp/remnic-memory-governance-tool-test" };
    },
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      listSessionKeys: async () => [],
    },
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
    appendMemoryActionEvent: async () => true,
  };

  registerTools(api as any, orchestrator as any);
  const tool = tools.get("memory_governance_run");
  assert.ok(tool);

  const result = await tool.execute("tool-call-1", { mode: "apply" });
  assert.match(toolText(result), /dreams\.phases\.deepSleep\.enabled=false/);
  assert.equal(storageCalls, 0);
});
