export type WorkTaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

export type WorkTaskPriority = "low" | "medium" | "high";

export type WorkProjectStatus = "active" | "on_hold" | "completed" | "archived";

export interface WorkTask {
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
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkTaskInput {
  id?: string;
  title: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string | null;
  assignee?: string | null;
  projectId?: string | null;
  tags?: string[];
  dueAt?: string | null;
}

export interface UpdateWorkTaskInput {
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string | null;
  assignee?: string | null;
  projectId?: string | null;
  tags?: string[];
  dueAt?: string | null;
}

export interface WorkProject {
  id: string;
  name: string;
  description: string;
  status: WorkProjectStatus;
  owner: string | null;
  tags: string[];
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkProjectInput {
  id?: string;
  name: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string | null;
  tags?: string[];
}

export interface UpdateWorkProjectInput {
  name?: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string | null;
  tags?: string[];
  taskIds?: string[];
}

export interface WorkTaskListFilter {
  status?: WorkTaskStatus;
  owner?: string;
  assignee?: string;
  projectId?: string;
}
