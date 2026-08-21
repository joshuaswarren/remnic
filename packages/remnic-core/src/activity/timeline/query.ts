/**
 * Timeline range/search query (issue #1983 PR1).
 *
 * Pure functions over an in-memory card list. Half-open UTC [from, to).
 * A zero-length range is an instant: include the card whose [start, end)
 * contains it. Search returns distinct empty vs store_unreadable shapes.
 *
 * Config: activity.timeline.qa.{enabled, maxRangeDays}.
 * MCP/HTTP and recall injection are later PRs.
 */
import { parseFlexibleIsoTimestamp } from "../../utils/iso-timestamp.js";
import type { PluginConfig } from "../../types.js";
import type { ActivityTimelineQaConfig } from "../types.js";
import { runTimelinePublishCli } from "./publish-cli.js";
import type { TimelineCard } from "./types.js";

const RANGE_FORMATS = ["cards", "compact"] as const;
const MS_PER_DAY = 86_400_000;
const DEFAULT_MAX_RANGE_DAYS = 31;
const DEFAULT_SEARCH_LIMIT = 10;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 50;

export type TimelineRangeFormat = (typeof RANGE_FORMATS)[number];

/** Card fields the query layer reads; later slices may add optional extras. */
export type TimelineQueryCard = TimelineCard & {
  detailedSummary?: string;
  distraction?: boolean;
};

export interface TimelineRangeQuery {
  from: string;
  to: string;
  categories?: readonly string[];
  includeDistractions?: boolean;
  format: TimelineRangeFormat;
  maxRangeDays?: number;
}

export interface TimelineCompactCard {
  start: string;
  end: string;
  category: string;
  title: string;
  summary: string;
}

export interface TimelineCompactRange {
  day: string;
  cards: TimelineCompactCard[];
}

export interface TimelineSearchQuery {
  query: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type TimelineSearchResult =
  | { ok: true; results: TimelineQueryCard[] }
  | { ok: false; error: "store_unreadable" };

export interface TimelineCliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

/** Inject cards so CLI tests never need ActivityStore. */
export interface TimelineCliDeps {
  cards: readonly TimelineQueryCard[] | null;
  qa: ActivityTimelineQaConfig;
  timelineEnabled?: boolean;
  /** Required for `publish`; range/search never read it. */
  config?: PluginConfig;
}

const USAGE = `Usage: timeline <command> [options]

Commands:
  range --from <ISO> --to <ISO> [--format cards|compact] [--categories id,id] [--include-distractions]
  search --query <text> [--from <ISO>] [--to <ISO>] [--limit N]
  publish [--date YYYY-MM-DD] [--what timeline] [--dry-run]
`;

const VALUE_FLAGS: Record<string, true> = {
  "--from": true,
  "--to": true,
  "--format": true,
  "--categories": true,
  "--query": true,
  "--limit": true,
  "--date": true,
  "--week": true,
  "--what": true,
};
const BOOLEAN_FLAGS: Record<string, true> = { "--include-distractions": true, "--dry-run": true };

function parseInstant(value: string, label: string): number {
  const ms = parseFlexibleIsoTimestamp(value);
  if (ms === null) {
    throw new TypeError(`${label} must be an ISO date or datetime`);
  }
  return ms;
}

function assertRange(fromMs: number, toMs: number, maxRangeDays: number): void {
  if (fromMs > toMs) {
    throw new RangeError("reversed range: from must be <= to");
  }
  if (fromMs === toMs) return;
  if (toMs - fromMs > maxRangeDays * MS_PER_DAY) {
    throw new RangeError(`range exceeds timeline.qa.maxRangeDays (${maxRangeDays})`);
  }
}

function cardOverlaps(card: TimelineQueryCard, fromMs: number, toMs: number): boolean {
  const start = Date.parse(card.startUtc);
  const end = Date.parse(card.endUtc);
  if (fromMs === toMs) return start <= fromMs && fromMs < end;
  return start < toMs && end > fromMs;
}

function passesFilters(
  card: TimelineQueryCard,
  categories: ReadonlySet<string> | undefined,
  includeDistractions: boolean,
): boolean {
  if (!includeDistractions && card.distraction === true) return false;
  if (categories && !categories.has(card.categoryId)) return false;
  return true;
}

function filterRange(
  cards: readonly TimelineQueryCard[],
  fromMs: number,
  toMs: number,
  categories: ReadonlySet<string> | undefined,
  includeDistractions: boolean,
): TimelineQueryCard[] {
  return cards.filter(
    (card) => cardOverlaps(card, fromMs, toMs) && passesFilters(card, categories, includeDistractions),
  );
}

function toCompact(cards: readonly TimelineQueryCard[], from: string): TimelineCompactRange {
  const day = from.length >= 10 ? from.slice(0, 10) : cards[0]?.dayKey ?? from;
  return {
    day,
    cards: cards.map((card) => ({
      start: card.startUtc,
      end: card.endUtc,
      category: card.categoryId,
      title: card.title,
      summary: card.summary,
    })),
  };
}

export function queryTimelineRange(
  cards: readonly TimelineQueryCard[],
  query: TimelineRangeQuery,
): TimelineCard[] | TimelineCompactRange {
  if (!RANGE_FORMATS.includes(query.format)) {
    throw new TypeError(`format must be one of: ${RANGE_FORMATS.join(", ")}`);
  }
  const maxRangeDays = query.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS;
  const fromMs = parseInstant(query.from, "from");
  const toMs = parseInstant(query.to, "to");
  assertRange(fromMs, toMs, maxRangeDays);
  const categories = query.categories ? new Set(query.categories) : undefined;
  const matched = filterRange(cards, fromMs, toMs, categories, query.includeDistractions === true);
  if (query.format === "compact") return toCompact(matched, query.from);
  return matched;
}

function haystack(card: TimelineQueryCard): string {
  const parts = [card.title, card.summary];
  if (card.detailedSummary) parts.push(card.detailedSummary);
  return parts.join(" ").toLowerCase();
}

function tokenMatchCount(card: TimelineQueryCard, tokens: readonly string[]): number {
  const text = haystack(card);
  let count = 0;
  for (const token of tokens) {
    if (text.includes(token)) count += 1;
  }
  return count;
}

export function queryTimelineSearch(
  cards: readonly TimelineQueryCard[] | null | undefined,
  query: TimelineSearchQuery,
): TimelineSearchResult {
  if (!Array.isArray(cards)) return { ok: false, error: "store_unreadable" };
  const tokens = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_SEARCH_LIMIT || limit > MAX_SEARCH_LIMIT) {
    throw new RangeError(`limit must be an integer from ${MIN_SEARCH_LIMIT} to ${MAX_SEARCH_LIMIT}`);
  }
  let pool = cards;
  if (query.from !== undefined || query.to !== undefined) {
    const fromMs = parseInstant(query.from ?? query.to!, "from");
    const toMs = parseInstant(query.to ?? query.from!, "to");
    assertRange(fromMs, toMs, DEFAULT_MAX_RANGE_DAYS);
    pool = filterRange(cards, fromMs, toMs, undefined, true);
  }
  if (tokens.length === 0) return { ok: true, results: [] };
  const ranked = pool
    .map((card) => ({ card, matches: tokenMatchCount(card, tokens) }))
    .filter((row) => row.matches > 0)
    .sort((a, b) => {
      if (a.matches !== b.matches) return b.matches - a.matches;
      const recency = Date.parse(b.card.endUtc) - Date.parse(a.card.endUtc);
      if (recency !== 0) return recency;
      return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
    })
    .slice(0, limit)
    .map((row) => row.card);
  return { ok: true, results: ranked };
}

