/**
 * Stateful entity consolidation benchmark for Remnic's file-backed entity store.
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  ENTITY_CONSOLIDATION_FIXTURE,
  ENTITY_CONSOLIDATION_SMOKE_FIXTURE,
  type EntityConsolidationCase,
  type EntityConsolidationExpectation,
} from "./fixture.js";

const BUILT_IN_SECTIONS = new Set([
  "facts",
  "timeline",
  "summary",
  "synthesis",
  "connected to",
  "activity",
  "aliases",
]);

export const entityConsolidationDefinition: BenchmarkDefinition = {
  id: "entity-consolidation",
  title: "Entity Consolidation",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "entity-consolidation",
    version: "1.0.0",
    description:
      "File-backed benchmark covering entity timeline consolidation, structured section merges, and duplicate-write dedupe.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #445",
  },
};

export async function runEntityConsolidationBenchmark(
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
        canonical_match: exactMatch(actual.canonicalName, sample.expected.canonicalName),
        timeline_count_match: exactMatch(String(actual.timelineCount), sample.expected.timelineCount),
        structured_fact_count_match: exactMatch(
          String(actual.structuredFactCount),
          sample.expected.structuredFactCount,
        ),
        stale_flag_match: exactMatch(String(actual.stale), String(sample.expected.stale)),
        synthesis_match: exactMatch(actual.synthesis, sample.expected.synthesis),
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
): EntityConsolidationCase[] {
  const baseCases = mode === "quick"
    ? ENTITY_CONSOLIDATION_SMOKE_FIXTURE
    : ENTITY_CONSOLIDATION_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("entity-consolidation limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("entity-consolidation fixture is empty after applying the requested limit.");
  }
  return limited;
}

async function executeCase(
  sample: EntityConsolidationCase,
): Promise<EntityConsolidationExpectation> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-entity-consolidation-"));

  try {
    const storage = new StorageManager(tmpDir);
    await storage.ensureDirectories();

    const canonicalName = await applyScenario(storage, sample);
    const rawEntity = await storage.readEntity(canonicalName);

    return summarizeEntity(rawEntity, canonicalName);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function applyScenario(
  storage: StorageManager,
  sample: EntityConsolidationCase,
): Promise<string> {
  switch (sample.scenario) {
    case "timeline-staleness": {
      const firstTimestamp = "2026-04-13T10:00:00.000Z";
      const secondTimestamp = "2026-04-13T11:00:00.000Z";
      const canonicalName = await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        ["Leads the roadmap."],
        {
          timestamp: firstTimestamp,
          source: "extraction",
          sessionKey: "session-1",
        },
      );
      await storage.updateEntitySynthesis(canonicalName, sample.expected.synthesis, {
        updatedAt: firstTimestamp,
        entityUpdatedAt: firstTimestamp,
        synthesisTimelineCount: 1,
      });
      await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        ["Owns release approvals now."],
        {
          timestamp: secondTimestamp,
          source: "extraction",
          sessionKey: "session-2",
        },
      );
      return canonicalName;
    }
    case "structured-merge": {
      const timestamp = "2026-04-13T10:00:00.000Z";
      const canonicalName = await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        [],
        {
          timestamp,
          source: "extraction",
          structuredSections: [
            {
              key: "beliefs",
              title: "Beliefs",
              facts: ["Small teams move faster than committees."],
            },
          ],
        },
      );
      await storage.updateEntitySynthesis(canonicalName, sample.expected.synthesis, {
        updatedAt: timestamp,
        entityUpdatedAt: timestamp,
        synthesisTimelineCount: 0,
        synthesisStructuredFactCount: 1,
      });
      await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        [],
        {
          timestamp,
          source: "extraction",
          structuredSections: [
            {
              key: "Beliefs",
              title: "Beliefs",
              facts: ["Roadmaps should stay legible to the team."],
            },
          ],
        },
      );
      return canonicalName;
    }
    case "duplicate-dedupe": {
      const timestamp = "2026-04-14T09:00:00.000Z";
      const canonicalName = await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        ["Keeps weekly notes."],
        {
          timestamp,
          source: "extraction",
          sessionKey: "session-1",
        },
      );
      await storage.updateEntitySynthesis(canonicalName, sample.expected.synthesis, {
        updatedAt: timestamp,
        entityUpdatedAt: timestamp,
        synthesisTimelineCount: 1,
      });
      await storage.writeEntity(
        sample.entityName,
        sample.entityType,
        ["Keeps weekly notes."],
        {
          timestamp,
          source: "extraction",
          sessionKey: "session-1",
        },
      );
      return canonicalName;
    }
  }
}

function summarizeEntity(
  rawEntity: string,
  canonicalName: string,
): EntityConsolidationExpectation {
  const frontmatter = parseFrontmatter(rawEntity);
  const sections = parseSections(rawEntity);
  const synthesis = (sections.get("synthesis") ?? [])
    .join("\n")
    .trim();
  const timelineCount = countBullets(sections.get("timeline"));
  const structuredFactCount = [...sections.entries()]
    .filter(([title]) => !BUILT_IN_SECTIONS.has(title))
    .reduce((sum, [, lines]) => sum + countBullets(lines), 0);

  return {
    canonicalName,
    timelineCount,
    structuredFactCount,
    stale: deriveStaleState(frontmatter, timelineCount, structuredFactCount, synthesis),
    synthesis,
  };
}

function parseFrontmatter(rawEntity: string): Record<string, string> {
  const match = rawEntity.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};

  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    frontmatter[key] = value;
  }

  return frontmatter;
}

function parseSections(rawEntity: string): Map<string, string[]> {
  const body = rawEntity.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const sections = new Map<string, string[]>();
  let activeSection: string | null = null;

  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      activeSection = line.slice(3).trim().toLowerCase();
      sections.set(activeSection, []);
      continue;
    }
    if (activeSection) {
      sections.get(activeSection)?.push(line);
    }
  }

  return sections;
}

function countBullets(lines: string[] | undefined): number {
  return (lines ?? []).filter((line) => line.startsWith("- ")).length;
}

function deriveStaleState(
  frontmatter: Record<string, string>,
  timelineCount: number,
  structuredFactCount: number,
  synthesis: string,
): boolean {
  if (timelineCount === 0 && structuredFactCount === 0) return false;
  if (!synthesis) return true;

  const synthesisTimelineCount = parseNonNegativeInt(frontmatter.synthesis_timeline_count);
  const synthesisStructuredFactCount = parseNonNegativeInt(frontmatter.synthesis_structured_fact_count);

  if (synthesisTimelineCount === undefined) return true;
  if (structuredFactCount > 0 && synthesisStructuredFactCount === undefined) return true;

  return timelineCount > synthesisTimelineCount
    || structuredFactCount > (synthesisStructuredFactCount ?? 0);
}

function parseNonNegativeInt(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
