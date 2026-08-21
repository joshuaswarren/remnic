import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MemoryCategory } from "../src/types.js";

describe("causal rule category", () => {
  it("includes 'rule' in MemoryCategory type", () => {
    const category: MemoryCategory = "rule";
    assert.equal(category, "rule");
  });

  it("rule is distinct from existing categories", () => {
    const categories: MemoryCategory[] = [
      "fact", "preference", "correction", "entity", "decision",
      "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure",
      "reasoning_trace",
    ];
    assert.equal(new Set(categories).size, categories.length);
  });
});
