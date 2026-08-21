import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wecloneExportAdapter } from "./adapter.js";

describe("wecloneExportAdapter", () => {
  it("has name 'weclone'", () => {
    assert.equal(wecloneExportAdapter.name, "weclone");
  });

  it("has .json file extension", () => {
    assert.equal(wecloneExportAdapter.fileExtension, ".json");
  });

  it("formats records as valid Alpaca JSON", () => {
    const records = [
      {
        instruction: "What is your favorite food?",
        input: "",
        output: "I love sushi and ramen.",
        category: "preferences/food",
        confidence: 0.9,
        sourceIds: ["mem-001"],
      },
    ];

    const result = wecloneExportAdapter.formatRecords(records);
    const parsed = JSON.parse(result);

    assert.ok(Array.isArray(parsed), "output should be a JSON array");
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      instruction: "What is your favorite food?",
      input: "",
      output: "I love sushi and ramen.",
    });
  });

  it("only includes instruction, input, output fields (no extras)", () => {
    const records = [
      {
        instruction: "Tell me about your work",
        input: "",
        output: "I work in software engineering.",
        category: "personal/career",
        confidence: 0.85,
        sourceIds: ["mem-002", "mem-003"],
      },
    ];

    const result = wecloneExportAdapter.formatRecords(records);
    const parsed = JSON.parse(result);
    const keys = Object.keys(parsed[0]);

    assert.deepEqual(keys.sort(), ["input", "instruction", "output"]);
  });

  it("formats empty records as empty JSON array", () => {
    const result = wecloneExportAdapter.formatRecords([]);
    const parsed = JSON.parse(result);

    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 0);
  });

  it("formats multiple records correctly", () => {
    const records = [
      { instruction: "Q1", input: "ctx1", output: "A1" },
      { instruction: "Q2", input: "", output: "A2" },
      { instruction: "Q3", input: "ctx3", output: "A3" },
    ];

    const result = wecloneExportAdapter.formatRecords(records);
    const parsed = JSON.parse(result);

    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].instruction, "Q1");
    assert.equal(parsed[1].input, "");
    assert.equal(parsed[2].output, "A3");
  });

  it("produces pretty-printed JSON with 2-space indent", () => {
    const records = [{ instruction: "Q", input: "", output: "A" }];
    const result = wecloneExportAdapter.formatRecords(records);

    // Verify indentation: lines should have 2-space or 4-space indentation
    const lines = result.split("\n");
    assert.ok(lines.length > 1, "output should be multi-line (pretty-printed)");
    assert.ok(
      lines.some((l: string) => l.startsWith("  ")),
      "should have 2-space indented lines",
    );
  });
});
