/**
 * @remnic/bench — CLI Wiring for Benchmark Failure Attribution (Issue #1954)
 */

import { QmdClient } from "@remnic/core";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  attributeRun,
  isTaskFailed,
  renderAttributionReportTable,
  serializeAttributionReport,
  type AttributionEnvironment,
  type AttributionMemory,
} from "./attribution.js";
import {
  loadBenchmarkResult,
  resolveBenchmarkResultReference,
} from "./results-store.js";

export function parseFrontmatter(fileContent: string): { id?: string; body: string } {
  const lines = fileContent.split(/\r?\n/);
  if (lines.length > 0 && lines[0].trim() === "---") {
    let closingIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closingIndex = i;
        break;
      }
    }
    if (closingIndex >= 1) {
      const fmLines = lines.slice(1, closingIndex);
      let id: string | undefined = undefined;
      for (const line of fmLines) {
        const match = line.match(/^id:\s*(.+)$/);
        if (match) {
          id = match[1].trim().replace(/^["']|["']$/g, "");
          break;
        }
      }
      const body = lines.slice(closingIndex + 1).join("\n");
      return { id, body };
    }
  }
  return { body: fileContent };
}

const SKIPPED_SYSTEM_DIRS: Record<string, boolean> = {
  activity: true,
  meetings: true,
  questions: true,
  state: true,
  wearables: true,
};

async function assertReadableMemoryDir(dirPath: string): Promise<void> {
  let rootStats;
  try {
    rootStats = await lstat(dirPath);
  } catch {
    throw new Error(`memory-dir "${dirPath}" is not a readable directory`);
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error(`memory-dir "${dirPath}" must not be a symlink`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`memory-dir "${dirPath}" is not a readable directory`);
  }
}

export async function scanMemoryDir(dirPath: string): Promise<AttributionMemory[]> {
  await assertReadableMemoryDir(dirPath);

  const memories: AttributionMemory[] = [];
  let unreadableEntries = 0;

  async function walk(currentDir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      unreadableEntries++;
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      try {
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink()) {
          continue;
        }
        if (stats.isDirectory()) {
          if (depth === 0 && SKIPPED_SYSTEM_DIRS[entry.name]) {
            continue;
          }
          await walk(fullPath, depth + 1);
        } else if (stats.isFile() && entry.name.endsWith(".md")) {
          const content = await readFile(fullPath, "utf8");
          const { id, body } = parseFrontmatter(content);
          const relPath = path.relative(dirPath, fullPath);
          memories.push({
            id: id ?? relPath,
            content: body.trim(),
          });
        }
      } catch {
        unreadableEntries++;
      }
    }
  }

  await walk(dirPath, 0);
  if (unreadableEntries > 0) {
    throw new Error(`memory scan incomplete: ${unreadableEntries} unreadable entries under ${dirPath}`);
  }
  return memories;
}

async function resolveQmdMemory(
  memoryDir: string,
  collection: string,
  resultPath: string,
): Promise<AttributionMemory | null> {
  const root = path.resolve(memoryDir);
  const candidates = new Set<string>();
  const addCandidate = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      candidates.add(resolved);
    }
  };
  const addRelative = (relativePath: string): void => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) return;
    addCandidate(path.join(root, normalized));
    if (/^\d{4}-\d{2}-\d{2}\//.test(normalized)) {
      addCandidate(path.join(root, "facts", normalized));
    }
  };

  if (path.isAbsolute(resultPath)) {
    addCandidate(resultPath);
  } else {
    addRelative(resultPath);
    const normalized = resultPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.startsWith(`${collection}/`)) {
      addRelative(normalized.slice(collection.length + 1));
    }
  }

  let resolvedMemory: AttributionMemory | null = null;
  for (const candidate of candidates) {
    try {
      const stats = await lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const parsed = parseFrontmatter(await readFile(candidate, "utf8"));
      if (!parsed.id || parsed.id.trim().length === 0) {
        throw new Error("QMD result has no canonical frontmatter id");
      }
      const memory = { id: parsed.id, content: parsed.body.trim() };
      if (resolvedMemory && resolvedMemory.id !== memory.id) {
        throw new Error("QMD result path resolves to more than one canonical memory id");
      }
      resolvedMemory = memory;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("QMD result")) throw error;
    }
  }
  return resolvedMemory;
}

