import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import { createBenchStatusPath, initBenchStatus } from "./bench-status.js";

test("createBenchStatusPath scopes status files per run", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-status-"));

  const firstPath = createBenchStatusPath(resultsDir, 111, 1_710_000_000_000);
  const secondPath = createBenchStatusPath(resultsDir, 222, 1_710_000_000_001);

  assert.notEqual(firstPath, secondPath);
  assert.match(firstPath, /bench-status-1710000000000-111\.json$/);
  assert.match(secondPath, /bench-status-1710000000001-222\.json$/);

  await initBenchStatus(firstPath, ["longmemeval"], 111);
  await initBenchStatus(secondPath, ["locomo"], 222);

  const files = (await readdir(resultsDir)).sort();
  assert.deepEqual(files, [
    "bench-status-1710000000000-111.json",
    "bench-status-1710000000001-222.json",
  ]);
});
