/**
 * Session-end experience memories as procedure-mining input (issue #2979 layer 3).
 *
 * Promoted episodes (experience_* attributes, status active) join the miner
 * record set when sessionExperience.enabled is on. Gate off: miner input is
 * byte-identical to the trajectory-only set (no experience records).
 * pending_review stays out.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import type { BufferTurn, PluginConfig } from "../types.js";
import { StorageManager } from "../storage.js";
import {
  filterTrajectoriesByLookbackDays,
  readCausalTrajectoryRecords,
  recordCausalTrajectory,
} from "../causal-trajectory.js";
import { runProcedureMining } from "../procedural/procedure-miner.js";
import { runSessionExperienceExtraction } from "./session-experience.js";
import { collectProcedureMiningRecords } from "./session-experience-mining.js";

function turn(role: "user" | "assistant", content: string): BufferTurn {
  return { role, content, timestamp: "2026-01-15T10:00:00.000Z" };
}

function successSession(): BufferTurn[] {
  return [
    turn("user", "Fix the failing integration test in the payments module. The test times out after 30 seconds."),
    turn("assistant", "I will inspect the payments test file and reproduce the timeout locally first."),
    turn("assistant", "The timeout came from an unawaited database call in the test setup. I added the missing await."),
    turn("assistant", "Verified: the payments integration test passes now and the full suite is green."),
  ];
}

function miningConfig(memoryDir: string, experienceEnabled: boolean): PluginConfig {
  return parseConfig({
    memoryDir,
    sessionExperience: { enabled: experienceEnabled },
    procedural: {
      enabled: true,
      minOccurrences: 2,
      lookbackDays: 30,
      successFloor: 1,
      autoPromoteEnabled: false,
      autoPromoteOccurrences: 10,
    },
  });
}

async function writePromotedExperience(
  storage: StorageManager,
  config: PluginConfig,
  sessionKey: string,
): Promise<string> {
  const written = await runSessionExperienceExtraction({
    turns: successSession(),
    sessionKey,
    config,
    storage,
  });
  assert.equal(written.written, true);
  assert.ok(written.memoryId);
  const promoted = await storage.updateMemoryFrontmatter(written.memoryId, { status: "active" });
  assert.equal(promoted, true);
  return written.memoryId;
}

test("gate off: miner input is byte-identical to the trajectory-only set", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-mine-off-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const on = miningConfig(memoryDir, true);
    await writePromotedExperience(storage, on, "session-mine-off-a");
    await writePromotedExperience(storage, on, "session-mine-off-b");
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: "traj-off-1",
        recordedAt: new Date().toISOString(),
        sessionKey: "traj-session",
        goal: "Ship the demo gateway to staging",
        actionSummary: "Confirm the requirements and prepare the working plan.",
        observationSummary: "The run produced a reusable sequence of actions.",
        outcomeKind: "success",
        outcomeSummary: "The workflow completed successfully with a reusable result.",
        entityRefs: ["project-demo"],
      },
    });

    const off = miningConfig(memoryDir, false);
    const { trajectories } = await readCausalTrajectoryRecords({ memoryDir });
    const nowMs = Date.now();
    const expected = filterTrajectoriesByLookbackDays(trajectories, off.procedural.lookbackDays, nowMs);
    const actual = await collectProcedureMiningRecords({
      trajectories,
      lookbackDays: off.procedural.lookbackDays,
      storage: {
        async readAllMemories() {
          throw new Error("gate-off miner input must not read memories");
        },
      },
      experienceEnabled: false,
      nowMs,
    });
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.equal(
      actual.some((r) => r.trajectoryId.startsWith("experience:")),
      false,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gate on: promoted experience memories feed the miner; pending_review does not", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-mine-on-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const config = miningConfig(memoryDir, true);
    await writePromotedExperience(storage, config, "session-mine-on-a");
    await writePromotedExperience(storage, config, "session-mine-on-b");
    const pending = await runSessionExperienceExtraction({
      turns: successSession(),
      sessionKey: "session-mine-on-pending",
      config,
      storage,
    });
    assert.equal(pending.written, true);

    const { trajectories } = await readCausalTrajectoryRecords({ memoryDir });
    const records = await collectProcedureMiningRecords({
      trajectories,
      lookbackDays: config.procedural.lookbackDays,
      storage,
      experienceEnabled: true,
    });
    const experienceIds = records.filter((r) => r.trajectoryId.startsWith("experience:")).map((r) => r.trajectoryId);
    assert.equal(experienceIds.length, 2, "only the two promoted episodes enter mining");
    assert.ok(records.every((r) => r.goal.toLowerCase().includes("payments")));

    const result = await runProcedureMining({ memoryDir, storage, config });
    assert.equal(result.proceduresWritten, 1);
    assert.ok((result.clustersProcessed ?? 0) >= 1);
    const memories = await storage.readAllMemories();
    const mined = memories.find(
      (m) =>
        m.frontmatter.category === "procedure" &&
        typeof m.frontmatter.structuredAttributes?.procedure_cluster_hash === "string" &&
        (m.frontmatter.structuredAttributes.trajectory_ids ?? "").includes("experience:"),
    );
    assert.ok(mined, "mined procedure must cite experience trajectory ids");
    assert.equal(mined.frontmatter.status, "pending_review");
    assert.equal(mined.frontmatter.structuredAttributes?.trajectory_count, "2");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gate off: two promoted experiences do not produce a mined procedure", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-sx-mine-off-write-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const enabled = miningConfig(memoryDir, true);
    await writePromotedExperience(storage, enabled, "session-mine-off-write-a");
    await writePromotedExperience(storage, enabled, "session-mine-off-write-b");
    const off = miningConfig(memoryDir, false);
    const result = await runProcedureMining({ memoryDir, storage, config: off });
    assert.equal(result.proceduresWritten, 0);
    const memories = await storage.readAllMemories();
    assert.equal(
      memories.filter((m) => m.frontmatter.structuredAttributes?.procedure_cluster_hash !== undefined).length,
      0,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
