import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchJudge,
  BenchResponder,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  readonly recallCalls: Array<{ sessionId: string; query: string }> = [];
  readonly judge?: BenchJudge;
  readonly responder?: BenchResponder;

  constructor(judge?: BenchJudge, responder?: BenchResponder) {
    this.judge = judge;
    this.responder = responder;
  }

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
    this.recallCalls.push({ sessionId, query: _query });
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
    const haystack = sessionId
      ? [[sessionId, this.sessions.get(sessionId) ?? []] as const]
      : [...this.sessions.entries()];

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        if (message.content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            turnIndex: index,
            role: message.role,
            snippet: message.content,
            sessionId: currentSessionId,
            score: 1,
          });
        }
      });
    }

    return results.slice(0, limit);
  }

  async reset(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.clear();
  }

  async getStats(): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    const totalMessages = [...this.sessions.values()].reduce(
      (sum, messages) => sum + messages.length,
      0,
    );

    return {
      totalMessages,
      totalSummaryNodes: 0,
      maxDepth: 1,
    };
  }

  async destroy(): Promise<void> {}
}

test("runBenchmark executes memoryagentbench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("memoryagentbench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "memoryagentbench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 4);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(typeof result.results.aggregates.rouge_l?.mean, "number");
  assert.equal(result.results.tasks[0]?.details?.competency, "accurate_retrieval");
  assert.equal(result.results.tasks[2]?.details?.competency, "long_range_understanding");
  assert.equal(
    result.results.tasks[3]?.actual.includes("The current project codename is Zephyr."),
    true,
  );
  assert.deepEqual(result.results.tasks[0]?.details?.answerVariants, [
    "the riverside market",
    "riverside market",
  ]);
});

