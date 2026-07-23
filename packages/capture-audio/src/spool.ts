/**
 * SQLite spool — the daemon's local buffer of captured conversations.
 *
 * Uses the built-in `node:sqlite` driver (no native dependency), keeping
 * @remnic/capture-audio à-la-carte: installing it pulls zero extra runtime
 * packages. WAL mode + foreign keys are enabled per connection.
 *
 * Schema (names/semantics fixed by issue #1897):
 *   chunks(id, channel, device, started_at_utc, ended_at_utc, status, wav_path)
 *   segments(id, chunk_id FK, conversation_id FK, speaker_cluster, is_wearer,
 *            channel, text, start_utc, end_utc, ordinal)
 *   conversations(id, started_at_utc, ended_at_utc, state, segment_count)
 *   speaker_clusters(id, label, centroid, example_embeddings, embedding_count, is_self)
 *   meta(key, value)
 *
 * The public read API (`queryFinalConversations`) serves ONLY `final`
 * conversations, ordered by a stable keyset (started_at_utc, id) so the
 * connector never ingests half a meeting and pagination is deterministic
 * even when two conversations share a start timestamp.
 */

import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SPOOL_SCHEMA_VERSION } from "./constants.js";
import { CaptureConfigError } from "./errors.js";
import { dateInTimezone, ulid } from "./util.js";
import { decodeCursor, encodeCursor } from "./validate.js";

export type ConversationState = "capturing" | "final";
export type ChunkStatus = "pending" | "transcribed" | "failed" | "deleted";

export interface SegmentInput {
  speakerCluster?: string | null;
  isWearer?: boolean;
  channel: string;
  text: string;
  startUtc: string;
  endUtc: string;
}
export interface ConversationInput {
  id?: string;
  startedAtUtc: string;
  endedAtUtc?: string | null;
  state?: ConversationState;
  device?: string | null;
  chunkStatus?: ChunkStatus;
  wavPath?: string | null;
  segments: SegmentInput[];
}
export interface SpeakerInput {
  id: string;
  label?: string | null;
  isSelf?: boolean;
  embeddingCount?: number;
}
export interface DaemonSegment {
  textRaw: string;
  speakerKey: string | null;
  isWearer: boolean;
  channel: string;
  startUtc: string;
  endUtc: string;
}
export interface DaemonConversation {
  id: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  state: ConversationState;
  segmentCount: number;
  segments: DaemonSegment[];
}
export interface ConversationPage {
  conversations: DaemonConversation[];
  nextCursor: string | null;
}
export interface SpeakerRow {
  id: string;
  label: string | null;
  isSelf: boolean;
  embeddingCount: number;
}
export interface QueryFinalOptions {
  date: string;
  timezone: string;
  cursor?: string | null;
  limit: number;
}

