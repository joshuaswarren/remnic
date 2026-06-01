import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { recordObjectiveStateSnapshot } from "../src/objective-state.js";

async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function buildObjectiveStateRecallHarness(options: {
  objectiveStateRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-npm-failure",
      recordedAt: "2026-03-07T10:00:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "process",
      changeKind: "failed",
      scope: "npm test",
      summary: "Verification run failed with 3 test failures in npm test.",
      toolName: "exec_command",
      command: "npm test",
      outcome: "failure",
      tags: ["verification", "tests"],
    },
  });

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: options.objectiveStateRecallEnabled,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("recall injects objective-state section when retrieval is enabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.match(context, /## Objective State/);
  assert.match(context, /Verification run failed with 3 test failures in npm test/i);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits objective-state section when retrieval flag is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});

test("recall omits objective-state section when pipeline section is disabled", async () => {
  const orchestrator = await buildObjectiveStateRecallHarness({
    objectiveStateRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did npm test fail during verification?",
    "agent:main",
  );

  assert.equal(context.includes("## Objective State"), false);
});

test("recall searches objective-state snapshots from the requested namespace store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-ns-"));
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["alice"],
        writePrincipals: ["alice"],
        includeInRecallByDefault: false,
      },
    ],
    defaultRecallNamespaces: ["self"],
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: true,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  try {
    await recordObjectiveStateSnapshot({
      memoryDir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-global-validation",
        recordedAt: "2026-03-07T10:00:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run validation",
        summary: "Global validation failed with a default-namespace error.",
        toolName: "exec_command",
        command: "npm run validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });
    const teamStorage = await orchestrator.getStorage("team-a");
    await recordObjectiveStateSnapshot({
      memoryDir: teamStorage.dir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-team-validation",
        recordedAt: "2026-03-07T10:01:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run team-validation",
        summary: "Team validation failed with a namespace-scoped error.",
        toolName: "exec_command",
        command: "npm run team-validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });
    await recordObjectiveStateSnapshot({
      memoryDir: teamStorage.dir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-team-other-validation",
        recordedAt: "2026-03-07T10:02:00.000Z",
        sessionKey: "agent:other",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run team-validation",
        summary: "Other validation failed with a namespace-scoped error.",
        toolName: "exec_command",
        command: "npm run team-validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });

    const context = await (orchestrator as any).recallInternal(
      "Why did validation fail?",
      "agent:main",
      { namespace: "team-a", principalOverride: "alice" },
    );

    assert.match(context, /## Objective State/);
    assert.match(context, /namespace-scoped error/i);
    assert.equal(context.includes("default-namespace error"), false);
    assert.ok(
      context.indexOf("Team validation failed") <
        context.indexOf("Other validation failed"),
      "raw session-key boost should rank the current session first",
    );
  } finally {
    await orchestrator.destroy();
    await removeTempDir(memoryDir);
  }
});

test("recall searches objective-state snapshots from routed default namespace storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-default-ns-"));
  await mkdir(path.join(memoryDir, "namespaces", "global"), { recursive: true });
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: true,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  try {
    await recordObjectiveStateSnapshot({
      memoryDir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-legacy-default-validation",
        recordedAt: "2026-03-07T10:00:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run validation",
        summary: "Legacy root validation failed in the old default store.",
        toolName: "exec_command",
        command: "npm run validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });
    const defaultStorage = await orchestrator.getStorage("global");
    await recordObjectiveStateSnapshot({
      memoryDir: defaultStorage.dir,
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-routed-default-validation",
        recordedAt: "2026-03-07T10:01:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run validation",
        summary: "Routed default validation failed in the namespace store.",
        toolName: "exec_command",
        command: "npm run validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });

    const context = await (orchestrator as any).recallInternal(
      "Why did validation fail?",
      "agent:main",
    );

    assert.match(context, /## Objective State/);
    assert.match(context, /namespace store/i);
    assert.equal(context.includes("old default store"), false);
  } finally {
    await orchestrator.destroy();
    await removeTempDir(memoryDir);
  }
});

test("recall searches namespaced objective-state snapshots from configured store override", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-override-ns-"));
  const overrideDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-recall-override-store-"));
  await mkdir(path.join(memoryDir, "namespaces", "global"), { recursive: true });
  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    namespacesEnabled: true,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self"],
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    objectiveStateRecallEnabled: true,
    objectiveStateStoreDir: overrideDir,
    recallPipeline: [
      {
        id: "objective-state",
        enabled: true,
        maxResults: 2,
        maxChars: 1200,
      },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  try {
    const defaultStorage = await orchestrator.getStorage("global");
    await recordObjectiveStateSnapshot({
      memoryDir: defaultStorage.dir,
      objectiveStateStoreDir: path.join(overrideDir, "namespaces", "global"),
      snapshot: {
        schemaVersion: 1,
        snapshotId: "snap-override-default-validation",
        recordedAt: "2026-03-07T10:01:00.000Z",
        sessionKey: "agent:main",
        source: "tool_result",
        kind: "process",
        changeKind: "failed",
        scope: "npm run validation",
        summary: "Override default validation failed in the configured store.",
        toolName: "exec_command",
        command: "npm run validation",
        outcome: "failure",
        tags: ["validation"],
      },
    });

    const context = await (orchestrator as any).recallInternal(
      "Why did validation fail?",
      "agent:main",
    );

    assert.match(context, /## Objective State/);
    assert.match(context, /configured store/i);
  } finally {
    await orchestrator.destroy();
    await removeTempDir(memoryDir);
    await removeTempDir(overrideDir);
  }
});
