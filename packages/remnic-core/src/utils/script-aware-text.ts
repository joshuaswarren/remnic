/**
 * Script-aware text primitives for write-path classifiers (issue #2192).
 *
 * The local classifiers (importance, topics, taxonomy) grew around English
 * keyword regexes and Latin-oriented tokenizers. Non-Latin prose matched no
 * tier and lost every token: a Japanese sentence as dense as a full English
 * clause was scored by raw character count and filed with zero keyword
 * overlap. These helpers provide script-agnostic signals — weighted length,
 * Latin-word detection, CJK bigram tokenization — without language detection.
 */

/** CJK + Hangul: kana (incl. halfwidth), Hangul jamo/syllables, ext A, unified + compat ideographs, ext B. */
const CJK_CHAR =
  /[\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f\u{20000}-\u{2a6df}]/u;

const CJK_RUN =
  /[\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f\u{20000}-\u{2a6df}]+/gu;

/** True when the text contains a Latin word of two or more letters. */
export function hasLatinWord(text: string): boolean {
  return /[a-z]{2,}/i.test(text);
}

/**
 * Length in Latin-equivalent characters: every code point counts 1,
 * CJK/Hangul code points count 3. One han/kana glyph typically carries a
 * whole Latin word of information ("予約しました" ≈ "made a reservation"),
 * so length cutoffs calibrated on English must weight dense scripts up, or
 * short non-Latin sentences are systematically dumped into trivial buckets.
 */
export function informationalLength(text: string): number {
  let weight = 0;
  for (const ch of text) {
    weight += CJK_CHAR.test(ch) ? 3 : 1;
  }
  return weight;
}

/**
 * Sliding bigrams over contiguous CJK runs — the standard script-agnostic
 * substitute for word tokenization in unsegmented scripts. Runs shorter
 * than two characters yield nothing (a lone glyph is too generic a token).
 */
export function cjkBigrams(text: string): string[] {
  const bigrams: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      bigrams.push(run.slice(i, i + 2));
    }
  }
  return bigrams;
}
