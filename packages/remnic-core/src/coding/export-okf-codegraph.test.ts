// Focused regression for the codegraph OKF projection (issue #1950).
//
// Fixture: a two-file synthetic repo indexed into a real GraphStore via the
// optional-engine loader (never a static optional-package import), plus a
// supersede pair + one accepted ADR and an architecture-card memory in the
// project's coding namespace. Covers the issue's acceptance set: bundle
// shape + verbatim card, determinism, truncation with a legal broken link,
// the --symbols ladder, gating refusals, and store-byte immutability.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginConfig } from "../types.js";
import { StorageManager } from "../storage.js";
import { serializeDecisionRecord, type DecisionRecord } from "./decision-records.js";
import { getCodegraphStore, resolveCodegraphDbPath } from "./codegraph-runtime.js";
import { isCodingGraphInstalled } from "./optional-coding-graph.js";

import {
  DEFAULT_OKF_CODEGRAPH_MAX_MODULE_CONCEPTS,
  OKF_CODEGRAPH_TRUNCATION_MARKER,
  exportCodegraphOkfBundle,
  parseOkfCodegraphSymbolFilter,
} from "./export-okf-codegraph.js";

const PROJECT_ID = "p1";
const CARD_MARKDOWN = "# Demo Repo\n\nLanguages: typescript\n\nModules: 2\n";

const GATE_ON_CONFIG = {
  codingKnowledge: {
    enabled: true,
    codegraphTools: true,
    decisionRecords: true,
    codegraphDbDir: "",
  },
} as unknown as PluginConfig;

interface Fixture {
  memoryDir: string;
  repoDir: string;
  dbPath: string;
  sqliteBefore: string;
}

async function seedGraphStore(memoryDir: string): Promise<string> {
  const dbPath = resolveCodegraphDbPath({
    config: GATE_ON_CONFIG,
    memoryDir,
    principal: "default",
    projectId: PROJECT_ID,
  });
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = await getCodegraphStore({
    config: GATE_ON_CONFIG,
    memoryDir,
    principal: "default",
    projectId: PROJECT_ID,
  });

  const big = await store.upsertFileBatch?.([
    {
      path: "src/big.ts",
      language: "typescript" as const,
      contentHash: "h-big",
      symbols: [
        { kind: "function" as const, name: "alpha", qualifiedName: "big.alpha", span: { startByte: 0, endByte: 10 } },
        { kind: "function" as const, name: "beta", qualifiedName: "big.beta", span: { startByte: 10, endByte: 20 } },
        { kind: "type" as const, name: "internal", qualifiedName: "big.internal", span: { startByte: 20, endByte: 30 } },
      ],
      exports: [{ name: "alpha", span: { startByte: 0, endByte: 5 } }],
      edges: [
        {
          srcQualifiedName: "big.alpha",
          dstQualifiedName: "small.zulu",
          type: "CALLS",
          confidence: 0.95,
          provenance: "heuristic",
        },
        {
          srcQualifiedName: "big.beta",
          dstQualifiedName: "small.zulu",
          type: "IMPORTS",
          confidence: 0.4,
          provenance: "heuristic",
        },
      ],
    },
    {
      path: "src/small.ts",
      language: "typescript" as const,
      contentHash: "h-small",
      symbols: [
        { kind: "function" as const, name: "zulu", qualifiedName: "small.zulu", span: { startByte: 0, endByte: 8 } },
      ],
      exports: [{ name: "zulu", span: { startByte: 0, endByte: 4 } }],
    },
  ]);
  assert.equal(big?.ok, true, `upsertFileBatch failed: ${JSON.stringify(big)}`);
  return dbPath;
}

async function writeAdr(
  storage: StorageManager,
  record: DecisionRecord,
  options: { status?: "archived" } = {},
): Promise<void> {
  await storage.writeMemory("decision", serializeDecisionRecord(record), {
    source: "coding-decision",
    tags: ["decision-record"],
    structuredAttributes: { decisionStatus: record.status },
    ...(options.status ? { status: options.status } : {}),
  });
}

async function seedNamespace(memoryDir: string): Promise<void> {
  const namespaceDir = path.join(memoryDir, "namespaces", "project-p1");
  const storage = new StorageManager(namespaceDir);
  await storage.ensureDirectories();
  // Accepted ADR with an explicit id.
  await writeAdr(storage, {
    id: "ADR-0001",
    title: "Use SQLite for the graph store",
    status: "accepted",
    context: "The graph needs a local queryable store.",
    decision: "Store the code graph in per-project SQLite files.",
    consequences: "Reads stay local; no server required.",
    entityRefs: [],
  });
  // Supersede pair in the production shape: frontmatter id left EMPTY (the
  // memory id is canonical) and the replacement carries `supersedes`.
  await writeAdr(
    storage,
    {
      id: "",
      title: "Single-pass indexing",
      status: "superseded",
      context: "Initial indexing approach.",
      decision: "Index everything in one pass.",
      consequences: undefined,
      entityRefs: [],
    },
    { status: "archived" },
  );
  await writeAdr(storage, {
    id: "",
    title: "Incremental indexing",
    status: "accepted",
    context: "Single-pass reindexes were too slow.",
    decision: "Index only files whose content hash changed.",
    consequences: undefined,
    entityRefs: [],
    supersedes: "ADR-0002",
  });
  // Architecture card memory (surface classification: fact + tag + cardKind).
  await storage.writeMemory("fact", CARD_MARKDOWN, {
    source: "coding-architecture",
    tags: ["architecture-card"],
    structuredAttributes: { cardKind: "architecture" },
  });
}

