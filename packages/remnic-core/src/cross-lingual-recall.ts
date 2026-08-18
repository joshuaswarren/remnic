/**
 * Cross-lingual recall planner (issue #2197).
 *
 * Lexical tiers (BM25/FTS) match on shared surface tokens, so a query whose
 * dominant script differs from the corpus's cannot retrieve lexically — an
 * English query never token-overlaps a Japanese fact. When the planner
 * detects that mismatch it leans on the vector tier (the embedding-fallback
 * supplement in the recall search pipeline), and when NO vector tier exists
 * it emits a {@link SearchDegradation} so "no results" stays distinguishable
 * from "cross-script query, vectors unavailable" (rule 34).
 *
 * The write-time half is a dominant-script hint stamped into frontmatter
 * `language` by `StorageManager.writeMemory` (ISO 15924 script codes);
 * legacy files without the field simply do not vote for the corpus script.
 */

import type { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";
import type { SearchDegradation } from "./search/port.js";

/** Script classes the cheap detector can distinguish. ISO 15924 codes. */
export type LanguageHint =
  | "latn"
  | "jpan"
  | "kore"
  | "hani"
  | "cyrl"
  | "grek"
  | "arab"
  | "hebr"
  | "thai"
  | "deva";

/** Inclusive codepoint ranges per script class. `kana` folds into `jpan` at detection. */
const SCRIPT_RANGES: ReadonlyArray<readonly [LanguageHint | "kana", number, number]> = [
  ["latn", 0x41, 0x5a],
  ["latn", 0x61, 0x7a],
  ["latn", 0xc0, 0x24f],
  ["grek", 0x370, 0x3ff],
  ["cyrl", 0x400, 0x4ff],
  ["cyrl", 0x500, 0x52f],
  ["hebr", 0x590, 0x5ff],
  ["arab", 0x600, 0x6ff],
  ["arab", 0x750, 0x77f],
  ["deva", 0x900, 0x97f],
  ["thai", 0xe00, 0xe7f],
  ["kore", 0x1100, 0x11ff],
  ["latn", 0x1e00, 0x1eff],
  ["kana", 0x3040, 0x309f],
  ["kana", 0x30a0, 0x30ff],
  ["kana", 0x31f0, 0x31ff],
  ["hani", 0x3400, 0x4dbf],
  ["hani", 0x4e00, 0x9fff],
  ["kore", 0xac00, 0xd7a3],
  ["kana", 0xff66, 0xff9d],
];

/**
 * Dominant-script hint for a text. Codepoint-range counting (no regex):
 * kana anywhere maps to `jpan` — kana is unique to Japanese and disambiguates
 * it from `hani` (Chinese, or kanji-only Japanese). Returns `undefined` when
 * the text contains no lettered script class.
 */
export function detectLanguageHint(text: string): LanguageHint | undefined {
  const counts = new Map<LanguageHint | "kana", number>();
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    for (const [script, low, high] of SCRIPT_RANGES) {
      if (code < low) break;
      if (code <= high) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }
  // SCRIPT_RANGES is sorted by start codepoint, so `break` on the first
  // range starting past the codepoint is exact — one range test per char.
  if (counts.has("kana")) return "jpan";
  let best: LanguageHint | undefined;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (script === "kana") continue;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/** Dominant hint over a corpus sample; `undefined` entries (legacy files) never vote. */
export function corpusDominantLanguage(
  hints: Iterable<string | undefined>,
): LanguageHint | undefined {
  const counts = new Map<string, number>();
  for (const hint of hints) {
    if (hint === undefined || hint === "") continue;
    counts.set(hint, (counts.get(hint) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [hint, count] of counts) {
    if (count > bestCount) {
      best = hint;
      bestCount = count;
    }
  }
  return best as LanguageHint | undefined;
}

/** Planner decision for one recall query. */
export interface CrossScriptPlan {
  queryLanguage: LanguageHint | undefined;
  corpusLanguage: LanguageHint | undefined;
  /** True when both hints resolved and differ — lexical tiers cannot serve this query. */
  crossScript: boolean;
  /** Emitted when `crossScript` is true and no vector tier can compensate. */
  degradation?: SearchDegradation;
}

/**
 * Pure planner core: compare query/corpus hints and, on a mismatch without a
 * vector tier, build the visible degradation signal.
 */
export function planCrossScript(input: {
  queryLanguage: LanguageHint | undefined;
  corpusLanguage: LanguageHint | undefined;
  vectorTierAvailable: boolean;
}): CrossScriptPlan {
  const crossScript =
    input.queryLanguage !== undefined &&
    input.corpusLanguage !== undefined &&
    input.queryLanguage !== input.corpusLanguage;
  return {
    queryLanguage: input.queryLanguage,
    corpusLanguage: input.corpusLanguage,
    crossScript,
    degradation:
      crossScript && !input.vectorTierAvailable
        ? {
            backend: "qmd",
            code: "vector_tier_unavailable",
            detail:
              `cross-script query (${input.queryLanguage}) over a ${input.corpusLanguage} corpus: ` +
              "lexical recall cannot match across scripts — enable a multilingual embedding model " +
              "(embedding fallback) so the vector tier can serve it",
          }
        : undefined,
  };
}

/** Corpus sample cap: dominant script stabilizes well below the full corpus. */
const CORPUS_SAMPLE_CAP = 500;

/** Memoized dominant corpus language per storage dir, keyed by corpus scan version. */
const corpusLanguageCache = new Map<string, { version: string; language: LanguageHint | undefined }>();

/**
 * Dominant corpus language for a storage manager, sampled from the newest
 * frontmatter `language` hints (capped, memoized on the corpus scan version so
 * recurring recalls pay one pass per corpus generation, not per query).
 * Read failures degrade to `undefined` — never break recall.
 */
export async function dominantCorpusLanguage(
  storage: Pick<StorageManager, "dir" | "readAllMemories" | "getCorpusScanVersion">,
): Promise<LanguageHint | undefined> {
  try {
    const version = storage.getCorpusScanVersion();
    const cached = corpusLanguageCache.get(storage.dir);
    if (cached?.version === version) return cached.language;
    const memories = await storage.readAllMemories();
    const language = corpusDominantLanguage(
      memories.slice(0, CORPUS_SAMPLE_CAP).map((memory: MemoryFile) => memory.frontmatter.language),
    );
    if (corpusLanguageCache.size > 8) corpusLanguageCache.clear();
    corpusLanguageCache.set(storage.dir, { version, language });
    return language;
  } catch {
    return undefined;
  }
}
