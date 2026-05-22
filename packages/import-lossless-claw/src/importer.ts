// ---------------------------------------------------------------------------
// lossless-claw → Remnic LCM importer (orchestration)
//
// Streams rows from a lossless-claw SQLite export into a Remnic LCM
// SQLite database opened by the caller. The Remnic database must already
// have its schema applied (use openLcmDatabase() from @remnic/core).
//
// Idempotency: messages are keyed on (session_id, turn_index) — the same
// natural key Remnic's own indexer uses. Summary nodes are keyed on the
// preserved primary id.
//
// FTS sync: lcm_messages_fts and lcm_summaries_fts are external-content
// FTS5 tables, so every insert must be mirrored. We do this in the same
// transaction as the row write to keep the index consistent on crash.
//
// Compaction-event boundary: per-session, we insert one row into
// lcm_compaction_events with tokens_before == tokens_after, marking the
// post-import state from which Remnic's own compaction will operate.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

import {
  assertLosslessClawSchema,
  listConversations,
  listMessageParts,
  listMessagesForConversation,
  listSummaries,
  listSummaryMessages,
  listSummaryParents,
  type LosslessClawConversation,
  type LosslessClawMessage,
  type LosslessClawMessagePart,
} from "./source.js";
import {
  indexSummaryDerivations,
  isMultiParent,
  mapMessage,
  mapSummary,
  resolveSessionId,
  resolveSummarySession,
} from "./transform.js";

export interface ImportLosslessClawOptions {
  /** Open lossless-claw source database (read-only OK). */
  sourceDb: Database.Database;
  /** Open Remnic LCM destination database with schema applied. */
  destDb: Database.Database;
  /** When true, run all reads + transformations but skip writes. */
  dryRun?: boolean;
  /**
   * Optional set of session_ids (post-resolve) to import.
   *
   * `undefined` or an empty Set both mean "import every session".
   * Pass a non-empty Set to restrict to specific resolved session ids.
   */
  sessionFilter?: ReadonlySet<string>;
  /** Hook for status output (defaults to no-op). */
  onLog?: (line: string) => void;
}

export interface ImportLosslessClawResult {
  conversationsScanned: number;
  sessionsTouched: string[];
  messagesInserted: number;
  messagesSkipped: number;
  messagePartsInserted: number;
  messagePartsSkipped: number;
  summariesInserted: number;
  summariesSkipped: number;
  summariesMultiParentCollapsed: number;
  summariesSkippedNoMessages: number;
  summariesSkippedMultiSession: number;
  compactionEventsInserted: number;
  dryRun: boolean;
}

const NOOP_LOG = (_line: string): void => {
  /* default sink */
};

interface LcmMessagePartInput {
  ordinal?: number;
  kind: string;
  payload: Record<string, unknown>;
  toolName?: string | null;
  filePath?: string | null;
  createdAt?: string | null;
}

