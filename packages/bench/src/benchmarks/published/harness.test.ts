import assert from "node:assert/strict";
import test from "node:test";

import { runPublishedHarness, type HarnessContext, type HarnessPlan } from "./harness.ts";
import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions } from "../../types.ts";

interface FakeRecallAttribution {
  sessionId: string;
  appliedCap: number;
  atCapMemoryIds: string[];
  headroomMemoryIds: string[];
}

interface FakeAttributionWitness {
  schemaVersion: 1;
  runtime: {
    qmdCollection: string;
    qmdIndex: string;
    qmdMaxResults: number;
    attributionThreshold: number;
  };
  golds: Array<{
    goldMemory: string;
    storeMemoryIds: string[] | null;
    oracleMemoryIds: string[] | null;
  }>;
  retrievals: FakeRecallAttribution[];
}

interface FakeAttributionWitnessRequest {
  goldMemories: string[];
  retrievals: FakeRecallAttribution[];
}
function attributionWitnessFromTask(task: unknown): unknown {
  if (!task || typeof task !== "object" || !("attributionWitness" in task)) {
    return undefined;
  }
  return task.attributionWitness;
}


/**
 * Fake system under test that records every call into a deterministic
 * log. Recall always returns a synthesized string containing the session
 * ID + the question so tests can verify session routing.
 */
function makeFakeSystem(opts?: {
  recallPrefix?: string;
  searchHits?: number;
  judgeScore?: number;
  responderModel?: string;
  judgeModel?: string;
  omitResponderIdentity?: boolean;
  traceAttributionBySession?: Record<string, FakeRecallAttribution>;
  attributionWitness?: FakeAttributionWitness;
}) {
  const calls: Array<
    | { kind: "reset" }
    | { kind: "store"; sessionId: string; messageCount: number }
    | { kind: "drain" }
    | { kind: "recall"; sessionId: string; question: string }
    | { kind: "recallWithTrace"; sessionId: string; question: string }
    | {
        kind: "captureAttributionWitness";
        request: FakeAttributionWitnessRequest;
      }
    | { kind: "search"; query: string; limit: number }
    | { kind: "judge"; question: string; predicted: string; expected: string }
    | { kind: "binaryJudge"; prompt: string }
    | { kind: "respond"; question: string }
  > = [];

  const system = {
    async reset() {
      calls.push({ kind: "reset" });
    },
    async store(sessionId: string, messages: Array<unknown>) {
      calls.push({ kind: "store", sessionId, messageCount: messages.length });
    },
    async drain() {
      calls.push({ kind: "drain" });
    },
    async recall(sessionId: string, question: string) {
      calls.push({ kind: "recall", sessionId, question });
      return `${opts?.recallPrefix ?? "recall"}:${sessionId}:${question}`;
    },
    async recallWithTrace(sessionId: string, question: string) {
      calls.push({ kind: "recallWithTrace", sessionId, question });
      return {
        text: `${opts?.recallPrefix ?? "recall"}:${sessionId}:${question}`,
        trace: {
          schemaVersion: 1 as const,
          sensitivity: {
            classification: "restricted" as const,
            contentEncoding: "sha256+length" as const,
            containsGold: false as const,
          },
          sections: [],
          selections: [],
          lcmCandidates: [],
          budget: {
            requestedChars: 0,
            composedChars: 0,
            returnedChars: 0,
            truncated: false,
          },
        },
        attribution: opts?.traceAttributionBySession?.[sessionId],
      };
    },
    async captureAttributionWitness(request: FakeAttributionWitnessRequest) {
      calls.push({ kind: "captureAttributionWitness", request });
      return opts?.attributionWitness;
    },
    async search(query: string, limit: number) {
      calls.push({ kind: "search", query, limit });
      return new Array(opts?.searchHits ?? 0).fill({ id: "r", text: "t" });
    },
    async destroy() {},
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    responder: {
      async respond(question: string) {
        calls.push({ kind: "respond", question });
        return {
          text: `answer:${question}`,
          tokens: { input: 1, output: 2 },
          latencyMs: 1,
          model: opts?.responderModel ?? "smoke-responder",
        };
      },
      ...(opts?.omitResponderIdentity
        ? {}
        : {
            identity() {
              return `responder:${opts?.responderModel ?? "smoke-responder"}`;
            },
          }),
    },
    judge: {
      async score() {
        return opts?.judgeScore ?? 1;
      },
      async scoreWithMetrics(question: string, predicted: string, expected: string) {
        calls.push({ kind: "judge", question, predicted, expected });
        return {
          score: opts?.judgeScore ?? 1,
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          model: opts?.judgeModel ?? "smoke-judge",
        };
      },
      async scoreBinaryPrompt(prompt: string) {
        calls.push({ kind: "binaryJudge", prompt });
        return {
          score: opts?.judgeScore ?? 1,
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          model: opts?.judgeModel ?? "smoke-judge",
        };
      },
    },
  };
  return { system, calls };
}

const smokeDefinition: BenchmarkDefinition = {
  id: "harness-test",
  title: "Harness Test",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "harness-test",
    version: "0.0.0",
    description: "test",
    category: "retrieval",
    citation: "test",
  },
};

function makeOptions(
  system: ReturnType<typeof makeFakeSystem>["system"],
  overrides?: Partial<ResolvedRunBenchmarkOptions>
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: smokeDefinition,
    mode: "quick",
    system: system as unknown as ResolvedRunBenchmarkOptions["system"],
    seed: 42,
    ...overrides,
  };
}

