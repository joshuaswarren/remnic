import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "@remnic/core";

import {
  buildBenchAdapterConfig,
  buildBenchBaselineRemnicConfig,
  createLightweightAdapter,
  createRemnicAdapter,
} from "./remnic-adapter.ts";

const BASE_CONFIG = {
  memoryDir: "/tmp/remnic-bench-memory",
  workspaceDir: "/tmp/remnic-bench-workspace",
  lcmEnabled: true as const,
};

test("direct adapter keeps its recall-friendly defaults without overrides", () => {
  const config = buildBenchAdapterConfig("direct", BASE_CONFIG);

  assert.equal(config.extractionDedupeEnabled, true);
  assert.equal(config.extractionMinChars, 10);
  assert.equal(config.extractionMinUserTurns, 0);
  assert.equal(config.recallPlannerEnabled, true);
  assert.equal(config.queryExpansionEnabled, false);
});

test("persisted baseline config stays aligned with direct adapter defaults", () => {
  const { memoryDir: _memoryDir, workspaceDir: _workspaceDir, ...directConfig } =
    buildBenchAdapterConfig("direct", BASE_CONFIG);

  assert.deepEqual(buildBenchBaselineRemnicConfig(), directConfig);
});

test("adapter sandbox paths cannot be overridden by runtime config", () => {
  const overrides = {
    memoryDir: "/tmp/real-user-memory",
    workspaceDir: "/tmp/real-user-workspace",
    lcmEnabled: false,
  };

  const direct = buildBenchAdapterConfig("direct", BASE_CONFIG, overrides);
  const lightweight = buildBenchAdapterConfig("lightweight", BASE_CONFIG, overrides);

  assert.equal(direct.memoryDir, BASE_CONFIG.memoryDir);
  assert.equal(direct.workspaceDir, BASE_CONFIG.workspaceDir);
  assert.equal(direct.lcmEnabled, true);
  assert.equal(lightweight.memoryDir, BASE_CONFIG.memoryDir);
  assert.equal(lightweight.workspaceDir, BASE_CONFIG.workspaceDir);
  assert.equal(lightweight.lcmEnabled, true);
});

test("lightweight adapter keeps smoke-run guardrails even when overrides conflict", () => {
  const assistantHook = { enabled: true };
  const config = buildBenchAdapterConfig("lightweight", BASE_CONFIG, {
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
    assistantHook,
  });

  assert.equal(config.extractionDedupeEnabled, false);
  assert.equal(config.extractionMinChars, 1000000);
  assert.equal(config.extractionMinUserTurns, 1000000);
  assert.equal(config.recallPlannerEnabled, false);
  assert.deepEqual(config.assistantHook, assistantHook);
});

test("benchmark config builders do not share nested nativeKnowledge state", () => {
  const first = buildBenchAdapterConfig("direct", BASE_CONFIG) as {
    nativeKnowledge: { enabled: boolean };
  };
  const second = buildBenchAdapterConfig("direct", BASE_CONFIG) as {
    nativeKnowledge: { enabled: boolean };
  };
  const baseline = buildBenchBaselineRemnicConfig() as {
    nativeKnowledge: { enabled: boolean };
  };

  first.nativeKnowledge.enabled = true;

  assert.equal(second.nativeKnowledge.enabled, false);
  assert.equal(baseline.nativeKnowledge.enabled, false);
});

test("benchmark config builders preserve function-valued assistant hooks", async () => {
  const assistantAgent = {
    async respond(): Promise<string> {
      return "ok";
    },
  };
  const assistantJudge = {
    async evaluate(): Promise<{ score: number }> {
      return { score: 0.8 };
    },
  };

  const config = buildBenchAdapterConfig("direct", BASE_CONFIG, {
    assistantAgent,
    assistantJudge,
  }) as {
    assistantAgent: typeof assistantAgent;
    assistantJudge: typeof assistantJudge;
  };

  assert.equal(await config.assistantAgent.respond(), "ok");
  assert.deepEqual(await config.assistantJudge.evaluate(), { score: 0.8 });
  assert.notEqual(config.assistantAgent, assistantAgent);
  assert.notEqual(config.assistantJudge, assistantJudge);
});

test("runtime-backed direct configs preserve core defaults for omitted keys", () => {
  const parsed = parseConfig(
    buildBenchAdapterConfig(
      "direct",
      BASE_CONFIG,
      { assistantAgent: { enabled: true } },
      { preserveRuntimeDefaults: true },
    ),
  );

  assert.equal(parsed.qmdEnabled, true);
  assert.equal(parsed.identityEnabled, true);
  assert.equal(parsed.workspaceDir, BASE_CONFIG.workspaceDir);
});

