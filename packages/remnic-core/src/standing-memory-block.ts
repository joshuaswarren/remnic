/**
 * Prefix-cache-stable standing memory block (issue #2971, foundation slice).
 *
 * A standing block is a compact, byte-stable index over pinned/high-value
 * memories that a host injects as the FIRST part of the system prompt, so
 * the LLM prefix cache survives across turns. Measured motivation
 * (distill-kura, local OpenAI-compatible server): an identical 4k-token
 * prefix reprices at 0.14 s vs 0.68 s cold, and one changed word at the
 * front costs the whole cache. So the block contains no clock, no date,
 * and no counter — and the builder REFUSES, at build time, any block that
 * carries one instead of discovering slow turns weeks later.
 *
 * Determinism rules (byte-identical between rebuilds):
 *  - line order is band rank, then id codepoint order — never wall clock,
 *    never insertion order, never locale collation;
 *  - `nowMs` classifies bands but never renders into the text;
 *  - the trimmed-tail marker is a constant string (no count of dropped
 *    lines, which would itself be a counter).
 *
 * Host contract for the full feature (later wiring slices):
 *  - rebuild only when the underlying store changes (store version), not
 *    per turn and not on a timer — band edges must not drift mid-session;
 *  - inject the standing block BEFORE per-turn dynamic recall and any
 *    ticking content (persona with a clock), see docs/config-reference.md;
 *  - selection of which memories qualify (pinned/high-value) happens
 *    before this builder — it only layers and renders what it is given;
 *  - on build failure (volatility, budget) skip injection and log — the
 *    dynamic recall surface must not go blank.
 *
 * Pure: no I/O, inputs never mutated, the returned ledger is a fresh Map.
 */
import { coerceBooleanLike, coerceNumber } from "./connectors/coerce.js";

export const DEFAULT_RECALL_STANDING_BLOCK = false;
export const DEFAULT_STANDING_BLOCK_FRESH_DAYS = 14;
export const DEFAULT_STANDING_BLOCK_MAX_CHARS = 2048;
/** ~24-token recognition hook at the repo's 4-chars-per-token Latin headroom. */
export const DEFAULT_STANDING_BLOCK_HOOK_CHARS = 96;

export const STANDING_BLOCK_HEADER = "## Standing Memory (Remnic)";
export const STANDING_BLOCK_INSTRUCTION =
  "Use this standing index for orientation. It changes only when the memory store changes.";
export const STANDING_BLOCK_TRIMMED_MARKER = "- ...(older lines trimmed)";

export type StandingBand = "pinned" | "fresh" | "compressed";

export interface StandingMemoryEntry {
  /** Stable document id. Total order within a band is id codepoint order. */
  id: string;
  /** The one-line description to stand in the index. */
  description: string;
  /** Pinned entries render in full, first band, never trimmed away. */
  pinned?: boolean;
  /** ISO timestamp of the last content change; drives the fresh band. */
  lastChangedAt?: string;
}

/** Cache of compressed hooks keyed on `${description}\u0000${hookMaxChars}`. */
export type StandingHookLedger = ReadonlyMap<string, string>;

export function standingHookLedgerKey(description: string, hookMaxChars: number): string {
  return `${description}\u0000${hookMaxChars}`;
}

export interface StandingBlockBandCounts {
  pinned: number;
  fresh: number;
  compressed: number;
  dropped: number;
}

export interface StandingMemoryBlock {
  /** Full block text (header + lines + instruction). Empty string for no entries. */
  text: string;
  /** Lines without a trailing newline; empty for no entries. */
  lines: string[];
  /** Ledger including hooks generated this build. Fresh Map; input never mutated. */
  ledger: StandingHookLedger;
  bandCounts: StandingBlockBandCounts;
}

export type StandingVolatilityKind = "iso-date" | "clock-time" | "relative-date" | "counter";

export interface StandingVolatilityMatch {
  kind: StandingVolatilityKind;
  token: string;
}

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const RELATIVE_DATE_RE =
  /\b(?:today|tonight|tomorrow|yesterday|this\s+(?:morning|afternoon|evening|week|month|year))\b/i;
const COUNTER_RE = /\b(?:count|total|entries|memories|items)\s*[:=]\s*\d+\b/i;