test("runPublishedHarness resets once per plan and stores every non-empty session", async () => {
  const { system, calls } = makeFakeSystem();
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [
        { sessionId: "a", messages: [{ role: "user", content: "hi" }] },
        { sessionId: "empty", messages: [] },
        { sessionId: "b", messages: [{ role: "user", content: "hello" }] },
      ],
      trials: [
        {
          taskId: "t1",
          question: "Q1",
          expected: "A1",
          recallSessionIds: ["a", "b"],
        },
      ],
    },
    {
      ingestSessions: [{ sessionId: "c", messages: [{ role: "user", content: "x" }] }],
      trials: [
        {
          taskId: "t2",
          question: "Q2",
          expected: "A2",
          recallSessionIds: ["c"],
        },
      ],
    },
  ];

  const ctx: HarnessContext = {
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "contains_answer"] },
    plans,
  };
  const result = await runPublishedHarness(ctx);

  const resets = calls.filter((call) => call.kind === "reset");
  assert.equal(resets.length, 2, "expected one reset per plan");

  const stores = calls.filter((call) => call.kind === "store");
  assert.equal(stores.length, 3, "empty session should not be stored");
  assert.deepEqual(
    stores.map((store) => (store as any).sessionId),
    ["a", "b", "c"]
  );

  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.meta.seeds[0], 42);
  assert.equal(result.meta.benchmark, "harness-test");
  assert.equal(result.config.adapterMode, "direct");
});

test("runPublishedHarness resumes completed tasks without repeated model calls", async () => {
  const plans: HarnessPlan[] = [{
    ingestSessions: [{ sessionId: "resume", messages: [{ role: "user", content: "context" }] }],
    trials: [
      { taskId: "resume-1", question: "Q1", expected: "A1", recallSessionIds: ["resume"] },
      { taskId: "resume-2", question: "Q2", expected: "A2", recallSessionIds: ["resume"] },
    ],
  }];
  const firstSystem = makeFakeSystem();
  const first = await runPublishedHarness({
    options: makeOptions(firstSystem.system),
    metricsSpec: { metrics: ["contains_answer"] },
    plans,
  });
  const completed = new Map(first.results.tasks.map((task) => [task.taskId, task]));

  const resumedSystem = makeFakeSystem();
  const started: string[] = [];
  const resumed = await runPublishedHarness({
    options: makeOptions(resumedSystem.system, {
      resumeTasks: completed,
      onTaskStart: (taskId) => { started.push(taskId); },
      benchmarkOptions: { trialConcurrency: 1 },
    }),
    metricsSpec: { metrics: ["contains_answer"] },
    plans,
  });
  assert.deepEqual(started, []);
  assert.deepEqual(resumed.results.tasks, first.results.tasks);
  assert.equal(resumedSystem.calls.length, 0);

  const partialSystem = makeFakeSystem();
  const partialStarted: string[] = [];
  const partial = await runPublishedHarness({
    options: makeOptions(partialSystem.system, {
      resumeTasks: new Map([[first.results.tasks[0]!.taskId, first.results.tasks[0]!]]),
      onTaskStart: (taskId) => { partialStarted.push(taskId); },
      benchmarkOptions: { trialConcurrency: 1 },
    }),
    metricsSpec: { metrics: ["contains_answer"] },
    plans,
  });
  assert.deepEqual(partialStarted, ["resume-2"]);
  assert.equal(partial.results.tasks.length, 2);
  assert.equal(partialSystem.calls.filter((call) => call.kind === "respond").length, 1);
});

test("runPublishedHarness rejects drain failure before scoring trials", async () => {
  const { system, calls } = makeFakeSystem();
  system.drain = async () => {
    calls.push({ kind: "drain" });
    throw new Error("drain timed out");
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system),
        metricsSpec: { metrics: ["f1"] },
        plans: [
          {
            ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "x" }] }],
            trials: [
              {
                taskId: "must-not-score",
                question: "Q",
                expected: "A",
                recallSessionIds: ["s"],
              },
            ],
          },
        ],
      }),
    /drain failed before scoring.*drain timed out/
  );

  assert.ok(calls.some((call) => call.kind === "store"));
  assert.ok(calls.some((call) => call.kind === "drain"));
  assert.equal(
    calls.some((call) => call.kind === "recall"),
    false
  );
  assert.equal(
    calls.some((call) => call.kind === "respond"),
    false
  );
  assert.equal(
    calls.some((call) => call.kind === "judge"),
    false
  );



















});

test("runPublishedHarness recalls from ALL recallSessionIds per trial", async () => {
  const { system, calls } = makeFakeSystem();
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [
        { sessionId: "s1", messages: [{ role: "user", content: "x" }] },
        { sessionId: "s2", messages: [{ role: "user", content: "y" }] },
      ],
      trials: [
        {
          taskId: "multi",
          question: "who",
          expected: "nobody",
          recallSessionIds: ["s1", "s2"],
        },
      ],
    },
  ];

  await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans,
  });

  const recalls = calls.filter((call) => call.kind === "recall") as Array<{
    kind: "recall";
    sessionId: string;
    question: string;
  }>;
  assert.deepEqual(recalls.map((recall) => recall.sessionId).sort(), ["s1", "s2"]);
  for (const recall of recalls) {
    assert.equal(recall.question, "who");
  }
});

test("runPublishedHarness executes independent trials concurrently with stable output order", async () => {
  const { system } = makeFakeSystem();
  let activeResponders = 0;
  let maxActiveResponders = 0;
  const originalRespond = system.responder.respond.bind(system.responder);
  system.responder.respond = async (...args) => {
    activeResponders += 1;
    maxActiveResponders = Math.max(maxActiveResponders, activeResponders);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await originalRespond(...args);
    } finally {
      activeResponders -= 1;
    }
  };
  const completedTaskIds: string[] = [];

  const result = await runPublishedHarness({
    options: makeOptions(system, {
      benchmarkOptions: { trialConcurrency: 2 },
      onTaskComplete: (task) => {
        completedTaskIds.push(task.taskId);
      },
    }),
    metricsSpec: { metrics: ["f1"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "x" }] }],
        trials: [
          {
            taskId: "t1",
            question: "Q1",
            expected: "A1",
            recallSessionIds: ["s"],
          },
          {
            taskId: "t2",
            question: "Q2",
            expected: "A2",
            recallSessionIds: ["s"],
          },
          {
            taskId: "t3",
            question: "Q3",
            expected: "A3",
            recallSessionIds: ["s"],
          },
        ],
      },
    ],
  });

  assert.equal(maxActiveResponders, 2);
  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    ["t1", "t2", "t3"]
  );
  assert.deepEqual(completedTaskIds, ["t1", "t2", "t3"]);
});

test("runPublishedHarness rejects invalid trialConcurrency", async () => {
  const { system } = makeFakeSystem();
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          benchmarkOptions: { trialConcurrency: 0 },
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [],
      }),
    /trialConcurrency must be an integer from 1 to 64/
  );
});

