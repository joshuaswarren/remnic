/**
 * UTF-16 code-unit offset → UTF-8 byte offset conversion (issue #1659 item 3).
 *
 * web-tree-sitter 0.25 parses strings internally by converting them to UTF-16
 * (`stringToUTF16` in the WASM glue), so every node's `startIndex`/`endIndex`
 * is a UTF-16 code-unit offset, NOT a UTF-8 byte offset. For pure-ASCII
 * content these are identical, but multibyte content (comments, strings, or
 * identifiers containing non-ASCII characters) produces incorrect spans:
 * dead-code analysis, navigation, and body extraction all rely on byte
 * offsets matching the on-disk file.
 *
 * This module builds a single lookup array per file (O(n) build, O(1)
 * lookup) so all offsets in a FileIR can be converted in one pass.
 */

/**
 * Build a map from UTF-16 code-unit offset → UTF-8 byte offset for the given
 * string. `map[i]` is the byte offset of the i-th UTF-16 code unit.
 * `map[content.length]` is the total byte length.
 *
 * Surrogate pairs (U+10000–U+10FFFF) occupy 2 UTF-16 code units but encode to
 * 4 UTF-8 bytes. The high surrogate's entry points to the start of the pair;
 * the low surrogate's entry also points there (its byte delta is 0, added by
 * the high surrogate).
 */
export function buildUtf16ToByteOffsetMap(content: string): Uint32Array {
  const map = new Uint32Array(content.length + 1);
  let byteOffset = 0;
  for (let i = 0; i < content.length; i++) {
    map[i] = byteOffset;
    const code = content.charCodeAt(i);
    if (code < 0x80) {
      byteOffset += 1;
    } else if (code < 0x800) {
      byteOffset += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate of a surrogate pair. The full code point encodes to
      // 4 UTF-8 bytes; we charge all 4 here and skip the low surrogate.
      byteOffset += 4;
      map[i + 1] = byteOffset;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (unpaired) — treat as 3-byte UTF-8 replacement.
      // This path is only hit for malformed input.
      byteOffset += 3;
    } else {
      byteOffset += 3;
    }
  }
  map[content.length] = byteOffset;
  return map;
}

/**
 * Convert a single UTF-16 code-unit offset to a UTF-8 byte offset using a
 * pre-built map. Returns 0 for negative offsets; clamps to the map length.
 */
export function utf16ToByte(map: Uint32Array, utf16Offset: number): number {
  if (utf16Offset <= 0) return 0;
  if (utf16Offset >= map.length) return map[map.length - 1];
  return map[utf16Offset];
}
