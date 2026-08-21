import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchResponder,
  BenchResponse,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";
import type { AMemGymProfile } from "../packages/bench/src/benchmarks/published/amemgym/fixture.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  responder?: BenchResponder;

  constructor(responder?: BenchResponder) {
    this.responder = responder;
  }

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]> {
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

class FixedResponder implements BenchResponder {
  constructor(private readonly text: string) {}

  async respond(): Promise<BenchResponse> {
    return {
      text: this.text,
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
      model: "fixed",
    };
  }
}

class FailingRecallAdapter extends FakeMemoryAdapter {
  async recall(): Promise<string> {
    throw new Error("forced recall failure");
  }
}

function createDatasetProfile(): AMemGymProfile[] {
  return [
    {
      id: "dataset-profile-1",
      start_time: "2025-02-01T00:00:00Z",
      user_profile: {
        uuid: "dataset-user-1",
        name: "Jordan",
        age: 34,
        gender: "nonbinary",
      },
      state_schema: {
        city: { type: "string" },
      },
      periods: [
        {
          period_start: "2025-02-01T00:00:00Z",
          period_end: "2025-02-28T23:59:59Z",
          period_summary: "Jordan moved cities.",
          sessions: [
            {
              event: "Jordan moved to Seattle.",
              exposed_states: { city: "Seattle" },
              query: "I live in Seattle now after the move.",
              messages: [],
              session_time: "2025-02-12T08:00:00Z",
            },
          ],
          state: { city: "Seattle" },
          updates: { city: "Seattle" },
          update_cnts: { city: 1 },
        },
      ],
      qas: [
        {
          query: "Where does Jordan live now?",
          required_info: ["city"],
          answer_choices: [
            { state: ["Seattle"], answer: "Seattle" },
            { state: ["Denver"], answer: "Denver" },
          ],
        },
      ],
    },
  ];
}

function createUpdatedStateDatasetProfile() {
  return [
    {
      id: "dataset-profile-updates",
      start_time: "2025-02-01T00:00:00Z",
      user_profile: {
        uuid: "dataset-user-updates",
        name: "Jordan",
        age: 34,
        gender: "nonbinary",
      },
      state_schema: {
        city: { type: "string" },
      },
      periods: [
        {
          period_start: "2025-02-01T00:00:00Z",
          period_end: "2025-02-28T23:59:59Z",
          period_summary: "Jordan lived in Austin.",
          sessions: [
            {
              event: "Jordan moved to Austin.",
              exposed_states: { city: "Austin" },
              query: "I live in Austin now.",
              messages: [],
              session_time: "2025-02-12T08:00:00Z",
            },
          ],
          state: { city: "Austin" },
          updates: { city: "Austin" },
          update_cnts: { city: 1 },
        },
        {
          period_start: "2025-03-01T00:00:00Z",
          period_end: "2025-03-31T23:59:59Z",
          period_summary: "Jordan moved again.",
          sessions: [
            {
              event: "Jordan moved to Denver.",
              exposed_states: { city: "Denver" },
              query: "I moved again and live in Denver now.",
              messages: [
                {
                  role: "assistant",
                  content: "I will remember Denver as the current city.",
                },
              ],
              session_time: "2025-03-12T08:00:00Z",
            },
          ],
          state: { city: "Denver" },
          updates: { city: "Denver" },
          update_cnts: { city: 1 },
        },
      ],
      qas: [
        {
          query: "What city does Jordan live in now?",
          required_info: ["city"],
          answer_choices: [
            { state: ["Austin"], answer: "Austin" },
            { state: ["Denver"], answer: "Denver" },
          ],
        },
      ],
    },
  ];
}

test("runBenchmark executes amemgym in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("amemgym", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "amemgym");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Chicago");
  assert.equal(result.results.tasks[1]?.expected, "trail mix");
  assert.equal(result.results.tasks[1]?.actual.includes("trail mix"), true);
});

test("runBenchmark executes amemgym in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Seattle");
  const stored = adapter.sessions.get("amemgym-dataset-profile-1") ?? [];
  assert.match(
    stored.map((message) => message.content).join("\n"),
    /\[User state update\]: city: Seattle/,
  );
});

test("runBenchmark ingests repeated AMemGym state updates without final-state injection", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-updates-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createUpdatedStateDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "Denver");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.expectedChoiceIndex, 2);

  const storedText = (adapter.sessions.get("amemgym-dataset-profile-updates") ?? [])
    .map((message) => message.content)
    .join("\n");
  assert.match(storedText, /\[User state update\]: city: Austin/);
  assert.match(storedText, /\[User state update\]: city: Denver/);
  assert.doesNotMatch(storedText, /Answer choices:/);
});

