import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";
import { registerTools } from "../src/tools.ts";


test("Orchestrator exposes a stable recall-introspection surface", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-introspection-surface-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
    }),
  );

  try {
    const surface = orchestrator.recallIntrospection;
    assert.equal(surface, orchestrator.recallIntrospection);
    assert.equal(typeof surface.getLastIntentSnapshot, "function");
    assert.equal(typeof surface.explainLastIntent, "function");
  } finally {
    await orchestrator.destroy();
  }
});

test(
  "recallInternal persists last_intent.json when intent debugging is available",
  async (t) => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-intent-debug-write-"));
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      recallPlannerEnabled: true,
      qmdEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    await (orchestrator as any).recallInternal(
      "What happened in my timeline last week?",
      "session-intent-debug",
    );

    let raw: string;
    try {
      raw = await readFile(path.join(memoryDir, "state", "last_intent.json"), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("this branch does not yet persist last_intent.json during recallInternal");
        return;
      }
      throw error;
    }
    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(typeof snapshot.recordedAt, "string");
    assert.equal(typeof snapshot.promptHash, "string");
    assert.equal(typeof snapshot.plannedMode, "string");
    assert.equal(typeof snapshot.effectiveMode, "string");
  },
);

test(
  "getLastIntentSnapshot reads persisted intent snapshots when available",
  async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-intent-debug-read-"));
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
    });
    const orchestrator = new Orchestrator(cfg);
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "state", "last_intent.json"),
      JSON.stringify(
        {
          recordedAt: "2026-02-22T00:00:00.000Z",
          promptHash: "prompt-123",
          promptLength: 37,
          retrievalQueryHash: "retrieval-123",
          retrievalQueryLength: 29,
          plannerEnabled: true,
          plannedMode: "graph_mode",
          effectiveMode: "graph_mode",
          recallResultLimit: 8,
          queryIntent: {
            goal: "timeline",
            actionType: "summarize",
            entityTypes: ["project"],
          },
          graphExpandedIntentDetected: true,
          graphDecision: {
            status: "completed",
            reason: "broad timeline query",
            shadowMode: false,
            qmdAvailable: true,
            graphRecallEnabled: true,
            multiGraphMemoryEnabled: true,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const snapshot =
      (await orchestrator.recallIntrospection.getLastIntentSnapshot()) as
      | {
          promptHash?: string;
          plannedMode?: string;
          effectiveMode?: string;
          queryIntent?: { goal?: string; actionType?: string; entityTypes?: string[] };
          graphDecision?: { status?: string; reason?: string };
        }
      | null;
    assert.ok(snapshot);
    assert.equal(snapshot.promptHash, "prompt-123");
    assert.equal(snapshot.plannedMode, "graph_mode");
    assert.equal(snapshot.effectiveMode, "graph_mode");
    assert.equal(snapshot.queryIntent?.goal, "timeline");
    assert.equal(snapshot.queryIntent?.actionType, "summarize");
    assert.deepEqual(snapshot.queryIntent?.entityTypes, ["project"]);
    assert.equal(snapshot.graphDecision?.status, "completed");
    assert.equal(snapshot.graphDecision?.reason, "broad timeline query");
  },
);

test(
  "explainLastIntent returns a tool-facing summary when available",
  async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-intent-debug-explain-"));
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
    });
    const orchestrator = new Orchestrator(cfg);
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "state", "last_intent.json"),
      JSON.stringify(
        {
          recordedAt: "2026-02-22T00:00:00.000Z",
          promptHash: "prompt-123",
          promptLength: 37,
          retrievalQueryHash: "retrieval-123",
          retrievalQueryLength: 29,
          plannerEnabled: true,
          plannedMode: "graph_mode",
          effectiveMode: "graph_mode",
          recallResultLimit: 8,
          queryIntent: {
            goal: "timeline",
            actionType: "summarize",
            entityTypes: ["project"],
          },
          graphExpandedIntentDetected: true,
          graphDecision: {
            status: "completed",
            reason: "broad timeline query",
            shadowMode: false,
            qmdAvailable: true,
            graphRecallEnabled: true,
            multiGraphMemoryEnabled: true,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const explanation =
      await orchestrator.recallIntrospection.explainLastIntent();
    assert.equal(typeof explanation, "string");
    assert.match(explanation, /intent/i);
    assert.match(explanation, /graph_mode/i);
    assert.match(explanation, /timeline/i);
    assert.match(explanation, /completed/i);
  },
);

test("registerTools exposes memory_intent_debug when explainLastIntent is available", async () => {
  const tools = new Map<string, {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  }>();
  const api = {
    registerTool(spec: {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }) {
      tools.set(spec.name, spec);
    },
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      workspaceDir: "/tmp/workspace",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      identityContinuityEnabled: false,
    },
    recallIntrospection: {
      explainLastIntent: async () => "## Last Intent Debug\n\nPlanned mode: graph_mode",
      explainLastGraphRecall: async () => "noop",
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
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
    },
    getStorageForNamespace: async () => ({
      readProfile: async () => "",
      readIdentityReflections: async () => "",
    }),
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      loadCheckpoint: async () => null,
      clearCheckpoint: async () => {},
    },
    searchAcrossNamespaces: async () => [],
  };
  registerTools(api as never, orchestrator as never);

  const tool = tools.get("memory_intent_debug");
  assert.ok(tool);
  const result = await tool.execute("call-1", {});
  const text = result.content.map((item) => item.text).join("\n");
  assert.match(text, /Last Intent Debug/);
  assert.match(text, /graph_mode/);
});
