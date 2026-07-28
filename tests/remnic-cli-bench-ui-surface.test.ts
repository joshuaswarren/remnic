import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseBenchArgs } from "../packages/remnic-cli/src/bench-args.ts";

test("bench action parser recognizes ui and preserves results-dir resolution", () => {
  const parsed = parseBenchArgs([
    "ui",
    "--results-dir",
    "~/bench-results",
  ]);

  assert.equal(parsed.action, "ui");
  assert.equal(parsed.benchmarks.length, 0);
  assert.match(parsed.resultsDir ?? "", /bench-results$/);
});

test("CLI source wires remnic bench ui to the local bench-ui package", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(parserSource, /\| "ui"/);
  assert.match(parserSource, /first === "ui"/);
  assert.match(source, /remnic bench <list\|run\|datasets\|runs\|compare\|results\|baseline\|export\|publish\|ui\|providers\|attribute\|drift-gen>/);
  assert.match(source, /ui\s+Launch the local benchmark overview UI/);
  assert.match(source, /if \(parsed\.action === "ui"\) \{\s*await launchBenchUi\(parsed\.resultsDir \?\? resolveBenchOutputDir\(\)\);\s*return;\s*\}/s);
  assert.match(source, /async function launchBenchUi\(resultsDir: string\): Promise<void>/);
  assert.match(source, /const benchUiDir = path\.join\(CLI_REPO_ROOT, "packages", "bench-ui"\);/);
  assert.match(source, /REMNIC_BENCH_RESULTS_DIR: resultsDir/);
  assert.match(source, /shell:\s*process\.platform === "win32"/);
  assert.match(source, /childProcess\.spawn\(pnpmCmd, \["exec", "vite", "--host", "127\.0\.0\.1"\]/);
});
