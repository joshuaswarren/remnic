import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformSupermemoryExport } from "./transform.js";

describe("transformSupermemoryExport", () => {
  it("maps record into ImportedMemory", () => {
    const out = transformSupermemoryExport({ memories: [{ id: "a", content: "memo", containerTags: ["user_1"] }] });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceLabel, "supermemory");
  });

  it("does not emit non-string sourceTimestamp", () => {
    const out = transformSupermemoryExport({
      memories: [{ id: "a", content: "memo", createdAt: 1700000000 as unknown as string }],
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.sourceTimestamp, undefined);
  });
});
