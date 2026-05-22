import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adapter } from "./adapter.js";

describe("adapter", () => {
  it("parses and transforms", async () => {
    const parsed = await adapter.parse({ memories: [{ id: "x", content: "y" }] });
    const out = await adapter.transform(parsed);
    assert.equal(out.length, 1);
  });

  it("forwards shared maxMemories transform option", async () => {
    const parsed = await adapter.parse({
      memories: [
        { id: "x", content: "first" },
        { id: "y", content: "second" },
      ],
    });

    const out = await adapter.transform(parsed, { maxMemories: 1 });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "first");
  });
});
