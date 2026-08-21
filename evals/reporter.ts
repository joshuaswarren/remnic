/**
 * Results reporter — writes versioned JSON and prints console summary.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkResult } from "./adapter/types.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Keep persisted benchmark artifacts portable and free of developer-local
 * directory names. Paths inside the repository are recorded repo-relative;
 * external overrides are intentionally represented without their host path.
 */
export function portableDatasetDir(datasetDir: string, repoRoot = REPO_ROOT): string {
  if (!path.isAbsolute(datasetDir)) {
    return datasetDir;
  }

  const relative = path.relative(repoRoot, datasetDir);
  const isInsideRepo =
    relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

  return isInsideRepo ? relative.split(path.sep).join("/") : "<external>";
}

export function resultForPersistence(result: BenchmarkResult): BenchmarkResult {
  const datasetDir = result.config.datasetDir;
  if (typeof datasetDir !== "string") {
    return result;
  }

  return {
    ...result,
    config: {
      ...result.config,
      datasetDir: portableDatasetDir(datasetDir),
    },
  };
}

function getEngramVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function enrichResult(result: BenchmarkResult): BenchmarkResult {
  return {
    ...result,
    engramVersion: result.engramVersion || getEngramVersion(),
    gitSha: result.gitSha || getGitSha(),
    timestamp: result.timestamp || new Date().toISOString(),
  };
}

export async function writeResult(result: BenchmarkResult, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${result.meta.name}-v${result.engramVersion}-${ts}.json`;
  const filePath = path.join(outputDir, filename);

  await writeFile(filePath, `${JSON.stringify(resultForPersistence(result), null, 2)}\n`);
  return filePath;
}

export function printSummary(result: BenchmarkResult): void {
  const { meta, aggregate, taskCount, durationMs, adapterMode } = result;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Benchmark: ${meta.name} (${meta.category})`);
  console.log(`Adapter:   ${adapterMode}`);
  console.log(`Tasks:     ${taskCount}`);
  console.log(`Duration:  ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Engram:    v${result.engramVersion} (${result.gitSha})`);
  console.log("-".repeat(60));

  const metricKeys = Object.keys(aggregate).sort();
  if (metricKeys.length === 0) {
    console.log("  (no aggregate metrics)");
  } else {
    for (const key of metricKeys) {
      const val = aggregate[key];
      console.log(`  ${key.padEnd(30)} ${val.toFixed(4)}`);
    }
  }

  console.log(`${"=".repeat(60)}\n`);
}
