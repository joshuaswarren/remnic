import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMemoryBlock, type RecallResult } from "./format.js";

const TEMPLATE = "[Memory]\n{memories}\n[/Memory]";

describe("formatMemoryBlock", () => {
  it("returns empty string for empty memories array", () => {
    const result = formatMemoryBlock([], TEMPLATE, 1500);
    assert.equal(result, "");
  });

  it("formats a single memory into the template", () => {
    const memories: RecallResult[] = [
      { content: "User likes cats", confidence: 0.9 },
    ];
    const result = formatMemoryBlock(memories, TEMPLATE, 1500);
    assert.equal(result, "[Memory]\nUser likes cats\n[/Memory]");
  });

  it("formats multiple memories joined by newlines", () => {
    const memories: RecallResult[] = [
      { content: "Fact A", confidence: 0.8 },
      { content: "Fact B", confidence: 0.7 },
    ];
    const result = formatMemoryBlock(memories, TEMPLATE, 1500);
    assert.equal(result, "[Memory]\nFact A\nFact B\n[/Memory]");
  });

  it("sorts memories by confidence descending", () => {
    const memories: RecallResult[] = [
      { content: "Low", confidence: 0.3 },
      { content: "High", confidence: 0.95 },
      { content: "Mid", confidence: 0.6 },
    ];
    const result = formatMemoryBlock(memories, "{memories}", 1500);
    assert.equal(result, "High\nMid\nLow");
  });

  it("places memories without confidence after those with", () => {
    const memories: RecallResult[] = [
      { content: "No conf" },
      { content: "Has conf", confidence: 0.5 },
    ];
    const result = formatMemoryBlock(memories, "{memories}", 1500);
    assert.equal(result, "Has conf\nNo conf");
  });

  it("truncates to fit within maxTokens", () => {
    // 4 chars per token, maxTokens = 5 => max 20 chars
    const memories: RecallResult[] = [
      { content: "Short text here!", confidence: 0.9 }, // 16 chars
      { content: "Another fact!!", confidence: 0.8 },    // 14 chars -- would exceed 20
    ];
    const result = formatMemoryBlock(memories, "{memories}", 5);
    assert.equal(result, "Short text here!");
  });

  it("always includes at least one memory even if it exceeds maxTokens", () => {
    const memories: RecallResult[] = [
      { content: "This is a very long memory that exceeds the limit", confidence: 0.9 },
    ];
    // maxTokens=1 => max 4 chars, but the single memory is much longer
    const result = formatMemoryBlock(memories, "{memories}", 1);
    assert.equal(result, "This is a very long memory that exceeds the limit");
  });

  it("handles memories with category field", () => {
    const memories: RecallResult[] = [
      { content: "City: NYC", confidence: 0.8, category: "location" },
    ];
    const result = formatMemoryBlock(memories, "{memories}", 1500);
    assert.equal(result, "City: NYC");
  });

  it("handles all memories without confidence scores", () => {
    const memories: RecallResult[] = [
      { content: "Fact X" },
      { content: "Fact Y" },
    ];
    const result = formatMemoryBlock(memories, "{memories}", 1500);
    // Both have confidence -1, so order is stable (original order)
    assert.ok(result.includes("Fact X"));
    assert.ok(result.includes("Fact Y"));
  });

  it("does not corrupt output when memory content contains $ patterns", () => {
    const memories: RecallResult[] = [
      { content: "Price is $100 and $200", confidence: 0.9 },
      { content: "Use $& and $` and $' in code", confidence: 0.8 },
    ];
    const result = formatMemoryBlock(memories, "[Mem]\n{memories}\n[/Mem]", 1500);
    assert.ok(
      result.includes("Price is $100 and $200"),
      "Dollar signs in content must not be interpreted as replacement patterns"
    );
    assert.ok(
      result.includes("$&"),
      "$& must appear literally, not as the matched substring"
    );
    assert.ok(
      result.includes("$`"),
      "$` must appear literally"
    );
    assert.ok(
      result.includes("$'"),
      "$' must appear literally"
    );
  });
});
