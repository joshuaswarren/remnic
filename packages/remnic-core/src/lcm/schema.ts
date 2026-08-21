import path from "node:path";
import { mkdir } from "node:fs/promises";
import { log } from "../logger.js";
import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "../runtime/better-sqlite.js";

const LCM_SCHEMA_VERSION = 2;

export function openLcmDatabase(memoryDir: string): BetterSqlite3Database {
  const dbPath = path.join(memoryDir, "state", "lcm.sqlite");
  const db = openBetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  applySchema(db);
  return db;
}

export async function ensureLcmStateDir(memoryDir: string): Promise<void> {
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
}

/**
 * Apply (or upgrade) the LCM schema on an already-open SQLite handle.
 *
 * Exposed so optional host packages — e.g. importers using an in-memory
 * destination database for true read-only `--dry-run` execution — can
 * bootstrap the schema without going through `openLcmDatabase()` (which
 * always touches the filesystem).
 */
export function applyLcmSchema(db: BetterSqlite3Database): void {
  applySchema(db);
}

function applySchema(db: BetterSqlite3Database): void {
  const versionRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lcm_meta'")
    .get() as { name: string } | undefined;

  if (!versionRow) {
    createTables(db);
    return;
  }

  const meta = db
    .prepare("SELECT value FROM lcm_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const currentVersion = meta ? parseInt(meta.value, 10) : 0;

  if (currentVersion < LCM_SCHEMA_VERSION) {
    log.info(`LCM schema upgrade: v${currentVersion} → v${LCM_SCHEMA_VERSION}`);
    createTables(db);
  }
}

function createTables(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lcm_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      metadata    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lcm_messages_session
      ON lcm_messages(session_id, turn_index);

    CREATE TABLE IF NOT EXISTS lcm_message_parts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES lcm_messages(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      tool_name   TEXT,
      file_path   TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lcm_message_parts_msg
      ON lcm_message_parts(message_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_lcm_message_parts_tool
      ON lcm_message_parts(tool_name);
    CREATE INDEX IF NOT EXISTS idx_lcm_message_parts_file
      ON lcm_message_parts(file_path);

    CREATE TABLE IF NOT EXISTS lcm_summary_nodes (
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
    CREATE INDEX IF NOT EXISTS idx_lcm_summary_session
      ON lcm_summary_nodes(session_id, depth);
    CREATE INDEX IF NOT EXISTS idx_lcm_summary_range
      ON lcm_summary_nodes(session_id, msg_start, msg_end);

    CREATE TABLE IF NOT EXISTS lcm_compaction_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      fired_at      TEXT NOT NULL,
      msg_before    INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after  INTEGER NOT NULL
    );
  `);

  // FTS5 tables — created separately so IF NOT EXISTS works correctly
  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lcm_messages_fts'")
    .get();
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE lcm_messages_fts USING fts5(
        content,
        content=lcm_messages,
        content_rowid=id
      );
    `);
  }

  const hasSummaryFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lcm_summaries_fts'")
    .get();
  if (!hasSummaryFts) {
    db.exec(`
      CREATE VIRTUAL TABLE lcm_summaries_fts USING fts5(
        summary_text,
        content=lcm_summary_nodes,
        content_rowid=rowid
      );
    `);
  }

  // Upsert meta version
  db.prepare("INSERT OR REPLACE INTO lcm_meta (key, value) VALUES ('schema_version', ?)").run(
    String(LCM_SCHEMA_VERSION),
  );
}
