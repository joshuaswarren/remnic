// ---------------------------------------------------------------------------
// Importer integration tests.
//
// Uses synthetic in-memory SQLite databases — no real user data, no fixture
// files. Per CLAUDE.md (public repo policy): test data must be synthetic.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { importLosslessClaw } from "./importer.js";

type DbHandle = ReturnType<typeof BetterSqlite3>;

interface SeedMessage {
  message_id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  token_count: number;
  identity_hash?: string | null;
  created_at: string;
}

interface SeedMessagePart {
  message_id: string;
  ordinal: number;
  kind: string;
  payload: string;
  tool_name?: string | null;
  file_path?: string | null;
  created_at?: string | null;
}

interface SeedSummary {
  summary_id: string;
  kind: "leaf" | "condensed";
  depth: number;
  content: string;
  token_count: number;
  earliest_at?: string | null;
  latest_at?: string | null;
  message_ids: string[];
  parent_ids?: Array<{ parent_summary_id: string; ordinal: number }>;
}

interface SeedConversation {
  conversation_id: string;
  session_id?: string | null;
  session_key?: string | null;
  title?: string | null;
}

function buildSourceDb(seed: {
  conversations: SeedConversation[];
  messages: SeedMessage[];
  messageParts?: SeedMessagePart[];
  summaries?: SeedSummary[];
}): DbHandle {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      session_id      TEXT,
      session_key     TEXT,
      title           TEXT
    );
    CREATE TABLE messages (
      message_id      TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      identity_hash   TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE summaries (
      summary_id      TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      depth           INTEGER NOT NULL,
      content         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      earliest_at     TEXT,
      latest_at       TEXT
    );
    CREATE TABLE summary_messages (
      summary_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE TABLE summary_parents (
      summary_id        TEXT NOT NULL,
      parent_summary_id TEXT NOT NULL,
      ordinal           INTEGER NOT NULL
    );
    CREATE TABLE message_parts (
      message_id TEXT NOT NULL,
      ordinal    INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      tool_name  TEXT,
      file_path  TEXT,
      created_at TEXT
    );
  `);

  const insConv = db.prepare(
    "INSERT INTO conversations (conversation_id, session_id, session_key, title) VALUES (?, ?, ?, ?)",
  );
  for (const c of seed.conversations) {
    insConv.run(
      c.conversation_id,
      c.session_id ?? null,
      c.session_key ?? null,
      c.title ?? null,
    );
  }

  const insMsg = db.prepare(
    "INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, identity_hash, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of seed.messages) {
    insMsg.run(
      m.message_id,
      m.conversation_id,
      m.seq,
      m.role,
      m.content,
      m.token_count,
      m.identity_hash ?? null,
      m.created_at,
    );
  }

  const insPart = db.prepare(
    "INSERT INTO message_parts (message_id, ordinal, kind, payload, tool_name, file_path, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const part of seed.messageParts ?? []) {
    insPart.run(
      part.message_id,
      part.ordinal,
      part.kind,
      part.payload,
      part.tool_name ?? null,
      part.file_path ?? null,
      part.created_at ?? null,
    );
  }

  if (seed.summaries) {
    const insSum = db.prepare(
      "INSERT INTO summaries (summary_id, kind, depth, content, token_count, earliest_at, latest_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insSumMsg = db.prepare(
      "INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)",
    );
    const insSumPar = db.prepare(
      "INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)",
    );
    for (const s of seed.summaries) {
      insSum.run(
        s.summary_id,
        s.kind,
        s.depth,
        s.content,
        s.token_count,
        s.earliest_at ?? null,
        s.latest_at ?? null,
      );
      for (const mid of s.message_ids) {
        insSumMsg.run(s.summary_id, mid);
      }
      for (const p of s.parent_ids ?? []) {
        insSumPar.run(s.summary_id, p.parent_summary_id, p.ordinal);
      }
    }
  }

  return db;
}

/**
 * Build a destination database with the EXACT Remnic LCM schema (kept
 * inline here so the test fails loudly if the production schema drifts).
 * Mirrors packages/remnic-core/src/lcm/schema.ts.
 */
function buildDestDb(): DbHandle {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE lcm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE lcm_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      metadata    TEXT
    );
    CREATE INDEX idx_lcm_messages_session ON lcm_messages(session_id, turn_index);

    CREATE TABLE lcm_message_parts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES lcm_messages(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      tool_name   TEXT,
      file_path   TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_lcm_message_parts_msg ON lcm_message_parts(message_id, ordinal);
    CREATE INDEX idx_lcm_message_parts_tool ON lcm_message_parts(tool_name);
    CREATE INDEX idx_lcm_message_parts_file ON lcm_message_parts(file_path);

    CREATE TABLE lcm_summary_nodes (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      depth         INTEGER NOT NULL,
      parent_id     TEXT,
      summary_text  TEXT NOT NULL,
      token_count   INTEGER NOT NULL,
      msg_start     INTEGER NOT NULL,
      msg_end       INTEGER NOT NULL,
      escalation    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES lcm_summary_nodes(id)
    );

    CREATE TABLE lcm_compaction_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      fired_at      TEXT NOT NULL,
      msg_before    INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after  INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE lcm_messages_fts USING fts5(
      content,
      content=lcm_messages,
      content_rowid=id
    );
    CREATE VIRTUAL TABLE lcm_summaries_fts USING fts5(
      summary_text,
      content=lcm_summary_nodes,
      content_rowid=rowid
    );
  `);
  return db;
}