test("runBenchmark executes memoryagentbench in full mode from split dataset files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "Accurate_Retrieval.json"),
    JSON.stringify([
      {
        context: "Event log:\\n1. Priya checked in at the library.\\n2. Priya headed to the cafe.",
        questions: ["Where did Priya go after the library?"],
        answers: [["the cafe", "cafe"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-full-ar-q1"],
        },
      },
    ]),
    "utf8",
  );

  await writeFile(
    path.join(datasetDir, "Conflict_Resolution.json"),
    JSON.stringify([
      {
        context: "0. The active theme is Ember.\\n1. The active theme is Aurora.",
        questions: ["What is the active theme?"],
        answers: [["Aurora"]],
        metadata: {
          source: "factconsolidation_sh_6k",
          qa_pair_ids: ["mab-full-cr-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.tasks[0]?.expected, "the cafe");
  assert.equal(result.results.tasks[0]?.details?.competency, "accurate_retrieval");
  assert.equal(result.results.tasks[1]?.expected, "Aurora");
  assert.equal(result.results.tasks[1]?.details?.competency, "conflict_resolution");
});

test("runBenchmark maps current MemoryAgentBench source aliases like ruler_qa1_197K to accurate_retrieval", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-ruler-alias-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "Accurate_Retrieval.json"),
    JSON.stringify([
      {
        context: "Reference notes:\\nNina stored the archive key inside the cedar box.",
        questions: ["Where did Nina store the archive key?"],
        answers: [["the cedar box", "cedar box"]],
        metadata: {
          source: "ruler_qa1_197K",
          qa_pair_ids: ["mab-ruler-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "the cedar box");
  assert.equal(result.results.tasks[0]?.details?.competency, "accurate_retrieval");
  assert.equal(result.results.tasks[0]?.details?.source, "ruler_qa1_197K");
});

test("runBenchmark maps broad MemoryAgentBench InfBench and Recsys source variants to official protocols", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-protocol-variants-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond(question) {
      return {
        text: question.includes("movie recommender")
          ? "The Big Lebowski (1998)"
          : "brief summary",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Long document asks for a short summary.",
        questions: ["What is the summary?"],
        answers: [["brief summary"]],
        metadata: {
          source: "infbench_qa",
          qa_pair_ids: ["mab-infbench-variant-q1"],
        },
      },
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_custom",
          qa_pair_ids: ["mab-recsys-variant-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.officialProtocol, "infbench_sum");
  assert.equal(result.results.tasks[0]?.actual, "brief summary");
  assert.equal(result.results.tasks[1]?.details?.officialProtocol, "recsys_redial");
  assert.equal(result.results.tasks[1]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark uses the best-matching MemoryAgentBench answer variant for judge scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-judge-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const judgeCalls: Array<{
    expected: string;
    predicted: string;
    question: string;
  }> = [];
  const adapter = new FakeMemoryAdapter({
    async score(question, predicted, expected) {
      judgeCalls.push({ question, predicted, expected });
      return expected === "quarterly roadmap review" ? 0.91 : 0.13;
    },
  });
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context:
          "Notes:\\nThe team met for the quarterly roadmap review and wrote action items.",
        questions: ["Which meeting generated the action items?"],
        answers: [["roadmap meeting", "quarterly roadmap review"]],
        metadata: {
          source: "eventqa_judge_variant",
          qa_pair_ids: ["mab-judge-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(judgeCalls.length, 1);
  assert.deepEqual(judgeCalls[0], {
    question: "Which meeting generated the action items?",
    predicted:
      "Notes:\\nThe team met for the quarterly roadmap review and wrote action items.",
    expected: "quarterly roadmap review",
  });
  assert.equal(result.results.tasks[0]?.details?.bestExpectedAnswer, "quarterly roadmap review");
  assert.equal(result.results.tasks[0]?.expected, "roadmap meeting");
  assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.91);
  assert.equal(result.results.tasks[0]?.scores.f1 > 0, true);
});

test("runBenchmark keeps sentence-ending punctuation on the preceding MemoryAgentBench chunk", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-chunking-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  const longSentence = `${"A".repeat(1_190)}. ${"B".repeat(40)}`;
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: longSentence,
        questions: ["What token fills the second sentence?"],
        answers: [["B"]],
        metadata: {
          source: "eventqa_sentence_chunking",
          qa_pair_ids: ["mab-chunk-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });
  const storedMessages = [...adapter.sessions.values()][0];

  assert.equal(storedMessages?.length, 2);
  assert.equal(storedMessages?.[0]?.content.endsWith("."), true);
  assert.equal(storedMessages?.[1]?.content.startsWith("."), false);
  assert.equal(
    result.results.tasks[0]?.actual.includes(`${"A".repeat(1_190)}.\n${"B".repeat(40)}`),
    true,
  );
});

test("runBenchmark retrieves MemoryAgentBench event/date cues from stored context only", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-event-date-cues-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) =>
        message.content.includes("event_id=E17")
        || message.content.includes("date=2026-04-03"),
      )
      .map((message) => message.content)
      .join("\n");
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: [
          "Event E11 on 2026-04-02: Maya packed the blue field kit.",
          "Event E17 on 2026-04-03: Maya walked to the riverside market.",
        ].join("\n\n"),
        questions: ["After event E17 on 2026-04-03, what happened next?"],
        answers: [["riverside market"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-event-date-visible-q1"],
          question_dates: ["2099-01-01"],
          previous_events: ["hidden previous event"],
          keypoints: ["hidden keypoint"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.actual), /riverside market/);
  assert.doesNotMatch(String(task.actual), /MemoryAgentBench visible anchors/);
  assert.doesNotMatch(adapter.recallCalls[0]?.query ?? "", /2099-01-01|hidden keypoint|hidden previous event/);
  assert.equal(task.details?.questionDate, "2099-01-01");
  assert.deepEqual(task.details?.keypoints, ["hidden keypoint"]);
});

test("runBenchmark supports latest fact cues for MemoryAgentBench conflict resolution", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-conflict-cues-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    const messages = adapter.sessions.get(sessionId) ?? [];
    const latest = [...messages]
      .reverse()
      .find((message) => message.content.includes("fact_id=1"));
    return /current|latest|newest|most recent/i.test(query) && latest
      ? latest.content
      : messages.map((message) => message.content).join("\n");
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: [
          "0. The active theme is Ember.",
          "1. The active theme is Aurora.",
        ].join("\n\n"),
        questions: ["What is the current active theme?"],
        answers: [["Aurora"]],
        metadata: {
          source: "factconsolidation_visible_fact_ids",
          qa_pair_ids: ["mab-conflict-visible-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.actual), /Aurora/);
  assert.doesNotMatch(String(task.actual), /Ember/);
  assert.doesNotMatch(String(task.actual), /MemoryAgentBench visible anchors/);
});

test("runBenchmark stores visible MemoryAgentBench chunk cues for chunked context recall", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-chunk-cues-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) =>
        /chunk\s+1/i.test(query) && message.content.includes("chunk_id=1"),
      )
      .map((message) => message.content)
      .join("\n");
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: [
          "Chunk zero notes discuss the marble archive.",
          "Chunk one notes say the archive key is in the cedar box.",
        ].join("\n\n"),
        questions: ["Use chunk 1: where is the archive key?"],
        answers: [["cedar box"]],
        metadata: {
          source: "eventqa_chunk_visible",
          qa_pair_ids: ["mab-chunk-visible-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.actual), /cedar box/);
  assert.doesNotMatch(String(task.actual), /marble archive/);
  assert.doesNotMatch(String(task.actual), /MemoryAgentBench visible anchors/);
});

test("runBenchmark rejects memoryagentbench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        system: adapter,
      }),
    /MemoryAgentBench full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when memoryagentbench full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /MemoryAgentBench dataset not found under/,
  );
});

test("runBenchmark rejects empty memoryagentbench datasets after applying limit", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemoryAgentBench dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark preserves the empty-after-limit error for MemoryAgentBench bundle files", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-empty-bundle-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Bundle sample.",
        questions: ["What happened?"],
        answers: [["A bundle sample was recorded."]],
        metadata: {
          source: "eventqa_bundle_limit",
        },
      },
    ]),
    "utf8",
  );

  await assert.rejects(async () => {
    await runBenchmark("memoryagentbench", {
      mode: "full",
      datasetDir,
      limit: 0,
      system: adapter,
    });
  }, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /MemoryAgentBench dataset is empty after applying the requested limit/,
    );
    assert.doesNotMatch(error.message, /MemoryAgentBench dataset not found under/);
    return true;
  });
});