interface ConversationRow {
  id: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  state: ConversationState;
  segmentCount: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  started_at_utc TEXT NOT NULL,
  ended_at_utc TEXT,
  state TEXT NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  device TEXT,
  started_at_utc TEXT NOT NULL,
  ended_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  wav_path TEXT
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  speaker_cluster TEXT,
  is_wearer INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS speaker_clusters (
  id TEXT PRIMARY KEY,
  label TEXT,
  centroid BLOB,
  example_embeddings BLOB,
  embedding_count INTEGER NOT NULL DEFAULT 0,
  is_self INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_keyset ON conversations(started_at_utc, id);
CREATE INDEX IF NOT EXISTS idx_seg_conv ON segments(conversation_id, ordinal);
`;

/** Reject a timestamp that would become an Invalid Date downstream. */
function assertIsoInstant(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new CaptureConfigError(`${label}: expected a valid ISO timestamp`);
  }
}

export class Spool {
  #db: DatabaseSync;
  #closed = false;

  constructor(location: string) {
    this.#db = new DatabaseSync(location);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA_SQL);
    if (location !== ":memory:") {
      // Transcript spool holds conversation text; keep it owner-only on
      // multi-user desktops (best-effort; ignored where chmod is a no-op).
      try {
        chmodSync(location, 0o600);
      } catch {
        // filesystem without POSIX perms (e.g. some Windows mounts)
      }
    }
    this.#db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", String(SPOOL_SCHEMA_VERSION));
    this.#db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)").run("instance_id", ulid());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  meta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /**
   * Insert (or replace) a whole conversation with its segments and a
   * backing chunk row, atomically. Idempotent by conversation id:
   * re-ingesting the same id deletes the prior rows first, so a repeated
   * replay is a content no-op (kill-9 restart safety, acceptance criteria).
   */
  insertConversation(input: ConversationInput): string {
    if (typeof input.startedAtUtc !== "string" || input.startedAtUtc.trim() === "") {
      throw new CaptureConfigError("conversation.startedAtUtc: expected a non-empty ISO timestamp");
    }
    if (!Array.isArray(input.segments)) {
      throw new CaptureConfigError("conversation.segments: expected an array");
    }
    // Validate every timestamp before persisting so a direct Spool caller (not
    // just replay) cannot store a value that becomes an Invalid Date in
    // queryFinalConversations' day bucketing.
    assertIsoInstant(input.startedAtUtc, "conversation.startedAtUtc");
    if (input.endedAtUtc !== undefined && input.endedAtUtc !== null) {
      assertIsoInstant(input.endedAtUtc, "conversation.endedAtUtc");
    }
    input.segments.forEach((seg, i) => {
      assertIsoInstant(seg.startUtc, `conversation.segments[${i}].startUtc`);
      assertIsoInstant(seg.endUtc, `conversation.segments[${i}].endUtc`);
    });
    const convId = input.id ?? `conv_${ulid()}`;
    const chunkId = `chk_${convId}`;
    const state: ConversationState = input.state ?? "final";
    const chunkStatus: ChunkStatus = input.chunkStatus ?? "transcribed";
    const wavPath = input.wavPath ?? null;
    const lastSeg = input.segments[input.segments.length - 1];
    const endedAtUtc = input.endedAtUtc ?? lastSeg?.endUtc ?? input.startedAtUtc;
    const chunkChannel = input.segments[0]?.channel ?? "mic";

    const db = this.#db;
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);
      db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
      db.prepare(
        "INSERT INTO chunks(id, channel, device, started_at_utc, ended_at_utc, status, wav_path) VALUES (?,?,?,?,?,?,?)",
      ).run(chunkId, chunkChannel, input.device ?? null, input.startedAtUtc, endedAtUtc, chunkStatus, wavPath);
      db.prepare(
        "INSERT INTO conversations(id, started_at_utc, ended_at_utc, state, segment_count) VALUES (?,?,?,?,?)",
      ).run(convId, input.startedAtUtc, endedAtUtc, state, input.segments.length);
      const segStmt = db.prepare(
        "INSERT INTO segments(id, chunk_id, conversation_id, speaker_cluster, is_wearer, channel, text, start_utc, end_utc, ordinal) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (let i = 0; i < input.segments.length; i++) {
        const seg = input.segments[i];
        if (typeof seg.text !== "string" || seg.text === "") {
          throw new CaptureConfigError(`conversation.segments[${i}].text: expected a non-empty string`);
        }
        segStmt.run(
          `seg_${ulid()}`,
          chunkId,
          convId,
          seg.speakerCluster ?? null,
          seg.isWearer ? 1 : 0,
          seg.channel,
          seg.text,
          seg.startUtc,
          seg.endUtc,
          i,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return convId;
  }

  /** Flip every still-open conversation to `final` (daemon stop / gap timeout). */
  finalizeOpenConversations(): number {
    const result = this.#db.prepare("UPDATE conversations SET state = 'final' WHERE state = 'capturing'").run();
    return Number(result.changes);
  }

  upsertSpeaker(input: SpeakerInput): void {
    const current = this.#db
      .prepare("SELECT label, embedding_count AS embeddingCount, is_self AS isSelf FROM speaker_clusters WHERE id = ?")
      .get(input.id) as { label: string | null; embeddingCount: number; isSelf: number } | undefined;
    const label = Object.hasOwn(input, "label") ? (input.label ?? null) : (current?.label ?? null);
    const embeddingCount = Object.hasOwn(input, "embeddingCount")
      ? (input.embeddingCount ?? 0)
      : (current?.embeddingCount ?? 0);
    const isSelf = Object.hasOwn(input, "isSelf") ? (input.isSelf ? 1 : 0) : (current?.isSelf ?? 0);
    this.#db
      .prepare(
        "INSERT INTO speaker_clusters(id, label, embedding_count, is_self) VALUES (?,?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET label = excluded.label, is_self = excluded.is_self, embedding_count = excluded.embedding_count",
      )
      .run(input.id, label, embeddingCount, isSelf);
  }

  listSpeakers(): SpeakerRow[] {
    const rows = this.#db
      .prepare("SELECT id, label, is_self AS isSelf, embedding_count AS embeddingCount FROM speaker_clusters ORDER BY id ASC")
      .all() as Array<{ id: string; label: string | null; isSelf: number; embeddingCount: number }>;
    return rows.map((r) => ({ id: r.id, label: r.label, isSelf: r.isSelf === 1, embeddingCount: r.embeddingCount }));
  }

  pendingChunkCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE status = 'pending'").get() as { n: number };
    return row.n;
  }

  stats(): { conversations: number; segments: number; chunks: number } {
    const count = (table: string): number =>
      (this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { conversations: count("conversations"), segments: count("segments"), chunks: count("chunks") };
  }

  getConversation(id: string): DaemonConversation | null {
    const row = this.#db
      .prepare(
        "SELECT id, started_at_utc AS startedAtUtc, ended_at_utc AS endedAtUtc, state, segment_count AS segmentCount FROM conversations WHERE id = ?",
      )
      .get(id) as unknown as ConversationRow | undefined;
    return row ? this.#hydrate(row) : null;
  }

  /**
   * Final conversations whose local day (per `timezone`) equals `date`,
   * paged by the stable (started_at_utc, id) keyset. Fetches all final
   * rows after the cursor (the spool is a bounded buffer, not an archive),
   * filters to the requested local day, then pages — so the id tiebreak
   * keeps pagination correct across duplicate start timestamps.
   */
  queryFinalConversations(opts: QueryFinalOptions): ConversationPage {
    const cursor = decodeCursor(opts.cursor ?? null);
    const afterStarted = cursor ? cursor.startedAtUtc : "";
    const afterId = cursor ? cursor.id : "";
    const rows = this.#db
      .prepare(
        "SELECT id, started_at_utc AS startedAtUtc, ended_at_utc AS endedAtUtc, state, segment_count AS segmentCount " +
          "FROM conversations WHERE state = 'final' AND (started_at_utc > ? OR (started_at_utc = ? AND id > ?)) " +
          "ORDER BY started_at_utc ASC, id ASC",
      )
      .all(afterStarted, afterStarted, afterId) as unknown as ConversationRow[];

    const matches: ConversationRow[] = [];
    for (const row of rows) {
      if (dateInTimezone(new Date(row.startedAtUtc), opts.timezone) === opts.date) {
        matches.push(row);
        if (matches.length > opts.limit) break;
      }
    }
    const hasMore = matches.length > opts.limit;
    const page = hasMore ? matches.slice(0, opts.limit) : matches;
    const last = page[page.length - 1];
    return {
      conversations: page.map((row) => this.#hydrate(row)),
      nextCursor: hasMore && last ? encodeCursor(last.startedAtUtc, last.id) : null,
    };
  }

  #hydrate(row: ConversationRow): DaemonConversation {
    const segs = this.#db
      .prepare(
        "SELECT text, speaker_cluster AS speakerKey, is_wearer AS isWearer, channel, start_utc AS startUtc, end_utc AS endUtc " +
          "FROM segments WHERE conversation_id = ? ORDER BY ordinal ASC, id ASC",
      )
      .all(row.id) as Array<{
      text: string;
      speakerKey: string | null;
      isWearer: number;
      channel: string;
      startUtc: string;
      endUtc: string;
    }>;
    return {
      id: row.id,
      startedAtUtc: row.startedAtUtc,
      endedAtUtc: row.endedAtUtc,
      state: row.state,
      segmentCount: row.segmentCount,
      segments: segs.map((s) => ({
        textRaw: s.text,
        speakerKey: s.speakerKey,
        isWearer: s.isWearer === 1,
        channel: s.channel,
        startUtc: s.startUtc,
        endUtc: s.endUtc,
      })),
    };
  }
}
