import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Orchestrator, parseConfig, parseEntityFile, StorageManager } from "@remnic/core";

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

function benchReplaySourceForTest(sessionId: string): string {
  return `bench-replay-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function createDeferredForTest(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function shellQuoteForTest(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hourlySummarySnapshotForTest(sessionKey: string, bullet: string): string {
  const generatedAt = "2026-05-17T10:00:00.000Z";
  return JSON.stringify(
    {
      schemaVersion: 1,
      sessionKey,
      generatedAt,
      summaries: [
        {
          hour: "2026-05-17T10:00:00.000Z",
          sessionKey,
          bullets: [bullet],
          turnCount: 1,
          generatedAt,
        },
      ],
    },
    null,
    2,
  );
}

async function assertPathMissingForTest(filePath: string): Promise<void> {
  await assert.rejects(
    () => stat(filePath),
    (err: unknown) =>
      !!err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "ENOENT",
  );
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
  const sentinelPath = path.join(memoryDir, "caller-owned-sentinel.txt");
  const threadPath = path.join(memoryDir, "threads", "stale-thread.json");
  const summaryPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    "owned-reset-session",
    "2026-05-17.md",
  );
  await writeFile(sentinelPath, "do not remove");
  await mkdir(path.dirname(threadPath), { recursive: true });
  await writeFile(threadPath, "{}");
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, "stale hourly summary");
  const adapter = await createRemnicAdapter({
    memoryDir,
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

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
    assert.equal(await readFile(sentinelPath, "utf8"), "do not remove");
    await assertPathMissingForTest(threadPath);
    await assertPathMissingForTest(summaryPath);

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

test("direct adapter session reset preserves other caller-owned sessions", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-session-"));
  const sentinelPath = path.join(memoryDir, "caller-owned-sentinel.txt");
  await writeFile(sentinelPath, "preserve caller data");
  const adapter = await createRemnicAdapter({ memoryDir });

  try {
    await adapter.store("owned-reset-session-a", [
      {
        role: "user",
        content: "Remember the session-a reset code is indigo-41.",
      },
    ]);
    await adapter.store("owned-reset-session-b", [
      {
        role: "user",
        content: "Remember the session-b reset code is copper-82.",
      },
    ]);
    await adapter.drain?.();

    assert.match(
      await adapter.recall(
        "owned-reset-session-a",
        "What is the session-a reset code?",
      ),
      /indigo-41/,
    );
    assert.match(
      await adapter.recall(
        "owned-reset-session-b",
        "What is the session-b reset code?",
      ),
      /copper-82/,
    );

    await adapter.reset?.("owned-reset-session-a");
    assert.equal(await readFile(sentinelPath, "utf8"), "preserve caller data");

    assert.doesNotMatch(
      await adapter.recall(
        "owned-reset-session-a",
        "What is the session-a reset code?",
      ),
      /indigo-41/,
    );
    assert.match(
      await adapter.recall(
        "owned-reset-session-b",
        "What is the session-b reset code?",
      ),
      /copper-82/,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears caller-owned hourly summaries", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-summary-"));
  const resetSession = "owned-summary-reset-session";
  const otherSession = "owned-summary-other-session";
  const resetSummaryPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    resetSession,
    "2026-05-17.md",
  );
  const otherSummaryPath = path.join(
    memoryDir,
    "summaries",
    "hourly",
    otherSession,
    "2026-05-17.md",
  );
  const resetSnapshotPath = path.join(
    memoryDir,
    "state",
    "summaries",
    `${resetSession}.json`,
  );
  const otherSnapshotPath = path.join(
    memoryDir,
    "state",
    "summaries",
    `${otherSession}.json`,
  );
  const adapter = await createRemnicAdapter({
    memoryDir,
    configOverrides: {
      hourlySummariesEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await mkdir(path.dirname(resetSummaryPath), { recursive: true });
    await mkdir(path.dirname(otherSummaryPath), { recursive: true });
    await mkdir(path.dirname(resetSnapshotPath), { recursive: true });
    await writeFile(resetSummaryPath, "stale reset hourly summary");
    await writeFile(otherSummaryPath, "preserve other hourly summary");
    await writeFile(
      resetSnapshotPath,
      hourlySummarySnapshotForTest(resetSession, "stale reset snapshot"),
    );
    await writeFile(
      otherSnapshotPath,
      hourlySummarySnapshotForTest(otherSession, "preserve other snapshot"),
    );

    await adapter.reset?.(resetSession);

    await assertPathMissingForTest(resetSummaryPath);
    await assertPathMissingForTest(resetSnapshotPath);
    assert.equal(await readFile(otherSummaryPath, "utf8"), "preserve other hourly summary");
    assert.equal(
      await readFile(otherSnapshotPath, "utf8"),
      hourlySummarySnapshotForTest(otherSession, "preserve other snapshot"),
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset rejects summary path traversal", async () => {
  const parentDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-summary-traversal-"),
  );
  const memoryDir = path.join(parentDir, "memory");
  const outsideDir = path.join(parentDir, "outside");
  const outsidePath = path.join(outsideDir, "sentinel.txt");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(outsidePath, "preserve caller data");
  const adapter = await createRemnicAdapter({
    memoryDir,
    configOverrides: {
      hourlySummariesEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("../../../outside", [
      {
        role: "user",
        content: "Remember the traversal reset code is calendula-91.",
      },
    ]);
    await adapter.drain?.();

    await assert.rejects(
      () => adapter.reset?.("../../../outside"),
      /benchmark sessionId resolves outside Remnic benchmark state/,
    );
    assert.equal(await readFile(outsidePath, "utf8"), "preserve caller data");
    assert.match(
      await adapter.recall("../../../outside", "What is the traversal reset code?"),
      /calendula-91/,
    );
  } finally {
    await adapter.destroy();
    await rm(parentDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears caller-owned core replay state", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-core-session-"));
  const sentinelPath = path.join(memoryDir, "caller-owned-sentinel.txt");
  await writeFile(sentinelPath, "preserve caller data");
  const adapterOptions = {
    memoryDir,
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  };
  let adapter = await createRemnicAdapter(adapterOptions);

  try {
    await adapter.store("owned-core-reset-session", [
      {
        role: "user",
        content: "Remember the old core reset code is orchid-17.",
      },
    ]);
    await adapter.store("owned-core-reset-other-session", [
      {
        role: "user",
        content: "Remember the other core reset code is cedar-29.",
      },
    ]);
    await adapter.drain?.();

    assert.match(
      await adapter.recall(
        "owned-core-reset-session",
        "What is the core reset code?",
      ),
      /orchid-17/,
    );
    assert.match(
      await adapter.recall(
        "owned-core-reset-other-session",
        "What is the other core reset code?",
      ),
      /cedar-29/,
    );

    await adapter.destroy();
    adapter = await createRemnicAdapter(adapterOptions);

    await adapter.reset?.("owned-core-reset-session");
    assert.equal(await readFile(sentinelPath, "utf8"), "preserve caller data");

    await adapter.store("owned-core-reset-session", [
      {
        role: "user",
        content: "Remember the new core reset code is willow-83.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "owned-core-reset-session",
      "What is the core reset code?",
    );
    assert.doesNotMatch(recalled, /orchid-17/);
    assert.match(recalled, /willow-83/);
    assert.match(
      await adapter.recall(
        "owned-core-reset-other-session",
        "What is the other core reset code?",
      ),
      /cedar-29/,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears caller-owned verbatim artifacts", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-artifacts-"));
  const resetSession = "owned-artifact-reset-session";
  const otherSession = "owned-artifact-other-session";
  const adapter = await createRemnicAdapter({
    memoryDir,
    configOverrides: {
      transcriptEnabled: true,
      verbatimArtifactsEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    const storage = new StorageManager(memoryDir);
    const resetMemoryId = await storage.writeMemory(
      "fact",
      "Remember the stale artifact reset code is hibiscus-57.",
      { source: benchReplaySourceForTest(resetSession) },
    );
    const otherMemoryId = await storage.writeMemory(
      "fact",
      "Remember the other artifact code is juniper-68.",
      { source: benchReplaySourceForTest(otherSession) },
    );
    await storage.writeArtifact(
      "Verbatim stale artifact quote: hibiscus-57.",
      { sourceMemoryId: resetMemoryId },
    );
    await storage.writeArtifact(
      "Verbatim other artifact quote: juniper-68.",
      { sourceMemoryId: otherMemoryId },
    );

    const resetArtifact = (await storage.searchArtifacts("hibiscus-57", 10))
      .find((artifact) => artifact.frontmatter.sourceMemoryId === resetMemoryId);
    const otherArtifact = (await storage.searchArtifacts("juniper-68", 10))
      .find((artifact) => artifact.frontmatter.sourceMemoryId === otherMemoryId);
    assert.ok(resetArtifact);
    assert.ok(otherArtifact);

    await adapter.reset?.(resetSession);

    await assertPathMissingForTest(resetArtifact.path);
    assert.match(await readFile(otherArtifact.path, "utf8"), /juniper-68/);
    const remainingArtifacts = await new StorageManager(memoryDir).searchArtifacts(
      "juniper-68",
      10,
    );
    assert.equal(
      remainingArtifacts.some(
        (artifact) => artifact.frontmatter.sourceMemoryId === otherMemoryId,
      ),
      true,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears caller-owned entity timeline state", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-entities-"));
  const resetSession = "owned-entity-reset-session";
  const otherSession = "owned-entity-other-session";
  const adapter = await createRemnicAdapter({
    memoryDir,
    configOverrides: {
      entityRetrievalEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    const storage = new StorageManager(memoryDir);
    const sharedEntityName = await storage.writeEntity(
      "Shared Reset Entity",
      "project",
      ["Remember the stale entity reset code is camellia-33."],
      { source: "extraction", sessionKey: resetSession },
    );
    await storage.writeEntity(
      "Shared Reset Entity",
      "project",
      ["Remember the other entity code is fern-44."],
      { source: "extraction", sessionKey: otherSession },
    );
    const resetOnlyEntityName = await storage.writeEntity(
      "Reset Only Entity",
      "project",
      ["Remember the reset-only entity code is moss-13."],
      { source: "extraction", sessionKey: resetSession },
    );
    const whitespaceEntityName = await storage.writeEntity(
      "Whitespace Entity",
      "project",
      [
        "Keep the alpha  beta spacing variant.",
        "Keep the alpha beta spacing variant.",
      ],
      { source: "extraction", sessionKey: otherSession },
    );
    await storage.writeEntity(
      "Whitespace Entity",
      "project",
      ["Remember the reset whitespace code is lichen-92."],
      { source: "extraction", sessionKey: resetSession },
    );
    const preexistingStructuredEntityName = await storage.writeEntity(
      "Preexisting Structured Entity",
      "project",
      [],
      {
        structuredSections: [
          {
            key: "details",
            title: "Details",
            facts: ["Preserve the preexisting structured code agate-64."],
          },
        ],
      },
    );
    await storage.writeEntity(
      "Preexisting Structured Entity",
      "project",
      ["Remember the reset-only timeline code is basalt-29."],
      { source: "extraction", sessionKey: resetSession },
    );

    await adapter.reset?.(resetSession);

    const sharedEntity = await storage.readEntity(sharedEntityName);
    assert.doesNotMatch(sharedEntity, /camellia-33/);
    assert.match(sharedEntity, /fern-44/);
    assert.equal(sharedEntity.includes(`[session=${resetSession}]`), false);
    assert.equal(sharedEntity.includes(`[session=${otherSession}]`), true);
    await assertPathMissingForTest(
      path.join(memoryDir, "entities", `${resetOnlyEntityName}.md`),
    );
    const whitespaceEntity = parseEntityFile(await storage.readEntity(whitespaceEntityName));
    assert.deepEqual(
      whitespaceEntity.facts.filter((fact) => fact.includes("alpha")),
      [
        "Keep the alpha  beta spacing variant.",
        "Keep the alpha beta spacing variant.",
      ],
    );
    const preexistingStructuredEntity = await storage.readEntity(
      preexistingStructuredEntityName,
    );
    assert.match(preexistingStructuredEntity, /agate-64/);
    assert.doesNotMatch(preexistingStructuredEntity, /basalt-29/);
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears replay structured entity facts", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-structured-entities-"),
  );
  const resetSession = "structured-entity-reset-session";
  const otherSession = "structured-entity-other-session";
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  let adapter: Awaited<ReturnType<typeof createRemnicAdapter>> | undefined;
  let sharedEntityName = "";
  let duplicateEntityName = "";

  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey ?? "";
    const code = sessionKey === resetSession ? "iris-41" : "cedar-52";
    sharedEntityName = await this.storage.writeEntity(
      "Shared Structured Entity",
      "project",
      [`Remember the structured entity timeline code is ${code}.`],
      {
        source: "extraction",
        sessionKey,
        structuredSections: [
          {
            key: "details",
            title: "Details",
            facts: [`Remember the structured entity section code is ${code}.`],
          },
        ],
      },
    );
    if (sessionKey === resetSession) {
      await this.storage.writeEntity(
        "Duplicate Structured Entity",
        "project",
        ["Remember the duplicate structured reset timeline code is quartz-18."],
        {
          source: "extraction",
          sessionKey,
          structuredSections: [
            {
              key: "details",
              title: "Details",
              facts: ["Preserve the duplicate structured code opal-73."],
            },
          ],
        },
      );
    }
  };

  try {
    adapter = await createRemnicAdapter({
      memoryDir,
      configOverrides: {
        entityRetrievalEnabled: true,
        extractionMinUserTurns: 999,
      },
    });
    const storage = new StorageManager(memoryDir);
    duplicateEntityName = await storage.writeEntity(
      "Duplicate Structured Entity",
      "project",
      [],
      {
        structuredSections: [
          {
            key: "details",
            title: "Details",
            facts: ["Preserve the duplicate structured code opal-73."],
          },
        ],
      },
    );
    await adapter.store(resetSession, [
      {
        role: "user",
        content: "Remember the structured entity reset code is iris-41.",
      },
    ]);
    await adapter.store(otherSession, [
      {
        role: "user",
        content: "Remember the structured entity other code is cedar-52.",
      },
    ]);
    await adapter.drain?.();

    const beforeReset = await storage.readEntity(sharedEntityName);
    assert.match(beforeReset, /iris-41/);
    assert.match(beforeReset, /cedar-52/);

    await adapter.reset?.(resetSession);

    const afterReset = await storage.readEntity(sharedEntityName);
    assert.doesNotMatch(afterReset, /iris-41/);
    assert.match(afterReset, /cedar-52/);
    const duplicateAfterReset = await storage.readEntity(duplicateEntityName);
    assert.match(duplicateAfterReset, /opal-73/);
    assert.doesNotMatch(duplicateAfterReset, /quartz-18/);
  } finally {
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter?.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter scoped reset waits for background core replay", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-background-replay-"),
  );
  const releaseReplay = createDeferredForTest();
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
    options?: Parameters<Orchestrator["ingestReplayBatch"]>[1],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey;
    if (sessionKey !== "background-reset-session") {
      return originalIngestReplayBatch.call(this, turns, options);
    }

    await releaseReplay.promise;
    await this.storage.writeMemory(
      "fact",
      "Remember the background reset replay code is azalea-24.",
      { source: "unclaimed-test-source" },
    );
  };
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "background",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("background-reset-session", [
      {
        role: "user",
        content: "Remember the background reset replay code is azalea-24.",
      },
    ]);

    let resetSettled = false;
    const resetPromise = adapter.reset?.("background-reset-session").then(() => {
      resetSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(resetSettled, false);

    releaseReplay.resolve();
    await resetPromise;

    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.content.includes("azalea-24")),
      false,
    );
  } finally {
    releaseReplay.resolve();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter scoped reset marks partial replay writes after rejection", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-partial-replay-"),
  );
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
    options?: Parameters<Orchestrator["ingestReplayBatch"]>[1],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey;
    if (sessionKey !== "partial-replay-reset-session") {
      return originalIngestReplayBatch.call(this, turns, options);
    }

    await this.storage.writeMemory(
      "fact",
      "Remember the partial replay reset code is primrose-12.",
      { source: "unclaimed-test-source" },
    );
    throw new Error("simulated partial replay failure");
  };
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "background",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("partial-replay-reset-session", [
      {
        role: "user",
        content: "Remember the partial replay reset code is primrose-12.",
      },
    ]);

    await adapter.reset?.("partial-replay-reset-session");

    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.content.includes("primrose-12")),
      false,
    );
  } finally {
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter drain checks extraction idle after background replay completes", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-drain-background-replay-"),
  );
  const releaseReplay = createDeferredForTest();
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  const originalWaitForExtractionIdle = Orchestrator.prototype.waitForExtractionIdle;
  const originalWaitForConsolidationIdle = Orchestrator.prototype.waitForConsolidationIdle;
  let replayCompleted = false;
  let extractionIdleCallCount = 0;
  let extractionIdleBeforeReplay = false;
  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
    options?: Parameters<Orchestrator["ingestReplayBatch"]>[1],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey;
    if (sessionKey !== "drain-background-replay-session") {
      return originalIngestReplayBatch.call(this, turns, options);
    }

    await releaseReplay.promise;
    replayCompleted = true;
  };
  Orchestrator.prototype.waitForExtractionIdle = async function (): Promise<boolean> {
    extractionIdleCallCount += 1;
    if (!replayCompleted) {
      extractionIdleBeforeReplay = true;
    }
    return true;
  };
  Orchestrator.prototype.waitForConsolidationIdle = async function (): Promise<boolean> {
    return true;
  };
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "background",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("drain-background-replay-session", [
      {
        role: "user",
        content: "Remember the drain background replay code is anise-27.",
      },
    ]);

    let drainSettled = false;
    const drainPromise = adapter.drain?.().then(() => {
      drainSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(drainSettled, false);
    assert.equal(extractionIdleCallCount, 0);

    releaseReplay.resolve();
    await drainPromise;

    assert.equal(replayCompleted, true);
    assert.equal(extractionIdleBeforeReplay, false);
    assert.equal(extractionIdleCallCount, 1);
  } finally {
    releaseReplay.resolve();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    Orchestrator.prototype.waitForExtractionIdle = originalWaitForExtractionIdle;
    Orchestrator.prototype.waitForConsolidationIdle = originalWaitForConsolidationIdle;
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter full reset waits for background core replay before rebuild", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-background-full-"),
  );
  const sentinelPath = path.join(memoryDir, "caller-owned-sentinel.txt");
  await writeFile(sentinelPath, "preserve caller data");
  const releaseReplay = createDeferredForTest();
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
    options?: Parameters<Orchestrator["ingestReplayBatch"]>[1],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey;
    if (sessionKey !== "background-full-reset-session") {
      return originalIngestReplayBatch.call(this, turns, options);
    }

    await releaseReplay.promise;
    await this.storage.writeMemory(
      "fact",
      "Remember the background full reset replay code is marigold-64.",
      { source: "unclaimed-test-source" },
    );
  };
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "background",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("background-full-reset-session", [
      {
        role: "user",
        content: "Remember the background full reset replay code is marigold-64.",
      },
    ]);

    let resetSettled = false;
    const resetPromise = adapter.reset?.().then(() => {
      resetSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(resetSettled, false);

    releaseReplay.resolve();
    await resetPromise;

    assert.equal(await readFile(sentinelPath, "utf8"), "preserve caller data");
    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.content.includes("marigold-64")),
      false,
    );
  } finally {
    releaseReplay.resolve();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter attributes concurrent background replay memories by session", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-background-attribution-"),
  );
  const releaseFirstReplay = createDeferredForTest();
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
    options?: Parameters<Orchestrator["ingestReplayBatch"]>[1],
  ): Promise<void> {
    const sessionKey = turns[0]?.sessionKey;
    if (
      sessionKey !== "background-attribution-a" &&
      sessionKey !== "background-attribution-b"
    ) {
      return originalIngestReplayBatch.call(this, turns, options);
    }

    if (sessionKey === "background-attribution-a") {
      await releaseFirstReplay.promise;
    }
    const code = sessionKey === "background-attribution-a"
      ? "iris-31"
      : "lotus-52";
    await this.storage.writeMemory(
      "fact",
      `Remember the ${sessionKey} replay code is ${code}.`,
      { source: "unclaimed-test-source" },
    );
  };
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "background",
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  });

  try {
    await adapter.store("background-attribution-a", [
      {
        role: "user",
        content: "Remember the background-attribution-a replay code is iris-31.",
      },
    ]);
    await adapter.store("background-attribution-b", [
      {
        role: "user",
        content: "Remember the background-attribution-b replay code is lotus-52.",
      },
    ]);

    releaseFirstReplay.resolve();
    await adapter.drain?.();
    await adapter.reset?.("background-attribution-a");

    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.content.includes("iris-31")),
      false,
    );
    assert.equal(
      memories.some((memory) => memory.content.includes("lotus-52")),
      true,
    );
  } finally {
    releaseFirstReplay.resolve();
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter normalizes session IDs for scoped reset", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-normalized-session-"),
  );
  const adapterOptions = {
    memoryDir,
    configOverrides: {
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  };
  const adapter = await createRemnicAdapter(adapterOptions);

  try {
    await adapter.store("  owned-normalized-reset-session  ", [
      {
        role: "user",
        content: "Remember the normalized reset code is pearl-44.",
      },
    ]);
    await adapter.store("owned-normalized-other-session", [
      {
        role: "user",
        content: "Remember the normalized other code is granite-55.",
      },
    ]);
    await adapter.drain?.();

    assert.match(
      await adapter.recall(
        "owned-normalized-reset-session",
        "What is the normalized reset code?",
      ),
      /pearl-44/,
    );
    assert.match(
      await adapter.recall(
        "owned-normalized-other-session",
        "What is the normalized other code?",
      ),
      /granite-55/,
    );

    await assert.rejects(
      async () => {
        await adapter.reset?.("   ");
      },
      /benchmark sessionId must be non-empty/,
    );
    assert.match(
      await adapter.recall(
        "owned-normalized-other-session",
        "What is the normalized other code?",
      ),
      /granite-55/,
    );

    await adapter.reset?.("  owned-normalized-reset-session  ");
    await adapter.store("owned-normalized-reset-session", [
      {
        role: "user",
        content: "Remember the replacement normalized code is quartz-66.",
      },
    ]);
    await adapter.drain?.();

    const recalled = await adapter.recall(
      "  owned-normalized-reset-session  ",
      "What is the normalized reset code?",
    );
    assert.doesNotMatch(recalled, /pearl-44/);
    assert.match(recalled, /quartz-66/);
    assert.match(
      await adapter.recall(
        "owned-normalized-other-session",
        "What is the normalized other code?",
      ),
      /granite-55/,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset clears caller-owned cold replay state", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-cold-session-"));
  const adapterOptions = {
    memoryDir,
    configOverrides: {
      qmdColdTierEnabled: true,
      transcriptEnabled: true,
      extractionMinUserTurns: 999,
    },
  };
  const adapter = await createRemnicAdapter(adapterOptions);

  try {
    const coldStorage = new StorageManager(path.join(memoryDir, "cold"));
    const resetColdId = await coldStorage.writeMemory(
      "fact",
      "Remember the stale cold reset code is frost-77.",
      { source: benchReplaySourceForTest("owned-cold-reset-session") },
    );
    const otherColdId = await coldStorage.writeMemory(
      "fact",
      "Remember the other cold reset code is ember-88.",
      { source: benchReplaySourceForTest("owned-cold-other-session") },
    );

    await adapter.reset?.("owned-cold-reset-session");

    const coldMemories = await new StorageManager(memoryDir).readAllColdMemories();
    assert.equal(
      coldMemories.some((memory) => memory.frontmatter.id === resetColdId),
      false,
    );
    assert.equal(
      coldMemories.some((memory) => memory.frontmatter.id === otherColdId),
      true,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter session reset tracks replay-created cold memories", async () => {
  const memoryDir = await mkdtemp(
    path.join(tmpdir(), "remnic-bench-reset-replay-cold-session-"),
  );
  const resetSession = "replay-cold-reset-session";
  const otherSession = "replay-cold-other-session";
  const originalIngestReplayBatch = Orchestrator.prototype.ingestReplayBatch;
  let adapter: Awaited<ReturnType<typeof createRemnicAdapter>> | undefined;

  Orchestrator.prototype.ingestReplayBatch = async function (
    this: Orchestrator,
    turns: Parameters<Orchestrator["ingestReplayBatch"]>[0],
  ): Promise<void> {
    const content = turns.map((turn) => turn.content).join("\n");
    const code = content.includes("glacier-31") ? "glacier-31" : "lantern-46";
    const memoryId = await this.storage.writeMemory(
      "fact",
      `Remember the replay-created cold reset code is ${code}.`,
    );
    const memory = (await this.storage.readAllMemories())
      .find((candidate) => candidate.frontmatter.id === memoryId);
    assert.ok(memory);
    await this.storage.migrateMemoryToTier(memory, "cold");
  };

  try {
    adapter = await createRemnicAdapter({
      memoryDir,
      configOverrides: {
        qmdColdTierEnabled: true,
        transcriptEnabled: true,
        extractionMinUserTurns: 999,
      },
    });
    await adapter.store(resetSession, [
      {
        role: "user",
        content: "Remember the replay-created cold reset code is glacier-31.",
      },
    ]);
    await adapter.store(otherSession, [
      {
        role: "user",
        content: "Remember the replay-created cold other code is lantern-46.",
      },
    ]);
    await adapter.drain?.();

    const beforeReset = await new StorageManager(memoryDir).readAllColdMemories();
    assert.equal(beforeReset.some((memory) => memory.content.includes("glacier-31")), true);
    assert.equal(beforeReset.some((memory) => memory.content.includes("lantern-46")), true);

    await adapter.reset?.(resetSession);

    const afterReset = await new StorageManager(memoryDir).readAllColdMemories();
    assert.equal(afterReset.some((memory) => memory.content.includes("glacier-31")), false);
    assert.equal(afterReset.some((memory) => memory.content.includes("lantern-46")), true);
  } finally {
    Orchestrator.prototype.ingestReplayBatch = originalIngestReplayBatch;
    await adapter?.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter full reset clears caller-owned core state when replay is skipped", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-skip-full-"));
  const sentinelPath = path.join(memoryDir, "caller-owned-sentinel.txt");
  await writeFile(sentinelPath, "preserve caller data");
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "skip",
    configOverrides: {
      transcriptEnabled: true,
    },
  });

  try {
    const staleId = await new StorageManager(memoryDir).writeMemory(
      "fact",
      "Remember the stale skip full reset code is saffron-18.",
      { source: benchReplaySourceForTest("skip-full-reset-session") },
    );

    await adapter.reset?.();

    assert.equal(await readFile(sentinelPath, "utf8"), "preserve caller data");
    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.frontmatter.id === staleId),
      false,
    );
  } finally {
    await adapter.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("direct adapter scoped reset clears caller-owned core state when replay is skipped", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-bench-reset-skip-session-"));
  const adapter = await createRemnicAdapter({
    memoryDir,
    replayExtractionMode: "skip",
    configOverrides: {
      transcriptEnabled: true,
    },
  });

  try {
    const storage = new StorageManager(memoryDir);
    const resetId = await storage.writeMemory(
      "fact",
      "Remember the stale skip session reset code is topaz-74.",
      { source: benchReplaySourceForTest("skip-reset-session") },
    );
    const otherId = await storage.writeMemory(
      "fact",
      "Remember the other skip session code is opal-36.",
      { source: benchReplaySourceForTest("skip-other-session") },
    );

    await adapter.reset?.("skip-reset-session");

    const memories = await new StorageManager(memoryDir).readAllMemories();
    assert.equal(
      memories.some((memory) => memory.frontmatter.id === resetId),
      false,
    );
    assert.equal(
      memories.some((memory) => memory.frontmatter.id === otherId),
      true,
    );
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
