import assert from "node:assert/strict";
import test from "node:test";

import { createChunker } from "../src/audio.mjs";

function collect(bytesPerChunk) {
  const seen = [];
  return { seen, chunker: createChunker(bytesPerChunk, (pcm, offset) => seen.push({ length: pcm.length, offset })) };
}

test("pieces of any size are cut at exact chunk edges with the stream offset of each chunk", () => {
  const { seen, chunker } = collect(32_000);
  for (const size of [1, 31_999, 40_000, 3]) chunker.push(Buffer.alloc(size));
  assert.deepEqual(seen, [{ length: 32_000, offset: 0 }, { length: 32_000, offset: 32_000 }]);
  assert.equal(seen.length, 2);
});

test("flush writes the rest as whole samples and drops a half sample", () => {
  const { seen, chunker } = collect(32_000);
  chunker.push(Buffer.alloc(16_001));
  chunker.flush();
  assert.deepEqual(seen, [{ length: 16_000, offset: 0 }]);
});

test("a rest shorter than a tenth of a second is dropped and flush leaves nothing behind", () => {
  const { seen, chunker } = collect(32_000);
  chunker.push(Buffer.alloc(3_198));
  chunker.flush();
  chunker.flush();
  assert.deepEqual(seen, []);
});
