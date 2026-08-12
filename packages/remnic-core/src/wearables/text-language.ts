/**
 * Script-aware text helpers shared by wearable cleanup and redaction.
 *
 * Both features were written for space-delimited English. A spoken
 * marker phrase or a filler token in Japanese, Korean, Chinese, Arabic,
 * or Russian never matched, so a privacy feature silently did nothing
 * (issue #2196). These helpers make phrase matching correct for scripts
 * that do not separate words with spaces.
 */

/** Coarse script class used to select built-in token sets. */
export type ScriptHint =
  | "latin"
  | "japanese"
  | "han"
  | "korean"
  | "arabic"
  | "cyrillic";

/**
 * Whether a phrase edge needs a word boundary is decided per EDGE and per
 * script, because scripts attach material at different ends.
 *
 * Leading edge: guarded for every script that spaces its words, so a
 * marker cannot match at the tail of a longer word — Korean `기록` must
 * not fire inside `신기록`, Arabic `خاص` must not fire inside `أشخاص`.
 * Arabic and Hebrew additionally write single-letter proclitics (`و`,
 * `ف`, `ב`, `ל`) with no space, so their guard admits ONE such letter
 * when that letter itself starts a word: `وبدون تسجيل` still reaches the
 * built-in `بدون تسجيل`.
 *
 * Trailing edge: guarded for the space-delimited scripts, so `بدون تسجيل`
 * does not match inside `بدون تسجيلات`. Hangul is excluded — Korean
 * particles attach to the END of a word, and guarding there would stop
 * `기록을` from matching `기록`.
 *
 * Han and Kana running text has no boundary at either end: requiring one
 * is the bug that made every non-Latin marker unreachable.
 */
const PREFIXABLE_EDGE_CHAR =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Hangul}\p{N}]/u;
const SUFFIXABLE_EDGE_CHAR =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{N}\p{M}]/u;
const PROCLITIC_EDGE_CHAR = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;

/**
 * Single-letter proclitics that attach to the following word in Arabic
 * and Hebrew. Kept to the unambiguous conjunctions and prepositions;
 * a longer prefix is a different word, not a clitic.
 */
const PROCLITIC_LETTERS = "وفبكلسהוכלמשב";

/**
 * Combining marks count as word characters. Without `\p{M}` a decomposed
 * `café` (base `e` plus U+0301) would let the phrase `cafe` match its
 * prefix and elide a span nobody marked.
 */
const BOUNDARY_LOOKBEHIND = "(?<![\\p{L}\\p{M}\\p{N}])";
const BOUNDARY_LOOKAHEAD = "(?![\\p{L}\\p{M}\\p{N}])";
/** Word start, or exactly one word-initial proclitic before the phrase. */
const PROCLITIC_LOOKBEHIND = `(?:${BOUNDARY_LOOKBEHIND}|(?<=${BOUNDARY_LOOKBEHIND}[${PROCLITIC_LETTERS}]))`;

const HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAS_HAN = /\p{Script=Han}/u;
const HAS_HANGUL = /\p{Script=Hangul}/u;
const HAS_ARABIC = /\p{Script=Arabic}/u;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * Report which script-specific token sets apply to `text`.
 *
 * `latin` is always present: transcripts mix scripts freely, and the
 * Latin filler tokens are whole-token matches that cannot fire inside
 * non-Latin text. Japanese wins over Han when kana are present, because
 * Japanese text also contains Han characters.
 */
export function detectScriptHints(text: string): ScriptHint[] {
  const hints: ScriptHint[] = ["latin"];
  if (HAS_KANA.test(text)) hints.push("japanese");
  else if (HAS_HAN.test(text)) hints.push("han");
  if (HAS_HANGUL.test(text)) hints.push("korean");
  if (HAS_ARABIC.test(text)) hints.push("arabic");
  if (HAS_CYRILLIC.test(text)) hints.push("cyrillic");
  return hints;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile `phrases` into one case-insensitive matcher, or `null` when
 * no usable phrase remains.
 *
 * Internal whitespace matches any whitespace run, so a transcript that
 * breaks a phrase across a line still matches. Letter boundaries are
 * added per edge, and only when that edge is a space-delimited script.
 */
export function buildPhraseMatcher(
  phrases: readonly string[],
): RegExp | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of phrases) {
    if (typeof raw !== "string") continue;
    // NFC on both sides (the tester normalizes its input too): an ASR that
    // emits decomposed text would otherwise never match a composed marker,
    // and the span would be persisted (issue #2196).
    const phrase = raw.trim().normalize("NFC");
    if (phrase.length === 0) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const characters = Array.from(phrase);
    const body = phrase
      .split(/\s+/)
      .map((word) => escapeRegExp(word))
      .join("\\s+");
    const first = characters[0];
    const lead = PROCLITIC_EDGE_CHAR.test(first)
      ? PROCLITIC_LOOKBEHIND
      : PREFIXABLE_EDGE_CHAR.test(first)
        ? BOUNDARY_LOOKBEHIND
        : "";
    const tail = SUFFIXABLE_EDGE_CHAR.test(characters[characters.length - 1])
      ? BOUNDARY_LOOKAHEAD
      : "";
    parts.push(`${lead}${body}${tail}`);
  }
  if (parts.length === 0) return null;
  return new RegExp(parts.join("|"), "iu");
}
