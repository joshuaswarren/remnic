#!/usr/bin/env node
/**
 * Pre-push gate: types.ts is imported by every production module via the
 * `PluginConfig` interface and the type-only interfaces it exports. Pulling a
 * runtime module (storage, extraction, orchestration, lifecycle) into types.ts
 * — even via a `type`-only re-export — drags that module's import graph into
 * the DTS worker, which has OOM'd at ~320 MB on branches that mixed a new
 * config interface in.
 *
 * The rule: `types.ts` may import type-only from leaf modules. When its import
 * graph reaches a heavy runtime module, the addition must move into a sibling
 * leaf module re-exported by types.ts (RecognitionTierSettings precedent).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TYPES_FILE = "packages/remnic-core/src/types.ts";

// Files whose own import graph fans out into the DTS worker enough to OOM it.
// The cycle class that bit us: types.ts -> a sibling interface module ->
// storage.ts (or orchestrator.ts). Reaching the leaf sibling is fine; reaching
// a HEAVY entry point is what exhausts the heap.
const HEAVY_MODULES = [
  "packages/remnic-core/src/storage.ts",
  "packages/remnic-core/src/extraction.ts",
  "packages/remnic-core/src/orchestrator.ts",
];

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot })
    .toString()
    .split("\n")
    .filter((f) => f.startsWith("packages/") && f.endsWith(".ts"));
}

const FILES = new Set(trackedFiles());

function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = dirname(fromFile);
  // Drop query/hash suffixes that some bundlers emit.
  const raw = spec.split("?")[0].split("#")[0];
  // Drop trailing "/index" or extension variants.
  const stripped = raw.replace(/\.js$/, ".ts");
  const candidates = [
    join(base, stripped),
    join(base, stripped, "index.ts"),
  ];
  for (const c of candidates) {
    if (FILES.has(c)) return c;
  }
  return null;
}

function buildGraph() {
  const importRe = /^\s*import(?:\s+type)?\s+(?:[^'"]+from\s+)?["']([^"']+)["']/gm;
  const graph = new Map();
  for (const f of FILES) {
    const src = readFileSync(join(repoRoot, f), "utf8");
    const set = new Set();
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const target = resolve(f, m[1]);
      if (target) set.add(target);
    }
    graph.set(f, set);
  }
  return graph;
}

function reaches(graph, root, targets) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const t of targets) {
      if (cur === t || cur.startsWith(t)) return cur;
    }
    const next = graph.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return null;
}

const graph = buildGraph();
if (!graph.has(TYPES_FILE)) {
  console.log("[types-import-cycle] types.ts not tracked; skipping");
  process.exit(0);
}
const hit = reaches(graph, TYPES_FILE, HEAVY_MODULES);
if (!hit) {
  console.log("[types-import-cycle] OK — types.ts import graph stays out of runtime modules");
  process.exit(0);
}
console.error(
  "[types-import-cycle] types.ts transitively reaches heavy runtime module: " +
    hit +
    ". Move the added interface into a sibling leaf module re-exported by types.ts (RecognitionTierSettings precedent).",
);
process.exit(1);
