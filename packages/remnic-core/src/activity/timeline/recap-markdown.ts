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

export function renderRecapMarkdown(options: RecapMarkdownOptions): string {
  const cards = [...options.cards].sort(compareCardIds);
  const body = cards.length === 0 ? ["(empty)"] : cards.map((card) => `- ${card.id}`);
  return [`# Recap — ${options.date} (${options.timezone})`, "", ...body, ""].join("\n");
}
