/**
 * Aged-dataset retention bench (issue #686 PR 2/6).
 *
 * Goal: measure structural properties of the hot/cold tier policy on a
 * synthetic 1- or 2-year dataset, contrasting `lifecyclePolicyEnabled:
 * false` (full corpus visible to recall) with `lifecyclePolicyEnabled:
 * true` (cold memories partitioned away from default recall).
 *
 * Metrics emitted per task (one task per query):
 *   - recall_at_5_full         — recall@5 against the full corpus.
 *   - recall_at_5_hot_only     — recall@5 against the hot-only corpus
 *                                (cold partition removed via the same
 *                                tier policy used in production).
 *   - recall_at_5_delta        — full minus hot-only (target: ≤ 0.01 in
 *                                aggregate; PR 3 will tune defaults).
 *   - hot_share                — fraction of corpus that ended up hot.
 *   - cold_share               — fraction that ended up cold.
 *
 * Latency is measured as the deterministic-ranker time per query as a
 * proxy for the "scan-and-score" component of recall — the relative
 * delta between full-corpus and hot-only-corpus rank time is what
 * matters for index-cost analysis, since the QMD index runtime is
 * proportional to the corpus the index covers.
 *
 * The bench is hermetic: no orchestrator, no QMD, no filesystem. It
 * relies on `decideTierTransition` from `@remnic/core` so the tier
 * computation is identical to production behavior.
 */

import { randomUUID } from "node:crypto";
import {
  decideTierTransition,
  type MemoryFile,
  type MemoryTier,
  type TierRoutingPolicy,
} from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { aggregateTaskScores } from "../../../scorer.js";
import {
  generateAgedDataset,
  type AgedDatasetGeneratorOptions,
} from "./fixture.js";

export const retentionAgedDatasetDefinition: BenchmarkDefinition = {
  id: "retention-aged-dataset",
  title: "Retention Aged Dataset",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retention-aged-dataset",
    version: "1.0.0",
    description:
      "Synthetic aged-corpus benchmark for the hot/cold tier policy at 1- and 2-year scale.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #686 PR 2/6",
  },
};

/** Default policy values match the production defaults from `config.ts`. */
const DEFAULT_POLICY: TierRoutingPolicy = {
  enabled: true,
  demotionMinAgeDays: 14,
  demotionValueThreshold: 0.35,
  promotionValueThreshold: 0.7,
};

const QUICK_OPTIONS: AgedDatasetGeneratorOptions = {
  size: 200,
  horizonDays: 365,
  topicCount: 8,
  paretoAlpha: 1.16,
  ageSkew: 1.5,
  seed: 0xa686,
  nowIso: "2026-04-25T12:00:00.000Z",
};

const FULL_OPTIONS: AgedDatasetGeneratorOptions = {
  size: 2000,
  horizonDays: 730,
  topicCount: 16,
  paretoAlpha: 1.16,
  ageSkew: 1.5,
  seed: 0xa686,
  nowIso: "2026-04-25T12:00:00.000Z",
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/**
 * Deterministic ranker — keyword-overlap on `content` + `tags` using
 * **whole-word token matching**. Substring matching (the previous
 * approach) caused cross-topic collisions in the fixture vocabulary
 * (`eta` substring of `beta`, `zeta`, `theta`), perturbing top-K recall
 * measurements. (Codex review on PR #698.)
 */
function rankMemories(query: string, memories: MemoryFile[]): MemoryFile[] {
  const queryTokens = tokenize(query);
  return [...memories]
    .map((m) => {
      const haystackTokens = tokenize(
        (m.content + " " + (m.frontmatter.tags ?? []).join(" ")),
      );
      let score = 0;
      for (const tok of queryTokens) {
        if (haystackTokens.has(tok)) score += 1;
      }
      // Tiebreak: more recent first, mirroring the fixture's
      // `relevantMemoryIds` recency selection.  The fixture sorts by
      // `lastAccessed ?? updated ?? created` (fixture.ts), so we MUST
      // use the same fallback chain here — using only `updated ?? created`
      // (the prior version) misalignned with the labeled relevant set
      // when memories had a `lastAccessed` distinct from `updated`,
      // artificially deflating recall@K.  (Codex P1 review on PR #698.)
      const recencyMs = Date.parse(
        m.frontmatter.lastAccessed
          ?? m.frontmatter.updated
          ?? m.frontmatter.created,
      );
      return { memory: m, score, recencyMs };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.recencyMs !== a.recencyMs) return b.recencyMs - a.recencyMs;
      return a.memory.frontmatter.id.localeCompare(b.memory.frontmatter.id);
    })
    .map((s) => s.memory);
}

