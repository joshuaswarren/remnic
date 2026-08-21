import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __memoryArenaTestHooks,
  memoryArenaDefinition,
  runMemoryArenaBenchmark,
} from "./runner.ts";

test("MemoryArena derives missing categories from the source filename", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 7,
        category: null,
        questions: ["Which proof topic did we review?"],
        answers: ["number theory"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "number theory";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(
      result.results.tasks[0]?.details?.category,
      "formal_reasoning_math",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects dataset tasks with no questions", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 1,
        category: "shopping",
        questions: [],
        answers: [],
      }) + "\n",
      "utf8",
    );

    await assert.rejects(
      runMemoryArenaBenchmark({
        benchmark: memoryArenaDefinition,
        mode: "full",
        datasetDir: tempDir,
        system: {
          async store() {},
          async recall() {
            return "";
          },
          async search() {
            return [];
          },
          async reset() {},
          async destroy() {},
          async getStats() {
            return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
          },
          judge: {
            async score() {
              return 0;
            },
            async scoreWithMetrics() {
              return {
                score: 0,
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "judge-smoke",
              };
            },
          },
        },
      }),
      /MemoryArena dataset file shopping\.jsonl line 1 must include at least one question/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects dataset tasks with partial answer cardinality", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 2,
        category: "shopping",
        questions: ["Which snack?", "Which drink?"],
        answers: ["trail mix"],
      }) + "\n",
      "utf8",
    );

    await assert.rejects(
      runMemoryArenaBenchmark({
        benchmark: memoryArenaDefinition,
        mode: "full",
        datasetDir: tempDir,
        system: {
          async store() {},
          async recall() {
            return "";
          },
          async search() {
            return [];
          },
          async reset() {},
          async destroy() {},
          async getStats() {
            return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
          },
          judge: {
            async score() {
              return 0;
            },
            async scoreWithMetrics() {
              return {
                score: 0,
                tokens: { input: 0, output: 0 },
                latencyMs: 0,
                model: "judge-smoke",
              };
            },
          },
        },
      }),
      /MemoryArena dataset file shopping\.jsonl line 1 must include exactly one answer for each question; received 2 questions and 1 answers/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena stored-line parser only maps selected-item markers to selected-item lines", () => {
  const { extractMemoryArenaStoredLineValue } = __memoryArenaTestHooks;

  assert.equal(
    extractMemoryArenaStoredLineValue(
      "Subtask 1: Selected item attributes: vanilla cake base",
      "Environment result:",
    ),
    undefined,
  );
  assert.equal(
    extractMemoryArenaStoredLineValue(
      "Subtask 1: Selected item attributes: vanilla cake base",
      "Selected item attributes:",
    ),
    "vanilla cake base",
  );
  assert.equal(
    extractMemoryArenaStoredLineValue(
      "Subtask 1: Selected item ASIN: B00BASE001",
      "Selected item ASIN:",
    ),
    "B00BASE001",
  );
  assert.equal(
    extractMemoryArenaStoredLineValue(
      "Subtask 1: Selected item attributes: vanilla cake base",
      "Selected item ASIN:",
    ),
    undefined,
  );
  assert.equal(
    extractMemoryArenaStoredLineValue(
      "Subtask 1: Environment result: B00BASE001",
      "Environment result:",
    ),
    "B00BASE001",
  );
});

