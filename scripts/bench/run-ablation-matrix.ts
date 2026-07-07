#!/usr/bin/env -S npx tsx
import { appendFile, mkdir, writeFile } from "node:fs/promises";
/**
 * run-ablation-matrix.ts — Execute the single-flag ablation matrix
 * (issues #1574 §"Ablations" + #1730) against a published benchmark under a
 * local-lab runtime profile, producing one publishable BenchmarkArtifact per
 * cell.
 *
 * This is the reproducible run config for the paper's §7 Ablations table.
 * Each cell flips exactly one Remnic config flag relative to the
 * {@link buildBenchBaselineRemnicConfig} baseline (see
 * `packages/bench/src/ablations/single-flag-matrix.ts`), so the delta against
 * the matching baseline artifact isolates that flag's effect.
 *
 * The script is a thin shell over the public `@remnic/bench` API
 * (`resolveBenchRuntimeProfile` + `runBenchmark` + `createRemnicAdapter` +
 * `buildBenchmarkArtifact`) — it adds only the ablation-override merge and
 * per-cell STATUS logging. Nothing here re-implements harness internals.
 *
 * Usage (full matrix, LoCoMo, Tier L on the lab box):
 *   scripts/bench/run-ablation-matrix.ts \
 *     --benchmark locomo \
 *     --local-lab-manifest ~/bench-manifests/local-lab-3090.json \
 *     --dataset-dir ./bench-datasets/locomo \
 *     --seed 1 \
 *     --out-dir ~/bench-artifacts/ablations \
 *     --judge-cache-dir ~/.remnic/bench/results/judge-cache
 *
 *   --only <cell-id>      run a single cell (default: all, in matrix order)
 *   --limit N             cap the QA count per cell (NON-publishable; for
 *                         smoke/iteration only — the resulting artifact is
 *                         labeled with the limit in its note and is NOT a
 *                         leaderboard-grade number)
 *   --no-judge-cache      force re-judging (default: cache on)
 *
 * Exit codes:
 *   0 — every requested cell produced a verified artifact
 *   1 — one or more cells failed (partial artifacts may still be on disk)
 *   2 — usage error
 */
import path from "node:path";
import process from "node:process";

import {
  type BenchmarkArtifactHardware,
  type BenchmarkArtifactTier,
  type BenchmarkResult,
  type PublishedBenchmarkId,
  type ResolvedBenchRuntimeProfile,
  SINGLE_FLAG_ABLATION_MATRIX,
  type SingleFlagAblationCell,
  type SingleFlagAblationId,
  buildBenchmarkArtifact,
  createRemnicAdapter,
  getAblationCell,
  loadBenchmarkArtifact,
  resolveBenchRuntimeProfile,
  runBenchmark,
  writeBenchmarkArtifact,
} from "@remnic/bench";

interface ParsedArgs {
  benchmark: string;
  localLabManifestPath: string;
  datasetDir: string;
  seed: number;
  outDir: string;
  judgeCacheDir?: string;
  noJudgeCache: boolean;
  only?: SingleFlagAblationId;
  limit?: number;
  hardware: BenchmarkArtifactHardware;
}

