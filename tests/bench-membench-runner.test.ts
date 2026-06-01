import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchResponder,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  responder?: BenchResponder;

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
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
    const queryTerms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        const content = message.content.toLowerCase();
        if (
          content.includes(query.toLowerCase())
          || queryTerms.some((term) => content.includes(term))
        ) {
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

function createDatasetCases() {
  return [
    {
      id: "membench-dataset-1",
      memoryType: "factual",
      scenario: "participant",
      level: "surface",
      turns: [
        {
          role: "user",
          content: "I moved to Lisbon last spring to work from the waterfront.",
        },
        {
          role: "assistant",
          content: "Lisbon by the waterfront, noted.",
        },
      ],
      question: "Which city did I move to last spring?",
      answer: "Lisbon",
      targetStepIds: [[0, 0]],
      targetStepCoordinates: [[0, 0]],
    },
  ];
}

function createNestedPublishedDataset() {
  return {
    conflict_patterns: [
      {
        trajectory: [
          {
            speaker: "Avery",
            text: "I moved to Porto last year to be closer to the river walk.",
          },
          {
            speaker: "Morgan",
            text: "Porto by the river walk. I'll remember that.",
          },
        ],
        qa: [
          {
            question: "Which city did Avery move to last year?",
            answer: "Porto",
          },
        ],
      },
    ],
  };
}

function createOfficialChoiceDataset() {
  return {
    factual: {
      ThirdAgentDataLowLevel: [
        {
          message_list: [
            "Avery moved to Porto last year to be closer to the river walk.",
            "Avery now lives in Porto near the river walk.",
          ],
          QA: {
            id: "official-mcq-1",
            question: "Which city did Avery move to last year?",
            time: "2026-04-01",
            choices: {
              A: "Lisbon",
              B: "Porto",
              C: "Madrid",
              D: "Seville",
            },
            answer: "B",
            target_step_id: "0",
          },
        },
      ],
    },
  };
}

function createOfficialParticipantDataset() {
  return {
    preference: {
      FirstAgentDataHighLevel: [
        {
          message_list: [
            [
              {
                user: "I liked Toy Story when we discussed lighter animation.",
                agent: "Toy Story is a lighter animation preference.",
              },
            ],
            [
              {
                user: "I loved Alien (1979), especially the practical tension.",
                agent: "Alien (1979) fits your taste for tense sci-fi.",
              },
            ],
          ],
          QA: {
            question: "Which movie preference should the assistant remember?",
            choices: ["Toy Story", "Alien (1979)", "Heat", "Jaws"],
            answer: "Alien (1979)",
            target_step_coordinates: [[1, 0], [1, 0, 1]],
          },
        },
      ],
    },
  };
}

function createOfficialPairedCoordinateDataset() {
  return {
    factual: {
      FirstAgentDataLowLevel: [
        {
          message_list: [
            [
              {
                user: "I chose the blue mug for my desk.",
                agent: "The blue mug choice is saved.",
              },
              {
                user: "I chose the green notebook for travel.",
                agent: "The green notebook choice is saved.",
              },
            ],
          ],
          QA: [
            {
              question: "Which item did the assistant acknowledge first?",
              choices: ["red pen", "blue mug", "black bag", "white lamp"],
              answer: "B",
              target_step_id: " ",
              target_step_coordinate: [0, 0, 1],
            },
            {
              question: "Which item did I choose second?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_id: "not-a-number",
              target_step_coordinates: [[0, 0, 1], [0, 1]],
            },
            {
              question: "Which item did I choose second when using tuple ids?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_id: [0, 1],
            },
            {
              question: "Which target ids should remain scalar ids?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_id: [3, 7],
            },
            {
              question: "Which one-item target id array should remain scalar?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_id: [3],
            },
            {
              question: "Which invalid coordinate should not be remapped?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_coordinate: [0, 99],
            },
            {
              question: "Which malformed coordinate should fail closed?",
              choices: ["blue mug", "green notebook", "yellow folder", "silver watch"],
              answer: "B",
              target_step_coordinate: [0, null],
            },
            {
              question: "Which partial id array should use coordinates?",
              choices: ["red pen", "blue mug", "black bag", "white lamp"],
              answer: "B",
              target_step_id: [0, null],
              target_step_coordinates: [[0, 0, 1]],
            },
            {
              question: "Which scalar coordinate should fail closed?",
              choices: ["red pen", "blue mug", "black bag", "white lamp"],
              answer: "B",
              target_step_coordinate: "0",
            },
          ],
        },
      ],
    },
  };
}

function createMixedFlatNestedCoordinateDataset() {
  return {
    factual: {
      ThirdAgentDataLowLevel: [
        {
          message_list: [
            [
              "Avery booked the first train to Porto.",
              "Avery booked the second train to Lisbon.",
            ],
            "Avery later reserved a ferry to Seville.",
          ],
          QA: {
            question: "Which second train did Avery book?",
            choices: ["Madrid", "Lisbon", "Porto", "Seville"],
            answer: "B",
            target_step_coordinate: [0, 1],
          },
        },
      ],
    },
  };
}

function createLetterAnswerNonChoiceDataset() {
  return [
    {
      id: "letter-answer-no-choices",
      memoryType: "factual",
      scenario: "participant",
      level: "surface",
      turns: [
        {
          role: "user",
          content: "A",
        },
      ],
      question: "What single-letter code did I give?",
      answer: "A",
    },
  ];
}

function createFlatChoiceOnlyDataset() {
  return [
    {
      id: "flat-choice-only",
      memoryType: "factual",
      scenario: "observation",
      level: "low_level",
      turns: [
        {
          role: "user",
          content: "Avery now lives in Porto near the river walk.",
        },
      ],
      question: "Where does Avery live?",
      choices: {
        A: "Lisbon",
        B: "Porto",
        C: "Madrid",
        D: "Seville",
      },
      correctChoice: "B",
      targetStepIds: [0],
    },
  ];
}

function createStepCueDataset() {
  return [
    {
      id: "step-cue-separation",
      memoryType: "factual",
      scenario: "participant",
      level: "low_level",
      turns: [
        {
          role: "user",
          content: "The first item was the blue mug.",
        },
        {
          role: "assistant",
          content: "The blue mug is saved.",
        },
        {
          role: "user",
          content: "The later item was the green notebook.",
        },
      ],
      question: "What item appears at step 2?",
      answer: "green notebook",
      targetStepIds: [0],
    },
  ];
}

function createTimeCueDataset() {
  return [
    {
      id: "time-cue-observation",
      memoryType: "factual",
      scenario: "observation",
      level: "low_level",
      turns: [
        {
          role: "user",
          content: "On 2026-04-02, Avery confirmed the lapis sample.",
        },
        {
          role: "user",
          content: "On 2026-04-03, Avery confirmed the quartz sample.",
        },
      ],
      question: "At the current time, what package did Avery confirm?",
      answer: "quartz sample",
      questionTime: "2026-04-03",
    },
  ];
}

test("runBenchmark executes membench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("membench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "membench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.actual.includes("Lisbon"), true);
  assert.equal(result.results.tasks[0]?.details.memoryType, "factual");
  assert.equal(result.results.tasks[1]?.details.memoryType, "reflective");
});