function parseFlags(args: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS[arg] === true) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TypeError(`flag ${arg} requires a value`);
      }
      flags.set(arg, value);
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS[arg] === true) {
      flags.set(arg, true);
      continue;
    }
    const known = [...Object.keys(VALUE_FLAGS), ...Object.keys(BOOLEAN_FLAGS)].sort().join(", ");
    throw new TypeError(`unknown flag ${arg} (valid: ${known})`);
  }
  return { flags, positional };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Shared CLI runner. `deps.cards` may be an in-memory fixture. */
export async function runTimelineCliCommand(
  deps: TimelineCliDeps,
  args: string[],
  io: TimelineCliIo,
): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === "help" || command === "--help") {
      io.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    }
    // `publish` writes into the user's vault and is not a qa/query surface,
    // so it dispatches before the qa gate. Its own flags are parsed here to
    // keep range/search error precedence unchanged.
    if (command === "publish") {
      if (deps.config === undefined) {
        io.stderr.write("timeline publish requires the Remnic config — run `remnic doctor`\n");
        return 1;
      }
      const publishFlags = parseFlags(rest).flags;
      return runTimelinePublishCli(
        deps.config,
        {
          date: flagString(publishFlags, "--date"),
          week: flagString(publishFlags, "--week"),
          what: flagString(publishFlags, "--what"),
          dryRun: publishFlags.get("--dry-run") === true,
        },
        io,
      );
    }
    if (deps.timelineEnabled === false || !deps.qa.enabled) {
      io.stderr.write("timeline qa disabled — set activity.timeline.qa.enabled=true\n");
      return 1;
    }
    const { flags } = parseFlags(rest);
    if (command === "range") {
      const from = flagString(flags, "--from");
      const to = flagString(flags, "--to");
      if (!from || !to) throw new TypeError("range requires --from and --to");
      if (!Array.isArray(deps.cards)) {
        io.stderr.write("store_unreadable\n");
        return 1;
      }
      const formatRaw = flagString(flags, "--format") ?? "compact";
      if (formatRaw !== "cards" && formatRaw !== "compact") {
        throw new TypeError("format must be one of: cards, compact");
      }
      const categoriesRaw = flagString(flags, "--categories");
      const result = queryTimelineRange(deps.cards, {
        from,
        to,
        format: formatRaw,
        categories: categoriesRaw ? categoriesRaw.split(",").filter(Boolean) : undefined,
        includeDistractions: flags.get("--include-distractions") === true,
        maxRangeDays: deps.qa.maxRangeDays,
      });
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (command === "search") {
      const q = flagString(flags, "--query");
      if (q === undefined) throw new TypeError("search requires --query");
      const limitRaw = flagString(flags, "--limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limitRaw !== undefined && !Number.isInteger(limit)) {
        throw new RangeError("limit must be an integer from 1 to 50");
      }
      const result = queryTimelineSearch(deps.cards, {
        query: q,
        from: flagString(flags, "--from"),
        to: flagString(flags, "--to"),
        limit,
      });
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 1;
    }
    throw new TypeError(`unknown command ${command} (valid: range, search, publish)`);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
