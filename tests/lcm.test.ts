import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { openLcmDatabase, ensureLcmStateDir } from "../src/lcm/schema.js";
import { LcmArchive, estimateTokens } from "../src/lcm/archive.js";
import { LcmDag } from "../src/lcm/dag.js";
import { LcmSummarizer, type SummarizeFn } from "../src/lcm/summarizer.js";
import { assembleCompressedHistory } from "../src/lcm/recall.js";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-lcm-test-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
}

// ── Schema Tests ──

test("openLcmDatabase creates all required tables", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    assert.ok(names.includes("lcm_messages"), "should have lcm_messages");
    assert.ok(names.includes("lcm_summary_nodes"), "should have lcm_summary_nodes");
    assert.ok(names.includes("lcm_message_parts"), "should have lcm_message_parts");
    assert.ok(names.includes("lcm_compaction_events"), "should have lcm_compaction_events");
    assert.ok(names.includes("lcm_messages_fts"), "should have lcm_messages_fts");
    assert.ok(names.includes("lcm_summaries_fts"), "should have lcm_summaries_fts");
    assert.ok(names.includes("lcm_meta"), "should have lcm_meta");

    // Verify schema version
    const meta = db
      .prepare("SELECT value FROM lcm_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(meta.value, "2");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openLcmDatabase is idempotent", () => {
  const dir = createTempDir();
  try {
    const db1 = openLcmDatabase(dir);
    db1.close();

    // Opening again should not throw
    const db2 = openLcmDatabase(dir);
    const meta = db2
      .prepare("SELECT value FROM lcm_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(meta.value, "2");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Archive Tests ──

test("LcmArchive appendMessage stores and retrieves messages", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    archive.appendMessage("session-1", 0, "user", "Hello world");
    archive.appendMessage("session-1", 1, "assistant", "Hi there!");

    const messages = archive.getMessages("session-1", 0, 1);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hello world");
    assert.equal(messages[1].role, "assistant");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive appendMessages batch insert", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    archive.appendMessages("session-1", [
      { turnIndex: 0, role: "user", content: "First" },
      { turnIndex: 1, role: "assistant", content: "Second" },
      { turnIndex: 2, role: "user", content: "Third" },
    ]);

    assert.equal(archive.getMessageCount("session-1"), 3);
    assert.equal(archive.getMaxTurnIndex("session-1"), 2);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive getMaxTurnIndex returns -1 for empty session", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    assert.equal(archive.getMaxTurnIndex("nonexistent"), -1);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive FTS search finds matching content", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    archive.appendMessage("session-1", 0, "user", "Deploy the application to production");
    archive.appendMessage("session-1", 1, "assistant", "Running deployment pipeline now");
    archive.appendMessage("session-1", 2, "user", "Check the database migration status");

    const results = archive.search("deploy", 10);
    assert.ok(results.length >= 1, "should find at least one result for 'deploy'");
    assert.ok(
      results.some((r) => r.turn_index === 0 || r.turn_index === 1),
      "should match deployment-related turns",
    );

    const dbResults = archive.search("database migration", 10);
    assert.ok(dbResults.length >= 1, "should find 'database migration'");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive search normalizes non-positive limits", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    archive.appendMessage("session-1", 0, "user", "Deploy the application");
    archive.appendMessage("session-1", 1, "assistant", "Deploying now");

    assert.deepEqual(archive.search("deploy", -1), []);
    assert.deepEqual(archive.search("deploy", 0), []);
    assert.deepEqual(archive.searchWithContent("deploy", -1), []);
    assert.deepEqual(archive.searchWithContent("deploy", 0), []);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive searchWithContent returns focused excerpt", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    // Short content — should return full content
    const shortContent = "Deploy the application to production with zero downtime strategy";
    archive.appendMessage("session-1", 0, "user", shortContent);
    archive.appendMessage("session-1", 1, "assistant", "Running deployment pipeline now");

    const results = archive.searchWithContent("deploy", 10);
    assert.ok(results.length >= 1, "should find at least one result");

    const match = results.find((r) => r.turn_index === 0);
    assert.ok(match, "should match turn 0");
    assert.equal(match!.content, shortContent, "short content should be returned in full");
    assert.ok(match!.id > 0, "should have a valid message id");
    assert.ok(match!.score > 0, "should have a positive score");

    // Long content — should return focused excerpt around match
    const padding = "Lorem ipsum dolor sit amet. ".repeat(100);
    const longContent = padding + "The deploy key was updated. " + padding;
    archive.appendMessage("session-1", 2, "user", longContent);

    const longResults = archive.searchWithContent("deploy", 10, undefined, 500);
    const longMatch = longResults.find((r) => r.turn_index === 2);
    assert.ok(longMatch, "should match long message");
    assert.ok(longMatch!.content.includes("deploy"), "excerpt should contain the match term");
    assert.ok(longMatch!.content.length < longContent.length, "excerpt should be shorter than full content");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive search with session filter", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);

    archive.appendMessage("session-1", 0, "user", "Deploy the app");
    archive.appendMessage("session-2", 0, "user", "Deploy the service");

    const results = archive.search("deploy", 10, "session-1");
    assert.equal(results.length, 1);
    assert.equal(results[0].session_id, "session-1");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmArchive pruneOldMessages removes old entries", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    db.pragma("foreign_keys = OFF");
    const archive = new LcmArchive(db);

    // Insert a message with old timestamp
    const inserted = db.prepare(`
      INSERT INTO lcm_messages (session_id, turn_index, role, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("session-1", 0, "user", "Old message", 3, "2020-01-01T00:00:00.000Z");
    const oldMessageId = Number(inserted.lastInsertRowid);
    db.prepare(`
      INSERT INTO lcm_message_parts (message_id, ordinal, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(oldMessageId, 0, "text", JSON.stringify({ text: "Old message" }), "2020-01-01T00:00:00.000Z");

    archive.appendMessage("session-1", 1, "user", "New message");

    const pruned = archive.pruneOldMessages(1); // 1 day retention
    assert.equal(pruned, 1);
    assert.equal(archive.getMessageCount("session-1"), 1);
    const orphanedParts = db
      .prepare("SELECT COUNT(*) AS count FROM lcm_message_parts WHERE message_id = ?")
      .get(oldMessageId) as { count: number };
    assert.equal(orphanedParts.count, 0);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DAG Tests ──

test("LcmDag insertNode and getNodesAtDepth", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const dag = new LcmDag(db);

    dag.insertNode({
      id: "node-1",
      session_id: "session-1",
      depth: 0,
      parent_id: null,
      summary_text: "Summary of turns 0-7",
      token_count: 50,
      msg_start: 0,
      msg_end: 7,
      escalation: 0,
    });

    const nodes = dag.getNodesAtDepth("session-1", 0);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].summary_text, "Summary of turns 0-7");
    assert.equal(nodes[0].msg_start, 0);
    assert.equal(nodes[0].msg_end, 7);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmDag setParent links children to parent", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const dag = new LcmDag(db);

    // Create 4 leaf nodes
    for (let i = 0; i < 4; i++) {
      dag.insertNode({
        id: `leaf-${i}`,
        session_id: "session-1",
        depth: 0,
        parent_id: null,
        summary_text: `Leaf ${i}`,
        token_count: 20,
        msg_start: i * 8,
        msg_end: (i + 1) * 8 - 1,
        escalation: 0,
      });
    }

    // Create parent
    dag.insertNode({
      id: "parent-1",
      session_id: "session-1",
      depth: 1,
      parent_id: null,
      summary_text: "Rolled up summary",
      token_count: 40,
      msg_start: 0,
      msg_end: 31,
      escalation: 0,
    });

    dag.setParent(["leaf-0", "leaf-1", "leaf-2", "leaf-3"], "parent-1");

    // Orphan nodes at depth 0 should now be empty
    const orphans = dag.getOrphanNodesAtDepth("session-1", 0);
    assert.equal(orphans.length, 0);

    // Children of parent should be 4
    const children = dag.getChildren("parent-1");
    assert.equal(children.length, 4);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmDag getDeepestNodes returns highest-depth nodes", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const dag = new LcmDag(db);

    dag.insertNode({
      id: "depth0",
      session_id: "s1",
      depth: 0,
      parent_id: null,
      summary_text: "Leaf",
      token_count: 20,
      msg_start: 0,
      msg_end: 7,
      escalation: 0,
    });

    dag.insertNode({
      id: "depth1",
      session_id: "s1",
      depth: 1,
      parent_id: null,
      summary_text: "Condensed",
      token_count: 30,
      msg_start: 0,
      msg_end: 31,
      escalation: 0,
    });

    const deepest = dag.getDeepestNodes("s1");
    assert.equal(deepest.length, 1);
    assert.equal(deepest[0].id, "depth1");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmDag recordCompaction stores compaction event", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const dag = new LcmDag(db);

    dag.recordCompaction("s1", 100, 50000, 10000);

    const events = db
      .prepare("SELECT * FROM lcm_compaction_events WHERE session_id = ?")
      .all("s1") as any[];
    assert.equal(events.length, 1);
    assert.equal(events[0].msg_before, 100);
    assert.equal(events[0].tokens_before, 50000);
    assert.equal(events[0].tokens_after, 10000);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summarizer Tests ──

test("LcmSummarizer creates leaf nodes from unsummarized messages", async () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    // Insert 8 messages (matches default leafBatchSize)
    for (let i = 0; i < 8; i++) {
      archive.appendMessage("session-1", i, i % 2 === 0 ? "user" : "assistant", `Message ${i}`);
    }

    // Use deterministic summarizer (returns input as-is, simulating level-2 fallback)
    const stubSummarize: SummarizeFn = async () => null; // Force deterministic fallback
    const summarizer = new LcmSummarizer(archive, dag, stubSummarize, {
      leafBatchSize: 8,
      rollupFanIn: 4,
      maxDepth: 5,
      deterministicMaxTokens: 512,
    });

    const created = await summarizer.summarizeIncremental("session-1");
    assert.ok(created >= 1, "should create at least one leaf node");

    const nodes = dag.getNodesAtDepth("session-1", 0);
    assert.ok(nodes.length >= 1, "should have at least one depth-0 node");
    assert.equal(nodes[0].msg_start, 0);
    assert.equal(nodes[0].msg_end, 7);
    assert.equal(nodes[0].escalation, 2, "should use deterministic fallback when LLM returns null");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmSummarizer performs rollup when enough leaf nodes exist", async () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    // Insert 16 messages (2 leaf batches of 8, rollupFanIn=2 for testing)
    for (let i = 0; i < 16; i++) {
      archive.appendMessage("session-1", i, i % 2 === 0 ? "user" : "assistant", `Turn ${i} content`);
    }

    const stubSummarize: SummarizeFn = async (text, _targetTokens, aggressive) => {
      return aggressive ? "- bullet summary" : "Normal summary of the content.";
    };

    const summarizer = new LcmSummarizer(archive, dag, stubSummarize, {
      leafBatchSize: 8,
      rollupFanIn: 2,  // Roll up after 2 leaves
      maxDepth: 3,
      deterministicMaxTokens: 512,
    });

    const created = await summarizer.summarizeIncremental("session-1");
    assert.ok(created >= 3, "should create 2 leaves + 1 rollup");

    const depth0 = dag.getNodesAtDepth("session-1", 0);
    assert.equal(depth0.length, 2, "should have 2 leaf nodes");

    const depth1 = dag.getNodesAtDepth("session-1", 1);
    assert.equal(depth1.length, 1, "should have 1 depth-1 rollup node");
    assert.equal(depth1[0].msg_start, 0);
    assert.equal(depth1[0].msg_end, 15);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LcmSummarizer does not create incomplete batches", async () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    // Insert 5 messages (less than leafBatchSize=8)
    for (let i = 0; i < 5; i++) {
      archive.appendMessage("session-1", i, "user", `Message ${i}`);
    }

    const stubSummarize: SummarizeFn = async () => "summary";
    const summarizer = new LcmSummarizer(archive, dag, stubSummarize, {
      leafBatchSize: 8,
      rollupFanIn: 4,
      maxDepth: 5,
      deterministicMaxTokens: 512,
    });

    const created = await summarizer.summarizeIncremental("session-1");
    assert.equal(created, 0, "should not create nodes for incomplete batch");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Recall Tests ──

test("assembleCompressedHistory returns empty string for empty archive", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    const result = assembleCompressedHistory(dag, archive, "nonexistent", {
      freshTailTurns: 16,
      budgetChars: 5000,
    });
    assert.equal(result, "");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assembleCompressedHistory includes session history header", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    // Create messages and a leaf node
    for (let i = 0; i < 8; i++) {
      archive.appendMessage("s1", i, "user", `Turn ${i}`);
    }

    dag.insertNode({
      id: "leaf-1",
      session_id: "s1",
      depth: 0,
      parent_id: null,
      summary_text: "Summary of early conversation about deployment setup.",
      token_count: 20,
      msg_start: 0,
      msg_end: 7,
      escalation: 0,
    });

    const result = assembleCompressedHistory(dag, archive, "s1", {
      freshTailTurns: 4,
      budgetChars: 5000,
    });

    assert.ok(result.includes("## Session History (Compressed)"), "should include header");
    assert.ok(result.includes("deployment setup"), "should include summary content");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assembleCompressedHistory respects budget", () => {
  const dir = createTempDir();
  try {
    const db = openLcmDatabase(dir);
    const archive = new LcmArchive(db);
    const dag = new LcmDag(db);

    for (let i = 0; i < 32; i++) {
      archive.appendMessage("s1", i, "user", `Turn ${i}`);
    }

    // Create many leaf nodes with long summaries
    for (let i = 0; i < 4; i++) {
      dag.insertNode({
        id: `leaf-${i}`,
        session_id: "s1",
        depth: 0,
        parent_id: null,
        summary_text: "A".repeat(500), // 500 chars each
        token_count: 125,
        msg_start: i * 8,
        msg_end: (i + 1) * 8 - 1,
        escalation: 0,
      });
    }

    const result = assembleCompressedHistory(dag, archive, "s1", {
      freshTailTurns: 8,
      budgetChars: 800, // Only room for ~1 section
    });

    // Should not exceed budget significantly
    assert.ok(result.length < 1200, `result too long: ${result.length} chars`);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── estimateTokens Tests ──

test("estimateTokens gives rough count", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("word"), 1);
  assert.equal(estimateTokens("a".repeat(100)), 25);
});

// ── Config Tests ──

test("LCM config fields parse correctly", async () => {
  // This test validates the config parsing by importing parseConfig
  // and checking the LCM fields are present with defaults
  const { parseConfig } = await import("../src/config.js");

  const config = parseConfig({
    openaiApiKey: "test",
    memoryDir: "/tmp/test",
  });

  // Default: disabled
  assert.equal(config.lcmEnabled, false);
  assert.equal(config.lcmLeafBatchSize, 8);
  assert.equal(config.lcmRollupFanIn, 4);
  assert.equal(config.lcmFreshTailTurns, 16);
  assert.equal(config.lcmMaxDepth, 5);
  assert.equal(config.lcmRecallBudgetShare, 0.15);
  assert.equal(config.lcmDeterministicMaxTokens, 512);
  assert.equal(config.lcmArchiveRetentionDays, 90);
  assert.equal(config.messagePartsEnabled, false);
  assert.equal(config.messagePartsRecallMaxResults, 6);
});

test("LCM config fields accept custom values", async () => {
  const { parseConfig } = await import("../src/config.js");

  const config = parseConfig({
    openaiApiKey: "test",
    memoryDir: "/tmp/test",
    lcmEnabled: true,
    lcmLeafBatchSize: 16,
    lcmRollupFanIn: 3,
    lcmFreshTailTurns: 32,
    lcmMaxDepth: 3,
    lcmRecallBudgetShare: 0.25,
    lcmDeterministicMaxTokens: 256,
    lcmArchiveRetentionDays: 30,
    messagePartsEnabled: true,
    messagePartsRecallMaxResults: 4,
  });

  assert.equal(config.lcmEnabled, true);
  assert.equal(config.lcmLeafBatchSize, 16);
  assert.equal(config.lcmRollupFanIn, 3);
  assert.equal(config.lcmFreshTailTurns, 32);
  assert.equal(config.lcmMaxDepth, 3);
  assert.equal(config.lcmRecallBudgetShare, 0.25);
  assert.equal(config.lcmDeterministicMaxTokens, 256);
  assert.equal(config.lcmArchiveRetentionDays, 30);
  assert.equal(config.messagePartsEnabled, true);
  assert.equal(config.messagePartsRecallMaxResults, 4);
});

test("LCM config clamps values to valid ranges", async () => {
  const { parseConfig } = await import("../src/config.js");

  const config = parseConfig({
    openaiApiKey: "test",
    memoryDir: "/tmp/test",
    lcmLeafBatchSize: 0,     // should clamp to 2
    lcmRollupFanIn: 1,       // should clamp to 2
    lcmFreshTailTurns: -5,   // should clamp to 1
    lcmMaxDepth: 0,          // should clamp to 1
    lcmRecallBudgetShare: 5, // should clamp to 1
    lcmDeterministicMaxTokens: 10, // should clamp to 64
    lcmArchiveRetentionDays: 0, // should clamp to 1
  });

  assert.equal(config.lcmLeafBatchSize, 2);
  assert.equal(config.lcmRollupFanIn, 2);
  assert.equal(config.lcmFreshTailTurns, 1);
  assert.equal(config.lcmMaxDepth, 1);
  assert.equal(config.lcmRecallBudgetShare, 1);
  assert.equal(config.lcmDeterministicMaxTokens, 64);
  assert.equal(config.lcmArchiveRetentionDays, 1);
});