function buildPreV2DestDb(): DbHandle {
  const db = buildDestDb();
  db.exec("DROP TABLE lcm_message_parts");
  return db;
}

const TWO_CONVS = (): {
  conversations: SeedConversation[];
  messages: SeedMessage[];
  messageParts?: SeedMessagePart[];
  summaries: SeedSummary[];
} => ({
  conversations: [
    { conversation_id: "conv-A", session_id: "sess-A", title: "topic A" },
    { conversation_id: "conv-B", session_id: null, title: "topic B" },
  ],
  messages: [
    {
      message_id: "m-a-1",
      conversation_id: "conv-A",
      seq: 0,
      role: "user",
      content: "hello A",
      token_count: 2,
      created_at: "2026-04-01T00:00:00.000Z",
    },
    {
      message_id: "m-a-2",
      conversation_id: "conv-A",
      seq: 1,
      role: "assistant",
      content: "hi A back",
      token_count: 3,
      created_at: "2026-04-01T00:00:01.000Z",
    },
    {
      message_id: "m-b-1",
      conversation_id: "conv-B",
      seq: 0,
      role: "user",
      content: "hello B",
      token_count: 2,
      created_at: "2026-04-01T00:01:00.000Z",
    },
  ],
  summaries: [
    {
      summary_id: "sum-A",
      kind: "leaf",
      depth: 0,
      content: "summary of A",
      token_count: 4,
      earliest_at: "2026-04-01T00:00:00.000Z",
      latest_at: "2026-04-01T00:00:01.000Z",
      message_ids: ["m-a-1", "m-a-2"],
    },
  ],
});

