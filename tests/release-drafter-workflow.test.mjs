import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("release-drafter action is pinned to a full commit SHA", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-drafter.yml", import.meta.url), "utf8");
  const match = workflow.match(/uses:\s+release-drafter\/release-drafter@([^\s#]+)/);

  assert.ok(match, "release-drafter action use was not found");
  assert.match(match[1], /^[0-9a-f]{40}$/);
});
