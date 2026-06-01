import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

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

class QueryVisibleBeamAdapter extends FakeMemoryAdapter {
  readonly recallQueries: Array<{ sessionId: string; query: string }> = [];

  async recall(sessionId: string, query: string): Promise<string> {
    this.recallQueries.push({ sessionId, query });
    const messages = this.sessions.get(sessionId) ?? [];
    const content = messages.map((message) => message.content).join("\n");
    const visiblePlanMatch = query.match(/\bplan\s+([A-Za-z0-9_.:-]+)/i);
    if (visiblePlanMatch) {
      const planId = visiblePlanMatch[1]!.replace(/[.,;:!?]+$/g, "");
      return content.includes(`plan_id=${planId}`) ? content : "";
    }
    if (query.toLowerCase().includes("chat id 27")) {
      return content.includes("chat_id=27") ? content : "";
    }
    return content;
  }
}

test("runBenchmark executes beam in quick mode with the bundled smoke fixture", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("beam", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "beam");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 4);
  assert.equal(result.results.tasks[0]?.expected, "March 29");
  assert.equal(result.results.tasks[0]?.actual.includes("March 29"), true);
  assert.equal(result.results.tasks[0]?.details.ability, "information_extraction");
  assert.equal(result.results.tasks[0]?.details.scale, "100K");
  assert.equal(typeof result.results.aggregates.rouge_l?.mean, "number");
  assert.equal(typeof result.results.aggregates.search_hits?.mean, "number");
});

test("runBenchmark loads beam full-mode datasets and includes 10M plan chats in recall", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  const conversation = [
    {
      conversation_id: "beam-full-10m-1",
      chat: [
        [
          {
            id: 1,
            role: "user",
            content: "The main thread is about preparing the release checklist.",
          },
        ],
      ],
      plans: [
        {
          plan_id: "plan-0",
          chat: [
            [
              {
                id: 101,
                role: "user",
                content: "Micah owns the final deployment sign-off for the 10M plan.",
              },
            ],
          ],
        },
      ],
      probing_questions:
        "{'knowledge_update': [{'question': 'Who owns the final deployment sign-off?', 'answer': 'Micah', 'difficulty': 'easy', 'rubric': ['LLM response should state: Micah']}]}",
    },
  ];

  await writeFile(
    path.join(datasetDir, "10M.json"),
    JSON.stringify(conversation),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Micah");
  assert.equal(result.results.tasks[0]?.actual.includes("Micah"), true);
  assert.equal(result.results.tasks[0]?.details.scale, "10M");
  assert.equal(result.results.tasks[0]?.details.sessionCount, 2);
});

test("runBenchmark stores query-visible beam plan anchors as memory evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-plan-cue-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new QueryVisibleBeamAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-visible-plan-1",
        chat: [
          [
            {
              id: 1,
              role: "user",
              content: "The main chat is unrelated to release approvals.",
            },
          ],
        ],
        plans: [
          {
            plan_id: "plan-needle",
            chat: [
              [
                {
                  id: 7,
                  role: "user",
                  content: "Serena owns release approvals for the visible plan.",
                },
              ],
            ],
          },
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Using plan plan-needle, who owns release approvals?",
              answer: "Serena",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual.includes("Serena"), true);
  assert.match(String(task.details.recalledText), /plan_id=plan-needle/);
  assert.equal(
    adapter.recallQueries.every(({ query }) => query.includes("plan-needle")),
    true,
  );
});

