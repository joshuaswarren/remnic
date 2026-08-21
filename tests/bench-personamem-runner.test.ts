import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchResponder,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  readonly recallCalls: Array<{ sessionId: string; query: string }> = [];
  readonly searchCalls: Array<{ sessionId?: string; query: string; limit: number }> = [];

  constructor(readonly responder?: BenchResponder) {}

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, query: string): Promise<string> {
    this.recallCalls.push({ sessionId, query });
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
    this.searchCalls.push({ sessionId, query, limit });
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

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function toCsv(headers: string[], values: string[]): string {
  return `${headers.join(",")}\n${values.map(escapeCsvField).join(",")}\n`;
}

test("runBenchmark executes personamem in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("personamem", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "personamem");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(
    result.results.tasks[0]?.actual.includes("Earl Grey"),
    true,
  );
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey");
});

test("runBenchmark executes personamem in full mode from an explicit dataset root", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      metadata: { persona_id: "persona-1" },
      chat_history: [
        {
          role: "system",
          content: "You are a personalized assistant.",
        },
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
        {
          role: "assistant",
          content: "Noted: journaling pairs with Earl Grey tea for you.",
        },
      ],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "expanded_persona",
        "user_query",
        "correct_answer",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{\n  \"preferences\": [\"tea\", \"journaling\"],\n  \"note\": \"contains a comma, too\"\n}",
        "{'role': 'user', 'content': 'Which tea do I usually drink while journaling in the morning?'}",
        "Earl Grey",
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(
    result.results.tasks[0]?.question,
    "Which tea do I usually drink while journaling in the morning?",
  );
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey");
  assert.equal(
    result.results.tasks[0]?.actual.includes("Earl Grey"),
    true,
  );
});

test("runBenchmark scores personamem with official-style MCQ accuracy when distractors are present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-mcq-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  let promptSeen = "";
  const adapter = new FakeMemoryAdapter({
    async respond(question, recalledText) {
      promptSeen = question;
      assert.match(question, /Please choose the best answer/);
      assert.match(question, /Please recall my related preferences/);
      assert.match(recalledText, /Earl Grey/);
      return {
        text: "The history points to the tea option.\n\nFinal Answer: A",
        tokens: { input: 10, output: 8 },
        latencyMs: 3,
        model: "fake-responder",
      };
    },
  });
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      metadata: { persona_id: "persona-1" },
      chat_history: [
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
      ],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
        "incorrect_answers",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'Which tea do I usually drink while journaling?'}",
        "Earl Grey",
        JSON.stringify(["coffee", "peppermint"]),
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    seed: 0,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.mcq_accuracy, 1);
  assert.equal(result.results.aggregates.mcq_accuracy?.mean, 1);
  assert.equal(task.details?.evaluationMode, "mcq");
  assert.equal(task.details?.correctMcqOption, "A");
  assert.equal(task.details?.predictedMcqOption, "A");
  assert.deepEqual(task.details?.mcqOptions, {
    A: "Earl Grey",
    B: "coffee",
    C: "peppermint",
  });
  assert.match(promptSeen, /Final Answer: \[Letter\]/);
});

test("runBenchmark prefers explicit final MCQ answers over broad answer labels", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-mcq-final-priority-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter({
    async respond() {
      return {
        text: "My answer: After checking the memory, my final answer is B.",
        tokens: { input: 10, output: 10 },
        latencyMs: 3,
        model: "fake-responder",
      };
    },
  });
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
      ],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
        "incorrect_answers",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'Which tea do I usually drink while journaling?'}",
        "Earl Grey",
        JSON.stringify(["peppermint", "zebra"]),
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    seed: 0,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.details?.correctMcqOption, "B");
  assert.equal(task.details?.predictedMcqOption, "B");
  assert.equal(task.scores.mcq_accuracy, 1);
});

test("runBenchmark retrieves implicit personamem preferences from visible chat history", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-implicit-pref-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) =>
        query.includes("personal preference")
        && message.content.includes("persona preference")
        && message.content.includes("aisle seats"),
      )
      .map((message) => message.content)
      .join("\n");
  };
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [
        {
          role: "user",
          content: "I usually pick aisle seats on flights because I like easy exits.",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      ["persona_id", "chat_history_32k_link", "user_query", "correct_answer"],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'Which seat should you pick for my flight?'}",
        "aisle seats",
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.actual), /aisle seats/);
  assert.doesNotMatch(String(task.actual), /PersonaMem visible anchors/);
  assert.match(adapter.recallCalls[0]?.query ?? "", /personal preference/);
  assert.doesNotMatch(adapter.recallCalls[0]?.query ?? "", /Visible PersonaMem recall cues/);
  assert.doesNotMatch(adapter.searchCalls[0]?.query ?? "", /personal preference|persona preference/);
});

