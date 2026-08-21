import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  ensureLiveConnectorCron,
  liveConnectorCronExprForConfig,
} from "../src/openclaw-live-connector-cron.js";

test("OpenClaw live connector cron registers once and calls engram.live_connectors_run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-live-connectors-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");
  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");
    const first = await ensureLiveConnectorCron(jobsPath, { timezone: "UTC" });
    assert.equal(first.created, true);
    const second = await ensureLiveConnectorCron(jobsPath, { timezone: "UTC" });
    assert.equal(second.created, false);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{
        id: string;
        schedule: { kind: string; expr: string; tz: string };
        payload: { message: string };
      }>;
    };
    const job = parsed.jobs.find((j) => j.id === "engram-live-connectors-sync");
    assert.ok(job);
    assert.deepEqual(job.schedule, {
      kind: "cron",
      expr: "*/5 * * * *",
      tz: "UTC",
    });
    assert.match(job.payload.message, /OpenClaw automation/);
    assert.match(job.payload.message, /engram\.live_connectors_run/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw live connector cron uses one-minute base cadence when connectors are enabled", () => {
  const connectors = {
    googleDrive: { enabled: false, pollIntervalMs: 60_000 },
    notion: { enabled: true, pollIntervalMs: 120_000 },
    gmail: { enabled: true, pollIntervalMs: 60_000 },
    github: { enabled: false, pollIntervalMs: 1_000 },
  } as any;

  assert.equal(liveConnectorCronExprForConfig(connectors), "* * * * *");
});

test("OpenClaw live connector cron updates an existing default cadence when connectors become enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-live-connectors-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");
  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");
    await ensureLiveConnectorCron(jobsPath, { timezone: "UTC" });

    const result = await ensureLiveConnectorCron(jobsPath, {
      timezone: "UTC",
      connectors: {
        googleDrive: { enabled: true, pollIntervalMs: 60_000 },
        notion: { enabled: false, pollIntervalMs: 60_000 },
        gmail: { enabled: false, pollIntervalMs: 60_000 },
        github: { enabled: false, pollIntervalMs: 60_000 },
      } as any,
    });

    assert.equal(result.created, false);
    assert.equal(result.updated, true);
    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{ id: string; schedule: { kind: string; expr: string; tz: string } }>;
    };
    const matchingJobs = parsed.jobs.filter((j) => j.id === "engram-live-connectors-sync");
    assert.equal(matchingJobs.length, 1);
    assert.deepEqual(matchingJobs[0].schedule, {
      kind: "cron",
      expr: "* * * * *",
      tz: "UTC",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw live connector cron preserves operator-owned fields when reconciling cadence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-live-connectors-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");
  try {
    await writeFile(
      jobsPath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "engram-live-connectors-sync",
              agentId: "main",
              name: "Operator edited live connector job",
              enabled: true,
              schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
              sessionTarget: "current",
              wakeMode: "deferred",
              payload: { kind: "agentTurn", message: "old" },
              delivery: { mode: "message", channelId: "ops" },
              failureDelivery: { mode: "message", channelId: "alerts" },
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const result = await ensureLiveConnectorCron(jobsPath, {
      timezone: "UTC",
      connectors: {
        googleDrive: { enabled: true, pollIntervalMs: 60_000 },
        notion: { enabled: false, pollIntervalMs: 60_000 },
        gmail: { enabled: false, pollIntervalMs: 60_000 },
        github: { enabled: false, pollIntervalMs: 60_000 },
      } as any,
    });

    assert.equal(result.created, false);
    assert.equal(result.updated, true);
    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<Record<string, unknown> & { id: string; schedule: { expr: string } }>;
    };
    const job = parsed.jobs.find((j) => j.id === "engram-live-connectors-sync");
    assert.ok(job);
    assert.equal(job.schedule.expr, "* * * * *");
    assert.equal(job.name, "Operator edited live connector job");
    assert.equal(job.sessionTarget, "current");
    assert.equal(job.wakeMode, "deferred");
    assert.deepEqual(job.delivery, { mode: "message", channelId: "ops" });
    assert.deepEqual(job.failureDelivery, { mode: "message", channelId: "alerts" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw live connector cron keeps five-minute default when no connector config is supplied", () => {
  assert.equal(liveConnectorCronExprForConfig(undefined), "*/5 * * * *");
});
