import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { shouldBuildBench } from "../scripts/test-file-deps.mjs";

test("shouldBuildBench is true only for packages/bench paths", () => {
  assert.equal(shouldBuildBench(["tests/intent.test.ts"]), false);
  assert.equal(shouldBuildBench(["packages/remnic-core/src/intent.test.ts"]), false);
  assert.equal(shouldBuildBench(["packages/bench/src/runner.test.ts"]), true);
  assert.equal(shouldBuildBench(["packages\\bench\\src\\runner.test.ts"]), true);
});

test("test-file.mjs skips the bench build unless a bench test is requested", () => {
  const source = readFileSync(new URL("../scripts/test-file.mjs", import.meta.url), "utf8");
  assert.match(source, /shouldBuildBench\(files\)/);
});

test("CodeQL analyze continues on GitHub 503", () => {
  const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
  assert.match(workflow, /continue-on-error:\s*true/);
});

test("pr-merge-ready treats ai-reviewers, analyze, Kilo, and CodeRabbit as informational", () => {
  const source = readFileSync(new URL("../scripts/pr-merge-ready.sh", import.meta.url), "utf8");
  assert.match(source, /gate_name" == "ai-reviewers"/);
  assert.match(
    source,
    /gate_name" == "Kilo Code Review" \|\| "\$gate_name" == "CodeRabbit"/,
  );
  assert.match(source, /REST PUT/);
});