test("runBenchmark keeps hidden beam source metadata reporting-only", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-hidden-source-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new QueryVisibleBeamAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-hidden-source-1",
        chat: [
          [
            {
              id: 1,
              role: "user",
              content: "Talia owns release readiness.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who owns release readiness?",
              answer: "Talia",
              plan_reference: "hidden-plan-reference",
              source_chat_ids: ["hidden-source-77"],
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.deepEqual(task.details.sourceChatIds, ["hidden-source-77"]);
  assert.equal(task.details.planReference, "hidden-plan-reference");
  assert.equal(
    adapter.recallQueries.some(({ query }) => query.includes("hidden-source-77")),
    false,
  );
  assert.equal(
    adapter.recallQueries.some(({ query }) => query.includes("hidden-plan-reference")),
    false,
  );
  assert.equal(String(task.details.recalledText).includes("hidden-source-77"), false);
  assert.equal(String(task.details.recalledText).includes("hidden-plan-reference"), false);
});

test("runBenchmark does not create beam sessions for empty turn batches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-empty-batch-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-empty-batch-1",
        chat: [
          [],
          [
            {
              id: 1,
              role: "user",
              content: "Only the non-empty batch should become a BEAM session.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Which batch should become a BEAM session?",
              answer: "Only the non-empty batch",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.details.sessionCount, 1);
  assert.equal([...adapter.sessions.keys()].length, 1);
});

test("runBenchmark indexes later beam chat ids as memory evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-chat-cue-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new QueryVisibleBeamAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-visible-chat-1",
        chat: [
          Array.from({ length: 27 }, (_, index) => ({
            id: index + 1,
            role: "user",
            content:
              index === 26
                ? "Marisol owns the late referenced chat evidence."
                : `Filler BEAM chat turn ${index + 1}.`,
          })),
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Using chat id 27, who owns the late referenced chat evidence?",
              answer: "Marisol",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.equal(task.actual.includes("Marisol"), true);
  assert.match(String(task.details.recalledText), /chat_id=27/);
});

test("runBenchmark streams beam JSON arrays without misreading braces in strings", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-stream-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-stream-1",
        chat: [
          [
            {
              id: 1,
              role: "user",
              content:
                "The literal marker is brace {alpha}, bracket [beta], and quote \"gamma\".",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "What is the literal marker?",
              answer: "brace {alpha}, bracket [beta], and quote \"gamma\"",
            },
          ],
        },
      },
      {
        conversation_id: "beam-stream-2",
        chat: [
          [
            {
              id: 2,
              role: "user",
              content: "The backup owner is Priya.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who is the backup owner?",
              answer: "Priya",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 2);
  assert.equal(
    result.results.tasks[0]?.actual.includes(
      'brace {alpha}, bracket [beta], and quote "gamma"',
    ),
    true,
  );
  assert.equal(result.results.tasks[1]?.actual.includes("Priya"), true);
});

test("runBenchmark loads beam 10M plan-map chat shards", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-plan-map-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "10M.json"),
    JSON.stringify([
      {
        conversation_id: "beam-plan-map-1",
        chat: [
          {
            "plan-2": null,
            "plan-1": [
              {
                batch_number: 1,
                turns: [
                  [
                    {
                      id: 1,
                      role: "user",
                      content: "The 10M shard owner is Nia.",
                    },
                  ],
                ],
              },
            ],
          },
        ],
        plans: [
          {
            plan_id: "plan-1",
            chat: [
              [
                {
                  id: 2,
                  role: "user",
                  content: "The supplemental plan owner is Elias.",
                },
              ],
            ],
          },
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who owns the 10M shard?",
              answer: "Nia",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.actual.includes("Nia"), true);
  assert.equal(result.results.tasks[0]?.details.sessionCount, 2);
  assert.equal(
    [...adapter.sessions.values()]
      .flat()
      .some((message) => message.content.includes("supplemental plan owner")),
    true,
  );
});

test("runBenchmark keeps plan chats when top-level beam chat is empty", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-empty-chat-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-empty-chat-1",
        chat: [],
        plans: [
          {
            plan_id: "plan-only",
            chat: [
              [
                {
                  id: 1,
                  role: "user",
                  content: "The plan-only answer is Rowan.",
                },
              ],
            ],
          },
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "What is the plan-only answer?",
              answer: "Rowan",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.actual.includes("Rowan"), true);
  assert.equal(result.results.tasks[0]?.details.sessionCount, 1);
});

test("runBenchmark orders same-number beam plan-map ids by stable secondary key", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-plan-order-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "10M.json"),
    JSON.stringify([
      {
        conversation_id: "beam-plan-order-1",
        chat: [
          {
            "plan-1-b": [
              {
                batch_number: 1,
                turns: [
                  [
                    {
                      id: 2,
                      role: "user",
                      content: "The second same-number plan owner is Blake.",
                    },
                  ],
                ],
              },
            ],
            "plan-1-a": [
              {
                batch_number: 1,
                turns: [
                  [
                    {
                      id: 1,
                      role: "user",
                      content: "The first same-number plan owner is Avery.",
                    },
                  ],
                ],
              },
            ],
          },
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who is the first same-number plan owner?",
              answer: "Avery",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const sessionIds = [...adapter.sessions.keys()];
  assert.equal(result.results.tasks[0]?.details.sessionCount, 2);
  assert.equal(sessionIds[0]?.includes("plan-1-a"), true);
  assert.equal(sessionIds[1]?.includes("plan-1-b"), true);
  assert.equal(result.results.tasks[0]?.actual.includes("Avery"), true);
});

test("runBenchmark applies beam dataset limits while streaming arrays", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-limit-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-limit-1",
        chat: [
          [
            {
              id: 1,
              role: "user",
              content: "Only the first streamed conversation should run.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Which streamed conversation should run?",
              answer: "first",
            },
          ],
        },
      },
      {
        conversation_id: "beam-limit-2",
        chat: [
          [
            {
              id: 2,
              role: "user",
              content: "The second streamed conversation should be skipped.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Which streamed conversation should be skipped?",
              answer: "second",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.details.conversationId, "beam-limit-1");
  assert.equal(adapter.sessions.size, 1);
});

test("runBenchmark rejects malformed beam JSON array comma placement", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-commas-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  const validObject = JSON.stringify({
    conversation_id: "beam-comma-1",
    chat: [],
    probing_questions: {
      information_extraction: [
        {
          question: "What should this malformed dataset do?",
          answer: "fail",
        },
      ],
    },
  });

  for (const [filename, payload, expected] of [
    ["100K-trailing.json", `[${validObject},]`, /invalid trailing comma/],
    ["100K-double.json", `[${validObject},,${validObject}]`, /invalid comma placement/],
    ["100K-missing.json", `[${validObject}${validObject}]`, /missing a comma/],
  ] as const) {
    await writeFile(path.join(datasetDir, filename), payload, "utf8");
    await assert.rejects(
      () =>
        runBenchmark("beam", {
          mode: "full",
          datasetDir,
          limit: 2,
          system: adapter,
        }),
      expected,
    );
    await writeFile(path.join(datasetDir, filename), "[]", "utf8");
  }
});

test("runBenchmark ignores beam JSON tails after reaching a limit", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-limit-tail-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  const validObject = JSON.stringify({
    conversation_id: "beam-limit-tail-1",
    chat: [],
    probing_questions: {
      information_extraction: [
        {
          question: "What should this malformed tail do?",
          answer: "fail",
        },
      ],
    },
  });

  await writeFile(path.join(datasetDir, "100K.json"), `[${validObject},not-json]`, "utf8");

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
});

test("runBenchmark ignores beam JSONL tails after reaching a limit", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-jsonl-tail-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  const validObject = JSON.stringify({
    conversation_id: "beam-jsonl-tail-1",
    chat: [],
    probing_questions: {
      information_extraction: [
        {
          question: "What should this malformed JSONL tail do?",
          answer: "fail",
        },
      ],
    },
  });

  await writeFile(path.join(datasetDir, "100K.jsonl"), `${validObject}\nnot-json\n`, "utf8");

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
});

test("runBenchmark stops reading later beam split files once the global limit is exhausted", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-later-split-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-later-split-1",
        chat: [
          [
            {
              id: 1,
              role: "user",
              content: "The limited split answer is Hazel.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "What is the limited split answer?",
              answer: "Hazel",
            },
          ],
        },
      },
    ]),
    "utf8",
  );
  await writeFile(path.join(datasetDir, "10M.json"), "[not-json]", "utf8");

  const result = await runBenchmark("beam", {
    mode: "full",
    datasetDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.actual.includes("Hazel"), true);
});

test("runBenchmark rejects beam full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "full",
        system: adapter,
      }),
    /BEAM full mode requires datasetDir/,
  );
});

test("runBenchmark rejects empty beam datasets after applying limit", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /BEAM dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark rejects beam datasets with mixed chat nesting", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-beam-mixed-"));
  const datasetDir = path.join(tmpDir, "datasets", "beam");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "100K.json"),
    JSON.stringify([
      {
        conversation_id: "beam-mixed-1",
        chat: [
          {
            id: 1,
            role: "user",
            content: "This top-level array mixes turns and batches.",
          },
          [
            {
              id: 2,
              role: "assistant",
              content: "This nested batch should be rejected.",
            },
          ],
        ],
        probing_questions: {
          information_extraction: [
            {
              question: "Who spoke in the second turn?",
              answer: "assistant",
            },
          ],
        },
      },
    ]),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("beam", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include chat data as a list of turns or turn batches/,
  );
});
