/**
 * detect_changes + blast radius tests (issue #1553).
 *
 * Blast-radius rubric fixtures: a fixture graph where the same change
 * yields direct/near/transitive classifications; fan-in escalation
 * boundary tested at the exact threshold.
 *
 * detect_changes output for a fixture diff is byte-stable (same diff +
 * graph → same output, regardless of Set iteration order).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GraphStore,
  type EdgeIR,
  type StoreFileIR,
  type SymbolIR,
} from "./graph-store.js";
import {
  classifyRisk,
  computeBlastRadius,
  findDirectlyAffectedSymbols,
  byteSpanToLines,
  rangesOverlap,
  FAN_IN_ESCALATION_THRESHOLD,
} from "./detect-changes.js";
import type { DiffHunk } from "./git-invoker.js";
import type { FileIR } from "@remnic/core";

// ──────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────────

function sym(
  qualifiedName: string,
  name: string,
  startByte: number,
  endByte: number,
  kind: SymbolIR["kind"] = "function",
): SymbolIR {
  return { qualifiedName, name, span: { startByte, endByte }, kind };
}

function edge(
  srcQualifiedName: string,
  dstQualifiedName: string,
  type = "CALLS",
  confidence = 0.9,
  provenance: EdgeIR["provenance"] = "heuristic",
): EdgeIR {
  return { srcQualifiedName, dstQualifiedName, type, confidence, provenance };
}

async function tempStore(): Promise<{ store: GraphStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "detect-changes-test-"));
  const store = await GraphStore.open({
    dbPath: path.join(dir, "graph.sqlite"),
    repoRoot: dir,
  });
  return { store, dir };
}

async function dispose(store: GraphStore, dir: string): Promise<void> {
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────────
// Line-range overlap tests (rule 35: half-open intervals)
// ──────────────────────────────────────────────────────────────────────────

test("rangesOverlap: half-open boundaries", () => {
  // [1,5) vs [5,10) → NO overlap (boundary touch)
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 5, endLine: 10 }),
    false,
  );
  // [1,5) vs [4,10) → overlap
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 4, endLine: 10 }),
    true,
  );
  // [1,5) vs [1,5) → overlap (same range)
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 1, endLine: 5 }),
    true,
  );
  // [1,5) vs [0,1) → NO overlap (hunk ends exactly at symbol start)
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 0, endLine: 1 }),
    false,
  );
  // Single-line: [3,4) vs [3,4) → overlap
  assert.equal(
    rangesOverlap({ startLine: 3, endLine: 4 }, { startLine: 3, endLine: 4 }),
    true,
  );
});

test("byteSpanToLines: basic conversion", () => {
  const content = new TextEncoder().encode("line1\nline2\nline3");
  // Bytes 0-5 = "line1" → lines {1, 2} (exclusive end)
  const r1 = byteSpanToLines(content, 0, 5);
  assert.equal(r1.startLine, 1);
  assert.equal(r1.endLine, 2);
  // Bytes 6-11 = "line2" → lines {2, 3}
  const r2 = byteSpanToLines(content, 6, 11);
  assert.equal(r2.startLine, 2);
  assert.equal(r2.endLine, 3);
});

// ──────────────────────────────────────────────────────────────────────────
// Risk classification rubric
// ──────────────────────────────────────────────────────────────────────────

test("classifyRisk: depth → risk mapping", () => {
  assert.equal(classifyRisk(0, 0), "direct");
  assert.equal(classifyRisk(1, 0), "near");
  assert.equal(classifyRisk(2, 0), "transitive");
  assert.equal(classifyRisk(3, 0), "transitive");
});

test("classifyRisk: fan-in escalation at exact threshold", () => {
  // Threshold is 5. At threshold-1 (4), no escalation.
  assert.equal(classifyRisk(1, FAN_IN_ESCALATION_THRESHOLD - 1), "near");
  // At threshold (5), near → direct.
  assert.equal(classifyRisk(1, FAN_IN_ESCALATION_THRESHOLD), "direct");
  // At threshold (5), transitive → near.
  assert.equal(classifyRisk(2, FAN_IN_ESCALATION_THRESHOLD), "near");
  // Direct stays direct (capped).
  assert.equal(classifyRisk(0, FAN_IN_ESCALATION_THRESHOLD), "direct");
});

// ──────────────────────────────────────────────────────────────────────────
// Blast-radius fixtures — same change yields direct/near/transitive
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fixture: a → b → c → d (chain). Changing `a` should classify:
 *   a → direct (depth 0)
 *   (nothing calls a, so no near/transitive from a)
 *
 * Changing `d` should classify via reverse BFS:
 *   d → direct (depth 0)
 *   c → near (depth 1, c calls d)
 *   b → transitive (depth 2, b calls c)
 *   a → transitive (depth 3, a calls b)
 */
