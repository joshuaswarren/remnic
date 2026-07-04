// Tests for the optional @remnic/coding-graph loader.
//
// Prove-fail-before (CLAUDE.md rule 6 / issue #1551): the loader throws a
// user-facing install hint that names the exact `npm install
// @remnic/coding-graph` command when the optional package is absent. We
// verify the hint surface via the exported `buildInstallHint` helper so
// the test exercises the same code path as the live loader without
// depending on whether the package is currently installed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodingGraphInstallHint,
  isSpecifierNotFoundErrorForCodingGraph,
  loadCodingGraphEngineFactory,
  tryLoadCodingGraphModule,
  isCodingGraphInstalled,
} from "./optional-coding-graph.js";

const CODING_GRAPH_SPECIFIER = "@remnic/coding-graph";

test("buildCodingGraphInstallHint names the exact npm install command and package name", () => {
  const hint = buildCodingGraphInstallHint();
  assert.match(
    hint,
    /@remnic\/coding-graph/,
    "hint must reference the package name",
  );
  assert.match(
    hint,
    /npm install @remnic\/coding-graph/,
    "hint must contain the exact install command for npm",
  );
  // pnpm and yarn install variants must also be present so users on any
  // package manager see a working command on first glance.
  assert.match(hint, /pnpm add @remnic\/coding-graph/);
  assert.match(hint, /yarn add @remnic\/coding-graph/);
});

test("isSpecifierNotFoundErrorForCodingGraph rejects ERR_MODULE_NOT_FOUND for unrelated specifiers", () => {
  // A broken *transitive* dependency inside the optional package must NOT
  // be reported as "package missing" — that's a different failure mode.
  const transitive = Object.assign(
    new Error("Cannot find package 'web-tree-sitter'"),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
  assert.equal(
    isSpecifierNotFoundErrorForCodingGraph(transitive),
    false,
    "transitive misses must not match the install-hint branch",
  );
});

test("isSpecifierNotFoundErrorForCodingGraph accepts ERR_MODULE_NOT_FOUND that names @remnic/coding-graph", () => {
  const direct = Object.assign(
    new Error(`Cannot find package '${CODING_GRAPH_SPECIFIER}'`),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
  assert.equal(
    isSpecifierNotFoundErrorForCodingGraph(direct),
    true,
    "the loader's miss branch must trigger for missing top-level package",
  );
});

test("loadCodingGraphEngineFactory returns a factory when @remnic/coding-graph is installed, throws hint when absent", async () => {
  // The loader throws only when the package is *missing*. In the workspace
  // today the package is installed (sibling workspace link), so we expect
  // a factory back. The throw-path contract is verified by
  // `isSpecifierNotFoundErrorForCodingGraph` + `buildCodingGraphInstallHint`
  // above; together they prove both halves of the loader's behavior.
  try {
    const factory = await loadCodingGraphEngineFactory();
    assert.equal(typeof factory, "function", "factory must be callable");
    // The PR1 placeholder factory is required to throw a tagged
    // CodingGraphError("not_implemented") — never return a fake engine.
    assert.throws(
      () => factory(),
      (err: unknown) => {
        if (!err || typeof err !== "object") return false;
        const e = err as { name?: unknown; code?: unknown; message?: unknown };
        return (
          e.name === "CodingGraphError" &&
          e.code === "not_implemented" &&
          typeof e.message === "string"
        );
      },
      "placeholder engine must throw CodingGraphError('not_implemented'), not return a fake engine",
    );
  } catch (err) {
    // If the loader throws (e.g. base install without the package), the
    // message must be the install hint.
    if (err instanceof Error) {
      assert.match(err.message, /@remnic\/coding-graph/);
      assert.match(err.message, /npm install @remnic\/coding-graph/);
      return;
    }
    throw err;
  }
});

test("tryLoadCodingGraphModule and isCodingGraphInstalled never throw and return module/null", async () => {
  const mod = await tryLoadCodingGraphModule();
  // Either installed (workspace dev) or absent (base install). Both are
  // valid; the invariant is "no throw + correct return type".
  if (mod === null) {
    assert.equal(mod, null);
  } else {
    assert.equal(typeof mod.createCodingGraphEngine, "function");
  }

  const installed = await isCodingGraphInstalled();
  assert.equal(typeof installed, "boolean");
  // Tautology with the call above — installed must match presence in mod.
  assert.equal(installed, mod !== null);
});
