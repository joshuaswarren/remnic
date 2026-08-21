import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMem0Export } from "./parser.js";
import { transformMem0Export } from "./transform.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("transformMem0Export", () => {
  it("emits one memory per non-empty mem0 entry, skipping blank bodies", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"), {
      filePath: "/tmp/mem0.json",
    });
    const memories = transformMem0Export(parsed);
    // 3 of 4 entries have non-empty content; the `   ` one is skipped.
    assert.equal(memories.length, 3);
    for (const m of memories) {
      assert.equal(m.sourceLabel, "mem0");
      assert.equal(m.importedFromPath, "/tmp/mem0.json");
      assert.equal(m.metadata?.kind, "mem0_memory");
    }
  });

  it("preserves categories, user_id, and metadata on emitted memories", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"));
    const memories = transformMem0Export(parsed);
    const first = memories[0]!;
    assert.equal(first.sourceId, "mem-syn-0001");
    assert.equal(first.sourceTimestamp, "2026-02-14T09:05:00.000Z"); // updated_at wins
    assert.deepEqual(first.metadata?.categories, ["preferences", "tooling"]);
    assert.equal(first.metadata?.userId, "synthetic-user-1");
  });

  it("accepts the content-field variant as a valid body", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"));
    const memories = transformMem0Export(parsed);
    const variant = memories.find((m) => m.sourceId === "mem-syn-0003");
    assert.ok(variant);
    assert.ok(variant.content.startsWith("Fictional (content-field variant)"));
  });

  it("honors maxMemories as a hard cap", () => {
    const parsed = parseMem0Export(loadFixture("replay-dump.json"));
    const memories = transformMem0Export(parsed, { maxMemories: 1 });
    assert.equal(memories.length, 1);
  });
});