const CHAIN_FILE: StoreFileIR = {
  path: "src/chain.ts",
  language: "typescript",
  contentHash: "h-chain",
  symbols: [
    sym("chain.a", "a", 0, 10),
    sym("chain.b", "b", 10, 20),
    sym("chain.c", "c", 20, 30),
    sym("chain.d", "d", 30, 40),
  ],
  edges: [
    edge("chain.a", "chain.b"), // a calls b
    edge("chain.b", "chain.c"), // b calls c
    edge("chain.c", "chain.d"), // c calls d
  ],
};

test("computeBlastRadius: chain fixture — d changed yields direct/near/transitive", async () => {
  const { store, dir } = await tempStore();
  try {
    const result = await store.upsertFileBatch([CHAIN_FILE]);
    assert.equal(result.ok, true);

    // Simulate: `d` is directly affected. Reverse BFS finds who depends on d.
    const affected = computeBlastRadius(store, new Set(["chain.d"]), 3);
    assert.equal(affected.length, 4);

    // d is direct (depth 0).
    const d = affected.find((a) => a.qualifiedName === "chain.d");
    assert.ok(d);
    assert.equal(d!.risk, "direct");
    assert.equal(d!.depth, 0);

    // c is near (depth 1 — c calls d).
    const c = affected.find((a) => a.qualifiedName === "chain.c");
    assert.ok(c);
    assert.equal(c!.risk, "near");
    assert.equal(c!.depth, 1);

    // b is transitive (depth 2).
    const b = affected.find((a) => a.qualifiedName === "chain.b");
    assert.ok(b);
    assert.equal(b!.risk, "transitive");
    assert.equal(b!.depth, 2);

    // a is transitive (depth 3).
    const a = affected.find((a) => a.qualifiedName === "chain.a");
    assert.ok(a);
    assert.equal(a!.risk, "transitive");
    assert.equal(a!.depth, 3);
  } finally {
    await dispose(store, dir);
  }
});

test("computeBlastRadius: byte-stable — same input, same output", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.upsertFileBatch([CHAIN_FILE]);

    const affected1 = computeBlastRadius(store, new Set(["chain.d"]), 3);
    const affected2 = computeBlastRadius(store, new Set(["chain.d"]), 3);

    // Deep equal — same order, same classifications.
  assert.deepEqual(
    affected1.map((a) => ({ q: a.qualifiedName, r: a.risk, d: a.depth })),
    affected2.map((a) => ({ q: a.qualifiedName, r: a.risk, d: a.depth })),
  );
  } finally {
    await dispose(store, dir);
  }
});