test("runBenchmark rejects unsupported memoryagentbench metadata sources with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-bad-source-"));
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Bad sample.",
        questions: ["What happened?"],
        answers: [["Nothing"]],
        metadata: {
          source: "unknown_split",
        },
      },
    ]),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /does not map to a supported competency/,
  );
});

test("runBenchmark uses official MemoryAgentBench ICL prompts and label scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-icl-protocol-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const responderQuestions: string[] = [];
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond(question, _recalledText) {
      responderQuestions.push(question);
      return {
        text: "label: 28",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "A disposable card problem maps to label: 28.",
        questions: ["My disposable card does not work."],
        answers: [["28"]],
        metadata: {
          source: "icl_banking77_5900shot_balance",
          qa_pair_ids: ["mab-icl-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.match(responderQuestions[0] ?? "", /Only output "label: \{label\}"/);
  assert.equal(result.results.tasks[0]?.details?.officialProtocol, "in_context_learning");
  assert.equal(result.results.tasks[0]?.details?.parsedOfficialAnswer, "28");
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 1);
  assert.equal(result.results.tasks[0]?.scores.official_f1, 1);
});

test("runBenchmark parses the final explicit ICL label mention for official scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-final-icl-label-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "Earlier example label: 12\nFinal label: 28",
        tokens: { input: 1, output: 2 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "A disposable card problem maps to label: 28.",
        questions: ["My disposable card does not work."],
        answers: [["28"]],
        metadata: {
          source: "icl_banking77_5900shot_balance",
          qa_pair_ids: ["mab-icl-final-label-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.parsedOfficialAnswer, "28");
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 1);
});

test("runBenchmark does not coerce trailing ICL reasoning text into a label", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-icl-no-label-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "Earlier example label: 12\nI cannot determine",
        tokens: { input: 1, output: 2 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "A disposable card problem maps to label: 28.",
        questions: ["My disposable card does not work."],
        answers: [["28"]],
        metadata: {
          source: "icl_banking77_5900shot_balance",
          qa_pair_ids: ["mab-icl-no-label-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(
    result.results.tasks[0]?.details?.parsedOfficialAnswer,
    "Earlier example label: 12\nI cannot determine",
  );
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 0);
});

test("runBenchmark preserves multiline official answers for MemoryAgentBench scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-multiline-answer-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "Answer: red scarf\nblue hat",
        tokens: { input: 1, output: 2 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The detective noted a red scarf and a blue hat.",
        questions: ["Which two items were noted?"],
        answers: [["red scarf blue hat"]],
        metadata: {
          source: "detective_qa",
          qa_pair_ids: ["mab-multiline-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(
    result.results.tasks[0]?.details?.parsedOfficialAnswer,
    "red scarf\nblue hat",
  );
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 1);
});

test("runBenchmark parses the last Answer block for MemoryAgentBench official scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-last-answer-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "Example Answer: wrong\nReasoning...\nAnswer: final answer",
        tokens: { input: 1, output: 3 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The final answer is recorded in the last answer block.",
        questions: ["What is the final answer?"],
        answers: [["final answer"]],
        metadata: {
          source: "detective_qa",
          qa_pair_ids: ["mab-last-answer-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.parsedOfficialAnswer, "final answer");
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 1);
});

test("runBenchmark scores EventQA recall against any accepted answer variant", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-eventqa-variants-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "The event that happens next is: she went to the riverside market",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Maya visited the museum, then walked to the riverside market.",
        questions: ["After the museum, what happened next?"],
        answers: [["the cafe", "riverside market"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-eventqa-variant-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.scores.eventqa_recall, 1);
});

test("runBenchmark strips EventQA prompt prefix before official text scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-eventqa-prefix-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "The event that happens next is: riverside market",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Maya visited the museum, then walked to the riverside market.",
        questions: ["After the museum, what happened next?"],
        answers: [["riverside market"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-eventqa-prefix-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.parsedOfficialAnswer, "riverside market");
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, 1);
  assert.equal(result.results.tasks[0]?.scores.official_f1, 1);
});

test("runBenchmark records official MemoryAgentBench metrics on task errors", async () => {
  class FailingRecallAdapter extends FakeMemoryAdapter {
    override async recall(sessionId: string, query: string): Promise<string> {
      this.recallCalls.push({ sessionId, query });
      throw new Error("recall unavailable");
    }
  }

  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-error-official-scores-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FailingRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Maya visited the museum, then walked to the riverside market.",
        questions: ["After the museum, what happened next?"],
        answers: [["riverside market"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-error-official-scores-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.scores.f1, -1);
  assert.equal(result.results.tasks[0]?.scores.official_exact_match, -1);
  assert.equal(result.results.tasks[0]?.scores.official_f1, -1);
  assert.equal(result.results.tasks[0]?.scores.official_rouge_l, -1);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.eventqa_recall, -1);
  assert.equal(result.results.aggregates.official_f1?.mean, -1);
});

test("runBenchmark keeps ReDial error metrics out of official text aggregates", async () => {
  class FailingRecallAdapter extends FakeMemoryAdapter {
    override async recall(sessionId: string, query: string): Promise<string> {
      this.recallCalls.push({ sessionId, query });
      throw new Error("recall unavailable");
    }
  }

  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-redial-error-scores-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FailingRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-redial-error-scores-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.scores.official_f1, undefined);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, -1);
  assert.equal(result.results.aggregates.official_f1, undefined);
  assert.equal(result.results.aggregates.recsys_recall_at_1?.mean, -1);
});

test("runBenchmark does not load ReDial mappings for non-ReDial MemoryAgentBench samples", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-non-redial-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(path.join(mappingDir, "entity2id.json"), "[malformed", "utf8");
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Priya checked in at the library and then went to the cafe.",
        questions: ["Where did Priya go after the library?"],
        answers: [["cafe"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-no-redial-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.details?.officialProtocol, "eventqa");
});

test("runBenchmark scores ReDial recommendations with the official entity mapping when present", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-protocol-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: ["1. The Big Lebowski (1998)", "2. Fargo (1996)"].join("\n"),
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/The_Big_Lebowski_(1998)": 7008,
      "/movie/Fargo_(1996)": 22364,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy and crime films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.officialProtocol, "recsys_redial");
  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, true);
  assert.deepEqual(result.results.tasks[0]?.details?.recsysGroundTruthMovies, [
    "The Big Lebowski (1998)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_5, 1);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_10, 1);
});

