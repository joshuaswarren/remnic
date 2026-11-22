
import { createHash } from "node:crypto";

import type {
  GeneratedRepo,
  SyntheticEdge,
  SyntheticFileIR,
  SyntheticRepoConfig,
  SyntheticSymbol,
} from "./types.js";

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
  const edgesByFile: SyntheticEdge[][] = [];
  let totalLoc = 0;

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

  let edgeCount = 0;
  for (let i = 0; i < allSymbols.length; i++) {
    const src = allSymbols[i];
    const edgeRolls = Math.ceil(config.callDensity * 3); // up to 3 potential edges
    for (let e = 0; e < edgeRolls; e++) {
      if (rng() > config.callDensity) continue;
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
