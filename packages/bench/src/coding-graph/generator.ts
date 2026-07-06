/**
 * Deterministic synthetic repo generator (issue #1557 design (a)).
 *
 * Produces {@link GeneratedRepo} — a set of synthetic StoreFileIR-shaped
 * files with symbols and CALLS edges. The generator is parameterized:
 * files × functions × call-density × language. Same seed + same params
 * always yields byte-identical output (rule 38 — generator determinism).
 *
 * The generator emits IR directly (not source code) because:
 *   1. The benchmark measures the GRAPH STORE, not the parser. Parser
 *      benchmarks are a separate concern (the parser has its own test
 *      suite in packages/coding-graph/src/engine/).
 *   2. Emitting IR avoids coupling the store benchmark to grammar
 *      availability, which varies by platform (rule 30).
 *   3. Synthetic IR is deterministic by construction — no parsing
 *      nondeterminism can leak into the benchmark.
 *
 * Public-repo policy: fixtures are synthetic only. No real source code
 * is committed or fetched by this generator. Pinned OSS repos are a
 * separate prepare step (issue step 4 — not this PR).
 */

import { createHash } from "node:crypto";

import type {
  GeneratedRepo,
  SyntheticEdge,
  SyntheticFileIR,
  SyntheticRepoConfig,
  SyntheticSymbol,
} from "./types.js";

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic, zero dependencies, sufficient
// quality for synthetic fixture generation (not crypto — rule 38 just needs
// reproducibility).
// ---------------------------------------------------------------------------

/**
 * Create a deterministic PRNG from a 32-bit seed. Returns a function that
 * produces floats in [0, 1). Same seed → identical sequence (rule 38).
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return function rng(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Symbol-kind distribution — mirrors the mix in a typical codebase.
// ---------------------------------------------------------------------------

const SYMBOL_KINDS = [
  "function",
  "function",
  "function",
  "method",
  "method",
  "class",
  "interface",
  "type",
] as const;

const EDGE_TYPE_WEIGHTS: ReadonlyArray<[string, number]> = [
  ["CALLS", 0.7],
  ["USES_TYPE", 0.2],
  ["IMPLEMENTS", 0.1],
];

const PROVENANCE_VALUES = ["heuristic", "heuristic", "heuristic", "trace"] as const;

// ---------------------------------------------------------------------------
// Approximate LOC — the generator doesn't produce source, but the report
// needs a LOC figure for the LOC/s metric. We compute it from symbol spans:
// each symbol's byte span / ~40 bytes per line gives a plausible LOC.
// ---------------------------------------------------------------------------

const AVG_BYTES_PER_LINE = 40;

function hashContent(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Generate a deterministic synthetic repo from the given config.
 *
 * Determinism guarantee (rule 38): calling this function twice with the
 * same {@link SyntheticRepoConfig} produces structurally identical output
 * — same files, same symbols, same edges, same byte spans, same hashes.
 */
export function generateSyntheticRepo(config: SyntheticRepoConfig): GeneratedRepo {
  const rng = createSeededRng(config.seed);
  const files: SyntheticFileIR[] = [];
  // Mutable per-file edge accumulator — edges are generated in phase 2
  // after all symbols exist, so we collect them here and assign at the end.
  const edgesByFile: SyntheticEdge[][] = [];
  let totalLoc = 0;

  // Phase 1: generate all symbols across all files. We materialize the
  // full symbol list first so cross-file edges can reference any symbol
  // in the repo (not just symbols in earlier files — that would bias the
  // call graph toward early files).
  const allSymbols: Array<{
    fileIndex: number;
    qualifiedName: string;
    name: string;
    kind: string;
  }> = [];

  for (let f = 0; f < config.fileCount; f++) {
    const filePath = `src/module_${f}/index.ts`;
    const symbols: SyntheticSymbol[] = [];
    let byteCursor = 0;

    for (let s = 0; s < config.symbolsPerFile; s++) {
      const kind = SYMBOL_KINDS[Math.floor(rng() * SYMBOL_KINDS.length)];
      const name = `${kind}_${f}_${s}`;
      const qualifiedName = `module_${f}.${name}`;

      // Symbol span — deterministic byte range. ~5-15 lines per symbol.
      const spanLines = 5 + Math.floor(rng() * 11);
      const spanBytes = spanLines * AVG_BYTES_PER_LINE;
      const startByte = byteCursor;
      const endByte = byteCursor + spanBytes;
      byteCursor = endByte;

      symbols.push({
        qualifiedName,
        name,
        kind,
        startByte,
        endByte,
      });

      allSymbols.push({ fileIndex: f, qualifiedName, name, kind });
    }

    totalLoc += Math.ceil(byteCursor / AVG_BYTES_PER_LINE);

    const fileEdges: SyntheticEdge[] = [];
    edgesByFile.push(fileEdges);
    files.push({
      path: filePath,
      language: config.language,
      contentHash: hashContent(`file_${f}_${config.seed}`),
      symbols,
      edges: fileEdges, // filled in phase 2
    });
  }

  // Phase 2: generate edges. For each symbol, with probability callDensity,
  // create an edge to another symbol. Edge targets are drawn from the
  // entire symbol pool so cross-file edges occur naturally.
  let edgeCount = 0;
  for (let i = 0; i < allSymbols.length; i++) {
    const src = allSymbols[i];
    // Each symbol generates 0-N edges based on callDensity.
    const edgeRolls = Math.ceil(config.callDensity * 3); // up to 3 potential edges
    for (let e = 0; e < edgeRolls; e++) {
      if (rng() > config.callDensity) continue;
      // Pick a target — not the same symbol.
      const targetIdx = Math.floor(rng() * allSymbols.length);
      if (targetIdx === i) continue;
      const dst = allSymbols[targetIdx];

      const edgeType = weightedPick(EDGE_TYPE_WEIGHTS, rng);
      const confidence = 0.5 + rng() * 0.5; // [0.5, 1.0)
      const provenance = PROVENANCE_VALUES[Math.floor(rng() * PROVENANCE_VALUES.length)];

      const edge: SyntheticEdge = {
        srcQualifiedName: src.qualifiedName,
        dstQualifiedName: dst.qualifiedName,
        type: edgeType,
        confidence,
        provenance,
      };

      edgesByFile[src.fileIndex].push(edge);
      edgeCount++;
    }
  }

  return {
    files,
    approximateLoc: totalLoc,
    config,
  };
}

function weightedPick(
  weights: ReadonlyArray<[string, number]>,
  rng: () => number,
): string {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, w] of weights) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return weights[weights.length - 1][0];
}

/**
 * Pick a random qualified name from the repo for query benchmarking.
 * Deterministic given the same seed (so trace/search benchmarks use a
 * stable start node across runs).
 */
export function pickStableQualifiedName(
  repo: GeneratedRepo,
  index: number,
): string {
  const allNames: string[] = [];
  for (const file of repo.files) {
    for (const sym of file.symbols) {
      allNames.push(sym.qualifiedName);
    }
  }
  if (allNames.length === 0) {
    throw new Error("generateSyntheticRepo: no symbols generated");
  }
  return allNames[index % allNames.length];
}
