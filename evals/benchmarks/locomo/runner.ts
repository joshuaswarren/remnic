/**
 * LoCoMo runner — Evaluating Very Long-Term Conversational Memory of LLM Agents.
 *
 * 10 long conversations (~300 turns, ~9K tokens each, up to 35 sessions).
 * 1,986 QA pairs across 5 categories.
 *
 * Categories (from paper):
 *   1 = single-hop        (factual retrieval from one turn)
 *   2 = multi-hop          (requires combining info across turns)
 *   3 = temporal           (time-based reasoning)
 *   4 = open-domain        (general questions about the conversation)
 *   5 = adversarial/unanswerable
 *
 * Published baselines (QA F1, from paper Table 2):
 *   GPT-4 + full context:  ~0.62  |  GPT-4 + RAG:  ~0.49
 *   LLaMA-2 70B + RAG:     ~0.36  |  Human:        ~0.86
 *
 * Dataset: https://github.com/snap-research/locomo
 * Paper:   Maharana et al. Evaluating Very Long-Term Conversational Memory of LLM Agents. ACL 2024.
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
import { f1Score, containsAnswer, rougeL, llmJudgeScore, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

// ── Dataset types (matches locomo10.json) ──

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[]; // e.g. ["D1:3", "D5:12"]
  category: number;   // 1-5
}

interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, any>; // speaker_a, speaker_b, session_1, session_1_date_time, etc.
  qa: LoCoMoQA[];
  event_summary: any;
  observation: any;
  session_summary: any;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "single_hop",
  2: "multi_hop",
  3: "temporal",
  4: "open_domain",
  5: "adversarial",
};

async function loadDataset(datasetDir: string): Promise<LoCoMoConversation[]> {
  for (const filename of ["locomo10.json", "locomo.json"]) {
    try {
      const raw = await readFile(path.join(datasetDir, filename), "utf-8");
      const data: LoCoMoConversation[] = JSON.parse(raw);
      console.log(`  Loaded ${data.length} conversations from ${filename}`);
      return data;
    } catch {
      continue;
    }
  }
  throw new Error(
    `LoCoMo dataset not found at ${datasetDir}. Download with:\n` +
    `  git clone --depth 1 https://github.com/snap-research/locomo.git /tmp/locomo && cp /tmp/locomo/data/locomo10.json ${datasetDir}/`,
  );
}

/** Extract sessions from the conversation dict as ordered (sessionId, turns) pairs. */
function extractSessions(conv: Record<string, any>): Array<{ sessionId: string; turns: LoCoMoTurn[] }> {
  const sessions: Array<{ sessionId: string; turns: LoCoMoTurn[] }> = [];
  const sessionKeys = Object.keys(conv)
    .filter((k) => k.match(/^session_\d+$/) && Array.isArray(conv[k]))
    .sort((a, b) => {
      const na = parseInt(a.replace("session_", ""));
      const nb = parseInt(b.replace("session_", ""));
      return na - nb;
    });

  for (const key of sessionKeys) {
    sessions.push({
      sessionId: key,
      turns: conv[key] as LoCoMoTurn[],
    });
  }
  return sessions;
}

const meta: BenchmarkMeta = {
  name: "locomo",
  version: "2.0.0",
  description: "Long conversation memory — 1,986 QA pairs across 10 multi-session conversations (ACL 2024)",
  category: "conversational",
  citation: "Maharana et al. Evaluating Very Long-Term Conversational Memory of LLM Agents. ACL 2024.",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const conversations = await loadDataset(options.datasetDir);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  // Limit applies to conversations (each has ~200 QA pairs)
  const convsToRun = options.limit !== undefined ? conversations.slice(0, options.limit) : conversations;

  for (let ci = 0; ci < convsToRun.length; ci++) {
    const conv = convsToRun[ci];
    await system.reset();

    console.log(`  [locomo] Conversation ${ci + 1}/${convsToRun.length} (${conv.sample_id}): ${conv.qa.length} QA pairs`);

    // Phase 1: Ingest all sessions
    const sessions = extractSessions(conv.conversation);
    const speakerA = conv.conversation.speaker_a ?? "Speaker A";
    const speakerB = conv.conversation.speaker_b ?? "Speaker B";

    for (const session of sessions) {
      // Map speaker turns to user/assistant roles
      // speakerA → user, speakerB → assistant (convention from paper)
      const messages = session.turns.map((t) => ({
        role: (t.speaker === speakerA ? "user" : "assistant") as "user" | "assistant",
        content: t.text,
      }));
      if (messages.length > 0) {
        await system.store(`${conv.sample_id}-${session.sessionId}`, messages);
      }
    }

    // Phase 2: Query each QA pair
    const sessionIds = sessions.map((s) => `${conv.sample_id}-${s.sessionId}`);

    for (let qi = 0; qi < conv.qa.length; qi++) {
      const qa = conv.qa[qi];
      const catName = CATEGORY_NAMES[qa.category] ?? `cat_${qa.category}`;

      const { result: recallText, durationMs } = await timed(async () => {
        // Recall from all sessions
        const parts: string[] = [];
        for (const sid of sessionIds) {
          const r = await system.recall(sid, qa.question);
          if (r && r.trim().length > 0) parts.push(r);
        }
        return parts.join("\n\n");
      });

      const f1 = f1Score(recallText, qa.answer);
      const contains = containsAnswer(recallText, qa.answer);
      const rouge = rougeL(recallText, qa.answer);
      const judgeScore = await llmJudgeScore(system.judge, qa.question, recallText, qa.answer);

      const metrics: Record<string, number> = {
        f1,
        contains_answer: contains,
        rouge_l: rouge,
      };
      if (judgeScore >= 0) metrics.llm_judge = judgeScore;

      scores.push({
        taskId: `${conv.sample_id}-q${qi}-${catName}`,
        metrics,
        details: {
          question: qa.question,
          expected: qa.answer,
          category: qa.category,
          category_name: catName,
          evidence: qa.evidence,
          conversation_id: conv.sample_id,
          recalled_length: recallText.length,
        },
        latencyMs: durationMs,
      });
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Overall aggregate
  const aggregate = aggregateScores(scores.map((s) => s.metrics));

  // Per-category aggregates
  for (const [catNum, catName] of Object.entries(CATEGORY_NAMES)) {
    const catScores = scores.filter((s) => (s.details as any)?.category === parseInt(catNum));
    if (catScores.length > 0) {
      const catF1 = catScores.map((s) => s.metrics.f1);
      const catContains = catScores.map((s) => s.metrics.contains_answer);
      aggregate[`${catName}_f1`] = catF1.reduce((a, b) => a + b, 0) / catF1.length;
      aggregate[`${catName}_accuracy`] = catContains.reduce((a, b) => a + b, 0) / catContains.length;
      aggregate[`${catName}_count`] = catScores.length;
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
      conversations_run: convsToRun.length,
    },
    durationMs,
  });
}

export const locomoRunner: BenchmarkRunner = { meta, run };
