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
  /** Speaker embedding centroid; persisted as a JSON BLOB for restart-stable ids. */
  centroid?: readonly number[] | null;
  /** Bounded diverse example embeddings; persisted as a JSON BLOB. */
  examples?: readonly (readonly number[])[] | null;
}
export interface SpeakerClusterRow {
  id: string;
  label: string | null;
  isSelf: boolean;
  embeddingCount: number;
  centroid: number[];
  examples: number[][];
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
export interface AssemblyAppendInput {
  /** Durable dedup marker for one application (e.g. a transcribed chunk id). */
  idempotencyKey: string;
  /** Stable `conv_<ulid>` id from the assembler. */
  conversationId: string;
  /** Conversation start; used only when the conversation is first created. */
  startedAtUtc: string;
  /** Defaults to `capturing`; the conversation is finalized by a later call. */
  state?: ConversationState;
  device?: string | null;
  /** Backing chunk row id; defaults to `idempotencyKey`. */
  chunkId?: string;
  /** Backing WAV path recorded on the chunk row; retained for the janitor/audit. */
  wavPath?: string | null;
  segments: SegmentInput[];
}
export interface AssemblyAppendResult {
  /** False when `idempotencyKey` was already applied (a replay no-op). */
  applied: boolean;
  conversationId: string;
  /** Total segments in the conversation after this call. */
  segmentCount: number;
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
CREATE TABLE IF NOT EXISTS applied_chunks (
  idempotency_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  applied_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_keyset ON conversations(started_at_utc, id);
CREATE INDEX IF NOT EXISTS idx_seg_conv ON segments(conversation_id, ordinal);
`;

/**
 * Canonical instant required at the Spool boundary: a full date + time with a
 * Z or numeric offset (e.g. `2026-07-20T15:04:05.000Z`). Date-only strings
 * (`2026-07-20`) and offsetless local timestamps are REJECTED so every value
 * persisted in a `*_utc` column - and every keyset cursor derived from one -
 * is an unambiguous, order-stable instant. Replay/connector inputs are already
 * canonicalized to Z upstream; this guards direct `insertConversation` callers.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function assertIsoInstant(value: string, label: string): void {
  const match = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new CaptureConfigError(
      `${label}: '${value}' is not a canonical ISO instant (need date, time, and Z or offset)`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new CaptureConfigError(`${label}: '${value}' is not a real calendar date`);
  }
}

/**
 * Validate + canonicalize an instant to UTC `Z`. Accepted offset instants are
 * normalized (not stored verbatim) so every persisted `*_utc` value and the
 * keyset cursor sort by true UTC under SQLite's lexical TEXT ordering.
 */
function canonicalInstant(value: string, label: string): string {
  assertIsoInstant(value, label);
  return new Date(value).toISOString();
}

/** Runtime-checkable enum tables (Spool is exported; JS callers are unchecked by TS). */
const CONVERSATION_STATES: Record<ConversationState, true> = { capturing: true, final: true };
const CHUNK_STATUSES: Record<ChunkStatus, true> = {
  pending: true,
  transcribed: true,
  failed: true,
  deleted: true,
};

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
    const startedAtUtc = canonicalInstant(input.startedAtUtc, "conversation.startedAtUtc");
    const endedAtUtcInput =
      input.endedAtUtc !== undefined && input.endedAtUtc !== null
        ? canonicalInstant(input.endedAtUtc, "conversation.endedAtUtc")
        : null;
    if (endedAtUtcInput !== null && Date.parse(endedAtUtcInput) < Date.parse(startedAtUtc)) {
      throw new CaptureConfigError("conversation.endedAtUtc: must not precede startedAtUtc");
    }
    // Spool is exported and callable from JS, so reject an unknown state/chunkStatus
    // at the persistence boundary instead of storing a row the query/finalize/count
    // paths don't recognize (which would silently hide or miscount it).
    if (input.state !== undefined && !Object.hasOwn(CONVERSATION_STATES, input.state)) {
      throw new CaptureConfigError(`conversation.state: unknown value '${input.state}'`);
    }
    if (input.chunkStatus !== undefined && !Object.hasOwn(CHUNK_STATUSES, input.chunkStatus)) {
      throw new CaptureConfigError(`conversation.chunkStatus: unknown value '${input.chunkStatus}'`);
    }
    const segments = input.segments.map((seg, i) => {
      const startUtc = canonicalInstant(seg.startUtc, `conversation.segments[${i}].startUtc`);
      const endUtc = canonicalInstant(seg.endUtc, `conversation.segments[${i}].endUtc`);
      if (Date.parse(endUtc) < Date.parse(startUtc)) {
        throw new CaptureConfigError(`conversation.segments[${i}]: endUtc must not precede startUtc`);
      }
      if (typeof seg.text !== "string" || seg.text === "") {
        throw new CaptureConfigError(`conversation.segments[${i}].text: expected a non-empty string`);
      }
      return { ...seg, startUtc, endUtc };
    });
    const convId = input.id ?? `conv_${ulid()}`;
    const chunkId = `chk_${convId}`;
    const state: ConversationState = input.state ?? "final";
    const chunkStatus: ChunkStatus = input.chunkStatus ?? "transcribed";
    const wavPath = input.wavPath ?? null;
    const endedAtUtc = endedAtUtcInput ?? segments[segments.length - 1]?.endUtc ?? startedAtUtc;
    const chunkChannel = segments[0]?.channel ?? "mic";

    const db = this.#db;
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);
      db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
      db.prepare(
        "INSERT INTO chunks(id, channel, device, started_at_utc, ended_at_utc, status, wav_path) VALUES (?,?,?,?,?,?,?)",
      ).run(chunkId, chunkChannel, input.device ?? null, startedAtUtc, endedAtUtc, chunkStatus, wavPath);
      db.prepare(
        "INSERT INTO conversations(id, started_at_utc, ended_at_utc, state, segment_count) VALUES (?,?,?,?,?)",
      ).run(convId, startedAtUtc, endedAtUtc, state, segments.length);
      const segStmt = db.prepare(
        "INSERT INTO segments(id, chunk_id, conversation_id, speaker_cluster, is_wearer, channel, text, start_utc, end_utc, ordinal) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
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

  /**
   * Durably append one transcribed chunk's segments to a conversation,
   * idempotent on `idempotencyKey` (a replay/restart of the same chunk is a
   * no-op). Creates the conversation as `capturing` on first append; a later
   * `finalizeConversation`/`finalizeOpenConversations` flips it to `final`.
   */
  appendAssembledSegments(input: AssemblyAppendInput): AssemblyAppendResult {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "") {
      throw new CaptureConfigError("appendAssembledSegments.idempotencyKey: expected a non-empty string");
    }
    if (typeof input.conversationId !== "string" || input.conversationId.trim() === "") {
      throw new CaptureConfigError("appendAssembledSegments.conversationId: expected a non-empty string");
    }
    if (typeof input.startedAtUtc !== "string" || input.startedAtUtc.trim() === "") {
      throw new CaptureConfigError("appendAssembledSegments.startedAtUtc: expected a non-empty ISO timestamp");
    }
    if (!Array.isArray(input.segments) || input.segments.length === 0) {
      throw new CaptureConfigError("appendAssembledSegments.segments: expected a non-empty array");
    }
    if (input.state !== undefined && !Object.hasOwn(CONVERSATION_STATES, input.state)) {
      throw new CaptureConfigError(`appendAssembledSegments.state: unknown value '${input.state}'`);
    }
    const startedAtUtc = canonicalInstant(input.startedAtUtc, "appendAssembledSegments.startedAtUtc");
    const segments = input.segments.map((seg, i) => {
      const startUtc = canonicalInstant(seg.startUtc, `appendAssembledSegments.segments[${i}].startUtc`);
      const endUtc = canonicalInstant(seg.endUtc, `appendAssembledSegments.segments[${i}].endUtc`);
      if (Date.parse(endUtc) < Date.parse(startUtc)) {
        throw new CaptureConfigError(`appendAssembledSegments.segments[${i}]: endUtc must not precede startUtc`);
      }
      if (typeof seg.text !== "string" || seg.text === "") {
        throw new CaptureConfigError(`appendAssembledSegments.segments[${i}].text: expected a non-empty string`);
      }
      return { ...seg, startUtc, endUtc };
    });
    const convId = input.conversationId;
    const chunkId = input.chunkId ?? input.idempotencyKey;
    const state: ConversationState = input.state ?? "capturing";
    const chunkChannel = segments[0]?.channel ?? "mic";
    const lastEnd = segments[segments.length - 1].endUtc;
    const chunkStart = segments[0].startUtc;

    const db = this.#db;
    db.exec("BEGIN");
    try {
      const seen = db
        .prepare("SELECT conversation_id AS conversationId FROM applied_chunks WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as { conversationId: string } | undefined;
      if (seen) {
        db.exec("COMMIT");
        return { applied: false, conversationId: seen.conversationId, segmentCount: this.#segmentCount(seen.conversationId) };
      }
      db.prepare(
        "INSERT OR IGNORE INTO chunks(id, channel, device, started_at_utc, ended_at_utc, status, wav_path) VALUES (?,?,?,?,?,?,?)",
      ).run(chunkId, chunkChannel, input.device ?? null, chunkStart, lastEnd, "transcribed", input.wavPath ?? null);
      const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(convId) as { id: string } | undefined;
      if (!existing) {
        db.prepare(
          "INSERT INTO conversations(id, started_at_utc, ended_at_utc, state, segment_count) VALUES (?,?,?,?,0)",
        ).run(convId, startedAtUtc, lastEnd, state);
      }
      const ordinalRow = db
        .prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS n FROM segments WHERE conversation_id = ?")
        .get(convId) as { n: number };
      const nextOrdinal = Number(ordinalRow.n);
      const segStmt = db.prepare(
        "INSERT INTO segments(id, chunk_id, conversation_id, speaker_cluster, is_wearer, channel, text, start_utc, end_utc, ordinal) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
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
          nextOrdinal + i,
        );
      }
      db.prepare(
        "UPDATE conversations SET segment_count = segment_count + ?, " +
          "ended_at_utc = CASE WHEN ended_at_utc IS NULL OR ? > ended_at_utc THEN ? ELSE ended_at_utc END WHERE id = ?",
      ).run(segments.length, lastEnd, lastEnd, convId);
      db.prepare("INSERT INTO applied_chunks(idempotency_key, conversation_id, applied_at_utc) VALUES (?,?,?)").run(
        input.idempotencyKey,
        convId,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { applied: true, conversationId: convId, segmentCount: this.#segmentCount(convId) };
  }

  /** Flip one conversation to `final`; returns true when it was capturing. */
  finalizeConversation(id: string): boolean {
    const result = this.#db
      .prepare("UPDATE conversations SET state = 'final' WHERE id = ? AND state = 'capturing'")
      .run(id);
    return Number(result.changes) > 0;
  }

  /**
   * The newest still-`capturing` conversation, so a chunk arriving after a
   * process restart continues it (subject to the assembler's gap rule) instead
   * of splitting off a new one. Null when none is open.
   */
  latestCapturingConversation(): { id: string; startedAtUtc: string; endedAtUtc: string } | null {
    const row = this.#db
      .prepare(
        "SELECT id, started_at_utc AS startedAtUtc, ended_at_utc AS endedAtUtc FROM conversations " +
          "WHERE state = 'capturing' ORDER BY ended_at_utc DESC, id DESC LIMIT 1",
      )
      .get() as { id: string; startedAtUtc: string; endedAtUtc: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, startedAtUtc: row.startedAtUtc, endedAtUtc: row.endedAtUtc ?? row.startedAtUtc };
  }

  #segmentCount(conversationId: string): number {
    const row = this.#db
      .prepare("SELECT segment_count AS n FROM conversations WHERE id = ?")
      .get(conversationId) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  upsertSpeaker(input: SpeakerInput): void {
    const current = this.#db
      .prepare(
        "SELECT label, embedding_count AS embeddingCount, is_self AS isSelf, centroid, example_embeddings AS examples FROM speaker_clusters WHERE id = ?",
      )
      .get(input.id) as
      | { label: string | null; embeddingCount: number; isSelf: number; centroid: Buffer | null; examples: Buffer | null }
      | undefined;
    const label = Object.hasOwn(input, "label") ? (input.label ?? null) : (current?.label ?? null);
    const embeddingCount = Object.hasOwn(input, "embeddingCount")
      ? (input.embeddingCount ?? 0)
      : (current?.embeddingCount ?? 0);
    const isSelf = Object.hasOwn(input, "isSelf") ? (input.isSelf ? 1 : 0) : (current?.isSelf ?? 0);
    const centroid = Object.hasOwn(input, "centroid")
      ? input.centroid
        ? Buffer.from(JSON.stringify(input.centroid))
        : null
      : (current?.centroid ?? null);
    const examples = Object.hasOwn(input, "examples")
      ? input.examples
        ? Buffer.from(JSON.stringify(input.examples))
        : null
      : (current?.examples ?? null);
    this.#db
      .prepare(
        "INSERT INTO speaker_clusters(id, label, embedding_count, is_self, centroid, example_embeddings) VALUES (?,?,?,?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET label = excluded.label, is_self = excluded.is_self, embedding_count = excluded.embedding_count, " +
          "centroid = excluded.centroid, example_embeddings = excluded.example_embeddings",
      )
      .run(input.id, label, embeddingCount, isSelf, centroid, examples);
  }

  /** Read every speaker cluster with decoded centroid + examples (diarization restart seed). */
  readSpeakerClusters(): SpeakerClusterRow[] {
    const rows = this.#db
      .prepare(
        "SELECT id, label, is_self AS isSelf, embedding_count AS embeddingCount, centroid, example_embeddings AS examples FROM speaker_clusters ORDER BY id ASC",
      )
      .all() as Array<{
      id: string;
      label: string | null;
      isSelf: number;
      embeddingCount: number;
      centroid: Buffer | null;
      examples: Buffer | null;
    }>;
    const decode = (blob: Buffer | Uint8Array | null): unknown => {
      if (!blob || blob.byteLength === 0) return null;
      try {
        return JSON.parse(Buffer.from(blob).toString("utf8"));
      } catch {
        return null;
      }
    };
    return rows.map((r) => {
      const centroid = decode(r.centroid);
      const examples = decode(r.examples);
      return {
        id: r.id,
        label: r.label,
        isSelf: r.isSelf === 1,
        embeddingCount: r.embeddingCount,
        centroid: Array.isArray(centroid) ? (centroid as number[]) : [],
        examples: Array.isArray(examples) ? (examples as number[][]) : [],
      };
    });
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
          // Order by timestamp first: with channel "both", mic and system chunks
          // arrive independently, so ordinal (arrival order) isn't chronological.
          "FROM segments WHERE conversation_id = ? ORDER BY start_utc ASC, ordinal ASC, id ASC",
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