test("runPublishedHarness postAnswerHook runs between answer and judge", async () => {
  const { system, calls } = makeFakeSystem({ searchHits: 4 });
  const order: string[] = [];
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "hi" }] }],
      trials: [
        {
          taskId: "hooked",
          question: "q",
          expected: "a",
          recallSessionIds: ["s"],
          postAnswerHook: async () => {
            order.push("hook");
            const results = await system.search("q", 10);
            return { extraScores: { search_hits: results.length } };
          },
        },
      ],
    },
  ];

  const originalJudge = system.judge.scoreWithMetrics.bind(system.judge);
  system.judge.scoreWithMetrics = async (...args) => {
    order.push("judge");
    return originalJudge(...args);
  };
  const originalRespond = system.responder.respond.bind(system.responder);
  system.responder.respond = async (...args) => {
    order.push("respond");
    return originalRespond(...args);
  };

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "llm_judge"] },
    plans,
  });

  assert.deepEqual(order, ["respond", "hook", "judge"]);
  assert.equal(result.results.tasks[0]?.scores.search_hits, 4);
  // Search call happened on the live system during the hook.
  assert.ok(calls.some((call) => call.kind === "search"));
});


test("runPublishedHarness skips the replay cache when the responder omits an identity", async () => {
  const baseline = makeFakeSystem({
    recallPrefix: "shared",
    responderModel: "baseline-responder",
    omitResponderIdentity: true,
  });
  const real = makeFakeSystem({
    recallPrefix: "shared",
    responderModel: "real-responder",
    omitResponderIdentity: true,
  });
  let baselineResponds = 0;
  let realResponds = 0;
  baseline.system.responder.respond = async () => {
    baselineResponds++;
    return {
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "baseline-responder",
    };
  };
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "real-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [{ taskId: "paired", question: "What happened?", expected: "baseline answer", recallSessionIds: ["session"] }],
  };
  const run = (
    system: typeof baseline.system,
    runtimeProfile: "baseline" | "real",
  ) =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const baselineResult = await run(baseline.system, "baseline");
  const realResult = await run(real.system, "real");

  assert.equal(baselineResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(baselineResponds, 1, "baseline must invoke its responder when no identity is declared");
  assert.equal(realResponds, 1, "real must invoke its responder when no identity is declared");
  assert.equal(pairedAnswerReplayCache.size, 0, "no entries may be stored without an identity");
});
test("runPublishedHarness forwards per-trial answer format to strict answering", async () => {
  const { system, calls } = makeFakeSystem();
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "hi" }] }],
        trials: [
          {
            taskId: "short-answer",
            question: "Which city did Maya move to?",
            expected: "Seattle",
            recallSessionIds: ["s"],
            answerFormat: "short",
          },
        ],
      },
    ],
  });

  const respond = calls.find((call) => call.kind === "respond") as { kind: "respond"; question: string } | undefined;
  assert.ok(respond);
  assert.match(respond.question, /shortest complete answer/);
  assert.equal(result.results.tasks[0]?.details?.answerFormat, "short");
});

import {
  BenchmarkRunBlockedError,
  BenchmarkRunBlockReason,
  findBenchmarkRunBlockedError,
  isBenchmarkRunBlockedError,
} from "../../benchmark-run-blocked-error.ts";

test("runPublishedHarness llm_judge metric suppressed when judge score negative", async () => {
  const { system } = makeFakeSystem({ judgeScore: -1 });
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "llm_judge"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "h" }] }],
        trials: [
          {
            taskId: "no-judge",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
          },
        ],
      },
    ],
  });
  const task = result.results.tasks[0]!;
  assert.ok("f1" in task.scores, "f1 should be present");
  assert.ok(!("llm_judge" in task.scores), "llm_judge should be omitted when judge returns negative");
});

test("runPublishedHarness records failed judge_accuracy when judge score is negative", async () => {
  const { system } = makeFakeSystem({ judgeScore: -1 });
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["llm_judge", "judge_accuracy"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "h" }] }],
        trials: [
          {
            taskId: "invalid-binary-judge",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
            binaryJudgePrompt: () => "official yes/no prompt",
          },
        ],
      },
    ],
  });

  const task = result.results.tasks[0]!;
  assert.ok(!("llm_judge" in task.scores));
  assert.equal(task.scores.judge_accuracy, -1);
  assert.equal(result.results.aggregates.judge_accuracy?.mean, -1);
  assert.equal(result.meta.status, undefined, "a legitimate negative judge score is not a transport failure");
});

test("runPublishedHarness marks caught provider failures partial without hiding the failed task", async () => {
  const { system } = makeFakeSystem();
  system.responder.respond = async () => {
    throw new Error("provider HTTP 400: model is unavailable");
  };
  const completedTaskIds: string[] = [];

  const result = await runPublishedHarness({
    options: makeOptions(system, {
      onTaskComplete: (task) => completedTaskIds.push(task.taskId),
    }),
    metricsSpec: { metrics: ["f1", "llm_judge"] },
    plans: [
      {
        ingestSessions: [],
        trials: [
          {
            taskId: "provider-failure",
            question: "q",
            expected: "a",
            recallSessionIds: [],
          },
        ],
      },
    ],
  });

  assert.equal(result.meta.status, "partial");
  assert.match(result.meta.failureReason ?? "", /trial_execution_failure.*provider-failure.*HTTP 400/);
  assert.deepEqual(completedTaskIds, ["provider-failure"]);
  assert.equal(result.results.tasks.length, 1);
  assert.deepEqual(result.results.tasks[0]?.scores, { f1: -1, llm_judge: -1 });
  assert.deepEqual(result.results.tasks[0]?.details?.benchmarkFailure, {
    kind: "trial_execution_failure",
    message: "provider HTTP 400: model is unavailable",
  });
});

