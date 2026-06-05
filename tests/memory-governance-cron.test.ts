import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  ensureDaySummaryCron,
  ensureGraphEdgeDecayCron,
  graphEdgeDecayCadenceToCronExpr,
  ensureNightlyGovernanceCron,
  ensureProceduralMiningCron,
  ensurePatternReinforcementCron,
} from "../src/maintenance/memory-governance-cron.ts";

test("nightly governance cron auto-registers a bounded job once", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-governance-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");

  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");

    const first = await ensureNightlyGovernanceCron(jobsPath, {
      timezone: "America/Chicago",
    });
    assert.equal(first.created, true);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{
        id: string;
        schedule: { kind: string; expr: string; tz: string };
        payload: { kind: string; message: string };
      }>;
    };
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.jobs[0]?.id, "engram-nightly-governance");
    assert.deepEqual(parsed.jobs[0]?.schedule, {
      kind: "cron",
      expr: "23 2 * * *",
      tz: "America/Chicago",
    });
    assert.match(parsed.jobs[0]?.payload.message ?? "", /engram\.memory_governance_run/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"mode": "apply"/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"recentDays": 2/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"maxMemories": 500/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"batchSize": 100/);

    const second = await ensureNightlyGovernanceCron(jobsPath, {
      timezone: "America/Chicago",
    });
    assert.equal(second.created, false);

    const deduped = JSON.parse(await readFile(jobsPath, "utf-8")) as { jobs: Array<{ id: string }> };
    assert.equal(deduped.jobs.filter((job) => job.id === "engram-nightly-governance").length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("day-summary and nightly governance cron registration share the same write lock", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-governance-cron-lock-"));
  const jobsPath = path.join(tempDir, "jobs.json");

  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");

    const [daySummary, governance] = await Promise.all([
      ensureDaySummaryCron(jobsPath, { timezone: "America/Chicago" }),
      ensureNightlyGovernanceCron(jobsPath, { timezone: "America/Chicago" }),
    ]);

    assert.equal(daySummary.created, true);
    assert.equal(governance.created, true);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as { jobs: Array<{ id: string }> };
    assert.deepEqual(
      parsed.jobs.map((job) => job.id).sort(),
      ["engram-day-summary", "engram-nightly-governance"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("procedural mining cron registers once and references engram.procedure_mining_run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-procedural-mining-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");
  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");
    const first = await ensureProceduralMiningCron(jobsPath, { timezone: "UTC" });
    assert.equal(first.created, true);
    const second = await ensureProceduralMiningCron(jobsPath, { timezone: "UTC" });
    assert.equal(second.created, false);
    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{ id: string; payload: { message: string } }>;
    };
    const job = parsed.jobs.find((j) => j.id === "engram-procedural-mining");
    assert.ok(job);
    assert.match(job.payload.message, /engram\.procedure_mining_run/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("pattern reinforcement cron registers once and references engram.pattern_reinforcement_run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-pattern-reinforcement-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");
  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");
    const first = await ensurePatternReinforcementCron(jobsPath, { timezone: "UTC" });
    assert.equal(first.created, true);
    const second = await ensurePatternReinforcementCron(jobsPath, { timezone: "UTC" });
    assert.equal(second.created, false);
    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{ id: string; schedule: { expr: string }; payload: { message: string } }>;
    };
    const job = parsed.jobs.find((j) => j.id === "engram-pattern-reinforcement");
    assert.ok(job);
    // Cron expression must offset from sibling crons.
    assert.equal(job.schedule.expr, "53 4 * * 0");
    assert.match(job.payload.message, /engram\.pattern_reinforcement_run/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("graph edge decay cadence maps to non-overeager cron expressions", () => {
  const day = 24 * 60 * 60 * 1000;

  assert.equal(graphEdgeDecayCadenceToCronExpr(Number.NaN), "13 4 * * 0");
  assert.equal(graphEdgeDecayCadenceToCronExpr(0), "13 4 * * 0");
  assert.equal(graphEdgeDecayCadenceToCronExpr(-day), "13 4 * * 0");

  assert.equal(graphEdgeDecayCadenceToCronExpr(60 * 60 * 1000), "13 4 * * *");
  assert.equal(graphEdgeDecayCadenceToCronExpr(day), "13 4 * * *");

  assert.equal(graphEdgeDecayCadenceToCronExpr(2 * day), "13 4 * * 0");
  assert.equal(graphEdgeDecayCadenceToCronExpr(6 * day), "13 4 * * 0");
  assert.equal(graphEdgeDecayCadenceToCronExpr(7 * day), "13 4 * * 0");
  assert.equal(graphEdgeDecayCadenceToCronExpr(30 * day), "13 4 * * 0");
});

test("graph edge decay cron reconciles an existing overeager daily schedule", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-edge-decay-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");

  try {
    await writeFile(
      jobsPath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "engram-graph-edge-decay",
            agentId: "main",
            name: "Remnic Graph Edge Decay (daily)",
            enabled: true,
            schedule: {
              kind: "cron",
              expr: "13 4 * * *",
              tz: "UTC",
            },
            payload: {
              kind: "agentTurn",
              message: "keep payload",
            },
          },
        ],
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await ensureGraphEdgeDecayCron(jobsPath, {
      timezone: "UTC",
      scheduleExpr: "13 4 * * 0",
    });
    assert.equal(result.created, false);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{ id: string; name: string; schedule: { expr: string; tz: string }; payload: { message: string } }>;
    };
    const job = parsed.jobs.find((candidate) => candidate.id === "engram-graph-edge-decay");
    assert.ok(job);
    assert.equal(job.name, "Remnic Graph Edge Decay (weekly)");
    assert.deepEqual(job.schedule, {
      kind: "cron",
      expr: "13 4 * * 0",
      tz: "UTC",
    });
    assert.equal(job.payload.message, "keep payload");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
