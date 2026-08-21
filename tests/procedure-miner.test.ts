import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";
import { runProcedureMining } from "../packages/remnic-core/src/procedural/procedure-miner.ts";

async function writeTrajectory(
  root: string,
  id: string,
  goal: string,
  outcome: "success" | "failure",
  recordedAt: string,
) {
  const day = recordedAt.slice(0, 10);
  const dir = path.join(root, "state", "causal-trajectories", "trajectories", day);
  await mkdir(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    trajectoryId: id,
    recordedAt,
    sessionKey: "test-session",
    goal,
    actionSummary: "Ran validation and deployed the service.",
    observationSummary: "Health checks passed.",
    outcomeKind: outcome,
    outcomeSummary: outcome === "success" ? "Completed without errors." : "Rolled back.",
    entityRefs: ["project-demo"],
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), "utf-8");
}

test("runProcedureMining writes a pending_review procedure for recurring successful trajectories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-miner-"));
  try {
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const g = "Ship the demo gateway to staging";
    await writeTrajectory(dir, "t-a", g, "success", iso(new Date(now.getTime() - 86_400_000)));
    await writeTrajectory(dir, "t-b", g, "success", iso(new Date(now.getTime() - 2 * 86_400_000)));
    await writeTrajectory(dir, "t-c", g, "success", iso(new Date(now.getTime() - 3 * 86_400_000)));

    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: {
        enabled: true,
        minOccurrences: 3,
        successFloor: 0.6,
        lookbackDays: 30,
        autoPromoteEnabled: false,
        autoPromoteOccurrences: 8,
      },
    });

    const result = await runProcedureMining({ memoryDir: dir, storage, config });
    assert.equal(result.proceduresWritten, 1);
    assert.ok((result.clustersProcessed ?? 0) >= 1);

    const memories = await storage.readAllMemories();
    const proc = memories.find((m) => m.frontmatter.category === "procedure");
    assert.ok(proc);
    assert.equal(proc.frontmatter.status, "pending_review");
    assert.equal(proc.frontmatter.structuredAttributes?.trajectory_count, "3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runProcedureMining no-ops when procedural.enabled is false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-miner-off-"));
  try {
    const storage = new StorageManager(dir);
    const config = parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "ws"),
      openaiApiKey: "test-key",
      procedural: { enabled: false },
    });
    const result = await runProcedureMining({ memoryDir: dir, storage, config });
    assert.equal(result.proceduresWritten, 0);
    assert.equal(result.skippedReason, "procedural_disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
