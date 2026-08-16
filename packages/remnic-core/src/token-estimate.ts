const NARROW_LETTER = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;

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
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f || NARROW_LETTER.test(char)) {
      narrowCodePoints++;
    } else {
      wideTokens++;
    }
  }
  return wideTokens + Math.ceil(narrowCodePoints / 4);
}