test("run-terminal detection follows wrapped causes and terminates on cyclic cause graphs", () => {
  const blocked = new BenchmarkRunBlockedError(
    BenchmarkRunBlockReason.ManualReconciliationRequired,
    "credit ledger requires reconciliation"
  );
  const wrapped = new Error("provider wrapper", { cause: blocked });
  assert.equal(findBenchmarkRunBlockedError(wrapped), blocked);
  assert.equal(isBenchmarkRunBlockedError(wrapped), true);

  const first = new Error("first") as Error & { cause?: unknown };
  const second = new Error("second") as Error & { cause?: unknown };
  first.cause = second;
  second.cause = first;
  assert.equal(findBenchmarkRunBlockedError(first), undefined);
  assert.equal(isBenchmarkRunBlockedError(first), false);
});

test("runPublishedHarness stops sequential plans on a terminal responder error", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  system.responder.respond = async (question: string) => {
    calls.push({ kind: "respond", question });
    if (question.includes("blocked")) {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.SpendHeadroomExhausted,
        "credit headroom is exhausted"
      );
    }
    return {
      text: `answer:${question}`,
      tokens: { input: 1, output: 2 },
      latencyMs: 1,
      model: "smoke-responder",
    };
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [
          {
            ingestSessions: [],
            trials: [
              {
                taskId: "before",
                question: "before",
                expected: "answer:before",
                recallSessionIds: [],
              },
            ],
          },
          {
            ingestSessions: [],
            trials: [
              {
                taskId: "blocked",
                question: "blocked",
                expected: "never",
                recallSessionIds: [],
                answerFallback: () => "must not mask a run-terminal error",
              },
            ],
          },
          {
            ingestSessions: [],
            trials: [
              {
                taskId: "after",
                question: "after",
                expected: "answer:after",
                recallSessionIds: [],
              },
            ],
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.SpendHeadroomExhausted
  );

  assert.deepEqual(completedTaskIds, ["before"]);
  assert.equal(calls.filter((call) => call.kind === "reset").length, 2);
  assert.deepEqual(
    calls
      .filter((call): call is { kind: "respond"; question: string } => call.kind === "respond")
      .map((call) => call.question.split("\n", 1)[0]),
    ["before", "blocked"]
  );
});

test("runPublishedHarness stops sequential trials on a terminal scoreWithMetrics error", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  system.judge.scoreWithMetrics = async (question, predicted, expected) => {
    calls.push({ kind: "judge", question, predicted, expected });
    throw new Error("judge wrapper", {
      cause: new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "judge credits require reconciliation"
      ),
    });
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["llm_judge"] },
        plans: [
          {
            ingestSessions: [],
            trials: ["Q1", "Q2"].map((question, index) => ({
              taskId: `t${index + 1}`,
              question,
              expected: `answer:${question}`,
              recallSessionIds: [],
            })),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired
  );

  assert.deepEqual(completedTaskIds, []);
  assert.equal(calls.filter((call) => call.kind === "respond").length, 1);
  assert.equal(calls.filter((call) => call.kind === "judge").length, 1);
});