async function makeFixture(): Promise<Fixture> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-cg-mem-"));
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-cg-repo-"));
  const dbPath = await seedGraphStore(memoryDir);
  await seedNamespace(memoryDir);
  return {
    memoryDir,
    repoDir,
    dbPath,
    sqliteBefore: sha256File(dbPath),
  };
}

async function requireEngine(t: { skip: (reason: string) => void }): Promise<boolean> {
  if (await isCodingGraphInstalled()) return true;
  t.skip("@remnic/coding-graph is optional and not installed");
  return false;
}


function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collectFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(path.join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

async function exportBundle(fx: Fixture, outDir: string, overrides: Record<string, unknown> = {}) {
  return exportCodegraphOkfBundle({
    config: GATE_ON_CONFIG,
    memoryDir: fx.memoryDir,
    projectId: PROJECT_ID,
    outDir,
    cwd: fx.repoDir,
    ...overrides,
  } as Parameters<typeof exportCodegraphOkfBundle>[0]);
}

test("parseOkfCodegraphSymbolFilter defaults to exported and rejects unknowns", () => {
  assert.equal(parseOkfCodegraphSymbolFilter(undefined), "exported");
  assert.equal(parseOkfCodegraphSymbolFilter("ALL"), "all");
  assert.equal(parseOkfCodegraphSymbolFilter("none"), "none");
  assert.throws(() => parseOkfCodegraphSymbolFilter("some"), /allowed:/);
  assert.equal(DEFAULT_OKF_CODEGRAPH_MAX_MODULE_CONCEPTS, 500);
});

test("exportCodegraphOkfBundle writes the full bundle: card verbatim, ADRs, modules, edges", async (t) => {
  if (!(await requireEngine(t))) return;
  const fx = await makeFixture();
  const out = path.join(fx.memoryDir, "out-a");
  try {
    const result = await exportBundle(fx, out);
    assert.equal(result.moduleConcepts, 2);
    assert.equal(result.moduleFilesInGraph, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.decisions, 3);
    assert.equal(result.architectureCard, true);

    // Root index carries the version stamp + counts.
    const root = await readFile(path.join(out, "index.md"), "utf8");
    assert.match(root, /okf_version: "0.1"/);
    assert.match(root, /- code modules: 2 of 2 indexed files/);
    assert.equal(root.includes(OKF_CODEGRAPH_TRUNCATION_MARKER), false);

    // Architecture card: OKF type frontmatter + stored body verbatim
    // (storage-layer attribute suffix stripped).
    const arch = await readFile(path.join(out, "architecture.md"), "utf8");
    assert.match(arch, /type: Architecture Card/);
    assert.ok(arch.includes(CARD_MARKDOWN.trimEnd()), "card body must be verbatim");
    assert.equal(arch.includes("[Attributes:"), false);

    // Decisions: all three statuses exported with type + original keys.
    const decisionFiles = collectFiles(path.join(out, "decisions")).sort();
    assert.deepEqual(
      decisionFiles.filter((f) => f !== "index.md"),
      ["ADR-0001.md", "ADR-0002.md", "ADR-0003.md"],
    );
    const adr1 = await readFile(path.join(out, "decisions", "ADR-0001.md"), "utf8");
    assert.match(adr1, /type: Decision Record/);
    assert.match(adr1, /title: Use SQLite for the graph store/);
    assert.match(adr1, /status: accepted/);
    assert.match(adr1, /# Decision/);
    const adr3 = await readFile(path.join(out, "decisions", "ADR-0003.md"), "utf8");
    assert.match(adr3, /- supersedes: \[ADR-0002\]\(\/decisions\/ADR-0002\.md\)/);
    const decisionsIndex = await readFile(path.join(out, "decisions", "index.md"), "utf8");
    // ACTIVE statuses listed before superseded.
    assert.ok(decisionsIndex.indexOf("## Accepted") < decisionsIndex.indexOf("## Superseded"));

    // Modules: one concept per file; symbols table (exported default);
    // edges under # Dependencies with kind prose + bundle-relative links.
    const big = await readFile(path.join(out, "modules", "src", "big.ts.md"), "utf8");
    assert.match(big, /type: Code Module/);
    assert.match(big, /title: src\/big\.ts/);
    assert.match(big, /description: 3 symbols, typescript/);
    assert.match(big, /tags:\n  - typescript/);
    assert.match(big, /# Symbols/);
    assert.match(big, /\| alpha \| function \| 0-10 \|/);
    assert.equal(big.includes("internal"), false, "unexported symbol hidden by default");
    assert.match(big, /# Dependencies/);
    assert.match(big, /- calls: \[zulu\(\) in src\/small\.ts\]\(\/modules\/src\/small\.ts\.md\) \(confidence: high\)/);
    assert.match(big, /- imports: \[src\/small\.ts\]\(\/modules\/src\/small\.ts\.md\) \(confidence: low\)/);
    const modulesIndex = await readFile(path.join(out, "modules", "index.md"), "utf8");
    assert.match(modulesIndex, /## src/);

    // Read-only guarantee: the store's bytes are unchanged.
    assert.equal(sha256File(fx.dbPath), fx.sqliteBefore);
  } finally {
    await rm(fx.memoryDir, { recursive: true, force: true });
    await rm(fx.repoDir, { recursive: true, force: true });
  }
});

test("exportCodegraphOkfBundle is byte-stable for an unchanged graph", async (t) => {
  if (!(await requireEngine(t))) return;
  const fx = await makeFixture();
  const outA = path.join(fx.memoryDir, "det-a");
  const outB = path.join(fx.memoryDir, "det-b");
  try {
    await exportBundle(fx, outA);
    await exportBundle(fx, outB);
    assert.deepEqual(collectFiles(outA), collectFiles(outB));
    for (const rel of collectFiles(outA)) {
      assert.equal(
        await readFile(path.join(outA, rel), "utf8"),
        await readFile(path.join(outB, rel), "utf8"),
        `${rel} must be byte-identical across exports`,
      );
    }
  } finally {
    await rm(fx.memoryDir, { recursive: true, force: true });
    await rm(fx.repoDir, { recursive: true, force: true });
  }
});

test("truncation keeps the most-symbolic file, notices in the root index, keeps broken links", async (t) => {
  if (!(await requireEngine(t))) return;
  const fx = await makeFixture();
  const out = path.join(fx.memoryDir, "out-trunc");
  try {
    const result = await exportBundle(fx, out, { maxModuleConcepts: 1 });
    assert.equal(result.moduleConcepts, 1);
    assert.equal(result.moduleFilesInGraph, 2);
    assert.equal(result.truncated, true);
    assert.equal(existsSync(path.join(out, "modules", "src", "small.ts.md")), false);
    const root = await readFile(path.join(out, "index.md"), "utf8");
    assert.match(root, new RegExp(OKF_CODEGRAPH_TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The edge to the truncated target survives as a legal broken link.
    const big = await readFile(path.join(out, "modules", "src", "big.ts.md"), "utf8");
    assert.match(big, /\(\/modules\/src\/small\.ts\.md\) \(confidence: high\) \(link target not exported\)/);
    assert.equal(sha256File(fx.dbPath), fx.sqliteBefore);
  } finally {
    await rm(fx.memoryDir, { recursive: true, force: true });
    await rm(fx.repoDir, { recursive: true, force: true });
  }
});

test("--symbols none|all changes only the # Symbols tables", async (t) => {
  if (!(await requireEngine(t))) return;
  const fx = await makeFixture();
  const outNone = path.join(fx.memoryDir, "sym-none");
  const outAll = path.join(fx.memoryDir, "sym-all");
  try {
    await exportBundle(fx, outNone, { symbols: "none" });
    await exportBundle(fx, outAll, { symbols: "all" });
    const noneBig = await readFile(path.join(outNone, "modules", "src", "big.ts.md"), "utf8");
    const allBig = await readFile(path.join(outAll, "modules", "src", "big.ts.md"), "utf8");
    assert.equal(noneBig.includes("# Symbols"), false);
    assert.match(allBig, /\| internal \| type \| 20-30 \|/);
    // Frontmatter and Dependencies are identical across the two filters.
    assert.equal(noneBig.split("# Dependencies")[0].split("# Symbols")[0], allBig.split("# Symbols")[0]);
    assert.equal(
      `# Dependencies${noneBig.split("# Dependencies")[1]}`,
      `# Dependencies${allBig.split("# Dependencies")[1]}`,
    );
  } finally {
    await rm(fx.memoryDir, { recursive: true, force: true });
    await rm(fx.repoDir, { recursive: true, force: true });
  }
});

test("gating: disabled config and unknown project produce tagged actionable refusals", async (t) => {
  const out = path.join(os.tmpdir(), `okf-cg-gate-${process.pid}`);
  await assert.rejects(
    exportCodegraphOkfBundle({
      config: { codingKnowledge: { enabled: false } } as unknown as PluginConfig,
      memoryDir: os.tmpdir(),
      projectId: PROJECT_ID,
      outDir: out,
    }),
    (err: unknown) => err instanceof Error && "code" in err && (err as { code: string }).code === "disabled",
  );
  if (!(await requireEngine(t))) return;
  const fx = await makeFixture();
  try {
    await assert.rejects(
      exportBundle(fx, path.join(fx.memoryDir, "out-gate"), { projectId: "nope" }),
      (err: unknown) =>
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "project_not_found" &&
        /known projects: .*p1/.test(err.message),
    );
  } finally {
    await rm(fx.memoryDir, { recursive: true, force: true });
    await rm(fx.repoDir, { recursive: true, force: true });
  }
});

