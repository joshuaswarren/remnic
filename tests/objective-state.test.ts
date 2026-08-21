import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  getObjectiveStateStoreStatus,
  recordObjectiveStateSnapshot,
  resolveObjectiveStateStoreDir,
  searchObjectiveStateSnapshots,
  validateObjectiveStateSnapshot,
} from "../src/objective-state.js";
import { runObjectiveStateStatusCliCommand } from "../src/cli.js";

test("objective-state config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveObjectiveStateStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "objective-state"),
  );
});

test("validateObjectiveStateSnapshot accepts a normalized snapshot contract", () => {
  const snapshot = validateObjectiveStateSnapshot({
    schemaVersion: 1,
    snapshotId: "snap-1",
    recordedAt: "2026-03-07T09:30:00.000Z",
    sessionKey: "agent:main",
    source: "tool_result",
    kind: "file",
    changeKind: "updated",
    scope: "workspace/package.json",
    summary: "Updated package metadata after a release tool run.",
    toolName: "write_file",
    outcome: "success",
    before: { exists: true, valueHash: "sha256-before" },
    after: { exists: true, valueHash: "sha256-after", ref: "workspace/package.json" },
    entityRefs: ["repo:openclaw-engram"],
    tags: ["release", "workspace"],
    metadata: { actor: "engram" },
  });

  assert.equal(snapshot.snapshotId, "snap-1");
  assert.equal(snapshot.kind, "file");
  assert.equal(snapshot.outcome, "success");
  assert.deepEqual(snapshot.tags, ["release", "workspace"]);
});

test("recordObjectiveStateSnapshot persists snapshots into dated objective-state storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-record-"));
  const filePath = await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-2",
      recordedAt: "2026-03-07T09:31:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "process",
      changeKind: "executed",
      scope: "npm test",
      summary: "Ran the local verification suite.",
      command: "npm test",
      outcome: "success",
      tags: ["verification"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "objective-state", "snapshots", "2026-03-07", "snap-2.json"),
  );
});

test("recordObjectiveStateSnapshot rejects unsafe snapshot paths and malformed dates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-reject-"));

  await assert.rejects(
    () =>
      recordObjectiveStateSnapshot({
        memoryDir,
        snapshot: {
          schemaVersion: 1,
          snapshotId: "../../escape",
          recordedAt: "2026-03-07T09:31:00.000Z",
          sessionKey: "agent:main",
          source: "cli",
          kind: "process",
          changeKind: "executed",
          scope: "npm test",
          summary: "Attempted invalid snapshot id.",
        },
      }),
    /snapshotId must be a safe path segment/i,
  );

  await assert.rejects(
    () =>
      recordObjectiveStateSnapshot({
        memoryDir,
        snapshot: {
          schemaVersion: 1,
          snapshotId: "snap-unsafe-date",
          recordedAt: "not-a-date",
          sessionKey: "agent:main",
          source: "cli",
          kind: "process",
          changeKind: "executed",
          scope: "npm test",
          summary: "Attempted invalid recordedAt.",
        },
      }),
    /recordedAt must be an ISO timestamp/i,
  );
});

test("objective-state status reports valid and invalid snapshots", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-status-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-3",
      recordedAt: "2026-03-07T09:32:00.000Z",
      sessionKey: "agent:main",
      source: "system",
      kind: "workspace",
      changeKind: "observed",
      scope: "workspace-root",
      summary: "Observed the current workspace health.",
      outcome: "unknown",
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "objective-state",
    "snapshots",
    "2026-03-07",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, snapshotId: "" }, null, 2), "utf8");

  const status = await getObjectiveStateStoreStatus({
    memoryDir,
    enabled: true,
    writesEnabled: false,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.writesEnabled, false);
  assert.equal(status.snapshots.total, 2);
  assert.equal(status.snapshots.valid, 1);
  assert.equal(status.snapshots.invalid, 1);
  assert.equal(status.snapshots.byKind.workspace, 1);
  assert.equal(status.snapshots.byOutcome.unknown, 1);
  assert.equal(status.latestSnapshot?.snapshotId, "snap-3");
  assert.match(status.invalidSnapshots[0]?.path ?? "", /invalid\.json$/);
});

test("objective-state search ranks prompt-relevant snapshots and ignores invalid files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-search-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-verify-failure",
      recordedAt: "2026-03-07T09:35:00.000Z",
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
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-readme-update",
      recordedAt: "2026-03-07T09:36:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "file",
      changeKind: "updated",
      scope: "README.md",
      summary: "Updated README examples for objective-state status usage.",
      toolName: "edit_file",
      outcome: "success",
      tags: ["docs"],
    },
  });
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-irrelevant-newer",
      recordedAt: "2026-03-07T11:36:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "workspace",
      changeKind: "observed",
      scope: "workspace-root",
      summary: "Observed the workspace heartbeat after a docs update.",
      outcome: "success",
      tags: ["workspace"],
    },
  });
  await writeFile(
    path.join(memoryDir, "state", "objective-state", "snapshots", "2026-03-07", "invalid.json"),
    JSON.stringify({ schemaVersion: 1, snapshotId: "" }, null, 2),
    "utf8",
  );

  const results = await searchObjectiveStateSnapshots({
    memoryDir,
    query: "Why did npm test fail during verification?",
    maxResults: 2,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.snapshot.snapshotId, "snap-verify-failure");
  assert.equal(results.some((result) => result.snapshot.snapshotId === "snap-irrelevant-newer"), false);
  assert.equal(results.some((result) => result.snapshot.snapshotId === "snap-readme-update"), false);
  assert.equal(results.some((result) => result.snapshot.snapshotId === "invalid"), false);
});

test("objective-state-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-objective-state-cli-"));
  await recordObjectiveStateSnapshot({
    memoryDir,
    snapshot: {
      schemaVersion: 1,
      snapshotId: "snap-4",
      recordedAt: "2026-03-07T09:33:00.000Z",
      sessionKey: "agent:main",
      source: "manual",
      kind: "record",
      changeKind: "created",
      scope: "salesforce:inventory:record-42",
      summary: "Created an inventory reconciliation record.",
      outcome: "partial",
      entityRefs: ["record:42"],
    },
  });

  const status = await runObjectiveStateStatusCliCommand({
    memoryDir,
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
  });

  assert.equal(status.snapshots.total, 1);
  assert.equal(status.latestSnapshot?.snapshotId, "snap-4");
  assert.equal(status.snapshots.byOutcome.partial, 1);
});
