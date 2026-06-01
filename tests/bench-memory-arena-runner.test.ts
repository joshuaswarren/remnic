import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchJudge,
  BenchResponder,
  BenchResponse,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  responder?: BenchResponder;
  judge?: BenchJudge;

  constructor(responder?: BenchResponder, judge?: BenchJudge) {
    this.responder = responder;
    this.judge = judge;
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

class FixedJudge implements BenchJudge {
  constructor(private readonly scoreValue: number) {}

  async score(): Promise<number> {
    return this.scoreValue;
  }
}

class FailingFirstStoreAdapter extends FakeMemoryAdapter {
  private shouldFailStore = true;

  async store(sessionId: string, messages: Message[]): Promise<void> {
    if (this.shouldFailStore) {
      this.shouldFailStore = false;
      throw new Error("forced seed store failure");
    }
    await super.store(sessionId, messages);
  }
}

class FailingRecallAdapter extends FakeMemoryAdapter {
  async recall(): Promise<string> {
    throw new Error("forced recall failure");
  }
}

class FailingSeedAndRecallAdapter extends FailingFirstStoreAdapter {
  async recall(): Promise<string> {
    throw new Error("forced recall failure");
  }
}

test("runBenchmark executes memory-arena in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("memory-arena", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "memory-arena");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(
    result.results.tasks[0]?.actual.includes("Environment result: trail mix"),
    true,
  );
  assert.equal(result.results.tasks[0]?.expected, "trail mix");
});

test("runBenchmark preserves string-form memory-arena answers in full mode datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-string-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.expected, "trail mix");
});

test("runBenchmark preserves array-form memory-arena answers in full mode datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-array-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: " Group_Travel_Planner ",
      questions: ["Which museum stop should we keep in the itinerary?"],
      answers: [[{ name: "Art Institute" }, { day: "Saturday" }]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(
    result.results.tasks[0]?.expected,
    "name: Art Institute | day: Saturday",
  );
});

test("runBenchmark honors reverse WebShop avoid rules before adding compatibility support", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-webshop-avoid-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("item: Rose candle; attributes: Rose"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "webshop-products.jsonl"),
    [
      {
        asin: "AAAA000001",
        name: "Vanilla candle",
        price: "$5.00",
        attributes: ["Vanilla"],
      },
      {
        asin: "BBBB000002",
        name: "Chocolate candle",
        price: "$30.00",
        attributes: ["Chocolate"],
      },
      {
        asin: "CCCC000003",
        name: "Rose candle",
        price: "$10.00",
        attributes: ["Rose"],
      },
    ].map((record) => JSON.stringify(record)).join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: [
        "Select the starter candle.\n**Available Options:**\n- Vanilla candle",
        [
          "Vanilla pairs well with Rose or Chocolate. Chocolate avoids Vanilla.",
          "Choose the highest priced compatible option.",
          "**Available Options:**",
          "- Chocolate candle",
          "- Rose candle",
        ].join("\n"),
      ],
      answers: [
        { target_asin: "AAAA000001", attributes: ["Vanilla"] },
        { target_asin: "CCCC000003", attributes: ["Rose"] },
      ],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  const answerContext = String(task.details?.answerContext ?? "");
  assert.match(
    answerContext,
    /Best-supported option by current rules: Option 2: Rose candle/,
  );
  assert.doesNotMatch(answerContext, /support: Vanilla -> Chocolate/);
  assert.equal(task.scores.item_selection_match, 1);
});

test("runBenchmark seeds memory-arena group travel with the base traveler plan", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-base-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. I want to join Jennifer for dinner."],
      answers: [[
        {
          days: 1,
          current_city: "from Austin to Dallas",
          transportation: "Flight Number: F1, from Austin to Dallas",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "Central Stay, Dallas",
        },
      ]],
      base_person: {
        name: "Jennifer",
        query: "I am Jennifer. Plan my trip.",
        daily_plans: [
          {
            days: 1,
            current_city: "from Austin to Dallas",
            transportation: "Flight Number: F1, from Austin to Dallas",
            breakfast: "-",
            attraction: "-",
            lunch: "-",
            dinner: "Coco Bambu, Dallas",
            accommodation: "Central Stay, Dallas",
          },
        ],
      },
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(task.actual, /initial finalized plan for Jennifer/);
  assert.match(task.actual, /MemoryArena structured plan field anchors:/);
  assert.match(task.actual, /Day 1 dinner: Coco Bambu, Dallas/);
  assert.match(task.actual, /Day 1 accommodation: Central Stay, Dallas/);
  assert.match(String(task.details?.promptQuestion), /complete finalized plan/);
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
  assert.equal(task.scores.process_score, 1);
  assert.equal(task.scores.task_success_rate, 1);
});

