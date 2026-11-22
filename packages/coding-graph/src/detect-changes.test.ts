import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GraphStore,
  nodeIdFor,
  type EdgeIR,
  type StoreFileIR,
  type SymbolIR,
} from "./graph-store.js";
import {
  classifyRisk,
  computeBlastRadius,
  type AffectedSymbol,
  findDirectlyAffectedSymbols,
  byteSpanToLines,
  rangesOverlap,
  FAN_IN_ESCALATION_THRESHOLD,
} from "./detect-changes.js";
import type { DiffHunk } from "./git-invoker.js";
import type { FileIR } from "@remnic/core";

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

function blast(
  store: GraphStore,
  ids: ReadonlySet<string>,
  depth: number,
): readonly AffectedSymbol[] {
  const r = computeBlastRadius(store, ids, depth);
  if (!r.ok) throw new Error("expected blast radius ok in characterization test");
  return r.affected;
}

async function dispose(store: GraphStore, dir: string): Promise<void> {
  await store.close();
  await rm(dir, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("rangesOverlap: half-open boundaries", () => {
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 5, endLine: 10 }),
    false,
  );
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 4, endLine: 10 }),
    true,
  );
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 1, endLine: 5 }),
    true,
  );
  assert.equal(
    rangesOverlap({ startLine: 1, endLine: 5 }, { startLine: 0, endLine: 1 }),
    false,
  );
  assert.equal(
    rangesOverlap({ startLine: 3, endLine: 4 }, { startLine: 3, endLine: 4 }),
    true,
  );
});

