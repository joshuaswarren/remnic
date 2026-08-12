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
 * Whether a phrase edge needs a word boundary is decided per EDGE, not
 * per script, because scripts differ at each end.
 *
 * Leading edge: a guard is added only where nothing attaches in front
 * of a word. Arabic and Hebrew are excluded — both write proclitics
 * (`و`, `ف`, `ب`, `ל`) with no space, so a lead guard would stop
 * `وبدون تسجيل` from matching the built-in `بدون تسجيل`. Hangul is
 * excluded for the same reason (attached particles).
 *
 * Trailing edge: a guard is added wherever the script spaces its words,
 * Arabic and Hebrew included, so `بدون تسجيل` does not match inside
 * `بدون تسجيلات`.
 *
 * Han, Kana, and Hangul running text has no boundary at all: requiring
 * one there is the bug that made every non-Latin marker unreachable.
 */
const PREFIXABLE_EDGE_CHAR =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;
const SUFFIXABLE_EDGE_CHAR =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{N}\p{M}]/u;

/**
 * Combining marks count as word characters. Without `\p{M}` a decomposed
 * `café` (base `e` plus U+0301) would let the phrase `cafe` match its
 * prefix and elide a span nobody marked.
 */
const BOUNDARY_LOOKBEHIND = "(?<![\\p{L}\\p{M}\\p{N}])";
const BOUNDARY_LOOKAHEAD = "(?![\\p{L}\\p{M}\\p{N}])";

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
    const lead = PREFIXABLE_EDGE_CHAR.test(characters[0])
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
