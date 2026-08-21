import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime-facing hourly summary labels use Remnic naming", async () => {
  const source = await readFile("src/index.ts", "utf8");

  assert.match(source, /name: "Remnic Hourly Summary"/);
  assert.match(source, /Task: Generate Remnic hourly summaries/);
  assert.doesNotMatch(source, /name: "Engram Hourly Summary"/);
  assert.doesNotMatch(source, /Task: Generate Engram hourly summaries/);
});
