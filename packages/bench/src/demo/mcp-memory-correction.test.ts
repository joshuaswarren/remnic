import assert from "node:assert/strict";
import test from "node:test";
import { parseSyntheticCorrection } from "./mcp-memory-correction.ts";

test("parses every generated MemCorrect correction shape", () => {
  const cases = [
    {
      input: "Correction: my coffee record saying oat-milk is wrong. It is now black-coffee.",
      expected: { oldValue: "oat-milk", newValue: "black-coffee" },
    },
    {
      input: "Oh by the way, we switched editor from helix to neovim last month.",
      expected: { oldValue: "helix", newValue: "neovim" },
    },
    {
      input: "For this project, database is mysql now, not postgres.",
      expected: { oldValue: "postgres", newValue: "mysql" },
    },
    {
      input: "Update: calendar is wednesday going forward instead of monday.",
      expected: { oldValue: "monday", newValue: "wednesday" },
    },
  ];

  for (const correction of cases) {
    assert.deepEqual(parseSyntheticCorrection(correction.input), correction.expected);
  }
});

test("keeps the adapter canary correction and rejects unrelated turns", () => {
  assert.deepEqual(parseSyntheticCorrection("Correction: replace old with new."), {
    oldValue: "old",
    newValue: "new",
  });
  assert.equal(parseSyntheticCorrection("Maybe use neovim someday."), undefined);
});
