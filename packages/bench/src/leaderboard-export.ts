import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveContainedPath, sanitizeFilenameSegment } from "./filename-safety.js";
import type { BenchmarkResult, TaskResult } from "./types.js";

export interface LeaderboardArtifactWrite {
  benchmark: string;
  path: string;
  format: string;
  records: number;
}

interface AmaBenchLeaderboardRow {
  episode_id: number | string;
  answer_list: string[];
}

export async function writeLeaderboardArtifactsForResult(
  result: BenchmarkResult,
  outputDir: string
): Promise<LeaderboardArtifactWrite[]> {
  if (result.meta.benchmark === "ama-bench") {
    return writeAmaBenchLeaderboard(result, outputDir);
  }
  if (result.meta.benchmark === "memcorrect-v1") {
    return writeMemCorrectLeaderboard(result, outputDir);
  }
  return [];
}

async function writeAmaBenchLeaderboard(
  result: BenchmarkResult,
  outputDir: string
): Promise<LeaderboardArtifactWrite[]> {
  const rows = buildAmaBenchLeaderboardRows(result);
  if (rows.length === 0) {
    return [];
  }

  const outputRoot = path.resolve(outputDir);
  const leaderboardDir = resolveContainedPath(outputRoot, "leaderboard");
  await mkdir(leaderboardDir, { recursive: true });
  const timestamp = sanitizeFilenameSegment(result.meta.timestamp.replace(/[:.]/g, "-"));
  const filePath = resolveContainedPath(leaderboardDir, `ama-bench-${timestamp}-answers.jsonl`);
  await writeFile(filePath, serializeJsonl(rows), "utf8");
  return [
    {
      benchmark: "ama-bench",
      path: filePath,
      format: "ama-bench-answer-list-jsonl",
      records: rows.length,
    },
  ];
}

/**
 * MemCorrect leaderboard row — one per adapter result. This is the public
 * submission format: a third party runs the benchmark against their system
 * via the MemCorrectSystemAdapter and submits this row. Lower-is-better
 * metrics (uptake_latency, collateral_delta magnitude, false_apply) are
 * emitted raw; the methodology doc defines the interpretation.
 */
export interface MemCorrectLeaderboardRow {
  benchmark: "memcorrect-v1";
  adapter: string;
  seed: number;
  dataset_hash: string;
  remnic_version: string;
  git_sha: string;
  timestamp: string;
  mode: string;
  uptake_at_next: number;
  uptake_latency: number;
  uptake_latency_censored: number;
  non_resurrection: number;
  collateral_delta: number;
  scope_precision: number | null;
  false_apply: number;
  reassertion: number | null;
  provenance_fidelity: number | null;
}

async function writeMemCorrectLeaderboard(
  result: BenchmarkResult,
  outputDir: string
): Promise<LeaderboardArtifactWrite[]> {
  const row = buildMemCorrectLeaderboardRow(result);
  if (!row) return [];
  const outputRoot = path.resolve(outputDir);
  const leaderboardDir = resolveContainedPath(outputRoot, "leaderboard");
  await mkdir(leaderboardDir, { recursive: true });
  const timestamp = sanitizeFilenameSegment(result.meta.timestamp.replace(/[:.]/g, "-"));
  const safeAdapter = sanitizeFilenameSegment(row.adapter);
  const filePath = resolveContainedPath(
    leaderboardDir,
    `memcorrect-${safeAdapter}-${timestamp}.jsonl`,
  );
  await writeFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
  return [
    {
      benchmark: "memcorrect-v1",
      path: filePath,
      format: "memcorrect-adapter-metrics-jsonl",
      records: 1,
    },
  ];
}

export function buildAmaBenchLeaderboardRows(result: BenchmarkResult): AmaBenchLeaderboardRow[] {
  const rowsByEpisode = new Map<number | string, { firstTaskIndex: number; answers: string[] }>();

  result.results.tasks.forEach((task, taskIndex) => {
    const episodeId = amaBenchEpisodeIdForTask(task);
    if (episodeId === undefined) {
      throw new Error(
        `AMA-Bench leaderboard export requires details.episodeId for every task; missing on ${task.taskId}.`
      );
    }

    const existing = rowsByEpisode.get(episodeId);
    const answer = normalizeAmaBenchAnswer(task.actual);
    if (existing) {
      existing.answers.push(answer);
      return;
    }
    rowsByEpisode.set(episodeId, {
      firstTaskIndex: taskIndex,
      answers: [answer],
    });
  });

  return [...rowsByEpisode.entries()]
    .sort((left, right) => left[1].firstTaskIndex - right[1].firstTaskIndex)
    .map(([episodeId, row]) => ({
      episode_id: episodeId,
      answer_list: row.answers,
    }));
}

/**
 * Build the public-leaderboard row for a MemCorrect result. Reads the
 * aggregate metric bundle the runner attaches to
 * `config.benchmarkOptions.aggregateMetrics`; returns null when the result
 * did not come from the MemCorrect runner (defensive — the dispatch already
 * gates on benchmark id).
 */
export function buildMemCorrectLeaderboardRow(
  result: BenchmarkResult,
): MemCorrectLeaderboardRow | null {
  const aggregate = (
    result.config.benchmarkOptions as { aggregateMetrics?: Record<string, unknown> }
  )?.aggregateMetrics;
  if (!aggregate) return null;
  const adapter =
    typeof result.config.adapterMode === "string" ? result.config.adapterMode : "unknown";
  const provenance = aggregate.provenance_fidelity;
  return {
    benchmark: "memcorrect-v1",
    adapter,
    seed: result.meta.seeds[0] ?? 0,
    dataset_hash: result.meta.datasetHash ?? "",
    remnic_version: result.meta.remnicVersion,
    git_sha: result.meta.gitSha,
    timestamp: result.meta.timestamp,
    mode: result.meta.mode,
    uptake_at_next: numberOrZero(aggregate.uptake_at_next),
    uptake_latency: numberOrZero(aggregate.uptake_latency),
    uptake_latency_censored: numberOrZero(aggregate.uptake_latency_censored),
    non_resurrection: numberOrZero(aggregate.non_resurrection),
    collateral_delta: numberOrZero(aggregate.collateral_delta),
    scope_precision: typeof aggregate.scope_precision === "number" ? aggregate.scope_precision : null,
    false_apply: numberOrZero(aggregate.false_apply),
    reassertion: typeof aggregate.reassertion === "number" ? aggregate.reassertion : null,
    provenance_fidelity:
      typeof provenance === "number" ? provenance : null,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function serializeJsonl<T>(rows: readonly T[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function amaBenchEpisodeIdForTask(task: TaskResult): number | string | undefined {
  const raw = task.details?.episodeId ?? task.details?.episode_id;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }
  return undefined;
}

function normalizeAmaBenchAnswer(answer: string): string {
  const trimmed = answer.trim();
  if (/^\(error:/i.test(trimmed)) {
    return "unknown";
  }
  return trimmed.length > 0 ? trimmed : "unknown";
}
