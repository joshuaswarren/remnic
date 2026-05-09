/**
 * LoCoMo runner migrated into @remnic/bench for phase 1.
 *
 * As of issue #566 PR 2/7, the per-item lifecycle (reset → ingest →
 * recall → answer → judge → score) lives in `../harness.ts`. This
 * module only knows about dataset loading, session extraction, and
 * how to translate a `LoCoMoConversation` into a `HarnessPlan`.
 */

import type { Message } from "../../../adapters/types.js";
import {
  type LoCoMoConversation,
  type LoCoMoQA,
  type LoCoMoTurn,
} from "./fixture.js";
import {
  LOCOMO_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLoCoMo10,
  normalizeLoCoMoQa,
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

const CATEGORY_NAMES: Record<number, string> = {
  1: "single_hop",
  2: "multi_hop",
  3: "temporal",
  4: "open_domain",
  5: "adversarial",
};
const DIALOGUE_ID_PATTERN = /\bD\d+:\d+\b/g;

/** Extract sessions from the conversation dict as ordered (sessionId, turns) pairs. */
function extractSessions(
  conversation: Record<string, unknown>,
): Array<{ sessionId: string; turns: LoCoMoTurn[] }> {
  const sessions: Array<{ sessionId: string; turns: LoCoMoTurn[] }> = [];
  const sessionKeys = Object.keys(conversation)
    .filter(
      (key) =>
        /^session_\d+$/.test(key) && Array.isArray(conversation[key]),
    )
    .sort((a, b) => {
      const leftIndex = Number.parseInt(a.replace("session_", ""), 10);
      const rightIndex = Number.parseInt(b.replace("session_", ""), 10);
      return leftIndex - rightIndex;
    });

  for (const key of sessionKeys) {
    sessions.push({
      sessionId: key,
      turns: conversation[key] as LoCoMoTurn[],
    });
  }
  return sessions;
}

function buildMessages(
  turns: LoCoMoTurn[],
  speakerA: string,
): Message[] {
  return turns.map((turn) => ({
    role: turn.speaker === speakerA ? "user" : "assistant",
    content: `[${turn.dia_id}] ${turn.speaker}: ${turn.text}`,
  }));
}

export const locomoDefinition: BenchmarkDefinition = {
  id: "locomo",
  title: "LoCoMo",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "locomo",
    version: "2.0.0",
    description:
      "Long conversation memory benchmark across multi-session dialogue transcripts and QA probes.",
    category: "conversational",
    citation:
      "Maharana et al. Evaluating Very Long-Term Conversational Memory of LLM Agents. ACL 2024.",
  },
};

export async function runLoCoMoBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const conversations = await loadDataset(
    options.mode,
    options.datasetDir,
    options.limit,
  );
  const trialLimit = resolveTrialLimit(options.benchmarkOptions?.trialLimit);
  const plans = applyTrialLimit(conversations.map(buildPlan), trialLimit);
  const benchmarkOptions =
    trialLimit === undefined
      ? options.benchmarkOptions
      : { ...(options.benchmarkOptions ?? {}), trialLimit };

  return runPublishedHarness({
    options: { ...options, benchmarkOptions },
    metricsSpec: {
      metrics: ["f1", "contains_answer", "rouge_l", "llm_judge"],
    },
    plans,
    totalCount: plans.reduce((sum, plan) => sum + plan.trials.length, 0),
  });
}

function resolveTrialLimit(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "LoCoMo benchmarkOptions.trialLimit must be a non-negative integer.",
    );
  }
  return parsed;
}

function applyTrialLimit(
  plans: HarnessPlan[],
  trialLimit: number | undefined,
): HarnessPlan[] {
  if (trialLimit === undefined) {
    return plans;
  }
  if (trialLimit === 0) {
    return [];
  }

  const limitedPlans: HarnessPlan[] = [];
  let remaining = trialLimit;
  for (const plan of plans) {
    if (remaining <= 0) {
      break;
    }
    const trials = plan.trials.slice(0, remaining);
    if (trials.length > 0) {
      limitedPlans.push({ ...plan, trials });
      remaining -= trials.length;
    }
  }
  return limitedPlans;
}

function buildPlan(conversation: LoCoMoConversation): HarnessPlan {
  const sessions = extractSessions(conversation.conversation);
  const speakerA =
    typeof conversation.conversation.speaker_a === "string"
      ? conversation.conversation.speaker_a
      : "Speaker A";

  const ingestSessions: HarnessPlan["ingestSessions"] = [];
  const sessionIds: string[] = [];
  for (const session of sessions) {
    const sessionId = `${conversation.sample_id}-${session.sessionId}`;
    const messages = buildMessages(session.turns, speakerA);
    sessionIds.push(sessionId);
    ingestSessions.push({ sessionId, messages });
  }

  const trials: HarnessTrial[] = conversation.qa.map((qa, questionIndex) =>
    buildTrial(conversation.sample_id, qa, questionIndex, sessionIds),
  );

  return { ingestSessions, trials };
}

