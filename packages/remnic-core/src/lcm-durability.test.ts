import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { LcmArchive } from "./lcm/archive.js";
import { LcmDag } from "./lcm/dag.js";
import { LcmEngine } from "./lcm/engine.js";
import { ensureLcmStateDir, openLcmDatabase } from "./lcm/schema.js";
import { LcmSummarizer } from "./lcm/summarizer.js";

function createConfig(memoryDir: string) {
  return parseConfig({
    memoryDir,
    lcmEnabled: true,
    lcmLeafBatchSize: 2,
    lcmRollupFanIn: 2,
    lcmFreshTailTurns: 16,
    lcmMaxDepth: 5,
    lcmDeterministicMaxTokens: 512,
    lcmTelemetryPrefilterEnabled: false,
    lcmArchiveRetentionDays: 90,
    lcmRecallBudgetShare: 0.15,
    lcmObserveConcurrency: 1,
    messagePartsEnabled: false,
  });
}

/** Second SQLite handle on the same file: proves content is durable on disk,
 * independent of the engine's in-memory queue state. */
function durableRowCount(memoryDir: string, sessionId: string): number {
  const db = openLcmDatabase(memoryDir);
  try {
    // SAFETY: the query returns exactly one aggregate column, `n`.
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function durableContents(memoryDir: string, sessionId: string): string[] {
  const db = openLcmDatabase(memoryDir);
  try {
    // SAFETY: the query returns the lcm_messages `content` column.
    const rows = db
      .prepare(
        "SELECT content FROM lcm_messages WHERE session_id = ? ORDER BY turn_index",
      )
      .all(sessionId) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } finally {
    db.close();
  }
}

function leafRanges(memoryDir: string, sessionId: string): Array<[number, number]> {
  const db = openLcmDatabase(memoryDir);
  try {
    // SAFETY: the query returns the summary node range columns.
    const rows = db
      .prepare(
        "SELECT msg_start, msg_end FROM lcm_summary_nodes WHERE session_id = ? AND depth = 0 ORDER BY msg_start",
      )
      .all(sessionId) as Array<{ msg_start: number; msg_end: number }>;
    return rows.map((r) => [r.msg_start, r.msg_end]);
  } finally {
    db.close();
  }
}

test("enqueueObserveMessages archives content durably before acknowledgement while the summarizer is blocked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-1-"));
  const { promise: summarizeStarted, resolve: resolveStarted } =
    Promise.withResolvers<void>();
  const { promise: releaseSummarize, resolve: resolveRelease } =
    Promise.withResolvers<void>();
  try {
    const engine = new LcmEngine(createConfig(dir), async () => {
      resolveStarted();
      await releaseSummarize;
      return "blocked summary";
    });

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "burst payload alpha" },
    ]);

    // Acknowledgement returned with the summarizer still parked: the payload
    // must already be in SQLite, not only in the in-memory queue.
    assert.equal(durableRowCount(dir, "session-1"), 1);
    assert.deepEqual(durableContents(dir, "session-1"), ["burst payload alpha"]);

    resolveRelease();
    await engine.waitForSessionObserveIdle("session-1");
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("burst enqueue keeps the pending queue metadata-only and every message lands in SQLite while summarization is blocked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-2-"));
  const { promise: releaseSummarize, resolve: resolveRelease } =
    Promise.withResolvers<void>();
  try {
    const engine = new LcmEngine(createConfig(dir), async () => {
      await releaseSummarize;
      return "blocked summary";
    });

    for (let i = 0; i < 30; i += 1) {
      await engine.enqueueObserveMessages("session-1", [
        { role: "user", content: `burst message ${i}` },
      ]);
    }

    // One running job plus one pending marker for the single session: the
    // queue never grows with the number of archived messages.
    assert.equal(engine.observeQueueDepth, 1);
    assert.equal(engine.observeQueueInFlightCount, 1);

    const contents = durableContents(dir, "session-1");
    assert.equal(contents.length, 30);
    assert.deepEqual(
      contents,
      Array.from({ length: 30 }, (_, i) => `burst message ${i}`),
    );

    resolveRelease();
    await engine.waitForSessionObserveIdle("session-1");
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close-and-recreate recovers the full archived session and resumes outstanding summaries automatically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-3-"));
  const { promise: summarizeStarted, resolve: resolveStarted } =
    Promise.withResolvers<void>();
  const { promise: releaseSummarize, resolve: resolveRelease } =
    Promise.withResolvers<void>();
  try {
    const blockedEngine = new LcmEngine(createConfig(dir), async () => {
      resolveStarted();
      await releaseSummarize;
      return "never finishes";
    });
    for (let i = 0; i < 4; i += 1) {
      await blockedEngine.enqueueObserveMessages("session-1", [
        { role: "user", content: `crash survivor ${i}` },
      ]);
    }
    await summarizeStarted;
    // Simulated crash: drop the engine (and its in-flight summarize job).
    blockedEngine.close();
    resolveRelease();

    // Content survived the crash.
    assert.equal(durableRowCount(dir, "session-1"), 4);

    // Restart: outstanding complete batches must resume without any new observe.
    let summarizeCalls = 0;
    const resumedEngine = new LcmEngine(createConfig(dir), async () => {
      summarizeCalls += 1;
      return `resumed summary ${summarizeCalls}`;
    });
    await resumedEngine.waitForObserveQueueIdle();
    assert.ok(summarizeCalls >= 1, "startup resume must summarize outstanding batches");
    assert.deepEqual(leafRanges(dir, "session-1"), [
      [0, 1],
      [2, 3],
    ]);
    assert.equal(durableRowCount(dir, "session-1"), 4);

    resumedEngine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsummarized archive reads are bounded by the requested limit without dropping source rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-4-"));
  try {
    await ensureLcmStateDir(dir);
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    for (let i = 0; i < 10; i += 1) {
      archive.appendMessage("session-1", i, "user", `bounded read ${i}`);
    }

    assert.equal(archive.getUnsummarizedMessages("session-1").length, 10);
    assert.equal(archive.getUnsummarizedMessages("session-1", 4).length, 4);
    assert.equal(archive.getUnsummarizedMessages("session-1", 0).length, 0);
    // Rows themselves untouched.
    assert.equal(archive.getMaxTurnIndex("session-1"), 9);
    assert.equal(durableRowCount(dir, "session-1"), 10);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maxLeafBatches caps one summarize pass and repeated passes keep contiguous lineage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-5-"));
  try {
    await ensureLcmStateDir(dir);
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);
    for (let i = 0; i < 6; i += 1) {
      archive.appendMessage("session-1", i, "user", `capped pass ${i}`);
    }
    const summarizer = new LcmSummarizer(archive, dag, async () => "cap summary", {
      leafBatchSize: 2,
      rollupFanIn: 2,
      maxDepth: 5,
      deterministicMaxTokens: 512,
      telemetryPrefilterEnabled: false,
    });

    assert.ok(
      (await summarizer.summarizeIncremental("session-1", { maxLeafBatches: 1 })) >= 1,
    );
    assert.equal(dag.getNodesAtDepth("session-1", 0).length, 1);
    assert.equal(archive.getUnsummarizedMessages("session-1").length, 4);

    await summarizer.summarizeIncremental("session-1", { maxLeafBatches: 1 });
    await summarizer.summarizeIncremental("session-1", { maxLeafBatches: 1 });
    assert.equal(dag.getNodesAtDepth("session-1", 0).length, 3);
    assert.equal(archive.getUnsummarizedMessages("session-1").length, 0);

    assert.deepEqual(
      dag.getNodesAtDepth("session-1", 0).map((l) => [l.msg_start, l.msg_end]),
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enqueueObserveMessages rejects instead of silently claiming acceptance when initialization fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-durable-6-"));
  // memoryDir points at a regular file: ensureLcmStateDir cannot mkdir beneath it.
  const filePath = path.join(dir, "not-a-dir");
  await writeFile(filePath, "occupied", "utf8");
  try {
    const engine = new LcmEngine(createConfig(filePath), async () => "unused");
    let failure: unknown;
    try {
      await engine.enqueueObserveMessages("session-1", [
        { role: "user", content: "must not be claimed durable" },
      ]);
    } catch (err) {
      failure = err;
    }
    assert.ok(failure instanceof Error, "the archive failure must reject");
    // Nothing was archived: the failed init left no database behind.
    assert.equal(existsSync(path.join(filePath, "state")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
