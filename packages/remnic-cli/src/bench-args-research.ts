/**
 * Flag parsing for the research bench subcommands (`attribute`, `drift-gen`;
 * issue #1954), extracted from bench-args.ts under the structural ratchet
 * (issue #1995).
 */

import path from "node:path";
import type { BenchAction } from "./bench-args.js";
import { readBenchOptionValue } from "./bench-flags.js";
import { expandTilde } from "./path-utils.js";

export interface BenchResearchArgs {
  runRef?: string;
  memoryDir?: string;
  qmdPath?: string;
  collection?: string;
  users?: number;
  epochs?: number;
  seed?: number;
  out?: string;
  factsPerEpoch?: number;
  driftingRatio?: number;
  contradictedRatio?: number;
}

function readPositiveInteger(args: string[], flag: string): number | undefined {
  const raw = readBenchOptionValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`ERROR: ${flag} must be a positive safe integer.`);
  }
  return parsed;
}

function readUnitRatio(args: string[], flag: string): number | undefined {
  const raw = readBenchOptionValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`ERROR: ${flag} must be a number between 0 and 1.`);
  }
  return parsed;
}

export function parseBenchResearchArgs(
  action: BenchAction,
  args: string[],
): BenchResearchArgs {
  const runRef = readBenchOptionValue(args, "--run");
  if (action === "attribute" && !runRef) {
    throw new Error("ERROR: bench attribute requires --run <id>.");
  }

  const memoryDirRaw = readBenchOptionValue(args, "--memory-dir");
  const qmdPathRaw = readBenchOptionValue(args, "--qmd");
  const collection = readBenchOptionValue(args, "--collection");
  if (action === "attribute" && Boolean(qmdPathRaw) !== Boolean(collection)) {
    throw new Error("ERROR: --qmd <path> and --collection <name> must be provided together.");
  }
  if (collection !== undefined && collection.trim().length === 0) {
    throw new Error("ERROR: --collection requires a non-empty value.");
  }

  let seed: number | undefined;
  let out: string | undefined;
  if (action === "drift-gen") {
    const seedRaw = readBenchOptionValue(args, "--seed");
    if (seedRaw !== undefined) {
      const parsed = Number(seedRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("ERROR: --seed must be a non-negative safe integer.");
      }
      seed = parsed;
    }
    const outRaw = readBenchOptionValue(args, "--out");
    if (outRaw !== undefined) {
      out = path.resolve(expandTilde(outRaw));
    }
  }

  const epochs = readPositiveInteger(args, "--epochs");
  if (action === "drift-gen" && epochs !== undefined && epochs < 2) {
    throw new Error("ERROR: --epochs must be at least 2 (supersession needs two epochs).");
  }

  const driftingRatio = readUnitRatio(args, "--drifting-ratio");
  const contradictedRatio = readUnitRatio(args, "--contradicted-ratio");
  if ((driftingRatio ?? 0.2) + (contradictedRatio ?? 0.1) > 1) {
    throw new Error("ERROR: --drifting-ratio and --contradicted-ratio must sum to at most 1.");
  }

  return {
    runRef,
    memoryDir: memoryDirRaw ? path.resolve(expandTilde(memoryDirRaw)) : undefined,
    qmdPath: qmdPathRaw ? path.resolve(expandTilde(qmdPathRaw)) : undefined,
    collection,
    users: readPositiveInteger(args, "--users"),
    epochs,
    seed,
    out,
    factsPerEpoch: readPositiveInteger(args, "--facts-per-epoch"),
    driftingRatio,
    contradictedRatio,
  };
}
