import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { WorkStorage } from "../src/work/storage.js";
import {
  exportWorkBoardMarkdown,
  exportWorkBoardSnapshot,
  importWorkBoardSnapshot,
} from "../src/work/board.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("work board export groups tasks by status and filters by project", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-export-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-board",
    name: "Board project",
  });

  await storage.createTask({
    id: "task-a",
    title: "Alpha",
    status: "todo",
    priority: "high",
    projectId: project.id,
  });
  await storage.createTask({
    id: "task-b",
    title: "Beta",
    status: "in_progress",
    priority: "medium",
    projectId: project.id,
  });
  await storage.createTask({
    id: "task-c",
    title: "Gamma",
    status: "blocked",
    priority: "low",
    projectId: null,
  });
  await storage.createTask({
    id: "task-d",
    title: "Done item",
    status: "done",
    priority: "medium",
    projectId: project.id,
  });
  await storage.createTask({
    id: "task-e",
    title: "Cancelled item",
    status: "cancelled",
    priority: "low",
    projectId: project.id,
  });

  const markdown = await exportWorkBoardMarkdown({
    memoryDir,
    projectId: project.id,
    now: new Date("2026-02-26T00:00:00.000Z"),
  });

  assert.match(markdown, /^# Work Board/m);
  assert.match(markdown, /Project: Board project \(project-board\)/);
  assert.match(markdown, /## Todo \(1\)/);
  assert.match(markdown, /## In Progress \(1\)/);
  assert.match(markdown, /## Blocked \(0\)/);
  assert.match(markdown, /## Done \(1\)/);
  assert.match(markdown, /## Cancelled \(1\)/);
  assert.match(markdown, /Alpha/);
  assert.match(markdown, /Beta/);
  assert.match(markdown, /- \[x\] Done item/);
  assert.match(markdown, /- \[ \] Cancelled item/);
  assert.doesNotMatch(markdown, /Gamma/);
});

test("work board import creates missing tasks and updates existing tasks", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-import-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-import",
    name: "Import project",
  });

  await storage.createTask({
    id: "task-existing",
    title: "Existing",
    status: "todo",
    priority: "low",
    projectId: project.id,
  });

  const snapshot = await exportWorkBoardSnapshot({
    memoryDir,
    projectId: project.id,
    now: new Date("2026-02-26T00:00:00.000Z"),
  });

  const existing = snapshot.items.find((item) => item.id === "task-existing");
  assert.ok(existing);
  existing.status = "in_progress";
  existing.priority = "high";
  existing.assignee = "agent";

  snapshot.items.push({
    id: "task-new",
    title: "New from import",
    description: "",
    status: "todo",
    priority: "medium",
    owner: null,
    assignee: null,
    projectId: project.id,
    tags: ["imported"],
    dueAt: null,
  });

  const result = await importWorkBoardSnapshot({
    memoryDir,
    snapshot,
    now: new Date("2026-02-27T00:00:00.000Z"),
  });

  assert.deepEqual(result, { created: 1, updated: 1 });

  const updated = await storage.getTask("task-existing");
  assert.ok(updated);
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.priority, "high");
  assert.equal(updated.assignee, "agent");

  const created = await storage.getTask("task-new");
  assert.ok(created);
  assert.equal(created.projectId, project.id);
  assert.deepEqual(created.tags, ["imported"]);
});

test("work storage serializes concurrent task updates for the same task", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-task-concurrent-update-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-race",
    title: "Race",
    status: "todo",
  });

  const originalGetTask = storage.getTask.bind(storage);
  let getTaskCalls = 0;
  storage.getTask = async (id: string) => {
    const call = ++getTaskCalls;
    const task = await originalGetTask(id);
    if (id === "task-race" && call === 1) {
      await delay(50);
    }
    return task;
  };

  await Promise.all([
    storage.updateTask("task-race", { status: "in_progress" }, new Date("2026-02-27T00:00:00.000Z")),
    storage.updateTask("task-race", { assignee: "alice" }, new Date("2026-02-27T00:00:01.000Z")),
  ]);

  const updated = await originalGetTask("task-race");
  assert.ok(updated);
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.assignee, "alice");
});

