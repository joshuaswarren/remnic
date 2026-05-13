import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSupermemoryExport } from "./parser.js";

describe("parseSupermemoryExport", () => {
  it("reads memories array from object", () => {
    const parsed = parseSupermemoryExport({ memories: [{ id: "m1", content: "hello" }] }, "bundle.json");
    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.importedFromPath, "bundle.json");
  });

  it("reads v4 memoryEntries array from object", () => {
    const parsed = parseSupermemoryExport({ memoryEntries: [{ id: "m1", content: "hello" }] });

    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.memories[0]?.id, "m1");
  });

  it("throws when input is missing", () => {
    assert.throws(
      () => parseSupermemoryExport(undefined),
      /Supermemory import requires JSON input\. Pass --file <supermemory-export\.json>\./,
    );
  });

  it("throws when JSON input is null", () => {
    assert.throws(
      () => parseSupermemoryExport("null"),
      /Supermemory export must be a JSON array or object; received null/,
    );
  });

  it("throws when JSON input is a primitive", () => {
    assert.throws(
      () => parseSupermemoryExport("123"),
      /Supermemory export must be a JSON array or object; received number/,
    );
  });

  it("throws when an object has no recognized memory key", () => {
    assert.throws(
      () => parseSupermemoryExport({ foo: [] }),
      /Supermemory export object has no recognized memory key/,
    );
  });

  it("throws when a recognized memory key is not an array", () => {
    assert.throws(
      () => parseSupermemoryExport({ memories: {} }),
      /Supermemory export key 'memories' must be an array/,
    );
  });

  it("consumes only first matching key to avoid duplicates", () => {
    const parsed = parseSupermemoryExport({
      memories: [{ id: "m1", content: "hello" }],
      memoryEntries: [{ id: "m2", content: "newer" }],
      data: [{ id: "m1", content: "hello" }],
    });

    assert.equal(parsed.memories.length, 1);
    assert.equal(parsed.memories[0]?.id, "m2");
  });
});