test("runPublishedHarness stops concurrent dequeue on a wrapped terminal error", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  let started = 0;
  let releaseStarted!: () => void;
  const startedTogether = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });

  system.responder.respond = async (question: string) => {
    calls.push({ kind: "respond", question });
    started += 1;
    if (started === 3) {
      releaseStarted();
    }
    await startedTogether;
    if (question.includes("Q2")) {
      throw new Error("provider wrapper", {
        cause: new BenchmarkRunBlockedError(BenchmarkRunBlockReason.ResourceLocked, "credit ledger is locked"),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      text: `answer:${question}`,
      tokens: { input: 1, output: 2 },
      latencyMs: 1,
      model: "smoke-responder",
    };
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          benchmarkOptions: { trialConcurrency: 3 },
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [
          {
            ingestSessions: [],
            trials: ["Q1", "Q2", "Q3", "Q4"].map((question, index) => ({
              taskId: `t${index + 1}`,
              question,
              expected: `answer:${question}`,
              recallSessionIds: [],
            })),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.ResourceLocked
  );

  assert.deepEqual(completedTaskIds, ["t1"]);
  assert.deepEqual(
    calls
      .filter((call): call is { kind: "respond"; question: string } => call.kind === "respond")
      .map((call) => call.question.split("\n", 1)[0])
      .sort(),
    ["Q1", "Q2", "Q3"]
  );
});

test("runPublishedHarness does not launch a new wave while an earlier trial can still terminate the run", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  let pendingStarted = 0;
  let releasePending!: () => void;
  const pendingTogether = new Promise<void>((resolve) => {
    releasePending = resolve;
  });

  system.responder.respond = async (question: string) => {
    calls.push({ kind: "respond", question });
    const taskQuestion = question.split("\n", 1)[0] ?? "";
    if (taskQuestion === "Q1") {
      return {
        text: "answer:Q1",
        tokens: { input: 1, output: 2 },
        latencyMs: 1,
        model: "smoke-responder",
      };
    }
    if (taskQuestion === "Q4") {
      throw new Error("Q4 must not start before the first wave settles");
    }

    pendingStarted += 1;
    if (pendingStarted === 2) {
      releasePending();
    }
    await pendingTogether;
    if (taskQuestion === "Q2") {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "Q2 discovered a terminal accounting state"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      text: `answer:${taskQuestion}`,
      tokens: { input: 1, output: 2 },
      latencyMs: 1,
      model: "smoke-responder",
    };
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          benchmarkOptions: { trialConcurrency: 3 },
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [
          {
            ingestSessions: [],
            trials: ["Q1", "Q2", "Q3", "Q4"].map((question, index) => ({
              taskId: `t${index + 1}`,
              question,
              expected: `answer:${question}`,
              recallSessionIds: [],
            })),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired
  );

  assert.deepEqual(completedTaskIds, ["t1"]);
  assert.deepEqual(
    calls
      .filter((call): call is { kind: "respond"; question: string } => call.kind === "respond")
      .map((call) => call.question.split("\n", 1)[0])
      .sort(),
    ["Q1", "Q2", "Q3"]
  );
});

test("runPublishedHarness emits only the prefix before the earliest of two concurrent terminal errors", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  const terminalOrder: string[] = [];
  let started = 0;
  let releaseStarted!: () => void;
  const startedTogether = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });

  system.responder.respond = async (question: string) => {
    calls.push({ kind: "respond", question });
    const taskQuestion = question.split("\n", 1)[0]!;
    started += 1;
    if (started === 3) {
      releaseStarted();
    }
    await startedTogether;

    if (taskQuestion === "Q3") {
      terminalOrder.push("t3");
      throw new BenchmarkRunBlockedError(BenchmarkRunBlockReason.ResourceLocked, "later ordinal failed first");
    }
    if (taskQuestion === "Q2") {
      await new Promise((resolve) => setTimeout(resolve, 15));
      terminalOrder.push("t2");
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.ManualReconciliationRequired,
        "earlier ordinal failed later"
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      text: `answer:${taskQuestion}`,
      tokens: { input: 1, output: 2 },
      latencyMs: 1,
      model: "smoke-responder",
    };
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          benchmarkOptions: { trialConcurrency: 3 },
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [
          {
            ingestSessions: [],
            trials: ["Q1", "Q2", "Q3", "Q4"].map((question, index) => ({
              taskId: `t${index + 1}`,
              question,
              expected: `answer:${question}`,
              recallSessionIds: [],
            })),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError &&
      error.reason === BenchmarkRunBlockReason.ManualReconciliationRequired &&
      error.message === "earlier ordinal failed later"
  );

  assert.deepEqual(terminalOrder, ["t3", "t2"]);
  assert.deepEqual(completedTaskIds, ["t1"]);
  assert.deepEqual(
    calls
      .filter((call): call is { kind: "respond"; question: string } => call.kind === "respond")
      .map((call) => call.question.split("\n", 1)[0])
      .sort(),
    ["Q1", "Q2", "Q3"]
  );
});

test("runPublishedHarness stops concurrent dequeue on a terminal binary judge error", async () => {
  const { system, calls } = makeFakeSystem();
  const completedTaskIds: string[] = [];
  let startedJudges = 0;
  let releaseJudges!: () => void;
  const judgesStarted = new Promise<void>((resolve) => {
    releaseJudges = resolve;
  });

  system.judge.scoreBinaryPrompt = async (prompt: string) => {
    calls.push({ kind: "binaryJudge", prompt });
    startedJudges += 1;
    if (startedJudges === 2) {
      releaseJudges();
    }
    await judgesStarted;
    if (prompt.includes("Q2")) {
      throw new BenchmarkRunBlockedError(
        BenchmarkRunBlockReason.SpendHeadroomExhausted,
        "binary judge credit headroom is exhausted"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      score: 1,
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
      model: "smoke-judge",
    };
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, {
          benchmarkOptions: { trialConcurrency: 2 },
          onTaskComplete: (task) => completedTaskIds.push(task.taskId),
        }),
        metricsSpec: { metrics: ["llm_judge", "judge_accuracy"] },
        plans: [
          {
            ingestSessions: [],
            trials: ["Q1", "Q2", "Q3"].map((question, index) => ({
              taskId: `t${index + 1}`,
              question,
              expected: `answer:${question}`,
              recallSessionIds: [],
              binaryJudgePrompt: () => `Official binary prompt for ${question}`,
            })),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof BenchmarkRunBlockedError && error.reason === BenchmarkRunBlockReason.SpendHeadroomExhausted
  );

  assert.deepEqual(completedTaskIds, ["t1"]);
  assert.deepEqual(
    calls
      .filter((call): call is { kind: "respond"; question: string } => call.kind === "respond")
      .map((call) => call.question.split("\n", 1)[0])
      .sort(),
    ["Q1", "Q2"]
  );
  assert.equal(calls.filter((call) => call.kind === "binaryJudge").length, 2);
});

test("runPublishedHarness supports benchmark-owned binary judge prompts", async () => {
  const { system, calls } = makeFakeSystem({ judgeScore: 0.8 });
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["llm_judge", "judge_accuracy"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "h" }] }],
        trials: [
          {
            taskId: "binary-judge",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
            binaryJudgePrompt: ({ answeredText }) => `Official binary prompt\nMODEL_RESPONSE:\n${answeredText}`,
          },
        ],
      },
    ],
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.llm_judge, 0.8);
  assert.equal(task.scores.judge_accuracy, 1);
  const binaryJudgeCall = calls.find((call) => call.kind === "binaryJudge");
  assert.ok(binaryJudgeCall, "binary judge prompt should be used");
  assert.match(binaryJudgeCall.prompt, /^Official binary prompt\nMODEL_RESPONSE:\nanswer:/);
  assert.ok(!calls.some((call) => call.kind === "judge"), "generic judge rubric should not be used");
});

test("runPublishedHarness falls back when judge lacks binary prompt support", async () => {
  const { system, calls } = makeFakeSystem({ judgeScore: 0.4 });
  delete (system.judge as { scoreBinaryPrompt?: unknown }).scoreBinaryPrompt;

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["llm_judge", "judge_accuracy"] },
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "h" }] }],
        trials: [
          {
            taskId: "binary-judge-fallback",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
            binaryJudgePrompt: () => "official yes/no prompt",
          },
        ],
      },
    ],
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.scores.llm_judge, 0.4);
  assert.equal(task.scores.judge_accuracy, 0);
  assert.ok(
    calls.some((call) => call.kind === "judge"),
    "generic judge rubric should be used as the compatibility fallback"
  );
  assert.ok(!calls.some((call) => call.kind === "binaryJudge"), "binary judge should not be called when unavailable");
});

test("runPublishedHarness is deterministic across repeated runs with same seed", async () => {
  async function run(): Promise<BenchmarkResult> {
    const { system } = makeFakeSystem();
    return await runPublishedHarness({
      options: makeOptions(system, { seed: 7 }),
      metricsSpec: { metrics: ["f1", "contains_answer", "rouge_l"] },
      plans: [
        {
          ingestSessions: [
            {
              sessionId: "s",
              messages: [{ role: "user", content: "hello world" }],
            },
          ],
          trials: [
            {
              taskId: "det-1",
              question: "say hello",
              expected: "hello",
              recallSessionIds: ["s"],
            },
          ],
        },
      ],
    });
  }

  const a = await run();
  const b = await run();

  // `id` and `timestamp` are non-deterministic by design (UUID +
  // wall-clock). Every other field must be identical.
  assert.equal(a.meta.seeds[0], b.meta.seeds[0]);
  assert.equal(a.meta.mode, b.meta.mode);
  assert.equal(a.meta.benchmark, b.meta.benchmark);
  assert.equal(a.results.tasks.length, b.results.tasks.length);
  for (let i = 0; i < a.results.tasks.length; i += 1) {
    const taskA = a.results.tasks[i]!;
    const taskB = b.results.tasks[i]!;
    assert.equal(taskA.taskId, taskB.taskId);
    assert.equal(taskA.actual, taskB.actual);
    assert.deepEqual(taskA.scores, taskB.scores);
  }
});

