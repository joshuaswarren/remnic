const WIDE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Myanmar}\p{Script=Lao}\p{Script=Khmer}\p{Extended_Pictographic}]/u;
const NARROW_LETTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const LETTER = /\p{L}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

/**
 * Estimate model tokens without a tokenizer.
 *
 * Wide-script code points approximate one token each. Latin, Greek, Cyrillic,
 * punctuation, and symbols use the established four-code-point heuristic.
 * Unknown letters count conservatively as wide-script code points.
 */
export function estimateTokenCount(text: string): number {
  let wideTokens = 0;
  let narrowCodePoints = 0;
  for (const char of text.normalize("NFC")) {
    if (WIDE_SCRIPT.test(char) || REGIONAL_INDICATOR.test(char) || (LETTER.test(char) && !NARROW_LETTER.test(char))) {
      wideTokens++;
    } else {
      narrowCodePoints++;
    }
  }
  return wideTokens + Math.ceil(narrowCodePoints / 4);
}