/**
 * Build-time volatility lint. Returns every cache-busting token class found:
 * ISO dates/datetimes, clock times, relative date words, and index counters.
 * Refusal is the designed behavior (a memory surface skips the block and
 * logs) — a silently repricing prefix is the failure this catches.
 */
export function lintStandingBlockVolatility(text: string): StandingVolatilityMatch[] {
  const matches: StandingVolatilityMatch[] = [];
  for (const [kind, re] of [
    ["iso-date", ISO_DATE_RE],
    ["clock-time", CLOCK_TIME_RE],
    ["relative-date", RELATIVE_DATE_RE],
    ["counter", COUNTER_RE],
  ] as const) {
    const hit = text.match(re);
    if (hit) matches.push({ kind, token: hit[0] });
  }
  return matches;
}

export class StandingBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandingBlockError";
  }
}

export class StandingBlockVolatilityError extends StandingBlockError {
  readonly matches: readonly StandingVolatilityMatch[];
  constructor(matches: readonly StandingVolatilityMatch[]) {
    super(
      `standing memory block refused: volatile content busts the prefix cache (${matches
        .map((m) => `${m.kind}:${JSON.stringify(m.token)}`)
        .join(", ")})`,
    );
    this.name = "StandingBlockVolatilityError";
    this.matches = matches;
  }
}

export class StandingBlockBudgetError extends StandingBlockError {
  constructor(maxChars: number) {
    super(
      `standing memory block does not fit: pinned lines alone exceed maxChars=${maxChars}; raise standingBlockMaxChars or unpin entries`,
    );
    this.name = "StandingBlockBudgetError";
  }
}

export function parseRecallStandingBlock(raw: unknown): boolean {
  return coerceBooleanLike(raw, "recallStandingBlock") === true;
}

