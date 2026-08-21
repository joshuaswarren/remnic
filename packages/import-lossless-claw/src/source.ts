// ---------------------------------------------------------------------------
// Lossless-claw source database access.
//
// Reads the schema produced by github.com/martian-engineering/lossless-claw
// (default location ~/.openclaw/lcm.db). Only the subset of tables that has
// a clean Remnic-LCM analog is surfaced:
//
//   conversations  → session_id resolution
//   messages       → lcm_messages
//   message_parts  → lcm_message_parts (when present)
//   summaries      → lcm_summary_nodes
//   summary_messages, summary_parents → derived msg_start/msg_end + parent_id
//
// Tables intentionally NOT read: large_files,
// conversation_compaction_telemetry, conversation_compaction_maintenance,
// lcm_migration_state. None have a Remnic LCM analog and importing them
// would create dead data.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";

import type Database from "better-sqlite3";

type BetterSqlite3Ctor = typeof import("better-sqlite3");

let cachedCtor: BetterSqlite3Ctor | null = null;

function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (cachedCtor) return cachedCtor;
  const require = createRequire(import.meta.url);
  const loaded = require("better-sqlite3") as
    | BetterSqlite3Ctor
    | { default?: BetterSqlite3Ctor };
  const ctor = typeof loaded === "function" ? loaded : loaded.default;
  if (typeof ctor !== "function") {
    throw new Error(
      "better-sqlite3 is unavailable. Install it alongside @remnic/import-lossless-claw " +
        "or rebuild from source: `pnpm rebuild better-sqlite3`.",
    );
  }
  cachedCtor = ctor;
  return ctor;
}

/**
 * Open a lossless-claw SQLite database file in read-only mode. The CLI uses
 * this so a half-baked source file cannot be written to during import.
 *
 * Tildes in the path are NOT expanded here — callers (CLI, tests) must
 * normalise paths first to keep the boundary explicit (CLAUDE.md gotcha
 * #17).
 */
export function openSourceDatabase(filePath: string): Database.Database {
  const Ctor = loadBetterSqlite3();
  return new Ctor(filePath, { readonly: true, fileMustExist: true });
}

/**
 * Open an in-memory destination database. The caller is expected to apply
 * the Remnic LCM schema via `applyLcmSchema(db)` from `@remnic/core` before
 * passing it to `importLosslessClaw`.
 *
 * Used by the `--dry-run` CLI path as a fallback when no existing on-disk
 * destination exists, so a true write-free run can still compute counts
 * against an empty destination without touching the filesystem.
 */
export function openInMemoryDestinationDatabase(): Database.Database {
  const Ctor = loadBetterSqlite3();
  return new Ctor(":memory:");
}

/**
 * Open an existing Remnic LCM database file in read-only mode. Used by the
 * `--dry-run` CLI path so dedup counts reflect the user's real
 * destination state without any write risk (Codex P2 follow-up: a fresh
 * in-memory database makes `messagesSkipped`/`summariesSkipped` always
 * report zero, which is misleading when the user has run a real import
 * before).
 */
export function openExistingLcmDatabaseReadOnly(
  filePath: string,
): Database.Database {
  const Ctor = loadBetterSqlite3();
  return new Ctor(filePath, { readonly: true, fileMustExist: true });
}

export interface LosslessClawConversation {
  conversation_id: string;
  session_id: string | null;
  session_key: string | null;
  title: string | null;
}

export interface LosslessClawMessage {
  message_id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  token_count: number;
  identity_hash: string | null;
  created_at: string;
}

export interface LosslessClawMessagePart {
  message_id: string;
  ordinal: number;
  kind: string;
  payload: string;
  tool_name: string | null;
  file_path: string | null;
  created_at: string | null;
}

export interface LosslessClawSummary {
  summary_id: string;
  kind: string;
  depth: number;
  content: string;
  token_count: number;
  earliest_at: string | null;
  latest_at: string | null;
}

export interface LosslessClawSummaryParent {
  summary_id: string;
  parent_summary_id: string;
  ordinal: number;
}

export interface LosslessClawSummaryMessage {
  summary_id: string;
  message_id: string;
}

/**
 * Verify a database handle points at a lossless-claw export by checking for
 * the required tables. Throws a user-facing error on mismatch so callers can
 * surface a clear "this isn't a lossless-claw database" message instead of
 * cryptic SQL errors during import.
 */
export function assertLosslessClawSchema(db: Database.Database): void {
  const required = [
    "conversations",
    "messages",
    "summaries",
    "summary_messages",
    "summary_parents",
  ];
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
  );
  const missing: string[] = [];
  for (const name of required) {
    const row = stmt.get(name) as { name: string } | undefined;
    if (!row) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Source database is missing lossless-claw tables: ${missing.join(", ")}. ` +
        "Confirm --src points at a lossless-claw lcm.db file.",
    );
  }
}

export function listConversations(
  db: Database.Database,
): LosslessClawConversation[] {
  return db
    .prepare(
      "SELECT conversation_id, session_id, session_key, title FROM conversations ORDER BY conversation_id",
    )
    .all() as LosslessClawConversation[];
}

export function listMessagesForConversation(
  db: Database.Database,
  conversationId: string,
): LosslessClawMessage[] {
  return db
    .prepare(
      "SELECT message_id, conversation_id, seq, role, content, token_count, identity_hash, created_at " +
        "FROM messages WHERE conversation_id = ? ORDER BY seq",
    )
    .all(conversationId) as LosslessClawMessage[];
}

export function listMessageParts(db: Database.Database): LosslessClawMessagePart[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_parts'")
    .get() as { name: string } | undefined;
  if (!hasTable) return [];

  const columns = new Set(
    (db.prepare("PRAGMA table_info(message_parts)").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has("message_id")) return [];

  const select = (name: string, fallback: string): string =>
    columns.has(name) ? name : `${fallback} AS ${name}`;
  const ordinalSelect = columns.has("ordinal")
    ? "ordinal"
    : "ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY rowid) - 1 AS ordinal";
  return db
    .prepare(
      "SELECT " +
        "message_id, " +
        `${ordinalSelect}, ` +
        `${select("kind", "'tool_call'")}, ` +
        `${select("payload", "'{}'")}, ` +
        `${select("tool_name", "NULL")}, ` +
        `${select("file_path", "NULL")}, ` +
        `${select("created_at", "NULL")} ` +
        "FROM message_parts ORDER BY message_id, ordinal",
    )
    .all() as LosslessClawMessagePart[];
}

export function listSummaries(db: Database.Database): LosslessClawSummary[] {
  return db
    .prepare(
      "SELECT summary_id, kind, depth, content, token_count, earliest_at, latest_at " +
        "FROM summaries ORDER BY depth, summary_id",
    )
    .all() as LosslessClawSummary[];
}

export function listSummaryParents(
  db: Database.Database,
): LosslessClawSummaryParent[] {
  return db
    .prepare(
      "SELECT summary_id, parent_summary_id, ordinal FROM summary_parents ORDER BY summary_id, ordinal",
    )
    .all() as LosslessClawSummaryParent[];
}

export function listSummaryMessages(
  db: Database.Database,
): LosslessClawSummaryMessage[] {
  return db
    .prepare(
      "SELECT summary_id, message_id FROM summary_messages",
    )
    .all() as LosslessClawSummaryMessage[];
}