function parseArgs(argv: string[]): { ok: true; value: ParsedArgs } | { ok: false; message: string } {
  const positional: string[] = [];
  let benchmark = "locomo";
  let localLabManifestPath: string | undefined;
  let datasetDir: string | undefined;
  let seed = 1;
  let outDir: string | undefined;
  let judgeCacheDir: string | undefined;
  let noJudgeCache = false;
  let only: SingleFlagAblationId | undefined;
  let limit: number | undefined;
  let gpu = "NVIDIA RTX 3090";
  let vramGb = 24;
  let quantization = "Q4_K_M";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--benchmark": {
        benchmark = requireValue(argv, ++i, "--benchmark");
        break;
      }
      case "--local-lab-manifest": {
        localLabManifestPath = requireValue(argv, ++i, "--local-lab-manifest");
        break;
      }
      case "--dataset-dir": {
        datasetDir = requireValue(argv, ++i, "--dataset-dir");
        break;
      }
      case "--seed": {
        seed = parsePositiveInt(requireValue(argv, ++i, "--seed"), "--seed");
        break;
      }
      case "--out-dir": {
        outDir = requireValue(argv, ++i, "--out-dir");
        break;
      }
      case "--judge-cache-dir": {
        judgeCacheDir = requireValue(argv, ++i, "--judge-cache-dir");
        break;
      }
      case "--no-judge-cache": {
        noJudgeCache = true;
        break;
      }
      case "--only": {
        only = requireValue(argv, ++i, "--only") as SingleFlagAblationId;
        // Fail fast on unknown cell ids — a typo would otherwise silently skip.
        getAblationCell(only);
        break;
      }
      case "--limit": {
        limit = parsePositiveInt(requireValue(argv, ++i, "--limit"), "--limit");
        break;
      }
      case "--gpu": {
        gpu = requireValue(argv, ++i, "--gpu");
        break;
      }
      case "--vram-gb": {
        vramGb = parsePositiveInt(requireValue(argv, ++i, "--vram-gb"), "--vram-gb");
        break;
      }
      case "--quantization": {
        quantization = requireValue(argv, ++i, "--quantization");
        break;
      }
      case "-h":
      case "--help": {
        return { ok: false, message: "__help__" };
      }
      default:
        positional.push(arg);
    }
  }

  if (!localLabManifestPath) {
    return {
      ok: false,
      message: "ERROR: --local-lab-manifest <path> is required (Tier L ablation runs use the local-lab profile).",
    };
  }
  if (!datasetDir) {
    return { ok: false, message: "ERROR: --dataset-dir <path> is required." };
  }
  if (!outDir) {
    return { ok: false, message: "ERROR: --out-dir <path> is required." };
  }

  return {
    ok: true,
    value: {
      benchmark,
      localLabManifestPath,
      datasetDir,
      seed,
      outDir,
      judgeCacheDir,
      noJudgeCache,
      only,
      limit,
      hardware: { gpu, vramGb, quantization },
    },
  };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer; got "${raw}".`);
  }
  return parsed;
}

const HELP = `usage: run-ablation-matrix.ts --benchmark <id> --local-lab-manifest <path> \\
  --dataset-dir <path> --out-dir <path> [--seed N] [--only <cell-id>] [--limit N] \\
  [--judge-cache-dir <path>] [--no-judge-cache] [--gpu "..."] [--vram-gb N] [--quantization ...]

Cells: ${SINGLE_FLAG_ABLATION_MATRIX.map((c) => c.id).join(", ")}
`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${parsed.message}\n${HELP}`);
    return 2;
  }
  const args = parsed.value;

  await mkdir(args.outDir, { recursive: true });
  const statusPath = path.join(args.outDir, "STATUS.md");
  const cells = args.only ? [getAblationCell(args.only)] : [...SINGLE_FLAG_ABLATION_MATRIX];

  await writeStatus(
    statusPath,
    `# Single-flag ablation matrix (issue #1730 / #1574)\n\n**Benchmark:** ${args.benchmark}  **Seed:** ${args.seed}  **Tier:** local\n**Cells:** ${cells.map((c) => c.id).join(", ")}\n${args.limit ? `**NOTE:** --limit ${args.limit} set — artifacts are NON-publishable (iteration only).\n` : ""}\n## Progress\n`
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "local-lab",
    localLabManifestPath: args.localLabManifestPath,
    judgeCacheDir: args.judgeCacheDir,
  });

  let failures = 0;
  for (const cell of cells) {
    const label = `[ablation:${cell.id}]`;
    process.stdout.write(`${label} starting — ${cell.label}\n`);
    await appendStatus(
      statusPath,
      `\n### ${cell.id} — ${cell.label}\n- status: RUNNING\n- axis: ${cell.axis}\n- baseline: ${cell.baselineState}\n`
    );
    try {
      const written = await runOneCell(args, resolved, cell);
      const { artifact } = await loadBenchmarkArtifact(written.path);
      const metrics = Object.entries(artifact.metrics)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : v}`)
        .join(", ");
      process.stdout.write(`${label} DONE → ${written.filename} (${metrics}) sha256=${written.sha256.slice(0, 12)}\n`);
      await appendStatus(
        statusPath,
        `- status: DONE\n  - artifact: \`${written.filename}\`\n  - metrics: ${metrics}\n  - sha256: ${written.sha256}\n`
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${label} FAILED: ${message}\n`);
      await appendStatus(statusPath, `- status: FAILED\n  - error: ${message.split("\n")[0]}\n`);
    }
  }

  await appendStatus(
    statusPath,
    `\n## Summary\n- cells attempted: ${cells.length}\n- failures: ${failures}\n- finished: ${new Date().toISOString()}\n`
  );
  return failures === 0 ? 0 : 1;
}

/**
 * Derive the true run window from the runner's end-stamp and summed task
 * latency. Mirrors build-artifact-from-result.ts so the artifact's
 * startedAt/finishedAt match the promotion path exactly.
 */