test("runBenchmark executes membench in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createDatasetCases()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.details.scenario, "participant");
  assert.deepEqual(result.results.tasks[0]?.details.targetStepCoordinates, [[0, 0]]);
  assert.deepEqual(result.results.tasks[0]?.details.targetStepIds, [0]);
});

test("runBenchmark accepts upstream MemBench export filenames in full mode", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-upstream-name-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "FirstAgentDataLowLevel.json"),
    JSON.stringify(createDatasetCases()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.details.memoryType, "factual");
  assert.equal(result.results.tasks[0]?.details.scenario, "participant");
});

test("runBenchmark rejects partial MemBench datasets when a recognized shard fails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-partial-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();

  try {
    await mkdir(datasetDir, { recursive: true });
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify(createDatasetCases()),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "FirstAgentDataHighLevel.jsonl"),
      "{not json}\n",
      "utf8",
    );

    await assert.rejects(
      () =>
        runBenchmark("membench", {
          mode: "full",
          datasetDir,
          system: adapter,
        }),
      /MemBench dataset under .* has invalid recognized shard\(s\).*FirstAgentDataHighLevel\.jsonl/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("runBenchmark validates later recognized shards after the limit is reached", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-limited-partial-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();

  try {
    await mkdir(datasetDir, { recursive: true });
    await writeFile(
      path.join(datasetDir, "membench.json"),
      JSON.stringify(createDatasetCases()),
      "utf8",
    );
    await writeFile(
      path.join(datasetDir, "ThirdAgentDataHighLevel.jsonl"),
      "{not json}\n",
      "utf8",
    );

    await assert.rejects(
      () =>
        runBenchmark("membench", {
          mode: "full",
          datasetDir,
          limit: 1,
          system: adapter,
        }),
      /MemBench dataset under .* has invalid recognized shard\(s\).*ThirdAgentDataHighLevel\.jsonl/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("runBenchmark normalizes nested published MemBench trajectory and qa structures", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-nested-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataHighLevel.json"),
    JSON.stringify(createNestedPublishedDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Porto");
  assert.equal(result.results.tasks[0]?.question, "Which city did Avery move to last year?");
  assert.equal(result.results.tasks[0]?.details.memoryType, "reflective");
  assert.equal(result.results.tasks[0]?.details.scenario, "observation");
});

test("runBenchmark scores official MemBench multiple-choice accuracy and recall", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-mcq-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  let recallQuery = "";
  adapter.recall = async (sessionId, query) => {
    recallQuery = query;
    return (adapter.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  };
  adapter.search = async (_query, _limit, sessionId) => [
    {
      turnIndex: 0,
      role: "user",
      snippet: "Avery moved to Porto last year to be closer to the river walk.",
      sessionId,
      score: 1,
    },
  ];
  adapter.responder = {
    async respond() {
      return {
        text: "Option A is plausible, but the final answer is B.",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createOfficialChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.actual, "B");
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(task.scores.membench_recall_at_10, 1);
  assert.match(recallQuery, /2026-04-01/);
  assert.equal(task.details?.correctAnswer, "Porto");
  assert.equal(task.details?.officialProtocol, "multiple_choice_accuracy");
  assert.equal(result.results.aggregates.membench_accuracy?.mean, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_observation?.mean,
    1,
  );
});

test("runBenchmark retrieves query-visible MemBench step cues without target id leakage", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-step-cue-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  const recallQueries: string[] = [];
  const searchQueries: string[] = [];
  adapter.recall = async (sessionId, query) => {
    recallQueries.push(query);
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) =>
        message.content.includes("step 2")
        || message.content.includes("step_id=2"),
      )
      .map((message) => message.content)
      .join("\n");
  };
  adapter.search = async (query, _limit, sessionId) => {
    searchQueries.push(query);
    return [
      {
        turnIndex: 2,
        role: "user",
        snippet: "The later item was the green notebook.",
        sessionId,
        score: 1,
      },
    ];
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createStepCueDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.details?.scenario, "participant");
  assert.equal(task.scores.contains_answer, 1);
  assert.equal(task.scores.membench_recall_at_10, 0);
  assert.match(String(task.actual), /green notebook/);
  assert.doesNotMatch(recallQueries.join("\n"), /target/i);
  assert.doesNotMatch(searchQueries.join("\n"), /target/i);
  assert.deepEqual(task.details?.targetStepIds, [0]);
});

test("runBenchmark retrieves query-visible MemBench time cues for observation cases", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-time-cue-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  let recallQuery = "";
  adapter.recall = async (sessionId, query) => {
    recallQuery = query;
    return (adapter.sessions.get(sessionId) ?? [])
      .filter((message) => message.content.includes("2026-04-03"))
      .map((message) => message.content)
      .join("\n");
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createTimeCueDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.details?.scenario, "observation");
  assert.equal(task.details?.questionTime, "2026-04-03");
  assert.match(recallQuery, /2026-04-03/);
  assert.match(String(task.actual), /quartz sample/);
  assert.doesNotMatch(String(task.actual), /lapis sample/);
  assert.equal(task.scores.contains_answer, 1);
});

test("runBenchmark accepts official first-agent message_list and QA records", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-first-agent-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "FirstAgentDataHighLevel.json"),
    JSON.stringify(createOfficialParticipantDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.actual, "B");
  assert.equal(task.details?.memoryType, "reflective");
  assert.equal(task.details?.scenario, "participant");
  assert.equal(task.details?.turnCount, 4);
  assert.deepEqual(task.details?.targetStepCoordinates, [[1, 0], [1, 0, 1]]);
  assert.deepEqual(task.details?.targetStepIds, [2, 3]);
  assert.equal(task.scores.membench_accuracy, 1);
  assert.equal(
    result.results.aggregates.membench_accuracy_reflective_participant?.mean,
    1,
  );
});

