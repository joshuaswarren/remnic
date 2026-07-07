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
 *
 * Input is validated at the CLI boundary (issue #1712): an invalid --tier,
 * non-integer --vram-gb, unpublished benchmarkId, incomplete source run, or a
 * `--tier local` invocation missing the hardware envelope all fail fast with a
 * clear stderr message + non-zero exit, rather than slipping through to
 * `parseBenchmarkArtifact`/`verify-artifact.ts` at publish time.
 */
import { realpathSync } from "node:fs";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildBenchmarkArtifact,
  writeBenchmarkArtifact,
  PUBLISHED_BENCHMARK_ARTIFACT_IDS,
  type BenchmarkArtifactHardware,
  type BenchmarkArtifactTier,
  type BenchmarkResult,
  type PublishedBenchmarkId,
} from "@remnic/bench";

/** CLI flags + positionals, parsed and validated by {@link parseArgs}. */
export interface ParsedArgs {
  resultPath: string;
  outDir: string;
  tier?: BenchmarkArtifactTier;
  hardware?: BenchmarkArtifactHardware;
  note?: string;
  datasetVersion?: string;
}

/** Discriminated result of {@link parseArgs}: either a clean parse or a diagnostic. */
export type ArgParseResult = { ok: true; value: ParsedArgs } | { ok: false; message: string };

/** Discriminated result of {@link validateResultForPromotion}. */
export type ValidationResult = { ok: true } | { ok: false; message: string };

/** Allowed `--tier` values (issue #1573 two-tier provenance). */
const ALLOWED_TIERS: Record<string, true> = { local: true, frontier: true };

/** True when `id` is one of the published benchmark artifact identifiers. */
export function isPublishedBenchmarkId(id: string): id is PublishedBenchmarkId {
  return (PUBLISHED_BENCHMARK_ARTIFACT_IDS as readonly string[]).includes(id);
}

/**
 * Parse + validate the CLI argument vector. Pure (no process.exit) so it can
 * be unit-tested directly; {@link main} translates a non-`ok` result into a
 * stderr message + exit code. Every flag that takes a value must receive one,
 * and value-bearing flags are type-checked at the boundary:
 *   - `--tier` must be `local` or `frontier`;
 *   - `--vram-gb` must be a positive finite integer;
 *   - a `--tier local` invocation must carry the full hardware envelope.
 */
export function parseArgs(argv: string[]): ArgParseResult {
  const positional: string[] = [];
  let tier: BenchmarkArtifactTier | undefined;
  let gpu: string | undefined;
  let vramGb: number | undefined;
  let quantization: string | undefined;
  let note: string | undefined;
  let datasetVersion: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--tier": {
        const value = argv[++i];
        if (value === undefined) {
          return { ok: false, message: "ERROR: --tier requires a value (one of: local, frontier)." };
        }
        if (ALLOWED_TIERS[value] !== true) {
          return {
            ok: false,
            message: `ERROR: --tier must be one of: local, frontier; got "${value}".`,
          };
        }
        tier = value as BenchmarkArtifactTier;
        break;
      }
      case "--gpu": {
        const value = argv[++i];
        if (value === undefined) {
          return { ok: false, message: "ERROR: --gpu requires a value." };
        }
        gpu = value;
        break;
      }
      case "--vram-gb": {
        const raw = argv[++i];
        if (raw === undefined) {
          return { ok: false, message: "ERROR: --vram-gb requires a positive integer value." };
        }
        const parsed = Number(raw);
        // Number("") === 0 and Number(" ") === 0, so reject non-finite and
        // non-integer explicitly; NaN from "abc" or a fractional/zero/negative
        // value all fail here instead of serializing as JSON `null` later.
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          return {
            ok: false,
            message: `ERROR: --vram-gb must be a positive finite integer; got "${raw}".`,
          };
        }
        vramGb = parsed;
        break;
      }
      case "--quantization": {
        const value = argv[++i];
        if (value === undefined) {
          return { ok: false, message: "ERROR: --quantization requires a value." };
        }
        quantization = value;
        break;
      }
      case "--note": {
        const value = argv[++i];
        if (value === undefined) {
          return { ok: false, message: "ERROR: --note requires a value." };
        }
        note = value;
        break;
      }
      case "--dataset-version": {
        const value = argv[++i];
        if (value === undefined) {
          return { ok: false, message: "ERROR: --dataset-version requires a value." };
        }
        datasetVersion = value;
        break;
      }
      default:
        positional.push(arg);
    }
  }

  if (positional.length < 2) {
    return {
      ok: false,
      message:
        "usage: build-artifact-from-result.ts <result.json> <outDir> [--tier local] [--gpu ...] [--vram-gb N] [--quantization ...] [--note ...] [--dataset-version ...]",
    };
  }

  let hardware: BenchmarkArtifactHardware | undefined;
  if (gpu !== undefined || vramGb !== undefined || quantization !== undefined) {
    if (gpu === undefined || vramGb === undefined || quantization === undefined) {
      return {
        ok: false,
        message: "ERROR: --gpu, --vram-gb, and --quantization must all be supplied together.",
      };
    }
    hardware = { gpu, vramGb, quantization };
  }

  // Tier L artifacts must carry the hardware envelope so a local-lab number is
  // never conflated with a frontier number (issue #1573).
  if (tier === "local" && hardware === undefined) {
    return {
      ok: false,
      message:
        "ERROR: --tier local requires the full hardware envelope (--gpu, --vram-gb, --quantization).",
    };
  }

  return {
    ok: true,
    value: {
      resultPath: positional[0] as string,
      outDir: positional[1] as string,
      tier,
      hardware,
      note,
      datasetVersion,
    },
  };
}

