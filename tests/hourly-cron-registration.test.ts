import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import {
  buildHourlySummaryCronJob,
  loadHourlySummaryCronJobsData,
  parseHourlySummaryCronJobsData,
  reconcileHourlySummaryCronRouting,
} from "../src/index.js";

// A pre-fix auto-registered job: model pinned at the root only (no payload.model
// / payload.fallbacks), as produced before the #1469 routing fix.
function staleExistingJob(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "engram-hourly-summary",
    agentId: "generalist",
    model: "gpt-5.5",
    name: "Remnic Hourly Summary",
    enabled: true,
    createdAtMs: 111,
    updatedAtMs: 111,
    schedule: { kind: "cron", expr: "42 * * * *", tz: "America/Chicago" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 120,
      thinking: "off",
      message: "Call the tool `memory_summarize_hourly` with empty params.",
    },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  };
}

const CRON_OPTS = {
  jobId: "engram-hourly-summary",
  minute: 17,
  nowMs: 1_700_000_000_000,
};

test("hourly cron jobs loader preserves malformed existing jobs files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-hourly-cron-"));
  try {
    const jobsPath = path.join(dir, "jobs.json");
    const malformed = "{ not valid jobs json\n";
    await writeFile(jobsPath, malformed, "utf8");

    const result = await loadHourlySummaryCronJobsData(jobsPath);

    assert.equal(result.status, "invalid");
    assert.equal(await readFile(jobsPath, "utf8"), malformed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hourly cron jobs parser rejects invalid jobs shape", () => {
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: {} })),
    /jobs array/,
  );
  assert.throws(
    () => parseHourlySummaryCronJobsData(JSON.stringify({ version: 1, jobs: [null] })),
    /jobs entries/,
  );
});

test("hourly cron job pins the gateway task model in the isolated agentTurn payload", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  assert.equal(job.sessionTarget, "isolated");
  assert.equal(payload.kind, "agentTurn");
  // Isolated agentTurn jobs honor payload.model, not the root model — without
  // this the configured task model is dropped and the run falls through to the
  // agent default. Issue #1469 / codex review on PR #1470.
  assert.equal(payload.model, "openrouter/deepseek/deepseek-v4-flash");
  // Root model kept for backward compatibility with older host builds.
  assert.equal(job.model, "openrouter/deepseek/deepseek-v4-flash");
  // When the model is the task-chain primary, the chain fallbacks must be
  // carried in payload.fallbacks — OpenClaw treats absence as a strict run and
  // would otherwise drop the operator's configured fallbacks. Codex review on #1470.
  assert.deepEqual(payload.fallbacks, ["zai/glm-4.5-air"]);
});

test("hourly cron job appends the gateway default chain after the task fallbacks", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
    gatewayConfig: {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            // duplicate of a task fallback (deduped) + a fresh last-resort model
            fallbacks: ["zai/glm-4.5-air", "openai/gpt-5.5-mini"],
          },
        },
      },
    },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  // Task fallbacks first, then the gateway default chain (primary + its
  // fallbacks) as an implicit last resort, de-duplicated and excluding the
  // primary model itself. Matches fallback-llm + the documented invariant that
  // an exhausted task chain never blocks a flush. Codex review on PR #1470.
  assert.deepEqual(payload.fallbacks, [
    "zai/glm-4.5-air",
    "openai/gpt-5.5",
    "openai/gpt-5.5-mini",
  ]);
});

test("hourly cron job lets an explicit summaryModel win over the task chain", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    summaryModel: "openrouter/summary-override",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  assert.equal(job.model, "openrouter/summary-override");
  assert.equal(payload.model, "openrouter/summary-override");
  // The model came from an explicit summaryModel, not the chain primary, so the
  // chain fallbacks are not auto-attached.
  assert.equal("fallbacks" in payload, false);
});

test("hourly cron job omits fallbacks when the task chain has none", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
  });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  assert.equal(payload.model, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal("fallbacks" in payload, false);
});

test("hourly cron job omits the model when no task model is configured", () => {
  const cfg = parseConfig({ modelSource: "gateway" });

  const job = buildHourlySummaryCronJob(cfg, CRON_OPTS);
  const payload = job.payload as Record<string, unknown>;

  // No bare "gpt-5.5" leaks to the gateway; the Gateway default + provider win.
  assert.equal("model" in job, false);
  assert.equal("model" in payload, false);
  assert.equal("fallbacks" in payload, false);
});

test("reconcile migrates a stale existing job to the configured task model + fallbacks", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });
  const existing = staleExistingJob();

  const { changed, job } = reconcileHourlySummaryCronRouting(existing, cfg, {
    nowMs: 222,
  });
  const payload = job.payload as Record<string, unknown>;

  assert.equal(changed, true);
  assert.equal(job.model, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(payload.model, "openrouter/deepseek/deepseek-v4-flash");
  assert.deepEqual(payload.fallbacks, ["zai/glm-4.5-air"]);
  // Schedule / delivery / message / createdAtMs preserved; updatedAtMs bumped.
  assert.deepEqual(job.schedule, { kind: "cron", expr: "42 * * * *", tz: "America/Chicago" });
  assert.deepEqual(job.delivery, { mode: "none" });
  assert.equal(payload.message, "Call the tool `memory_summarize_hourly` with empty params.");
  assert.equal(job.createdAtMs, 111);
  assert.equal(job.updatedAtMs, 222);
});

test("reconcile is idempotent for an already-correct job", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });
  const correct = buildHourlySummaryCronJob(cfg, CRON_OPTS);

  const { changed, job } = reconcileHourlySummaryCronRouting(correct, cfg, {
    nowMs: 999,
  });

  assert.equal(changed, false);
  assert.equal(job, correct); // unchanged reference; no rewrite
});

test("reconcile strips a now-unroutable stale model when no task model is configured", () => {
  const cfg = parseConfig({ modelSource: "gateway" });
  const existing = staleExistingJob({
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 120,
      thinking: "off",
      model: "gpt-5.5",
      fallbacks: ["gpt-5.5-mini"],
      message: "keep me",
    },
  });

  const { changed, job } = reconcileHourlySummaryCronRouting(existing, cfg, {
    nowMs: 222,
  });
  const payload = job.payload as Record<string, unknown>;

  assert.equal(changed, true);
  // Bare/stale routing removed so the Gateway default wins; message preserved.
  assert.equal("model" in job, false);
  assert.equal("model" in payload, false);
  assert.equal("fallbacks" in payload, false);
  assert.equal(payload.message, "keep me");
});

test("reconcile leaves a malformed payload untouched", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
  });
  const existing = staleExistingJob({ payload: "not-an-object" });

  const { changed, job } = reconcileHourlySummaryCronRouting(existing, cfg, {
    nowMs: 222,
  });

  assert.equal(changed, false);
  assert.equal(job, existing);
});
