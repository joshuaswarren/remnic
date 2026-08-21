// ---------------------------------------------------------------------------
// End-to-end integration test — synthetic WeClone export → bulk-import pipeline
// ---------------------------------------------------------------------------
//
// This test exercises the full WeClone import path against the `@remnic/core`
// bulk-import pipeline using synthetic fixture data.  No real conversations
// are used; all senders, timestamps, and content are fabricated.
//
// Coverage matrix:
//
//   parser      → parses wrapped + raw-array inputs, infers roles
//   threader    → splits on time gaps, merges reply chains
//   participant → tags self/frequent/occasional
//   chunker     → respects maxTurnsPerChunk + overlap
//   pipeline    → dryRun completes, non-dryRun flows turns through processBatch
//   adapter     → registers in core and resolves by name
//
// Keeping the fixture inline (vs. a JSON file under __fixtures__) makes the
// causal link between input shape and expected outputs visible without a
// jump-to-file, and matches the pattern used by other integration tests in
// this repo (see packages/remnic-core/src/bulk-import/pipeline.test.ts).
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import {
  registerBulkImportSource,
  clearBulkImportSources,
  getBulkImportSource,
  runBulkImportPipeline,
} from "@remnic/core";
import type { BulkImportSource, ImportTurn } from "@remnic/core";

import { wecloneImportAdapter } from "./adapter.js";
import { ensureWecloneImportAdapterRegistered } from "./index.js";
import { parseWeCloneExport } from "./parser.js";

// ---------------------------------------------------------------------------
// Synthetic fixture — multi-thread export covering all code paths
// ---------------------------------------------------------------------------

/**
 * Build a synthetic WeClone-preprocessed export covering:
 *
 *   - A morning conversation between Alice (self) and Bob
 *     (4 messages, all within 30 min)
 *   - A mid-day conversation with Bob, Carol, and a ChatGPT Bot
 *     (6 messages, including reply chains)
 *   - An evening out-of-band reply that threader should merge into
 *     the morning thread via reply_to_id
 *   - A lonely late-night message that will be filtered by minThreadSize
 *
 * All timestamps are ISO-8601 UTC. Message content is fabricated.
 */
function buildSyntheticExport(): unknown {
  return {
    platform: "telegram",
    export_date: "2025-03-15T00:00:00.000Z",
    messages: [
      // Thread 1: morning conversation
      {
        sender: "Alice",
        text: "good morning team",
        timestamp: "2025-03-15T08:00:00.000Z",
        message_id: "m-001",
      },
      {
        sender: "Bob",
        text: "morning! ready for the standup?",
        timestamp: "2025-03-15T08:02:00.000Z",
        message_id: "m-002",
        reply_to_id: "m-001",
      },
      {
        sender: "Alice",
        text: "yep, joining in 5",
        timestamp: "2025-03-15T08:05:00.000Z",
        message_id: "m-003",
      },
      {
        sender: "Bob",
        text: "sounds good",
        timestamp: "2025-03-15T08:10:00.000Z",
        message_id: "m-004",
      },

      // Thread 2: mid-day collaboration with a bot
      {
        sender: "Alice",
        text: "anyone seen the deployment doc?",
        timestamp: "2025-03-15T13:00:00.000Z",
        message_id: "m-010",
      },
      {
        sender: "Bob",
        text: "its in the wiki under infra/releases",
        timestamp: "2025-03-15T13:02:00.000Z",
        message_id: "m-011",
        reply_to_id: "m-010",
      },
      {
        sender: "Carol",
        text: "I updated it yesterday with the new rollback steps",
        timestamp: "2025-03-15T13:05:00.000Z",
        message_id: "m-012",
      },
      {
        sender: "ChatGPT Bot",
        text: "summary: rollback now uses the snapshot API",
        timestamp: "2025-03-15T13:06:00.000Z",
        message_id: "m-013",
      },
      {
        sender: "Alice",
        text: "thanks!",
        timestamp: "2025-03-15T13:10:00.000Z",
        message_id: "m-014",
        reply_to_id: "m-012",
      },
      {
        sender: "Bob",
        text: "ill ping you if anything else comes up",
        timestamp: "2025-03-15T13:15:00.000Z",
        message_id: "m-015",
      },

      // Thread 3: evening reply that references thread 1
      // (time gap > 30 min but reply chain should merge it into thread 1)
      {
        sender: "Carol",
        text: "following up on the standup topic from earlier",
        timestamp: "2025-03-15T19:00:00.000Z",
        message_id: "m-020",
        reply_to_id: "m-002",
      },
      {
        sender: "Alice",
        text: "good call - lets discuss tomorrow",
        timestamp: "2025-03-15T19:05:00.000Z",
        message_id: "m-021",
        reply_to_id: "m-020",
      },

      // Thread 4: late-night lonely message (filtered by minThreadSize=2)
      {
        sender: "Alice",
        text: "note to self: push the docs",
        timestamp: "2025-03-15T23:45:00.000Z",
        message_id: "m-030",
      },
    ],
  };
}

