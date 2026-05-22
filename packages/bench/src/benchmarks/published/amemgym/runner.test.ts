import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Message } from "../../../adapters/types.js";
import { amemGymDefinition, runAMemGymBenchmark } from "./runner.ts";

test("AMemGym batches tiny session messages before storing profile context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-amemgym-"));
  const storeBatches: Message[][] = [];

  try {
    await writeFile(
      path.join(tempDir, "amemgym-v1-base.json"),
      JSON.stringify([
        {
          id: "batched-profile",
          start_time: "2025-01-01T00:00:00Z",
          user_profile: {
            uuid: "user-1",
            name: "Maya",
            age: 29,
            gender: "female",
          },
          state_schema: { city: { type: "string" } },
          periods: [
            {
              period_start: "2025-01-01T00:00:00Z",
              period_end: "2025-01-31T23:59:59Z",
              period_summary: "Maya updated her city.",
              sessions: Array.from({ length: 12 }, (_value, index) => ({
                event: index === 0 ? "Maya moved to Chicago." : null,
                exposed_states: index === 11 ? { city: "Chicago" } : {},
                query: `profile update ${index}`,
                messages: [
                  {
                    role: "assistant",
                    content: `remembered profile update ${index}`,
                  },
                ],
                session_time: `2025-01-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
              })),
              state: { city: "Chicago" },
              updates: { city: "Chicago" },
              update_cnts: { city: 1 },
            },
          ],
          qas: [
            {
              query: "What city does Maya live in now?",
              required_info: ["city"],
              answer_choices: [
                { state: ["Chicago"], answer: "Chicago" },
                { state: ["Austin"], answer: "Austin" },
              ],
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runAMemGymBenchmark({
      benchmark: amemGymDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storeBatches.push(messages);
        },
        async recall() {
          return storeBatches
            .flat()
            .map((message) => message.content)
            .join("\n");
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
              text: "1",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "amemgym-test-responder",
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
              model: "amemgym-test-judge",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.scores.qa_accuracy, 1);
    assert.deepEqual(
      storeBatches.map((batch) => batch.length),
      [20, 7],
    );
    assert.equal(storeBatches[0]?.[0]?.content, "[Context update]: Maya moved to Chicago.");
    assert.match(
      storeBatches[1]?.at(-1)?.content ?? "",
      /^\[Current user state\]: city: Chicago \(city: Chicago\)$/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMemGym rejects malformed primary dataset files instead of falling back", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-amemgym-malformed-"));
  let storeCalls = 0;

  try {
    await writeFile(path.join(tempDir, "amemgym-v1-base.json"), "{", "utf8");
    await writeFile(
      path.join(tempDir, "data.json"),
      JSON.stringify([
        {
          id: "fallback-profile",
          start_time: "2025-01-01T00:00:00Z",
          user_profile: {
            uuid: "user-1",
            name: "Maya",
            age: 29,
            gender: "female",
          },
          state_schema: { city: { type: "string" } },
          periods: [
            {
              period_start: "2025-01-01T00:00:00Z",
              period_end: "2025-01-31T23:59:59Z",
              period_summary: "Maya updated her city.",
              sessions: [],
              state: { city: "Chicago" },
              updates: { city: "Chicago" },
              update_cnts: { city: 1 },
            },
          ],
          qas: [
            {
              query: "What city does Maya live in now?",
              required_info: ["city"],
              answer_choices: [
                { state: ["Chicago"], answer: "Chicago" },
                { state: ["Austin"], answer: "Austin" },
              ],
            },
          ],
        },
      ]),
      "utf8",
    );

    await assert.rejects(
      () =>
        runAMemGymBenchmark({
          benchmark: amemGymDefinition,
          mode: "full",
          datasetDir: tempDir,
          system: {
            async store() {
              storeCalls += 1;
            },
            async recall() {
              return "Chicago";
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
                  text: "1",
                  tokens: { input: 1, output: 1 },
                  latencyMs: 1,
                  model: "amemgym-test-responder",
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
                  model: "amemgym-test-judge",
                };
              },
            },
          },
        }),
      /AMemGym dataset file amemgym-v1-base\.json is invalid:/,
    );
    assert.equal(storeCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMemGym applies a positive limit before validating later profiles", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-amemgym-limit-"));

  try {
    await writeFile(
      path.join(tempDir, "data.json"),
      JSON.stringify([
        {
          id: "valid-prefix-profile",
          start_time: "2025-01-01T00:00:00Z",
          user_profile: {
            uuid: "user-1",
            name: "Maya",
            age: 29,
            gender: "female",
          },
          state_schema: { city: { type: "string" } },
          periods: [
            {
              period_start: "2025-01-01T00:00:00Z",
              period_end: "2025-01-31T23:59:59Z",
              period_summary: "Maya updated her city.",
              sessions: [],
              state: { city: "Chicago" },
              updates: { city: "Chicago" },
              update_cnts: { city: 1 },
            },
          ],
          qas: [
            {
              query: "What city does Maya live in now?",
              required_info: ["city"],
              answer_choices: [
                { state: ["Chicago"], answer: "Chicago" },
                { state: ["Austin"], answer: "Austin" },
              ],
            },
          ],
        },
        {
          id: "malformed-after-limit",
          qas: [],
        },
      ]),
      "utf8",
    );

    const result = await runAMemGymBenchmark({
      benchmark: amemGymDefinition,
      mode: "full",
      datasetDir: tempDir,
      limit: 1,
      system: {
        async store() {},
        async recall() {
          return "Chicago";
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
              text: "1",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "amemgym-test-responder",
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
              model: "amemgym-test-judge",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.taskId, "valid-prefix-profile-q0");
    assert.equal(result.results.tasks[0]?.scores.qa_accuracy, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMemGym rejects answer choices that do not match the final profile state", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-amemgym-bad-choice-"));
  let storeCalls = 0;

  try {
    await writeFile(
      path.join(tempDir, "amemgym-v1-base.json"),
      JSON.stringify([
        {
          id: "bad-choice-profile",
          start_time: "2025-01-01T00:00:00Z",
          user_profile: {
            uuid: "user-1",
            name: "Maya",
            age: 29,
            gender: "female",
          },
          state_schema: { city: { type: "string" } },
          periods: [
            {
              period_start: "2025-01-01T00:00:00Z",
              period_end: "2025-01-31T23:59:59Z",
              period_summary: "Maya updated her city.",
              sessions: [],
              state: { city: "Chicago" },
              updates: { city: "Chicago" },
              update_cnts: { city: 1 },
            },
          ],
          qas: [
            {
              query: "What city does Maya live in now?",
              required_info: ["city"],
              answer_choices: [
                { state: ["Austin"], answer: "Austin" },
                { state: ["Boston"], answer: "Boston" },
              ],
            },
          ],
        },
      ]),
      "utf8",
    );

    await assert.rejects(
      () =>
        runAMemGymBenchmark({
          benchmark: amemGymDefinition,
          mode: "full",
          datasetDir: tempDir,
          system: {
            async store() {
              storeCalls += 1;
            },
            async recall() {
              return "Austin";
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
          },
        }),
      /final state does not match any answer_choices state/,
    );
    assert.equal(storeCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMemGym fails fast when profile drain fails before scoring", async () => {
  let completedTasks = 0;
  let recallCalls = 0;

  await assert.rejects(
    () =>
      runAMemGymBenchmark({
        benchmark: amemGymDefinition,
        mode: "quick",
        onTaskComplete() {
          completedTasks += 1;
        },
        system: {
          async store() {},
          async recall() {
            recallCalls += 1;
            return "Chicago";
          },
          async search() {
            return [];
          },
          async reset() {},
          async drain() {
            throw new Error("drain timed out");
          },
          async destroy() {},
          async getStats() {
            return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
          },
          responder: {
            async respond() {
              return {
                text: "1",
                tokens: { input: 1, output: 1 },
                latencyMs: 1,
                model: "amemgym-test-responder",
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
                model: "amemgym-test-judge",
              };
            },
          },
        },
      }),
    /AMemGym drain failed for profile smoke-profile-1: drain timed out/,
  );

  assert.equal(recallCalls, 0);
  assert.equal(completedTasks, 0);
});