export async function runAttributeCliCommand(options: {
  runRef: string;
  resultsDir: string;
  memoryDir?: string;
  qmdPath?: string;
  collection?: string;
  threshold?: number;
  json?: boolean;
}): Promise<{ exitCode: number; output: string }> {
  const summary = await resolveBenchmarkResultReference(options.resultsDir, options.runRef);
  if (!summary) {
    return {
      exitCode: 1,
      output: `Error: Benchmark run reference "${options.runRef}" was not found in "${options.resultsDir}".\n`,
    };
  }

  let result;
  try {
    result = await loadBenchmarkResult(summary.path);
  } catch {
    return {
      exitCode: 1,
      output: `Error: failed to load benchmark result for run "${options.runRef}": file unreadable or invalid\n`,
    };
  }
  if (Boolean(options.qmdPath) !== Boolean(options.collection)) {
    return {
      exitCode: 1,
      output: "Error: --qmd <path> and --collection <name> must be provided together.\n",
    };
  }


  let memorySnapshot: AttributionMemory[] | undefined;
  const listMemoriesFn = async (): Promise<AttributionMemory[]> => {
    if (memorySnapshot) return memorySnapshot;
    if (!options.memoryDir) throw new Error("memoryDir not provided");
    memorySnapshot = await scanMemoryDir(options.memoryDir);
    return memorySnapshot;
  };

  if (options.memoryDir) {
    try {
      await assertReadableMemoryDir(options.memoryDir);
    } catch (error) {
      return {
        exitCode: 1,
        output: `Error: ${error instanceof Error ? error.message : `memory-dir "${options.memoryDir}" is not a readable directory`}\n`,
      };
    }
  }

  const recallLimitRaw = result.config?.remnicConfig?.recallLimit;
  const recallLimit = typeof recallLimitRaw === "number" && recallLimitRaw > 0 ? recallLimitRaw : 10;
  const needsLegacyFallback = result.results.tasks.some((task) =>
    task.attributionWitness === undefined &&
    isTaskFailed(task) &&
    Array.isArray(task.goldMemories) &&
    task.goldMemories.length > 0 &&
    !(task.details?.benchmarkFailure && typeof task.details.benchmarkFailure === "object")
  );
  if (needsLegacyFallback && options.qmdPath && !options.memoryDir) {
    return {
      exitCode: 1,
      output: "Error: explicit legacy QMD fallback requires --memory-dir <path>.\n",
    };
  }

  const env: AttributionEnvironment = {
    listMemories: listMemoriesFn,
    recallLimit,
  };
  let qmdClient: QmdClient | undefined;
  if (needsLegacyFallback && options.qmdPath && options.collection && options.memoryDir) {
    qmdClient = new QmdClient(options.collection, recallLimit, {
      qmdPath: options.qmdPath,
      qmdStrictPath: true,
    });
    const qmdAvailable = await qmdClient.probe().catch(() => false);
    const search = async (query: string, limit: number): Promise<AttributionMemory[]> => {
      if (!qmdAvailable) {
        throw new Error("QMD unavailable");
      }
      const degradations: unknown[] = [];
      const results = await qmdClient!.search(
        query,
        options.collection,
        limit,
        undefined,
        { onDegradation: (degradation) => degradations.push(degradation) },
      );
      if (degradations.length > 0) {
        throw new Error("QMD search degraded");
      }
      const memories: AttributionMemory[] = [];
      const seenIds = new Set<string>();
      for (const resultItem of results) {
        const memory = await resolveQmdMemory(options.memoryDir!, options.collection!, resultItem.path);
        if (!memory) {
          throw new Error("QMD result canonical identity unavailable");
        }
        if (!seenIds.has(memory.id)) {
          seenIds.add(memory.id);
          memories.push(memory);
        }
      }
      return memories;
    };
    env.oracleSearch = async (query, limit) => (await search(query, limit)).map(({ id }) => ({ id }));
    env.recall = search;
  }

  let report;
  try {
    report = await attributeRun(result, env, { threshold: options.threshold });
  } finally {
    await qmdClient?.dispose();
  }

  const output = options.json
    ? serializeAttributionReport(report)
    : renderAttributionReportTable(report);

  return {
    exitCode: 0,
    output,
  };
}
