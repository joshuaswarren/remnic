/**
 * 64-bit word-shingle SimHash for near-duplicate screen-text detection.
 * Text is lower-cased and tokenized to Unicode letter/number runs (so CJK,
 * Cyrillic, and other non-ASCII scripts tokenize instead of collapsing to an
 * empty set), then shingled into overlapping 2-word grams. Each gram is hashed
 * with 64-bit FNV-1a; the signed
 * per-bit vote across all grams yields a 64-bit fingerprint whose Hamming
 * distance tracks textual similarity: identical text → distance 0, a small edit
 * → a small distance, unrelated text → a large distance. Everything is BigInt
 * so the full 64 bits are exact.
 */

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const SHINGLE_SIZE = 2;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(tokens: string[]): string[] {
  if (tokens.length < SHINGLE_SIZE) {
    return tokens.length > 0 ? [tokens.join(" ")] : [];
  }
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    out.push(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

/** 64-bit FNV-1a over the UTF-16 code units of `s`. */
function hash64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** 64-bit SimHash fingerprint of `text` (0n for empty/whitespace-only text). */
export function simhash(text: string): bigint {
  const grams = shingles(tokenize(text));
  if (grams.length === 0) return 0n;
  const votes = new Array<number>(64).fill(0);
  for (const gram of grams) {
    const h = hash64(gram);
    for (let b = 0; b < 64; b++) {
      votes[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (votes[b] > 0) out |= 1n << BigInt(b);
  }
  return out;
}

/** Hamming distance between two 64-bit fingerprints (0..64). */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Fixed-width 16-char hex rendering (wire/simhash column form). */
export function simhashToHex(h: bigint): string {
  return (h & MASK64).toString(16).padStart(16, "0");
}

export function simhashFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`) & MASK64;
}