test("runBenchmark maps singular and paired MemBench coordinate tuples without collisions", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-paired-coords-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.search = async (_query, _limit, sessionId) => [
    {
      turnIndex: 1,
      role: "assistant",
      snippet: "The blue mug choice is saved.",
      sessionId,
      score: 1,
    },
  ];
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "FirstAgentDataLowLevel.json"),
    JSON.stringify(createOfficialPairedCoordinateDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 9);
  assert.deepEqual(result.results.tasks[0]?.details?.targetStepCoordinates, [[0, 0, 1]]);
  assert.deepEqual(result.results.tasks[0]?.details?.targetStepIds, [1]);
  assert.equal(result.results.tasks[0]?.scores.membench_recall_at_10, 1);
  assert.deepEqual(result.results.tasks[1]?.details?.targetStepCoordinates, [[0, 0, 1], [0, 1]]);
  assert.deepEqual(result.results.tasks[1]?.details?.targetStepIds, [1, 2]);
  assert.equal(result.results.tasks[1]?.scores.membench_recall_at_10, 0.5);
  assert.deepEqual(result.results.tasks[2]?.details?.targetStepCoordinates, [[0, 1]]);
  assert.deepEqual(result.results.tasks[2]?.details?.targetStepIds, [2]);
  assert.equal(result.results.tasks[2]?.scores.membench_recall_at_10, 0);
  assert.deepEqual(result.results.tasks[3]?.details?.targetStepIds, [3, 7]);
  assert.deepEqual(result.results.tasks[4]?.details?.targetStepIds, [3]);
  assert.deepEqual(result.results.tasks[5]?.details?.targetStepCoordinates, [[0, 99]]);
  assert.equal(result.results.tasks[5]?.details?.targetStepIds, undefined);
  assert.equal(result.results.tasks[5]?.scores.membench_recall_at_10, undefined);
  assert.equal(result.results.tasks[6]?.details?.targetStepCoordinates, undefined);
  assert.equal(result.results.tasks[6]?.details?.targetStepIds, undefined);
  assert.equal(result.results.tasks[6]?.scores.membench_recall_at_10, undefined);
  assert.deepEqual(result.results.tasks[7]?.details?.targetStepCoordinates, [[0, 0, 1]]);
  assert.deepEqual(result.results.tasks[7]?.details?.targetStepIds, [1]);
  assert.equal(result.results.tasks[8]?.details?.targetStepCoordinates, undefined);
  assert.equal(result.results.tasks[8]?.details?.targetStepIds, undefined);
});