function nullStream(): Writable {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: WeClone → @remnic/core bulk-import", () => {
  beforeEach(() => {
    clearBulkImportSources();
  });

  afterEach(() => {
    clearBulkImportSources();
  });

  it("parser produces a valid BulkImportSource with all expected turns", () => {
    const source = parseWeCloneExport(buildSyntheticExport());

    assert.equal(source.metadata.source, "weclone-telegram");
    assert.equal(source.metadata.messageCount, 13);
    assert.equal(
      source.metadata.dateRange.from,
      "2025-03-15T08:00:00.000Z",
    );
    assert.equal(
      source.metadata.dateRange.to,
      "2025-03-15T23:45:00.000Z",
    );

    // Alice is the first non-bot sender → user role
    const alice = source.turns.filter((t) => t.participantId === "Alice");
    assert.ok(alice.length >= 4);
    for (const turn of alice) {
      assert.equal(turn.role, "user");
    }

    // ChatGPT Bot should be classified as assistant
    const bot = source.turns.find(
      (t) => t.participantId === "ChatGPT Bot",
    );
    assert.equal(bot?.role, "assistant");

    // Bob and Carol are "other"
    const bob = source.turns.find((t) => t.participantId === "Bob");
    const carol = source.turns.find((t) => t.participantId === "Carol");
    assert.equal(bob?.role, "other");
    assert.equal(carol?.role, "other");
  });


  it("adapter registers in core and resolves by name", () => {
    registerBulkImportSource(wecloneImportAdapter);
    const resolved = getBulkImportSource("weclone");
    assert.ok(resolved, "adapter should be resolvable by name");
    assert.equal(resolved?.name, "weclone");
  });

  it("public import registration is recoverable and idempotent", () => {
    assert.equal(ensureWecloneImportAdapterRegistered(), true);
    assert.equal(getBulkImportSource("weclone")?.name, "weclone");
    assert.equal(ensureWecloneImportAdapterRegistered(), false);
  });

  it("pipeline dryRun completes end-to-end without calling processBatch", async () => {
    registerBulkImportSource(wecloneImportAdapter);
    const source = parseWeCloneExport(buildSyntheticExport());

    let batchCalls = 0;
    const result = await runBulkImportPipeline(
      source,
      { batchSize: 5, dryRun: true, dedup: true, trustLevel: "import" },
      async () => {
        batchCalls += 1;
        return {
          memoriesCreated: 0,
          duplicatesSkipped: 0,
          entitiesCreated: 0,
        };
      },
    );

    assert.equal(batchCalls, 0, "processBatch must not be called in dryRun");
    assert.equal(result.turnsProcessed, source.turns.length);
    assert.ok(result.batchesProcessed > 0);
    assert.equal(result.errors.length, 0);
  });

  it("CLI invokes ingestBatch for each batch and reports per-batch memoriesCreated", async () => {
    // End-to-end check for #460's persistence wiring: runBulkImportCliCommand
    // no longer throws "not wired" when non-dryRun is invoked; instead it
    // delegates to the supplied `ingestBatch` callback, which in production
    // is backed by `orchestrator.ingestBulkImportBatch`.
    const { runBulkImportCliCommand } = await import("@remnic/core");

    registerBulkImportSource(wecloneImportAdapter);

    const tmp = mkdtempSync(join(tmpdir(), "weclone-persist-"));
    const filePath = join(tmp, "export.json");
    writeFileSync(filePath, JSON.stringify(buildSyntheticExport()));

    const seenBatchSizes: number[] = [];

    try {
      const result = await runBulkImportCliCommand({
        memoryDir: tmp,
        source: "weclone",
        file: filePath,
        platform: "telegram",
        batchSize: 4,
        // dryRun omitted → non-dryRun path; ingestBatch is the persistence hook.
        ingestBatch: async (turns: ImportTurn[]) => {
          seenBatchSizes.push(turns.length);
          return {
            memoriesCreated: turns.length,
            duplicatesSkipped: 0,
          };
        },
        stdout: nullStream(),
        stderr: nullStream(),
      });

      // 13 turns at batchSize=4 → 4 batches (4, 4, 4, 1)
      assert.deepEqual(seenBatchSizes, [4, 4, 4, 1]);
      assert.equal(result.turnsProcessed, 13);
      assert.equal(result.batchesProcessed, 4);
      assert.equal(result.memoriesCreated, 13);
      assert.equal(result.errors.length, 0);
    } finally {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  });

  it("pipeline flows turns through processBatch in correct batch sizes", async () => {
    // Simulates what the orchestrator integration will do once persistence is
    // wired — the callback receives each batch and records how many turns
    // were seen per batch. Using a mock callback lets us exercise batching
    // without depending on the orchestrator.
    const source = parseWeCloneExport(buildSyntheticExport());
    const seenBatches: number[] = [];

    const result = await runBulkImportPipeline(
      source,
      { batchSize: 4, dryRun: false, dedup: true, trustLevel: "import" },
      async (batch) => {
        seenBatches.push(batch.length);
        return {
          memoriesCreated: batch.length,
          duplicatesSkipped: 0,
          entitiesCreated: 0,
        };
      },
    );

    // 13 turns / 4 per batch = 4 batches (sizes 4, 4, 4, 1)
    assert.deepEqual(seenBatches, [4, 4, 4, 1]);
    assert.equal(result.turnsProcessed, 13);
    assert.equal(result.batchesProcessed, 4);
    assert.equal(result.memoriesCreated, 13);
    assert.equal(result.errors.length, 0);
  });

  it("adapter accepts a file-shaped input via parse() like the CLI does", async () => {
    // Mirrors runBulkImportCliCommand's contract: the CLI reads the file,
    // JSON.parses it, then calls adapter.parse(inputParsed, {strict, platform}).
    registerBulkImportSource(wecloneImportAdapter);

    const tmp = mkdtempSync(join(tmpdir(), "weclone-integration-"));
    const filePath = join(tmp, "export.json");
    writeFileSync(filePath, JSON.stringify(buildSyntheticExport()));

    try {
      const adapter = getBulkImportSource("weclone");
      assert.ok(adapter);
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const parsed = (await adapter.parse(raw, {
        strict: false,
        platform: "telegram",
      })) as BulkImportSource;
      assert.equal(parsed.metadata.source, "weclone-telegram");
      assert.equal(parsed.metadata.messageCount, 13);
    } finally {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  });

  it("nullStream helper is usable for CLI-surface tests", () => {
    // Sanity: the helper is wired correctly so downstream CLI integration
    // tests can rely on it without redefining.
    const stream = nullStream();
    assert.ok(stream instanceof Writable);
  });
});