describe("importLosslessClaw — basic copy", () => {
  it("copies messages and summary across two conversations, falling back to conversation_id when session_id is null", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.conversationsScanned, 2);
    assert.equal(result.messagesInserted, 3);
    assert.equal(result.messagesSkipped, 0);
    assert.equal(result.summariesInserted, 1);
    assert.equal(result.summariesMultiParentCollapsed, 0);
    assert.equal(result.dryRun, false);
    // sessionsTouched: explicit "sess-A" + fallback "conv-B"
    assert.deepEqual(result.sessionsTouched, ["conv-B", "sess-A"]);

    const msgs = dst
      .prepare("SELECT session_id, turn_index, role, content FROM lcm_messages ORDER BY session_id, turn_index")
      .all();
    assert.deepEqual(msgs, [
      { session_id: "conv-B", turn_index: 0, role: "user", content: "hello B" },
      { session_id: "sess-A", turn_index: 0, role: "user", content: "hello A" },
      {
        session_id: "sess-A",
        turn_index: 1,
        role: "assistant",
        content: "hi A back",
      },
    ]);

    const summaries = dst
      .prepare(
        "SELECT id, session_id, depth, msg_start, msg_end, summary_text FROM lcm_summary_nodes",
      )
      .all();
    assert.deepEqual(summaries, [
      {
        id: "sum-A",
        session_id: "sess-A",
        depth: 0,
        msg_start: 0,
        msg_end: 1,
        summary_text: "summary of A",
      },
    ]);
  });

  it("imports message_parts into the Remnic LCM sidecar table", () => {
    const seed = TWO_CONVS();
    seed.messageParts = [
      {
        message_id: "m-a-2",
        ordinal: 0,
        kind: "file_write",
        payload: JSON.stringify({ path: "src/auth.ts" }),
        tool_name: "Edit",
        file_path: "src/auth.ts",
        created_at: "2026-04-01T00:00:01.500Z",
      },
    ];
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.messagePartsInserted, 1);
    assert.equal(result.messagePartsSkipped, 0);

    const parts = dst
      .prepare(
        "SELECT p.ordinal, p.kind, p.tool_name, p.file_path, m.session_id, m.turn_index " +
          "FROM lcm_message_parts p JOIN lcm_messages m ON m.id = p.message_id",
      )
      .all();
    assert.deepEqual(parts, [
      {
        ordinal: 0,
        kind: "file_write",
        tool_name: "Edit",
        file_path: "src/auth.ts",
        session_id: "sess-A",
        turn_index: 1,
      },
    ]);
  });

  it("preserves unknown message part kinds instead of coercing them", () => {
    const seed = TWO_CONVS();
    seed.messageParts = [
      {
        message_id: "m-a-2",
        ordinal: 0,
        kind: "reasoning_delta",
        payload: JSON.stringify({ text: "future source event" }),
        created_at: "2026-04-01T00:00:01.500Z",
      },
    ];
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.messagePartsInserted, 1);

    const part = dst
      .prepare("SELECT kind, payload FROM lcm_message_parts")
      .get() as { kind: string; payload: string };
    assert.equal(part.kind, "reasoning_delta");
    assert.deepEqual(JSON.parse(part.payload), { text: "future source event" });
  });
});

describe("importLosslessClaw — idempotency", () => {
  it("re-running imports zero new rows", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();

    const first = importLosslessClaw({ sourceDb: src, destDb: dst });
    const second = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(first.messagesInserted, 3);
    assert.equal(second.messagesInserted, 0);
    assert.equal(second.messagesSkipped, 3);
    assert.equal(second.summariesInserted, 0);
    assert.equal(second.summariesSkipped, 1);

    const total = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages")
      .get() as { n: number };
    assert.equal(total.n, 3);
  });

  it("dry-run skips message_parts that already exist on destination messages", () => {
    const seed = TWO_CONVS();
    seed.messageParts = [
      {
        message_id: "m-a-2",
        ordinal: 0,
        kind: "file_write",
        payload: JSON.stringify({ path: "src/auth.ts" }),
        tool_name: "Edit",
        file_path: "src/auth.ts",
        created_at: "2026-04-01T00:00:01.500Z",
      },
    ];
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    const first = importLosslessClaw({ sourceDb: src, destDb: dst });
    const dry = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });

    assert.equal(first.messagePartsInserted, 1);
    assert.equal(dry.messagePartsInserted, 0);
    assert.equal(dry.messagePartsSkipped, 1);
  });

  it("dry-run treats missing destination message_parts table as zero existing parts", () => {
    const seed = TWO_CONVS();
    seed.messageParts = [
      {
        message_id: "m-a-2",
        ordinal: 0,
        kind: "file_write",
        payload: JSON.stringify({ path: "src/auth.ts" }),
        tool_name: "Edit",
        file_path: "src/auth.ts",
        created_at: "2026-04-01T00:00:01.500Z",
      },
    ];
    const src = buildSourceDb(seed);
    const dst = buildPreV2DestDb();

    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });

    assert.equal(result.messagePartsInserted, 1);
    assert.equal(result.messagePartsSkipped, 0);
  });
});

