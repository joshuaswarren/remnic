/**
 * Agent-readable benchmark status file.
 *
 * Writes a run-scoped bench status file to the results directory that AI
 * agents (or humans) can poll to track benchmark progress without relying
 * on Node.js stdout (which is invisible when piped/nohup'd).
 *
 * All writes are serialized through a per-file queue so that concurrent
 * task-progress updates never race with benchmark completion/failure writes.
 * Each write uses atomic temp-file + rename so readers never see
 * partially-written JSON.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BenchmarkStatusEntry {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt?: string;
  completedAt?: string;
  resultPath?: string;
  error?: string;
}

export interface BenchStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  currentBenchmark?: string;
  currentTaskProgress?: { completed: number; total?: number };
  benchmarks: BenchmarkStatusEntry[];
  completedResults: string[];
}

export function createBenchStatusPath(
  resultsDir: string,
  pid: number,
  startedAtMs = Date.now(),
): string {
  return path.join(resultsDir, `bench-status-${startedAtMs}-${pid}.json`);
}

const BENCH_STATUS_FILENAME = /^bench-status-\d+-\d+\.json$/;
const VALID_BENCH_ENTRY_STATUSES = new Set(["pending", "running", "complete", "failed"]);

/**
 * Find the most recent bench-status file in the results directory.
 * Returns `null` when no valid status file exists.
 */
export async function findLatestBenchStatusFile(
  resultsDir: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((name) => BENCH_STATUS_FILENAME.test(name))
    .sort()
    .reverse();

  for (const name of candidates) {
    const filePath = path.join(resultsDir, name);
    const status = await readBenchStatus(filePath);
    if (status) {
      return filePath;
    }
  }

  return null;
}

async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, filePath);
}

export async function readBenchStatus(filePath: string): Promise<BenchStatus | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.benchmarks)) return null;
    if (typeof obj.pid !== "number") return null;
    if (typeof obj.startedAt !== "string") return null;
    // Validate each benchmark entry has required fields.
    for (const entry of obj.benchmarks as unknown[]) {
      if (typeof entry !== "object" || entry === null) return null;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string") return null;
      if (
        typeof e.status !== "string" ||
        !VALID_BENCH_ENTRY_STATUSES.has(e.status)
      ) {
        return null;
      }
    }
    return parsed as BenchStatus;
  } catch {
    return null;
  }
}

// Per-file serialized write queue to prevent concurrent writes from racing.
const writeQueues = new Map<string, Promise<void>>();

function serializedWrite(
  filePath: string,
  fn: (status: BenchStatus) => BenchStatus | null,
): Promise<void> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    const current = await readBenchStatus(filePath);
    if (!current) return;
    const updated = fn(current);
    if (updated) {
      await atomicWriteJSON(filePath, updated);
    }
  }).catch(() => {
    // Swallow I/O errors so status file failures never crash the benchmark loop.
  });
  writeQueues.set(filePath, next);
  // Prune completed entries to avoid unbounded map growth.
  void next.finally(() => {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  });
  return next;
}

export async function initBenchStatus(
  filePath: string,
  benchmarks: string[],
  pid: number,
): Promise<void> {
  const now = new Date().toISOString();
  const status: BenchStatus = {
    pid,
    startedAt: now,
    updatedAt: now,
    benchmarks: benchmarks.map((id) => ({ id, status: "pending" as const })),
    completedResults: [],
  };
  await atomicWriteJSON(filePath, status);
}

export function updateBenchmarkStarted(
  filePath: string,
  benchmarkId: string,
): Promise<void> {
  return serializedWrite(filePath, (status) => {
    status.updatedAt = new Date().toISOString();
    status.currentBenchmark = benchmarkId;
    status.currentTaskProgress = { completed: 0 };
    const entry = status.benchmarks.find((b) => b.id === benchmarkId);
    if (entry) {
      entry.status = "running";
      entry.startedAt = new Date().toISOString();
    }
    return status;
  });
}

export function updateBenchmarkCompleted(
  filePath: string,
  benchmarkId: string,
  resultPath: string,
): Promise<void> {
  return serializedWrite(filePath, (status) => {
    status.updatedAt = new Date().toISOString();
    const entry = status.benchmarks.find((b) => b.id === benchmarkId);
    if (entry) {
      entry.status = "complete";
      entry.completedAt = new Date().toISOString();
      entry.resultPath = resultPath;
    }
    status.completedResults.push(resultPath);
    delete status.currentTaskProgress;
    delete status.currentBenchmark;
    return status;
  });
}

export function updateBenchmarkFailed(
  filePath: string,
  benchmarkId: string,
  error: string,
): Promise<void> {
  return serializedWrite(filePath, (status) => {
    status.updatedAt = new Date().toISOString();
    const entry = status.benchmarks.find((b) => b.id === benchmarkId);
    if (entry) {
      entry.status = "failed";
      entry.completedAt = new Date().toISOString();
      entry.error = error;
    }
    delete status.currentTaskProgress;
    delete status.currentBenchmark;
    return status;
  });
}

export function updateTaskProgress(
  filePath: string,
  completed: number,
  total?: number,
): Promise<void> {
  return serializedWrite(filePath, (status) => {
    status.updatedAt = new Date().toISOString();
    status.currentTaskProgress = { completed, ...(total != null ? { total } : {}) };
    return status;
  });
}

export function finalizeBenchStatus(
  filePath: string,
): Promise<void> {
  return serializedWrite(filePath, (status) => {
    status.updatedAt = new Date().toISOString();
    delete status.currentBenchmark;
    delete status.currentTaskProgress;
    return status;
  });
}
