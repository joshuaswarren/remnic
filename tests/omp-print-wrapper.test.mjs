import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("omp-print.sh execs omp with stdin from /dev/null", () => {
  const source = readFileSync(new URL("../scripts/omp-print.sh", import.meta.url), "utf8");
  assert.match(source, /exec omp --mode text --print --approval-mode yolo "\$@" <\/dev\/null/);
});
