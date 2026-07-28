/**
 * @remnic/bench — CLI Wiring for Benchmark Failure Attribution (Issue #1954)
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  attributeRun,
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
  state: true,
  wearables: true,
  activity: true,
  meetings: true,
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

export async function runAttributeCliCommand(options: {
  runRef: string;
  resultsDir: string;
  memoryDir?: string;
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

  let listMemoriesFn: () => Promise<AttributionMemory[]>;

  if (options.memoryDir) {
    try {
      await assertReadableMemoryDir(options.memoryDir);
    } catch (error) {
      return {
        exitCode: 1,
        output: `Error: ${error instanceof Error ? error.message : `memory-dir "${options.memoryDir}" is not a readable directory`}\n`,
      };
    }
    listMemoriesFn = () => scanMemoryDir(options.memoryDir!);
  } else {
    listMemoriesFn = async () => {
      throw new Error("memoryDir not provided");
    };
  }

  const recallLimitRaw = result.config?.remnicConfig?.recallLimit;
  const recallLimit = typeof recallLimitRaw === "number" && recallLimitRaw > 0 ? recallLimitRaw : 10;

  const env: AttributionEnvironment = {
    listMemories: listMemoriesFn,
    recallLimit,
  };

  const report = await attributeRun(result, env, { threshold: options.threshold });

  const output = options.json
    ? serializeAttributionReport(report)
    : renderAttributionReportTable(report);

  return {
    exitCode: 0,
    output,
  };
}
