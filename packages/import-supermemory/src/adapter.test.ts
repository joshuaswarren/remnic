import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adapter } from "./adapter.js";

describe("adapter", () => {
  it("parses and transforms", async () => {
    const parsed = await adapter.parse({ memories: [{ id: "x", content: "y" }] });
    const out = adapter.transform(parsed);
    assert.equal(out.length, 1);
  });
});