describe("importLosslessClaw — FTS sync", () => {
  it("messages_fts and summaries_fts are queryable post-import", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    importLosslessClaw({ sourceDb: src, destDb: dst });

    const ftsMsgs = dst
      .prepare(
        "SELECT lcm_messages.session_id FROM lcm_messages_fts " +
          "JOIN lcm_messages ON lcm_messages.id = lcm_messages_fts.rowid " +
          "WHERE lcm_messages_fts MATCH 'hello'",
      )
      .all() as Array<{ session_id: string }>;
    const sessions = ftsMsgs.map((r) => r.session_id).sort();
    assert.deepEqual(sessions, ["conv-B", "sess-A"]);

    const ftsSums = dst
      .prepare("SELECT count(*) AS n FROM lcm_summaries_fts WHERE lcm_summaries_fts MATCH 'summary'")
      .get() as { n: number };
    assert.equal(ftsSums.n, 1);
  });
});

describe("importLosslessClaw — compaction-event boundary", () => {
  it("inserts one marker per session with tokens_before == tokens_after", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.compactionEventsInserted, 2);

    const events = dst
      .prepare(
        "SELECT session_id, msg_before, tokens_before, tokens_after FROM lcm_compaction_events ORDER BY session_id",
      )
      .all() as Array<{
      session_id: string;
      msg_before: number;
      tokens_before: number;
      tokens_after: number;
    }>;
    assert.equal(events.length, 2);
    for (const e of events) {
      assert.equal(
        e.tokens_before,
        e.tokens_after,
        "import marker must encode no-op compaction",
      );
    }
    const byId = new Map(events.map((e) => [e.session_id, e]));
    // sess-A has 2 messages → msg_before = max turn_index + 1 = 2; tokens = 2 + 3 = 5
    assert.equal(byId.get("sess-A")?.msg_before, 2);
    assert.equal(byId.get("sess-A")?.tokens_before, 5);
    // conv-B (fallback) has 1 message → msg_before = 1; tokens = 2
    assert.equal(byId.get("conv-B")?.msg_before, 1);
    assert.equal(byId.get("conv-B")?.tokens_before, 2);
  });

  it("dry-run COUNTS markers (matches other counters) but does not write them", () => {
    // Cursor low-sev: Messages/Summaries inserted are reported as
    // 'would insert' counts in dry-run; compactionEventsInserted must
    // follow the same contract for output consistency.
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(
      result.compactionEventsInserted,
      2,
      "dry-run reports the same count as a real run (2 sessions)",
    );
    const total = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_compaction_events")
      .get() as { n: number };
    assert.equal(total.n, 0, "no actual rows written in dry-run");
  });
});

describe("importLosslessClaw — dry run", () => {
  it("counts what would be inserted without writing", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      dryRun: true,
    });

    assert.equal(result.messagesInserted, 3);
    assert.equal(result.summariesInserted, 1);

    const totalMsgs = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages")
      .get() as { n: number };
    assert.equal(totalMsgs.n, 0);
    const totalSums = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_summary_nodes")
      .get() as { n: number };
    assert.equal(totalSums.n, 0);
  });
});

describe("importLosslessClaw — session filter", () => {
  it("treats an empty Set as 'import all' (Cursor low-sev: empty Set is truthy)", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      sessionFilter: new Set<string>(),
    });
    assert.equal(result.messagesInserted, 3, "empty Set must not skip all");
    assert.equal(result.summariesInserted, 1);
  });

  it("limits import to specified resolved sessions", () => {
    const src = buildSourceDb(TWO_CONVS());
    const dst = buildDestDb();
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      sessionFilter: new Set(["sess-A"]),
    });

    assert.equal(result.messagesInserted, 2);
    assert.equal(result.summariesInserted, 1);
    assert.deepEqual(result.sessionsTouched, ["sess-A"]);

    const otherSession = dst
      .prepare("SELECT COUNT(*) AS n FROM lcm_messages WHERE session_id = 'conv-B'")
      .get() as { n: number };
    assert.equal(otherSession.n, 0);
  });
});

