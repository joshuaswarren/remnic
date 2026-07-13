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

function buildHarness(resultOverride?: {
  enabled?: boolean;
  dryRun?: boolean;
  eventCount?: number;
  previousGuidelineVersion?: number | null;
  nextGuidelineVersion?: number;
  draftContentHash?: string | null;
  changedRules?: number;
  semanticRefinementApplied?: boolean;
  persisted?: boolean;
  activated?: boolean;
  reason?:
    | "disabled"
    | "missing_draft"
    | "expected_revision_required"
    | "content_hash_mismatch"
    | "guideline_version_mismatch"
    | "draft_changed";
}) {
  const tools = new Map<string, RegisteredTool>();
  const capturedCalls: Array<Record<string, unknown>> = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    compressionGuidelineCoordinator: {
      optimizeCompressionGuidelines: async (params?: Record<string, unknown>) => {
        capturedCalls.push(params ?? {});
        return {
          enabled: resultOverride?.enabled ?? true,
          dryRun: resultOverride?.dryRun ?? false,
          eventCount: resultOverride?.eventCount ?? 22,
          previousGuidelineVersion: resultOverride?.previousGuidelineVersion ?? 3,
          nextGuidelineVersion: resultOverride?.nextGuidelineVersion ?? 4,
          draftContentHash:
            resultOverride?.draftContentHash ?? (resultOverride?.dryRun === true ? null : "hash-123"),
          changedRules: resultOverride?.changedRules ?? 2,
          semanticRefinementApplied: resultOverride?.semanticRefinementApplied ?? false,
          persisted: resultOverride?.persisted ?? true,
        };
      },
      activateCompressionGuidelineDraft: async () => ({
        enabled: resultOverride?.enabled ?? true,
        activated: resultOverride?.activated ?? true,
        guidelineVersion: resultOverride?.nextGuidelineVersion ?? 4,
        reason: resultOverride?.reason,
      }),
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

  registerTools(api as any, orchestrator as any);
  return { tools, capturedCalls };
}

test("compression_guidelines_optimize reports disabled learning gate", async () => {
  const { tools } = buildHarness({ enabled: false });
  const tool = tools.get("compression_guidelines_optimize");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-1", { dryRun: true });
  assert.match(toolText(result), /disabled/i);
});

test("compression_guidelines_optimize passes dryRun/eventLimit and returns summary", async () => {
  const { tools, capturedCalls } = buildHarness({
    enabled: true,
    dryRun: true,
    eventCount: 10,
    previousGuidelineVersion: 5,
    nextGuidelineVersion: 6,
    changedRules: 1,
    semanticRefinementApplied: true,
    persisted: false,
  });
  const tool = tools.get("compression_guidelines_optimize");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-2", { dryRun: true, eventLimit: 120 });
  assert.equal(capturedCalls.length, 1);
  assert.deepEqual(capturedCalls[0], { dryRun: true, eventLimit: 120 });

  const text = toolText(result);
  assert.match(text, /optimization complete/i);
  assert.match(text, /dryRun=true/);
  assert.match(text, /persisted=false/);
  assert.match(text, /guidelineVersion: 5 -> 6/);
  assert.match(text, /draftContentHash=none/);
  assert.match(text, /changedRules=1/);
  assert.match(text, /semanticRefinementApplied=true/);
});

test("compression_guidelines_activate reports draft activation result", async () => {
  const { tools } = buildHarness({
    enabled: true,
    activated: true,
    nextGuidelineVersion: 7,
  });
  const tool = tools.get("compression_guidelines_activate");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-3", {});
  const text = toolText(result);
  assert.match(text, /draft activated/i);
  assert.match(text, /guidelineVersion=7/);
});

test("compression_guidelines_activate requires a reviewed draft identity", async () => {
  const { tools } = buildHarness({
    enabled: true,
    activated: false,
    reason: "expected_revision_required",
  });
  const tool = tools.get("compression_guidelines_activate");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-4", {});
  assert.match(toolText(result), /requires `expectedContentHash` or `expectedGuidelineVersion`/i);
});
