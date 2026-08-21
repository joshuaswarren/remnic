export interface NormalizeRecallTokenOptions {
  minTokenLength?: number;
}

const DEFAULT_RECALL_STOP_WORDS = ["the", "and", "for", "with", "from", "into", "that", "this", "why", "did"];

export function isUnsegmentableRecallChar(char: string): boolean {
  if (char === "ー" || char === "ｰ") return true;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u.test(
    char,
  );
}

function isRecallCombiningMark(char: string): boolean {
  return /\p{M}/u.test(char);
}

function buildRecallStopWords(extraStopWords: string[]): Set<string> {
  return new Set([...DEFAULT_RECALL_STOP_WORDS, ...extraStopWords.map((word) => word.toLowerCase())]);
}

function shouldKeepRecallToken(token: string, minTokenLength: number, stopWords: Set<string>): boolean {
  if (stopWords.has(token)) return false;
  if (token.length >= minTokenLength) return true;
  const hasNonAsciiCodepoint = [...token].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
  return token.length >= 2 && hasNonAsciiCodepoint && /\p{L}/u.test(token);
}

export function expandUnsegmentableRecallNGrams(segment: string): string[] {
  const chars = [...segment].filter((ch) => /[\p{L}\p{N}\p{M}]/u.test(ch) || isUnsegmentableRecallChar(ch));
  const tokens: string[] = [];
  for (const ch of chars) {
    tokens.push(ch);
  }
  for (const size of [2, 3, 4]) {
    if (chars.length < size) continue;
    for (let index = 0; index <= chars.length - size; index += 1) {
      tokens.push(chars.slice(index, index + size).join(""));
    }
  }
  if (chars.length > 3) {
    tokens.push(chars.join(""));
  }
  return tokens;
}

function addUnsegmentableRecallSegment(tokens: Set<string>, segment: string, stopWords: Set<string>): void {
  for (const token of expandUnsegmentableRecallNGrams(segment)) {
    if (!stopWords.has(token)) tokens.add(token);
  }
}

function isUnsegmentableRecallToken(token: string): boolean {
  const chars = [...token].filter((ch) => /[\p{L}\p{N}\p{M}]/u.test(ch) || isUnsegmentableRecallChar(ch));
  return (
    chars.length > 0 &&
    chars.some(isUnsegmentableRecallChar) &&
    chars.every((ch) => isUnsegmentableRecallChar(ch) || isRecallCombiningMark(ch))
  );
}

function addBridgedUnsegmentableRecallSegments(tokens: Set<string>, cleaned: string, stopWords: Set<string>): void {
  let segment = "";
  const flushSegment = () => {
    addUnsegmentableRecallSegment(tokens, segment, stopWords);
    segment = "";
  };

  for (const token of cleaned.split(/\s+/)) {
    if (isUnsegmentableRecallToken(token)) {
      segment += token;
    } else {
      flushSegment();
    }
  }
  flushSegment();
}

export function normalizeRecallTokenSet(
  value: string,
  extraStopWords: string[] = [],
  options: NormalizeRecallTokenOptions = {}
): Set<string> {
  const minTokenLength = Math.max(1, Math.floor(options.minTokenLength ?? 3));
  const stopWords = buildRecallStopWords(extraStopWords);
  const cleaned = value
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}\u30fc\uff70]+/gu, " ")
    .trim();
  if (cleaned.length === 0) return new Set();

  const tokens = new Set<string>();
  addBridgedUnsegmentableRecallSegments(tokens, cleaned, stopWords);
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if ([...token].some(isUnsegmentableRecallChar)) {
      let segment = "";
      let unsegmentableSegment = "";
      const flushSegment = () => {
        if (shouldKeepRecallToken(segment, minTokenLength, stopWords)) {
          tokens.add(segment);
        }
        segment = "";
      };
      const flushUnsegmentableSegment = () => {
        addUnsegmentableRecallSegment(tokens, unsegmentableSegment, stopWords);
        unsegmentableSegment = "";
      };
      for (const ch of token) {
        if (!/[\p{L}\p{N}\p{M}]/u.test(ch) && !isUnsegmentableRecallChar(ch)) continue;
        if (isUnsegmentableRecallChar(ch)) {
          flushSegment();
          unsegmentableSegment += ch;
        } else if (isRecallCombiningMark(ch)) {
          if (unsegmentableSegment.length > 0) {
            unsegmentableSegment += ch;
          } else {
            segment += ch;
          }
        } else {
          flushUnsegmentableSegment();
          segment += ch;
        }
      }
      flushUnsegmentableSegment();
      flushSegment();
      continue;
    }
    if (shouldKeepRecallToken(token, minTokenLength, stopWords)) {
      tokens.add(token);
    }
  }
  return tokens;
}

export function normalizeRecallTokens(value: string, extraStopWords: string[] = []): string[] {
  return Array.from(normalizeRecallTokenSet(value, extraStopWords));
}

export function countRecallTokenOverlap(
  queryTokens: Set<string>,
  value: string | undefined,
  extraStopWords: string[] = []
): number {
  if (!value) return 0;
  const tokens = normalizeRecallTokenSet(value, extraStopWords);
  let matches = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) matches += 1;
  }
  return matches;
}
