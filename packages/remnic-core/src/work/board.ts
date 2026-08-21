import type { WorkProject, WorkTask, WorkTaskPriority, WorkTaskStatus } from "./types.js";
import { WORK_ID_PATTERN, WorkStorage } from "./storage.js";

const BOARD_STATUS_ORDER: WorkTaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

const BOARD_STATUS_LABEL: Record<WorkTaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITY_WEIGHT: Record<WorkTaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface WorkBoardItem {
  id: string;
  title: string;
  description: string;
  status: WorkTaskStatus;
  priority: WorkTaskPriority;
  owner: string | null;
  assignee: string | null;
  projectId: string | null;
  tags: string[];
  dueAt: string | null;
}

export interface WorkBoardSnapshot {
  version: 1;
  generatedAt: string;
  projectId: string | null;
  projectName: string | null;
  items: WorkBoardItem[];
}

export interface ImportWorkBoardResult {
  created: number;
  updated: number;
}

function stableSortTasks(tasks: WorkTask[]): WorkTask[] {
  return [...tasks].sort((a, b) => {
    const priorityCmp = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (priorityCmp !== 0) return priorityCmp;
    const createdCmp = a.createdAt.localeCompare(b.createdAt);
    if (createdCmp !== 0) return createdCmp;
    return a.id.localeCompare(b.id);
  });
}

function projectMatches(task: WorkTask, projectId?: string): boolean {
  if (!projectId) return true;
  return task.projectId === projectId;
}

function assertValidImportEnums(item: WorkBoardItem): void {
  if (!["todo", "in_progress", "blocked", "done", "cancelled"].includes(item.status)) {
    throw new Error(`invalid task status in snapshot for ${item.id}: ${item.status}`);
  }
  if (!["low", "medium", "high"].includes(item.priority)) {
    throw new Error(`invalid task priority in snapshot for ${item.id}: ${item.priority}`);
  }
}

function normalizeImportedProjectId(
  rawValue: unknown,
  taskId: string,
  fallbackForUndefined: string | null,
): string | null {
  if (rawValue === undefined) return fallbackForUndefined;
  if (rawValue === null) return null;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  throw new Error(`invalid task projectId in snapshot for ${taskId}`);
}

function normalizeImportedTags(rawValue: unknown, taskId: string): string[] {
  if (rawValue === undefined || rawValue === null) return [];
  if (!Array.isArray(rawValue)) {
    throw new Error(`invalid task tags in snapshot for ${taskId}`);
  }
  if (!rawValue.every((entry) => typeof entry === "string")) {
    throw new Error(`invalid task tags in snapshot for ${taskId}`);
  }
  return [...rawValue];
}

function assertValidImportedTaskId(rawValue: unknown): string {
  if (typeof rawValue !== "string") {
    throw new Error("invalid task id in snapshot");
  }
  const trimmed = rawValue.trim();
  if (!WORK_ID_PATTERN.test(trimmed)) {
    throw new Error(`invalid task id in snapshot: ${trimmed}`);
  }
  return trimmed;
}

function normalizeImportedNullableField(
  rawValue: unknown,
  taskId: string,
  fieldName: "owner" | "assignee" | "dueAt",
  fallbackForUndefined: string | null,
): string | null {
  if (rawValue === undefined) return fallbackForUndefined;
  if (rawValue === null) return null;
  if (typeof rawValue === "string") return rawValue;
  throw new Error(`invalid task ${fieldName} in snapshot for ${taskId}`);
}

function normalizeImportedTitle(rawValue: unknown, taskId: string): string {
  if (typeof rawValue !== "string") {
    throw new Error(`invalid task title in snapshot for ${taskId}`);
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid task title in snapshot for ${taskId}`);
  }
  return trimmed;
}

function normalizeImportedDescription(rawValue: unknown, taskId: string): string {
  if (typeof rawValue !== "string") {
    throw new Error(`invalid task description in snapshot for ${taskId}`);
  }
  return rawValue;
}

function asBoardItem(task: WorkTask): WorkBoardItem {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    assignee: task.assignee,
    projectId: task.projectId,
    tags: [...task.tags],
    dueAt: task.dueAt,
  };
}

function formatTaskLine(task: WorkBoardItem): string {
  const bits: string[] = [`id:${task.id}`, `priority:${task.priority}`];
  if (task.assignee) bits.push(`assignee:${task.assignee}`);
  if (task.owner) bits.push(`owner:${task.owner}`);
  if (task.dueAt) bits.push(`due:${task.dueAt}`);
  if (task.tags.length > 0) bits.push(`tags:${task.tags.join(",")}`);
  const checked = task.status === "done";
  return `- [${checked ? "x" : " "}] ${task.title} \`[${bits.join(" ")}]\``;
}

export async function exportWorkBoardSnapshot(options: {
  memoryDir: string;
  projectId?: string;
  now?: Date;
}): Promise<WorkBoardSnapshot> {
  const storage = new WorkStorage(options.memoryDir);
  await storage.ensureDirectories();

  const projectId = options.projectId?.trim() || undefined;
  let project: WorkProject | null = null;
  if (projectId) {
    project = await storage.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
  }

  const allTasks = await storage.listTasks();
  const filtered = stableSortTasks(allTasks.filter((task) => projectMatches(task, projectId)));
  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    projectId: projectId ?? null,
    projectName: project?.name ?? null,
    items: filtered.map(asBoardItem),
  };
}

