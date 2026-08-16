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
 * Word boundaries depend on both sides of a phrase edge. Most documented
 * scripts use spaces or word-like runs consistently, but mixed-script text
 * can attach a phrase to a word in the adjacent script. Keep this table
 * directional: it describes the phrase edge first, then adjacent text.
 *
 * Unknown pairs do not get a boundary. The privacy feature must prefer a
 * match over silently retaining a marked span when script data is uncertain.
 */
type BoundaryScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "hangul"
  | "han"
  | "kana"
  | "number"
  | "mark"
  | "other";

const SCRIPT_SOURCES: Record<BoundaryScript, string> = {
  latin: "\\p{Script=Latin}",
  cyrillic: "\\p{Script=Cyrillic}",
  greek: "\\p{Script=Greek}",
  arabic: "\\p{Script=Arabic}",
  hebrew: "\\p{Script=Hebrew}",
  hangul: "\\p{Script=Hangul}",
  han: "\\p{Script=Han}",
  kana: "\\p{Script=Hiragana}\\p{Script=Katakana}",
  number: "\\p{N}",
  mark: "\\p{M}",
  other: "",
};

const WORD_SCRIPTS: readonly BoundaryScript[] = [
  "latin",
  "cyrillic",
  "greek",
  "arabic",
  "hebrew",
  "hangul",
  "han",
  "kana",
  "number",
  "mark",
];

const SCRIPT_PAIRS_THAT_MAY_ABUT_INSIDE_WORD: Record<string, true> = {
  "latin:hangul": true,
  "latin:han": true,
  "latin:kana": true,
};

function scriptOfCharacter(character: string): BoundaryScript {
  if (/\p{M}/u.test(character)) return "mark";
  if (/\p{N}/u.test(character)) return "number";
  if (/\p{Script=Latin}/u.test(character)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(character)) return "cyrillic";
  if (/\p{Script=Greek}/u.test(character)) return "greek";
  if (/\p{Script=Arabic}/u.test(character)) return "arabic";
  if (/\p{Script=Hebrew}/u.test(character)) return "hebrew";
  if (/\p{Script=Hangul}/u.test(character)) return "hangul";
  if (/\p{Script=Han}/u.test(character)) return "han";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) {
    return "kana";
  }
  return "other";
}

function boundaryCharacterClass(edge: BoundaryScript): string {
  return WORD_SCRIPTS.filter(
    (adjacent) => !SCRIPT_PAIRS_THAT_MAY_ABUT_INSIDE_WORD[`${edge}:${adjacent}`],
  )
    .map((adjacent) => SCRIPT_SOURCES[adjacent])
    .join("");
}

function boundaryLookbehindFor(edge: BoundaryScript): string {
  return `(?<![${boundaryCharacterClass(edge)}])`;
}

function boundaryLookaheadFor(edge: BoundaryScript): string {
  return `(?![${boundaryCharacterClass(edge)}])`;
}

/** Phrase edge scripts that use conventional word guards. */
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
/** Word start, or exactly one word-initial proclitic before the phrase. */
const PROCLITIC_LOOKBEHIND = `(?:${BOUNDARY_LOOKBEHIND}|(?<=${BOUNDARY_LOOKBEHIND}[${PROCLITIC_LETTERS}]))`;

const HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAS_HAN = /\p{Script=Han}/u;
const HAS_HANGUL = /\p{Script=Hangul}/u;
const HAS_ARABIC = /\p{Script=Arabic}/u;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * Normalize text for phrase matching: NFC, then fold the Turkic dotted and
 * dotless I onto plain `i`.
 *
 * JavaScript's `/iu` folding is locale-independent, so it equates `i` with
 * `I` but never `ı` with `I` or `i` with `İ`. A Turkish marker such as
 * `kayıt dışı` would therefore miss an uppercase `KAYIT DIŞI` transcript and
 * leave the span on the record. Both sides of the comparison run through
 * this, so the fold cannot make one side drift from the other.
 */
export function foldForMatching(text: string): string {
  return text.normalize("NFC").replace(/[\u0131\u0130I]/g, "i");
}

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
 * breaks a phrase across a line still matches. Boundaries use the phrase
 * edge and adjacent-script pair. An attachable pair omits that boundary.
 */
export function buildPhraseMatcher(
  phrases: readonly string[],
): RegExp | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of phrases) {
    if (typeof raw !== "string") continue;
    // Folded on both sides (the tester folds its input too): an ASR that
    // emits decomposed or Turkic-uppercase text would otherwise never match
    // its marker, and the span would be persisted (issue #2196).
    const phrase = foldForMatching(raw.trim());
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
        ? boundaryLookbehindFor(scriptOfCharacter(first))
        : "";
    const last = characters[characters.length - 1];
    const tail = SUFFIXABLE_EDGE_CHAR.test(last)
      ? boundaryLookaheadFor(scriptOfCharacter(last))
      : "";
    parts.push(`${lead}${body}${tail}`);
  }
  if (parts.length === 0) return null;
  return new RegExp(parts.join("|"), "iu");
}
