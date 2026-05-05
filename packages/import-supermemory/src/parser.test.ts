import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSupermemoryExport } from "./parser.js";

describe("parseSupermemoryExport", () => {
  it("reads memories array from object", () => {
    const parsed = parseSupermemoryExport({ memories: [{ id: "m1", content: "hello" }] }, "bundle.json");
    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.importedFromPath, "bundle.json");
  });

  it("throws when input is missing", () => {
    assert.throws(
      () => parseSupermemoryExport(undefined),
      /Supermemory import requires JSON input\. Pass --file <supermemory-export\.json>\./,
    );
  });

  it("consumes only first matching key to avoid duplicates", () => {
    const parsed = parseSupermemoryExport({
      memories: [{ id: "m1", content: "hello" }],
      data: [{ id: "m1", content: "hello" }],
    });

    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.memories[0]?.id, "m1");
  });
});