test("runBenchmark stores completed group-travel subtasks as structured dependency evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-dependency-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: [
        "I am Jennifer. Generate my finalized plan.",
        "I am Eric. Join Jennifer for the same dinner.",
      ],
      answers: [
        [
          {
            days: 1,
            current_city: "-",
            transportation: "-",
            breakfast: "-",
            attraction: "-",
            lunch: "-",
            dinner: "Coco Bambu, Dallas",
            accommodation: "-",
          },
        ],
        [
          {
            days: 1,
            current_city: "-",
            transportation: "-",
            breakfast: "-",
            attraction: "-",
            lunch: "-",
            dinner: "Coco Bambu, Dallas",
            accommodation: "-",
          },
        ],
      ],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.details?.recalledText), /completed subtask 1/);
  assert.match(
    String(task.details?.recalledText),
    /MemoryArena structured plan field anchors:/,
  );
  assert.match(String(task.details?.recalledText), /Day 1 dinner: Coco Bambu, Dallas/);
  assert.equal(task.scores.plan_field_recall, 1);
});

test("runBenchmark treats null memory-arena base traveler plans as absent", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-null-base-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Which dinner should I share with Jennifer?"],
      answers: ["Coco Bambu, Dallas"],
      base_person: {
        name: "Jennifer",
        query: "I am Jennifer. Plan my trip.",
        daily_plans: null,
      },
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(task.actual, /initial finalized plan for Jennifer/);
  assert.match(task.actual, /Base traveler request: I am Jennifer/);
  assert.doesNotMatch(task.actual, /Environment result:/);
});

test("runBenchmark treats null memory-arena base_person as absent metadata", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-null-base-person-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(new FixedResponder("trail mix"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
      base_person: null,
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual, "trail mix");
  assert.equal(task.scores.contains_answer, 1);
});

test("runBenchmark keeps memory-arena base traveler seed failures task-local", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-seed-failure-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FailingFirstStoreAdapter(new FixedResponder("Coco Bambu, Dallas"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Which dinner should I share with Jennifer?"],
      answers: ["Coco Bambu, Dallas"],
      base_person: {
        name: "Jennifer",
        query: "I am Jennifer. Plan my trip.",
        daily_plans: [{ dinner: "Coco Bambu, Dallas" }],
      },
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(
    String(task.actual),
    /MemoryArena prerequisite failed before group_travel_planner-t1-q0/,
  );
  assert.match(String(task.details?.initialSeedError), /forced seed store failure/);
});

test("runBenchmark ignores base traveler seeds outside group-travel tasks", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-non-group-base-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(new FixedResponder("trail mix"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
      base_person: {
        name: "Jennifer",
        query: "I am Jennifer. Plan my trip.",
        daily_plans: [{ dinner: "Coco Bambu, Dallas" }],
      },
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.actual, "trail mix");
  assert.equal(
    [...adapter.sessions.values()].some((messages) =>
      messages.some((message) => /initial finalized plan/.test(message.content)),
    ),
    false,
  );
});

test("runBenchmark applies group-travel protocol using the task category", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-category-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Transportation: Flight Number: F1\nDay 1 Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "custom_domain.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "group_travel_planner",
      questions: ["I am Eric. Generate my complete shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "Flight Number: F1",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(String(task.details?.promptQuestion), /complete finalized plan/);
  assert.doesNotMatch(String(task.details?.promptQuestion), /Return 1 day sections/);
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark keeps memory-arena partial plan recall separate from process completion", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-partial-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Transportation: Flight Number: F1"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my complete shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "Flight Number: F1",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0.5);
  assert.equal(task.scores.soft_process_score, 0);
  assert.equal(task.scores.process_score, 0);
  assert.equal(task.scores.task_success_rate, 0);
});

test("runBenchmark does not double-count overlapping memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-overlap-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Transportation: Flight Number: F1, from Austin to Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my complete shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "from Austin to Dallas",
          transportation: "Flight Number: F1, from Austin to Dallas",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0.5);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark uses boundary-aware matching for memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-boundary-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Flight Number: F10"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my complete shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "Flight Number: F1",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark includes group-travel metrics in memory-arena failure rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-failure-metrics-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FailingRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my complete shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "Flight Number: F1",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
  assert.equal(result.results.aggregates.plan_field_recall?.mean, 0);
  assert.equal(result.results.aggregates.soft_process_score?.mean, 0);
});