test("direct adapter recall expands search hits with adjacent stored results", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("arena-session", [
      {
        role: "user",
        content: "Buy a train ride snack that is compact, shareable, and not messy.",
      },
      {
        role: "assistant",
        content: "MemoryArena completed subtask 1.\nEnvironment result: trail mix",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "arena-session",
      "Which train ride snack from the completed purchase should I pack?",
    );

    assert.match(recalled, /Environment result: trail mix/);
    assert.match(recalled, /\[arena-session, turn 1, assistant/);
    assert.ok(recalled.length <= 24_000);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall front-loads exact step references from the session trace", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "At Step 8, why did the agent's action matter?",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 8\]: state-8/);
    assert.ok(
      recalled.indexOf("## Explicit Cue Evidence") <
        recalled.indexOf("[Action 8]: move-8"),
    );
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall recognizes plural multi-step reference prompts", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 8 and 9 before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 8\]: state-8/);
    assert.match(recalled, /\[Action 9\]: move-9/);
    assert.match(recalled, /\[Observation 9\]: state-9/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall preserves trailing references after a parsed step range", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 14 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 8-10 and 12 before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 10\]: state-10/);
    assert.match(recalled, /\[Action 12\]: move-12/);
    assert.match(recalled, /\[Observation 12\]: state-12/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall expands only the explicit range segment in mixed prompts", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 16 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 8 and 10-15 before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Action 10\]: move-10/);
    assert.match(recalled, /\[Observation 13\]: state-13/);
    assert.match(recalled, /\[Observation 15\]: state-15/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall treats unicode dashes as step range separators", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 8\u201310 before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 9\]: state-9/);
    assert.match(recalled, /\[Action 10\]: move-10/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall does not let stray labels consume later reference numbers", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 10 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Think step by step. Turn 8 is relevant.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 8\]: state-8/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall maps turn references to direct and paired turn candidates", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 10 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Turn 8 is relevant.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 4\]: move-4/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /\[Observation 8\]: state-8/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall keeps AMA explicit step prompts focused on the cited window", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 30 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-ep-test", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-test",
      "Between steps 20 and 23, which single action mattered?",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 20\]: move-20/);
    assert.match(recalled, /\[Action 23\]: move-23/);
    assert.match(recalled, /## Search evidence/);
    assert.doesNotMatch(recalled, /\[Action 29\]: move-29/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall keeps bounded search evidence after AMA explicit step prompts", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = [
      {
        role: "user" as const,
        content: "Background note: the compact snack signal was trail mix.",
      },
      ...Array.from({ length: 12 }, (_, index) => [
        {
          role: "user" as const,
          content: `[Action ${index}]: move-${index}`,
        },
        {
          role: "assistant" as const,
          content: `[Observation ${index}]: state-${index}`,
        },
      ]).flat(),
    ];

    await adapter.store("ama-ep-search", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-search",
      "At Step 8, why did the compact snack signal matter?",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /## Search evidence/);
    assert.match(recalled, /compact snack signal was trail mix/);
    assert.ok(
      recalled.indexOf("## Explicit Cue Evidence") <
        recalled.indexOf("## Search evidence"),
    );
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall keeps short lexical cues in focused AMA search evidence", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = [
      {
        role: "user" as const,
        content: "Background note: the red box unlocked the west door.",
      },
      ...Array.from({ length: 10 }, (_, index) => [
        {
          role: "user" as const,
          content: `[Action ${index}]: move-${index}`,
        },
        {
          role: "assistant" as const,
          content: `[Observation ${index}]: state-${index}`,
        },
      ]).flat(),
    ];

    await adapter.store("ama-ep-short-cue", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-short-cue",
      "At Step 8, why did the red box matter?",
      24_000,
    );

    assert.match(recalled, /## Search evidence/);
    assert.match(recalled, /red box unlocked the west door/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall filters common-word-only focused search hits", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = [
      {
        role: "user" as const,
        content: "Background note: why did the matter and the did why.",
      },
      {
        role: "user" as const,
        content: "Background note: the red box unlocked the west door.",
      },
      ...Array.from({ length: 10 }, (_, index) => [
        {
          role: "user" as const,
          content: `[Action ${index}]: move-${index}`,
        },
        {
          role: "assistant" as const,
          content: `[Observation ${index}]: state-${index}`,
        },
      ]).flat(),
    ];

    await adapter.store("ama-ep-common-words", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-common-words",
      "At Step 8, why did the red box matter?",
      24_000,
    );

    assert.match(recalled, /red box unlocked the west door/);
    assert.doesNotMatch(recalled, /why did the matter and the did why/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall does not treat quoted trajectory labels as structured focused hits", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = [
      {
        role: "user" as const,
        content: "Background note: someone quoted [Action 8] out of context.",
      },
      ...Array.from({ length: 10 }, (_, index) => [
        {
          role: "user" as const,
          content: `[Action ${index}]: move-${index}`,
        },
        {
          role: "assistant" as const,
          content: `[Observation ${index}]: state-${index}`,
        },
      ]).flat(),
    ];

    await adapter.store("ama-ep-quoted-label", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-quoted-label",
      "At Step 8, why did the action matter?",
      24_000,
    );

    assert.match(recalled, /\[Action 8\]: move-8/);
    assert.match(recalled, /## Search evidence/);
    const searchEvidence = recalled.split("## Search evidence")[1] ?? "";
    assert.doesNotMatch(searchEvidence, /quoted \[Action 8\] out of context/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall keeps disjoint AMA step search windows separate", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 42 }, (_, index) => [
      {
        role: "user" as const,
        content:
          index === 20
            ? "[Action 20]: unrelated-noise bridge action"
            : `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-ep-disjoint", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-disjoint",
      "Compare steps 2 and 40 with unrelated-noise before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 2\]: move-2/);
    assert.match(recalled, /\[Action 40\]: move-40/);
    assert.doesNotMatch(recalled, /\[Action 20\]: unrelated-noise/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall resolves AMA step labels when stored transcript turns are offset", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const preamble = Array.from({ length: 60 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `preamble turn ${index}`,
    }));
    const trace = Array.from({ length: 52 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-ep-offset", [...preamble, ...trace]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-ep-offset",
      "In steps 47 and 48, what did the maneuver accomplish?",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Observation 46\]: state-46/);
    assert.match(recalled, /\[Action 47\]: move-47/);
    assert.match(recalled, /\[Observation 48\]: state-48/);
    assert.doesNotMatch(recalled, /\[Action 49\]: move-49/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall preserves long explicit reference lists", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 18 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 1,2,3,4,5,6,7,8,9,10,11,12 before answering.",
      24_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 1\]: move-1/);
    assert.match(recalled, /\[Observation 8\]: state-8/);
    assert.match(recalled, /\[Action 12\]: move-12/);
    assert.match(recalled, /\[Observation 12\]: state-12/);
  } finally {
    await adapter.destroy();
  }
});

test("adapter recall expands ranges up to the configured reference cap", async () => {
  const adapter = await createRemnicAdapter();

  try {
    const messages = Array.from({ length: 22 }, (_, index) => [
      {
        role: "user" as const,
        content: `[Action ${index}]: move-${index}`,
      },
      {
        role: "assistant" as const,
        content: `[Observation ${index}]: state-${index}`,
      },
    ]).flat();

    await adapter.store("ama-session", messages);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "ama-session",
      "Compare steps 1-20 before answering.",
      32_000,
    );

    assert.match(recalled, /## Explicit Cue Evidence/);
    assert.match(recalled, /\[Action 1\]: move-1/);
    assert.match(recalled, /\[Observation 12\]: state-12/);
    assert.match(recalled, /\[Action 20\]: move-20/);
  } finally {
    await adapter.destroy();
  }
});

test("runtime-backed adapter stores benchmark turns into Remnic recall surfaces", async () => {
  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("agent:bench:main", [
      {
        role: "user",
        content: "Remember the espresso code is crema-42.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "agent:bench:main",
      "What is the espresso code?",
    );

    assert.match(recalled, /## Remnic recall pipeline/);
    assert.match(recalled, /Recent Conversation/);
    assert.match(recalled, /crema-42/);
  } finally {
    await adapter.destroy();
  }
});

test("runtime-backed adapter preserves transcript order for stored batches", async () => {
  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("agent:bench:main", [
      {
        role: "user",
        content: "First turn: choose the train.",
      },
      {
        role: "assistant",
        content: "Second turn: the final snack is trail mix.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "agent:bench:main",
      "What happened in the first and second turn?",
    );
    const firstIndex = recalled.indexOf("First turn: choose the train.");
    const secondIndex = recalled.indexOf("Second turn: the final snack is trail mix.");

    assert.notEqual(firstIndex, -1);
    assert.notEqual(secondIndex, -1);
    assert.equal(firstIndex < secondIndex, true);
  } finally {
    await adapter.destroy();
  }
});

test("lightweight adapter suppresses real Remnic pipeline even when feature overrides are present", async () => {
  const adapter = await createLightweightAdapter({
    configOverrides: {
      transcriptEnabled: true,
      qmdEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("agent:bench:main", [
      {
        role: "user",
        content: "Remember the lightweight mode code is smoke-only.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "agent:bench:main",
      "What is the lightweight mode code?",
    );

    assert.doesNotMatch(recalled, /## Remnic recall pipeline/);
    assert.doesNotMatch(recalled, /Recent Conversation/);
    assert.match(recalled, /smoke-only/);
  } finally {
    await adapter.destroy();
  }
});
