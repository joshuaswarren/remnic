/**
 * LongMemEval runner migrated into @remnic/bench for phase 1.
 *
 * As of issue #566 PR 2/7, the per-item lifecycle (reset → ingest →
 * recall → answer → judge → score) lives in `../harness.ts`. This
 * module only knows about dataset loading + how to translate a
 * `LongMemEvalItem` into a `HarnessPlan`.
 */

import { collectTemporalLexicalCues } from "@remnic/core";

import type { Message, SearchResult } from "../../../adapters/types.js";
import { type LongMemEvalItem } from "./fixture.js";
import {
  LONG_MEM_EVAL_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLongMemEvalS,
} from "../dataset-loader.js";
import {
  runPublishedHarness,
  type HarnessPlan,
  type HarnessTrial,
} from "../harness.js";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";

export const longMemEvalDefinition: BenchmarkDefinition = {
  id: "longmemeval",
  title: "LongMemEval",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "longmemeval",
    version: "2.0.0",
    description:
      "Long-term memory evaluation across information extraction, multi-session reasoning, temporal reasoning, and knowledge updates.",
    category: "retrieval",
    citation:
      "Wu et al. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025.",
  },
};

export async function runLongMemEvalBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(
    options.mode,
    options.datasetDir,
    options.limit,
  );

  const plans: HarnessPlan[] = dataset.map((item) => buildPlan(item, options));

  return runPublishedHarness({
    options,
    metricsSpec: {
      metrics: ["f1", "contains_answer", "llm_judge"],
    },
    plans,
    totalCount: plans.reduce((sum, plan) => sum + plan.trials.length, 0),
  });
}

function buildPlan(
  item: LongMemEvalItem,
  options: ResolvedRunBenchmarkOptions,
): HarnessPlan {
  const ingestSessions: HarnessPlan["ingestSessions"] = [];
  const sessionIds: string[] = [];
  const annotateTemporalSources = shouldAnnotateTemporalSources(item.question);
  for (
    let sessionIndex = 0;
    sessionIndex < item.haystack_sessions.length;
    sessionIndex += 1
  ) {
    const sessionId =
      item.haystack_session_ids[sessionIndex] ?? `session-${sessionIndex}`;
    const haystackDate = item.haystack_dates[sessionIndex];
    const messages = item.haystack_sessions[sessionIndex]!.map<Message>(
      (turn) => ({
        role: turn.role,
        content: annotateTemporalSources
          ? formatLongMemEvalTurn(turn.content, {
              sessionId,
              haystackDate,
            })
          : turn.content,
      }),
    );
    sessionIds.push(sessionId);
    ingestSessions.push({ sessionId, messages });
  }

  const trial: HarnessTrial = {
    taskId: `q${item.question_id}`,
    question: item.question,
    expected: item.answer,
    recallSessionIds: sessionIds,
    extraDetails: {
      questionType: item.question_type,
      questionDate: item.question_date,
      haystackDates: item.haystack_dates,
      haystackSessionIds: item.haystack_session_ids,
      answerSessionIds: item.answer_session_ids,
    },
    postAnswerHook: async ({ question, recalledText }) => {
      const searchResults = await searchLongMemEvalEvidence(
        options,
        question,
        sessionIds,
      );
      const recallEvidenceHits =
        searchResults.length > 0 || recalledText.trim().length === 0 ? 0 : 1;
      return {
        extraScores: {
          search_hits: Math.max(searchResults.length, recallEvidenceHits),
        },
        extraDetails: {
          directSearchHits: searchResults.length,
          recallEvidenceHits,
          temporalRecallAudit: buildTemporalRecallAudit({
            item,
            question,
            recalledText,
          }),
        },
      };
    },
  };

  return { ingestSessions, trials: [trial] };
}

async function searchLongMemEvalEvidence(
  options: ResolvedRunBenchmarkOptions,
  question: string,
  sessionIds: string[],
): Promise<SearchResult[]> {
  const globalResults = await options.system.search(question, 10);
  if (globalResults.length > 0) {
    return globalResults;
  }

  const scopedResults = await Promise.all(
    sessionIds.map((sessionId) =>
      options.system.search(question, 10, sessionId).catch(() => []),
    ),
  );
  return uniqueSearchResults(scopedResults.flat());
}

function uniqueSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    const key = `${result.sessionId}:${result.turnIndex}:${result.snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

function formatLongMemEvalTurn(
  content: string,
  metadata: { sessionId: string; haystackDate?: string },
): string {
  const fields = [`source_session: ${metadata.sessionId}`];
  if (metadata.haystackDate) {
    fields.push(`source_date: ${metadata.haystackDate}`);
  }
  return `[${fields.join("] [")}] ${content}`;
}

function shouldAnnotateTemporalSources(question: string): boolean {
  return (
    collectIsoDateCues(question).length > 0 ||
    collectTemporalLexicalCues(question).length > 0
  );
}

function buildTemporalRecallAudit(options: {
  item: LongMemEvalItem;
  question: string;
  recalledText: string;
}): Record<string, unknown> {
  const questionDates = collectIsoDateCues(options.question);
  const temporalCues = collectTemporalLexicalCues(options.question);
  const recalledText = options.recalledText;
  return {
    questionDates,
    temporalCues,
    matchedQuestionDates: questionDates.filter((date) =>
      recalledText.includes(date),
    ),
    matchedTemporalCues: temporalCues.filter((cue) =>
      recalledText.toLowerCase().includes(cue.toLowerCase()),
    ),
    matchedSourceDates: options.item.haystack_dates.filter((date) =>
      recalledText.includes(date),
    ),
    matchedSourceSessionIds: options.item.haystack_session_ids.filter(
      (sessionId) => recalledText.includes(`source_session: ${sessionId}`),
    ),
    answerSessionIdsUsedForRecall: false,
  };
}

function collectIsoDateCues(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/g)]
        .map((match) => match[0]),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<LongMemEvalItem[]> {
  const loaded = await loadLongMemEvalS({ mode, datasetDir, limit });

  if (loaded.source === "missing") {
    if (!datasetDir) {
      throw new Error(
        "LongMemEval full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
      );
    }
    throw new Error(
      formatMissingDatasetError(
        "longmemeval",
        datasetDir,
        LONG_MEM_EVAL_DATASET_FILENAMES,
        loaded.errors,
      ),
    );
  }

  if (loaded.items.length === 0) {
    throw new Error(
      "LongMemEval dataset is empty after applying the requested limit.",
    );
  }

  if (loaded.source === "smoke" && loaded.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LongMemEval falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  return loaded.items;
}
