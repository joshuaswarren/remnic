import { promises as fsp } from "node:fs";
import path from "node:path";
import { coerceBooleanLike, coerceNumber } from "./connectors/coerce.js";
import { log } from "./logger.js";

export const DEFAULT_RECALL_RECOGNITION_TIER = false;
export const DEFAULT_RECOGNITION_INDEX_MAX_ENTRIES = 500;
export const RECOGNITION_INDEX_VERSION = 1;
const RECOGNITION_INDEX_FILE = "index_recognition.json";

export const RECOGNITION_PROMPT_HEADER =
  "Memory index — one line per memory. Name the ids that bear on the question.";
export const RECOGNITION_PROMPT_FOOTER =
  "Answer with the relevant ids only, comma-separated. If none bear on the question, answer with nothing.";

export interface RecognitionIndexEntry {
  /** Stable memory id. Candidates always come back in index order. */
  id: string;
  /** One-line recognition trigger; not a summary (issue #2975 swap test). */
  description: string;
}

export interface RecognitionIndex {
  version: number;
  entries: RecognitionIndexEntry[];
}

export interface RecognitionTierSettings {
  /** Small namespaces recall by recognizing against the whole compact index instead of vector search; parsed now, wiring lands in a later slice. Default false. */
  recallRecognitionTier: boolean;
  /** Max entries a namespace's recognition index may carry for the tier to engage (inclusive). Default 500. */
  recognitionIndexMaxEntries: number;
}

export function parseRecallRecognitionTier(raw: unknown): boolean {
  return coerceBooleanLike(raw, "recallRecognitionTier") === true;
}

