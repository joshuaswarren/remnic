import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTools } from "../src/tools.ts";
import { parseConfig } from "../src/config.js";
import { SharedContextManager } from "../src/shared-context/manager.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function isoForDate(date: string, time: string): Date {
  return new Date(`${date}T${time}Z`);
}

async function buildManager(prefix: string) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-shared-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: true,
    sharedContextDir: sharedDir,
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, memoryDir, sharedDir };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((entry) => entry.text).join("\n");
}

test("shared_context_cross_signals_run generates markdown and json artifacts on demand", async () => {
  const { manager, memoryDir, sharedDir } = await buildManager("engram-shared-tool");
  try {
    const date = "2026-03-06";
    await manager.writeAgentOutput({
      agentId: "generalist",
      title: "Latency mitigation plan",
      content: "checkout latency mitigation rollout and query plan cleanup",
      createdAt: isoForDate(date, "09:00:00"),
    });
    await manager.writeAgentOutput({
      agentId: "oracle",
      title: "Checkout latency review",
      content: "validated checkout latency mitigation and rollout sequencing",
      createdAt: isoForDate(date, "09:05:00"),
    });

    const tools = new Map<string, RegisteredTool>();
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
        sharedContextEnabled: true,
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
      sharedContext: manager,
      compounding: null,
      recordMemoryFeedback: async () => {},
      recordNotUsefulMemories: async () => {},
      requestQmdMaintenanceForTool: () => {},
    };

    registerTools(api as any, orchestrator as any);
    const tool = tools.get("shared_context_cross_signals_run");
    assert.ok(tool);

    const result = await tool.execute("tc-shared-cross", { date });
    const text = toolText(result);

    assert.match(text, /Cross-signals markdown:/);
    assert.match(text, /Cross-signals JSON:/);
    assert.match(text, /Overlap count:/);

    const markdownPath = text.match(/Cross-signals markdown: (.+)/)?.[1];
    const jsonPath = text.match(/Cross-signals JSON: (.+)/)?.[1];
    assert.ok(markdownPath);
    assert.ok(jsonPath);

    const markdown = await readFile(markdownPath!, "utf-8");
    const json = JSON.parse(await readFile(jsonPath!, "utf-8"));
    assert.match(markdown, /## Recurring Themes/);
    assert.equal(json.overlaps.some((entry: { agentCount: number }) => entry.agentCount >= 2), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("shared context defaults under configured workspace directory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-workspace-memory-"));
  try {
    const workspaceDir = path.join(memoryDir, "workspace");
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: true,
    });
    const manager = new SharedContextManager(config);

    assert.equal(manager.dir, path.join(workspaceDir, "shared-context"));
    await manager.ensureStructure();

    const priorities = await readFile(path.join(workspaceDir, "shared-context", "priorities.md"), "utf-8");
    assert.match(priorities, /# Priorities/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("shared context workspace fallback expands leading tilde", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const memoryDir = path.join(homeDir, "memory");
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: "~/bench-workspace",
      qmdEnabled: false,
      sharedContextEnabled: true,
    });
    const manager = new SharedContextManager(config);

    assert.equal(manager.dir, path.join(homeDir, "bench-workspace", "shared-context"));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("explicit shared context directory overrides workspace fallback", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-explicit-memory-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-explicit-dir-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      sharedContextEnabled: true,
      sharedContextDir: sharedDir,
    });
    const manager = new SharedContextManager(config);

    assert.equal(manager.dir, sharedDir);
    await manager.ensureStructure();

    const priorities = await readFile(path.join(sharedDir, "priorities.md"), "utf-8");
    assert.match(priorities, /# Priorities/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});
