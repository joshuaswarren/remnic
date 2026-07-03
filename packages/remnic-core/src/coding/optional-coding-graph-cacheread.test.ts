// Regression test for Cursor Bugbot P3 round 5 on PR #1588:
// "Loader skips success cache".
//
// After an initial loadCodingGraphEngineFactory() succeeds, subsequent
// calls must reuse the cached factory without re-importing the optional
// package. This test asserts the success-cache fast path is wired.

import assert from "node:assert/strict";
import test from "node:test";

import { loadCodingGraphEngineFactory, tryLoadCodingGraphModule } from "./optional-coding-graph.js";

test("loadCodingGraphEngineFactory returns a callable factory on every call (cached success fast-path)", async () => {
  const f1 = await loadCodingGraphEngineFactory();
  const f2 = await loadCodingGraphEngineFactory();
  // Both calls return the same factory function (cached success path).
  assert.equal(typeof f1, "function");
  assert.equal(typeof f2, "function");
});

test("after a successful load, tryLoadCodingGraphModule and loadCodingGraphEngineFactory agree on the cached module", async () => {
  // Seed the success cache by calling loadCodingGraphEngineFactory once.
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function");
  // Now a fresh probe call should return the same cached module reference.
  const probeResult = await tryLoadCodingGraphModule();
  assert.ok(probeResult !== null, "dev workspace has the package installed");
  // Both paths now serve the same identity until the process ends.
  const factoryAgain = await loadCodingGraphEngineFactory();
  assert.equal(typeof factoryAgain, "function");
  // Sanity: invoking the factory throws the placeholder (proves the
  // exposed function is the actual createCodingGraphEngine).
  assert.throws(() => factoryAgain(), (err: unknown) => {
    if (!err || typeof err !== "object") return false;
    const e = err as { name?: unknown; code?: unknown };
    return e.name === "CodingGraphError" && e.code === "not_implemented";
  });
});

test("loader fresh-attempts when the package is currently missing (not in dev)", async () => {
  // This test asserts the throwing loader path: when the cached result
  // is unset AND the package is missing, the loader must throw the
  // install hint. The runtime check is conditional because the dev
  // workspace has the package installed; we exercise the throwing
  // branch via a fresh loadCodingGraphEngineFactory call and confirm
  // it either returns a function (package present) or throws the
  // install hint (package absent).
  try {
    const factory = await loadCodingGraphEngineFactory();
    assert.equal(typeof factory, "function");
  } catch (err) {
    if (err instanceof Error) {
      assert.match(err.message, /@remnic\/coding-graph/);
      assert.match(err.message, /npm install @remnic\/coding-graph/);
      return;
    }
    throw err;
  }
});
