import assert from "node:assert/strict";
import test from "node:test";

import { buildLineOffsetMap, byteOffsetToPosition, positionToByteOffset } from "./byte-position.js";

test("line starts count UTF-8 bytes across CRLF, CR, and LF endings", () => {
  const content = "aé中😀\r\nβ\rz\n";
  assert.deepEqual(buildLineOffsetMap(content).lineStarts, [0, 12, 15, 17]);
  assert.deepEqual(buildLineOffsetMap(Buffer.from(content, "utf8")).lineStarts, [0, 12, 15, 17]);
});

test("byte spans map to UTF-16 positions at multibyte character and line boundaries", () => {
  const content = "aé中😀\r\nβ\rz\n";
  const map = buildLineOffsetMap(content);
  const positions = [
    { byte: 0, line: 0, character: 0 },
    { byte: 1, line: 0, character: 1 },
    { byte: 3, line: 0, character: 2 },
    { byte: 6, line: 0, character: 3 },
    { byte: 10, line: 0, character: 5 },
    { byte: 12, line: 1, character: 0 },
    { byte: 14, line: 1, character: 1 },
    { byte: 15, line: 2, character: 0 },
    { byte: 16, line: 2, character: 1 },
    { byte: 17, line: 3, character: 0 },
  ];

  for (const { byte, line, character } of positions) {
    assert.deepEqual(byteOffsetToPosition(content, byte, map), { line, character }, `byte ${byte}`);
    assert.equal(positionToByteOffset(content, { line, character }, map), byte, `position ${line}:${character}`);
  }
});

test("empty files retain a usable origin position", () => {
  const map = buildLineOffsetMap("");
  assert.deepEqual(map.lineStarts, [0]);
  assert.deepEqual(byteOffsetToPosition("", 0, map), { line: 0, character: 0 });
  assert.equal(positionToByteOffset("", { line: 0, character: 0 }, map), 0);
});

test("unpaired surrogates count as UTF-8 replacement characters", () => {
  const content = "\ud800\n\udc00";
  const map = buildLineOffsetMap(content);
  assert.deepEqual(map.lineStarts, [0, 4]);
  assert.deepEqual(byteOffsetToPosition(content, 7, map), { line: 1, character: 1 });
  assert.equal(positionToByteOffset(content, { line: 1, character: 1 }, map), 7);
});

test("positions beyond the final line clamp to the file end", () => {
  const content = "é\n😀";
  const map = buildLineOffsetMap(content);
  assert.equal(positionToByteOffset(content, { line: 99, character: 99 }, map), 7);
  assert.deepEqual(byteOffsetToPosition(content, 99, map), { line: 1, character: 2 });
});