test("computeBlastRadius: empty affected set → empty result", async () => {
  const { store, dir } = await tempStore();
  try {
    const affected = computeBlastRadius(store, new Set(), 3);
    assert.equal(affected.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

/**
 * Fixture for fan-in escalation:
 *   caller1 → mid → target
 *   caller2 → mid
 *   caller3 → mid
 *   caller4 → mid
 *   caller5 → mid
 *
 * When `target` is directly affected:
 *   target → direct (depth 0)
 *   mid → near (depth 1, mid calls target). mid has fanIn=5 ≥ threshold.
 *        Fan-in escalates near → direct.
 *   caller1-5 → transitive (depth 2).
 */
const FAN_IN_FILE: StoreFileIR = {
  path: "src/fanin.ts",
  language: "typescript",
  contentHash: "h-fanin",
  symbols: [
    sym("fanin.target", "target", 0, 10),
    sym("fanin.mid", "mid", 10, 20),
    sym("fanin.caller1", "caller1", 20, 30),
    sym("fanin.caller2", "caller2", 30, 40),
    sym("fanin.caller3", "caller3", 40, 50),
    sym("fanin.caller4", "caller4", 50, 60),
    sym("fanin.caller5", "caller5", 60, 70),
  ],
  edges: [
    edge("fanin.mid", "fanin.target"),
    edge("fanin.caller1", "fanin.mid"),
    edge("fanin.caller2", "fanin.mid"),
    edge("fanin.caller3", "fanin.mid"),
    edge("fanin.caller4", "fanin.mid"),
    edge("fanin.caller5", "fanin.mid"),
  ],
};

test("computeBlastRadius: fan-in escalation — mid escalates near→direct", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.upsertFileBatch([FAN_IN_FILE]);

    // Change target. mid is 1 hop away (near) but has fanIn=5 ≥ 5.
    const affected = computeBlastRadius(store, new Set(["fanin.target"]), 3);
    const mid = affected.find((a) => a.qualifiedName === "fanin.mid");
    assert.ok(mid, "mid should be in blast radius");
    assert.equal(mid!.depth, 1);
    // Fan-in escalates near → direct.
    assert.equal(mid!.risk, "direct");
    assert.ok(mid!.fanIn >= FAN_IN_ESCALATION_THRESHOLD);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// findDirectlyAffectedSymbols — hunk → span overlap
// ──────────────────────────────────────────────────────────────────────────

test("findDirectlyAffectedSymbols: hunk overlapping a symbol span", () => {
  const content = new TextEncoder().encode("function foo() {\n  return 1;\n}\n");
  // foo spans bytes 0-23 (lines 1-3).
  const ir: FileIR = {
    path: "src/a.ts",
    language: "typescript",
    contentHash: "h",
    symbols: [
      {
        kind: "function",
        name: "foo",
        qualifiedName: "a::foo",
        span: { startByte: 0, endByte: 23 },
      },
    ],
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
  };
  const hunks = new Map<string, readonly DiffHunk[]>([
    ["src/a.ts", [{ path: "src/a.ts", newRange: { startLine: 2, endLine: 3 } }]],
  ]);
  const irs = new Map([["src/a.ts", ir]]);
  const contents = new Map([["src/a.ts", content]]);
  const affected = findDirectlyAffectedSymbols(hunks, irs, contents);
  assert.ok(affected.has("a::foo"));
});

test("findDirectlyAffectedSymbols: hunk NOT overlapping → not affected", () => {
  // Content with clear line boundaries:
  // Line 1: "function foo() {"
  // Line 2: "  return 1;"
  // Line 3: "}"
  // Line 4: "function bar() {}"
  // Byte layout: "function foo() {\n  return 1;\n}\nfunction bar() {}\n"
  // foo = bytes [0, 31) = lines [1, 4)
  // bar = bytes [31, 49) = line [4, 5)
  const content = new TextEncoder().encode("function foo() {\n  return 1;\n}\nfunction bar() {}\n");
  const fooEnd = "function foo() {\n  return 1;\n}\n".length; // 31
  const ir: FileIR = {
    path: "src/a.ts",
    language: "typescript",
    contentHash: "h",
    symbols: [
      {
        kind: "function",
        name: "foo",
        qualifiedName: "a::foo",
        span: { startByte: 0, endByte: fooEnd },
      },
      {
        kind: "function",
        name: "bar",
        qualifiedName: "a::bar",
        span: { startByte: fooEnd, endByte: content.length },
      },
    ],
    imports: [],
    exports: [],
    callSites: [],
    routes: [],
  };
  // Hunk on line 4 (bar's line), not foo (lines 1-3).
  const hunks = new Map<string, readonly DiffHunk[]>([
    ["src/a.ts", [{ path: "src/a.ts", newRange: { startLine: 4, endLine: 5 } }]],
  ]);
  const irs = new Map([["src/a.ts", ir]]);
  const contents = new Map([["src/a.ts", content]]);
  const affected = findDirectlyAffectedSymbols(hunks, irs, contents);
  assert.ok(!affected.has("a::foo"), "foo should NOT be affected");
  assert.ok(affected.has("a::bar"), "bar should be affected");
});

// ──────────────────────────────────────────────────────────────────────────
// cursor Bugbot fix — filePath resolution for duplicate simple names
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fixture: two files both declaring a symbol named `foo` (same simple
 * name, different qualified names). a.ts::foo CALLS b.ts::foo. When b's
 * foo changes, the blast radius must report a.ts::foo with filePath
 * `src/a.ts` — NOT the wrong file resolved by a name-only search.
 *
 * Before the fix, computeBlastRadius resolved filePath via searchGraph
 * ({ namePattern: "foo", limit: 1 }), which could attach either file's
 * path to the affected symbol (cursor Bugbot: 'Blast radius wrong file
 * path'). The fix reads filePath straight from the traverse hit.
 */
const DUP_A: StoreFileIR = {
  path: "src/a.ts",
  language: "typescript",
  contentHash: "h-dup-a",
  symbols: [sym("a.foo", "foo", 0, 30)],
  edges: [edge("a.foo", "b.foo")], // a.ts::foo calls b.ts::foo
  exports: [],
};
const DUP_B: StoreFileIR = {
  path: "src/b.ts",
  language: "typescript",
  contentHash: "h-dup-b",
  symbols: [sym("b.foo", "foo", 0, 30)],
  edges: [],
  exports: [],
};

test("computeBlastRadius: duplicate simple names keep the correct filePath (cursor Bugbot: 'Blast radius wrong file path')", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.upsertFileBatch([DUP_A, DUP_B]);

    // b.foo changed directly. Reverse BFS finds a.foo (a calls b).
    const affected = computeBlastRadius(store, new Set(["b.foo"]), 3);
    // Both symbols appear (b.foo direct, a.foo near).
    assert.equal(affected.length, 2);

    const aHit = affected.find((x) => x.qualifiedName === "a.foo");
    assert.ok(aHit, "a.foo is in the blast radius (it calls the changed b.foo)");
    // The load-bearing assertion: a.foo's filePath is src/a.ts, not the
    // wrong src/b.ts that a name-only search could return.
    assert.equal(aHit!.filePath, "src/a.ts");

    const bHit = affected.find((x) => x.qualifiedName === "b.foo");
    assert.ok(bHit);
    assert.equal(bHit!.filePath, "src/b.ts");
    assert.equal(bHit!.risk, "direct");
  } finally {
    await dispose(store, dir);
  }
});