function renderWorkBoardMarkdown(snapshot: WorkBoardSnapshot): string {
  const lines: string[] = [];
  lines.push("# Work Board");
  lines.push("");
  lines.push(`Generated: ${snapshot.generatedAt}`);
  lines.push(`Project: ${snapshot.projectName ?? "all"} (${snapshot.projectId ?? "all"})`);
  lines.push("");

  for (const status of BOARD_STATUS_ORDER) {
    const bucket = snapshot.items.filter((item) => item.status === status);
    lines.push(`## ${BOARD_STATUS_LABEL[status]} (${bucket.length})`);
    if (bucket.length === 0) {
      lines.push("_none_");
    } else {
      for (const item of bucket) {
        lines.push(formatTaskLine(item));
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function exportWorkBoardMarkdown(options: {
  memoryDir: string;
  projectId?: string;
  now?: Date;
}): Promise<string> {
  const snapshot = await exportWorkBoardSnapshot(options);
  return renderWorkBoardMarkdown(snapshot);
}

export async function importWorkBoardSnapshot(options: {
  memoryDir: string;
  snapshot: WorkBoardSnapshot;
  projectId?: string | null;
  now?: Date;
}): Promise<ImportWorkBoardResult> {
  if (options.snapshot.version !== 1) {
    throw new Error(`unsupported work board snapshot version: ${options.snapshot.version}`);
  }

  const storage = new WorkStorage(options.memoryDir);
  await storage.ensureDirectories();

  const forcedProjectId = options.projectId === undefined
    ? undefined
    : (options.projectId?.trim() || null);
  const snapshotProjectId = normalizeImportedProjectId(
    (options.snapshot as unknown as { projectId?: unknown }).projectId,
    "snapshot",
    null,
  );

  type PreparedImportRow = {
    item: WorkBoardItem;
    existing: WorkTask | null;
    id: string;
    title: string;
    description: string;
    projectId: string | null;
    tags: string[];
    owner: string | null;
    assignee: string | null;
    dueAt: string | null;
  };

  const preparedRows: PreparedImportRow[] = [];
  const seenItemIds = new Set<string>();
  for (const item of options.snapshot.items) {
    const id = assertValidImportedTaskId((item as unknown as { id?: unknown }).id);
    if (seenItemIds.has(id)) {
      throw new Error(`duplicate task id in snapshot: ${id}`);
    }
    seenItemIds.add(id);
    assertValidImportEnums(item);
    const existing = await storage.getTask(id);
    const title = normalizeImportedTitle((item as unknown as { title?: unknown }).title, id);
    const description = normalizeImportedDescription((item as unknown as { description?: unknown }).description, id);
    const fallbackProjectId = existing ? existing.projectId : snapshotProjectId;
    const projectId = forcedProjectId === undefined
      ? normalizeImportedProjectId(
        (item as unknown as { projectId?: unknown }).projectId,
        item.id,
        fallbackProjectId,
      )
      : forcedProjectId;

    const hasTagsField = Object.prototype.hasOwnProperty.call(
      item as unknown as Record<string, unknown>,
      "tags",
    );
    const tags = hasTagsField
      ? normalizeImportedTags((item as unknown as { tags?: unknown }).tags, item.id)
      : (existing ? [...existing.tags] : []);

    const owner = normalizeImportedNullableField(
      (item as unknown as { owner?: unknown }).owner,
      id,
      "owner",
      existing?.owner ?? null,
    );
    const assignee = normalizeImportedNullableField(
      (item as unknown as { assignee?: unknown }).assignee,
      id,
      "assignee",
      existing?.assignee ?? null,
    );
    const dueAt = normalizeImportedNullableField(
      (item as unknown as { dueAt?: unknown }).dueAt,
      id,
      "dueAt",
      existing?.dueAt ?? null,
    );

    preparedRows.push({ item, existing, id, title, description, projectId, tags, owner, assignee, dueAt });
  }

  const projectIdsToValidate = new Set(
    preparedRows
      .map((row) => row.projectId)
      .filter((projectId): projectId is string => typeof projectId === "string"),
  );
  for (const projectId of projectIdsToValidate) {
    const project = await storage.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
  }

  let created = 0;
  let updated = 0;
  for (const row of preparedRows) {
    const { item, existing, id, title, description, projectId, tags, owner, assignee, dueAt } = row;

    if (existing) {
      await storage.updateTask(id, {
        title,
        description,
        status: item.status,
        priority: item.priority,
        owner,
        assignee,
        projectId,
        tags,
        dueAt,
      }, options.now, { skipStatusTransitionValidation: true });
      updated += 1;
      continue;
    }

    await storage.createTask({
      id,
      title,
      description,
      status: item.status,
      priority: item.priority,
      owner,
      assignee,
      projectId,
      tags,
      dueAt,
    }, options.now);
    created += 1;
  }

  return { created, updated };
}