test("runBenchmark scores amemgym using the benchmark multiple-choice protocol", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(task.question, /Answer choices:/);
  assert.equal(task.actual, "1");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.scores.contains_answer, 1);
  assert.equal(task.details?.expectedChoiceIndex, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.selectedAnswer, "Seattle");
  assert.equal(task.details?.scoredAnswer, "Seattle");
  assert.equal(typeof result.results.aggregates.qa_accuracy?.mean, "number");
});

test("runBenchmark accepts labeled amemgym option-number answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: (1) because Seattle is current."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
});

test("runBenchmark accepts amemgym answers labeled with is and a colon", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-is-colon-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer is: 1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts amemgym answers labeled as answer is option", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-answer-option-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("The answer is option 1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts amemgym answers labeled as correct answer is option", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-correct-answer-option-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("The correct answer is option 1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts colon-labeled amemgym option-number answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-colon-option-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: option 1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts parenthesized amemgym option-number answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-parenthesized-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("(1)"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "(1)");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
});

test("runBenchmark accepts option numbers followed by parenthesized amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-parenthetical-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 (Seattle)"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 (Seattle)");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts labeled option numbers followed by parenthesized amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-choice-parenthetical-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Option 1 (Seattle)"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Option 1 (Seattle)");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts option numbers with closing-paren amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-closing-paren-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1) Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1) Seattle");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts labeled option numbers with closing-paren amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-choice-closing-paren-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Option 1) Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Option 1) Seattle");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts option numbers followed by plain amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-plain-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 Seattle");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts labeled option numbers followed by plain amemgym text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-choice-plain-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Option 1 Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "Option 1 Seattle");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts hash numerals inside amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-hash-choice-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.route = { type: "string" };
  profile[0]!.periods[0]!.state.route = "Route #66";
  profile[0]!.periods[0]!.updates.route = "Route #66";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.route = "Route #66";
  profile[0]!.qas[0]!.required_info = ["route"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["Route #66"], answer: "Route #66" },
    { state: ["Route #20"], answer: "Route #20" },
  ];
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 Route #66"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 Route #66");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Route #66");
});

test("runBenchmark accepts numeric alternatives inside exact amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-or-number-choice-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.duration = { type: "string" };
  profile[0]!.periods[0]!.state.duration = "1 or 2 years";
  profile[0]!.periods[0]!.updates.duration = "1 or 2 years";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.duration = "1 or 2 years";
  profile[0]!.qas[0]!.required_info = ["duration"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["1 or 2 years"], answer: "1 or 2 years" },
    { state: ["3 years"], answer: "3 years" },
  ];
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 1 or 2 years"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 1 or 2 years");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "1 or 2 years");
});

test("runBenchmark accepts numeric-leading exact amemgym text answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-numeric-leading-exact-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.duration = { type: "string" };
  profile[0]!.periods[0]!.state.duration = "1 or 2 years";
  profile[0]!.periods[0]!.updates.duration = "1 or 2 years";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.duration = "1 or 2 years";
  profile[0]!.qas[0]!.required_info = ["duration"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["1 or 2 years"], answer: "1 or 2 years" },
    { state: ["3 years"], answer: "3 years" },
  ];
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 or 2 years"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "1 or 2 years");
});

test("runBenchmark accepts numeric alternatives inside extended amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-extended-or-number-choice-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.duration = { type: "string" };
  profile[0]!.periods[0]!.state.duration = "1 or 2 years";
  profile[0]!.periods[0]!.updates.duration = "1 or 2 years";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.duration = "1 or 2 years";
  profile[0]!.qas[0]!.required_info = ["duration"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["1 or 2 years"], answer: "1 or 2 years" },
    { state: ["3 years"], answer: "3 years" },
  ];
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("1 1 or 2 years depending on visa timing"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 1 or 2 years depending on visa timing");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "1 or 2 years");
});

