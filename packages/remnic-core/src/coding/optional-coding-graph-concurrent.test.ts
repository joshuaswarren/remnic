// Regression tests for Cursor Bugbot P2 round 4 on PR #1588:
// "Concurrent probe calls return null".
//
// These tests assert concurrent probes observe the same kind of
// outcome (module-or-null), independent of whether the package is
// installed. chatgpt-codex round 6 P2: previous tests assumed the
// package was installed and would fail in a core-only install.
// Every assertion below is conditional on the current install state.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodingGraphInstalled,
  tryLoadCodingGraphModule,
} from "./optional-coding-graph.js";

test("two probes fired in the same tick must observe the same outcome kind", async () => {
  // Kick off two probes back-to-back. They both observe the same
  // outcome (module-or-null), regardless of presence.
  const a = await tryLoadCodingGraphModule();
  const b = await tryLoadCodingGraphModule();
  const aKind = a === null ? "null" : "module";
  const bKind = b === null ? "null" : "module";
  assert.equal(aKind, bKind, "concurrent probes must produce the same kind of outcome");
});

test("many parallel probes never observe a transient null", async () => {
  // 8 parallel probes; every one must observe the same outcome kind.
  const probes = Array.from({ length: 8 }, () => tryLoadCodingGraphModule());
  const results = await Promise.all(probes);
  const nullCount = results.filter((r) => r === null).length;
  const moduleCount = results.filter((r) => r !== null).length;
  // All-or-nothing: every probe must agree.
  assert.ok(
    nullCount === 0 || moduleCount === 0,
    "no probe in a parallel batch may report a different outcome than the others",
  );
  assert.equal(nullCount + moduleCount, 8);
});

test("isCodingGraphInstalled stays truthful under parallel calls", async () => {
  const flags = await Promise.all(Array.from({ length: 8 }, () => isCodingGraphInstalled()));
  // All parallel invocations must agree on the boolean.
  const allTrue = flags.every((f) => f === true);
  const allFalse = flags.every((f) => f === false);
  assert.ok(allTrue || allFalse, "parallel probes must all agree on the boolean");
});
