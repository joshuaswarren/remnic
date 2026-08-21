import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/squash-merge-pr.mjs");

test("squash-merge-pr rejects a missing PR number", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});
