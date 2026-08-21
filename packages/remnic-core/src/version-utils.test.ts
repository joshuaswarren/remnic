import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions } from "./version-utils.js";

test("compareVersions sorts version triples consistently", () => {
  assert.equal(compareVersions([2026, 1, 28], [2026, 1, 29]), -1);
  assert.equal(compareVersions([2026, 1, 29], [2026, 1, 29]), 0);
  assert.equal(compareVersions([2026, 3, 8], [2026, 1, 29]), 1);
});