test("byteSpanToLines: basic conversion", () => {
  const content = new TextEncoder().encode("line1\nline2\nline3");
  const r1 = byteSpanToLines(content, 0, 5);
  assert.equal(r1.startLine, 1);
  assert.equal(r1.endLine, 2);
  const r2 = byteSpanToLines(content, 6, 11);
  assert.equal(r2.startLine, 2);
  assert.equal(r2.endLine, 3);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("classifyRisk: depth → risk mapping", () => {
  assert.equal(classifyRisk(0, 0), "direct");
  assert.equal(classifyRisk(1, 0), "near");
  assert.equal(classifyRisk(2, 0), "transitive");
  assert.equal(classifyRisk(3, 0), "transitive");
});

test("classifyRisk: fan-in escalation at exact threshold", () => {
  assert.equal(classifyRisk(1, FAN_IN_ESCALATION_THRESHOLD - 1), "near");
  assert.equal(classifyRisk(1, FAN_IN_ESCALATION_THRESHOLD), "direct");
  assert.equal(classifyRisk(2, FAN_IN_ESCALATION_THRESHOLD), "near");
  assert.equal(classifyRisk(0, FAN_IN_ESCALATION_THRESHOLD), "direct");
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

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

    const affected = blast(store, new Set(["chain.d"]), 3);
    assert.equal(affected.length, 4);

    const d = affected.find((a) => a.qualifiedName === "chain.d");
    assert.ok(d);
    assert.equal(d!.risk, "direct");
    assert.equal(d!.depth, 0);

    const c = affected.find((a) => a.qualifiedName === "chain.c");
    assert.ok(c);
    assert.equal(c!.risk, "near");
    assert.equal(c!.depth, 1);

    const b = affected.find((a) => a.qualifiedName === "chain.b");
    assert.ok(b);
    assert.equal(b!.risk, "transitive");
    assert.equal(b!.depth, 2);

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

    const affected1 = blast(store, new Set(["chain.d"]), 3);
    const affected2 = blast(store, new Set(["chain.d"]), 3);

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
    const affected = blast(store, new Set(), 3);
    assert.equal(affected.length, 0);
  } finally {
    await dispose(store, dir);
  }
});

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

    const affected = blast(store, new Set(["fanin.target"]), 3);
    const mid = affected.find((a) => a.qualifiedName === "fanin.mid");
    assert.ok(mid, "mid should be in blast radius");
    assert.equal(mid!.depth, 1);
    assert.equal(mid!.risk, "direct");
    assert.ok(mid!.fanIn >= FAN_IN_ESCALATION_THRESHOLD);
  } finally {
    await dispose(store, dir);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("findDirectlyAffectedSymbols: hunk overlapping a symbol span", () => {
  const content = new TextEncoder().encode("function foo() {\n  return 1;\n}\n");
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
  // Returns node ids (qualifiedName + filePath + label identity).
  assert.ok(
    affected.has(nodeIdFor({ qualifiedName: "a::foo", filePath: "src/a.ts", label: "function" })),
    "foo's node id is affected",
  );
});

test("findDirectlyAffectedSymbols: hunk NOT overlapping → not affected", () => {
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
  const hunks = new Map<string, readonly DiffHunk[]>([
    ["src/a.ts", [{ path: "src/a.ts", newRange: { startLine: 4, endLine: 5 } }]],
  ]);
  const irs = new Map([["src/a.ts", ir]]);
  const contents = new Map([["src/a.ts", content]]);
  const affected = findDirectlyAffectedSymbols(hunks, irs, contents);
  assert.ok(
    !affected.has(nodeIdFor({ qualifiedName: "a::foo", filePath: "src/a.ts", label: "function" })),
    "foo should NOT be affected",
  );
  assert.ok(
    affected.has(nodeIdFor({ qualifiedName: "a::bar", filePath: "src/a.ts", label: "function" })),
    "bar should be affected",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

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

    const affected = blast(store, new Set(["b.foo"]), 3);
    assert.equal(affected.length, 2);

    const aHit = affected.find((x) => x.qualifiedName === "a.foo");
    assert.ok(aHit, "a.foo is in the blast radius (it calls the changed b.foo)");
    assert.equal(aHit!.filePath, "src/a.ts");

    const bHit = affected.find((x) => x.qualifiedName === "b.foo");
    assert.ok(bHit);
    assert.equal(bHit!.filePath, "src/b.ts");
    assert.equal(bHit!.risk, "direct");
  } finally {
    await dispose(store, dir);
  }
});


test("findDirectlyAffectedSymbols: duplicate qualifiedName across files yields distinct node ids (chatgpt-codex-connector: 'Preserve node identity')", () => {
  const content = new TextEncoder().encode("function fn() {}\n");
  const irA: FileIR = {
    path: "src/a.ts", language: "typescript", contentHash: "h",
    symbols: [{ kind: "function", name: "fn", qualifiedName: "dup::fn", span: { startByte: 0, endByte: 16 } }],
    imports: [], exports: [], callSites: [], routes: [],
  };
  const irB: FileIR = {
    path: "src/b.ts", language: "typescript", contentHash: "h",
    symbols: [{ kind: "function", name: "fn", qualifiedName: "dup::fn", span: { startByte: 0, endByte: 16 } }],
    imports: [], exports: [], callSites: [], routes: [],
  };
  const hunks = new Map<string, readonly DiffHunk[]>([
    ["src/a.ts", [{ path: "src/a.ts", newRange: { startLine: 1, endLine: 2 } }]],
    ["src/b.ts", [{ path: "src/b.ts", newRange: { startLine: 1, endLine: 2 } }]],
  ]);
  const irs = new Map([["src/a.ts", irA], ["src/b.ts", irB]]);
  const contents = new Map([["src/a.ts", content], ["src/b.ts", content]]);
  const affected = findDirectlyAffectedSymbols(hunks, irs, contents);
  const idA = nodeIdFor({ qualifiedName: "dup::fn", filePath: "src/a.ts", label: "function" });
  const idB = nodeIdFor({ qualifiedName: "dup::fn", filePath: "src/b.ts", label: "function" });
  assert.notEqual(idA, idB, "node ids must differ by filePath");
  assert.ok(affected.has(idA), "a.ts node affected");
  assert.ok(affected.has(idB), "b.ts node affected");
});

test("computeBlastRadius: byte-stable sort with duplicate qualifiedNames (cursor Bugbot: 'Blast radius sort not byte-stable')", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.upsertFileBatch([DUP_A, DUP_B]);
    const r1 = blast(store, new Set(["b.foo"]), 3);
    const r2 = blast(store, new Set(["b.foo"]), 3);
    assert.deepEqual(
      r1.map((a) => ({ q: a.qualifiedName, f: a.filePath, r: a.risk })),
      r2.map((a) => ({ q: a.qualifiedName, f: a.filePath, r: a.risk })),
    );
    assert.equal(r1.length, 2);
    assert.equal(new Set(r1.map((a) => a.filePath)).size, 2);
  } finally {
    await dispose(store, dir);
  }
});


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("computeBlastRadius: store failure surfaces as store_error, not masked as empty (rule 22)", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.upsertFileBatch([CHAIN_FILE]);
    const ids = new Set(["chain.d"]);
    const ok = computeBlastRadius(store, ids, 3);
    assert.equal(ok.ok, true);

    await store.close();
    const failed = computeBlastRadius(store, ids, 3);
    assert.equal(failed.ok, false);
    if (failed.ok) throw new Error("expected store_error");
    assert.equal(failed.code, "store_error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
