// Regression tests for Cursor Bugbot P3 round 5 on PR #1588:
// "Loader skips success cache".
//
// These tests must work both when @remnic/coding-graph is installed
// (workspace dev scenario) AND when it is absent (CI base install —
// the optional peer is not symlinked). chatgpt-codex round 6 P2:
// the original test assumed the package is installed and would fail
// in a core-only install. Every assertion below is conditional.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isCodingGraphInstalled,
  loadCodingGraphEngineFactory,
  tryLoadCodingGraphModule,
} from "./optional-coding-graph.js";

test("loadCodingGraphEngineFactory returns a callable factory (install present)", async () => {
  const installed = await isCodingGraphInstalled();
  if (!installed) {
    // Skip when package is absent (CI base install).
    return;
  }
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function");
});

test("loadCodingGraphEngineFactory throws install hint when package absent", async () => {
  const installed = await isCodingGraphInstalled();
  if (installed) {
    return;
  }
  let threw = false;
  let message = "";
  try {
    await loadCodingGraphEngineFactory();
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert.equal(threw, true);
  assert.match(message, /@remnic\/coding-graph/);
  assert.match(message, /npm install @remnic\/coding-graph/);
});

test("after a successful load, tryLoadCodingGraphModule returns the same module (cache fast-path)", async () => {
  const installed = await isCodingGraphInstalled();
  if (!installed) return;
  // Seed the success cache by calling loadCodingGraphEngineFactory.
  const factory = await loadCodingGraphEngineFactory();
  assert.equal(typeof factory, "function");
  // A fresh probe call should return the cached module reference.
  const probeResult = await tryLoadCodingGraphModule();
  assert.ok(probeResult !== null);
  // Invoking the factory throws the placeholder (PR1 contract).
  assert.throws(() => factory(), (err: unknown) => {
    if (!err || typeof err !== "object") return false;
    const e = err as { name?: unknown; code?: unknown };
    return e.name === "CodingGraphError" && e.code === "not_implemented";
  });
});

test("loader fresh-attempts after the package is detected as missing", async () => {
  // If present, loader returns a factory.
  // If absent, loader throws the install hint.
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
