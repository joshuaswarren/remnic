import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributeRun,
  attributeTask,
  lexicalSimilarity,
  renderAttributionReportTable,
  serializeAttributionReport,
  type AttributionEnvironment,
  type AttributionReport,
} from "./attribution.js";

test("lexicalSimilarity computes containment of gold in candidate", () => {
  const sim1 = lexicalSimilarity(
    "Avery Quill visited Paris in May",
    "Avery Quill traveled to Paris during May"
  );
  // Gold content words: avery, quill, visited, paris, may (5 words)
  // Candidate content words: avery, quill, traveled, paris, may (matches 4: avery, quill, paris, may) -> 4/5 = 0.8
  assert.strictEqual(sim1, 0.8);

  const sim2 = lexicalSimilarity("no match here", "completely different text");
  assert.strictEqual(sim2, 0);

  const simEmpty = lexicalSimilarity("", "candidate text");
  assert.strictEqual(simEmpty, 0);
});

test("attribution labels extraction_miss when similarity below threshold", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [{ id: "mem-1", content: "Unrelated content about baking bread" }],
    recallLimit: 10,
  };

  const task = {
    taskId: "task-1",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "extraction_miss");
  assert.strictEqual(res!.golds[0].stages.extraction.status, "fail");
  assert.strictEqual(res!.golds[0].stages.index.status, "unavailable");
});

test("attribution labels index_miss when gold missing from oracle search", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    oracleSearch: async () => [{ id: "mem-2" }], // mem-1 not in index results
    recall: async () => [],
    recallLimit: 5,
  };

  const task = {
    taskId: "task-2",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "index_miss");
  assert.strictEqual(res!.golds[0].stages.extraction.status, "pass");
  assert.strictEqual(res!.golds[0].stages.index.status, "fail");
});

test("attribution labels retrieval_miss with stage cap when rank exceeds recallLimit", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    oracleSearch: async () => [{ id: "mem-1" }],
    recall: async (_q, limit) => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: i === 12 ? "mem-1" : `mem-other-${i}`,
        content: i === 12 ? "Avery's favorite color is teal blue" : `Other info ${i}`,
      }));
      return items.slice(0, limit);
    },
    recallLimit: 5,
    replayLimit: 25,
  };

  const task = {
    taskId: "task-3",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "retrieval_miss");
  assert.strictEqual(res!.overall.retrievalStage, "cap");
  assert.strictEqual(res!.golds[0].stages.retrieval.status, "fail");
  assert.match(res!.golds[0].stages.retrieval.detail ?? "", /Rank 13/);
});

test("attribution labels retrieval_miss with stage rank when absent even at replayLimit", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    oracleSearch: async () => [{ id: "mem-1" }],
    recall: async () => Array.from({ length: 25 }, (_, i) => ({
      id: `mem-distractor-${i}`,
      content: `Distractor topic ${i}`,
    })),
    recallLimit: 5,
    replayLimit: 25,
  };

  const task = {
    taskId: "task-4",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "retrieval_miss");
  assert.strictEqual(res!.overall.retrievalStage, "rank");
});

test("attribution labels use_miss when gold retrieved into context but task failed", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    oracleSearch: async () => [{ id: "mem-1" }],
    recall: async () => [{ id: "mem-1", content: "Avery's favorite color is teal blue" }],
    recallLimit: 5,
  };

  const task = {
    taskId: "task-5",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "use_miss");
  assert.strictEqual(res!.golds[0].stages.use.status, "fail");
});

test("implied-pass logic: passing retrieval retroactively marks unavailable index as pass", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    // oracleSearch is undefined (unavailable)
    recall: async () => [{ id: "mem-1", content: "Avery's favorite color is teal blue" }],
    recallLimit: 5,
  };

  const task = {
    taskId: "task-6",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.golds[0].stages.index.status, "pass");
  assert.strictEqual(res!.golds[0].stages.index.detail, "implied pass from retrieval");
  assert.strictEqual(res!.overall.class, "use_miss");
});