export function parseStandingBlockFreshDays(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_STANDING_BLOCK_FRESH_DAYS;
  const n = coerceNumber(raw, "standingBlockFreshDays");
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid standingBlockFreshDays: expected a number >= 0, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseStandingBlockMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_STANDING_BLOCK_MAX_CHARS;
  const n = coerceNumber(raw, "standingBlockMaxChars");
  if (n === undefined || !Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid standingBlockMaxChars: expected an integer >= 1, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(n);
}

/**
 * Mechanical hook: deterministic first-cut of the description to the char
 * budget at a word boundary. This is also the fallback when no model is
 * reachable for compression — the standing surface never goes blank because
 * a model is down. Model-generated hooks arrive pre-seeded in the ledger.
 */
function mechanicalHook(description: string, budget: number): string {
  if (description.length <= budget) return description;
  const cut = description.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > Math.floor(budget * 0.6) ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:]+$/, "")}...`;
}

interface LayeredEntry {
  id: string;
  band: StandingBand;
  line: string;
}

const BAND_RANK: Record<StandingBand, number> = { pinned: 0, fresh: 1, compressed: 2 };

function validateEntries(entries: readonly StandingMemoryEntry[]): Map<string, StandingMemoryEntry> {
  if (!Array.isArray(entries)) {
    throw new StandingBlockError("standing memory block entries must be an array");
  }
  const seen = new Set<string>();
  const validated = new Map<string, StandingMemoryEntry>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new StandingBlockError(`standing memory block entry must be an object, got ${JSON.stringify(entry)}`);
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (id.length === 0) {
      throw new StandingBlockError("standing memory block entry requires a non-empty id");
    }
    if (description.length === 0) {
      throw new StandingBlockError(`standing memory block entry ${id} requires a non-empty description`);
    }
    if (seen.has(id)) {
      throw new StandingBlockError(`standing memory block entry ids must be unique; duplicate: ${id}`);
    }
    if (entry.lastChangedAt !== undefined && Number.isNaN(Date.parse(entry.lastChangedAt))) {
      throw new StandingBlockError(
        `standing memory block entry ${id} has an unparseable lastChangedAt: ${JSON.stringify(entry.lastChangedAt)}`,
      );
    }
    seen.add(id);
    validated.set(id, { ...entry, id, description });
  }
  return validated;
}

export interface StandingMemoryBlockInput {
  entries: readonly StandingMemoryEntry[];
  /**
   * Evaluation instant for the fresh band. Hosts must key rebuilds on the
   * store version, not on this clock, or band edges drift per turn.
   */
  nowMs: number;
  freshDays?: number;
  maxChars?: number;
  hookMaxChars?: number;
  ledger?: StandingHookLedger;
}

export function buildStandingMemoryBlock(input: StandingMemoryBlockInput): StandingMemoryBlock {
  const freshDays = input.freshDays ?? DEFAULT_STANDING_BLOCK_FRESH_DAYS;
  const maxChars = input.maxChars ?? DEFAULT_STANDING_BLOCK_MAX_CHARS;
  const hookMaxChars = input.hookMaxChars ?? DEFAULT_STANDING_BLOCK_HOOK_CHARS;
  if (!Number.isFinite(input.nowMs)) {
    throw new StandingBlockError("standing memory block requires a finite nowMs");
  }
  if (!(freshDays >= 0) || !Number.isFinite(freshDays)) {
    throw new StandingBlockError("standing memory block requires freshDays >= 0");
  }
  if (!(maxChars >= 1) || !Number.isFinite(maxChars)) {
    throw new StandingBlockError("standing memory block requires maxChars >= 1");
  }
  if (!(hookMaxChars >= 1) || !Number.isFinite(hookMaxChars)) {
    throw new StandingBlockError("standing memory block requires hookMaxChars >= 1");
  }

  const entries = validateEntries(input.entries);
  const ledger = new Map(input.ledger ?? []);
  if (entries.size === 0) {
    return {
      text: "",
      lines: [],
      ledger,
      bandCounts: { pinned: 0, fresh: 0, compressed: 0, dropped: 0 },
    };
  }

  const freshCutoff = input.nowMs - freshDays * 86_400_000;
  const layered: LayeredEntry[] = [];
  for (const entry of entries.values()) {
    let band: StandingBand;
    if (entry.pinned === true) {
      band = "pinned";
    } else if (
      typeof entry.lastChangedAt === "string" &&
      Date.parse(entry.lastChangedAt) >= freshCutoff &&
      Date.parse(entry.lastChangedAt) <= input.nowMs
    ) {
      band = "fresh";
    } else {
      band = "compressed";
    }
    if (band !== "compressed") {
      layered.push({ id: entry.id, band, line: `- ${entry.description}` });
      continue;
    }
    const key = standingHookLedgerKey(entry.description, hookMaxChars);
    const cached = ledger.get(key);
    const hook = cached ?? mechanicalHook(entry.description, hookMaxChars);
    if (cached === undefined) ledger.set(key, hook);
    layered.push({ id: entry.id, band, line: `- ${hook}` });
  }

  // Band rank, then id codepoint order. Never localeCompare: collation is
  // ICU-dependent and this text must be byte-identical across rebuilds.
  layered.sort(
    (a, b) =>
      BAND_RANK[a.band] - BAND_RANK[b.band] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const render = (keep: number, withMarker: boolean): { text: string; lines: string[] } => {
    const body = layered.slice(0, keep).map((item) => item.line);
    if (withMarker) body.push(STANDING_BLOCK_TRIMMED_MARKER);
    const lines = [STANDING_BLOCK_HEADER, "", ...body, "", STANDING_BLOCK_INSTRUCTION];
    return { text: lines.join("\n"), lines };
  };

  const pinnedCount = layered.filter((item) => item.band === "pinned").length;
  let keep = layered.length;
  let rendered = render(keep, false);
  // Mechanical trim: drop from the tail. The sort puts compressed lines
  // last, so oldest-band hooks go first and pinned lines are never reached.
  while (rendered.text.length > maxChars && keep > pinnedCount) {
    keep -= 1;
    rendered = render(keep, true);
  }
  if (rendered.text.length > maxChars) {
    throw new StandingBlockBudgetError(maxChars);
  }

  const volatility = lintStandingBlockVolatility(rendered.text);
  if (volatility.length > 0) {
    throw new StandingBlockVolatilityError(volatility);
  }

  const kept = layered.slice(0, keep);
  return {
    text: rendered.text,
    lines: rendered.lines,
    ledger,
    bandCounts: {
      pinned: kept.filter((item) => item.band === "pinned").length,
      fresh: kept.filter((item) => item.band === "fresh").length,
      compressed: kept.filter((item) => item.band === "compressed").length,
      dropped: layered.length - keep,
    },
  };
}
