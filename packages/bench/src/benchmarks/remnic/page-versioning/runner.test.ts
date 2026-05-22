import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDiffChangedLines } from "./runner.ts";

test("normalizeDiffChangedLines preserves unexpected changed lines", () => {
  const observed = normalizeDiffChangedLines(
    [
      "--- version 1",
      "+++ version 2",
      " line 1",
      "-line 2",
      "+line 2 changed",
      "-line 3",
      " line 3",
      "+line 4",
    ].join("\n"),
  );

  assert.equal(observed, "-line 2|+line 2 changed|-line 3|+line 4");
});
