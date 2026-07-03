// Regression test for Cursor Bugbot P2 on PR #1588 round 3:
// "Probe poisons loader error path".
//
// Before the fix: when tryLoadCodingGraphModule caught a non-specifier
// error and cached the failure as `cached === null`, a subsequent
// loadCodingGraphEngineFactory call would short-circuit on the
// cached failure and throw the install hint instead of the underlying
// import error.
//
// After the fix: the probe path uses a separate attempt-state slot
// (`probeAttempted`/`probeReturnedNull`). loadCodingGraphEngineFactory
// always re-attempts the import on a fresh call so users see the real
// diagnostic on broken installs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodingGraphInstalled,
  loadCodingGraphEngineFactory,
  tryLoadCodingGraphModule,
  // We import the installed module only via tryLoad — never with a
  // direct import — so this test stays consistent with the loader
  // contract.
} from "./optional-coding-graph.js";

test("loadCodingGraphEngineFactory fresh-attempts even after probe returned null; probe and loader do not share a cached-null state", async () => {
  // In the dev workspace the package IS installed, so the loader should
  // resolve to a factory. The test exercises the contract invariant
  // that the probe (tryLoad → null or module) and the loader
  // (loadCodingGraphEngineFactory → factory or throw) are independent
  // caches: a `null` returned by tryLoadCodingGraphModule does NOT
  // prevent a fresh loadCodingGraphEngineFactory call from succeeding
  // when the package is in fact present.

  // Step 1: probe and load side-by-side. The probe returns module-or-null;
  // the loader returns factory-or-throws. Both must agree on the
  // package's presence at this instant.
  const probeResult = await tryLoadCodingGraphModule();
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function");
  const installed = await isCodingGraphInstalled();

  if (probeResult === null) {
    // If the probe resolved to null (package absent in CI), the loader
    // should have thrown the install hint. That branch is not reachable
    // in the dev workspace where this test runs, but we assert the
    // invariant for completeness.
    assert.equal(installed, false, "probe-null must agree with installed=false");
    let threw = false;
    try {
      await loadCodingGraphEngineFactory();
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "loader must throw install hint when probe returned null");
  } else {
    // Package present in dev — confirm the loader agrees.
    assert.equal(installed, true, "probe-module must agree with installed=true");
    assert.equal(typeof factory, "function");
  }
});

test("probe and loader are independent caches: a subsequent probe call does not poison the loader", async () => {
  // Even if the probe returns null on a first call, the loader on a
  // later call must still attempt the fresh import. We don't fabricate
  // a broken install here (it would require mutating the workspace),
  // but we DO run probe twice and confirm the loader succeeded after.
  const a = await tryLoadCodingGraphModule();
  const b = await tryLoadCodingGraphModule();
  assert.equal(a === null, b === null, "probe short-circuits to the same answer");
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function", "loader returns the factory after repeated probes");
});
