import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Orchestrator, parseConfig } from "@remnic/core";

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

function shellQuoteForTest(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

test("direct adapter keeps its recall-friendly defaults without overrides", () => {
  const config = buildBenchAdapterConfig("direct", BASE_CONFIG);

  assert.equal(config.extractionDedupeEnabled, true);
  assert.equal(config.extractionMinChars, 10);
  assert.equal(config.extractionMinUserTurns, 0);
  assert.equal(config.recallPlannerEnabled, true);
  assert.equal(config.queryExpansionEnabled, false);
  assert.equal(config.lcmLeafBatchSize, 64);
  assert.equal(config.lcmRollupFanIn, 8);
  assert.equal(config.lcmFreshTailTurns, 64);
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

test("adapter sandbox QMD index settings cannot be overridden by runtime config", () => {
  const sandboxedConfig = {
    ...BASE_CONFIG,
    qmdCollection: "remnic-bench-hot",
    qmdColdCollection: "remnic-bench-cold",
    qmdPath: "/tmp/remnic-bench-qmd",
  };
  const overrides = {
    qmdCollection: "openclaw-engram",
    qmdColdCollection: "openclaw-engram-cold",
    qmdPath: "/usr/local/bin/qmd",
  };

  const direct = buildBenchAdapterConfig("direct", sandboxedConfig, overrides);
  const lightweight = buildBenchAdapterConfig("lightweight", sandboxedConfig, overrides);

  assert.equal(direct.qmdCollection, "remnic-bench-hot");
  assert.equal(direct.qmdColdCollection, "remnic-bench-cold");
  assert.equal(direct.qmdPath, "/tmp/remnic-bench-qmd");
  assert.equal(lightweight.qmdCollection, "remnic-bench-hot");
  assert.equal(lightweight.qmdColdCollection, "remnic-bench-cold");
  assert.equal(lightweight.qmdPath, "/tmp/remnic-bench-qmd");
});

test("adapter QMD wrapper resolves relative binaries and isolates QMD env", async () => {
  const fakeRoot = await mkdtemp(path.join(tmpdir(), "remnic-fake-qmd-"));
  const fakeQmdPath = path.join(fakeRoot, "qmd");
  const markerPath = path.join(fakeRoot, "calls.log");
  await writeFile(
    fakeQmdPath,
    [
      "#!/bin/sh",
      `{`,
      `  echo "PWD=$PWD"`,
      `  echo "INDEX_PATH=$INDEX_PATH"`,
      `  echo "XDG_CACHE_HOME=$XDG_CACHE_HOME"`,
      `  echo "QMD_CONFIG_DIR=$QMD_CONFIG_DIR"`,
      `  echo "XDG_CONFIG_HOME=${"$"}{XDG_CONFIG_HOME-}"`,
      `  echo "ARGS=$*"`,
      `} >> ${shellQuoteForTest(markerPath)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(fakeQmdPath, 0o700);

  const adapter = await createRemnicAdapter({
    configOverrides: {
      qmdPath: path.relative(process.cwd(), fakeQmdPath),
    },
  });

  try {
    const marker = await readFile(markerPath, "utf8");
    assert.match(marker, /ARGS=.* collection add .* --name remnic-bench-direct-/);
    assert.match(marker, /INDEX_PATH=.*\/qmd-cache\/remnic-bench-direct-.*\.sqlite/);
    assert.match(marker, /XDG_CACHE_HOME=.*\/qmd-cache/);
    assert.match(marker, /QMD_CONFIG_DIR=.*\/qmd-config/);
    assert.match(marker, /XDG_CONFIG_HOME=\n/);
    assert.doesNotMatch(marker, /openclaw-engram/);
  } finally {
    await adapter.destroy();
    await rm(fakeRoot, { recursive: true, force: true });
  }
});

test("direct adapter can use a caller-owned memory directory", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-owned-"));
  const adapter = await createRemnicAdapter({ memoryDir });

  try {
    await adapter.store("owned-memory-session", [
      {
        role: "user",
        content: "Remember the caller-owned memory directory code is amber-17.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "owned-memory-session",
      "What is the caller-owned memory directory code?",
    );

    assert.match(recalled, /amber-17/);
  } finally {
    await adapter.destroy();
  }

  try {
    assert.equal((await stat(memoryDir)).isDirectory(), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter reset clears caller-owned memory directory", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-owned-"));
  const adapter = await createRemnicAdapter({ memoryDir });

  try {
    await adapter.store("owned-reset-session", [
      {
        role: "user",
        content: "Remember the caller-owned reset code is violet-19.",
      },
    ]);
    await adapter.drain?.();

    const beforeReset = await adapter.recall(
      "owned-reset-session",
      "What is the caller-owned reset code?",
    );
    assert.match(beforeReset, /violet-19/);

    await adapter.reset?.();
    assert.equal((await stat(memoryDir)).isDirectory(), true);

    const afterReset = await adapter.recall(
      "owned-reset-session",
      "What is the caller-owned reset code?",
    );
    assert.doesNotMatch(afterReset, /violet-19/);
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("AMB bridge rejects non-object config JSON", () => {
  const result = spawnSync(
    process.execPath,
    ["packages/bench/scripts/amb-remnic-bridge.mjs"],
    {
      cwd: path.resolve(import.meta.dirname, "../../../.."),
      env: {
        ...process.env,
        REMNIC_AMB_CONFIG_JSON: "null",
      },
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.fatal, true);
  assert.match(
    payload.error,
    /REMNIC_AMB_CONFIG_JSON must be valid JSON: must be a JSON object/,
  );
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

test("direct adapter returns a sufficiency note for personal history queries without direct evidence", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-personal-history-guard", [
      {
        role: "user",
        content:
          "I'm Craig, a hands-on developer with a practical mindset, eager to build a personal budget tracker using Python and Flask.",
      },
      {
        role: "assistant",
        content: "Let's plan the current Flask budget tracker project.",
      },
      {
        role: "user",
        content: "The current project uses Flask and SQLite for transaction tracking.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-personal-history-guard",
      "Can you tell me about my background and previous development projects?",
      24_000,
    );

    assert.match(recalled, /## Remnic recall sufficiency/);
    assert.match(recalled, /No direct evidence found/);
    assert.doesNotMatch(recalled, /hands-on developer/);
    assert.doesNotMatch(recalled, /personal budget tracker/);
    assert.doesNotMatch(recalled, /Flask and SQLite/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter keeps explicit prior-project evidence for personal history queries", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-personal-history-direct", [
      {
        role: "user",
        content:
          "Previous development project: I built a Django CRM before starting this budget tracker.",
      },
      {
        role: "assistant",
        content: "Noted as prior project background.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-personal-history-direct",
      "Can you tell me about my background and previous development projects?",
      24_000,
    );

    assert.match(recalled, /## Search evidence/);
    assert.match(recalled, /Previous development project: I built a Django CRM/);
    assert.doesNotMatch(recalled, /No direct evidence found/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter keeps direct career facts for personal history queries", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-personal-history-career", [
      {
        role: "user",
        content: "I worked on the Apollo app as one of my projects, and I was a designer at Acme.",
      },
      {
        role: "assistant",
        content: "Noted.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-personal-history-career",
      "Can you tell me about my background and previous projects?",
      24_000,
    );

    assert.match(recalled, /## Search evidence/);
    assert.match(recalled, /I worked on the Apollo app/);
    assert.match(recalled, /I was a designer at Acme/);
    assert.doesNotMatch(recalled, /No direct evidence found/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter front-loads direct temporal evidence for end-date questions", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-temporal-direct", [
      {
        role: "user",
        content:
          "The first sprint ends on March 29 and focuses on user registration and login.",
      },
      {
        role: "assistant",
        content: "The sprint plan lists March 29 as the end date.",
      },
      {
        role: "user",
        content:
          "The first sprint now targets completion by March 31, giving two extra testing days.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-temporal-direct",
      "When does my first sprint end?",
      24_000,
    );

    assert.match(recalled, /## Direct temporal evidence/);
    const directSection = recalled.split("## Search evidence")[0] ?? recalled;
    assert.match(directSection, /first sprint ends on March 29/);
    assert.doesNotMatch(directSection, /March 31/);
    assert.doesNotMatch(recalled, /## Session History/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter adds contradiction guidance when evidence contains both sides", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-contradiction-guidance", [
      {
        role: "user",
        content:
          "I have never written any Flask routes or handled HTTP requests in this project.",
      },
      {
        role: "assistant",
        content: "Noted that Flask route and request handling experience was denied.",
      },
      {
        role: "user",
        content:
          "I'm trying to implement the basic homepage route with Flask, and I've managed to return static HTML. Here's my current code: @app.route('/') def homepage(): return render_template('homepage.html')",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-contradiction-guidance",
      "Have I worked with Flask routes and handled HTTP requests in this project?",
      24_000,
    );

    assert.match(recalled, /## Contradiction guidance/);
    assert.match(recalled, /Denial evidence:/);
    assert.match(recalled, /Affirmative evidence:/);
    assert.match(recalled, /does not establish which statement is correct/);
    assert.match(recalled, /never written any Flask routes/);
    assert.match(recalled, /trying to implement the basic homepage route/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter front-loads the latest matching numeric evidence", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-latest-quantity", [
      {
        role: "user",
        content:
          "The Git repository release notes say the main branch has 150 commits and 12 branches merged.",
      },
      {
        role: "assistant",
        content: "The older repository status lists 150 commits.",
      },
      {
        role: "user",
        content:
          "The GitHub Actions workflow deploys on push to the main branch and reduces manual deploy errors by 90%.",
      },
      {
        role: "user",
        content:
          "Recent growth of commits merged into the main branch has now reached 165.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-latest-quantity",
      "How many commits have been merged into the main branch of my Git repository?",
      24_000,
    );

    const latestSection = recalled.match(
      /## Latest quantitative evidence[\s\S]*?(?=\n\n##|$)/,
    )?.[0] ?? "";
    assert.match(latestSection, /165/);
    assert.doesNotMatch(latestSection, /150 commits/);
    assert.doesNotMatch(latestSection, /90%/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter counts only user-stated implementation targets across sessions", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-implementation-targets", [
      {
        role: "user",
        content:
          "I'm trying to estimate the time it'll take to implement user registration with password hashing and validation.",
      },
      {
        role: "assistant",
        content:
          "You could also consider MFA, CSRF protection, JWT rotation, security headers, and audit logging as general best practices.",
      },
      {
        role: "user",
        content:
          "I'm trying to implement role-based access control for my application, specifically for the 'user' role.",
      },
      {
        role: "assistant",
        content:
          "For authorization, broad best practices include RBAC, ABAC, scopes, permissions, and policy engines.",
      },
      {
        role: "user",
        content:
          "I'm trying to implement the account lockout feature after 5 failed login attempts using Redis 7.0 for rate limiting.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-implementation-targets",
      "How many different user roles and security features am I trying to implement across my sessions?",
      24_000,
    );

    assert.match(recalled, /## User-stated implementation targets/);
    assert.match(recalled, /Distinct user-stated targets found: 3/);
    assert.match(recalled, /password hashing/);
    assert.match(recalled, /role-based access control/);
    assert.match(recalled, /account lockout after failed login attempts/);
    assert.doesNotMatch(recalled, /MFA/);
    assert.doesNotMatch(recalled, /JWT rotation/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter lists only dependencies with explicit versions", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-dependency-versions", [
      {
        role: "assistant",
        content:
          "Initial plan:\n- **Flask**: 2.3.1\n- **Flask-Login**: 0.6.2\n- **Flask-Migrate**: 3.1.0",
      },
      {
        role: "assistant",
        content:
          "Dependencies and Versions:\n- **Flask**: 2.3.1\n- **Flask-Login**: 0.6.2\n- **Flask-Migrate**: 4.0.3\n- **SQLite**: 3.39",
      },
      {
        role: "assistant",
        content:
          "Other referenced tools include Matplotlib, Gunicorn, React, and PostgreSQL, but no versions were specified.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-dependency-versions",
      "Which libraries are used in this project?",
      24_000,
    );

    assert.match(recalled, /## Versioned dependency evidence/);
    assert.match(recalled, /Flask: 2\.3\.1/);
    assert.match(recalled, /Flask-Login: 0\.6\.2/);
    assert.match(recalled, /Flask-Migrate: 4\.0\.3/);
    assert.doesNotMatch(recalled, /Flask-Migrate: 3\.1\.0/);
    assert.match(recalled, /SQLite: 3\.39/);
    assert.doesNotMatch(recalled, /Matplotlib/);
    assert.doesNotMatch(recalled, /Gunicorn/);
    assert.doesNotMatch(recalled, /React/);
    assert.doesNotMatch(recalled, /PostgreSQL/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter leaves library recommendation prompts on general recall", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-dependency-recommendations", [
      {
        role: "user",
        content:
          "I prefer simple, minimal dependencies to keep the app lightweight and easy to maintain.",
      },
      {
        role: "assistant",
        content:
          "Dependencies and Versions:\n- **Flask**: 2.3.1\n- **Flask-Login**: 0.6.2",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-dependency-recommendations",
      "What libraries or tools would you suggest I use to implement these features?",
      24_000,
    );

    assert.doesNotMatch(recalled, /## Versioned dependency evidence/);
    assert.match(recalled, /simple, minimal dependencies/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter front-loads temporal interval calculations", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("beam-temporal-intervals", [
      {
        role: "assistant",
        content:
          "Project plan: Dec 16, 2023 - Jan 15, 2024: Develop transaction management features. Feb 16 - Mar 15, 2024: Final adjustments, testing, and deployment.",
      },
      {
        role: "user",
        content:
          "I'm working on sprint 2 which targets analytics by April 19, and I've already completed sprint 1 on March 29 with user auth and basic transaction CRUD.",
      },
    ]);
    await adapter.drain?.();

    const deploymentSpan = await adapter.recall(
      "beam-temporal-intervals",
      "How many weeks do I have between finishing the transaction management features and the final deployment deadline?",
      24_000,
    );
    assert.match(deploymentSpan, /## Temporal interval evidence/);
    assert.match(deploymentSpan, /from January 15, 2024 till March 15, 2024 = 8 weeks and 4 days \(60 days; about 8\.6 weeks\)/);

    const sprintSpan = await adapter.recall(
      "beam-temporal-intervals",
      "How many days were there between the end of my first sprint and the deadline for completing the analytics features in sprint 2?",
      24_000,
    );
    assert.match(sprintSpan, /## Temporal interval evidence/);
    assert.match(sprintSpan, /from March 29 till April 19 = 21 days/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter archives stored messages into LCM once", async () => {
  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("archive-once-session", [
      {
        role: "user",
        content: "First archived turn.",
      },
      {
        role: "assistant",
        content: "Second archived turn.",
      },
    ]);
    await adapter.drain?.();

    const stats = await adapter.getStats("archive-once-session");

    assert.equal(stats.totalMessages, 2);
    assert.equal(stats.maxTurnIndex, 1);
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

test("direct adapter can skip replay extraction while preserving LCM recall", async () => {
  const adapter = await createRemnicAdapter({
    replayExtractionMode: "skip",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("locomo-style-session", [
      {
        role: "user",
        content: "Session fact: Caroline went to the support group yesterday.",
      },
      {
        role: "assistant",
        content: "Session date anchor: 8 May 2023.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "locomo-style-session",
      "When did Caroline go to the support group?",
    );

    assert.match(recalled, /support group yesterday/);
    assert.match(recalled, /8 May 2023/);
  } finally {
    await adapter.destroy();
  }
});

test("direct adapter rejects historical recall when the core pipeline is disabled", async () => {
  const adapter = await createRemnicAdapter();

  try {
    await adapter.store("bench-historical-disabled-session", [
      {
        role: "user",
        content: "Historical recall should not silently use LCM-only storage.",
      },
    ]);

    await assert.rejects(
      () =>
        adapter.recall(
          "bench-historical-disabled-session",
          "What should not silently use LCM-only storage?",
          24_000,
          { asOf: "2000-01-01T00:00:00.000Z" },
        ),
      /benchmark historical recall requires core replay extraction/,
    );
  } finally {
    await adapter.destroy();
  }
});

test("runtime-backed adapter rejects historical recall when replay extraction is skipped", async () => {
  const adapter = await createRemnicAdapter({
    replayExtractionMode: "skip",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("beam-historical-session", [
      {
        role: "user",
        content: "Future-only benchmark leak marker is cobalt-99.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-historical-session",
      "What is the future-only benchmark leak marker?",
      24_000,
    );
    assert.match(recalled, /cobalt-99/);

    await assert.rejects(
      () =>
        adapter.recall(
          "beam-historical-session",
          "What is the future-only benchmark leak marker?",
          24_000,
          { asOf: "2000-01-01T00:00:00.000Z" },
        ),
      /benchmark historical recall requires core replay extraction/,
    );

    await assert.rejects(
      () =>
        adapter.recall(
          "beam-historical-session",
          "What is the future-only benchmark leak marker?",
          24_000,
          { asOf: "not-a-date" },
        ),
      /benchmark recall asOf must be a valid timestamp/,
    );
    await assert.rejects(
      () =>
        adapter.recall(
          "beam-historical-session",
          "What is the future-only benchmark leak marker?",
          24_000,
          { asOf: "2026-05-10T12:00:00" },
        ),
      /benchmark recall asOf must be a valid timestamp/,
    );
    await assert.rejects(
      () =>
        adapter.recall(
          "beam-historical-session",
          "What is the future-only benchmark leak marker?",
          24_000,
          { asOf: "2026-05-10T12:00+23:00" },
        ),
      /benchmark recall asOf must be a valid timestamp/,
    );
    await assert.rejects(
      () =>
        adapter.recall(
          "beam-historical-session",
          "What is the future-only benchmark leak marker?",
          24_000,
          { asOf: "2026-02-30" },
        ),
      /benchmark recall asOf must be a valid timestamp/,
    );
  } finally {
    await adapter.destroy();
  }
});

test("runtime-backed adapter preserves source timestamps for historical recall", async () => {
  const sandboxDir = await mkdtemp(path.join(tmpdir(), "remnic-source-time-"));
  const adapter = await createRemnicAdapter({
    sandboxDir,
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("beam-source-time-session", [
      {
        role: "user",
        content: "Source-dated launch marker is amber-31.",
        timestamp: "1999-12-31T23:59:59Z",
      },
    ]);
    await adapter.drain?.();

    const transcriptPath = path.join(
      sandboxDir,
      "transcripts",
      "other",
      "default",
      `${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    const transcriptLines = (await readFile(transcriptPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { sessionKey?: string; timestamp?: string });
    const storedTurn = transcriptLines.find(
      (entry) => entry.sessionKey === "beam-source-time-session",
    );
    assert.equal(storedTurn?.timestamp, "1999-12-31T23:59:59.000Z");

    await assert.rejects(
      () =>
        adapter.store("beam-source-time-session", [
          {
            role: "user",
            content: "Bad timestamp should be rejected.",
            timestamp: "not-a-date",
          },
        ]),
      /benchmark message timestamp must be a valid timestamp/,
    );
    await assert.rejects(
      () =>
        adapter.store("beam-source-time-session", [
          {
            role: "user",
            content: "Timezone-less timestamp should be rejected.",
            timestamp: "2026-05-10T12:00:00",
          },
        ]),
      /benchmark message timestamp must be a valid timestamp/,
    );
    await assert.rejects(
      () =>
        adapter.store("beam-source-time-session", [
          {
            role: "user",
            content: "Overflow timestamp should be rejected.",
            timestamp: "2026-02-30",
          },
        ]),
      /benchmark message timestamp must be a valid timestamp/,
    );
  } finally {
    await adapter.destroy();
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("runtime-backed adapter returns a time-safe diagnostic for empty historical recall", async () => {
  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("beam-empty-historical-session", [
      {
        role: "user",
        content: "Future-only diagnostic marker is cobalt-99.",
        timestamp: "2026-05-10T12:00:00Z",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "beam-empty-historical-session",
      "What is the future-only diagnostic marker?",
      24_000,
      { asOf: "2000-01-01T00:00:00.000Z" },
    );

    assert.match(recalled, /## Remnic historical recall/);
    assert.match(
      recalled,
      /No historically valid Remnic memories matched this query as of 2000-01-01T00:00:00.000Z/,
    );
    assert.doesNotMatch(recalled, /cobalt-99/);
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

test("runtime-backed adapter does not turn synthetic ordering timestamps into source validity", async () => {
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  const observedBatches: Array<Array<{ timestamp: string; sourceValidAt?: string }>> = [];
  Orchestrator.prototype.ingestReplayBatch = async function patchedIngestReplayBatch(turns) {
    observedBatches.push(
      turns.map((turn) => ({
        timestamp: turn.timestamp,
        sourceValidAt: turn.sourceValidAt,
      })),
    );
  };

  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("beam-undated-bench-session", [
      {
        role: "user",
        content: "Undated BEAM turn one uses synthetic transcript order only.",
      },
      {
        role: "assistant",
        content: "Undated BEAM turn two should share the replay batch.",
      },
    ]);

    assert.equal(observedBatches.length, 1);
    assert.equal(observedBatches[0]?.length, 2);
    assert.equal(typeof observedBatches[0]?.[0]?.timestamp, "string");
    assert.equal(typeof observedBatches[0]?.[1]?.timestamp, "string");
    assert.equal(observedBatches[0]?.[0]?.sourceValidAt, undefined);
    assert.equal(observedBatches[0]?.[1]?.sourceValidAt, undefined);
  } finally {
    await adapter.destroy();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
  }
});

test("runtime-backed adapter forwards real message timestamps as source validity", async () => {
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  const observedBatches: Array<Array<{ timestamp: string; sourceValidAt?: string }>> = [];
  Orchestrator.prototype.ingestReplayBatch = async function patchedIngestReplayBatch(turns) {
    observedBatches.push(
      turns.map((turn) => ({
        timestamp: turn.timestamp,
        sourceValidAt: turn.sourceValidAt,
      })),
    );
  };

  const adapter = await createRemnicAdapter({
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("beam-dated-bench-session", [
      {
        role: "user",
        content: "Dated BEAM turn one has a historical source time.",
        timestamp: "2025-01-01T00:00:00Z",
      },
    ]);

    assert.deepEqual(observedBatches, [
      [
        {
          timestamp: "2025-01-01T00:00:00.000Z",
          sourceValidAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    ]);
  } finally {
    await adapter.destroy();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
  }
});

test("runtime-backed adapter can batch dated replay turns without historical validity", async () => {
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  const observedBatches: Array<Array<{ timestamp: string; sourceValidAt?: string }>> = [];
  Orchestrator.prototype.ingestReplayBatch = async function patchedIngestReplayBatch(turns) {
    observedBatches.push(
      turns.map((turn) => ({
        timestamp: turn.timestamp,
        sourceValidAt: turn.sourceValidAt,
      })),
    );
  };

  const adapter = await createRemnicAdapter({
    replaySourceValidAtMode: "batch",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 0,
    },
  });

  try {
    await adapter.store("beam-dated-batch-session", [
      {
        role: "user",
        content: "Dated BEAM turn one should remain in the same replay batch.",
        timestamp: "2025-01-01T00:00:00Z",
      },
      {
        role: "assistant",
        content: "Dated BEAM turn two should not create an as-of replay slice.",
        timestamp: "2025-01-02T00:00:00Z",
      },
    ]);

    assert.deepEqual(observedBatches, [
      [
        {
          timestamp: "2025-01-01T00:00:00.000Z",
          sourceValidAt: undefined,
        },
        {
          timestamp: "2025-01-02T00:00:00.000Z",
          sourceValidAt: undefined,
        },
      ],
    ]);

    await assert.rejects(
      () =>
        adapter.recall(
          "beam-dated-batch-session",
          "What happened in the dated batch?",
          24_000,
          { asOf: "2025-01-03T00:00:00.000Z" },
        ),
      /benchmark historical recall requires core replay extraction/,
    );
  } finally {
    await adapter.destroy();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
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
    await assert.rejects(
      () =>
        adapter.recall(
          "agent:bench:main",
          "What is the lightweight mode code?",
          24_000,
          { asOf: "2000-01-01T00:00:00.000Z" },
        ),
      /benchmark historical recall requires core replay extraction/,
    );
  } finally {
    await adapter.destroy();
  }
});
