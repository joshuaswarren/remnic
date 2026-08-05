import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import {
  getCausalTrajectoryStoreStatus,
  readCausalTrajectoryRecordsStrict,
  readCausalTrajectoryRevisionToken,
  recordCausalTrajectory,
  resolveCausalTrajectoryStoreDir,
  validateCausalTrajectoryRecord,
} from "../src/causal-trajectory.js";
import { runCausalTrajectoryStatusCliCommand } from "../src/cli.js";

test("causal-trajectory config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveCausalTrajectoryStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "causal-trajectories"),
  );
});

test("validateCausalTrajectoryRecord accepts the normalized causal chain contract", () => {
  const record = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: "traj-1",
    recordedAt: "2026-03-07T10:00:00.000Z",
    sessionKey: "agent:main",
    goal: "Recover a failing verification run",
    actionSummary: "Ran npm test after updating parser handling",
    observationSummary: "The run still reported 3 failures in objective-state output",
    outcomeKind: "failure",
    outcomeSummary: "Verification is still red because negated pass phrases are misclassified",
    followUpSummary: "Patch the negation parser and rerun the focused tests",
    objectiveStateSnapshotRefs: ["snap-verify-failure", "snap-parser-edit"],
    entityRefs: ["repo:openclaw-engram"],
    tags: ["verification", "trajectory"],
    metadata: { source: "agent_end" },
  });

  assert.equal(record.trajectoryId, "traj-1");
  assert.equal(record.outcomeKind, "failure");
  assert.deepEqual(record.objectiveStateSnapshotRefs, ["snap-verify-failure", "snap-parser-edit"]);
});

test("recordCausalTrajectory persists records into dated causal-trajectory storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-record-"));
  const filePath = await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-2",
      recordedAt: "2026-03-07T10:01:00.000Z",
      sessionKey: "agent:main",
      goal: "Validate the PR8 store contract",
      actionSummary: "Persisted the first causal trajectory record",
      observationSummary: "The store directory should now contain a dated JSON artifact",
      outcomeKind: "success",
      outcomeSummary: "Record write completed without errors",
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "causal-trajectories", "trajectories", "2026-03-07", "traj-2.json"),
  );
});

test("recordCausalTrajectory rejects unsafe ids and malformed timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-reject-"));

  await assert.rejects(
    () =>
      recordCausalTrajectory({
        memoryDir,
        record: {
          schemaVersion: 1,
          trajectoryId: "../escape",
          recordedAt: "2026-03-07T10:02:00.000Z",
          sessionKey: "agent:main",
          goal: "Invalid path test",
          actionSummary: "Attempted to persist an unsafe id",
          observationSummary: "The validator should reject path traversal",
          outcomeKind: "failure",
          outcomeSummary: "Path traversal blocked",
        },
      }),
    /trajectoryId must be a safe path segment/i,
  );

  await assert.rejects(
    () =>
      recordCausalTrajectory({
        memoryDir,
        record: {
          schemaVersion: 1,
          trajectoryId: "traj-bad-date",
          recordedAt: "not-a-date",
          sessionKey: "agent:main",
          goal: "Invalid timestamp test",
          actionSummary: "Attempted to persist a malformed timestamp",
          observationSummary: "The validator should reject non-ISO dates",
          outcomeKind: "failure",
          outcomeSummary: "Bad timestamp blocked",
        },
      }),
    /recordedAt must be an ISO timestamp/i,
  );

  const strict = await readCausalTrajectoryRecordsStrict({ memoryDir });
  assert.equal(strict.status, "absent");
  assert.deepEqual(strict.files, []);
});

test("causal-trajectory status reports valid and invalid records", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-status-"));
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-3",
      recordedAt: "2026-03-07T10:03:00.000Z",
      sessionKey: "agent:main",
      goal: "Diagnose merge readiness",
      actionSummary: "Reran the stale review-thread check",
      observationSummary: "GitHub reported a fresh successful rerun",
      outcomeKind: "success",
      outcomeSummary: "The PR became merge-ready",
      objectiveStateSnapshotRefs: ["snap-rerun-thread-check"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "causal-trajectories",
    "trajectories",
    "2026-03-07",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, trajectoryId: "" }, null, 2), "utf8");

  const status = await getCausalTrajectoryStoreStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.trajectories.total, 2);
  assert.equal(status.trajectories.valid, 1);
  assert.equal(status.trajectories.invalid, 1);
  assert.equal(status.trajectories.byOutcome.success, 1);
  assert.equal(status.latestTrajectory?.trajectoryId, "traj-3");
  assert.match(status.invalidTrajectories[0]?.path ?? "", /invalid\.json$/);
});

