export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateCodePointSafe(value: string, maxChars: number): string {
  const glyphs = Array.from(value);
  if (maxChars <= 0) return "";
  if (glyphs.length <= maxChars) return value;
  return glyphs.slice(0, Math.max(1, maxChars)).join("").trimEnd();
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return graphemeSegmenter;
}

/**
 * Longest prefix of `value` whose UTF-16 length stays within `maxChars`
 * without splitting a surrogate pair or a grapheme cluster (ZWJ emoji
 * sequences, flags, Hangul jamo runs, combining marks). A cluster wider than
 * the budget is dropped whole rather than split. Falls back to code-point
 * boundaries when Intl.Segmenter is unavailable.
 */
export function truncateGraphemeSafe(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  let truncated = "";
  for (const unit of graphemeUnits(value)) {
    if (truncated.length + unit.length > maxChars) break;
    truncated += unit;
  }
  return truncated;
}

/**
 * Grapheme clusters of `value` as separate strings, or its code points when
 * Intl.Segmenter is unavailable.
 */
export function graphemeUnits(value: string): string[] {
  const segmenter = getGraphemeSegmenter();
  if (segmenter === null) return [...value];
  return Array.from(segmenter.segment(value), (segment) => segment.segment);
}

const COMBINING_MARK = /\p{M}/u;
const FORMAT_CHAR = /\p{Cf}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI_PRESENTATION_SELECTOR = "\uFE0F";

// ponytail: pragmatic East_Asian_Width Wide/Fullwidth subset - contiguous
// block ranges plus the emoji presentation planes. Sparse exceptions inside
// those ranges (narrow unassigned code points, U+303F) do not matter for
// terminal column alignment; switch to a full EAW table only if drift shows.
const WIDE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi radicals, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility jamo
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0xa4cf], // CJK unified ideographs, Yi
  [0xa960, 0xa97f], // Hangul Jamo extension A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6b], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth ASCII and punctuation
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji symbols, pictographs, emoticons
  [0x1f680, 0x1f6ff], // Transport and map
  [0x1f900, 0x1f9ff], // Supplemental symbols
  [0x1fa70, 0x1faff], // Symbols and pictographs extended-A
  [0x20000, 0x2fffd], // CJK extensions B-F
  [0x30000, 0x3fffd], // CJK extension G and later
];

function isWideGlyph(glyph: string): boolean {
  const codePoint = glyph.codePointAt(0)!;
  let low = 0;
  let high = WIDE_CODE_POINT_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = WIDE_CODE_POINT_RANGES[mid]!;
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Terminal cell width: East_Asian_Width Wide/Fullwidth glyphs count as 2,
 * combining marks and format characters (ZWJ, variation selectors) as 0,
 * everything else as 1. A grapheme cluster with emoji presentation - ZWJ
 * sequences, flags, skin-tone modifiers - occupies two cells.
 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const cluster of graphemeUnits(value)) {
    width += graphemeClusterWidth(cluster);
  }
  return width;
}

function graphemeClusterWidth(cluster: string): number {
  if (cluster.includes(EMOJI_PRESENTATION_SELECTOR)) return 2;
  let emojiCluster = false;
  let width = 0;
  for (const glyph of cluster) {
    if (COMBINING_MARK.test(glyph) || FORMAT_CHAR.test(glyph)) continue;
    if (EMOJI_PRESENTATION.test(glyph)) emojiCluster = true;
    width += isWideGlyph(glyph) ? 2 : 1;
  }
  return emojiCluster ? 2 : width;
}

/**
 * padEnd analog that pads to a terminal cell width, so rows containing CJK
 * or emoji keep their columns aligned.
 */
export function padEndDisplay(value: string, targetWidth: number): string {
  const padding = targetWidth - displayWidth(value);
  return padding > 0 ? value + " ".repeat(padding) : value;
}