export function parseRecognitionIndexMaxEntries(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_RECOGNITION_INDEX_MAX_ENTRIES;
  const n = coerceNumber(raw, "recognitionIndexMaxEntries");
  if (n === undefined || !Number.isFinite(n) || n < 1) {
    throw new Error(
      `Invalid recognitionIndexMaxEntries: expected an integer >= 1, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.floor(n);
}

export function recognitionIndexPath(memoryDir: string): string {
  return path.join(memoryDir, "state", RECOGNITION_INDEX_FILE);
}

/**
 * Normalize raw records into a recognition index: blank/whitespace ids
 * are dropped, descriptions are trimmed, and the first record for an id
 * wins. Input order is preserved — it is the recognition order.
 */
export function buildRecognitionIndex(
  records: ReadonlyArray<{ id?: string | null; description?: string | null }>,
): RecognitionIndex {
  const seen = new Set<string>();
  const out: RecognitionIndexEntry[] = [];
  for (const record of records) {
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      description: typeof record.description === "string" ? record.description.trim() : "",
    });
  }
  return { version: RECOGNITION_INDEX_VERSION, entries: out };
}

/**
 * Persist a recognition index. Single-writer: the maintenance slice that
 * owns index writes must serialize calls the way temporal-index does.
 */
export async function saveRecognitionIndex(
  memoryDir: string,
  index: RecognitionIndex,
): Promise<void> {
  const file = recognitionIndexPath(memoryDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function isRecognitionIndex(raw: unknown): raw is RecognitionIndex {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as { version?: unknown; entries?: unknown };
  if (candidate.version !== RECOGNITION_INDEX_VERSION) return false;
  if (!Array.isArray(candidate.entries)) return false;
  return candidate.entries.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RecognitionIndexEntry).id === "string" &&
      typeof (entry as RecognitionIndexEntry).description === "string",
  );
}

/**
 * Load a namespace's recognition index. Total: a missing, corrupt,
 * wrong-shape, or future-version file all return `null` so the caller
 * falls back to vector search without an error.
 */
export async function loadRecognitionIndex(memoryDir: string): Promise<RecognitionIndex | null> {
  try {
    const raw = await fsp.readFile(recognitionIndexPath(memoryDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecognitionIndex(parsed)) return parsed;
    log.warn(
      `recognition index ignored at ${RECOGNITION_INDEX_FILE}: unexpected shape; falling back to vector search`,
    );
    return null;
  } catch {
    return null;
  }
}

export type RecognitionRecallTier = "recognition" | "vector";
export type RecognitionTierReason =
  | "index_absent"
  | "index_above_threshold"
  | "index_within_threshold";

export interface RecognitionTierDecision {
  tier: RecognitionRecallTier;
  reason: RecognitionTierReason;
  /** Entries the decision considered; 0 when the index is absent. */
  entriesConsidered: number;
  maxEntries: number;
}

/**
 * Deterministic tier choice, pure on (index, maxEntries). The threshold
 * is inclusive: an index of exactly maxEntries entries still recognizes
 * (a threshold-sized index is the designed working set, not an overrun).
 */
export function decideRecognitionTier(
  index: RecognitionIndex | null,
  opts: { maxEntries: number },
): RecognitionTierDecision {
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries));
  if (index === null) {
    return { tier: "vector", reason: "index_absent", entriesConsidered: 0, maxEntries };
  }
  if (index.entries.length > maxEntries) {
    return {
      tier: "vector",
      reason: "index_above_threshold",
      entriesConsidered: index.entries.length,
      maxEntries,
    };
  }
  return {
    tier: "recognition",
    reason: "index_within_threshold",
    entriesConsidered: index.entries.length,
    maxEntries,
  };
}

/** Render the full index, one line per entry, in index order. */
export function renderRecognitionIndex(entries: ReadonlyArray<RecognitionIndexEntry>): string {
  return entries.map((entry) => `${entry.id}: ${entry.description}`).join("\n");
}

/** The single recognition prompt: header, the FULL index, the question, the answer shape. */
export function buildRecognitionPrompt(
  query: string,
  entries: ReadonlyArray<RecognitionIndexEntry>,
): string {
  return [
    RECOGNITION_PROMPT_HEADER,
    renderRecognitionIndex(entries),
    `Question: ${query}`,
    RECOGNITION_PROMPT_FOOTER,
  ].join("\n\n");
}

function dedupeOrdered(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

const TRAILING_PUNCTUATION: Record<string, true> = { ".": true, ",": true, ";": true, ":": true };

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION[value.charAt(end - 1)]) end -= 1;
  return value.slice(0, end);
}

/**
 * Parse recognizer output into ordered unique id tokens. Accepts a JSON
 * string array or comma/whitespace-separated ids, and strips sentence
 * punctuation so prose wrappers do not corrupt ids. Tokens that are not
 * real ids are dropped later by validation against the index.
 */
export function parseRecognizerIds(output: string | null | undefined): string[] {
  if (typeof output !== "string") return [];
  const text = output.trim();
  if (text.length === 0) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return dedupeOrdered(
          parsed
            .filter((item): item is string => typeof item === "string")
            .map((item) => stripTrailingPunctuation(item.trim()).trim()),
        );
      }
    } catch {
      // Fall through to separator parsing.
    }
  }
  return dedupeOrdered(
    text
      .split(/[\s,]+/)
      .map((token) => stripTrailingPunctuation(token.replace(/^[•\-*\d.)\]]+/, "")).trim()),
  );
}

/** One model call over the full index; supplied by the wiring slice. */
export type Recognizer = (prompt: string) => Promise<string | null | undefined>;

export interface RecognitionRunResult {
  /** Recognized ids, validated against the index, in index order. */
  ids: string[];
  /** Recognizer tokens the index does not carry (hallucinated ids). */
  dropped: string[];
  /** True when no model call was made (empty index). */
  skipped: boolean;
}

/**
 * Run the recognition pass: the FULL index goes into one prompt, the
 * recognizer names ids, unknown ids are dropped, and the kept ids come
 * back in index order so downstream merging stays deterministic.
 */
export async function runRecognitionTier(
  query: string,
  entries: ReadonlyArray<RecognitionIndexEntry>,
  recognize: Recognizer,
): Promise<RecognitionRunResult> {
  if (entries.length === 0) {
    return { ids: [], dropped: [], skipped: true };
  }
  const raw = parseRecognizerIds(await recognize(buildRecognitionPrompt(query, entries)));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const picked = new Set(raw.filter((token) => byId.has(token)));
  return {
    ids: entries.filter((entry) => picked.has(entry.id)).map((entry) => entry.id),
    dropped: dedupeOrdered(raw.filter((token) => !byId.has(token))),
    skipped: false,
  };
}

export interface RecognitionTierOutcome<TVector> {
  decision: RecognitionTierDecision;
  /** Recognition picks, index order; empty on the vector tier. */
  ids: string[];
  /** Vector-tier results from the fallback; empty on the recognition tier. */
  vectorResults: TVector[];
  /**
   * Set when recognition was routed but the recognizer failed and the
   * vector tier served the recall instead — loud degradation.
   */
  degraded?: "recognizer_unavailable";
}

/**
 * The wiring-seam composition for one namespace: load the index, decide
 * the tier, then either recognize against the full index or run the
 * caller's vector search. Never throws for index problems; a failing
 * recognizer degrades to vector search labeled `recognizer_unavailable`.
 */
export async function recallViaRecognitionTier<TVector>(args: {
  memoryDir: string;
  query: string;
  maxEntries: number;
  recognize: Recognizer;
  vectorSearch: () => Promise<TVector[]>;
}): Promise<RecognitionTierOutcome<TVector>> {
  const index = await loadRecognitionIndex(args.memoryDir);
  const decision = decideRecognitionTier(index, { maxEntries: args.maxEntries });
  if (index === null || decision.tier === "vector") {
    return { decision, ids: [], vectorResults: await args.vectorSearch() };
  }
  try {
    const run = await runRecognitionTier(args.query, index.entries, args.recognize);
    return { decision, ids: run.ids, vectorResults: [] };
  } catch (err) {
    log.warn(
      `recognition tier degraded to vector search: recognizer failed${
        err instanceof Error ? ` (${err.message})` : ""
      }`,
    );
    return {
      decision,
      ids: [],
      vectorResults: await args.vectorSearch(),
      degraded: "recognizer_unavailable",
    };
  }
}
