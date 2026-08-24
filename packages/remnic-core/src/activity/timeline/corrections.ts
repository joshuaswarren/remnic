/**
 * Timeline correction store (issue #2049): manual card/category edits that
 * survive day rebuilds. Corrections are keyed by the card's stable
 * content-derived id, so rebuilding the same evidence reproduces the same
 * card ids and re-applies the edit; an explicit `reset()` reverts a card to
 * its derived values. Corrections are user edits, not evidence — they live in
 * their own small SQLite file, never in the #1899 snapshot store.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { openBetterSqlite3, type BetterSqlite3Database } from "../../runtime/better-sqlite.js";
import { DEFAULT_TIMELINE_CATEGORIES, validateTimelineCategories } from "./categories.js";
import type { TimelineCard, TimelineCategory, TimelineCorrection } from "./types.js";

export function timelineCorrectionDatabasePath(memoryDir: string): string {
  return path.join(memoryDir, "state", "activity-timeline.sqlite");
}

interface CorrectionRow {
  card_id: string;
  category_id: string | null;
  title: string | null;
  edited_at_utc: string;
}

function rowToCorrection(row: CorrectionRow): TimelineCorrection {
  return {
    cardId: row.card_id,
    categoryId: row.category_id ?? undefined,
    title: row.title ?? undefined,
    editedAtUtc: row.edited_at_utc,
  };
}

export class TimelineCorrectionStore {
  private readonly db: BetterSqlite3Database;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  static open(memoryDir: string): TimelineCorrectionStore {
    mkdirSync(path.join(memoryDir, "state"), { recursive: true });
    const db = openBetterSqlite3(timelineCorrectionDatabasePath(memoryDir));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS timeline_corrections (
        card_id       TEXT PRIMARY KEY,
        category_id   TEXT,
        title         TEXT,
        edited_at_utc TEXT NOT NULL
      );
    `);
    return new TimelineCorrectionStore(db);
  }

  /**
   * Persist one correction. `categoryId`, when set, must exist in `categories`
   * (defaults to the built-in registry) — an unknown category is a malformed
   * edit and must fail rather than silently strand the card.
   */
  upsert(correction: TimelineCorrection, categories: readonly TimelineCategory[] = DEFAULT_TIMELINE_CATEGORIES): void {
    validateTimelineCategories(categories);
    if (typeof correction.cardId !== "string" || correction.cardId.length === 0) {
      throw new RangeError("timeline correction requires a non-empty cardId");
    }
    if (typeof correction.editedAtUtc !== "string" || Number.isNaN(Date.parse(correction.editedAtUtc))) {
      throw new RangeError("timeline correction requires a valid editedAtUtc instant");
    }
    if ((correction.categoryId === undefined && correction.title === undefined) || (correction.title !== undefined && correction.title.length === 0)) {
      throw new RangeError("timeline correction must set a categoryId and/or a non-empty title");
    }
    if (correction.categoryId !== undefined && !categories.some((category) => category.id === correction.categoryId)) {
      throw new RangeError(`timeline correction targets unknown category: ${correction.categoryId}`);
    }
    this.db
      .prepare(
        `INSERT INTO timeline_corrections (card_id, category_id, title, edited_at_utc)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET category_id = excluded.category_id, title = excluded.title, edited_at_utc = excluded.edited_at_utc`,
      )
      .run(correction.cardId, correction.categoryId ?? null, correction.title ?? null, correction.editedAtUtc);
  }

  get(cardId: string): TimelineCorrection | undefined {
    const row = this.db.prepare("SELECT card_id, category_id, title, edited_at_utc FROM timeline_corrections WHERE card_id = ?").get(cardId);
    return row === undefined ? undefined : rowToCorrection(row as CorrectionRow);
  }

  /** All corrections ordered by card id (deterministic listing). */
  list(): TimelineCorrection[] {
    return this.db
      .prepare("SELECT card_id, category_id, title, edited_at_utc FROM timeline_corrections ORDER BY card_id ASC")
      .all()
      .map((row) => rowToCorrection(row as CorrectionRow));
  }

  /** Explicitly reset a card to its derived values; true when a correction existed. */
  reset(cardId: string): boolean {
    return this.db.prepare("DELETE FROM timeline_corrections WHERE card_id = ?").run(cardId).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/** Corrections whose cardId is in `cards`, in incoming list order. */
export function correctionsForCards(
  cards: readonly TimelineCard[],
  corrections: readonly TimelineCorrection[],
): TimelineCorrection[] {
  const ids = new Set(cards.map((card) => card.id));
  return corrections.filter((correction) => ids.has(correction.cardId));
}

/**
 * Apply corrections to built cards. Overrides title/category, sets confidence
 * to 1 (a human confirmed it), and stamps manual-edit provenance. Uncorrected
 * cards pass through untouched, so serialization stays byte-stable for them.
 */
export function applyTimelineCorrections(
  cards: readonly TimelineCard[],
  corrections: readonly TimelineCorrection[],
): TimelineCard[] {
  const byCardId = new Map(corrections.map((correction) => [correction.cardId, correction]));
  return cards.map((card) => {
    const correction = byCardId.get(card.id);
    if (correction === undefined) return card;
    return {
      id: card.id,
      kind: card.kind,
      title: correction.title ?? card.title,
      summary: card.summary,
      categoryId: correction.categoryId ?? card.categoryId,
      confidence: 1,
      startUtc: card.startUtc,
      endUtc: card.endUtc,
      dayKey: card.dayKey,
      timezone: card.timezone,
      machine: card.machine,
      evidenceIds: card.evidenceIds,
      evidenceRange: card.evidenceRange,
      manualEdit: {
        ...(correction.categoryId !== undefined ? { categoryId: correction.categoryId } : {}),
        ...(correction.title !== undefined ? { title: correction.title } : {}),
        editedAtUtc: correction.editedAtUtc,
      },
    };
  });
}