describe("importLosslessClaw — multi-parent DAG collapse", () => {
  it("counts and logs collapsed multi-parent rows, picks lowest-ordinal parent", () => {
    const seed = TWO_CONVS();
    seed.summaries.push(
      {
        summary_id: "p-late",
        kind: "leaf",
        depth: 0,
        content: "late parent",
        token_count: 5,
        message_ids: ["m-a-1", "m-a-2"],
      },
      {
        summary_id: "sum-rollup",
        kind: "condensed",
        depth: 1,
        content: "rollup",
        token_count: 8,
        message_ids: ["m-a-1", "m-a-2"],
        parent_ids: [
          { parent_summary_id: "p-late", ordinal: 5 },
          { parent_summary_id: "sum-A", ordinal: 0 },
        ],
      },
    );
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const logs: string[] = [];
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      onLog: (line) => logs.push(line),
    });

    assert.equal(result.summariesMultiParentCollapsed, 1);
    assert.ok(
      logs.some((l) => l.includes("sum-rollup") && l.includes("2 parents")),
      "expected log about multi-parent collapse",
    );

    const row = dst
      .prepare("SELECT parent_id FROM lcm_summary_nodes WHERE id = 'sum-rollup'")
      .get() as { parent_id: string | null };
    assert.equal(row.parent_id, "sum-A");
  });

  it("drops parent links to summaries that are skipped during import", () => {
    const seed = TWO_CONVS();
    seed.summaries.push(
      {
        summary_id: "sum-orphan-parent",
        kind: "leaf",
        depth: 0,
        content: "orphan parent",
        token_count: 4,
        message_ids: [],
      },
      {
        summary_id: "sum-child",
        kind: "condensed",
        depth: 1,
        content: "child with skipped parent",
        token_count: 6,
        message_ids: ["m-a-1", "m-a-2"],
        parent_ids: [{ parent_summary_id: "sum-orphan-parent", ordinal: 0 }],
      },
    );
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const logs: string[] = [];
    const result = importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      onLog: (line) => logs.push(line),
    });

    assert.equal(result.summariesSkippedNoMessages, 1);

    const child = dst
      .prepare("SELECT parent_id FROM lcm_summary_nodes WHERE id = 'sum-child'")
      .get() as { parent_id: string | null };
    assert.equal(child.parent_id, null);
    assert.ok(
      logs.some((line) => line.includes("sum-child") && line.includes("dropped 1 parent")),
      "expected dropped parent link log",
    );
  });

  it("drops parent links to summaries from a different resolved session", () => {
    const seed = TWO_CONVS();
    seed.summaries.push({
      summary_id: "sum-cross-session-child",
      kind: "condensed",
      depth: 1,
      content: "child in B with parent from A",
      token_count: 6,
      message_ids: ["m-b-1"],
      parent_ids: [{ parent_summary_id: "sum-A", ordinal: 0 }],
    });
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const logs: string[] = [];

    importLosslessClaw({
      sourceDb: src,
      destDb: dst,
      onLog: (line) => logs.push(line),
    });

    const child = dst
      .prepare("SELECT session_id, parent_id FROM lcm_summary_nodes WHERE id = 'sum-cross-session-child'")
      .get() as { session_id: string; parent_id: string | null };
    assert.equal(child.session_id, "conv-B");
    assert.equal(child.parent_id, null);
    assert.ok(
      logs.some((line) => line.includes("sum-cross-session-child") && line.includes("dropped 1 parent")),
      "expected dropped cross-session parent link log",
    );
  });
});

