// Regression test for Cursor Bugbot P2 round 4 on PR #1588:
// "Concurrent probe calls return null".
//
// Before the fix: tryLoadCodingGraphModule set `probeAttempted = true`
// synchronously before awaiting the import. A second probe call that
// fired before the first settled would observe `probeAttempted` and
// return `null` from the short-circuit, even when the first call was
// still in-flight and would have succeeded.
//
// After the fix: an in-flight promise slot means concurrent callers
// await the same `startProbeOnce()` promise. They either both see the
// module or both see null, depending on what the underlying import
// actually returns — never a transient "probe said null while loader
// would have succeeded" state.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodingGraphInstalled,
  tryLoadCodingGraphModule,
} from "./optional-coding-graph.js";

test("two probes fired in the same tick must observe the same outcome", async () => {
  // Kick off two probes back-to-back without awaiting them in between.
  // The fixture (dev workspace) has the package installed, so both
  // probes should resolve to a module, not null.
  const aP = tryLoadCodingGraphModule();
  const bP = tryLoadCodingGraphModule();
  const [a, b] = await Promise.all([aP, bP]);
  // Both resolve to the same "kind of outcome".
  const aKind = a === null ? "null" : "module";
  const bKind = b === null ? "null" : "module";
  assert.equal(
    aKind,
    bKind,
    "concurrent probes must produce the same kind of outcome",
  );
  // In the dev workspace, both should be modules.
  assert.ok(a !== null && b !== null, "dev workspace must resolve both probes to the same module");
  assert.equal(typeof a!.createCodingGraphEngine, "function");
  assert.equal(typeof b!.createCodingGraphEngine, "function");
});

test("many parallel probes never observe a transient null while a real result is pending", async () => {
  // 8 parallel probes; every one must observe the same outcome.
  const probes = Array.from({ length: 8 }, () => tryLoadCodingGraphModule());
  const results = await Promise.all(probes);
  const nullCount = results.filter((r) => r === null).length;
  const moduleCount = results.filter((r) => r !== null).length;
  assert.equal(nullCount, 0, "no probe in a parallel batch may report null when the package is installed");
  assert.equal(moduleCount, 8);
});

test("isCodingGraphInstalled stays truthful under parallel calls", async () => {
  const flags = await Promise.all(Array.from({ length: 8 }, () => isCodingGraphInstalled()));
  // All parallel invocations must agree on the boolean.
  const allTrue = flags.every((f) => f === true);
  const allFalse = flags.every((f) => f === false);
  assert.ok(allTrue || allFalse, "parallel probes must all agree on the boolean");
  // Dev workspace: package installed → all true.
  assert.ok(allTrue, "dev workspace has @remnic/coding-graph symlinked, expected all probes to be true");
});