test("runBenchmark retrieves topic-specific personamem preferences", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-topic-pref-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) =>
        /headphone/i.test(query)
        && message.content.includes("headphones")
        && message.content.includes("warm sound"),
      )
      .map((message) => message.content)
      .join("\n");
  };
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [
        { role: "user", content: "For headphones I like a warm sound with soft treble." },
        { role: "user", content: "Desk speakers in my office use neutral tuning." },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
        "topic_query",
        "preference",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'What headphone sound should you recommend for me?'}",
        "warm sound",
        "hidden headphone topic",
        "hidden warm answer label",
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  const storedMessages = adapter.sessions.get("personamem-persona-1") ?? [];
  assert.match(String(task.actual), /warm sound/);
  assert.doesNotMatch(String(task.actual), /neutral tuning/);
  assert.doesNotMatch(adapter.recallCalls[0]?.query ?? "", /hidden headphone topic|hidden warm answer label/);
  assert.doesNotMatch(storedMessages[1]?.content ?? "", /PersonaMem visible anchors|turn 1/);
});

test("runBenchmark retrieves latest personamem preference updates", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-updated-pref-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async (sessionId, query) => {
    adapter.recallCalls.push({ sessionId, query });
    const messages = adapter.sessions.get(sessionId) ?? [];
    const latest = [...messages]
      .reverse()
      .find((message) => message.content.includes("latest preference"));
    return /latest preference|current preference/i.test(query) && latest
      ? [
          `[personamem-persona-1, turn 1]: ${latest.content.replaceAll("\n", "\n[personamem-persona-1, turn 1]: ")}`,
          "",
          "[personamem-persona-1, note]: Follow-up paragraph.",
        ].join("\n")
      : messages.map((message) => message.content).join("\n");
  };
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });
  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [
        { role: "user", content: "I used to prefer coffee for morning writing." },
        { role: "user", content: "I switched drinks; now I prefer Earl Grey for morning writing." },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
        "related_conversation_snippet",
        "updated",
        "prev_pref",
      ],
      [
        "persona-1",
        "data/chat_history_32k/persona-1.json",
        "{'role': 'user', 'content': 'Which drink do I prefer now for morning writing?'}",
        "Earl Grey",
        "hidden related snippet says Earl Grey",
        "hidden updated timestamp",
        "hidden old coffee preference",
      ],
    ),
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  const storedMessages = adapter.sessions.get("personamem-persona-1") ?? [];
  assert.match(String(task.actual), /Earl Grey/);
  assert.doesNotMatch(String(task.actual), /coffee/);
  assert.doesNotMatch(String(task.actual), /PersonaMem visible anchors/);
  assert.match(String(task.details?.recalledText), /\n\n\[personamem-persona-1, note\]/);
  assert.doesNotMatch(storedMessages[0]?.content ?? "", /latest preference|current preference|updated preference/);
  assert.doesNotMatch(
    adapter.recallCalls[0]?.query ?? "",
    /hidden related snippet|hidden updated timestamp|hidden old coffee preference/,
  );
  assert.equal(task.details?.updated, "hidden updated timestamp");
  assert.equal(task.details?.prevPref, "hidden old coffee preference");
});

test("runBenchmark rejects personamem full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        system: adapter,
      }),
    /PersonaMem-v2 full mode requires datasetDir/,
  );
});

test("runBenchmark rejects personamem chat history links that escape the dataset root", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-escape-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const outsideDir = path.join(tmpDir, "outside");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(
    path.join(outsideDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [{ role: "user", content: "I prefer oolong tea." }],
    }),
    "utf8",
  );

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    toCsv(
      [
        "persona_id",
        "chat_history_32k_link",
        "user_query",
        "correct_answer",
      ],
      [
        "persona-1",
        "../../outside/persona-1.json",
        "{'role': 'user', 'content': 'Which tea do I prefer?'}",
        "oolong tea",
      ],
    ),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must stay within datasetDir/,
  );
});

test("runBenchmark honors personamem limit before parsing later CSV rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-limit-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const chatHistoryDir = path.join(datasetDir, "data", "chat_history_32k");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });
  await mkdir(chatHistoryDir, { recursive: true });

  await writeFile(
    path.join(chatHistoryDir, "persona-1.json"),
    JSON.stringify({
      chat_history: [{ role: "user", content: "I always order Earl Grey tea." }],
    }),
    "utf8",
  );

  const headers = [
    "persona_id",
    "chat_history_32k_link",
    "user_query",
    "correct_answer",
  ];
  const validRow = [
    "persona-1",
    "data/chat_history_32k/persona-1.json",
    "{'role': 'user', 'content': 'Which tea do I order?'}",
    "Earl Grey tea",
  ];
  const invalidRow = [
    "",
    "data/chat_history_32k/persona-1.json",
    "{'role': 'user', 'content': 'Which tea do I order?'}",
    "Earl Grey tea",
  ];

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    `${headers.join(",")}\n${validRow.map(escapeCsvField).join(",")}\n${invalidRow.map(escapeCsvField).join(",")}\n`,
    "utf8",
  );

  const result = await runBenchmark("personamem", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Earl Grey tea");
});

test("runBenchmark preserves original CSV row numbers after blank personamem rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-personamem-rows-"));
  const datasetDir = path.join(tmpDir, "datasets", "personamem");
  const benchmarkDir = path.join(datasetDir, "benchmark", "text");
  const adapter = new FakeMemoryAdapter();
  await mkdir(benchmarkDir, { recursive: true });

  await writeFile(
    path.join(benchmarkDir, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,correct_answer",
      "",
      ",data/chat_history_32k/persona-1.json,\"{'role': 'user', 'content': 'Which tea do I order?'}\",Earl Grey tea",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("personamem", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /row 3 is missing persona_id/,
  );
});
