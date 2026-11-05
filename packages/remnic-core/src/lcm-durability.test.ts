import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { eventually } from "./testing/orchestrator-lite.js";
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

test("a closed engine rejects acceptance instead of acknowledging an empty archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-closed-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "unused");
    await engine.ensureInitialized();
    engine.close();

    let failure: unknown;
    try {
      await engine.enqueueObserveMessages("session-1", [
        { role: "user", content: "must not be acknowledged" },
      ]);
    } catch (err) {
      failure = err;
    }
    assert.ok(failure instanceof Error, "a closed engine must reject acceptance");
    assert.match(failure.message, /closed/);
    assert.equal(durableRowCount(dir, "session-1"), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed summary pass is retried from the durable archive without a new observe", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "retry summary");
    await engine.ensureInitialized();

    // Fail the first summary pass, then let the retry succeed.
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = (engine as any).summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    const realSummarize = summarizer.summarizeIncremental.bind(summarizer);
    let failNext = true;
    summarizer.summarizeIncremental = async (
      sessionId: string,
      options?: { maxLeafBatches?: number },
    ) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient summary failure");
      }
      return realSummarize(sessionId, options);
    };

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "retry me" },
      { role: "assistant", content: "retry me too" },
    ]);

    // The durable backlog must be summarized by the retry alone: no new
    // observe, no restart.
    await eventually(
      async () => {
        const summary = await engine.describeContext("session-1", 0, 1);
        return summary?.depth === 0 ? true : null;
      },
      "the failed summary pass is retried",
    );
    assert.equal(durableRowCount(dir, "session-1"), 2);
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a summary pass that keeps failing is retried until it succeeds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-persist-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "persistent summary");
    await engine.ensureInitialized();

    // SAFETY: the test drives the engine's own retry pacing and summarizer.
    const internals = engine as any;
    internals.summarizeRetryBaseMs = 10;
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = internals.summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    const realSummarize = summarizer.summarizeIncremental.bind(summarizer);
    let failures = 0;
    summarizer.summarizeIncremental = async (
      sessionId: string,
      options?: { maxLeafBatches?: number },
    ) => {
      failures += 1;
      // More failures than any attempt budget would allow: the retry must
      // keep trying, not stop and strand the durable backlog.
      if (failures <= 7) throw new Error("persistent summary failure");
      return realSummarize(sessionId, options);
    };

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "keep retrying" },
      { role: "assistant", content: "keep retrying too" },
    ]);

    await eventually(
      async () => {
        const summary = await engine.describeContext("session-1", 0, 1);
        return summary?.depth === 0 ? true : null;
      },
      "the failing summary pass is retried until it succeeds",
    );
    assert.ok(failures > 7, `expected more than 7 attempts, got ${failures}`);
    assert.equal(durableRowCount(dir, "session-1"), 2);
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("closing the engine cancels a pending summary retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-close-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "unused");
    await engine.ensureInitialized();

    // SAFETY: the test drives the engine's own retry pacing and summarizer.
    const internals = engine as any;
    internals.summarizeRetryBaseMs = 10_000;
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = internals.summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    summarizer.summarizeIncremental = async () => {
      throw new Error("permanent summary failure");
    };

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "pending retry" },
      { role: "assistant", content: "pending retry too" },
    ]);
    await eventually(
      async () => (internals.summarizeRetryTimers.size > 0 ? true : null),
      "a summary retry is pending",
    );

    engine.close();
    assert.equal(internals.summarizeRetryTimers.size, 0, "close must clear pending retries");
    assert.equal(internals.db, null, "close must not reinitialize the engine");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-compaction flush serializes with a pending summary retry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-flush-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "compaction summary");
    await engine.ensureInitialized();

    // SAFETY: the test drives the engine's own retry pacing and summarizer.
    const internals = engine as any;
    internals.summarizeRetryBaseMs = 10;
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = internals.summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    const realSummarize = summarizer.summarizeIncremental.bind(summarizer);
    let failures = 0;
    summarizer.summarizeIncremental = async (
      sessionId: string,
      options?: { maxLeafBatches?: number },
    ) => {
      failures += 1;
      if (failures === 1) throw new Error("transient summary failure");
      // Keep later passes busy long enough for a retry timer to fire mid-pass,
      // which is exactly the overlap a direct flush must not allow.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
      return realSummarize(sessionId, options);
    };

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "flush race" },
      { role: "assistant", content: "flush race too" },
    ]);

    // Compaction starts while the retry delay is still pending: the flush
    // must serialize behind the retry, not run a second pass beside it.
    await engine.preCompactionFlush("session-1");
    await engine.waitForObserveQueueIdle();

    assert.ok(failures >= 2, "the retry must have run before the flush");
    // Exactly one leaf for the batch: no duplicate summary ranges.
    assert.deepEqual(leafRanges(dir, "session-1"), [[0, 1]]);
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no summary pass starts while a retry is pending for the session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-order-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "ordered summary");
    await engine.ensureInitialized();
    // Seed the archive directly: the backlog exists before any observe.
    await ensureLcmStateDir(dir);
    const seedDb = openLcmDatabase(dir);
    const seedArchive = new LcmArchive(seedDb);
    seedArchive.appendMessage("session-1", 0, "user", "order seed one");
    seedArchive.appendMessage("session-1", 1, "assistant", "order seed two");
    seedDb.close();

    // SAFETY: the test drives the engine's own retry pacing and summarizer.
    const internals = engine as any;
    internals.summarizeRetryBaseMs = 150;
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = internals.summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    const realSummarize = summarizer.summarizeIncremental.bind(summarizer);
    let failures = 0;
    const passOrder: Array<"background" | "direct" | "retry"> = [];
    summarizer.summarizeIncremental = async (
      sessionId: string,
      options?: { maxLeafBatches?: number },
    ) => {
      // A pass that starts while this session's retry timer is still pending
      // is either the armed retry or a racy direct flush; the flush must not
      // start until the retry has fired.
      const retryPending = internals.summarizeRetryTimers.has(sessionId);
      const label: (typeof passOrder)[number] =
        failures === 0 ? "background" : retryPending ? "direct" : "retry";
      passOrder.push(label);
      failures += 1;
      if (failures === 1) throw new Error("transient summary failure");
      return realSummarize(sessionId, options);
    };

    // The background pass fails and arms a 150ms retry; compaction starts
    // inside that window.
    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "ordering one" },
      { role: "assistant", content: "ordering two" },
    ]);
    await engine.preCompactionFlush("session-1");
    await engine.waitForObserveQueueIdle();

    // The flush must serialize behind the armed retry, never start while the
    // retry timer is pending: no "direct" label may appear. The retry pass
    // covers both seeded batches; the flush pass then finds nothing left.
    assert.deepEqual(passOrder, ["background", "retry", "retry"]);
    assert.deepEqual(leafRanges(dir, "session-1"), [
      [0, 1],
      [2, 3],
    ]);
    engine.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted idle wait releases the retry timer reference and close clears everything", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-lcm-retry-abort-"));
  try {
    const engine = new LcmEngine(createConfig(dir), async () => "unused");
    await engine.ensureInitialized();

    // SAFETY: the test drives the engine's own retry pacing and summarizer.
    const internals = engine as any;
    internals.summarizeRetryBaseMs = 60_000;
    // SAFETY: the stub replaces the engine's own summarizer for this test.
    const summarizer = internals.summarizer as {
      summarizeIncremental: (
        sessionId: string,
        options?: { maxLeafBatches?: number },
      ) => Promise<number>;
    };
    summarizer.summarizeIncremental = async () => {
      throw new Error("permanent summary failure");
    };

    await engine.enqueueObserveMessages("session-1", [
      { role: "user", content: "abort the wait" },
      { role: "assistant", content: "abort the wait too" },
    ]);
    await eventually(
      async () => (internals.summarizeRetryTimers.size > 0 ? true : null),
      "a summary retry is pending",
    );

    const abort = new AbortController();
    const waiting = engine.waitForSessionObserveIdle("session-1", abort.signal);
    await eventually(
      async () => (internals.summarizeRetryIdleWaiters.get("session-1") === 1 ? true : null),
      "the idle wait is parked on the retry and holds a reference",
    );

    abort.abort(new Error("caller gave up"));
    await assert.rejects(() => waiting);
    assert.equal(internals.summarizeRetryIdleWaiters.size, 0, "abort releases the idle-waiter reference");

    engine.close();
    assert.equal(internals.summarizeRetryTimers.size, 0, "close clears pending retries");
    assert.equal(internals.summarizeRetryWaiters.size, 0, "close resolves retry waiters");
    assert.equal(internals.summarizeRetryIdleWaiters.size, 0, "close clears idle-waiter counts");
    assert.equal(internals.db, null, "close does not reinitialize the engine");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