test("runBenchmark accepts numeric alternatives inside qualified amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-qualified-or-number-choice-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.duration = { type: "string" };
  profile[0]!.periods[0]!.state.duration = "1 or 2 years";
  profile[0]!.periods[0]!.updates.duration = "1 or 2 years";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.duration = "1 or 2 years";
  profile[0]!.qas[0]!.required_info = ["duration"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["1 or 2 years"], answer: "1 or 2 years" },
    { state: ["3 years"], answer: "3 years" },
  ];
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("1 about 1 or 2 years depending on visa"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 about 1 or 2 years depending on visa");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "1 or 2 years");
});

test("runBenchmark rejects hash conflicts outside matching amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-hash-choice-with-conflict-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.route = { type: "string" };
  profile[0]!.periods[0]!.state.route = "Route #66";
  profile[0]!.periods[0]!.updates.route = "Route #66";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.route = "Route #66";
  profile[0]!.qas[0]!.required_info = ["route"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["Route #66"], answer: "Route #66" },
    { state: ["Route #20"], answer: "Route #20" },
  ];
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 Route #66 because #2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 Route #66 because #2");
});

test("runBenchmark accepts punctuation variants of hash-bearing amemgym option text", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-hash-punctuation-variant-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const profile = createDatasetProfile();
  profile[0]!.state_schema.route = { type: "string" };
  profile[0]!.periods[0]!.state.route = "Route #66 eastbound";
  profile[0]!.periods[0]!.updates.route = "Route #66 eastbound";
  profile[0]!.periods[0]!.sessions[0]!.exposed_states.route = "Route #66 eastbound";
  profile[0]!.qas[0]!.required_info = ["route"];
  profile[0]!.qas[0]!.answer_choices = [
    { state: ["Route #66 eastbound"], answer: "Route #66 eastbound" },
    { state: ["Route #20 westbound"], answer: "Route #20 westbound" },
  ];
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("1 Route#66 eastbound quickly"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(profile),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Route #66 eastbound");
});

test("runBenchmark rejects plain amemgym option text that mentions another option", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-plain-conflicting-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 Seattle or 2 Dallas"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 Seattle or 2 Dallas");
});

test("runBenchmark accepts plain amemgym option text with unrelated numerals", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-plain-choice-unrelated-number-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("1 Seattle, 20 minutes away"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts bare amemgym option-number answers with rationale", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-bare-rationale-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 because Seattle is current."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "1 because Seattle is current.");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
});

test("runBenchmark accepts amemgym option-number rationales with non-option numbers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-rationale-number-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1 because 2 weeks ago I moved to Seattle."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts amemgym option-number rationales that restate the same option", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-same-option-rationale-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1 because option 1 is Seattle."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark rejects amemgym option-number rationales that mention a conflicting option", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-conflicting-option-rationale-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1 because option 2 is Denver."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "Answer: 1 because option 2 is Denver.");
});

test("runBenchmark rejects amemgym option-number rationales with bare conflicting choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-bare-conflicting-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 because 2 might be right."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 because 2 might be right.");
});

test("runBenchmark rejects amemgym option-number rationales with hash conflicting choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-hash-conflicting-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 because #2 might also be right."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 because #2 might also be right.");
});

test("runBenchmark rejects amemgym option-number rationales with bare hash choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-bare-hash-conflicting-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 because #2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 because #2");
});

test("runBenchmark rejects amemgym option-number rationales with hedged conflicting choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-hedged-conflicting-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1 because maybe 2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "Answer: 1 because maybe 2");
});

test("runBenchmark accepts comma-led amemgym option-number rationales with non-option numbers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-comma-rationale-number-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1, because 2 weeks ago I moved to Seattle."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark accepts labeled amemgym text answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "Seattle");
});

test("runBenchmark does not parse leading prose numbers as amemgym choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-prose-number-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("2 weeks ago I moved to Seattle."));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.selectedAnswer, "Seattle");
});

test("runBenchmark rejects ambiguous labeled amemgym option-number answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-ambiguous-labeled-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Answer: 1 or 2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "Answer: 1 or 2");
});

test("runBenchmark rejects ambiguous bare amemgym option-number answers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-ambiguous-bare-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1, maybe 2"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1, maybe 2");
});

test("runBenchmark rejects out-of-range amemgym option numbers before text fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-out-of-range-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("3"));
  const dataset = createDatasetProfile();
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["Seattle"], answer: "3" },
    { state: ["Dallas"], answer: "4" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "3");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "3");
});

