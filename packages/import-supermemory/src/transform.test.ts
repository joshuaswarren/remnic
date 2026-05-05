import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformSupermemoryExport } from "./transform.js";

describe("transformSupermemoryExport", () => {
  it("maps record into ImportedMemory", () => {
    const out = transformSupermemoryExport({ memories: [{ id: "a", content: "memo", containerTags: ["user_1"] }] });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceLabel, "supermemory");
  });

  it("preserves numeric source IDs", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: 12345 as unknown as string, content: "memo" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceId, "12345");
  });

  it("reads v4 memory text as imported content", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", memory: "remember this" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "remember this");
  });

  it("does not emit non-string sourceTimestamp", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", createdAt: 1700000000 as unknown as string }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, undefined);
  });

  it("falls back to createdAt when updatedAt is blank", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: " ", createdAt: "2026-05-05T00:00:00.000Z" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, "2026-05-05T00:00:00.000Z");
  });
});
