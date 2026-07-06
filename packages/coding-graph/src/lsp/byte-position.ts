/**
 * Byte-offset ↔ LSP position conversion.
 *
 * LSP positions are zero-based {line, character} where `character` is a
 * UTF-16 code-unit offset within the line (LSP 3.17 §3.17). The coding-
 * graph store uses byte spans. This module converts between the two.
 *
 * A {@link LineOffsetMap} pre-computes the byte offset of each line start,
 * making both directions O(log n) via binary search.
 */

/**
 * Pre-computed line-start byte offsets for a single file. Built once per
 * file from its content; reused for all position conversions in that file.
 *
 * `lineStarts[i]` = byte offset of the first character on line `i`.
 * Line 0 always starts at byte 0.
 */
export interface LineOffsetMap {
  readonly lineStarts: readonly number[];
}

/**
 * Build a line-offset map from file content (as a UTF-8 string or Buffer).
 * Handles `\n`, `\r\n`, and `\r` line endings. The map is owned by the
 * caller — no module-level caching (rule 11).
 */
export function buildLineOffsetMap(content: string | Buffer): LineOffsetMap {
  const text = typeof content === "string" ? content : content.toString("utf8");
  const lineStarts = [0];
  // Scan for line endings. `\r\n` is counted as one break (don't double-count).
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a) {
      // \n — Unix line ending (or the \n of a \r\n pair).
      lineStarts.push(i + 1);
    } else if (ch === 0x0d) {
      // \r — could be \r\n or lone \r.
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) {
        // \r\n — skip the \n in the next iteration by advancing i.
        i++;
      }
      lineStarts.push(i + 1);
    }
  }
  return { lineStarts };
}

/**
 * Convert a byte offset to an LSP position {line, character}.
 *
 * `character` is the UTF-16 code-unit offset from the line start, NOT
 * the byte offset. This matches the LSP spec (§3.17 — character offsets
 * are based on UTF-16 string representation). We compute it by counting
 * UTF-16 code units from the line start to the byte offset.
 */
export function byteOffsetToPosition(
  content: string,
  byteOffset: number,
  map: LineOffsetMap,
): { line: number; character: number } {
  // Binary search for the last lineStart <= byteOffset.
  const lineIdx = binarySearchLine(map.lineStarts, byteOffset);
  const lineStart = map.lineStarts[lineIdx];

  // Extract the substring from line start to the target byte offset.
  // Since we're working with the JS string (UTF-16), and byteOffset is
  // a byte position, we need to convert. For ASCII-only files these are
  // identical. For files with multi-byte chars, we count bytes up to
  // the target position.
  const lineStartByte = lineStart;
  let currentByte = lineStartByte;
  let charIndex = 0;

  // Walk from lineStart counting bytes until we reach byteOffset.
  // This is O(n) per line in the worst case but lines are typically short.
  for (let i = lineStart; i < content.length && currentByte < byteOffset; i++) {
    const code = content.charCodeAt(i);
    // Surrogate pairs (e.g., emoji) are 4 bytes in UTF-8 but 2 UTF-16 units.
    if (code >= 0xd800 && code <= 0xdbff) {
      currentByte += 4; // high surrogate → 4-byte UTF-8 (most common)
      i++; // skip the low surrogate
    } else if (code < 0x80) {
      currentByte += 1;
    } else if (code < 0x800) {
      currentByte += 2;
    } else {
      currentByte += 3;
    }
    charIndex++;
  }

  return { line: lineIdx, character: charIndex };
}

/**
 * Convert an LSP position {line, character} to a byte offset.
 *
 * `character` is a UTF-16 code-unit offset from the line start. We walk
 * from the line start, counting bytes per UTF-16 code unit, until we
 * reach the target character count.
 */
export function positionToByteOffset(
  content: string,
  position: { line: number; character: number },
  map: LineOffsetMap,
): number {
  const lineIdx = Math.min(position.line, map.lineStarts.length - 1);
  const lineStart = map.lineStarts[lineIdx];
  let currentByte = lineStart;
  let charCount = 0;

  for (let i = lineStart; i < content.length && charCount < position.character; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      currentByte += 4;
      i++; // skip low surrogate
    } else if (code < 0x80) {
      currentByte += 1;
    } else if (code < 0x800) {
      currentByte += 2;
    } else {
      currentByte += 3;
    }
    charCount++;
  }

  return currentByte;
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