function deriveRunWindow(metaTimestamp: string, totalLatencyMs: number): { startedAt: string; finishedAt: string } {
  const finishedMs = Date.parse(metaTimestamp);
  if (!Number.isFinite(finishedMs)) {
    throw new Error(`meta.timestamp "${metaTimestamp}" is not a valid ISO-8601 timestamp.`);
  }
  const duration = Number.isFinite(totalLatencyMs) && totalLatencyMs > 0 ? totalLatencyMs : 0;
  return {
    startedAt: new Date(finishedMs - duration).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
  };
}

/** Default dataset-version tag per published benchmark (matches the promotion path). */
function defaultDatasetVersion(benchmarkId: PublishedBenchmarkId): string {
  if (benchmarkId === "locomo") return "locomo-10";
  if (benchmarkId === "longmemeval") return "longmemeval-oracle";
  return `${benchmarkId}-v1`;
}

async function runOneCell(
  args: ParsedArgs,
  resolved: ResolvedBenchRuntimeProfile,
  cell: SingleFlagAblationCell
): Promise<string> {
  // Merge the cell's configOverrides ON TOP of the resolved baseline config.
  // The resolved `adapterOptions.configOverrides` already contains the
  // local-lab baseline + provider hooks; the ablation flag rides on top so
  // everything else (provider, judge, drain) is byte-identical to the
  // matching baseline run.
  const mergedConfigOverrides = {
    ...resolved.adapterOptions.configOverrides,
    ...cell.configOverrides,
  };

  const limitNote = args.limit
    ? ` ITERATION-ONLY slice (--limit ${args.limit}); NOT a publishable full-run number.`
    : "";
  const note = `Single-flag ablation "${cell.id}" (${cell.label}). ${cell.description} Baseline: ${cell.baselineState}${limitNote}`;

  const adapter = await createRemnicAdapter({
    configOverrides: mergedConfigOverrides,
    responder: resolved.adapterOptions.responder,
    judge: resolved.adapterOptions.judge,
    preserveRuntimeDefaults: resolved.adapterOptions.preserveRuntimeDefaults,
    ...(resolved.adapterOptions.drainTimeoutMs ? { drainTimeoutMs: resolved.adapterOptions.drainTimeoutMs } : {}),
    ...(args.benchmark === "locomo" ? { replayExtractionMode: "skip" as const } : {}),
  });

  const result = (await runBenchmark(args.benchmark, {
    mode: "full",
    datasetDir: args.datasetDir,
    seed: args.seed,
    limit: args.limit,
    adapterMode: "direct",
    runtimeProfile: resolved.profile,
    systemProvider: resolved.systemProvider,
    judgeProvider: resolved.judgeProvider,
    internalProvider: resolved.internalProvider,
    remnicConfig: mergedConfigOverrides,
    drainTimeoutMs: resolved.adapterOptions.drainTimeoutMs,
    ...(args.noJudgeCache ? { noJudgeCache: true } : {}),
    ...(args.judgeCacheDir ? { judgeCacheDir: args.judgeCacheDir } : {}),
    system: adapter,
  })) as BenchmarkResult;

  // Stamp the effective config (post-merge) so the artifact reflects what
  // actually ran, including the ablation override.
  result.config.remnicConfig = mergedConfigOverrides;

  // Build the artifact via the public promotion contract (same shape as
  // build-artifact-from-result.ts): derive benchmarkId/model/seed/run-window
  // from the live result so the artifact is self-describing + reproducible.
  const benchmarkId = result.meta.benchmark as PublishedBenchmarkId;
  const model = result.config.systemProvider?.model ?? "unknown";
  const seed = result.meta.seeds[0] ?? 1;
  const { startedAt, finishedAt } = deriveRunWindow(result.meta.timestamp, result.cost?.totalLatencyMs ?? 0);
  const artifact = buildBenchmarkArtifact({
    result,
    benchmarkId,
    datasetVersion: defaultDatasetVersion(benchmarkId),
    model,
    seed,
    startedAt,
    finishedAt,
    tier: "local",
    hardware: args.hardware,
    note,
  });
  return writeBenchmarkArtifact(artifact, args.outDir);
}

async function writeStatus(statusPath: string, content: string): Promise<void> {
  await writeFile(statusPath, content, "utf8");
}

async function appendStatus(statusPath: string, content: string): Promise<void> {
  await appendFile(statusPath, content, "utf8");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `run-ablation-matrix.ts crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
