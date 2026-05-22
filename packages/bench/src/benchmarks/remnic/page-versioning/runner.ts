/**
 * Stateful page versioning benchmark for Remnic's snapshot sidecars.
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createVersion,
  diffVersions,
  getVersion,
  listVersions,
  revertToVersion,
  type VersioningConfig,
} from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  PAGE_VERSIONING_FIXTURE,
  PAGE_VERSIONING_SMOKE_FIXTURE,
  type PageVersioningCase,
  type PageVersioningExpectation,
} from "./fixture.js";

export const pageVersioningDefinition: BenchmarkDefinition = {
  id: "page-versioning",
  title: "Page Versioning",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "page-versioning",
    version: "1.0.0",
    description:
      "File-backed benchmark covering sequential snapshots, revert behavior, pruning, and line diffs.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #445",
  },
};

export async function runPageVersioningBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const startedAt = performance.now();
    const actual = await executeCase(sample);
    const latencyMs = Math.round(performance.now() - startedAt);
    const expectedJson = JSON.stringify(sample.expected);
    const actualJson = JSON.stringify(actual);

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: expectedJson,
      actual: actualJson,
      scores: {
        exact_match: exactMatch(actualJson, expectedJson),
        history_match: exactMatch(
          JSON.stringify({
            versionIds: actual.versionIds,
            currentVersion: actual.currentVersion,
          }),
          JSON.stringify({
            versionIds: sample.expected.versionIds,
            currentVersion: sample.expected.currentVersion,
          }),
        ),
        page_content_match: exactMatch(actual.pageContent, sample.expected.pageContent),
        observed_match: exactMatch(actual.observed, sample.expected.observed),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        scenario: sample.scenario,
      },
    });
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): PageVersioningCase[] {
  const baseCases = mode === "quick"
    ? PAGE_VERSIONING_SMOKE_FIXTURE
    : PAGE_VERSIONING_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("page-versioning limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("page-versioning fixture is empty after applying the requested limit.");
  }
  return limited;
}

async function executeCase(
  sample: PageVersioningCase,
): Promise<PageVersioningExpectation> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-page-versioning-"));

  try {
    const factsDir = path.join(tmpDir, "facts");
    const pagePath = path.join(factsDir, `${sample.id}.md`);
    await mkdir(factsDir, { recursive: true });
    const config = versioningConfig();

    switch (sample.scenario) {
      case "revert-flow": {
        await writeFile(pagePath, "original content", "utf-8");
        await createVersion(pagePath, "original content", "write", config, undefined, undefined, tmpDir);
        await writeFile(pagePath, "modified content", "utf-8");
        await createVersion(pagePath, "modified content", "write", config, undefined, undefined, tmpDir);
        await revertToVersion(pagePath, "1", config, undefined, tmpDir);
        const history = await listVersions(pagePath, config, tmpDir);
        const pageContent = await readFile(pagePath, "utf-8");
        const observed = await getVersion(pagePath, "3", config, tmpDir);
        return {
          versionIds: history.versions.map((version) => version.versionId),
          currentVersion: history.currentVersion,
          pageContent,
          observed,
        };
      }
      case "prune-window": {
        const pruningConfig = versioningConfig({ maxVersionsPerPage: 2 });
        for (let index = 1; index <= 4; index += 1) {
          const content = `content v${index}`;
          await writeFile(pagePath, content, "utf-8");
          await createVersion(pagePath, content, "write", pruningConfig, undefined, undefined, tmpDir);
        }
        const history = await listVersions(pagePath, pruningConfig, tmpDir);
        const pageContent = await readFile(pagePath, "utf-8");
        const prunedIds: string[] = [];
        for (const versionId of ["1", "2"]) {
          try {
            await getVersion(pagePath, versionId, pruningConfig, tmpDir);
          } catch {
            prunedIds.push(versionId);
          }
        }
        return {
          versionIds: history.versions.map((version) => version.versionId),
          currentVersion: history.currentVersion,
          pageContent,
          observed: `pruned:${prunedIds.join(",")}`,
        };
      }
      case "diff-output": {
        await writeFile(pagePath, "line 1\nline 2\nline 3", "utf-8");
        await createVersion(
          pagePath,
          "line 1\nline 2\nline 3",
          "write",
          config,
          undefined,
          undefined,
          tmpDir,
        );
        await writeFile(pagePath, "line 1\nline 2 changed\nline 3\nline 4", "utf-8");
        await createVersion(
          pagePath,
          "line 1\nline 2 changed\nline 3\nline 4",
          "write",
          config,
          undefined,
          undefined,
          tmpDir,
        );
        const history = await listVersions(pagePath, config, tmpDir);
        const pageContent = await readFile(pagePath, "utf-8");
        const diff = await diffVersions(pagePath, "1", "2", config, tmpDir);
        const observedLines = normalizeDiffChangedLines(diff);
        return {
          versionIds: history.versions.map((version) => version.versionId),
          currentVersion: history.currentVersion,
          pageContent,
          observed: observedLines,
        };
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function normalizeDiffChangedLines(diff: string): string {
  return diff
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (line.startsWith("--- version ")) return false;
      if (line.startsWith("+++ version ")) return false;
      return line.startsWith("-") || line.startsWith("+");
    })
    .join("|");
}

function versioningConfig(
  overrides?: Partial<VersioningConfig>,
): VersioningConfig {
  return {
    enabled: true,
    maxVersionsPerPage: 50,
    sidecarDir: ".versions",
    ...overrides,
  };
}
