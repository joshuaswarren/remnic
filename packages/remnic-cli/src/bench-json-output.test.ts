import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __benchDatasetTestHooks } from "./index.js";

function captureConsole(run: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    stdout.push([message, ...optionalParams].map(String).join(" "));
  };
  console.error = (message?: unknown, ...optionalParams: unknown[]) => {
    stderr.push([message, ...optionalParams].map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout, stderr };
}

test("benchmark status lines go to stderr when JSON output is active", () => {
  const jsonMode = captureConsole(() => {
    __benchDatasetTestHooks.printBenchStatusLineForTest(true, "progress");
  });

  assert.deepEqual(jsonMode.stdout, []);
  assert.deepEqual(jsonMode.stderr, ["progress"]);

  const textMode = captureConsole(() => {
    __benchDatasetTestHooks.printBenchStatusLineForTest(false, "progress");
  });

  assert.deepEqual(textMode.stdout, ["progress"]);
  assert.deepEqual(textMode.stderr, []);
});

test("benchmark JSON-capable progress and legacy report prefaces use JSON-aware status output", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(
    source,
    /onTaskComplete:[\s\S]*?printBenchStatusLine\(\s*parsed\.json,/,
  );
  assert.match(
    source,
    /printBenchStatusLine\(json,\s*`Report saved to \$\{reportPath \?\? "benchmarks\/report\.json"\}`\)/,
  );
  assert.match(
    source,
    /printBenchStatusLine\(parsed\.json,\s*`Resuming from: \$\{path\.basename\(latestStatusPath\)\}`\)/,
  );
});

test("benchmark fallback artifacts are included in repro manifest inputs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(
    source,
    /const fallbackResultPath = await runBenchViaFallback\([^;]+;\s*writtenPaths\.push\(fallbackResultPath\);[\s\S]*?writeBenchReproManifestForPackageRun\(\{[\s\S]*?resultPaths: writtenPaths,/,
  );
});