test("runPublishedHarness rejects unknown metric id", async () => {
  const { system } = makeFakeSystem();
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system),
        // @ts-expect-error intentional invalid metric
        metricsSpec: { metrics: ["not-a-metric"] },
        plans: [],
      }),
    /unknown metric/
  );
});

test("runPublishedHarness rejects negative or non-integer seed", async () => {
  const { system } = makeFakeSystem();
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, { seed: -1 }),
        metricsSpec: { metrics: ["f1"] },
        plans: [],
      }),
    /seed must be a non-negative integer/
  );
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, { seed: 1.5 }),
        metricsSpec: { metrics: ["f1"] },
        plans: [],
      }),
    /seed must be a non-negative integer/
  );
});

test("runPublishedHarness skips LLM judge when llm_judge is not in metrics spec", async () => {
  const { system, calls } = makeFakeSystem();
  let judgeInvocations = 0;
  const originalJudge = system.judge.scoreWithMetrics.bind(system.judge);
  system.judge.scoreWithMetrics = async (...args) => {
    judgeInvocations += 1;
    return originalJudge(...args);
  };

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "contains_answer"] }, // no llm_judge
    plans: [
      {
        ingestSessions: [{ sessionId: "s", messages: [{ role: "user", content: "hi" }] }],
        trials: [
          {
            taskId: "no-judge-billing",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
          },
        ],
      },
    ],
  });
  assert.equal(judgeInvocations, 0, "judge should not be invoked");
  const task = result.results.tasks[0]!;
  assert.ok(!("llm_judge" in task.scores));
  // Judge latency/tokens should NOT be folded into cost totals.
  assert.equal(result.cost.inputTokens, 1); // responder only
  assert.equal(result.cost.outputTokens, 2); // responder only
  assert.ok(!calls.some((call) => call.kind === "judge"), "no judge call should have been made");
});

test("runPublishedHarness produces empty result for empty plans", async () => {
  const { system } = makeFakeSystem();
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [],
  });
  assert.equal(result.results.tasks.length, 0);
  assert.equal(result.cost.meanQueryLatencyMs, 0);
  assert.equal(result.meta.status, undefined, "an empty dataset is not a backend failure");
});
test("runPublishedHarness reuses an answer only for an identical paired input", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  let baselineResponds = 0;
  let realResponds = 0;
  baseline.system.responder.respond = async () => {
    baselineResponds++;
    return {
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      { taskId: "paired", question: "What happened?", expected: "baseline answer", recallSessionIds: ["session"] },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "real") =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const baselineResult = await run(baseline.system, "baseline");
  const realResult = await run(real.system, "real");

  assert.equal(baselineResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(realResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(baselineResponds, 1);
  assert.equal(realResponds, 0);
});

test("runPublishedHarness never replays a real answer into baseline", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  let baselineResponds = 0;
  let realResponds = 0;
  baseline.system.responder.respond = async () => {
    baselineResponds++;
    return {
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      { taskId: "paired", question: "What happened?", expected: "baseline answer", recallSessionIds: ["session"] },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "real") =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const realResult = await run(real.system, "real");
  const baselineResult = await run(baseline.system, "baseline");

  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(baselineResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(baselineResult.results.tasks[0]?.details?.pairedAnswerReusedFrom, undefined);
  assert.equal(realResponds, 1);
  assert.equal(baselineResponds, 1);
});

test("runPublishedHarness does not replay across different responder models", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  let baselineResponds = 0;
  let realResponds = 0;
  baseline.system.responder.respond = async () => {
    baselineResponds++;
    return {
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "baseline-responder",
    };
  };
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "real-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      { taskId: "paired", question: "What happened?", expected: "baseline answer", recallSessionIds: ["session"] },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "real", model: string) =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
        systemProvider: { provider: "openai", model },
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const baselineResult = await run(baseline.system, "baseline", "baseline-model");
  const realResult = await run(real.system, "real", "real-model");

  assert.equal(baselineResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(baselineResponds, 1);
  assert.equal(realResponds, 1);
});

test("runPublishedHarness does not replay a baseline fallback answer", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  baseline.system.responder.respond = async () => {
    throw new Error("baseline responder unavailable");
  };
  let realResponds = 0;
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      {
        taskId: "paired",
        question: "What happened?",
        expected: "fallback answer",
        recallSessionIds: ["session"],
        answerFallback: () => "fallback answer",
      },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "real") =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const baselineResult = await run(baseline.system, "baseline");
  const realResult = await run(real.system, "real");

  assert.equal(baselineResult.results.tasks[0]?.actual, "fallback answer");
  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(realResponds, 1);
});

test("runPublishedHarness preserves a baseline replay answer across another profile", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const localLab = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  let baselineResponds = 0;
  let localLabResponds = 0;
  let realResponds = 0;
  baseline.system.responder.respond = async () => {
    baselineResponds++;
    return {
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  localLab.system.responder.respond = async () => {
    localLabResponds++;
    return {
      text: "local-lab answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      { taskId: "paired", question: "What happened?", expected: "baseline answer", recallSessionIds: ["session"] },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "local-lab" | "real") =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  await run(baseline.system, "baseline");
  await run(localLab.system, "local-lab");
  const realResult = await run(real.system, "real");

  assert.equal(realResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(baselineResponds, 1);
  assert.equal(localLabResponds, 1);
  assert.equal(realResponds, 0);
});

test("runPublishedHarness does not replay a baseline answer after a later trial failure", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  let realResponds = 0;
  baseline.system.responder.respond = async () => ({
    text: "baseline answer",
    tokens: { input: 1, output: 1 },
    latencyMs: 1,
    model: "shared-responder",
  });
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  let shouldFail = true;
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      {
        taskId: "accepted",
        question: "What happened?",
        expected: "baseline answer",
        recallSessionIds: ["session"],
      },
      {
        taskId: "failed",
        question: "What failed?",
        expected: "baseline answer",
        recallSessionIds: ["session"],
        postAnswerHook: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("late trial failure");
          }
          return {};
        },
      },
    ],
  };
  const run = (system: typeof baseline.system, runtimeProfile: "baseline" | "real") =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  const baselineResult = await run(baseline.system, "baseline");
  const realResult = await run(real.system, "real");

  assert.match(baselineResult.results.tasks[1]?.actual ?? "", /late trial failure/);
  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(realResponds, 2);
});

