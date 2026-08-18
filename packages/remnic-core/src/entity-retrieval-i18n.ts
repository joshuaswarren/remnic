import { normalizeEntityText } from "./entity-schema.js";

/**
 * Non-English query-mode cues for entity retrieval (#2193).
 *
 * #2161 made explicit entity mentions language-independent, but follow-up /
 * pronoun coreference and timeline phrasing still classify through English
 * word lists in `detectEntityQueryMode`. These cue tables plus the structural
 * follow-up signal below close that gap without building a full coreference
 * engine: the structural layer covers zero-pronoun scripts (Japanese,
 * Chinese, Korean — languages that omit the subject entirely and can never
 * trip a pronoun word list), and the tables add precision for other scripts,
 * including Latin-script languages whose pronoun follow-ups carry their
 * pronoun explicitly. Latin-script queries never use the structural layer:
 * their generic technical questions ("what does this error mean?") are
 * indistinguishable from subject-less follow-ups by shape alone.
 */

export type EntityQueryMode = "direct" | "timeline" | "follow_up";

/** Shared short-question bound. Whitespace tokens are a poor length proxy
 * for unspaced scripts, so bound graphemes too (48 graphemes ≈ 8 words). */
const FOLLOW_UP_MAX_TOKENS = 8;
const FOLLOW_UP_MAX_GRAPHEMES = 48;

/** Latin letters mark a script with explicit pronouns; structural fallback
 * never applies there (English "what does this error mean?" and its
 * relatives keep the technical-question guard in detectEntityQueryMode). */
const LATIN_LETTER_RE = /\p{Script=Latin}/u;

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
 * coreference cue in zero-pronoun scripts (Latin-script queries are excluded
 * above — their follow-ups carry pronouns that the cue tables and English
 * rules classify). Recent-turn candidate resolution (and its empty result →
 * section absent) remains the real gate, so this only routes the query into
 * the follow-up path; it never invents an entity.
 */
export function isStructuralEntityFollowUpQuery(query: string, hasRecentDialogue: boolean): boolean {
  if (!hasRecentDialogue) return false;
  if (LATIN_LETTER_RE.test(query)) return false;
  const normalized = normalizeEntityText(query);
  return isShortFollowUpShaped(normalized) && QUESTION_MARK_RE.test(query);
}

const ENTITY_PRONOUN_RE = /\b(he|him|his|she|her|they|them|their|it|its)\b/i;

export function detectEntityQueryMode(query: string): EntityQueryMode | null {
  const normalized = normalizeEntityText(query);
  if (!normalized) return null;
  if (
    /^(what about|and what about|how about|what happened (with|to) (he|him|his|she|her|they|them|their|it|its)|did (he|she|they|it)|is (he|she|they|it)|was (he|she|they|it))\b/.test(normalized)
  ) {
    return "follow_up";
  }
  if (
    /^(who is|who s|what do we know about|what does|tell me about|what can you tell me about|what s new with|what happened with|what happened to|status of|where is|how is)\b/.test(normalized)
  ) {
    if (/^what does\b/.test(normalized)) {
      if (/^what does (?:this|that|it|the|a|an|my|our|your|their)\b/.test(normalized)) {
        return null;
      }
      if (
        /^what does [a-z0-9-]+ (?:error|warning|exception|failure|stack|trace|code|message|log)\b/.test(normalized)
        && /\b(mean|means|indicate|indicates|imply|implies)\b/.test(normalized)
      ) {
        return null;
      }
    }
    return /what happened|what s new|status of|how is|where is/.test(normalized) ? "timeline" : "direct";
  }
  if (ENTITY_PRONOUN_RE.test(normalized) && normalized.split(/\s+/).length <= 8) {
    return "follow_up";
  }
  return detectNonEnglishEntityQueryMode(normalized);
}