test("runBenchmark prefers canonical ReDial mappings over loose entity2id fallbacks", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-canonical-map-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "entity2id.json"),
    JSON.stringify({ "/movie/Stale_Local_Map_(2000)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-canonical-map-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.match(
    String(result.results.tasks[0]?.details?.recsysEntityMappingPath),
    /processed_data/,
  );
  assert.deepEqual(result.results.tasks[0]?.details?.recsysGroundTruthMovies, [
    "The Big Lebowski (1998)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark marks ReDial tasks not leaderboard-scorable when any answer ID is unmapped", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-partial-groundtruth-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008", "9999"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-partial-groundtruth-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, false);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, undefined);
  assert.equal(result.results.tasks[0]?.details?.recsysGroundTruthMovies, undefined);
});

test("runBenchmark uses the raw MemoryAgentBench question for recall and the official prompt for response", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recall-query-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const responderQuestions: string[] = [];
  const rawQuestion = "System: recommend a comedy movie";
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond(question) {
      responderQuestions.push(question);
      return {
        text: "The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: [rawQuestion],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recall-query-q1"],
        },
      },
    ]),
    "utf8",
  );

  await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(adapter.recallCalls.length, 1);
  assert.equal(adapter.recallCalls[0]?.query, rawQuestion);
  assert.equal(responderQuestions.length, 1);
  assert.match(responderQuestions[0] ?? "", /movie recommender system/);
  assert.match(responderQuestions[0] ?? "", new RegExp(rawQuestion));
});

