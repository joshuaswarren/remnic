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

function parseFrontmatter(fileContent: string): { id?: string; body: string } {
  const lines = fileContent.split(/\r?\n/);
  if (lines.length > 0 && lines[0].trim() === "---") {
    let closingIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closingIndex = i;
        break;
      }
    }
    if (closingIndex > 1) {
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

async function scanMemoryDir(dirPath: string): Promise<AttributionMemory[]> {
  const memories: AttributionMemory[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
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
          if (entry.name === "state" || entry.name === "wearables") {
            continue;
          }
          await walk(fullPath);
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
        // Skip inaccessible entries
      }
    }
  }

  await walk(dirPath);
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      output: `Error loading benchmark result file "${summary.path}": ${msg}\n`,
    };
  }

  let listMemoriesFn: () => Promise<AttributionMemory[]>;

  if (options.memoryDir) {
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
