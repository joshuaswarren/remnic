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
  outputDir: string,
): Promise<LeaderboardArtifactWrite[]> {
  if (result.meta.benchmark !== "ama-bench") {
    return [];
  }

  const rows = buildAmaBenchLeaderboardRows(result);
  if (rows.length === 0) {
    return [];
  }

  const outputRoot = path.resolve(outputDir);
  const leaderboardDir = resolveContainedPath(outputRoot, "leaderboard");
  await mkdir(leaderboardDir, { recursive: true });
  const timestamp = sanitizeFilenameSegment(result.meta.timestamp.replace(/[:.]/g, "-"));
  const filePath = resolveContainedPath(
    leaderboardDir,
    `ama-bench-${timestamp}-answers.jsonl`,
  );
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

export function buildAmaBenchLeaderboardRows(
  result: BenchmarkResult,
): AmaBenchLeaderboardRow[] {
  const rowsByEpisode = new Map<
    number | string,
    { firstTaskIndex: number; answers: string[] }
  >();

  result.results.tasks.forEach((task, taskIndex) => {
    const episodeId = amaBenchEpisodeIdForTask(task);
    if (episodeId === undefined) {
      throw new Error(
        `AMA-Bench leaderboard export requires details.episodeId for every task; missing on ${task.taskId}.`,
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

export function serializeJsonl(rows: readonly AmaBenchLeaderboardRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
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