test("runBenchmark preserves comma-containing ReDial movie titles while parsing recommendations", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-comma-title-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. O Brother, Where Art Thou? (2000)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/O_Brother,_Where_Art_Thou?_(2000)": 1001,
      "/movie/O_(2001)": 1002,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comic odyssey films.",
        questions: ["System: "],
        answers: [["1001"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-comma-title-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "O Brother, Where Art Thou? (2000)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark parses comma-separated ReDial recommendations as separate movies", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-comma-list-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "The Big Lebowski (1998), Fargo (1996)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/The_Big_Lebowski_(1998)": 7008,
      "/movie/Fargo_(1996)": 22364,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy and crime films.",
        questions: ["System: "],
        answers: [["22364"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-comma-list-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "The Big Lebowski (1998)",
    "Fargo (1996)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_5, 1);
});

test("runBenchmark ignores unmatched ReDial preamble lines instead of nearest-mapping them", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-preamble-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: ["Sure!", "The recommendations are:", "1. The Big Lebowski (1998)"].join("\n"),
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/Sabrina_(1995)": 123,
      "/movie/The_Big_Lebowski_(1998)": 7008,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-preamble-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "The Big Lebowski (1998)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark matches yearless ReDial recommendations to year-bearing entity titles", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-yearless-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: ["1. The Big Lebowski", "2. Fargo"].join("\n"),
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/The_Big_Lebowski_(1998)": 7008,
      "/movie/Fargo_(1996)": 22364,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy and crime films.",
        questions: ["System: "],
        answers: [["22364"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-yearless-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "The Big Lebowski (1998)",
    "Fargo (1996)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_5, 1);
});

test("runBenchmark decodes URL escapes in ReDial entity movie names", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-url-decode-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. Ocean's Eleven",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/Ocean%27s_Eleven_(2001)": 9001 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions heist films.",
        questions: ["System: "],
        answers: [["9001"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-url-decode-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "Ocean's Eleven (2001)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark preserves hyphens in ReDial entity movie names", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-hyphen-title-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. Spider-Man",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/Spider-Man_(2002)": 2002 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions superhero films.",
        questions: ["System: "],
        answers: [["2002"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-hyphen-title-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "Spider-Man (2002)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark matches short yearless ReDial movie titles", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-short-title-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: '1. "Up."',
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/Up_(2009)": 2009 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions animated films.",
        questions: ["System: "],
        answers: [["2009"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-short-title-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "Up (2009)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark does not match short ReDial titles inside ordinary words", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-short-word-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "I came up with The Big Lebowski (1998), Fargo (1996)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/Up_(2009)": 2009,
      "/movie/The_Big_Lebowski_(1998)": 7008,
      "/movie/Fargo_(1996)": 22364,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy and crime films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-short-word-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "The Big Lebowski (1998)",
    "Fargo (1996)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark ignores ambiguous yearless ReDial aliases for duplicate movie titles", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-duplicate-title-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. King Kong",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/King_Kong_(1933)": 1933,
      "/movie/King_Kong_(2005)": 2005,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions monster movies.",
        questions: ["System: "],
        answers: [["2005"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-duplicate-title-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, []);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 0);
});

test("runBenchmark prefers the most specific overlapping ReDial movie title", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-overlap-title-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Matrix Revolutions",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/The_Matrix_(1999)": 1999,
      "/movie/The_Matrix_Revolutions_(2003)": 2003,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions science fiction sequels.",
        questions: ["System: "],
        answers: [["2003"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-overlap-title-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "The Matrix Revolutions (2003)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark parses comma-separated short yearless ReDial titles", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-short-comma-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "Up,Her",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({
      "/movie/Up_(2009)": 2009,
      "/movie/Her_(2013)": 2013,
    }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions animated and near-future films.",
        questions: ["System: "],
        answers: [["2013"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-short-comma-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.deepEqual(result.results.tasks[0]?.details?.recsysPredictedMovies, [
    "Up (2009)",
    "Her (2013)",
  ]);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_5, 1);
});

test("runBenchmark scopes ReDial mapping details to ReDial MemoryAgentBench tasks", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-detail-scope-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond(question) {
      return {
        text: question.includes("System:")
          ? "The Big Lebowski (1998)"
          : "the riverside market",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(
    path.join(mappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-detail-scope-redial"],
        },
      },
      {
        context: "Maya visited the museum, then walked to the riverside market.",
        questions: ["After the museum, what happened next?"],
        answers: [["riverside market"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-recsys-detail-scope-eventqa"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const redialDetails = result.results.tasks[0]?.details ?? {};
  const eventQaDetails = result.results.tasks[1]?.details ?? {};
  assert.equal(redialDetails.recsysScoringReady, true);
  assert.equal(typeof redialDetails.recsysEntityMappingPath, "string");
  assert.equal("recsysScoringReady" in eventQaDetails, false);
  assert.equal("recsysEntityMappingPath" in eventQaDetails, false);
  assert.equal("recsysGroundTruthMovies" in eventQaDetails, false);
  assert.equal("recsysPredictedMovies" in eventQaDetails, false);
});

test("runBenchmark marks ReDial tasks not leaderboard-scorable when entity mapping is malformed", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-bad-map-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const mappingDir = path.join(tmpDir, "datasets", "processed_data", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(mappingDir, { recursive: true });
  await writeFile(path.join(mappingDir, "entity2id.json"), "[malformed", "utf8");
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-bad-map-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, false);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, undefined);
});

test("runBenchmark keeps searching ReDial mapping candidates after a malformed file", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-map-fallback-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const badMappingDir = path.join(
    tmpDir,
    "datasets",
    "processed_data",
    "Recsys_Redial",
  );
  const goodMappingDir = path.join(tmpDir, "datasets", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(badMappingDir, { recursive: true });
  await mkdir(goodMappingDir, { recursive: true });
  await writeFile(path.join(badMappingDir, "entity2id.json"), "[malformed", "utf8");
  await writeFile(
    path.join(goodMappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-map-fallback-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, true);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark skips empty ReDial mapping candidates before accepting a fallback", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-empty-map-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const emptyMappingDir = path.join(
    tmpDir,
    "datasets",
    "processed_data",
    "Recsys_Redial",
  );
  const goodMappingDir = path.join(tmpDir, "datasets", "Recsys_Redial");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await mkdir(emptyMappingDir, { recursive: true });
  await mkdir(goodMappingDir, { recursive: true });
  await writeFile(path.join(emptyMappingDir, "entity2id.json"), "{}", "utf8");
  await writeFile(
    path.join(goodMappingDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-empty-map-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, true);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, 1);
});

test("runBenchmark marks ReDial tasks not leaderboard-scorable when entity mapping is missing", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-missing-map-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-no-map-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, false);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, undefined);
});

test("runBenchmark does not use loose ReDial mapping files outside the dataset bundle", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-recsys-ancestor-map-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter(undefined, {
    async respond() {
      return {
        text: "1. The Big Lebowski (1998)",
        tokens: { input: 1, output: 1 },
        latencyMs: 0,
        model: "fake",
      };
    },
  });
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(tmpDir, "entity2id.json"),
    JSON.stringify({ "/movie/The_Big_Lebowski_(1998)": 7008 }),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Dialogue history mentions comedy films.",
        questions: ["System: "],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial_full",
          qa_pair_ids: ["mab-recsys-ancestor-map-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details?.recsysScoringReady, false);
  assert.equal(result.results.tasks[0]?.scores.official_protocol_ready, 0);
  assert.equal(result.results.tasks[0]?.scores.recsys_recall_at_1, undefined);
});