function recallAtK(
  ranked: MemoryFile[],
  relevantIds: Set<string>,
  k: number,
): number {
  if (relevantIds.size === 0) return 1;
  const topK = ranked.slice(0, k);
  let hits = 0;
  for (const m of topK) {
    if (relevantIds.has(m.frontmatter.id)) hits += 1;
  }
  // Recall@K = (relevant items in top K) / (total relevant items).
  // Using min(k, relevantIds.size) as the denominator turns this into
  // precision@K. (Cursor Bugbot review on PR #698.)
  return hits / relevantIds.size;
}

function partitionByTier(
  memories: MemoryFile[],
  policy: TierRoutingPolicy,
  nowIso: string,
): { hot: MemoryFile[]; cold: MemoryFile[] } {
  const now = new Date(nowIso);
  const hot: MemoryFile[] = [];
  const cold: MemoryFile[] = [];
  for (const memory of memories) {
    // Start every memory in `hot` and apply the demotion decision once.
    // This mirrors production: memories are written to hot and demoted
    // when the tier-migration cycle sweeps past them.
    const decision = decideTierTransition(memory, "hot" as MemoryTier, policy, now);
    if (decision.nextTier === "cold") {
      cold.push(memory);
    } else {
      hot.push(memory);
    }
  }
  return { hot, cold };
}

export async function runRetentionAgedDatasetBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const baseOptions =
    options.mode === "quick" ? QUICK_OPTIONS : FULL_OPTIONS;
  // Thread `options.seed` into the generator so result metadata's reported
  // seed actually drives the corpus. (Cursor Bugbot review on PR #698.)
  const seed =
    typeof options.seed === "number" ? options.seed : baseOptions.seed;
  const fixtureOptions: AgedDatasetGeneratorOptions = {
    ...baseOptions,
    seed,
  };
  const fixture = generateAgedDataset(fixtureOptions);

  const policyEnabled: TierRoutingPolicy = { ...DEFAULT_POLICY, enabled: true };
  const { hot: hotMemories, cold: coldMemories } = partitionByTier(
    fixture.memories,
    policyEnabled,
    fixture.options.nowIso,
  );
  const hotShare = hotMemories.length / Math.max(1, fixture.memories.length);
  const coldShare = coldMemories.length / Math.max(1, fixture.memories.length);

  // Honor `options.limit` so quick / limited bench runs don't fan out across
  // every fixture topic. Other remnic runners apply this same shape.
  // (Codex review on PR #698.)
  const queries =
    typeof options.limit === "number" && options.limit > 0
      ? fixture.queries.slice(0, options.limit)
      : fixture.queries;

  const tasks: TaskResult[] = [];
  for (const query of queries) {
    const relevantIds = new Set(query.relevantMemoryIds);

    const startedFull = performance.now();
    const fullRanked = rankMemories(query.text, fixture.memories);
    const latencyFullMs = Math.round(performance.now() - startedFull);

    const startedHot = performance.now();
    const hotRanked = rankMemories(query.text, hotMemories);
    const latencyHotMs = Math.round(performance.now() - startedHot);

    const recallFull = recallAtK(fullRanked, relevantIds, 5);
    const recallHot = recallAtK(hotRanked, relevantIds, 5);
    const recallDelta = recallFull - recallHot;

    const task: TaskResult = {
      taskId: query.id,
      question: query.text,
      expected: JSON.stringify({
        relevantCount: relevantIds.size,
      }),
      actual: JSON.stringify({
        topFull: fullRanked.slice(0, 5).map((m) => m.frontmatter.id),
        topHot: hotRanked.slice(0, 5).map((m) => m.frontmatter.id),
      }),
      scores: {
        recall_at_5_full: recallFull,
        recall_at_5_hot_only: recallHot,
        recall_at_5_delta: recallDelta,
        hot_share: hotShare,
        cold_share: coldShare,
      },
      // Use the full-corpus latency as the headline — the comparison to
      // hotMs is captured in details.
      latencyMs: latencyFullMs,
      tokens: { input: 0, output: 0 },
      details: {
        topicId: query.topicId,
        relevantCount: relevantIds.size,
        latencyFullMs,
        latencyHotMs,
        latencyDeltaMs: latencyFullMs - latencyHotMs,
        hotMemoryCount: hotMemories.length,
        coldMemoryCount: coldMemories.length,
        totalMemoryCount: fixture.memories.length,
      },
    };
    tasks.push(task);
    options.onTaskComplete?.(task, tasks.length, queries.length);
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, t) => sum + t.latencyMs, 0);
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
      // `seed` is the actual seed used to generate `fixture` (resolved
      // from options.seed if provided, otherwise from baseOptions).
      seeds: [seed],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "synthetic",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs:
        tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      // Use plain `aggregateTaskScores` rather than `buildTieredAggregates`:
      // this bench has no clean/dirty pairing semantics. The latter requires
      // each task to set `details.tier === "clean" | "dirty"` and produces
      // empty aggregates otherwise. (Cursor Bugbot review on PR #698.)
      aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}