test("unavailable propagation to unattributed when checks unavailable", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    // Neither oracleSearch nor recall available
    recallLimit: 5,
  };

  const task = {
    taskId: "task-7",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery's favorite color is teal blue"],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  assert.strictEqual(res!.overall.class, "unattributed");
  assert.match(res!.overall.reason ?? "", /unavailable/);
});

test("threshold boundary handling", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery likes teal color" },
    ],
    recallLimit: 5,
  };

  // Gold words: avery, favorite, color, teal, blue (5 words)
  // Candidate words: avery, likes, teal, color (matches 3/5 = 0.6)
  const task = {
    taskId: "task-8",
    question: "What is Avery's favorite color?",
    scores: { overall: 0 },
    goldMemories: ["Avery favorite color teal blue"],
  };

  // With threshold 0.6 -> pass extraction
  const resPass = await attributeTask(task, env, { threshold: 0.6 });
  assert.strictEqual(resPass!.golds[0].stages.extraction.status, "pass");

  // With threshold 0.7 -> fail extraction
  const resFail = await attributeTask(task, env, { threshold: 0.7 });
  assert.strictEqual(resFail!.golds[0].stages.extraction.status, "fail");
});

test("overall label picks earliest stage miss across multiple golds", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
      // gold 2 has no memory in store -> extraction_miss
    ],
    oracleSearch: async () => [{ id: "mem-1" }],
    recall: async () => [{ id: "mem-1", content: "Avery's favorite color is teal blue" }],
    recallLimit: 5,
  };

  const task = {
    taskId: "task-9",
    question: "What are Avery's color and pet preference?",
    scores: { overall: 0 },
    goldMemories: [
      "Avery's favorite color is teal blue", // use_miss
      "Avery owns a rare green reptile named Ziggy", // extraction_miss
    ],
  };

  const res = await attributeTask(task, env, { threshold: 0.6 });
  assert.notStrictEqual(res, null);
  // extraction_miss is earlier than use_miss -> overall must be extraction_miss
  assert.strictEqual(res!.overall.class, "extraction_miss");
});

test("attributeRun aggregates totals, handles skipped tasks, and sorts deterministically", async () => {
  const env: AttributionEnvironment = {
    listMemories: async () => [
      { id: "mem-1", content: "Avery's favorite color is teal blue" },
    ],
    recallLimit: 5,
  };

  const runResult = {
    meta: { id: "test-run-123" },
    results: {
      tasks: [
        {
          taskId: "task-Z",
          question: "Question Z",
          scores: { overall: 0 },
          goldMemories: ["Avery's favorite color is teal blue"],
        },
        {
          taskId: "task-A",
          question: "Question A",
          scores: { overall: 1 }, // Passed task -> skipped
          goldMemories: ["Avery's favorite color is teal blue"],
        },
        {
          taskId: "task-M",
          question: "Question M",
          scores: { overall: 0 },
          // No goldMemories -> skipped
        },
      ],
    },
  };

  const report1 = await attributeRun(runResult, env, { threshold: 0.6 });
  const report2 = await attributeRun(runResult, env, { threshold: 0.6 });

  // Determinism check
  assert.deepStrictEqual(report1, report2);
  assert.strictEqual(serializeAttributionReport(report1), serializeAttributionReport(report2));

  // Check items sorted by taskId
  assert.strictEqual(report1.items.length, 1);
  assert.strictEqual(report1.items[0].taskId, "task-Z");

  // Check skipped tasks sorted by taskId
  assert.strictEqual(report1.skippedTasks.length, 2);
  assert.strictEqual(report1.skippedTasks[0].taskId, "task-A");
  assert.strictEqual(report1.skippedTasks[1].taskId, "task-M");

  const tableStr = renderAttributionReportTable(report1);
  assert.match(tableStr, /Attribution Report \(Run: test-run-123\)/);
  assert.match(tableStr, /task-Z/);
});