/**
 * Validate a parsed result for promotion to a publishable artifact. Publish-
 * safety guards (issue #1712): reject unpublished benchmark ids, partial /
 * quick-mode runs, and runs persisted with a `benchmarkOptions.limit` or
 * `trialLimit` — only complete full runs may be published. Structural
 * validation of the inner task/aggregate shape is delegated to
 * `buildBenchmarkArtifact`, which throws with a per-field diagnostic.
 */
export function validateResultForPromotion(result: unknown): ValidationResult {
  if (typeof result !== "object" || result === null) {
    return { ok: false, message: "result file is not a JSON object." };
  }
  const r = result as Record<string, unknown>;
  const meta = r.meta as Record<string, unknown> | undefined;
  const benchmarkId = meta?.benchmark;

  if (typeof benchmarkId !== "string" || !isPublishedBenchmarkId(benchmarkId)) {
    return {
      ok: false,
      message:
        `meta.benchmark "${String(benchmarkId)}" is not a published benchmark artifact id ` +
        `(allowed: ${PUBLISHED_BENCHMARK_ARTIFACT_IDS.join(", ")}).`,
    };
  }

  if (meta?.status === "partial") {
    return {
      ok: false,
      message:
        'refusing to promote a partial run (meta.status="partial"); only complete runs may be published.',
    };
  }

  if (meta?.mode === "quick") {
    return {
      ok: false,
      message:
        'refusing to promote a quick-mode run (meta.mode="quick"); only full runs may be published.',
    };
  }

  const config = r.config as Record<string, unknown> | undefined;
  const benchmarkOptions = config?.benchmarkOptions as Record<string, unknown> | undefined;
  if (benchmarkOptions !== null && typeof benchmarkOptions === "object") {
    if (benchmarkOptions.limit !== undefined || benchmarkOptions.trialLimit !== undefined) {
      return {
        ok: false,
        message:
          "refusing to promote a limited run (config.benchmarkOptions.limit/trialLimit set); only full runs may be published.",
      };
    }
  }

  return { ok: true };
}

