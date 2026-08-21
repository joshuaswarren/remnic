import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { runReplayCliCommand, type ReplayCliOrchestrator } from "../src/cli.js";

function openclawJsonlSample(): string {
  return [
    JSON.stringify({
      timestamp: "2026-02-25T10:00:00.000Z",
      role: "user",
      content: "hello",
      sessionKey: "agent:generalist:main",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:01:00.000Z",
      role: "assistant",
      content: "hi",
      sessionKey: "agent:generalist:main",
    }),
  ].join("\n");
}

test("runReplayCliCommand dry-run parses but does not enqueue extraction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  let ingestCalls = 0;
  let waitCalls = 0;
  let consolidationCalls = 0;
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch() {
      ingestCalls += 1;
    },
    async waitForConsolidationIdle() {
      waitCalls += 1;
      return true;
    },
    async runConsolidationNow() {
      consolidationCalls += 1;
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    dryRun: true,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.processedTurns, 2);
  assert.equal(ingestCalls, 0);
  assert.equal(waitCalls, 0);
  assert.equal(consolidationCalls, 0);
});

test("runReplayCliCommand enqueues batches and can run consolidation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-live-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  const ingested: number[] = [];
  let waitCalls = 0;
  let consolidationCalls = 0;
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(turns) {
      ingested.push(turns.length);
    },
    async waitForConsolidationIdle() {
      waitCalls += 1;
      return true;
    },
    async runConsolidationNow() {
      consolidationCalls += 1;
      return { memoriesProcessed: 2, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 1,
    runConsolidation: true,
  });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.processedTurns, 2);
  assert.deepEqual(ingested, [1, 1]);
  assert.equal(waitCalls, 1);
  assert.equal(consolidationCalls, 1);
});

test("runReplayCliCommand honors batch size for single-session ingestion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-batch-size-"));
  const inputPath = path.join(dir, "replay.jsonl");
  const raw = [
    JSON.stringify({
      timestamp: "2026-02-25T10:00:00.000Z",
      role: "user",
      content: "u1",
      sessionKey: "agent:generalist:main",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:00:01.000Z",
      role: "assistant",
      content: "a1",
      sessionKey: "agent:generalist:main",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:00:02.000Z",
      role: "user",
      content: "u2",
      sessionKey: "agent:generalist:main",
    }),
  ].join("\n");
  await writeFile(inputPath, raw, "utf-8");

  const ingested: number[] = [];
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(turns) {
      ingested.push(turns.length);
    },
    async waitForConsolidationIdle() {
      return true;
    },
    async runConsolidationNow() {
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 2,
  });

  assert.equal(summary.processedTurns, 3);
  assert.deepEqual(ingested, [2, 1]);
});

test("runReplayCliCommand partitions mixed-session batches before ingest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-session-split-"));
  const inputPath = path.join(dir, "replay.jsonl");
  const raw = [
    JSON.stringify({
      timestamp: "2026-02-25T10:00:00.000Z",
      role: "user",
      content: "a1",
      sessionKey: "agent:a",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:00:01.000Z",
      role: "assistant",
      content: "a2",
      sessionKey: "agent:a",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:00:02.000Z",
      role: "user",
      content: "b1",
      sessionKey: "agent:b",
    }),
  ].join("\n");
  await writeFile(inputPath, raw, "utf-8");

  const sessionKeysByCall: string[][] = [];
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(turns) {
      sessionKeysByCall.push(Array.from(new Set(turns.map((turn) => turn.sessionKey))).sort());
    },
    async waitForConsolidationIdle() {
      return true;
    },
    async runConsolidationNow() {
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 10,
  });

  assert.equal(summary.processedTurns, 3);
  assert.deepEqual(sessionKeysByCall, [["agent:a"], ["agent:b"]]);
});

test("runReplayCliCommand handles normalized fallback session keys safely", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-unknown-session-"));
  const inputPath = path.join(dir, "replay.jsonl");
  const raw = [
    JSON.stringify({
      timestamp: "2026-02-25T10:00:00.000Z",
      role: "user",
      content: "u1",
      sessionKey: "   ",
    }),
    JSON.stringify({
      timestamp: "2026-02-25T10:00:01.000Z",
      role: "assistant",
      content: "a1",
      sessionKey: "   ",
    }),
  ].join("\n");
  await writeFile(inputPath, raw, "utf-8");

  const sessionKeysByCall: string[][] = [];
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(turns) {
      sessionKeysByCall.push(Array.from(new Set(turns.map((turn) => turn.sessionKey))).sort());
    },
    async waitForConsolidationIdle() {
      return true;
    },
    async runConsolidationNow() {
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  const summary = await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 10,
  });

  assert.equal(summary.processedTurns, 2);
  assert.deepEqual(sessionKeysByCall, [["replay:openclaw:import"]]);
});

test("runReplayCliCommand passes replay deadline to batch ingestion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-deadline-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  const seenDeadlines: number[] = [];
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch(_turns, opts) {
      if (opts?.deadlineMs) seenDeadlines.push(opts.deadlineMs);
    },
    async waitForConsolidationIdle() {
      return true;
    },
    async runConsolidationNow() {
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  await runReplayCliCommand(orchestrator, {
    source: "openclaw",
    inputPath,
    batchSize: 1,
    extractionIdleTimeoutMs: 1_000,
  });

  assert.ok(seenDeadlines.length >= 1);
  for (const deadline of seenDeadlines) {
    assert.ok(deadline > Date.now() - 60_000);
  }
});

test("runReplayCliCommand throws when replay batch processing exceeds timeout", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-timeout-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch() {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    },
    async waitForConsolidationIdle() {
      return true;
    },
    async runConsolidationNow() {
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  await assert.rejects(
    async () =>
      runReplayCliCommand(orchestrator, {
        source: "openclaw",
        inputPath,
        extractionIdleTimeoutMs: 1_000,
      }),
    /batch did not complete before timeout/,
  );
});

test("runReplayCliCommand throws when consolidation remains in-flight before finalize", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-replay-consolidation-timeout-"));
  const inputPath = path.join(dir, "replay.jsonl");
  await writeFile(inputPath, openclawJsonlSample(), "utf-8");

  let consolidationCalls = 0;
  const orchestrator: ReplayCliOrchestrator = {
    async ingestReplayBatch() {},
    async waitForConsolidationIdle() {
      return false;
    },
    async runConsolidationNow() {
      consolidationCalls += 1;
      return { memoriesProcessed: 0, merged: 0, invalidated: 0 };
    },
  };

  await assert.rejects(
    async () =>
      runReplayCliCommand(orchestrator, {
        source: "openclaw",
        inputPath,
        runConsolidation: true,
      }),
    /replay consolidation did not become idle before timeout/,
  );
  assert.equal(consolidationCalls, 0);
});
