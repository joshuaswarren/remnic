import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSupermemoryExport } from "./parser.js";

describe("parseSupermemoryExport", () => {
  it("reads memories array from object", () => {
    const parsed = parseSupermemoryExport({ memories: [{ id: "m1", content: "hello" }] }, "bundle.json");
    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.importedFromPath, "bundle.json");
  });
});
