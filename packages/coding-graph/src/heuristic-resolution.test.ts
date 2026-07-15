/**
 * Phase A heuristic edge resolution tests (issue #1891).
 *
 * deriveHeuristicEdges: pure function FileIR[] → per-file EdgeIR[] + stats.
 * The store's pass-2 (batch map + full-DB dst fallback, conservative
 * ambiguity drops) does final id resolution; this module only decides
 * WHICH (srcQualifiedName → dstQualifiedName, CALLS) assertions a fresh
 * parse supports, so every emitted edge must be derivable from the IR
 * alone.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveHeuristicEdges,
  HEURISTIC_CONFIDENCE_SAME_FILE,
  HEURISTIC_CONFIDENCE_IMPORT_BOUND,
} from "./heuristic-resolution.js";
import type { EdgeIR, FileIR } from "./graph-store.js";

function firstFile(result: { files: readonly { edges: readonly EdgeIR[] }[] }): { edges: readonly EdgeIR[] } {
  const file = result.files[0];
  assert.ok(file, "expected at least one file in the result");
  return file;
}

function fileIR(overrides: Partial<FileIR> & { path: string }): FileIR {
  return {
    language: "typescript",
    contentHash: `h-${overrides.path}`,
    symbols: [],
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
    ...overrides,
  } as FileIR;
}

const span = (startByte: number, endByte: number) => ({ startByte, endByte });

test("same-file call resolves to a CALLS edge with heuristic provenance", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
      { kind: "function", name: "format", qualifiedName: "format", span: span(71, 132) },
    ],
    callSites: [{ calleeNameCandidates: ["format"], span: span(40, 46) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.equal(result.files.length, 1);
  assert.deepEqual(firstFile(result).edges, [
    {
      srcQualifiedName: "greet",
      dstQualifiedName: "format",
      type: "CALLS",
      confidence: HEURISTIC_CONFIDENCE_SAME_FILE,
      provenance: "heuristic",
    },
  ]);
  assert.equal(stats.callSites, 1);
  assert.equal(stats.resolved, 1);
});

test("import-bound cross-file call emits an edge for the store to resolve", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(30, 110) },
    ],
    imports: [{ module: "./main", importedNames: ["greet"], span: span(0, 29) }],
    callSites: [{ calleeNameCandidates: ["greet"], span: span(60, 67) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(firstFile(result).edges, [
    {
      srcQualifiedName: "shout",
      dstQualifiedName: "greet",
      type: "CALLS",
      confidence: HEURISTIC_CONFIDENCE_IMPORT_BOUND,
      provenance: "heuristic",
      dstPathHint: "main",
    },
  ]);
});

test("unresolvable bare names are skipped and counted, never emitted", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 70) },
    ],
    callSites: [{ calleeNameCandidates: ["log"], span: span(20, 25) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedUnresolved, 1);
  assert.equal(stats.resolved, 0);
});

test("call site outside any symbol span is skipped and counted", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "format", qualifiedName: "format", span: span(50, 100) },
    ],
    // Top-level call before the first symbol.
    callSites: [{ calleeNameCandidates: ["format"], span: span(0, 8) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedNoEnclosingSymbol, 1);
});

test("innermost enclosing symbol wins as src (nested spans)", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "class", name: "Outer", qualifiedName: "Outer", span: span(0, 200) },
      { kind: "method", name: "run", qualifiedName: "Outer.run", span: span(20, 120) },
      { kind: "function", name: "helper", qualifiedName: "helper", span: span(210, 260) },
    ],
    callSites: [{ calleeNameCandidates: ["helper"], span: span(60, 68) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(firstFile(result).edges[0]?.srcQualifiedName, "Outer.run");
});

test("ambiguous same-file name is skipped conservatively and counted", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "run", qualifiedName: "run", span: span(0, 50) },
      // Same bare name at a different span (e.g. overload-style duplicate).
      { kind: "function", name: "format", qualifiedName: "a.format", span: span(60, 100) },
      { kind: "function", name: "format", qualifiedName: "b.format", span: span(110, 150) },
    ],
    callSites: [{ calleeNameCandidates: ["format"], span: span(20, 28) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedAmbiguous, 1);
});

test("second callee candidate is tried when the first cannot resolve", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "run", qualifiedName: "run", span: span(0, 50) },
      { kind: "function", name: "fallback", qualifiedName: "fallback", span: span(60, 100) },
    ],
    callSites: [{ calleeNameCandidates: ["missing", "fallback"], span: span(10, 20) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(firstFile(result).edges[0]?.dstQualifiedName, "fallback");
  assert.equal(stats.resolved, 1);
});

test("recursive self-call emits a self edge", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "walk", qualifiedName: "walk", span: span(0, 90) },
    ],
    callSites: [{ calleeNameCandidates: ["walk"], span: span(40, 46) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(firstFile(result).edges.map((e: EdgeIR) => [e.srcQualifiedName, e.dstQualifiedName]), [
    ["walk", "walk"],
  ]);
});

test("duplicate src→dst call sites are deduped to one edge", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 90) },
      { kind: "function", name: "format", qualifiedName: "format", span: span(100, 150) },
    ],
    callSites: [
      { calleeNameCandidates: ["format"], span: span(20, 26) },
      { calleeNameCandidates: ["format"], span: span(50, 56) },
    ],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(stats.callSites, 2);
  assert.equal(stats.resolved, 2);
});

test("files with no call sites assert an explicit empty edge set", () => {
  const ir = fileIR({
    path: "empty.ts",
    symbols: [
      { kind: "function", name: "solo", qualifiedName: "solo", span: span(0, 20) },
    ],
  });
  const result = deriveHeuristicEdges([ir]);
  // Empty ARRAY (not undefined): the fresh parse asserts "no heuristic
  // edges", so stale heuristic edges from a prior version are cleaned up.
  assert.deepEqual(firstFile(result).edges, []);
});

test("output is deterministic and byte-stable across runs (rule 38)", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "a", qualifiedName: "a", span: span(0, 40) },
      { kind: "function", name: "b", qualifiedName: "b", span: span(50, 90) },
      { kind: "function", name: "c", qualifiedName: "c", span: span(100, 140) },
    ],
    callSites: [
      { calleeNameCandidates: ["c"], span: span(10, 12) },
      { calleeNameCandidates: ["b"], span: span(20, 22) },
    ],
  });
  const one = JSON.stringify(deriveHeuristicEdges([ir]));
  const two = JSON.stringify(deriveHeuristicEdges([ir]));
  assert.equal(one, two);
});

test("a nested symbol under a different parent is NOT visible to a sibling caller", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "outer", qualifiedName: "outer", span: span(0, 100) },
      { kind: "function", name: "helper", qualifiedName: "outer.helper", span: span(10, 60) },
      { kind: "function", name: "run", qualifiedName: "run", span: span(110, 180) },
    ],
    callSites: [{ calleeNameCandidates: ["helper"], span: span(130, 138) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, [], "outer.helper is not in run's lexical scope");
  assert.equal(stats.skippedUnresolved, 1);
});

test("shadowing: the innermost visible declaration wins over a top-level one", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "greet", qualifiedName: "greet", span: span(0, 100) },
      { kind: "function", name: "format", qualifiedName: "greet.format", span: span(10, 50) },
      { kind: "function", name: "format", qualifiedName: "format", span: span(110, 160) },
    ],
    callSites: [{ calleeNameCandidates: ["format"], span: span(60, 68) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(
    firstFile(result).edges[0]?.dstQualifiedName,
    "greet.format",
    "the nested declaration shadows the top-level one for calls inside greet",
  );
});

test("a caller's own nested declaration is visible to it", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "outer", qualifiedName: "outer", span: span(0, 100) },
      { kind: "function", name: "helper", qualifiedName: "outer.helper", span: span(10, 40) },
    ],
    // Call inside outer but outside helper.
    callSites: [{ calleeNameCandidates: ["helper"], span: span(60, 68) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(
    firstFile(result).edges.map((e: EdgeIR) => [e.srcQualifiedName, e.dstQualifiedName]),
    [["outer", "outer.helper"]],
  );
});

test("external-package imports never bind bare names (no false in-repo edges)", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(30, 110) },
    ],
    imports: [{ module: "lodash", importedNames: ["map"], span: span(0, 29) }],
    callSites: [{ calleeNameCandidates: ["map"], span: span(60, 65) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, [], "lodash's map must not bind an in-repo symbol");
  assert.equal(stats.skippedUnresolved, 1);
});

test("relative-module imports bind with a normalized in-repo hint", () => {
  const ir = fileIR({
    path: "src/util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(30, 110) },
    ],
    imports: [{ module: "../lib/main.js", importedNames: ["greet"], span: span(0, 29) }],
    callSites: [{ calleeNameCandidates: ["greet"], span: span(60, 67) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(firstFile(result).edges[0]?.confidence, HEURISTIC_CONFIDENCE_IMPORT_BOUND);
  assert.equal(firstFile(result).edges[0]?.dstPathHint, "lib/main");
});

test("an import escaping the repo root never binds (cursor review)", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(30, 110) },
    ],
    // dirname("util.ts") = "." so ../lib escapes the repo root — files.path
    // is canonical and can never match a "../" hint.
    imports: [{ module: "../lib/main.js", importedNames: ["greet"], span: span(0, 29) }],
    callSites: [{ calleeNameCandidates: ["greet"], span: span(60, 67) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedUnresolved, 1);
});

test("member-access call sites never bind bare names (codex review)", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "function", name: "run", qualifiedName: "run", span: span(0, 90) },
      { kind: "function", name: "connect", qualifiedName: "connect", span: span(100, 150) },
    ],
    // client.connect() — the property name matches a visible bare symbol
    // but the receiver decides the target; Phase A must skip it.
    callSites: [{ calleeNameCandidates: ["connect"], memberAccess: true, span: span(30, 40) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedMemberAccess, 1);
});

test("aliased imports bind by local name and emit the exported dst (codex review)", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(30, 110) },
    ],
    imports: [
      {
        module: "./main",
        importedNames: ["greet"],
        bindings: [{ exported: "greet", local: "salute" }],
        span: span(0, 29),
      },
    ],
    // Call site uses the LOCAL alias...
    callSites: [{ calleeNameCandidates: ["salute"], span: span(60, 68) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.equal(firstFile(result).edges.length, 1);
  // ...but the edge's dst is the EXPORTED name in the target file.
  assert.equal(firstFile(result).edges[0]?.dstQualifiedName, "greet");
  assert.equal(firstFile(result).edges[0]?.dstPathHint, "main");
});

test("an ambiguous first candidate does not block a later candidate's import binding (cursor review)", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "shout", qualifiedName: "shout", span: span(40, 120) },
      { kind: "function", name: "dup", qualifiedName: "a.dup", span: span(130, 160) },
      { kind: "function", name: "dup", qualifiedName: "b.dup", span: span(170, 200) },
    ],
    imports: [{ module: "./main", importedNames: ["greet"], span: span(0, 29) }],
    callSites: [{ calleeNameCandidates: ["dup", "greet"], span: span(60, 70) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.equal(firstFile(result).edges.length, 1);
  assert.equal(firstFile(result).edges[0]?.dstQualifiedName, "greet");
  assert.equal(firstFile(result).edges[0]?.dstPathHint, "main");
});

test("python dot-style relative imports bind with package-path hints (cursor review)", () => {
  const ir = fileIR({
    path: "pkg/app/views.py",
    language: "python",
    symbols: [
      { kind: "function", name: "render", qualifiedName: "render", span: span(30, 110) },
    ],
    imports: [
      { module: ".models", importedNames: ["User"], span: span(0, 25) },
      { module: "..lib.utils", importedNames: ["helper"], span: span(26, 55) },
    ],
    callSites: [
      { calleeNameCandidates: ["User"], span: span(60, 64) },
      { calleeNameCandidates: ["helper"], span: span(70, 76) },
    ],
  });
  const result = deriveHeuristicEdges([ir]);
  const hints = firstFile(result).edges.map((e: EdgeIR) => [e.dstQualifiedName, e.dstPathHint]);
  assert.deepEqual(hints, [
    ["User", "pkg/app/models"],
    ["helper", "pkg/lib/utils"],
  ]);
});

test("python dot-style import escaping the root never binds", () => {
  const ir = fileIR({
    path: "views.py",
    language: "python",
    symbols: [
      { kind: "function", name: "render", qualifiedName: "render", span: span(30, 110) },
    ],
    imports: [{ module: "..outside", importedNames: ["thing"], span: span(0, 25) }],
    callSites: [{ calleeNameCandidates: ["thing"], span: span(60, 65) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(firstFile(result).edges, []);
});

test("same exported name from two modules yields two hinted edges (codex review)", () => {
  const ir = fileIR({
    path: "util.ts",
    symbols: [
      { kind: "function", name: "run", qualifiedName: "run", span: span(60, 160) },
    ],
    imports: [
      { module: "./a", importedNames: ["foo"], bindings: [{ exported: "foo", local: "fooA" }], span: span(0, 28) },
      { module: "./b", importedNames: ["foo"], bindings: [{ exported: "foo", local: "fooB" }], span: span(29, 57) },
    ],
    callSites: [
      { calleeNameCandidates: ["fooA"], span: span(80, 86) },
      { calleeNameCandidates: ["fooB"], span: span(100, 106) },
    ],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(
    firstFile(result).edges.map((e: EdgeIR) => [e.dstQualifiedName, e.dstPathHint]),
    [
      ["foo", "a"],
      ["foo", "b"],
    ],
  );
});

test("a bare call inside a method never binds a sibling method (codex review round 8)", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "class", name: "C", qualifiedName: "C", span: span(0, 200) },
      { kind: "method", name: "run", qualifiedName: "C.run", span: span(10, 100) },
      { kind: "method", name: "helper", qualifiedName: "C.helper", span: span(110, 190) },
      { kind: "function", name: "helper", qualifiedName: "helper", span: span(210, 260) },
    ],
    // bare helper() inside C.run — this.helper() would be memberAccess.
    callSites: [{ calleeNameCandidates: ["helper"], span: span(40, 48) }],
  });
  const result = deriveHeuristicEdges([ir]);
  assert.deepEqual(
    firstFile(result).edges.map((e: EdgeIR) => [e.srcQualifiedName, e.dstQualifiedName]),
    [["C.run", "helper"]],
    "binds the file-level function, never the sibling method C.helper",
  );
});

test("with only a sibling method available, a bare call stays unresolved", () => {
  const ir = fileIR({
    path: "main.ts",
    symbols: [
      { kind: "class", name: "C", qualifiedName: "C", span: span(0, 200) },
      { kind: "method", name: "run", qualifiedName: "C.run", span: span(10, 100) },
      { kind: "method", name: "helper", qualifiedName: "C.helper", span: span(110, 190) },
    ],
    callSites: [{ calleeNameCandidates: ["helper"], span: span(40, 48) }],
  });
  const result = deriveHeuristicEdges([ir]);
  const { stats } = result;
  assert.deepEqual(firstFile(result).edges, []);
  assert.equal(stats.skippedUnresolved, 1);
});
