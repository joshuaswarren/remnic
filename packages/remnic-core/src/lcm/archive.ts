import type Database from "better-sqlite3";
import { log } from "../logger.js";
import {
  parseMessageParts,
  type LcmMessagePartInput,
  type MessagePartSourceFormat,
} from "../message-parts/index.js";

export interface LcmMessage {
  id: number;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  token_count: number;
  created_at: string;
  metadata: string | null;
}

export interface LcmSearchResult {
  turn_index: number;
  role: string;
  snippet: string;
  session_id: string;
  score: number;
}

export interface LcmSearchWithContentResult {
  id: number;
  turn_index: number;
  role: string;
  content: string;
  session_id: string;
  score: number;
}

export interface LcmStructuredRecallMatch {
  part_id: number;
  message_id: number;
  turn_index: number;
  role: string;
  content: string;
  session_id: string;
  kind: string;
  tool_name: string | null;
  file_path: string | null;
  payload: string;
  score: number;
}

/** Rough token count: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class LcmArchive {
  constructor(private readonly db: Database.Database) {}

  /** Append a message to the archive. Returns the row id. */
  appendMessage(
    sessionId: string,
    turnIndex: number,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    parts?: LcmMessagePartInput[],
  ): number {
    const tokenCount = estimateTokens(content);
    const now = new Date().toISOString();
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    const stmt = this.db.prepare(`
      INSERT INTO lcm_messages (session_id, turn_index, role, content, token_count, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(sessionId, turnIndex, role, content, tokenCount, now, metaJson);
    const rowId = Number(result.lastInsertRowid);

    // Keep FTS in sync
    this.db
      .prepare("INSERT INTO lcm_messages_fts (rowid, content) VALUES (?, ?)")
      .run(rowId, content);

    if (parts && parts.length > 0) {
      this.insertMessageParts(rowId, parts, now);
    }

    return rowId;
  }

  /** Append multiple messages in a single transaction. */
  appendMessages(
    sessionId: string,
    messages: Array<{
      turnIndex: number;
      role: string;
      content: string;
      metadata?: Record<string, unknown>;
      parts?: LcmMessagePartInput[];
      rawContent?: unknown;
      sourceFormat?: MessagePartSourceFormat;
    }>,
    options: { messagePartsEnabled?: boolean } = {},
  ): void {
    if (messages.length === 0) return;
    const captureMessageParts = options.messagePartsEnabled !== false;

    const txn = this.db.transaction(() => {
      for (const msg of messages) {
        const explicitParts =
          msg.parts && msg.parts.length > 0 ? msg.parts : undefined;
        const rawContent = msg.rawContent ?? msg.content;
        const parts =
          captureMessageParts
            ? explicitParts ??
              parseMessageParts(rawContent, {
                sourceFormat: msg.sourceFormat,
                renderedContent: msg.content,
              })
            : undefined;
        this.appendMessage(
          sessionId,
          msg.turnIndex,
          msg.role,
          msg.content,
          msg.metadata,
          parts,
        );
      }
    });
    txn();
  }

  insertMessageParts(
    messageId: number,
    parts: LcmMessagePartInput[],
    fallbackCreatedAt: string,
  ): void {
    if (parts.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO lcm_message_parts (message_id, ordinal, kind, payload, tool_name, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const rawPart = part as unknown as Record<string, unknown>;
      const toolName = part.toolName ?? asNullableString(rawPart.tool_name);
      const filePath = part.filePath ?? asNullableString(rawPart.file_path);
      const createdAt = part.createdAt ?? asNullableString(rawPart.created_at);
      stmt.run(
        messageId,
        part.ordinal ?? index,
        part.kind,
        JSON.stringify(part.payload ?? {}),
        toolName ?? null,
        filePath ?? null,
        createdAt ?? fallbackCreatedAt,
      );
    }
  }

  /** Get the highest turn_index for a session, or -1 if none. */
  getMaxTurnIndex(sessionId: string): number {
    const row = this.db
      .prepare("SELECT MAX(turn_index) as max_turn FROM lcm_messages WHERE session_id = ?")
      .get(sessionId) as { max_turn: number | null } | undefined;
    return row?.max_turn ?? -1;
  }

  /** Retrieve messages in a turn range (inclusive). */
  getMessages(sessionId: string, fromTurn: number, toTurn: number): LcmMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM lcm_messages WHERE session_id = ? AND turn_index >= ? AND turn_index <= ? ORDER BY turn_index",
      )
      .all(sessionId, fromTurn, toTurn) as LcmMessage[];
  }

  /** Retrieve unsummarized messages (after last leaf summary). */
  getUnsummarizedMessages(sessionId: string): LcmMessage[] {
    const lastLeafEnd = this.db
      .prepare(
        "SELECT MAX(msg_end) as last_end FROM lcm_summary_nodes WHERE session_id = ? AND depth = 0",
      )
      .get(sessionId) as { last_end: number | null } | undefined;

    const lastSummarized = lastLeafEnd?.last_end ?? -1;
    return this.db
      .prepare(
        "SELECT * FROM lcm_messages WHERE session_id = ? AND turn_index > ? ORDER BY turn_index",
      )
      .all(sessionId, lastSummarized) as LcmMessage[];
  }

  /** Full-text search across all messages. */
  search(query: string, limit: number, sessionId?: string): LcmSearchResult[] {
    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      let sql: string;
      const params: unknown[] = [ftsQuery];

      if (sessionId) {
        sql = `
          SELECT m.turn_index, m.role, snippet(lcm_messages_fts, 0, '>>>', '<<<', '...', 48) as snippet,
                 m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
            AND m.session_id = ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(sessionId, limit);
      } else {
        sql = `
          SELECT m.turn_index, m.role, snippet(lcm_messages_fts, 0, '>>>', '<<<', '...', 48) as snippet,
                 m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        turn_index: number;
        role: string;
        snippet: string;
        session_id: string;
        rank: number;
      }>;

      return rows.map((r) => ({
        turn_index: r.turn_index,
        role: r.role,
        snippet: r.snippet,
        session_id: r.session_id,
        score: -r.rank, // FTS5 rank is negative; negate for ascending score
      }));
    } catch (err) {
      log.debug(`LCM FTS search error: ${err}`);
      return [];
    }
  }

  /**
   * Full-text search returning focused excerpts around matching terms.
   * Returns ~1000-char windows centered on query term matches.
   * Deduplicates by message id and returns results sorted by FTS rank.
   */
  searchWithContent(query: string, limit: number, sessionId?: string, excerptChars = 1000): LcmSearchWithContentResult[] {
    try {
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return [];

      // Extract content words from query for excerpt windowing
      const queryWords = query
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
        .map((w) => w.toLowerCase());

      let sql: string;
      const params: unknown[] = [ftsQuery];

      if (sessionId) {
        sql = `
          SELECT m.id, m.turn_index, m.role, m.content, m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
            AND m.session_id = ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(sessionId, limit);
      } else {
        sql = `
          SELECT m.id, m.turn_index, m.role, m.content, m.session_id, rank
          FROM lcm_messages_fts f
          JOIN lcm_messages m ON m.id = f.rowid
          WHERE lcm_messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `;
        params.push(limit);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        turn_index: number;
        role: string;
        content: string;
        session_id: string;
        rank: number;
      }>;

      // Deduplicate by message id (same message may match multiple terms)
      const seen = new Set<number>();
      const results: LcmSearchWithContentResult[] = [];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        results.push({
          id: r.id,
          turn_index: r.turn_index,
          role: r.role,
          content: extractExcerpt(r.content, queryWords, excerptChars),
          session_id: r.session_id,
          score: -r.rank,
        });
      }
      return results;
    } catch (err) {
      log.debug(`LCM FTS searchWithContent error: ${err}`);
      return [];
    }
  }

  searchStructuredParts(
    query: string,
    limit: number,
    sessionId?: string,
  ): LcmStructuredRecallMatch[] {
    const cappedLimit = Math.max(0, Math.min(20, Math.floor(limit)));
    if (cappedLimit === 0) return [];

    const fileTerms = extractStructuredFileTerms(query);
    const toolTerms = extractStructuredToolTerms(query);
    if (fileTerms.length === 0 && toolTerms.length === 0) return [];

    const matchWhere: string[] = [];
    const whereParams: unknown[] = [];
    for (const term of fileTerms) {
      matchWhere.push("(p.file_path = ? OR p.file_path LIKE ? ESCAPE '\\')");
      whereParams.push(term, `%${escapeLike(term)}%`);
    }
    for (const term of toolTerms) {
      matchWhere.push("p.tool_name LIKE ? ESCAPE '\\'");
      whereParams.push(`%${escapeLike(term)}%`);
    }
    const where = [`(${matchWhere.join(" OR ")})`];
    if (sessionId) {
      where.push("m.session_id = ?");
      whereParams.push(sessionId);
    }
    const exactFileScoreParams = [...fileTerms];
    const sqlParams = [...exactFileScoreParams, ...whereParams, cappedLimit];

    const rows = this.db.prepare(`
      SELECT
        p.id AS part_id,
        p.message_id AS message_id,
        m.turn_index AS turn_index,
        m.role AS role,
        m.content AS content,
        m.session_id AS session_id,
        p.kind AS kind,
        p.tool_name AS tool_name,
        p.file_path AS file_path,
        p.payload AS payload,
        CASE
          WHEN p.file_path IN (${fileTerms.map(() => "?").join(",") || "NULL"}) THEN 3
          WHEN p.file_path IS NOT NULL THEN 2
          WHEN p.tool_name IS NOT NULL THEN 1
          ELSE 0
        END AS score
      FROM lcm_message_parts p
      JOIN lcm_messages m ON m.id = p.message_id
      WHERE ${where.join(" AND ")}
      ORDER BY score DESC, m.turn_index DESC, p.ordinal ASC
      LIMIT ?
    `).all(...sqlParams) as LcmStructuredRecallMatch[];

    return rows;
  }

  /** Get total message count for a session. */
  getMessageCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM lcm_messages WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /** Get total message count across all sessions. */
  getTotalMessageCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM lcm_messages")
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Delete all archived messages for one session. */
  deleteSession(sessionId: string): number {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM lcm_messages_fts WHERE rowid IN (SELECT id FROM lcm_messages WHERE session_id = ?)",
        )
        .run(sessionId);
      this.db
        .prepare(
          "DELETE FROM lcm_message_parts WHERE message_id IN (SELECT id FROM lcm_messages WHERE session_id = ?)",
        )
        .run(sessionId);
      const result = this.db
        .prepare("DELETE FROM lcm_messages WHERE session_id = ?")
        .run(sessionId);
      return result.changes;
    });
    return txn();
  }

  /** Delete all archived messages. */
  deleteAll(): number {
    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM lcm_messages_fts").run();
      this.db.prepare("DELETE FROM lcm_message_parts").run();
      const result = this.db.prepare("DELETE FROM lcm_messages").run();
      return result.changes;
    });
    return txn();
  }

  /** Prune messages older than retentionDays. */
  pruneOldMessages(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();

    // Delete from FTS first
    this.db
      .prepare(
        "DELETE FROM lcm_messages_fts WHERE rowid IN (SELECT id FROM lcm_messages WHERE created_at < ?)",
      )
      .run(cutoff);

    const result = this.db
      .prepare("DELETE FROM lcm_messages WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }
}

/**
 * Extract a focused excerpt from content centered on query term matches.
 * Returns a window of ~excerptChars around the first matching term.
 * If content is shorter than excerptChars, returns the full content.
 */
function extractExcerpt(content: string, queryWords: string[], excerptChars: number): string {
  if (content.length <= excerptChars) return content;

  // Find the earliest position of any query word in the content
  const contentLower = content.toLowerCase();
  let bestPos = -1;
  for (const word of queryWords) {
    const pos = contentLower.indexOf(word);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
    }
  }

  // If no match found (shouldn't happen for FTS results), return start
  if (bestPos === -1) {
    return content.slice(0, excerptChars) + "...";
  }

  // Center the window around the match
  const halfWindow = Math.floor(excerptChars / 2);
  let start = Math.max(0, bestPos - halfWindow);
  let end = Math.min(content.length, start + excerptChars);

  // Adjust start if we hit the end
  if (end === content.length) {
    start = Math.max(0, end - excerptChars);
  }

  // Extend to sentence boundaries if possible
  if (start > 0) {
    const sentenceStart = content.lastIndexOf(". ", start);
    if (sentenceStart !== -1 && start - sentenceStart < 200) {
      start = sentenceStart + 2;
    }
  }
  if (end < content.length) {
    const sentenceEnd = content.indexOf(". ", end - 1);
    if (sentenceEnd !== -1 && sentenceEnd - end < 200) {
      end = sentenceEnd + 1;
    }
  }

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return prefix + content.slice(start, end) + suffix;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "between",
  "through", "during", "before", "after", "and", "but", "or", "nor",
  "not", "so", "if", "then", "than", "that", "this", "it", "its",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "only", "own", "same", "just", "very",
  "my", "your", "his", "her", "our", "their", "me", "him", "us", "them",
  "i", "you", "he", "she", "we", "they",
]);

function extractStructuredFileTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const raw of splitQueryTerms(query)) {
    const cleaned = trimStructuredQueryTerm(raw);
    if (
      cleaned.includes("/") ||
      hasStructuredFileExtension(cleaned)
    ) {
      terms.add(cleaned);
      const basename = cleaned.split("/").pop();
      if (basename && basename !== cleaned) terms.add(basename);
    }
  }
  return [...terms].filter((term) => term.length > 1).slice(0, 12);
}

function splitQueryTerms(query: string): string[] {
  const terms: string[] = [];
  let term = "";
  for (const char of query.slice(0, 20_000)) {
    if (char === " " || char === "\n" || char === "\r" || char === "\t") {
      if (term.length > 0) terms.push(term);
      term = "";
      continue;
    }
    term += char;
    if (term.length > 512) {
      terms.push(term);
      term = "";
    }
  }
  if (term.length > 0) terms.push(term);
  return terms;
}

function trimStructuredQueryTerm(raw: string): string {
  const leading = new Set(["`", "'", "\"", "(", "[", "{"]);
  const trailing = new Set(["`", "'", "\"", ",", ".", "?", "!", ":", ";", ")", "]", "}"]);
  let start = 0;
  let end = raw.length;
  while (start < end && leading.has(raw[start]!)) start += 1;
  while (end > start && trailing.has(raw[end - 1]!)) end -= 1;
  return raw.slice(start, end);
}

function hasStructuredFileExtension(value: string): boolean {
  const slash = value.lastIndexOf("/");
  const basename = value.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  const ext = basename.slice(dot + 1);
  if (ext.length < 1 || ext.length > 12) return false;
  for (const char of ext) {
    const code = char.charCodeAt(0);
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char === "_" ||
      char === "+" ||
      char === "-";
    if (!valid) return false;
  }
  return true;
}

function extractStructuredToolTerms(query: string): string[] {
  const lower = query.toLowerCase();
  if (!/\b(tool|command|invocation|called|used|ran|read|write|patch|edit|grep|search)\b/.test(lower)) {
    return [];
  }
  return query
    .replace(/[^\w.-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term.toLowerCase()))
    .slice(0, 8);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Sanitize a query for FTS5 MATCH.
 * Uses OR logic so partial matches rank higher than no matches.
 * Filters stopwords to focus on content words.
 */
function sanitizeFtsQuery(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) {
    // If all words were stopwords, fall back to using all words
    const allWords = raw.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
    if (allWords.length === 0) return "";
    return allWords.map((w) => `"${w}"`).join(" OR ");
  }
  return words.map((w) => `"${w}"`).join(" OR ");
}