test("work board import bypasses transition guardrails for snapshot restores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-transition-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-transition",
    name: "Transition project",
  });

  await storage.createTask({
    id: "task-restore",
    title: "Restore me",
    status: "done",
    projectId: project.id,
  });

  const snapshot = await exportWorkBoardSnapshot({ memoryDir, projectId: project.id });
  const target = snapshot.items.find((item) => item.id === "task-restore");
  assert.ok(target);
  target.status = "todo";

  const result = await importWorkBoardSnapshot({ memoryDir, snapshot });
  assert.deepEqual(result, { created: 0, updated: 1 });

  const restored = await storage.getTask("task-restore");
  assert.ok(restored);
  assert.equal(restored.status, "todo");
});

test("work board import rejects invalid status/priority values", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-invalid-enum-"));

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [{
          id: "task-bad",
          title: "Bad enum",
          description: "",
          status: "inprogress" as unknown as "todo",
          priority: "urgent" as unknown as "medium",
          owner: null,
          assignee: null,
          projectId: null,
          tags: [],
          dueAt: null,
        }],
      },
    }),
  );
});

test("work board import rejects unsupported snapshot versions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-version-"));

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 2 as unknown as 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [],
      },
    }),
  );
});

test("work board import preserves existing project linkage when item projectId is omitted", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-project-link-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-keep-link",
    name: "Keep link",
  });
  await storage.createTask({
    id: "task-keep-link",
    title: "Keep link task",
    status: "todo",
    projectId: project.id,
  });

  const snapshot = await exportWorkBoardSnapshot({ memoryDir, projectId: project.id });
  const item = snapshot.items.find((entry) => entry.id === "task-keep-link");
  assert.ok(item);

  const { projectId: _dropProjectId, ...withoutProjectId } = item;
  snapshot.items = [withoutProjectId as unknown as typeof item];

  await importWorkBoardSnapshot({ memoryDir, snapshot });

  const updated = await storage.getTask("task-keep-link");
  assert.ok(updated);
  assert.equal(updated.projectId, project.id);
});

test("work board import falls back to snapshot projectId for new tasks", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-snapshot-project-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-snapshot-fallback",
    name: "Snapshot fallback",
  });

  await importWorkBoardSnapshot({
    memoryDir,
    snapshot: {
      version: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      projectId: project.id,
      projectName: project.name,
      items: [{
        id: "task-new-snapshot",
        title: "From snapshot",
        description: "",
        status: "todo",
        priority: "medium",
        owner: null,
        assignee: null,
        projectId: undefined as unknown as null,
        tags: [],
        dueAt: null,
      }],
    },
  });

  const created = await storage.getTask("task-new-snapshot");
  assert.ok(created);
  assert.equal(created.projectId, project.id);
});

test("work board import rejects invalid tags payload", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-invalid-tags-"));

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [{
          id: "task-bad-tags",
          title: "Bad tags",
          description: "",
          status: "todo",
          priority: "low",
          owner: null,
          assignee: null,
          projectId: null,
          tags: "infra" as unknown as string[],
          dueAt: null,
        }],
      },
    }),
  );
});

test("work board import preserves existing null project linkage when item projectId is omitted", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-null-project-"));
  const storage = new WorkStorage(memoryDir);

  const project = await storage.createProject({
    id: "project-null-fallback",
    name: "Null fallback",
  });
  await storage.createTask({
    id: "task-null-project",
    title: "No project",
    status: "todo",
    projectId: null,
  });

  await importWorkBoardSnapshot({
    memoryDir,
    snapshot: {
      version: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      projectId: project.id,
      projectName: project.name,
      items: [{
        id: "task-null-project",
        title: "No project",
        description: "",
        status: "todo",
        priority: "medium",
        owner: null,
        assignee: null,
        projectId: undefined as unknown as null,
        tags: [],
        dueAt: null,
      }],
    },
  });

  const updated = await storage.getTask("task-null-project");
  assert.ok(updated);
  assert.equal(updated.projectId, null);
});

test("work board import preserves existing tags when item omits tags", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-preserve-tags-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-tags-keep",
    title: "Keep tags",
    status: "todo",
    tags: ["alpha", "beta"],
  });

  await importWorkBoardSnapshot({
    memoryDir,
    snapshot: {
      version: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      projectId: null,
      projectName: null,
      items: [{
        id: "task-tags-keep",
        title: "Keep tags",
        description: "",
        status: "in_progress",
        priority: "medium",
        owner: null,
        assignee: null,
        projectId: null,
        dueAt: null,
      } as unknown as any],
    },
  });

  const updated = await storage.getTask("task-tags-keep");
  assert.ok(updated);
  assert.deepEqual(updated.tags, ["alpha", "beta"]);
});