describe("importLosslessClaw — schema rejection", () => {
  it("throws when source DB lacks lossless-claw tables", () => {
    const src = new BetterSqlite3(":memory:");
    src.exec("CREATE TABLE foo (x INTEGER);");
    const dst = buildDestDb();
    assert.throws(
      () => importLosslessClaw({ sourceDb: src, destDb: dst }),
      /lossless-claw tables/,
    );
  });
});

describe("importLosslessClaw — compaction-event token aggregation", () => {
  it("uses the destination's actual SUM(token_count), not just newly-inserted", () => {
    // Simulate a partial-retry scenario: messages already in dest, only
    // summaries new this run. The compaction event must reflect the dest's
    // real token total, not zero.
    const seed = TWO_CONVS();
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    // Pre-populate dst with the same messages so this run is summary-only.
    importLosslessClaw({ sourceDb: src, destDb: dst });

    // Wipe summaries + compaction events so the next run re-inserts them
    // but messages are already there.
    dst.exec("DELETE FROM lcm_summary_nodes; DELETE FROM lcm_compaction_events;");

    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.messagesInserted, 0);
    assert.equal(result.summariesInserted, 1);
    assert.equal(result.compactionEventsInserted, 2);
    assert.deepEqual(result.sessionsTouched, ["conv-B", "sess-A"]);

    const event = dst
      .prepare(
        "SELECT session_id, tokens_before FROM lcm_compaction_events WHERE session_id = 'sess-A'",
      )
      .get() as { session_id: string; tokens_before: number };
    // Total token_count for sess-A is 2 + 3 = 5, all already present in dest.
    assert.equal(
      event.tokens_before,
      5,
      "summary-only retry must read tokens from dest, not from this run's writes",
    );
  });

  it("recreates a missing import boundary when messages and summaries already exist", () => {
    const seed = TWO_CONVS();
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    importLosslessClaw({ sourceDb: src, destDb: dst });
    dst.exec("DELETE FROM lcm_compaction_events;");

    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.messagesInserted, 0);
    assert.equal(result.summariesInserted, 0);
    assert.equal(result.compactionEventsInserted, 2);
    assert.deepEqual(result.sessionsTouched, ["conv-B", "sess-A"]);

    const event = dst
      .prepare(
        "SELECT session_id, msg_before, tokens_before, tokens_after FROM lcm_compaction_events WHERE session_id = 'sess-A'",
      )
      .get() as {
        session_id: string;
        msg_before: number;
        tokens_before: number;
        tokens_after: number;
      };
    assert.equal(event.session_id, "sess-A");
    assert.equal(event.msg_before, 2);
    assert.equal(event.tokens_before, 5);
    assert.equal(event.tokens_after, 5);
  });

  it("recreates a missing import boundary for a message-only session", () => {
    const seed = {
      conversations: [
        { conversation_id: "conv-message-only", session_id: "sess-message-only" },
      ],
      messages: [
        {
          message_id: "msg-only-1",
          conversation_id: "conv-message-only",
          seq: 0,
          role: "user",
          content: "message only",
          token_count: 4,
          created_at: "2026-04-01T00:00:00.000Z",
        },
      ],
    };
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    importLosslessClaw({ sourceDb: src, destDb: dst });
    dst.exec("DELETE FROM lcm_compaction_events;");

    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.messagesInserted, 0);
    assert.equal(result.messagesSkipped, 1);
    assert.equal(result.summariesInserted, 0);
    assert.equal(result.compactionEventsInserted, 1);
    assert.deepEqual(result.sessionsTouched, ["sess-message-only"]);

    const event = dst
      .prepare(
        "SELECT session_id, msg_before, tokens_before, tokens_after FROM lcm_compaction_events WHERE session_id = 'sess-message-only'",
      )
      .get() as {
        session_id: string;
        msg_before: number;
        tokens_before: number;
        tokens_after: number;
      };
    assert.equal(event.session_id, "sess-message-only");
    assert.equal(event.msg_before, 1);
    assert.equal(event.tokens_before, 4);
    assert.equal(event.tokens_after, 4);
  });
});