test("runBenchmark omits group-travel plan metrics in failure rows without plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-failure-no-plan-metrics-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FailingRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Which dinner should I choose?"],
      answers: ["Coco Bambu, Dallas"],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal("plan_field_recall" in task.scores, false);
  assert.equal("soft_process_score" in task.scores, false);
  assert.equal(result.results.aggregates.plan_field_recall, undefined);
  assert.equal(result.results.aggregates.soft_process_score, undefined);
});

test("runBenchmark counts repeated memory-arena plan fields with multiplicity", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-repeated-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Accommodation: Central Stay, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my two-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "Central Stay, Dallas",
        },
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "Central Stay, Dallas",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0.5);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark counts adjacent repeated memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-adjacent-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder(
      "Day 1 Accommodation: Central Stay, Dallas Day 2 Accommodation: Central Stay, Dallas",
    ),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my two-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "Central Stay, Dallas",
        },
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "Central Stay, Dallas",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark rejects swapped-day memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-swapped-days-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Dinner: Sushi Place. Day 2 Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my two-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Sushi Place",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark rejects same-day memory-arena plan fields under the wrong nearest label", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-swapped-fields-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Lunch: Sushi Place. Day 1 Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my one-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "Coco Bambu, Dallas",
          dinner: "Sushi Place",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark ignores prose day words when locating memory-arena day context", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-prose-day-context-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Dinner: after a mid-day activity, Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my one-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark prefers nearest weekday memory-arena context over earlier numbered day", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-weekday-nearest-context-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 2 Monday Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my Monday shared itinerary."],
      answers: [[
        {
          days: "Monday",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark normalizes string day labels for memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-string-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my one-day shared itinerary."],
      answers: [[
        {
          days: "Day 1",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark prefers explicit memory-arena day markers over weekday labels", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-day-marker-weekday-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 2 Monday Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my second-day shared itinerary."],
      answers: [[
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark prefers compact numeric memory-arena day markers over prior weekdays", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-compact-day-weekday-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Monday Day2 Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my second-day shared itinerary."],
      answers: [[
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark matches weekday memory-arena plan day headers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-weekday-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Monday\nDinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my Monday shared itinerary."],
      answers: [[
        {
          days: "Monday",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark rejects memory-arena fields under a nearer wrong weekday header", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-wrong-weekday-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Monday Dinner: Sushi Place. Tuesday Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my Monday shared itinerary."],
      answers: [[
        {
          days: "Monday",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark does not reuse unrelated numbered days as weekday alternates", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-unrelated-day-alternate-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 Lunch: Sushi Place. Tuesday Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my day-one shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark uses the nearest standalone memory-arena weekday", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-nearest-weekday-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Monday Tuesday Dinner: Coco Bambu, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my Tuesday shared itinerary."],
      answers: [[
        {
          days: "Tuesday",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark matches word-based memory-arena plan day headers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-word-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day One Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my day-one shared itinerary."],
      answers: [[
        {
          days: "Day One",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark matches multi-token memory-arena plan day headers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-multi-token-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("First Day Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my first-day shared itinerary."],
      answers: [[
        {
          days: "First Day",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark rejects incidental memory-arena day words without explicit headers", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-incidental-day-word-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("One traveler prefers seafood. Dinner: Coco Bambu, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my day-one shared itinerary."],
      answers: [[
        {
          days: "Day One",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
});

test("runBenchmark parses compact day headers for memory-arena plan fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-compact-day-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day1 Dinner: Coco Bambu, Dallas\nDay02 Accommodation: Central Stay, Dallas"),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my two-day shared itinerary."],
      answers: [[
        {
          days: "Day01",
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
        {
          days: 2,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "-",
          accommodation: "Central Stay, Dallas",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark lets a positive memory-arena judge score pass despite soft plan diagnostics", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-judge-pass-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("The plan should include Coco Bambu, Dallas."),
    new FixedJudge(1),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my one-day shared itinerary."],
      answers: [[
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "-",
        },
      ]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 0);
  assert.equal(task.scores.soft_process_score, 0);
  assert.equal(task.scores.llm_judge, 1);
  assert.equal(task.scores.process_score, 1);
  assert.equal(task.scores.task_success_rate, 1);
});

test("runBenchmark scores object-form memory-arena group-travel plans by field", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-object-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(
    new FixedResponder("Day 1 dinner is Coco Bambu, Dallas. Accommodation is Central Stay, Dallas."),
  );
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["I am Eric. Generate my one-day shared itinerary."],
      answers: [
        {
          days: 1,
          current_city: "-",
          transportation: "-",
          breakfast: "-",
          attraction: "-",
          lunch: "-",
          dinner: "Coco Bambu, Dallas",
          accommodation: "Central Stay, Dallas",
        },
      ],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.plan_field_recall, 1);
  assert.equal(task.scores.soft_process_score, 1);
});

test("runBenchmark leaves string-answer memory-arena group-travel prompts unrewritten", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-string-plan-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Coco Bambu, Dallas"));
  const question = "What dinner should Eric keep?";
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: [question],
      answers: ["Coco Bambu, Dallas"],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.details?.promptQuestion, question);
  assert.equal(task.scores.plan_field_recall, undefined);
  assert.equal(task.scores.soft_process_score, undefined);
  assert.equal(task.scores.contains_answer, 1);
});

test("runBenchmark skips empty memory-arena base-person seed data", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-empty-base-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter(new FixedResponder("Coco Bambu, Dallas"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["What dinner should Eric keep?"],
      answers: ["Coco Bambu, Dallas"],
      base_person: {
        name: "Jennifer",
        query: "",
        daily_plans: null,
      },
    })}\n`,
    "utf8",
  );

  await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const storedText = [...adapter.sessions.values()]
    .flat()
    .map((message) => message.content)
    .join("\n");
  assert.equal(storedText.includes("MemoryArena initial state"), false);
  assert.equal(storedText.includes("MemoryArena initial finalized plan"), false);
});

test("runBenchmark keeps memory-arena initial seed errors in failure rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-seed-failure-details-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FailingSeedAndRecallAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["What dinner should Eric keep?"],
      answers: ["Coco Bambu, Dallas"],
      base_person: {
        name: "Jennifer",
        query: "Jennifer wants a one-day Dallas plan.",
        daily_plans: {
          days: 1,
          dinner: "Coco Bambu, Dallas",
        },
      },
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(
    task.details?.error,
    "MemoryArena prerequisite failed before group_travel_planner-t1-q0: MemoryArena initial task state failed: forced seed store failure",
  );
  assert.equal(task.details?.initialSeedError, "forced seed store failure");
});

test("runBenchmark applies the memory-arena limit across the full benchmark, not once per domain file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-global-limit-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 2,
      category: "group_travel_planner",
      questions: ["Which museum stop should we keep in the itinerary?"],
      answers: [["Art Institute"]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "bundled_shopping-t1-q0");
});

test("runBenchmark stops reading later memory-arena domain files once the global limit is exhausted", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-stop-after-limit-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    "{not json}\n",
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "bundled_shopping-t1-q0");
});

test("runBenchmark rejects memory-arena full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        system: adapter,
      }),
    /MemoryArena full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when memory-arena full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /MemoryArena dataset not found under/,
  );
});

test("runBenchmark fails fast when memory-arena full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "bundled_shopping.jsonl"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /MemoryArena dataset file bundled_shopping\.jsonl contains invalid JSON on line 1/,
  );
});

test("runBenchmark rejects empty memory-arena datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    "",
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /MemoryArena dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark treats memory-arena limit zero as an empty run instead of falling back to all tasks", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemoryArena dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark rejects malformed memory-arena questions arrays with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-questions-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: [42],
      answers: [{ attributes: ["trail mix"] }],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include a questions array of strings/,
  );
});

test("runBenchmark rejects malformed memory-arena answers arrays with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-answers-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What snack should I pack?"],
      answers: [null],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include an answers array of strings, objects, or arrays of those values/,
  );
});

test("runBenchmark rejects memory-arena answer objects with non-array attributes", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-attributes-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What snack should I pack?"],
      answers: [{ attributes: "trail mix" }],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include an answers array of strings, objects, or arrays of those values/,
  );
});

test("runBenchmark rejects invalid memory-arena base traveler plans while parsing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-base-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      questions: ["What dinner should we keep?"],
      answers: ["Coco Bambu, Dallas"],
      base_person: {
        name: "Jennifer",
        daily_plans: 42,
      },
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /base_person must be an object with a valid daily_plans value/,
  );
});

test("runBenchmark reports original JSONL line numbers when blank lines precede malformed memory-arena rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-lines-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `\n${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What snack should I pack?"],
      answers: [{ attributes: ["trail mix"] }],
    })}\n\n{not json}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /contains invalid JSON on line 4/,
  );
});

test("runBenchmark fails fast when a memory-arena question is missing a matching answer entry", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memory-arena-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What product should we buy?"],
      answers: [],
    })}\n`,
    "utf8",
  );

  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        limit: 1,
        system: adapter,
      }),
    /MemoryArena dataset file bundled_shopping\.jsonl line 1 must include exactly one answer/,
  );

  assert.equal(
    [...adapter.sessions.values()].some((messages) =>
      messages.some((message) => /Answer for subtask/.test(message.content)),
    ),
    false,
  );
});
