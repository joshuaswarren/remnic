/**
 * Deterministic Markdown recap from timeline cards (issue #2051 leftover).
 *
 * Pure: date + timezone + cards in, Markdown out. No LLM, no I/O, no
 * persistence. Cards are sorted by id. Empty cards print (empty).
 */
import type { TimelineCard } from "./types.js";

export interface RecapMarkdownOptions {
  date: string;
  timezone: string;
  cards: readonly TimelineCard[];
}

function compareCardIds(a: TimelineCard, b: TimelineCard): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Render a byte-stable Markdown recap for one local day. */
export function renderRecapMarkdown(options: RecapMarkdownOptions): string {
  const cards = [...options.cards].sort(compareCardIds);
  const body = cards.length === 0 ? ["(empty)"] : cards.map((card) => `- ${card.id}`);
  return [`# Recap — ${options.date} (${options.timezone})`, "", ...body, ""].join("\n");
}