test("runBenchmark rejects out-of-range plain-text amemgym option numbers before text fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-out-of-range-plain-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("3 3 bedrooms"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "3 bedrooms";
  dataset[0]!.periods[0]!.updates.city = "3 bedrooms";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "3 bedrooms";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["3 bedrooms"], answer: "3 bedrooms" },
    { state: ["4 bedrooms"], answer: "4 bedrooms" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "3 bedrooms");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "3 3 bedrooms");
});

test("runBenchmark blocks text fallback for numeric-prefixed amemgym contradictions", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-number-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("2 Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "2 Seattle");
});

test("runBenchmark blocks text fallback for labeled numeric-prefixed amemgym contradictions", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-labeled-number-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("option 2 Seattle"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "option 2 Seattle");
});

test("runBenchmark matches numeric-prefixed amemgym text answer choices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-numeric-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("2 bedrooms"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "2 bedrooms";
  dataset[0]!.periods[0]!.updates.city = "2 bedrooms";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "2 bedrooms";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["2 bedrooms"], answer: "2 bedrooms" },
    { state: ["3 bedrooms"], answer: "3 bedrooms" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "2 bedrooms");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.scoredAnswer, "2 bedrooms");
});

test("runBenchmark rejects conflicting numeric prefixes before amemgym text fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-conflicting-numeric-text-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1 3 bedrooms"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "3 bedrooms";
  dataset[0]!.periods[0]!.updates.city = "3 bedrooms";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "3 bedrooms";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["2 bedrooms"], answer: "2 bedrooms" },
    { state: ["3 bedrooms"], answer: "3 bedrooms" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "3 bedrooms");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
  assert.equal(task.details?.scoredAnswer, "1 3 bedrooms");
});

test("runBenchmark uses token boundaries for amemgym text choice fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-boundary-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Dallas"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "LA";
  dataset[0]!.periods[0]!.updates.city = "LA";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "LA";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["LA"], answer: "LA" },
    { state: ["SF"], answer: "SF" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "LA");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
});

test("runBenchmark leaves ambiguous amemgym text choice fallbacks unselected", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-ambiguous-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Paris or Tokyo"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "Paris";
  dataset[0]!.periods[0]!.updates.city = "Paris";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "Paris";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["Paris"], answer: "Paris" },
    { state: ["Tokyo"], answer: "Tokyo" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "Paris");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
});

test("runBenchmark leaves duplicate exact amemgym answer text unselected", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-duplicate-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Seattle"));
  const dataset = createDatasetProfile();
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["Denver"], answer: "Seattle" },
    { state: ["Seattle"], answer: "Seattle" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "Seattle");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.selectedChoiceIndex, null);
});

test("runBenchmark matches exact amemgym choices before substring fallbacks", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-overlap-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Seattle Washington"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "Seattle Washington";
  dataset[0]!.periods[0]!.updates.city = "Seattle Washington";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "Seattle Washington";
  dataset[0]!.qas[0]!.answer_choices = [
    { state: ["Seattle"], answer: "Seattle" },
    { state: ["Seattle Washington"], answer: "Seattle Washington" },
  ];

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "Seattle Washington");
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.details?.expectedChoiceIndex, 2);
  assert.equal(task.details?.selectedChoiceIndex, 2);
});

test("runBenchmark scores amemgym qa_accuracy against the first-choice fallback", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-fallback-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1"));
  const dataset = createDatasetProfile();
  dataset[0]!.periods[0]!.state.city = "Portland";
  dataset[0]!.periods[0]!.updates.city = "Portland";
  dataset[0]!.periods[0]!.sessions[0]!.exposed_states.city = "Portland";

  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(dataset),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "Seattle");
  assert.equal(task.scores.qa_accuracy, 0);
  assert.equal(task.details?.expectedChoiceIndex, null);
  assert.equal(task.details?.selectedChoiceIndex, 1);
});

test("runBenchmark includes qa_accuracy in amemgym failure rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-failure-score-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FailingRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(task.question, /Answer choices:/);
  assert.equal(task.scores.qa_accuracy, -1);
  assert.equal(result.results.aggregates.qa_accuracy?.mean, -1);
});

test("runBenchmark rejects amemgym full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        system: adapter,
      }),
    /AMemGym full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when amemgym full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /AMemGym dataset not found under/,
  );
});

test("runBenchmark fails fast when amemgym full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "data.json"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMemGym dataset file data\.json is invalid:/,
  );
});

test("runBenchmark rejects empty amemgym datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    "[]",
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMemGym dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark treats amemgym limit zero as an empty run instead of falling back to all profiles", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /AMemGym dataset is empty after applying the requested limit/,
  );
});