test("causal-trajectory-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-cli-"));
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-4",
      recordedAt: "2026-03-07T10:04:00.000Z",
      sessionKey: "agent:main",
      goal: "Prepare PR9 graph work",
      actionSummary: "Stored the causal chain foundation",
      observationSummary: "The trajectory store now has one valid record",
      outcomeKind: "partial",
      outcomeSummary: "Storage exists, but graph wiring is still future work",
    },
  });

  const status = await runCausalTrajectoryStatusCliCommand({
    memoryDir,
    causalTrajectoryMemoryEnabled: true,
  });

  assert.equal(status.trajectories.total, 1);
  assert.equal(status.latestTrajectory?.trajectoryId, "traj-4");
  assert.equal(status.trajectories.byOutcome.partial, 1);
});
test("validateCausalTrajectoryRecord accepts optional typed identity and preserves schema-v1 legacy reads", () => {
  const legacyRecord = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: "legacy-traj-1",
    recordedAt: "2026-03-07T10:00:00.000Z",
    sessionKey: "session-1",
    goal: "Legacy goal",
    actionSummary: "Legacy action",
    observationSummary: "Legacy observation",
    outcomeKind: "failure",
    outcomeSummary: "Legacy failure",
  });
  assert.equal(legacyRecord.trajectoryId, "legacy-traj-1");
  assert.equal(legacyRecord.codingContext, undefined);
  assert.equal(legacyRecord.actionIdentity, undefined);

  const typedRecord = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: "typed-traj-1",
    recordedAt: "2026-03-07T10:05:00.000Z",
    sessionKey: "session-2",
    goal: "Typed goal",
    actionSummary: "npm test",
    observationSummary: "Command failed",
    outcomeKind: "failure",
    outcomeSummary: "Exit code 1",
    codingContext: {
      projectId: "proj-alpha",
      branch: "main",
    },
    actionIdentity: {
      fingerprintVersion: 1,
      strategyId: "RUN_CHECK",
      fingerprint: `v1:sha256:${"a".repeat(64)}`,
    },
  });
  assert.equal(typedRecord.codingContext?.projectId, "proj-alpha");
  assert.equal(typedRecord.actionIdentity?.fingerprintVersion, 1);
  assert.equal(typedRecord.actionIdentity?.strategyId, "RUN_CHECK");
  assert.equal(typedRecord.actionSummary, "npm test");
});

test("recordCausalTrajectory performs atomic write and advances causal trajectory revision", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-atomic-"));

  const filePath = await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "atomic-traj-1",
      recordedAt: "2026-03-07T10:10:00.000Z",
      sessionKey: "session-3",
      goal: "Test atomic write",
      actionSummary: "Write file atomically",
      observationSummary: "File persisted",
      outcomeKind: "success",
      outcomeSummary: "Success",
    },
  });

  assert.ok(filePath.endsWith("atomic-traj-1.json"));
  // 1. Assert readback
  const readback = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(readback.trajectoryId, "atomic-traj-1");

  // 2. Assert no .tmp file residue
  const dir = path.dirname(filePath);
  const files = await readdir(dir);
  const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0);
});

test("recordCausalTrajectory rolls back publication and temp files when revision publication fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-revision-failure-"));
  const storeRoot = path.join(memoryDir, "state", "causal-trajectories");
  await mkdir(path.join(storeRoot, "revision.json"), { recursive: true });

  await assert.rejects(() => recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "revision-failure",
      recordedAt: "2026-03-07T10:10:00.000Z",
      sessionKey: "session",
      goal: "Exercise rollback",
      actionSummary: "Publish trajectory",
      observationSummary: "Revision write fails",
      outcomeKind: "failure",
      outcomeSummary: "Revision failure",
    },
  }));

  const dayDir = path.join(storeRoot, "trajectories", "2026-03-07");
  assert.deepEqual(await readdir(dayDir), []);
  assert.deepEqual((await readdir(storeRoot)).filter((name) => name.endsWith(".tmp")), []);
});

test("recordCausalTrajectory keeps trajectory IDs immutable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-immutable-"));
  const record = {
    schemaVersion: 1 as const,
    trajectoryId: "immutable-id",
    recordedAt: "2026-03-07T10:10:00.000Z",
    sessionKey: "session",
    goal: "Preserve identity",
    actionSummary: "First publication",
    observationSummary: "Published",
    outcomeKind: "success" as const,
    outcomeSummary: "First content",
  };
  const filePath = await recordCausalTrajectory({ memoryDir, record });
  await assert.rejects(
    () => recordCausalTrajectory({
      memoryDir,
      record: { ...record, actionSummary: "Replacement content" },
    }),
    /already exists/,
  );
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).actionSummary, "First publication");
});

test("readCausalTrajectoryRevisionToken rejects malformed present revision files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-bad-revision-"));
  const storeRoot = path.join(memoryDir, "state", "causal-trajectories");
  await mkdir(storeRoot, { recursive: true });
  await writeFile(path.join(storeRoot, "revision.json"), JSON.stringify({ updatedAt: "missing-token" }));
  await assert.rejects(
    () => readCausalTrajectoryRevisionToken({ memoryDir }),
    /revision\.json must contain a non-empty revisionToken/,
  );
});

test("readCausalTrajectoryRecordsStrict distinguishes empty from success and throws on store failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-strict-"));

  const absent = await readCausalTrajectoryRecordsStrict({ memoryDir });
  assert.equal(absent.status, "absent");
  assert.equal(absent.trajectories.length, 0);

  await mkdir(path.join(memoryDir, "state", "causal-trajectories", "trajectories"), { recursive: true });
  const empty = await readCausalTrajectoryRecordsStrict({ memoryDir });
  assert.equal(empty.status, "empty");

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "strict-traj-1",
      recordedAt: "2026-03-07T10:15:00.000Z",
      sessionKey: "session-4",
      goal: "Strict goal",
      actionSummary: "Strict action",
      observationSummary: "Strict obs",
      outcomeKind: "failure",
      outcomeSummary: "Strict failure",
    },
  });

  const okRes = await readCausalTrajectoryRecordsStrict({ memoryDir });
  assert.equal(okRes.status, "ok");
  assert.equal(okRes.trajectories.length, 1);
  assert.equal(okRes.trajectories[0].trajectoryId, "strict-traj-1");
});