export function importLosslessClaw(
  options: ImportLosslessClawOptions,
): ImportLosslessClawResult {
  const { sourceDb, destDb } = options;
  const dryRun = options.dryRun ?? false;
  // Normalise sessionFilter: an empty Set is truthy in JavaScript, so a
  // raw `sessionFilter && !sessionFilter.has(session)` guard would skip
  // every session if a caller passed `new Set()` expecting "import all"
  // (the documented contract on the option). Treat empty-Set the same
  // as undefined here so every guard below is correct (Cursor Bugbot
  // review on PR #797).
  const sessionFilter =
    options.sessionFilter && options.sessionFilter.size > 0
      ? options.sessionFilter
      : undefined;
  const log = options.onLog ?? NOOP_LOG;

  assertLosslessClawSchema(sourceDb);

  const result: ImportLosslessClawResult = {
    conversationsScanned: 0,
    sessionsTouched: [],
    messagesInserted: 0,
    messagesSkipped: 0,
    messagePartsInserted: 0,
    messagePartsSkipped: 0,
    summariesInserted: 0,
    summariesSkipped: 0,
    summariesMultiParentCollapsed: 0,
    summariesSkippedNoMessages: 0,
    summariesSkippedMultiSession: 0,
    compactionEventsInserted: 0,
    dryRun,
  };

  // ── Pre-resolve session ids per conversation + per message id ──────────
  const conversations = listConversations(sourceDb);
  result.conversationsScanned = conversations.length;

  const sessionByConvId = new Map<string, string>();
  const sessionByMessageId = new Map<string, string>();

  for (const c of conversations) {
    sessionByConvId.set(c.conversation_id, resolveSessionId(c));
  }

  // Materialize messages once per conversation; reused for the write pass
  // and (via sessionByMessageId) for summary mapping.
  const messagesByConv = new Map<
    string,
    ReturnType<typeof listMessagesForConversation>
  >();

  for (const c of conversations) {
    const msgs = listMessagesForConversation(sourceDb, c.conversation_id);
    messagesByConv.set(c.conversation_id, msgs);
    const session = sessionByConvId.get(c.conversation_id)!;
    for (const m of msgs) {
      sessionByMessageId.set(m.message_id, session);
    }
  }

  // Build a per-session list of (conversation, message) pairs and sort
  // by message.created_at. This handles interleaved conversations
  // correctly: if conv-A has messages at t=0 and t=10 and conv-B has
  // messages at t=5 and t=6, turn_index ends up as t=0, t=5, t=6,
  // t=10 (chronological), not t=0, t=10, t=5, t=6 (which a per-
  // conversation pre-sort produces — Codex P1 follow-up review).
  type SessionEntry = {
    conv: LosslessClawConversation;
    msg: LosslessClawMessage;
  };
  const sessionMessages = new Map<string, SessionEntry[]>();
  const sessionOrder: string[] = [];
  for (const c of conversations) {
    const session = sessionByConvId.get(c.conversation_id)!;
    if (!sessionMessages.has(session)) {
      sessionMessages.set(session, []);
      sessionOrder.push(session);
    }
    const list = sessionMessages.get(session)!;
    for (const m of messagesByConv.get(c.conversation_id) ?? []) {
      list.push({ conv: c, msg: m });
    }
  }
  for (const list of sessionMessages.values()) {
    list.sort((a, b) => {
      if (a.msg.created_at !== b.msg.created_at) {
        return a.msg.created_at < b.msg.created_at ? -1 : 1;
      }
      // Stable tie-breaker chain when timestamps collide: conversation
      // id, then per-conversation seq (preserves intra-conversation
      // order even on identical timestamps).
      const cidCmp = a.conv.conversation_id.localeCompare(
        b.conv.conversation_id,
      );
      if (cidCmp !== 0) return cidCmp;
      return a.msg.seq - b.msg.seq;
    });
  }

  // ── Insert messages ────────────────────────────────────────────────────
  // Dedup uses source identity (`metadata.conversation_id` +
  // `metadata.source_seq`) rather than `(session_id, turn_index)` so two
  // source conversations sharing one session can both contribute messages
  // without one's `seq=N` masking the other's `seq=N` (Codex P1 review).
  //
  // To avoid the O(n²) behavior of a per-row `json_extract` lookup with
  // no covering index (Codex P2 review), pre-fetch existing source
  // identities once per affected session into an in-memory Map. The
  // import loop then does O(1) Map lookups for dedup.
  const insertMessageStmt = destDb.prepare(
    "INSERT INTO lcm_messages (session_id, turn_index, role, content, token_count, created_at, metadata) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessageFtsStmt = destDb.prepare(
    "INSERT INTO lcm_messages_fts (rowid, content) VALUES (?, ?)",
  );
  const existingScanStmt = destDb.prepare(
    "SELECT id, turn_index, " +
      "json_extract(metadata, '$.conversation_id') AS conv, " +
      "json_extract(metadata, '$.source_seq') AS source_seq " +
      "FROM lcm_messages WHERE session_id = ?",
  );

  // session → "convId|seq" → destination row identity. Lookup is
  // O(1) Map membership instead of a per-row JSON-extract scan.
  const existingBySession = new Map<
    string,
    Map<string, { turnIndex: number; rowId: number }>
  >();
  // session → max(turn_index) currently in dest (so new rows append).
  const maxTurnBySession = new Map<string, number>();
  for (const session of sessionMessages.keys()) {
    if (sessionFilter && !sessionFilter.has(session)) continue;
    const map = new Map<string, { turnIndex: number; rowId: number }>();
    let max = -1;
    const rows = existingScanStmt.iterate(session) as Iterable<{
      id: number;
      turn_index: number;
      conv: string | null;
      source_seq: number | null;
    }>;
    for (const row of rows) {
      if (row.turn_index > max) max = row.turn_index;
      if (row.conv != null && row.source_seq != null) {
        map.set(`${row.conv}|${row.source_seq}`, {
          turnIndex: row.turn_index,
          rowId: row.id,
        });
      }
    }
    existingBySession.set(session, map);
    maxTurnBySession.set(session, max);
  }

  const importBoundaryExistsStmt = destDb.prepare(
    "SELECT 1 AS hit FROM lcm_compaction_events " +
      "WHERE session_id = ? AND tokens_before = tokens_after LIMIT 1",
  );
  const importBoundaryCache = new Map<string, boolean>();

  function hasImportBoundary(session: string): boolean {
    const cached = importBoundaryCache.get(session);
    if (cached !== undefined) {
      return cached;
    }
    const row = importBoundaryExistsStmt.get(session) as
      | { hit: number }
      | undefined;
    const exists = row !== undefined;
    importBoundaryCache.set(session, exists);
    return exists;
  }

  const sessionsTouched = new Set<string>();
  // Mapping from source message_id → assigned (or pre-existing)
  // turn_index. Populated for both inserted rows and dedup-skipped rows
  // so summary mapping (msg_start/msg_end) reflects real turn indices.
  const turnIndexByMessageId = new Map<string, number>();
  const destRowIdByMessageId = new Map<string, number>();

  function assignTurnIndices(forWrite: boolean): void {
    for (const session of sessionOrder) {
      if (sessionFilter && !sessionFilter.has(session)) continue;
      const entries = sessionMessages.get(session) ?? [];
      const existing =
        existingBySession.get(session) ??
        new Map<string, { turnIndex: number; rowId: number }>();
      let nextTurn = (maxTurnBySession.get(session) ?? -1) + 1;
      for (const { conv, msg } of entries) {
        const key = `${conv.conversation_id}|${msg.seq}`;
        const existingTurn = existing.get(key);
        if (existingTurn !== undefined) {
          turnIndexByMessageId.set(msg.message_id, existingTurn.turnIndex);
          destRowIdByMessageId.set(msg.message_id, existingTurn.rowId);
          result.messagesSkipped += 1;
          if (!hasImportBoundary(session)) {
            sessionsTouched.add(session);
          }
          continue;
        }
        const ti = nextTurn++;
        turnIndexByMessageId.set(msg.message_id, ti);
        // Update the in-memory dedup map so duplicates within this
        // run also count as skips on subsequent passes (defensive;
        // shouldn't happen with valid source data).
        existing.set(key, { turnIndex: ti, rowId: -1 });
        if (forWrite) {
          const mapped = mapMessage(conv, msg, ti);
          const info = insertMessageStmt.run(
            mapped.session_id,
            mapped.turn_index,
            mapped.role,
            mapped.content,
            mapped.token_count,
            mapped.created_at,
            mapped.metadata,
          );
          insertMessageFtsStmt.run(
            Number(info.lastInsertRowid),
            mapped.content,
          );
          const rowId = Number(info.lastInsertRowid);
          destRowIdByMessageId.set(msg.message_id, rowId);
          existing.set(key, { turnIndex: ti, rowId });
        }
        result.messagesInserted += 1;
        sessionsTouched.add(session);
      }
    }
  }

  if (!dryRun) {
    const writeMessages = destDb.transaction(() => assignTurnIndices(true));
    writeMessages();
  } else {
    // Dry run: walk the same iteration to populate counters and
    // turnIndexByMessageId without mutating either DB.
    assignTurnIndices(false);
  }

  // ── Insert message parts ────────────────────────────────────────────────
  const messageParts = listMessageParts(sourceDb);
  const destHasMessageParts = sqliteTableExists(destDb, "lcm_message_parts");
  const existingPartsStmt = destHasMessageParts
    ? destDb.prepare(
      "SELECT COUNT(*) AS cnt FROM lcm_message_parts WHERE message_id = ?",
    )
    : undefined;
  const insertPartStmt = destHasMessageParts
    ? destDb.prepare(
      "INSERT INTO lcm_message_parts (message_id, ordinal, kind, payload, tool_name, file_path, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    : undefined;

  function processMessageParts(forWrite: boolean): void {
    const seenDestMessages = new Set<number>();
    const blockedDestMessages = new Set<number>();
    for (const sourcePart of messageParts) {
      if (!turnIndexByMessageId.has(sourcePart.message_id)) {
        result.messagePartsSkipped += 1;
        continue;
      }
      const destMessageId = destRowIdByMessageId.get(sourcePart.message_id);
      if (destMessageId !== undefined && destMessageId >= 0) {
        if (blockedDestMessages.has(destMessageId)) {
          result.messagePartsSkipped += 1;
          continue;
        }
        if (existingPartsStmt && !seenDestMessages.has(destMessageId)) {
          const existing = existingPartsStmt.get(destMessageId) as { cnt: number };
          if (existing.cnt > 0) {
            seenDestMessages.add(destMessageId);
            blockedDestMessages.add(destMessageId);
            result.messagePartsSkipped += 1;
            continue;
          }
          seenDestMessages.add(destMessageId);
        }
      } else if (forWrite) {
        result.messagePartsSkipped += 1;
        continue;
      }
      if (forWrite && !insertPartStmt) {
        result.messagePartsSkipped += 1;
        continue;
      }
      if (forWrite) {
        const mapped = mapLosslessMessagePart(sourcePart);
        insertPartStmt!.run(
          destMessageId,
          mapped.ordinal ?? sourcePart.ordinal,
          mapped.kind,
          JSON.stringify(mapped.payload),
          mapped.toolName ?? null,
          mapped.filePath ?? null,
          mapped.createdAt ?? sourcePart.created_at ?? new Date().toISOString(),
        );
      }
      result.messagePartsInserted += 1;
      const session = sessionByMessageId.get(sourcePart.message_id);
      if (session) sessionsTouched.add(session);
    }
  }

  if (!dryRun) {
    const writeParts = destDb.transaction(() => processMessageParts(true));
    writeParts();
  } else {
    processMessageParts(false);
  }

  // ── Insert summaries ───────────────────────────────────────────────────
  const summaries = listSummaries(sourceDb);
  const summaryMessages = listSummaryMessages(sourceDb);
  const summaryParents = listSummaryParents(sourceDb);
  const derivations = indexSummaryDerivations(summaryMessages, summaryParents);

  const summaryExistsStmt = destDb.prepare(
    "SELECT session_id FROM lcm_summary_nodes WHERE id = ? LIMIT 1",
  );
  const insertSummaryStmt = destDb.prepare(
    "INSERT INTO lcm_summary_nodes (id, session_id, depth, parent_id, summary_text, token_count, msg_start, msg_end, escalation, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSummaryFtsStmt = destDb.prepare(
    "INSERT INTO lcm_summaries_fts (rowid, summary_text) VALUES (?, ?)",
  );
  const lookupSummaryRowidStmt = destDb.prepare(
    "SELECT rowid AS rowid FROM lcm_summary_nodes WHERE id = ?",
  );
  const importableSummarySessions = new Map<string, string>();
  for (const summary of summaries) {
    const derivation = derivations.get(summary.summary_id);
    if (!derivation || derivation.messageIds.length === 0) continue;
    const session = resolveSummarySession(
      derivation.messageIds,
      sessionByMessageId,
    );
    if (!session) continue;
    if (sessionFilter && !sessionFilter.has(session)) continue;
    if (
      derivation.messageIds.some(
        (mid) => typeof turnIndexByMessageId.get(mid) === "number",
      )
    ) {
      importableSummarySessions.set(summary.summary_id, session);
    }
  }

  // Single shared loop body for both write and dry-run paths so summary
  // filter conditions (skip-no-messages, multi-session, dedup, etc.)
  // can never silently diverge between modes (Cursor Bugbot review).
  function processSummaries(forWrite: boolean): void {
    for (const summary of summaries) {
      const derivation = derivations.get(summary.summary_id);
      if (!derivation || derivation.messageIds.length === 0) {
        result.summariesSkippedNoMessages += 1;
        log(
          `skip summary ${summary.summary_id}: no message references in summary_messages`,
        );
        continue;
      }
      const session = resolveSummarySession(
        derivation.messageIds,
        sessionByMessageId,
      );
      if (!session) {
        result.summariesSkippedMultiSession += 1;
        log(
          `skip summary ${summary.summary_id}: covers messages from multiple sessions or has dangling references`,
        );
        continue;
      }
      if (sessionFilter && !sessionFilter.has(session)) continue;

      const messageSeqs: number[] = [];
      for (const mid of derivation.messageIds) {
        const seq = turnIndexByMessageId.get(mid);
        if (typeof seq === "number") messageSeqs.push(seq);
      }
      if (messageSeqs.length === 0) {
        result.summariesSkippedNoMessages += 1;
        log(
          `skip summary ${summary.summary_id}: message ids exist but seqs unresolved`,
        );
        continue;
      }

      const validParents = derivation.parents.filter((parent) => {
        const importableParentSession = importableSummarySessions.get(parent.parent_summary_id);
        if (importableParentSession !== undefined) {
          return importableParentSession === session;
        }
        const existingParent = summaryExistsStmt.get(parent.parent_summary_id) as
          | { session_id: string }
          | undefined;
        return existingParent !== undefined && existingParent.session_id === session;
      });
      if (validParents.length !== derivation.parents.length) {
        log(
          `summary ${summary.summary_id}: dropped ${derivation.parents.length - validParents.length} ` +
            "parent link(s) to skipped or missing summaries",
        );
      }

      const mapped = mapSummary({
        summary,
        parents: validParents,
        messageSeqs,
        sessionId: session,
      });

      if (isMultiParent(validParents)) {
        result.summariesMultiParentCollapsed += 1;
        log(
          `summary ${summary.summary_id} has ${validParents.length} parents; ` +
            `keeping ${mapped.parent_id ?? "(none)"} (Remnic LCM is single-parent).`,
        );
      }

      const existing = summaryExistsStmt.get(mapped.id) as
        | { session_id: string }
        | undefined;
      if (existing) {
        result.summariesSkipped += 1;
        if (!hasImportBoundary(mapped.session_id)) {
          sessionsTouched.add(mapped.session_id);
        }
        continue;
      }
      if (forWrite) {
        insertSummaryStmt.run(
          mapped.id,
          mapped.session_id,
          mapped.depth,
          mapped.parent_id,
          mapped.summary_text,
          mapped.token_count,
          mapped.msg_start,
          mapped.msg_end,
          mapped.escalation,
          mapped.created_at,
        );
        const row = lookupSummaryRowidStmt.get(mapped.id) as
          | { rowid: number }
          | undefined;
        if (row) {
          insertSummaryFtsStmt.run(row.rowid, mapped.summary_text);
        }
      }
      result.summariesInserted += 1;
      sessionsTouched.add(mapped.session_id);
    }
  }

  if (!dryRun) {
    const writeSummaries = destDb.transaction(() => processSummaries(true));
    writeSummaries();
  } else {
    processSummaries(false);
  }

  // ── Compaction-event boundary ──────────────────────────────────────────
  // Insert one marker row per session that gained data. tokens_before
  // equals tokens_after to encode "this is an import boundary, not a real
  // compaction event"; any consumer that needs the distinction can detect
  // the equality.
  //
  // Token totals are queried from the destination at boundary-write time
  // rather than accumulated from this run's newly-inserted rows. That
  // way a session whose only new rows are summaries (e.g. partial retry
  // after a crash between message and summary transactions) still gets
  // a correct anchor reflecting the messages already in the destination
  // (Cursor Bugbot review on PR #797).
  // Always count what compaction events WOULD be written so dry-run
  // output matches the rest of the counters (Cursor Bugbot review on
  // PR #797: dry-run was reporting `Messages inserted: N` but
  // `Compaction events written: 0` despite the documented "count what
  // would be imported" contract). Skip the actual INSERTs in dry-run.
  const insertEventStmt = destDb.prepare(
    "INSERT INTO lcm_compaction_events (session_id, fired_at, msg_before, tokens_before, tokens_after) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  const maxTurnStmt = destDb.prepare(
    "SELECT IFNULL(MAX(turn_index), -1) AS max_turn FROM lcm_messages WHERE session_id = ?",
  );
  const totalTokensStmt = destDb.prepare(
    "SELECT IFNULL(SUM(token_count), 0) AS total FROM lcm_messages WHERE session_id = ?",
  );

  function processCompactionBoundaries(forWrite: boolean): void {
    const firedAt = new Date().toISOString();
    for (const session of sessionsTouched) {
      const turnRow = maxTurnStmt.get(session) as { max_turn: number };
      const msgBefore = turnRow.max_turn + 1;
      const tokRow = totalTokensStmt.get(session) as { total: number };
      const tokens = tokRow.total;
      if (forWrite) {
        insertEventStmt.run(session, firedAt, msgBefore, tokens, tokens);
      }
      result.compactionEventsInserted += 1;
    }
  }

  if (!dryRun) {
    const writeEvents = destDb.transaction(() => processCompactionBoundaries(true));
    writeEvents();
  } else {
    processCompactionBoundaries(false);
  }

  result.sessionsTouched = [...sessionsTouched].sort();
  return result;
}

function sqliteTableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function mapLosslessMessagePart(
  part: LosslessClawMessagePart,
): LcmMessagePartInput {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(part.payload);
    payload =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
  } catch {
    payload = { value: part.payload };
  }
  return {
    ordinal: part.ordinal,
    kind: part.kind,
    payload,
    toolName: part.tool_name,
    filePath: part.file_path,
    createdAt: part.created_at,
  };
}
