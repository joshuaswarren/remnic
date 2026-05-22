import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractMemoryBody, parseMem0Export } from "./parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseMem0Export", () => {
  it("parses a flat results-array replay dump", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"));
    // 4 entries total, but the dump's 'empty' one keeps its id so it survives parse.
    assert.equal(parsed.memories.length, 4);
  });

  it("parses a multi-page recording via the `pages` key", () => {
    const parsed = parseMem0Export(loadFixture("two-page-recording.json"));
    assert.equal(parsed.memories.length, 3);
  });

  it("accepts a pre-fetched array directly", () => {
    const parsed = parseMem0Export([
      { id: "x1", memory: "hello" },
      { id: "x2", content: "world" },
    ]);
    assert.equal(parsed.memories.length, 2);
  });

  it("drops entries with no id in non-strict mode", () => {
    const parsed = parseMem0Export([{ memory: "no id" }]);
    assert.equal(parsed.memories.length, 0);
  });

  it("rejects primitive and null replay payloads in non-strict mode", () => {
    for (const payload of ["123", "true", "null"]) {
      assert.throws(
        () => parseMem0Export(payload, { filePath: "/tmp/mem0.json" }),
        /mem0 export must be an array or recognized object/,
      );
    }
  });

  it("rejects unrecognized top-level object replay payloads", () => {
    assert.throws(
      () => parseMem0Export(JSON.stringify({ foo: [] })),
      /must contain a results, memories, all_pages, or pages array/,
    );
  });

  it("strict mode rejects entries without id", () => {
    assert.throws(
      () =>
        parseMem0Export(JSON.stringify([{ memory: "no id" }]), { strict: true }),
      /missing id/,
    );
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseMem0Export("{not-json"), /not valid JSON/);
  });

  it("preserves filePath on the result", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"), {
      filePath: "/tmp/mem0-replay.json",
    });
    assert.equal(parsed.importedFromPath, "/tmp/mem0-replay.json");
  });
});

describe("extractMemoryBody", () => {
  it("prefers memory → content → text", () => {
    assert.equal(
      extractMemoryBody({ id: "a", memory: "m", content: "c", text: "t" }),
      "m",
    );
    assert.equal(extractMemoryBody({ id: "a", content: "c", text: "t" }), "c");
    assert.equal(extractMemoryBody({ id: "a", text: "t" }), "t");
  });

  it("returns undefined when all candidate fields are empty / missing", () => {
    assert.equal(extractMemoryBody({ id: "a" }), undefined);
    assert.equal(extractMemoryBody({ id: "a", memory: "   " }), undefined);
  });
});
