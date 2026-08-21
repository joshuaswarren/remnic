import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function parseWorkJson(result: { content: Array<{ type: string; text: string }> }): any {
  const text = result.content.map((c) => c.text).join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `Expected JSON payload in work-layer response, got: ${text}`);
  return JSON.parse(text.slice(start, end + 1));
}

function workText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function buildHarness(memoryDir: string) {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      memoryDir,
      defaultNamespace: "default",
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      identityContinuityEnabled: false,
      contextCompressionActionsEnabled: false,
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
  return tools;
}

test("work tools normalize whitespace around IDs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-tool-id-norm-"));
  try {
    const tools = buildHarness(memoryDir);
    const taskTool = tools.get("work_task");
    const projectTool = tools.get("work_project");
    assert.ok(taskTool);
    assert.ok(projectTool);

    const createdTask = parseWorkJson(await taskTool.execute("t1", { action: "create", title: "Task A" })).task;
    const createdProject = parseWorkJson(await projectTool.execute("p1", { action: "create", name: "Project A" })).project;

    const fetchedTask = parseWorkJson(
      await taskTool.execute("t2", { action: "get", id: `  ${createdTask.id}  ` }),
    ).task;
    assert.equal(fetchedTask.id, createdTask.id);

    const updatedTask = parseWorkJson(
      await taskTool.execute("t3", { action: "update", id: `  ${createdTask.id}\n`, title: "Task A+" }),
    ).task;
    assert.equal(updatedTask.title, "Task A+");

    const transitionedTask = parseWorkJson(
      await taskTool.execute("t4", { action: "transition", id: `\t${createdTask.id}\t`, status: "in_progress" }),
    ).task;
    assert.equal(transitionedTask.status, "in_progress");

    const linkedTask = parseWorkJson(
      await projectTool.execute("p2", {
        action: "link_task",
        taskId: ` ${createdTask.id} `,
        projectId: ` ${createdProject.id} `,
      }),
    ).linked;
    assert.equal(linkedTask.task.projectId, createdProject.id);

    const fetchedProject = parseWorkJson(
      await projectTool.execute("p3", { action: "get", id: ` ${createdProject.id} ` }),
    ).project;
    assert.equal(fetchedProject.id, createdProject.id);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("work_board failures honor linkToMemory=true", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-link-failure-"));
  try {
    const tools = buildHarness(memoryDir);
    const boardTool = tools.get("work_board");
    assert.ok(boardTool);

    const result = await boardTool.execute("b1", { action: "import_snapshot", linkToMemory: true });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /\[WORK_LAYER_CONTEXT link_to_memory=true\]/);
    assert.match(text, /requires `snapshotJson`/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("work tools reject invalid enum values before mutating storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-tool-invalid-enum-"));
  try {
    const tools = buildHarness(memoryDir);
    const taskTool = tools.get("work_task");
    const projectTool = tools.get("work_project");
    assert.ok(taskTool);
    assert.ok(projectTool);

    const invalidTaskCreate = workText(
      await taskTool.execute("t1", { action: "create", title: "Task A", status: "finished" }),
    );
    assert.match(invalidTaskCreate, /work_task\.create received invalid `status`/);
    assert.equal(parseWorkJson(await taskTool.execute("t2", { action: "list" })).count, 0);

    const task = parseWorkJson(await taskTool.execute("t3", { action: "create", title: "Task A" })).task;
    const invalidTaskUpdate = workText(
      await taskTool.execute("t4", { action: "update", id: task.id, priority: "urgent" }),
    );
    assert.match(invalidTaskUpdate, /work_task\.update received invalid `priority`/);
    assert.equal(parseWorkJson(await taskTool.execute("t5", { action: "get", id: task.id })).task.priority, "medium");

    const project = parseWorkJson(await projectTool.execute("p1", { action: "create", name: "Project A" })).project;
    const invalidProjectUpdate = workText(
      await projectTool.execute("p2", { action: "update", id: project.id, status: "paused" }),
    );
    assert.match(invalidProjectUpdate, /work_project\.update received invalid `status`/);
    assert.equal(parseWorkJson(await projectTool.execute("p3", { action: "get", id: project.id })).project.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
