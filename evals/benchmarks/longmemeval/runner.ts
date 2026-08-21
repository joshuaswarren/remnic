/**
 * LongMemEval runner — long-term memory evaluation for chat assistants.
 *
 * 500 questions across 6 categories testing 5 memory abilities:
 *   - Information Extraction (single-session-user, single-session-assistant, single-session-preference)
 *   - Multi-Session Reasoning
 *   - Temporal Reasoning
 *   - Knowledge Updates
 *
 * Each question has its own haystack of conversation sessions (oracle retrieval set).
 * We ingest ALL haystack sessions, then probe with the question.
 *
 * Published baselines (LongMemEvalS, ~115K tokens):
 *   GPT-4o full-context: ~60.6%  |  ChatGPT online: ~57.7%  |  Coze: ~32.9%
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * Paper:   LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025)
 * Code:    https://github.com/xiaowu0162/LongMemEval
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BenchmarkRunner,
  BenchmarkResult,
  BenchmarkMeta,
  MemorySystem,
  TaskScore,
} from "../../adapter/types.js";
import { f1Score, containsAnswer, llmJudgeScore, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

// ── Dataset types (matches longmemeval_oracle.json) ──

interface HaystackTurn {
  role: "user" | "assistant";
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalItem {
  question_id: number;
  question_type: string; // "single-session-user" | "single-session-assistant" | "single-session-preference" | "multi-session" | "temporal-reasoning" | "knowledge-update"
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: HaystackTurn[][]; // array of sessions, each session is an array of turns
  answer_session_ids: string[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<LongMemEvalItem[]> {
  // Try oracle dataset first (has answer-session-specific haystacks)
  for (const filename of ["longmemeval_oracle.json", "longmemeval_s_cleaned.json", "longmemeval.json"]) {
    try {
      const raw = await readFile(path.join(datasetDir, filename), "utf-8");
      const data: LongMemEvalItem[] = JSON.parse(raw);
      console.log(`  Loaded ${data.length} questions from ${filename}`);
      return limit !== undefined ? data.slice(0, limit) : data;
    } catch {
      continue;
    }
  }
  throw new Error(
    `LongMemEval dataset not found at ${datasetDir}. Download with:\n` +
    `  curl -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json -o ${datasetDir}/longmemeval_oracle.json`,
  );
}

/** Map question_type to the 5 memory ability categories from the paper. */
function abilityCategory(questionType: string): string {
  if (questionType.startsWith("single-session")) return "information_extraction";
  if (questionType === "multi-session") return "multi_session_reasoning";
  if (questionType === "temporal-reasoning") return "temporal_reasoning";
  if (questionType === "knowledge-update") return "knowledge_update";
  return questionType;
}

const meta: BenchmarkMeta = {
  name: "longmemeval",
  version: "2.0.0",
  description: "Long-term memory evaluation — 500 questions across 5 memory abilities (ICLR 2025)",
  category: "retrieval",
  citation: "Wu et al. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025.",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const items = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    await system.reset();

    if ((idx + 1) % 25 === 0 || idx === 0) {
      console.log(`  [longmemeval] Processing question ${idx + 1}/${items.length} (${item.question_type})`);
    }

    // Phase 1: Ingest all haystack sessions
    // Each item has its own set of haystack sessions with session IDs
    // Track all session IDs actually used (including fallbacks for extra sessions)
    const usedSessionIds: string[] = [];
    for (let si = 0; si < item.haystack_sessions.length; si++) {
      const session = item.haystack_sessions[si];
      const sessionId = item.haystack_session_ids[si] ?? `session-${si}`;
      usedSessionIds.push(sessionId);
      const messages = session.map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
      }));
      if (messages.length > 0) {
        await system.store(sessionId, messages);
      }
    }

    // Phase 2: Recall and score
    const { result: recallText, durationMs } = await timed(async () => {
      // Recall from all sessions that were stored (including fallback IDs)
      const parts: string[] = [];
      for (const sid of usedSessionIds) {
        const r = await system.recall(sid, item.question);
        if (r && r.trim().length > 0) parts.push(r);
      }
      return parts.join("\n\n");
    });

    // Also do a global search to measure FTS coverage
    const searchResults = await system.search(item.question, 10);
    const searchHits = searchResults.length;

    const f1 = f1Score(recallText, item.answer);
    const contains = containsAnswer(recallText, item.answer);
    const judgeScore = await llmJudgeScore(system.judge, item.question, recallText, item.answer);
    const ability = abilityCategory(item.question_type);

    const metrics: Record<string, number> = {
      f1,
      contains_answer: contains,
      search_hits: searchHits,
    };
    if (judgeScore >= 0) metrics.llm_judge = judgeScore;

    scores.push({
      taskId: `q${item.question_id}`,
      metrics,
      details: {
        question: item.question,
        expected: item.answer,
        question_type: item.question_type,
        ability_category: ability,
        num_sessions: item.haystack_sessions.length,
        answer_session_ids: item.answer_session_ids,
        recalled_length: recallText.length,
      },
      latencyMs: durationMs,
    });
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Overall aggregate
  const aggregate = aggregateScores(scores.map((s) => s.metrics));

  // Per-ability-category aggregates (matches paper breakdown)
  const abilities = ["information_extraction", "multi_session_reasoning", "temporal_reasoning", "knowledge_update"];
  for (const ability of abilities) {
    const catScores = scores.filter((s) => (s.details as any)?.ability_category === ability);
    if (catScores.length > 0) {
      const catContains = catScores.map((s) => s.metrics.contains_answer);
      const catF1 = catScores.map((s) => s.metrics.f1);
      aggregate[`${ability}_accuracy`] = catContains.reduce((a, b) => a + b, 0) / catContains.length;
      aggregate[`${ability}_f1`] = catF1.reduce((a, b) => a + b, 0) / catF1.length;
      aggregate[`${ability}_count`] = catScores.length;
    }
  }

  // Per-question-type aggregates (finer granularity)
  const questionTypes = [...new Set(scores.map((s) => (s.details as any)?.question_type))];
  for (const qt of questionTypes) {
    const qtScores = scores.filter((s) => (s.details as any)?.question_type === qt);
    if (qtScores.length > 0) {
      const qtContains = qtScores.map((s) => s.metrics.contains_answer);
      aggregate[`${qt}_accuracy`] = qtContains.reduce((a, b) => a + b, 0) / qtContains.length;
      aggregate[`${qt}_count`] = qtScores.length;
    }
  }

  return enrichResult({
    meta,
    engramVersion: "",
    gitSha: "",
    timestamp: "",
    adapterMode: "direct",
    taskCount: scores.length,
    scores,
    aggregate,
    config: {
      limit: options.limit,
      datasetDir: options.datasetDir,
    },
    durationMs,
  });
}

export const longMemEvalRunner: BenchmarkRunner = { meta, run };
