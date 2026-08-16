import { expandUnsegmentableRecallNGrams, isUnsegmentableRecallChar } from "../recall-tokenization.js";

/**
 * Language marker persisted inside Orama index files (`.msp`). Orama persists
 * `tokenizer.language` with the index, so this doubles as the tokenization
 * version: `OramaBackend` detects any other marker on restore and rebuilds
 * the full-text index (issue #2187). Bump the suffix whenever tokenization
 * changes.
 */
export const ORAMA_CJK_TOKENIZER_LANGUAGE = "english+cjk-v1";

/** Minimal structural surface of `@orama/orama` this module consumes. */
export interface OramaTokenizerComponents {
  components: {
    tokenizer: {
      createTokenizer: (config: { language: string }) => OramaTokenizer;
    };
  };
}

export interface OramaTokenizer {
  language: string;
  normalizationCache: Map<string, string>;
  tokenize: (raw: string, language?: string, prop?: string, withCache?: boolean) => string[];
}

const THAI_SCRIPT_CHAR = /[\p{Script=Thai}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const COMBINING_MARK = /\p{M}/u;
const WHITESPACE_CHAR = /\s/u;
/**
 * Chars the stock English tokenizer keeps inside a token. Input made only of
 * these (plus whitespace) is delegated to the stock tokenizer byte-for-byte so
 * existing English indexes stay term-compatible.
 */
const LEGACY_TOKENIZER_CHAR = /[A-Za-zàèéìòóù0-9_'-]/u;

/**
 * Space-free scripts: CJK per the shared recall segmentation strategy, plus
 * Thai. Runs in these scripts are indexed as character n-grams so phrase
 * queries match without word boundaries.
 */
export function isSpaceFreeScriptChar(char: string): boolean {
  return isUnsegmentableRecallChar(char) || THAI_SCRIPT_CHAR.test(char);
}

/**
 * True when tokenizing the value differs from the stock English tokenizer —
 * i.e. the value contains characters outside the stock keep-set that this
 * tokenizer still indexes as token material: word characters (whole-word
 * non-ASCII scripts), combining marks (attached to runs), and space-free
 * scripts (CJK/Thai n-grams). Symbols and punctuation that are separators in
 * BOTH tokenizers do not count. `OramaBackend` uses this to decide whether a
 * stale pre-CJK index needs re-indexing on upgrade.
 */
export function containsNonLegacyTokenizerChars(value: string): boolean {
  for (const ch of value) {
    if (LEGACY_TOKENIZER_CHAR.test(ch) || WHITESPACE_CHAR.test(ch)) continue;
    if (WORD_CHAR.test(ch) || COMBINING_MARK.test(ch) || isSpaceFreeScriptChar(ch)) {
      return true;
    }
  }
  return false;
}

/**
 * Orama tokenizer component that segments space-free scripts (CJK, Thai).
 *
 * - CJK/Thai runs expand to the same n-gram set the recall query-side
 *   tokenizer (`recall-tokenization.ts`) produces, so index-side and
 *   query-side tokens agree.
 * - Other non-Latin scripts (Hangul, Cyrillic, Greek, Arabic, ...) are kept
 *   as whole words instead of being dropped by the English splitter.
 * - Legacy Latin content tokenizes exactly like the stock English tokenizer;
 *   content with other characters keeps every stock token and additionally
 *   indexes non-ASCII words whole (e.g. "über" adds "über" beside "ber").
 */
export function createCjkCapableTokenizer(oramaModule: OramaTokenizerComponents): OramaTokenizer {
  const base = oramaModule.components.tokenizer.createTokenizer({ language: "english" });

  const tokenize = (raw: string, _language?: string, prop?: string, withCache?: boolean): string[] => {
    if (typeof raw !== "string") return [];
    const normalized = raw.normalize("NFC");

    if (!containsNonLegacyTokenizerChars(normalized)) {
      return base.tokenize(normalized, "english", prop, withCache);
    }

    // The stock tokenizer treats every non-legacy char as a separator, so its
    // output over the raw input already carries the legacy-Latin tokens
    // (e.g. the "nebula-472" in "Nebula-472 東京都庁").
    const tokens = base.tokenize(normalized, "english", prop, withCache);
    const seen = new Set(tokens);

    const pushToken = (token: string) => {
      if (token && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    };

    let spaceFreeRun = "";
    let wordRun = "";
    const flushSpaceFreeRun = () => {
      if (!spaceFreeRun) return;
      for (const token of expandUnsegmentableRecallNGrams(spaceFreeRun)) {
        pushToken(token);
      }
      spaceFreeRun = "";
    };
    const flushWordRun = () => {
      if (!wordRun) return;
      pushToken(wordRun.toLowerCase());
      wordRun = "";
    };

    for (const ch of normalized) {
      if (isSpaceFreeScriptChar(ch)) {
        flushWordRun();
        spaceFreeRun += ch;
      } else if (COMBINING_MARK.test(ch)) {
        if (spaceFreeRun) spaceFreeRun += ch;
        else if (wordRun) wordRun += ch;
      } else if (WORD_CHAR.test(ch) && !LEGACY_TOKENIZER_CHAR.test(ch)) {
        flushSpaceFreeRun();
        wordRun += ch;
      } else {
        flushSpaceFreeRun();
        flushWordRun();
      }
    }
    flushSpaceFreeRun();
    flushWordRun();

    return tokens;
  };

  return {
    language: ORAMA_CJK_TOKENIZER_LANGUAGE,
    normalizationCache: base.normalizationCache,
    tokenize,
  };
}