test("MemoryArena quick fixture seeds prerequisite subtasks before scoring follow-ups", async () => {
  const storedMessages: string[] = [];
  const recalledQueries: string[] = [];
  const completedCounts: number[] = [];

  const result = await runMemoryArenaBenchmark({
    benchmark: memoryArenaDefinition,
    mode: "quick",
    system: {
      async store(_sessionId, messages) {
        storedMessages.push(...messages.map((message) => message.content));
      },
      async recall(_sessionId, query) {
        recalledQueries.push(query);
        return storedMessages.join("\n\n");
      },
      async search() {
        return [];
      },
      async reset() {
        storedMessages.length = 0;
      },
      async destroy() {},
      async drain() {},
      async getStats() {
        return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics(_question, predicted, expected) {
          return {
            score: predicted.includes(expected) ? 1 : 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "judge-smoke",
          };
        },
      },
    },
    onTaskComplete(_task, completed) {
      completedCounts.push(completed);
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "bundled_shopping-t1-q1");
  assert.equal(result.results.tasks[0]?.expected, "trail mix");
  assert.equal(result.results.tasks[0]?.scores.contains_answer, 1);
  assert.equal(result.results.tasks[0]?.scores.process_score, 1);
  assert.equal(result.results.tasks[0]?.scores.task_success_rate, 1);
  assert.match(result.results.tasks[0]?.actual ?? "", /trail mix/);
  assert.deepEqual(completedCounts, [1]);
  assert.equal(recalledQueries.length, 1);
  assert.match(storedMessages.join("\n"), /Environment result: trail mix/);
});

test("MemoryArena reports prerequisite drain failures before scoring follow-ups", async () => {
  const storedMessages: string[] = [];
  const completedCounts: number[] = [];
  let drainCalls = 0;
  let recallCalls = 0;
  let responderCalls = 0;
  let judgeCalls = 0;

  const result = await runMemoryArenaBenchmark({
    benchmark: memoryArenaDefinition,
    mode: "quick",
    system: {
      async store(_sessionId, messages) {
        storedMessages.push(...messages.map((message) => message.content));
      },
      async recall() {
        recallCalls += 1;
        return storedMessages.join("\n\n");
      },
      async search() {
        return [];
      },
      async reset() {
        storedMessages.length = 0;
      },
      async drain() {
        drainCalls += 1;
        if (drainCalls === 2) {
          throw new Error("drain timed out");
        }
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond() {
          responderCalls += 1;
          return {
            text: "trail mix",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "memory-arena-test-responder",
          };
        },
      },
      judge: {
        async score() {
          judgeCalls += 1;
          return 1;
        },
        async scoreWithMetrics() {
          judgeCalls += 1;
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "judge-smoke",
          };
        },
      },
    },
    onTaskComplete(_task, completed) {
      completedCounts.push(completed);
    },
  });

  assert.equal(recallCalls, 0);
  assert.equal(responderCalls, 0);
  assert.equal(judgeCalls, 0);
  assert.deepEqual(completedCounts, [1]);
  assert.equal(result.results.tasks.length, 1);

  const task = result.results.tasks[0]!;
  assert.equal(task.taskId, "bundled_shopping-t1-q1");
  assert.match(
    task.actual,
    /MemoryArena prerequisite failed before bundled_shopping-t1-q1/,
  );
  assert.match(task.actual, /MemoryArena drain failed after completed subtask 1/);
  assert.equal(task.scores.f1, -1);
  assert.equal(task.scores.contains_answer, -1);
  assert.equal(task.scores.llm_judge, -1);
  assert.equal(task.scores.process_score, 0);
  assert.equal(task.details?.error, "MemoryArena prerequisite failed before bundled_shopping-t1-q1: MemoryArena drain failed after completed subtask 1: drain timed out");
});

test("MemoryArena reports group-travel initial seed failures before scoring", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "group_travel_planner.jsonl");
  const completedCounts: number[] = [];
  let recallCalls = 0;
  let responderCalls = 0;
  let judgeCalls = 0;

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 31,
        category: "group_travel_planner",
        base_person: {
          name: "Avery",
          query: "Plan a base trip.",
          daily_plans: {
            days: "1",
            current_city: "Paris",
            transportation: "Train A",
            breakfast: "Cafe Base",
            attraction: "Museum Base",
            lunch: "Bistro Base",
            dinner: "Dinner Base",
            accommodation: "Hotel Base",
          },
        },
        questions: [
          "Create the joined traveler plan using Avery's base trip.",
        ],
        answers: [
          {
            days: "1",
            current_city: "Paris",
            transportation: "Train A",
            breakfast: "Cafe Base",
            attraction: "Museum Base",
            lunch: "Bistro Base",
            dinner: "Dinner Base",
            accommodation: "Hotel Base",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          recallCalls += 1;
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {
          throw new Error("initial drain timeout");
        },
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            responderCalls += 1;
            return {
              text: "should not be called",
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            judgeCalls += 1;
            return 0;
          },
          async scoreWithMetrics() {
            judgeCalls += 1;
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
      onTaskComplete(_task, completed) {
        completedCounts.push(completed);
      },
    });

    assert.equal(recallCalls, 0);
    assert.equal(responderCalls, 0);
    assert.equal(judgeCalls, 0);
    assert.deepEqual(completedCounts, [1]);
    assert.equal(result.results.tasks.length, 1);

    const task = result.results.tasks[0]!;
    assert.match(
      task.actual,
      /MemoryArena prerequisite failed before group_travel_planner-t31-q0/,
    );
    assert.match(task.actual, /MemoryArena initial task state failed/);
    assert.match(task.actual, /initial drain timeout/);
    assert.equal(task.scores.f1, -1);
    assert.equal(task.scores.contains_answer, -1);
    assert.equal(task.scores.llm_judge, -1);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.task_success_rate, 0);
    assert.equal(task.scores.plan_field_recall, 0);
    assert.equal(task.scores.soft_process_score, 0);
    assert.equal(
      task.details?.initialSeedError,
      "MemoryArena drain failed after initial task state: initial drain timeout",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena accepts optional string-array backgrounds from dataset files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 8,
        category: "shopping",
        questions: [
          "What did the previous shopper choose?",
          "Which item should be packed?",
        ],
        answers: ["trail mix", "trail mix"],
        backgrounds: ["The shopper already bought trail mix.", ""],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "trail mix";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 2);
    assert.equal(result.results.tasks[0]?.taskId, "shopping-t8-q0");
    assert.equal(result.results.tasks[1]?.taskId, "shopping-t8-q1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena passes the live task prompt into answer context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 9,
        category: "bundled_shopping",
        questions: [
          "Product 1 options: ASIN A costs $4. Product 2 options: ASIN B costs $5. Which bundle should be purchased?",
        ],
        answers: ["ASIN A | ASIN B"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "ASIN A | ASIN B",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /Current MemoryArena task prompt/);
    assert.match(responderContext, /Product 1 options: ASIN A/);
    assert.match(responderContext, /Prior memory context/);
    assert.doesNotMatch(
      responderContext,
      /Best-supported option by current rules/,
    );
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product 2 options: ASIN B/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena item-selection context prioritizes compact prior environment results", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 15,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the base.",
            "**Available Options:**",
            "- A stale old option that must not be replayed.",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Frosting",
            "**Goal:** Vanilla pairs well with White.",
            "**Constraint:** Must be compatible with the previous product.",
            "**Available Options:**",
            "- A white frosting.",
            "- A chocolate frosting.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B00-BASE",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B00-WHITE",
            attributes: ["white frosting"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "item: A white frosting.; attributes: white frosting",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /Prior completed MemoryArena subtasks/);
    assert.match(responderContext, /Environment result: B00-BASE/);
    assert.match(responderContext, /Selected item attributes: vanilla cake base/);
    assert.match(responderContext, /A white frosting/);
    assert.doesNotMatch(responderContext, /stale old option/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena item-selection context includes WebShop sidecar observations", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 16,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the cake base.",
            "**Available Options:**",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Decorations",
            "**Goal:** Compatibility notes: Vanilla pairs well with Rose.",
            "**Preference:** Pick the highest-priced option among those compatible with the notes.",
            "**Constraint:** Must be compatible with the previous (ground truth) products.",
            "**Available Options:**",
            "- A low-price chocolate sprinkle mix for cakes.",
            "- A Dessert Rose Sprinkle Mix for cupcakes and baked goods.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "BASE000001",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          pricing: "$3.00",
          average_rating: 4.5,
          total_reviews: 10,
          product_category: "Grocery & Gourmet Food > Cakes",
        }),
        JSON.stringify({
          asin: "LOWPRICE01",
          name: "Low Price Chocolate Sprinkle Mix for Cakes",
          pricing: "$4.00",
          average_rating: 4.9,
          total_reviews: 50,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        }),
        JSON.stringify({
          asin: "B08957C9ZH",
          name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
          pricing: "$12.00",
          average_rating: 4.2,
          total_reviews: 9,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; item: A Dessert Rose Sprinkle Mix for cupcakes and baked goods.; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /Selected WebShop product title: Vanilla Cake Base/);
    assert.match(responderContext, /LOWPRICE01/);
    assert.match(responderContext, /\$4\.00/);
    assert.match(responderContext, /B08957C9ZH/);
    assert.match(responderContext, /\$12\.00/);
    assert.match(responderContext, /Average rating: 4\.2/);
    assert.match(responderContext, /WebShop derived decision support/);
    assert.match(
      String(result.results.tasks[0]?.details?.promptQuestion ?? ""),
      /return that option/,
    );
    assert.match(responderContext, /Prior selected rule labels detected: Vanilla/);
    assert.match(
      responderContext,
      /Best-supported option by current rules: Option 2: A Dessert Rose Sprinkle Mix/,
    );
    assert.equal(
      result.results.tasks[0]?.details?.webshopProductCatalog,
      sidecarPath,
    );
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
    assert.equal(result.results.tasks[0]?.scores.process_score, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena matches WebShop sidecar observations for ASIN-only options", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 17,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
            "- B08957C9ZHX",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      JSON.stringify([
        {
          asin: "B08957C9ZH",
          name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
          pricing: "$12.00",
          average_rating: 4.2,
          total_reviews: 9,
          product_category: "Grocery & Gourmet Food > Sprinkles",
        },
      ]) + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /Option 1: B08957C9ZH/);
    assert.doesNotMatch(responderContext, /Option 2: B08957C9ZHX/);
    assert.match(responderContext, /Dessert Rose Sprinkle Mix/);
    assert.match(responderContext, /\$12\.00/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects longer ASIN-like sibling selections", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 18,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
            "- B08957C9ZHX",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B08957C9ZHX; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 0);
    assert.equal(result.results.tasks[0]?.scores.process_score, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena loads WebShop sidecar wrapper product maps", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.json");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 21,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      JSON.stringify({
        products: {
          B08957C9ZH: {
            name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
            price: "$12.00",
          },
        },
      }),
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /B08957C9ZH/);
    assert.match(responderContext, /Dessert Rose Sprinkle Mix/);
    assert.match(responderContext, /\$12\.00/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena loads single-record WebShop JSON sidecars", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.json");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 25,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      JSON.stringify({
        asin: "B08957C9ZH",
        name: "Dessert Rose Sprinkle Mix",
        price: "$12.00",
      }),
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /B08957C9ZH/);
    assert.match(responderContext, /Dessert Rose Sprinkle Mix/);
    assert.match(responderContext, /\$12\.00/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena loads WebShop JSONL array batches", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 22,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Sprinkles",
            "**Goal:** Buy the dessert rose sprinkle mix.",
            "**Available Options:**",
            "- B08957C9ZH",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["dessert rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify([
          {
            asin: "B08957C9ZH",
            name: "Dessert Rose Sprinkle Mix for cupcakes and baked goods",
            price: "$12.00",
          },
        ]),
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          pricing: "$3.00",
        }),
      ].join("\n"),
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; attributes: dessert rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /WebShop environment observations/);
    assert.match(responderContext, /Dessert Rose Sprinkle Mix/);
    assert.match(responderContext, /\$12\.00/);
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena ranks WebShop price preferences from currency price fields", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 20,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the vanilla cake base.",
            "**Available Options:**",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Decorations",
            "**Goal:** Compatibility notes: Vanilla pairs well with Rose.",
            "**Preference:** Pick the highest-priced option among those compatible with the notes.",
            "**Available Options:**",
            "- A Budget Rose Sprinkle Mix.",
            "- A Premium Rose Sprinkle Mix.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "BASE000001",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B08957C9ZH",
            attributes: ["premium rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          price: "$3.00",
        }),
        JSON.stringify({
          asin: "BUDGET0001",
          name: "Budget Rose Sprinkle Mix",
          price: "$4.00",
        }),
        JSON.stringify({
          asin: "B08957C9ZH",
          name: "Premium Rose Sprinkle Mix",
          price: "$12.00",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; item: A Premium Rose Sprinkle Mix.; attributes: premium rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /Option 1: A Budget Rose Sprinkle Mix/);
    assert.match(responderContext, /price: \$4\.00/);
    assert.match(responderContext, /Option 2: A Premium Rose Sprinkle Mix/);
    assert.match(responderContext, /price: \$12\.00/);
    assert.match(
      responderContext,
      /Best-supported option by current rules: Option 2: A Premium Rose Sprinkle Mix/,
    );
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena ranks WebShop price preferences from comma-separated prices", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 27,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the vanilla cake base.",
            "**Available Options:**",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Premium Machine",
            "**Goal:** Compatibility notes: Vanilla pairs well with Rose.",
            "**Preference:** Pick the highest-priced option among those compatible with the notes.",
            "**Available Options:**",
            "- A Budget Rose Machine.",
            "- A Premium Rose Machine.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "BASE000001",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B08957C9ZH",
            attributes: ["premium rose", "machine"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          pricing: "$3.00",
        }),
        JSON.stringify({
          asin: "BUDGET0001",
          name: "Budget Rose Machine",
          pricing: "$999.00",
        }),
        JSON.stringify({
          asin: "B08957C9ZH",
          name: "Premium Rose Machine",
          pricing: "$1,299.00",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; item: A Premium Rose Machine.; attributes: premium rose, machine",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /Option 1: A Budget Rose Machine/);
    assert.match(responderContext, /price: \$999\.00/);
    assert.match(responderContext, /Option 2: A Premium Rose Machine/);
    assert.match(responderContext, /price: \$1,299\.00/);
    assert.match(
      responderContext,
      /Best-supported option by current rules: Option 2: A Premium Rose Machine/,
    );
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena ranks WebShop rating preferences from Amazon review strings", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  const sidecarPath = path.join(tempDir, "webshop-products.jsonl");
  const previousSidecarPath =
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
  const storedMessages: string[] = [];
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 26,
        category: "bundled_shopping",
        questions: [
          [
            "Product 1:",
            "### Select Base",
            "**Goal:** Buy the vanilla cake base.",
            "**Available Options:**",
            "- A vanilla cake base.",
          ].join("\n"),
          [
            "Product 2:",
            "### Select Decorations",
            "**Goal:** Compatibility notes: Vanilla pairs well with Rose.",
            "**Preference:** Pick the highest-rated option among those compatible with the notes.",
            "**Available Options:**",
            "- A Budget Rose Sprinkle Mix.",
            "- A Premium Rose Sprinkle Mix.",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "BASE000001",
            attributes: ["vanilla cake base"],
          },
          {
            target_asin: "B08957C9ZH",
            attributes: ["premium rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );
    await writeFile(
      sidecarPath,
      [
        JSON.stringify({
          asin: "BASE000001",
          name: "Vanilla Cake Base",
          price: "$3.00",
        }),
        JSON.stringify({
          asin: "BUDGET0001",
          name: "Budget Rose Sprinkle Mix",
          product_information: {
            "Customer Reviews": {
              stars: "4.1 out of 5 stars",
              ratings_count: "222 ratings",
            },
          },
        }),
        JSON.stringify({
          asin: "B08957C9ZH",
          name: "Premium Rose Sprinkle Mix",
          product_information: {
            "Customer Reviews": {
              stars: "4.7 out of 5 stars",
              ratings_count: "1,234 ratings",
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS = sidecarPath;

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages.map((message) => message.content));
        },
        async recall() {
          return storedMessages.join("\n\n");
        },
        async search() {
          return [];
        },
        async reset() {
          storedMessages.length = 0;
        },
        async drain() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "target_asin: B08957C9ZH; item: A Premium Rose Sprinkle Mix.; attributes: premium rose, sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.match(responderContext, /Option 1: A Budget Rose Sprinkle Mix/);
    assert.match(responderContext, /rating: 4\.1/);
    assert.match(responderContext, /Option 2: A Premium Rose Sprinkle Mix/);
    assert.match(responderContext, /rating: 4\.7/);
    assert.match(responderContext, /Reviews: 1234/);
    assert.match(
      responderContext,
      /Best-supported option by current rules: Option 2: A Premium Rose Sprinkle Mix/,
    );
    assert.equal(result.results.tasks[0]?.scores.item_selection_match, 1);
  } finally {
    if (previousSidecarPath === undefined) {
      delete process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS;
    } else {
      process.env.REMNIC_BENCH_MEMORY_ARENA_WEBSHOP_PRODUCTS =
        previousSidecarPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena no-responder runs do not score the live task prompt as recall", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 10,
        category: "bundled_shopping",
        questions: [
          "Product options include ASIN A. Which item should be purchased?",
        ],
        answers: ["ASIN A"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context without the answer.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks[0]?.actual, "Prior memory context without the answer.");
    assert.equal(result.results.tasks[0]?.scores.contains_answer, 0);
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product options include ASIN A/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena honors negative judges before lexical fallbacks for non-item-selection tasks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 11,
        category: "formal_reasoning_math",
        questions: ["Which theorem name was established?"],
        answers: ["Euler theorem"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Euler theorem";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.contains_answer, 1);
    assert.equal(task.scores.f1, 1);
    assert.equal(task.scores.llm_judge, 0);
    assert.equal(task.scores.process_score, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores item-selection objects with deterministic match metric", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");
  let responderPrompt = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 11,
        category: "shopping",
        questions: [
          "Options include target_asin B00-TEA, a blue ceramic mug, and target_asin B00-CUP, a red cup. Which item should be selected for the tea setup?",
        ],
        answers: [
          {
            target_asin: "B00-TEA",
            attributes: ["blue ceramic mug"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The tea setup should use the blue ceramic mug with target_asin B00-TEA.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question) {
            responderPrompt = question;
            return {
              text: "target_asin: B00-TEA; attributes: blue ceramic mug",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(responderPrompt, /item-selection task/);
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena item-selection token overlap matches common -ies singulars", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 24,
        category: "shopping",
        questions: [
          [
            "Which movie-night snack should be selected?",
            "- Movie night cookies pack",
            "- Movie night brownies pack",
          ].join("\n"),
        ],
        answers: [
          {
            attributes: ["movie night cookie pack"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the movie night cookie pack.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "movie night cookie pack",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena accepts exact ASIN matches without requiring secondary attributes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 12,
        category: "shopping",
        questions: [
          "Options include target_asin B00TUDFEW2, a washable travel bottle. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B00TUDFEW2",
            attributes: ["washable travel bottle", "navy"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item is target_asin B00TUDFEW2.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B00TUDFEW2",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena accepts exact multi-item ASIN selections without extras", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 23,
        category: "shopping",
        questions: [
          "Options include target_asin B000AAAAAA and target_asin B000BBBBBB. Which bundle should be selected?",
        ],
        answers: [
          [
            {
              target_asin: "B000AAAAAA",
              attributes: [],
            },
            {
              target_asin: "B000BBBBBB",
              attributes: [],
            },
          ],
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected bundle includes target_asin B000AAAAAA and target_asin B000BBBBBB.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B000AAAAAA; target_asin: B000BBBBBB",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects exact ASIN matches with extra conflicting ASINs", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 22,
        category: "shopping",
        questions: [
          "Options include target_asin B000RIGHT1, a red cotton bag. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B000RIGHT1",
            attributes: ["red", "cotton"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item is target_asin B000RIGHT1.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin: B000RIGHT1; also references B000WRONG1",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects conflicting explicit ASINs before attribute fallback", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 17,
        category: "shopping",
        questions: [
          "Options include target_asin B000RIGHT1, a red cotton bag. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B000RIGHT1",
            attributes: ["red", "cotton"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the red cotton bag.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "B000WRONG1; attributes: red, cotton",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects bare numeric ASIN conflicts before attribute fallback", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 23,
        category: "shopping",
        questions: [
          "Options include target_asin B000RIGHT1, a red cotton bag. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B000RIGHT1",
            attributes: ["red", "cotton"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the red cotton bag.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "1234567890; attributes: red, cotton",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena keeps attribute fallback for unlabeled non-ASIN words", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 18,
        category: "shopping",
        questions: [
          "Pick the red cotton bag. Which item should be selected?",
        ],
        answers: [
          {
            target_asin: "B000RIGHT1",
            attributes: ["red", "cotton"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the red cotton bag.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "asin background context; attributes: red, cotton; explanation: selected by material",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores hidden-ASIN selections by unique visible option text", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");
  let responderPrompt = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 13,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A BBTO 50th birthday cake topper decoration with glitter numeral candles in rose gold.",
            "- A Amscan #5 metallic birthday candle in gold for my party.",
            "- A black 50th birthday candle cake topper for a man or woman party decoration.",
            "- A red birthday candle with numeral for a one year cake.",
            "- A Glitter Star Candle set for cake in gold color.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B06XG24BBK",
            attributes: ["metallic", "birthday", "candle", "gold", "party supply"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The best visible option is the metallic birthday candle in gold.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(question) {
            responderPrompt = question;
            return {
              text: "item: A Amscan #5 metallic birthday candle in gold for my party; attributes: metallic, birthday, candle, gold",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.match(responderPrompt, /omit target_asin instead of answering unknown/);
    assert.match(responderPrompt, /item: <visible option text>/);
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects ambiguous hidden-ASIN selections when option attributes tie", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 28,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A Budget Rose Sprinkle Mix.",
            "- A Premium Rose Sprinkle Mix.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B08957C9ZH",
            attributes: ["sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected visible option is the premium rose sprinkle mix.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "item: A Budget Rose Sprinkle Mix.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores tied visible predictions when expectation is unique", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 29,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A Budget Rose Sprinkle Mix.",
            "- A Premium Rose Sprinkle Mix.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            attributes: ["premium rose", "sprinkle mix"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item should be the rose sprinkle mix.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "rose sprinkle mix",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena scores explicit non-B0 ASIN selections case-insensitively", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 20,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A reusable red cotton tote bag for groceries.",
            "- A blue insulated lunch bag with zipper.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "A1B2C3D4E5",
            attributes: ["red", "cotton", "tote"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The selected item is the red cotton tote.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin a1b2c3d4e5; attributes: red, cotton, tote",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 1);
    assert.equal(task.scores.process_score, 1);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects conflicting explicit ASINs before visible-option fallback", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 19,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A BBTO 50th birthday cake topper decoration with glitter numeral candles in rose gold.",
            "- A Amscan #5 metallic birthday candle in gold for my party.",
            "- A black 50th birthday candle cake topper for a man or woman party decoration.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B06XG24BBK",
            attributes: ["metallic", "birthday", "candle", "gold", "party supply"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The visible item is the metallic birthday candle in gold.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "target_asin B000WRONG1; item: A Amscan #5 metallic birthday candle in gold for my party; attributes: metallic, birthday, candle, gold",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena rejects wrong visible option selections that share generic attributes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 14,
        category: "shopping",
        questions: [
          [
            "Available Options:",
            "- A BBTO 50th birthday cake topper decoration with glitter numeral candles in rose gold.",
            "- A Amscan #5 metallic birthday candle in gold for my party.",
            "- A black 50th birthday candle cake topper for a man or woman party decoration.",
            "- A red birthday candle with numeral for a one year cake.",
            "- A Glitter Star Candle set for cake in gold color.",
            "Which item should be selected?",
          ].join("\n"),
        ],
        answers: [
          {
            target_asin: "B06XG24BBK",
            attributes: ["metallic", "birthday", "candle", "gold", "party supply"],
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "The answer is a gold candle option.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond() {
            return {
              text: "item: A Glitter Star Candle set for cake in gold color; attributes: glitter star candle, gold color",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "memory-arena-test-responder",
            };
          },
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    const task = result.results.tasks[0]!;
    assert.equal(task.scores.item_selection_match, 0);
    assert.equal(task.scores.process_score, 0);
    assert.equal(task.scores.llm_judge, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
