#!/usr/bin/env -S npx tsx
/**
 * build-artifact-from-result.ts — Promote a stored `BenchmarkResult` into a
 * publishable `BenchmarkArtifact` (v1) JSON file, with optional two-tier
 * provenance (issue #1573) for local-lab runs.
 *
 * `remnic bench run` writes a full `BenchmarkResult` (meta/config/cost/results)
 * to the results store; the leaderboard-grade `BenchmarkArtifact` (flat
 * metrics + per-task scores + reproducibility envelope) is produced from it by
 * `buildBenchmarkArtifact`. This script is the reproducible bridge between the
 * two for a finished run, parallel to `verify-artifact.ts`.
 *
 * Usage:
 *   scripts/bench/build-artifact-from-result.ts <result.json> <outDir> \
 *     [--tier local] [--gpu "NVIDIA RTX 3090"] [--vram-gb 24] \
 *     [--quantization Q4_K_M] [--note "..."] [--dataset-version <v>]
 *
 * Prints the written path + sha256 on success; exits non-zero on failure.
 */
import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";

import {
  buildBenchmarkArtifact,
  writeBenchmarkArtifact,
  type BenchmarkArtifact,
  type BenchmarkArtifactHardware,
} from "@remnic/bench";

interface BenchmarkResult {
  meta: {
    benchmark: string;
    remnicVersion: string;
    gitSha: string;
    timestamp: string;
    seeds: number[];
  };
  config: {
    systemProvider?: { model?: string };
    runtimeProfile?: string;
    benchmarkOptions?: { judgeCalibration?: unknown };
  };
  cost?: {
    totalLatencyMs?: number;
    judgeModelCalls?: number;
  };
  results: BenchmarkArtifact extends never ? never : unknown;
  environment: { nodeVersion: string; os: string; hardware?: string };
}

function parseArgs(argv: string[]): {
  resultPath: string;
  outDir: string;
  tier?: "local" | "frontier";
  hardware?: BenchmarkArtifactHardware;
  note?: string;
  datasetVersion?: string;
} {
  const positional: string[] = [];
  let tier: "local" | "frontier" | undefined;
  let gpu: string | undefined;
  let vramGb: number | undefined;
  let quantization: string | undefined;
  let note: string | undefined;
  let datasetVersion: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--tier":
        tier = argv[++i] as "local" | "frontier";
        break;
      case "--gpu":
        gpu = argv[++i];
        break;
      case "--vram-gb":
        vramGb = Number(argv[++i]);
        break;
      case "--quantization":
        quantization = argv[++i];
        break;
      case "--note":
        note = argv[++i];
        break;
      case "--dataset-version":
        datasetVersion = argv[++i];
        break;
      default:
        positional.push(arg);
    }
  }

  if (positional.length < 2) {
    process.stderr.write(
      "usage: build-artifact-from-result.ts <result.json> <outDir> [--tier local] [--gpu ...] [--vram-gb N] [--quantization ...] [--note ...] [--dataset-version ...]\n",
    );
    process.exit(2);
  }

  let hardware: BenchmarkArtifactHardware | undefined;
  if (gpu !== undefined || vramGb !== undefined || quantization !== undefined) {
    if (gpu === undefined || vramGb === undefined || quantization === undefined) {
      process.stderr.write(
        "ERROR: --gpu, --vram-gb, and --quantization must all be supplied together.\n",
      );
      process.exit(2);
    }
    hardware = { gpu, vramGb, quantization };
  }

  return {
    resultPath: positional[0]!,
    outDir: positional[1]!,
    tier,
    hardware,
    note,
    datasetVersion,
  };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readFile(opts.resultPath, "utf8");
  const result = JSON.parse(raw) as BenchmarkResult;

  const startedAtMs = Date.parse(result.meta.timestamp);
  if (!Number.isFinite(startedAtMs)) {
    process.stderr.write(`ERROR: meta.timestamp "${result.meta.timestamp}" is not a valid ISO-8601 timestamp.\n`);
    return 1;
  }
  const durationMs = opts.resultPath ? result.cost?.totalLatencyMs ?? 0 : 0;
  const finishedAt = new Date(startedAtMs + durationMs).toISOString();

  const model = result.config.systemProvider?.model ?? "unknown";
  const seed = result.meta.seeds[0] ?? 1;
  const benchmarkId = result.meta.benchmark;

  // Default dataset version per benchmark when not explicitly supplied.
  const datasetVersion =
    opts.datasetVersion ??
    (benchmarkId === "locomo"
      ? "locomo-10"
      : benchmarkId === "longmemeval"
        ? "longmemeval-oracle"
        : `${benchmarkId}-v1`);

  const note =
    opts.note ??
    (result.cost?.judgeModelCalls !== undefined
      ? `judgeCalls=${result.cost.judgeModelCalls}`
      : undefined);

  const artifact = buildBenchmarkArtifact({
    // The builder only reads result.results + result.meta + result.environment,
    // so the loose cast is safe for a stored BenchmarkResult.
    result: result as never,
    benchmarkId: benchmarkId as never,
    datasetVersion,
    model,
    seed,
    startedAt: result.meta.timestamp,
    finishedAt,
    ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts.hardware !== undefined ? { hardware: opts.hardware } : {}),
    ...(note !== undefined ? { note } : {}),
  });

  const written = await writeBenchmarkArtifact(artifact, opts.outDir);
  process.stdout.write(
    `WROTE ${written.path} ${benchmarkId} model=${model} seed=${seed} ` +
      `tasks=${artifact.perTaskScores.length} judgeCalls=${result.cost?.judgeModelCalls ?? "n/a"} ` +
      `sha256=${written.sha256}\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `build-artifact-from-result.ts crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
