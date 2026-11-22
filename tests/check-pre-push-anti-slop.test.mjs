// check:pre-push must run the scoped anti-slop gate (#3616). PR 3645 added
// chained type assertions on new lines; check:pre-push passed locally because
// it never ran scripts/check-anti-slop.mjs, and CI's lint job then failed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../scripts/check-pre-push.mjs", import.meta.url), "utf8");

test("check:pre-push runs the scoped anti-slop gate against the resolved base (#3616)", () => {
  assert.match(source, /argv: \["node", "scripts\/check-anti-slop\.mjs"\]/);
  assert.match(source, /REMNIC_ANTI_SLOP_BASE_REF:\s*\n?\s*process\.env\.REMNIC_ANTI_SLOP_BASE_REF \?\? resolvedBase\?\.ref/);
});
