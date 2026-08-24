import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("config-reference documents governed MCP and OpenClaw binding requests", async () => {
  const src = await readFile(path.join(repoRoot, "docs", "config-reference.md"), "utf8");
  assert.doesNotMatch(src, /cannot request it yet/);
  const rows = src
    .split("\n")
    .filter((line) => line.includes("`sharedContextAllowBindingAuthority`"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /MCP and OpenClaw/);
    assert.match(row, /request(?: `binding`| binding)/);
  }
});

test("shared-context docs scope HTTP 400 to Access HTTP and OpenClaw tool errors", async () => {
  const src = await readFile(path.join(repoRoot, "docs", "shared-context.md"), "utf8");
  assert.doesNotMatch(src, /rejected with an input error \(HTTP 400\)/);
  assert.match(src, /Access HTTP maps those\ninput errors to HTTP 400/);
  assert.match(src, /shared_context_write_output error:/);
  assert.match(src, /not as an HTTP response/);
});