describe("importLosslessClaw — multiple conversations per session (Codex P1)", () => {
  it("preserves all messages when two conversations share a session_id, despite seq overlap", () => {
    // Two conversations under one session, both starting at seq=0.
    // Naive (session_id, turn_index) dedup would silently drop the
    // second conversation's seq=0,1 as 'already present'. The fix
    // assigns session-global turn_index and dedupes on
    // metadata.{conversation_id, source_seq}.
    const seed = {
      conversations: [
        { conversation_id: "conv-A", session_id: "shared-sess" },
        { conversation_id: "conv-B", session_id: "shared-sess" },
      ],
      messages: [
        {
          message_id: "ma1",
          conversation_id: "conv-A",
          seq: 0,
          role: "user",
          content: "A says hello",
          token_count: 3,
          created_at: "2026-04-01T00:00:00.000Z",
        },
        {
          message_id: "ma2",
          conversation_id: "conv-A",
          seq: 1,
          role: "assistant",
          content: "A responds",
          token_count: 2,
          created_at: "2026-04-01T00:00:01.000Z",
        },
        {
          message_id: "mb1",
          conversation_id: "conv-B",
          seq: 0,
          role: "user",
          content: "B says hello",
          token_count: 3,
          created_at: "2026-04-01T00:01:00.000Z",
        },
        {
          message_id: "mb2",
          conversation_id: "conv-B",
          seq: 1,
          role: "assistant",
          content: "B responds",
          token_count: 2,
          created_at: "2026-04-01T00:01:01.000Z",
        },
      ],
    };
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });

    assert.equal(result.messagesInserted, 4, "all 4 messages must land");
    assert.equal(result.messagesSkipped, 0);

    const rows = dst
      .prepare(
        "SELECT turn_index, content, json_extract(metadata, '$.conversation_id') AS conv, " +
          "json_extract(metadata, '$.source_seq') AS source_seq " +
          "FROM lcm_messages WHERE session_id = 'shared-sess' ORDER BY turn_index",
      )
      .all() as Array<{
      turn_index: number;
      content: string;
      conv: string;
      source_seq: number;
    }>;
    assert.equal(rows.length, 4);
    // Session-global turn_index 0..3, no collisions
    assert.deepEqual(
      rows.map((r) => r.turn_index),
      [0, 1, 2, 3],
    );
    // Conversation order is deterministic by conversation_id sort:
    // conv-A first (seqs 0,1), then conv-B (seqs 0,1).
    assert.deepEqual(
      rows.map((r) => `${r.conv}:${r.source_seq}`),
      ["conv-A:0", "conv-A:1", "conv-B:0", "conv-B:1"],
    );
  });

  it("interleaves messages across conversations by created_at (Codex P1 follow-up #2)", () => {
    // Conv-A: messages at t=0 and t=10
    // Conv-B: messages at t=5 and t=6
    // Expected turn_index order: A@t0, B@t5, B@t6, A@t10
    const seed = {
      conversations: [
        { conversation_id: "conv-A", session_id: "sess" },
        { conversation_id: "conv-B", session_id: "sess" },
      ],
      messages: [
        {
          message_id: "a1",
          conversation_id: "conv-A",
          seq: 0,
          role: "user",
          content: "A@t0",
          token_count: 1,
          created_at: "2026-04-01T00:00:00.000Z",
        },
        {
          message_id: "a2",
          conversation_id: "conv-A",
          seq: 1,
          role: "assistant",
          content: "A@t10",
          token_count: 1,
          created_at: "2026-04-01T00:00:10.000Z",
        },
        {
          message_id: "b1",
          conversation_id: "conv-B",
          seq: 0,
          role: "user",
          content: "B@t5",
          token_count: 1,
          created_at: "2026-04-01T00:00:05.000Z",
        },
        {
          message_id: "b2",
          conversation_id: "conv-B",
          seq: 1,
          role: "assistant",
          content: "B@t6",
          token_count: 1,
          created_at: "2026-04-01T00:00:06.000Z",
        },
      ],
    };
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    importLosslessClaw({ sourceDb: src, destDb: dst });

    const rows = dst
      .prepare(
        "SELECT turn_index, content FROM lcm_messages WHERE session_id = 'sess' ORDER BY turn_index",
      )
      .all() as Array<{ turn_index: number; content: string }>;
    assert.deepEqual(
      rows.map((r) => r.content),
      ["A@t0", "B@t5", "B@t6", "A@t10"],
      "interleaved messages must appear in chronological order",
    );
  });

  it("orders conversations by earliest message timestamp, not by conversation_id (Codex P1 follow-up)", () => {
    // UUID-like ids that sort the OPPOSITE direction of chronology.
    // 'aaaa-conv-id' < 'zzzz-conv-id' lexicographically, but 'zzzz' is
    // chronologically earlier. A conversation_id sort would give the
    // wrong session timeline.
    const seed = {
      conversations: [
        { conversation_id: "aaaa-conv-id", session_id: "sess" },
        { conversation_id: "zzzz-conv-id", session_id: "sess" },
      ],
      messages: [
        {
          message_id: "z1",
          conversation_id: "zzzz-conv-id",
          seq: 0,
          role: "user",
          content: "earliest in time, conv-z",
          token_count: 1,
          created_at: "2026-04-01T00:00:00.000Z",
        },
        {
          message_id: "a1",
          conversation_id: "aaaa-conv-id",
          seq: 0,
          role: "user",
          content: "later in time, conv-a",
          token_count: 1,
          created_at: "2026-04-02T00:00:00.000Z",
        },
      ],
    };
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    importLosslessClaw({ sourceDb: src, destDb: dst });

    const rows = dst
      .prepare(
        "SELECT turn_index, content FROM lcm_messages WHERE session_id = 'sess' ORDER BY turn_index",
      )
      .all() as Array<{ turn_index: number; content: string }>;
    // Earliest message (zzzz-conv-id, 2026-04-01) gets turn_index 0
    // even though 'zzzz' sorts AFTER 'aaaa' lexicographically.
    assert.equal(rows[0]!.turn_index, 0);
    assert.match(rows[0]!.content, /earliest in time/);
    assert.equal(rows[1]!.turn_index, 1);
    assert.match(rows[1]!.content, /later in time/);
  });

  it("idempotent re-run still inserts zero new rows when conversations share a session", () => {
    const seed = {
      conversations: [
        { conversation_id: "conv-A", session_id: "shared-sess" },
        { conversation_id: "conv-B", session_id: "shared-sess" },
      ],
      messages: [
        {
          message_id: "ma1",
          conversation_id: "conv-A",
          seq: 0,
          role: "user",
          content: "A0",
          token_count: 1,
          created_at: "2026-04-01T00:00:00.000Z",
        },
        {
          message_id: "mb1",
          conversation_id: "conv-B",
          seq: 0,
          role: "user",
          content: "B0",
          token_count: 1,
          created_at: "2026-04-01T00:01:00.000Z",
        },
      ],
    };
    const src = buildSourceDb(seed);
    const dst = buildDestDb();

    const first = importLosslessClaw({ sourceDb: src, destDb: dst });
    const second = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(first.messagesInserted, 2);
    assert.equal(second.messagesInserted, 0);
    assert.equal(second.messagesSkipped, 2);
  });
});

describe("importLosslessClaw — orphan summaries", () => {
  it("skips summaries with no message references and increments the counter", () => {
    const seed = TWO_CONVS();
    seed.summaries.push({
      summary_id: "sum-orphan",
      kind: "leaf",
      depth: 0,
      content: "orphan",
      token_count: 4,
      message_ids: [],
    });
    const src = buildSourceDb(seed);
    const dst = buildDestDb();
    const result = importLosslessClaw({ sourceDb: src, destDb: dst });
    assert.equal(result.summariesSkippedNoMessages, 1);
    const row = dst
      .prepare("SELECT count(*) AS n FROM lcm_summary_nodes WHERE id = 'sum-orphan'")
      .get() as { n: number };
    assert.equal(row.n, 0);
  });
});