test("work board import validates snapshot fully before mutating storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-atomic-validate-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-atomic",
    title: "Atomic",
    status: "todo",
    tags: ["keep"],
  });

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [
          {
            id: "task-atomic",
            title: "Atomic changed",
            description: "",
            status: "in_progress",
            priority: "medium",
            owner: null,
            assignee: null,
            projectId: null,
            tags: ["keep"],
            dueAt: null,
          },
          {
            id: "task-invalid",
            title: "Invalid",
            description: "",
            status: "todo",
            priority: "high",
            owner: null,
            assignee: null,
            projectId: null,
            tags: "not-array" as unknown as string[],
            dueAt: null,
          },
        ],
      },
    }),
  );

  const unchanged = await storage.getTask("task-atomic");
  assert.ok(unchanged);
  assert.equal(unchanged.title, "Atomic");
  assert.equal(unchanged.status, "todo");
});

test("work board import rejects duplicate snapshot task IDs before mutation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-duplicate-ids-"));
  const storage = new WorkStorage(memoryDir);

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [
          {
            id: "task-dup",
            title: "First",
            description: "",
            status: "todo",
            priority: "medium",
            owner: null,
            assignee: null,
            projectId: null,
            tags: [],
            dueAt: null,
          },
          {
            id: "task-dup",
            title: "Second",
            description: "",
            status: "in_progress",
            priority: "high",
            owner: null,
            assignee: null,
            projectId: null,
            tags: [],
            dueAt: null,
          },
        ],
      },
    }),
  );

  const created = await storage.getTask("task-dup");
  assert.equal(created, null);
});

test("work board import rejects invalid snapshot task IDs before mutation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-invalid-id-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-safe",
    title: "Safe",
    status: "todo",
  });

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [{
          id: "bad/id" as unknown as string,
          title: "Bad id",
          description: "",
          status: "todo",
          priority: "medium",
          owner: null,
          assignee: null,
          projectId: null,
          tags: [],
          dueAt: null,
        }],
      },
    }),
  );

  const existing = await storage.getTask("task-safe");
  assert.ok(existing);
  assert.equal(existing.title, "Safe");
});

test("work board import preserves nullable fields when omitted", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-nullable-omit-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-nullable",
    title: "Nullable",
    status: "todo",
    owner: "owner-1",
    assignee: "assignee-1",
    dueAt: "2026-03-01T00:00:00.000Z",
  });

  await importWorkBoardSnapshot({
    memoryDir,
    snapshot: {
      version: 1,
      generatedAt: "2026-02-26T00:00:00.000Z",
      projectId: null,
      projectName: null,
      items: [{
        id: "task-nullable",
        title: "Nullable updated",
        description: "",
        status: "in_progress",
        priority: "medium",
        projectId: null,
        tags: [],
      } as unknown as any],
    },
  });

  const updated = await storage.getTask("task-nullable");
  assert.ok(updated);
  assert.equal(updated.owner, "owner-1");
  assert.equal(updated.assignee, "assignee-1");
  assert.equal(updated.dueAt, "2026-03-01T00:00:00.000Z");
});

test("work board import rejects missing title/description before mutation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-work-board-title-desc-"));
  const storage = new WorkStorage(memoryDir);

  await storage.createTask({
    id: "task-existing-safe",
    title: "Safe",
    status: "todo",
  });

  await assert.rejects(() =>
    importWorkBoardSnapshot({
      memoryDir,
      snapshot: {
        version: 1,
        generatedAt: "2026-02-26T00:00:00.000Z",
        projectId: null,
        projectName: null,
        items: [{
          id: "task-new-bad",
          title: "Valid",
          description: undefined as unknown as string,
          status: "todo",
          priority: "medium",
          owner: null,
          assignee: null,
          projectId: null,
          tags: [],
          dueAt: null,
        }],
      },
    }),
  );

  const unchanged = await storage.getTask("task-existing-safe");
  assert.ok(unchanged);
  assert.equal(unchanged.title, "Safe");
});