test("runPublishedHarness clears staged baseline replay entries after a terminal abort", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  baseline.system.responder.respond = async () => ({
    text: "baseline answer",
    tokens: { input: 1, output: 1 },
    latencyMs: 1,
    model: "shared-responder",
  });
  let realResponds = 0;
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  let baselineResets = 0;
  baseline.system.reset = async () => {
    baselineResets++;
    if (baselineResets === 2) {
      throw new Error("terminal baseline abort");
    }
  };
  const pairedAnswerReplayCache = new Map();
  const scoredPlan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      {
        taskId: "paired",
        question: "What happened?",
        expected: "baseline answer",
        recallSessionIds: ["session"],
      },
    ],
  };

  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(baseline.system, {
          pairedAnswerReplayCache,
          runtimeProfile: "baseline",
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [scoredPlan, { ingestSessions: [], trials: [] }],
      }),
    /terminal baseline abort/,
  );
  assert.equal(pairedAnswerReplayCache.size, 0);

  const realResult = await runPublishedHarness({
    options: makeOptions(real.system, {
      pairedAnswerReplayCache,
      runtimeProfile: "real",
    }),
    metricsSpec: { metrics: ["f1"] },
    plans: [scoredPlan],
  });
  assert.equal(realResult.results.tasks[0]?.actual, "real answer");
  assert.equal(realResponds, 1);
});

test("paired replay keys include every responder-affecting provider option", async () => {
  type SystemProvider = NonNullable<ResolvedRunBenchmarkOptions["systemProvider"]>;
  const baseProvider: SystemProvider = {
    provider: "openai",
    model: "gpt-test",
    baseUrl: "https://example.test/v1",
    retryOptions: { maxAttempts: 3, baseBackoffMs: 100 },
    providerRequestTimeoutMs: 1_000,
    disableThinking: false,
    reasoningEffort: "low",
    responderContextBudgetChars: 4_000,
    responderPromptBudgetChars: 2_000,
    temperature: 0,
    seed: 1,
  };
  const variants: Array<[string, SystemProvider]> = [
    ["provider", { ...baseProvider, provider: "anthropic" }],
    ["model", { ...baseProvider, model: "gpt-other" }],
    ["baseUrl", { ...baseProvider, baseUrl: "https://other.example.test/v1" }],
    ["retryOptions", { ...baseProvider, retryOptions: { maxAttempts: 4, baseBackoffMs: 100 } }],
    ["providerRequestTimeoutMs", { ...baseProvider, providerRequestTimeoutMs: 2_000 }],
    ["disableThinking", { ...baseProvider, disableThinking: true }],
    ["reasoningEffort", { ...baseProvider, reasoningEffort: "high" }],
    ["responderContextBudgetChars", { ...baseProvider, responderContextBudgetChars: 5_000 }],
    ["responderPromptBudgetChars", { ...baseProvider, responderPromptBudgetChars: 3_000 }],
    ["temperature", { ...baseProvider, temperature: 0.5 }],
    ["seed", { ...baseProvider, seed: 2 }],
  ];
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      {
        taskId: "paired",
        question: "What happened?",
        expected: "baseline answer",
        recallSessionIds: ["session"],
      },
    ],
  };

  for (const [field, realProvider] of variants) {
    const baseline = makeFakeSystem({ recallPrefix: "shared" });
    const real = makeFakeSystem({ recallPrefix: "shared" });
    baseline.system.responder.respond = async () => ({
      text: "baseline answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    });
    let realResponds = 0;
    real.system.responder.respond = async () => {
      realResponds++;
      return {
        text: "real answer",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        model: "shared-responder",
      };
    };
    const pairedAnswerReplayCache = new Map();
    const run = (
      system: typeof baseline.system,
      runtimeProfile: "baseline" | "real",
      systemProvider: SystemProvider,
    ) =>
      runPublishedHarness({
        options: makeOptions(system, {
          pairedAnswerReplayCache,
          runtimeProfile,
          systemProvider,
        }),
        metricsSpec: { metrics: ["f1"] },
        plans: [plan],
      });

    await run(baseline.system, "baseline", baseProvider);
    const realResult = await run(real.system, "real", realProvider);
    assert.equal(realResult.results.tasks[0]?.actual, "real answer", field);
    assert.equal(realResponds, 1, `${field} must prevent paired replay`);
  }
});

test("paired replay keys canonicalize nested retry option order", async () => {
  const baseline = makeFakeSystem({ recallPrefix: "shared" });
  const real = makeFakeSystem({ recallPrefix: "shared" });
  baseline.system.responder.respond = async () => ({
    text: "baseline answer",
    tokens: { input: 1, output: 1 },
    latencyMs: 1,
    model: "shared-responder",
  });
  let realResponds = 0;
  real.system.responder.respond = async () => {
    realResponds++;
    return {
      text: "real answer",
      tokens: { input: 1, output: 1 },
      latencyMs: 1,
      model: "shared-responder",
    };
  };
  const pairedAnswerReplayCache = new Map();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "session", messages: [{ role: "user", content: "memory" }] }],
    trials: [
      {
        taskId: "paired",
        question: "What happened?",
        expected: "baseline answer",
        recallSessionIds: ["session"],
      },
    ],
  };
  const run = (
    system: typeof baseline.system,
    runtimeProfile: "baseline" | "real",
    retryOptions: NonNullable<NonNullable<ResolvedRunBenchmarkOptions["systemProvider"]>["retryOptions"]>,
  ) =>
    runPublishedHarness({
      options: makeOptions(system, {
        pairedAnswerReplayCache,
        runtimeProfile,
        systemProvider: {
          provider: "openai",
          model: "gpt-test",
          retryOptions,
        },
      }),
      metricsSpec: { metrics: ["f1"] },
      plans: [plan],
    });

  await run(baseline.system, "baseline", { maxAttempts: 3, baseBackoffMs: 100 });
  const realResult = await run(real.system, "real", { baseBackoffMs: 100, maxAttempts: 3 });
  assert.equal(realResult.results.tasks[0]?.actual, "baseline answer");
  assert.equal(realResponds, 0);
});

