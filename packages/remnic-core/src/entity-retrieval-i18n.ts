import { normalizeEntityText } from "./entity-schema.js";

/**
 * Non-English query-mode cues for entity retrieval (#2193).
 *
 * #2161 made explicit entity mentions language-independent, but follow-up /
 * pronoun coreference and timeline phrasing still classify through English
 * word lists in `detectEntityQueryMode`. These cue tables plus the
 * structural follow-up signal below close that gap without building a full
 * coreference engine: the structural layer covers every script (including
 * zero-pronoun languages like Japanese, Chinese, and Korean, which omit the
 * subject entirely and can never trip a pronoun word list), and the tables
 * add precision for queries without a question mark.
 */

export type EntityQueryMode = "direct" | "timeline" | "follow_up";

/** Shared short-question bound. Whitespace tokens are a poor length proxy
 * for unspaced scripts, so bound graphemes too (48 graphemes ≈ 8 words). */
const FOLLOW_UP_MAX_TOKENS = 8;
const FOLLOW_UP_MAX_GRAPHEMES = 48;

/** Latin / question marks: ASCII `?`, fullwidth `？` (CJK), Arabic `؟`. */
const QUESTION_MARK_RE = /[?？؟]/;

/**
 * CJK cues and normalized multi-word phrases match by containment; single
 * Latin/Cyrillic/Arabic words match with a script-agnostic letter boundary
 * so `él` never matches `el` and `il` never matches `famille`.
 */
const FOLLOW_UP_CONTAINS_CUES = [
  // ja
  "彼", "彼女", "あの人", "その人", "それで", "ちなみに",
  // zh (simplified + traditional)
  "他", "她", "它", "他们", "她们", "他們", "她們", "然后呢", "然後呢",
  // ko
  "그녀", "그 사람", "걔",
] as const;

const FOLLOW_UP_WORD_CUES = [
  // es
  "él", "ella", "ellos", "ellas",
  // fr
  "elle", "eux",
  // de
  "sie",
  // pt
  "ele", "ela",
  // it
  "lui", "lei",
  // ru
  "он", "она", "они",
  // ar
  "هو", "هي", "هم",
] as const;

const TIMELINE_CONTAINS_CUES = [
  // ja
  "最近", "その後", "どうなった", "何があった",
  // zh (simplified + traditional)
  "怎么样了", "怎麼樣了", "后来", "後來", "最新", "近况", "近況", "什么情况", "什麼情況",
  // ko
  "요즘", "요새", "최근",
  // multi-word phrases, already in normalized form (punctuation → space)
  "qué hay de nuevo", "qué pasó con", "quoi de neuf", "что нового",
  "что случилось", "ما الجديد", "ماذا حدث", "was gibt s neues",
] as const;

function wordCueRegex(cues: readonly string[]): RegExp {
  const alternation = cues
    .map((cue) => cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "u");
}

const FOLLOW_UP_WORD_RE = wordCueRegex(FOLLOW_UP_WORD_CUES);

function isShortFollowUpShaped(normalized: string): boolean {
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > FOLLOW_UP_MAX_TOKENS) return false;
  return Array.from(normalized).length <= FOLLOW_UP_MAX_GRAPHEMES;
}

/**
 * Classify already-normalized non-English queries. Returns null when no
 * table cue matches; callers keep their English rules untouched.
 */
export function detectNonEnglishEntityQueryMode(normalizedQuery: string): EntityQueryMode | null {
  if (!normalizedQuery) return null;
  if (
    isShortFollowUpShaped(normalizedQuery)
    && (
      FOLLOW_UP_CONTAINS_CUES.some((cue) => normalizedQuery.includes(cue))
      || FOLLOW_UP_WORD_RE.test(normalizedQuery)
    )
  ) {
    return "follow_up";
  }
  if (TIMELINE_CONTAINS_CUES.some((cue) => normalizedQuery.includes(cue))) {
    return "timeline";
  }
  return null;
}

/**
 * Structural follow-up signal, independent of pronoun vocabulary: a short
 * question carrying no entity name, asked while recent dialogue exists, is a
 * coreference cue in any language. Recent-turn candidate resolution (and its
 * empty result → section absent) remains the real gate, so this only routes
 * the query into the follow-up path; it never invents an entity.
 */
export function isStructuralEntityFollowUpQuery(query: string, hasRecentDialogue: boolean): boolean {
  if (!hasRecentDialogue) return false;
  const normalized = normalizeEntityText(query);
  return isShortFollowUpShaped(normalized) && QUESTION_MARK_RE.test(query);
}
