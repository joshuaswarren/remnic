const WIDE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Hebrew}]/u;
const COMBINING_MARK = /^\p{M}$/u;

/**
 * Estimate model tokens without a tokenizer.
 *
 * Wide-script code points approximate one token each. Other code points use
 * the established four-code-point English heuristic. NFC normalization and
 * code-point iteration avoid combining-mark and surrogate-pair overcounts.
 */
export function estimateTokenCount(text: string): number {
  let wideTokens = 0;
  let narrowCodePoints = 0;
  for (const char of text.normalize("NFC")) {
    if (COMBINING_MARK.test(char)) continue;
    if (WIDE_SCRIPT.test(char)) wideTokens++;
    else narrowCodePoints++;
  }
  return wideTokens + Math.ceil(narrowCodePoints / 4);
}
