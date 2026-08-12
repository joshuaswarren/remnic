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
 * Scripts that separate words with spaces. A phrase in one of these
 * scripts must not match inside a longer word, so the compiled matcher
 * adds letter boundaries. Scripts outside this set (Han, Kana, Hangul
 * syllables in running text) have no such boundary: requiring one there
 * is exactly the bug that made every non-Latin marker unreachable.
 *
 * Arabic and Hebrew belong here. Both space their words, so without a
 * guard the built-in `بدون تسجيل` would match inside `بدون تسجيلات` and
 * elide a span nobody asked to hide.
 */
const SPACE_DELIMITED_CHAR =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{N}]/u;

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
    const phrase = raw.trim();
    if (phrase.length === 0) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const characters = Array.from(phrase);
    const body = phrase
      .split(/\s+/)
      .map((word) => escapeRegExp(word))
      .join("\\s+");
    const lead = SPACE_DELIMITED_CHAR.test(characters[0])
      ? "(?<![\\p{L}\\p{N}])"
      : "";
    const tail = SPACE_DELIMITED_CHAR.test(characters[characters.length - 1])
      ? "(?![\\p{L}\\p{N}])"
      : "";
    parts.push(`${lead}${body}${tail}`);
  }
  if (parts.length === 0) return null;
  return new RegExp(parts.join("|"), "iu");
}
