import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformSupermemoryExport } from "./transform.js";

describe("transformSupermemoryExport", () => {
  it("maps record into ImportedMemory", () => {
    const out = transformSupermemoryExport({ memories: [{ id: "a", content: "memo", containerTags: ["user_1"] }] });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceLabel, "supermemory");
  });

  it("honors maxMemories as a hard cap", () => {
    const out = transformSupermemoryExport(
      {
        memories: [
          { id: "a", content: "first memo" },
          { id: "b", content: "second memo" },
        ],
      },
      { maxMemories: 1 },
    );

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "first memo");
  });

  it("preserves numeric source IDs", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: 12345 as unknown as string, content: "memo" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceId, "12345");
  });

  it("does not synthesize colliding source IDs for id-less memories", () => {
    const sharedPrefix = "x".repeat(64);
    const out = transformSupermemoryExport({
      memories: [
        { content: `${sharedPrefix}a` },
        { content: `${sharedPrefix}b` },
      ],
      importedFromPath: "/exports/supermemory.json",
    });

    assert.equal(out.length, 2);
    assert.equal(out[0]?.sourceId, undefined);
    assert.equal(out[1]?.sourceId, undefined);
    assert.notEqual(out[0]?.content, out[1]?.content);
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

  it("falls back to createdAt when updatedAt is not a valid timestamp", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: "not-a-date", createdAt: "2026-05-05T00:00:00.000Z" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, "2026-05-05T00:00:00.000Z");
  });

  it("falls back to createdAt when updatedAt is an impossible calendar date", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: "2026-02-31T00:00:00.000Z", createdAt: "2026-05-05T00:00:00.000Z" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, "2026-05-05T00:00:00.000Z");
  });

  it("omits sourceTimestamp when exported timestamps are invalid", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: "not-a-date", createdAt: "2026-05-05" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, undefined);
  });

  it("omits sourceTimestamp for a malformed updatedAt with no fallback", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: "not-a-date" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, undefined);
  });

  it("omits sourceTimestamp for an impossible calendar date with no fallback", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", updatedAt: "2026-04-31T00:00:00Z" }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, undefined);
  });
});