test("runPublishedHarness preserves goldMemories on TaskResult in success path", async () => {
  const { system } = makeFakeSystem();
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "s1", messages: [{ role: "user", content: "m" }] }],
    trials: [
      {
        taskId: "t1",
        question: "q1",
        expected: "e1",
        recallSessionIds: ["s1"],
        goldMemories: ["Gold fact 1", "Gold fact 2"],
      },
    ],
  };
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [plan],
  });
  assert.equal(result.results.tasks.length, 1);
  assert.deepEqual(result.results.tasks[0]?.goldMemories, ["Gold fact 1", "Gold fact 2"]);
});

test("runPublishedHarness preserves goldMemories on TaskResult in trial execution failure path", async () => {
  const { system } = makeFakeSystem();
  system.responder.respond = async () => {
    throw new Error("Simulated responder failure");
  };
  const plan: HarnessPlan = {
    ingestSessions: [{ sessionId: "s1", messages: [{ role: "user", content: "m" }] }],
    trials: [
      {
        taskId: "t1",
        question: "q1",
        expected: "e1",
        recallSessionIds: ["s1"],
        goldMemories: ["Gold fact 1", "Gold fact 2"],
      },
    ],
  };
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [plan],
  });
  assert.equal(result.results.tasks.length, 1);
  assert.deepEqual(result.results.tasks[0]?.goldMemories, ["Gold fact 1", "Gold fact 2"]);
  assert.equal(result.results.tasks[0]?.actual, "(error: Simulated responder failure)");
});

test("runPublishedHarness captures one ordered attribution witness before the next plan reset", async () => {
  const retrievals: FakeRecallAttribution[] = [
    {
      sessionId: "session-beta",
      appliedCap: 2,
      atCapMemoryIds: ["fact-beta-2", "fact-beta-1"],
      headroomMemoryIds: ["fact-beta-3"],
    },
    {
      sessionId: "session-alpha",
      appliedCap: 1,
      atCapMemoryIds: ["fact-alpha-1"],
      headroomMemoryIds: ["fact-alpha-2", "fact-alpha-3"],
    },
  ];
  const witness: FakeAttributionWitness = {
    schemaVersion: 1,
    runtime: {
      qmdCollection: "remnic-bench-runtime-hot",
      qmdIndex: "remnic-bench-runtime-index",
      qmdMaxResults: 37,
      attributionThreshold: 0.6,
    },
    golds: [
      {
        goldMemory: "Gold fact one",
        storeMemoryIds: ["fact-beta-2"],
        oracleMemoryIds: ["fact-beta-2", "fact-alpha-1"],
      },
      {
        goldMemory: "Gold fact two",
        storeMemoryIds: [],
        oracleMemoryIds: null,
      },
    ],
    retrievals,
  };
  const { system, calls } = makeFakeSystem({
    traceAttributionBySession: Object.fromEntries(
      retrievals.map((retrieval) => [retrieval.sessionId, retrieval]),
    ),
    attributionWitness: witness,
  });

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [
      {
        ingestSessions: [
          { sessionId: "session-beta", messages: [{ role: "user", content: "beta" }] },
          { sessionId: "session-alpha", messages: [{ role: "user", content: "alpha" }] },
        ],
        trials: [{
          taskId: "witness-task",
          question: "What should be remembered?",
          expected: "answer",
          recallSessionIds: ["session-beta", "session-alpha"],
          goldMemories: ["Gold fact one", "Gold fact two"],
        }],
      },
      {
        ingestSessions: [],
        trials: [{
          taskId: "legacy-task",
          question: "Does the next plan still run?",
          expected: "answer",
          recallSessionIds: [],
        }],
      },
    ],
  });

  const captureCalls = calls.filter(
    (call): call is Extract<(typeof calls)[number], { kind: "captureAttributionWitness" }> =>
      call.kind === "captureAttributionWitness",
  );
  assert.equal(captureCalls.length, 1);
  assert.deepEqual(captureCalls[0]?.request, {
    goldMemories: ["Gold fact one", "Gold fact two"],
    retrievals,
  });
  assert.equal(calls.some((call) => call.kind === "recall"), false);
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "recallWithTrace")
      .map((call) => call.sessionId),
    ["session-beta", "session-alpha"],
  );

  const firstReset = calls.findIndex((call) => call.kind === "reset");
  const capture = calls.findIndex((call) => call.kind === "captureAttributionWitness");
  const secondReset = calls.findIndex(
    (call, index) => call.kind === "reset" && index > firstReset,
  );
  assert.ok(firstReset < capture && capture < secondReset);
  assert.deepEqual(attributionWitnessFromTask(result.results.tasks[0]), witness);
});

test("runPublishedHarness keeps gold-bearing tasks compatible with adapters that expose no witness API", async () => {
  const { system, calls } = makeFakeSystem();
  Reflect.deleteProperty(system, "recallWithTrace");
  Reflect.deleteProperty(system, "captureAttributionWitness");

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [{
      ingestSessions: [{ sessionId: "legacy-session", messages: [{ role: "user", content: "memory" }] }],
      trials: [{
        taskId: "legacy-gold-task",
        question: "What was remembered?",
        expected: "answer",
        recallSessionIds: ["legacy-session"],
        goldMemories: ["A legacy gold fact"],
      }],
    }],
  });

  assert.equal(calls.filter((call) => call.kind === "recall").length, 1);
  assert.equal(calls.some((call) => call.kind === "captureAttributionWitness"), false);
  assert.equal(result.results.tasks.length, 1);
  assert.equal(attributionWitnessFromTask(result.results.tasks[0]), undefined);
});