function buildTrial(
  conversationId: string,
  qa: LoCoMoQA,
  questionIndex: number,
  sessionIds: string[],
): HarnessTrial {
  const categoryName =
    CATEGORY_NAMES[qa.category] ?? `category_${qa.category}`;
  return {
    taskId: `${conversationId}-q${questionIndex}-${categoryName}`,
    question: qa.question,
    expected: qa.answer,
    recallSessionIds: sessionIds,
    answerFormat: "short",
    recallTextTransform: sanitizeLoCoMoRecallText,
    postAnswerHook: async ({ question, recalledText }) => {
      const hiddenEvidenceIdLeakCount = countHiddenEvidenceIdsInRecall(
        qa.evidence,
        question,
        recalledText,
      );
      return {
        extraScores: {
          locomo_hidden_evidence_id_leak:
            hiddenEvidenceIdLeakCount === 0 ? 1 : 0,
        },
        extraDetails: { hiddenEvidenceIdLeakCount },
      };
    },
    extraDetails: {
      category: qa.category,
      categoryName,
      evidence: qa.evidence,
      conversationId,
      sessionIds,
    },
  };
}

function sanitizeLoCoMoRecallText(args: {
  question: string;
  recalledText: string;
}): string {
  const queryVisibleIds = collectDialogueIds(args.question);
  return args.recalledText
    .replace(/\[(D\d+:\d+)\]\s*/g, (match, id: string) =>
      queryVisibleIds.has(id) ? match : "",
    )
    .replace(DIALOGUE_ID_PATTERN, (id: string) =>
      queryVisibleIds.has(id) ? id : "",
    );
}

function countHiddenEvidenceIdsInRecall(
  evidence: readonly string[] | undefined,
  question: string,
  recalledText: string,
): number {
  const queryVisibleIds = collectDialogueIds(question);
  let count = 0;
  for (const id of evidence ?? []) {
    if (queryVisibleIds.has(id)) {
      continue;
    }
    if (new RegExp(`\\b${escapeRegExp(id)}\\b`).test(recalledText)) {
      count += 1;
    }
  }
  return count;
}

function collectDialogueIds(text: string): Set<string> {
  return new Set(text.match(DIALOGUE_ID_PATTERN) ?? []);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<LoCoMoConversation[]> {
  // Limit normalization happens inside `loadLoCoMo10`; do not re-validate
  // here (the shared loader's `normalizeLimit` is the single source of
  // truth).
  const loaded = await loadLoCoMo10({
    mode,
    datasetDir,
    limit,
    parseFile: parseDataset,
  });

  if (loaded.source === "missing") {
    if (!datasetDir) {
      throw new Error(
        "LoCoMo full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
      );
    }
    throw new Error(
      formatMissingDatasetError(
        "locomo",
        datasetDir,
        LOCOMO_DATASET_FILENAMES,
        loaded.errors,
      ),
    );
  }

  if (loaded.items.length === 0) {
    throw new Error(
      "LoCoMo dataset is empty after applying the requested limit.",
    );
  }

  if (loaded.source === "smoke" && loaded.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LoCoMo falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  return loaded.items;
}

function parseDataset(
  raw: string,
  filename: string,
): LoCoMoConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `LoCoMo dataset file ${filename} must contain an array of conversations.`,
    );
  }

  return parsed.map((entry, index) => parseConversation(entry, filename, index));
}

function parseConversation(
  entry: unknown,
  filename: string,
  index: number,
): LoCoMoConversation {
  const location = `LoCoMo dataset file ${filename} conversation ${index + 1}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.sample_id !== "string") {
    throw new Error(`${location} must include a string sample_id.`);
  }
  if (
    !record.conversation ||
    typeof record.conversation !== "object" ||
    Array.isArray(record.conversation)
  ) {
    throw new Error(`${location} must include a conversation object.`);
  }
  const qa = normalizeQaArray(record.qa, location);

  return {
    sample_id: record.sample_id,
    conversation: record.conversation as Record<string, unknown>,
    qa,
    event_summary: record.event_summary,
    observation: record.observation,
    session_summary: record.session_summary,
  };
}

function normalizeQaArray(value: unknown, location: string): LoCoMoQA[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${location} must include a qa array with question/answer/evidence/category fields.`,
    );
  }

  return value.map((entry, index) =>
    normalizeLoCoMoQa(entry, `${location} qa[${index}]`),
  );
}
