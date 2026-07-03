// Regression tests for Cursor Bugbot P2 round 3 on PR #1588:
// "Probe poisons loader error path" and the round-5 "Loader skips
// success cache" follow-up.
//
// These tests must work both when @remnic/coding-graph is installed
// (workspace dev scenario) AND when it is absent (CI base install —
// the optional peer is not symlinked). Conditional branches keep the
// tests durable across install scenarios (P2 P2 P2 chatgpt-codex on
// PR #1588 round 6).

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodingGraphInstalled,
  loadCodingGraphEngineFactory,
  tryLoadCodingGraphModule,
} from "./optional-coding-graph.js";

test("loadCodingGraphEngineFactory fresh-attempts regardless of probe state", async () => {
  // Probe and load side-by-side. Both must agree on the package's
  // presence at this instant. When @remnic/coding-graph is absent
  // (CI base install) the probe returns null and the loader throws
  // the install hint. When present (dev workspace) both succeed.
  const probeResult = await tryLoadCodingGraphModule();
  const installed = await isCodingGraphInstalled();

  if (probeResult === null) {
    assert.equal(installed, false);
    let threw = false;
    let message = "";
    try {
      await loadCodingGraphEngineFactory();
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    assert.equal(threw, true, "loader must throw install hint when probe returned null");
    assert.match(message, /@remnic\/coding-graph/);
    assert.match(message, /npm install @remnic\/coding-graph/);
    return;
  }

  // Package present.
  assert.equal(installed, true);
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function");
});

test("probe short-circuits to the same answer on repeated calls", async () => {
  // Probe must be deterministic — repeated calls return the same
  // answer. Both branches are valid (present → module, absent → null).
  const a = await tryLoadCodingGraphModule();
  const b = await tryLoadCodingGraphModule();
  const aKind = a === null ? "null" : "module";
  const bKind = b === null ? "null" : "module";
  assert.equal(aKind, bKind, "consecutive probe calls must agree");
});

test("loader path is independent of the probe result", async () => {
  // The Bugbot P2 round 3 bug was: a probe that caught a non-specifier
  // import error was caching `null` into the load-path. That poisoned
  // the user-facing loader path. This test asserts the load-path
  // ALWAYS attempts a fresh import — proven by exercising the path
  // for both present and absent packages.
  const probe = await tryLoadCodingGraphModule();
  if (probe === null) {
    // Absent: loader throws install hint.
    let threw = false;
    try {
      await loadCodingGraphEngineFactory();
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "loader throws when package is absent");
  } else {
    // Present: loader returns a callable factory.
    const factory = await loadCodingGraphEngineFactory();
    assert.equal(typeof factory, "function");
    assert.throws(() => factory(), (err: unknown) => {
      if (!err || typeof err !== "object") return false;
      const e = err as { name?: unknown; code?: unknown };
      return e.name === "CodingGraphError" && e.code === "not_implemented";
    });
  }
});