test("runBenchmark accepts flat MCQ cases with choices and correctChoice only", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-flat-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createFlatChoiceOnlyDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.details?.correctAnswer, "Porto");
  assert.equal(task.scores.membench_accuracy, 1);
});

test("runBenchmark keeps flat aliases from overwriting nested MemBench coordinates", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-mixed-coords-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createMixedFlatNestedCoordinateDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.deepEqual(task.details?.targetStepCoordinates, [[0, 1]]);
  assert.deepEqual(task.details?.targetStepIds, [1]);
});

test("runBenchmark surfaces MemBench recall@10 search failures", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-search-error-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.search = async () => {
    throw new Error("search offline");
  };
  adapter.responder = {
    async respond() {
      return {
        text: "B",
        tokens: { input: 3, output: 1 },
        latencyMs: 2,
        model: "fake-choice-model",
      };
    },
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createOfficialChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.scores.membench_recall_at_10, -1);
  assert.equal(result.results.aggregates.membench_recall_at_10?.mean, -1);
});

test("runBenchmark includes official MemBench failure sentinels on task errors", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-task-error-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  adapter.recall = async () => {
    throw new Error("recall offline");
  };
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createOfficialChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.scores.membench_accuracy, -1);
  assert.equal(task.scores.membench_recall_at_10, -1);
  assert.equal(task.details?.memoryType, "factual");
  assert.equal(task.details?.scenario, "observation");
  assert.equal(result.results.aggregates.membench_accuracy?.mean, -1);
  assert.equal(result.results.aggregates.membench_recall_at_10?.mean, -1);
  assert.equal(
    result.results.aggregates.membench_accuracy_factual_observation,
    undefined,
  );
  assert.equal(
    result.results.aggregates.membench_error_rate_factual_observation?.mean,
    1,
  );
});

test("runBenchmark infers MCQ choices from recalled text without a responder", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-no-responder-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "ThirdAgentDataLowLevel.json"),
    JSON.stringify(createOfficialChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "B");
  assert.equal(task.actual, "B");
  assert.equal(task.scores.membench_accuracy, 1);
});

test("runBenchmark treats bare letter answers as exact-answer cases when choices are absent", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-letter-answer-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createLetterAnswerNonChoiceDataset()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.expected, "A");
  assert.equal(task.actual, "A");
  assert.equal(task.details?.correctChoice, undefined);
  assert.equal(task.details?.officialProtocol, "exact_answer_accuracy");
  assert.equal(task.scores.membench_accuracy, 1);
});

test("runBenchmark rejects membench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "full",
        system: adapter,
      }),
    /MemBench full mode requires datasetDir/,
  );
});

test("runBenchmark treats membench limit zero as an empty run instead of falling back to all cases", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemBench dataset is empty after applying the requested limit/,
  );
});