/**
 * Derive the true run window from a stored `BenchmarkResult`.
 *
 * `meta.timestamp` is recorded at run **end** — `buildBenchmarkResult` in the
 * published harness runs after every task has completed, so the timestamp is
 * the finish, not the start. Treating it as `startedAt` (the pre-#1712
 * behavior) produced a `finishedAt` in the future (`timestamp + duration`).
 * The true window is therefore: `finishedAt = meta.timestamp` and
 * `startedAt = finishedAt − totalLatencyMs`. A non-finite or non-positive
 * duration collapses to a zero-length window (start === finish) rather than a
 * backwards interval.
 */
export function deriveRunWindow(
  metaTimestamp: string,
  totalLatencyMs: number,
): { startedAt: string; finishedAt: string } {
  const finishedMs = Date.parse(metaTimestamp);
  if (!Number.isFinite(finishedMs)) {
    throw new Error(`meta.timestamp "${metaTimestamp}" is not a valid ISO-8601 timestamp.`);
  }
  const duration = Number.isFinite(totalLatencyMs) && totalLatencyMs > 0 ? totalLatencyMs : 0;
  const startedMs = finishedMs - duration;
  return {
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
  };
}

/** Outcome of a successful {@link promote} run, mirroring the `WROTE` log line. */
export interface PromotionResult {
  path: string;
  sha256: string;
  benchmarkId: PublishedBenchmarkId;
  model: string;
  seed: number;
  taskCount: number;
  judgeCalls: number | undefined;
}

/**
 * Read a stored `BenchmarkResult`, validate it for publication, derive the
 * true run window, build the `BenchmarkArtifact`, and write it to `outDir`.
 * Throws an `Error` whose `message` is a clear, single-line diagnostic on any
 * failure (missing file, bad JSON, validation rejection, builder error) so
 * {@link main} can surface it verbatim. Exported as the integration seam used
 * by the test suite.
 */
export async function promote(opts: ParsedArgs): Promise<PromotionResult> {
  let raw: string;
  try {
    raw = await readFile(opts.resultPath, "utf8");
  } catch (error) {
    throw new Error(
      `could not read result file "${opts.resultPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `could not parse result file "${opts.resultPath}" as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const validity = validateResultForPromotion(parsedResult);
  if (!validity.ok) {
    throw new Error(validity.message);
  }

  // validateResultForPromotion narrowed meta.benchmark to a published id, so
  // the cast here is bounded and safe; buildBenchmarkArtifact validates the
  // remaining task/aggregate structure and throws with a per-field diagnostic.
  const result = parsedResult as BenchmarkResult;
  const benchmarkId = result.meta.benchmark as PublishedBenchmarkId;

  // meta.timestamp is the run-end stamp; derive the true start from the summed
  // task latency. resultPath is a required positional, so there is no longer a
  // dead "no path" branch — cost.totalLatencyMs is read unconditionally.
  const totalLatencyMs = result.cost?.totalLatencyMs ?? 0;
  const { startedAt, finishedAt } = deriveRunWindow(result.meta.timestamp, totalLatencyMs);

  const model = result.config.systemProvider?.model ?? "unknown";
  const seed = result.meta.seeds[0] ?? 1;

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
    result,
    benchmarkId,
    datasetVersion,
    model,
    seed,
    startedAt,
    finishedAt,
    ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts.hardware !== undefined ? { hardware: opts.hardware } : {}),
    ...(note !== undefined ? { note } : {}),
  });

  const written = await writeBenchmarkArtifact(artifact, opts.outDir);
  return {
    path: written.path,
    sha256: written.sha256,
    benchmarkId,
    model,
    seed,
    taskCount: artifact.perTaskScores.length,
    judgeCalls: result.cost?.judgeModelCalls,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 2;
  }
  try {
    const result = await promote(parsed.value);
    process.stdout.write(
      `WROTE ${result.path} ${result.benchmarkId} model=${result.model} seed=${result.seed} ` +
        `tasks=${result.taskCount} judgeCalls=${result.judgeCalls ?? "n/a"} ` +
        `sha256=${result.sha256}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Only auto-run when invoked directly (not when imported by tests). Mirrors the
// realpath-based direct-run check in scripts/check-test-types.mjs so a
// symlinked or tsx-wrapped invocation still resolves correctly.
function isDirectRun(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
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
}
