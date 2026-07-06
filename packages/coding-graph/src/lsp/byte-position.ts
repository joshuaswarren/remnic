/**
 * Byte-offset ↔ LSP position conversion.
 *
 * LSP positions are zero-based {line, character} where `character` is a
 * UTF-16 code-unit offset within the line (LSP 3.17 §3.17). The coding-
 * graph store uses UTF-8 byte spans. This module converts between the two.
 *
 * A {@link LineOffsetMap} pre-computes the UTF-8 BYTE offset of each line
 * start, making both directions O(log n) via binary search for the line,
 * then O(line length) for the character within the line.
 */

/**
 * Pre-computed line-start byte offsets for a single file. Built once per
 * file from its content; reused for all position conversions in that file.
 *
 * `lineStarts[i]` = UTF-8 byte offset of the first character on line `i`.
 * Line 0 always starts at byte 0.
 */
export interface LineOffsetMap {
  readonly lineStarts: readonly number[];
}

/**
 * Compute the UTF-8 byte length of a single UTF-16 code unit or a
 * surrogate pair. Surrogate pairs encode to 4 bytes (U+10000-U+10FFFF).
 */
function utf8ByteLength(code: number, nextCode: number): number {
  if (code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
    return 4;
  }
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

/** True if this code unit is the high half of a surrogate pair. */
function isHighSurrogate(code: number, nextCode: number): boolean {
  return code >= 0xd800 && code <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff;
}

/**
 * Build a line-offset map from file content (as a UTF-8 string or Buffer).
 * Records UTF-8 BYTE offsets — not UTF-16 string indices — because
 * Content-Length and the store's span_start/span_end count bytes.
 * Handles `\n`, `\r\n`, and `\r` line endings.
 */
export function buildLineOffsetMap(content: string | Buffer): LineOffsetMap {
  const text = typeof content === "string" ? content : content.toString("utf8");
  const lineStarts = [0];
  let byteOffset = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const nextCode = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;

    if (code === 0x0d && nextCode === 0x0a) {
      // \r\n — 2 bytes, advance past \n.
      byteOffset += 2;
      lineStarts.push(byteOffset);
      i++;
    } else if (code === 0x0a || code === 0x0d) {
      byteOffset += 1;
      lineStarts.push(byteOffset);
    } else {
      byteOffset += utf8ByteLength(code, nextCode);
      if (isHighSurrogate(code, nextCode)) i++;
    }
  }
  return { lineStarts };
}

/**
 * Convert a UTF-8 byte offset to an LSP position {line, character}.
 * `character` is a UTF-16 code-unit count from the line start (surrogates
 * count as 2, matching LSP §3.17).
 */
export function byteOffsetToPosition(
  content: string,
  byteOffset: number,
  map: LineOffsetMap,
): { line: number; character: number } {
  const lineIdx = binarySearchLine(map.lineStarts, byteOffset);
  const lineByteStart = map.lineStarts[lineIdx];

  // Find the string index where the line starts (byte offset == lineByteStart).
  let strIdx = 0;
  let byteAccum = 0;
  for (strIdx = 0; strIdx < content.length; strIdx++) {
    if (byteAccum >= lineByteStart) break;
    const code = content.charCodeAt(strIdx);
    const nextCode = strIdx + 1 < content.length ? content.charCodeAt(strIdx + 1) : 0;
    byteAccum += utf8ByteLength(code, nextCode);
    if (isHighSurrogate(code, nextCode)) strIdx++;
  }

  // Walk from the line start to byteOffset, counting UTF-16 code units.
  let charCount = 0;
  let currentByte = lineByteStart;
  for (let i = strIdx; i < content.length; i++) {
    if (currentByte >= byteOffset) break;
    const code = content.charCodeAt(i);
    const nextCode = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;
    currentByte += utf8ByteLength(code, nextCode);
    if (isHighSurrogate(code, nextCode)) {
      charCount += 2;
      i++;
    } else {
      charCount++;
    }
  }

  return { line: lineIdx, character: charCount };
}

/**
 * Convert an LSP position {line, character} to a UTF-8 byte offset.
 * `character` is a UTF-16 code-unit count from the line start.
 */
export function positionToByteOffset(
  content: string,
  position: { line: number; character: number },
  map: LineOffsetMap,
): number {
  const lineIdx = Math.min(position.line, map.lineStarts.length - 1);
  const lineByteStart = map.lineStarts[lineIdx];

  // Find the string index where the line starts (byte offset == lineByteStart).
  let strIdx = 0;
  let byteAccum = 0;
  for (strIdx = 0; strIdx < content.length; strIdx++) {
    if (byteAccum >= lineByteStart) break;
    const code = content.charCodeAt(strIdx);
    const nextCode = strIdx + 1 < content.length ? content.charCodeAt(strIdx + 1) : 0;
    byteAccum += utf8ByteLength(code, nextCode);
    if (isHighSurrogate(code, nextCode)) strIdx++;
  }

  // Walk from the line start, counting UTF-16 code units until position.character.
  let charCount = 0;
  let byteOffset = lineByteStart;
  for (let i = strIdx; i < content.length && charCount < position.character; i++) {
    const code = content.charCodeAt(i);
    const nextCode = i + 1 < content.length ? content.charCodeAt(i + 1) : 0;
    byteOffset += utf8ByteLength(code, nextCode);
    if (isHighSurrogate(code, nextCode)) {
      charCount += 2;
      i++;
    } else {
      charCount++;
    }
  }

  return byteOffset;
}

/**
 * Binary search for the last lineStart that is <= byteOffset.
 * Returns the line index (0-based).
 */
function binarySearchLine(lineStarts: readonly number[], byteOffset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= byteOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
