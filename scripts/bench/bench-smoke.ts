#!/usr/bin/env -S npx tsx
/**
 * bench-smoke.ts — Deterministic, side-effect-free smoke harness that
 * exercises the LongMemEval + LoCoMo published-benchmark runners
 * against their bundled smoke fixtures. Intended for CI regression
 * guarding only — do NOT run this against real datasets or real LLMs.
 *
 * The smoke harness uses:
 *   - The runner's built-in `LONG_MEM_EVAL_SMOKE_FIXTURE` and
 *     `LOCOMO_SMOKE_FIXTURE` (no network, no dataset files).
 *   - A deterministic in-memory adapter that echoes the stored
 *     messages back on recall/search.
 *   - A deterministic responder that returns the `recalledText`
 *     verbatim so scoring is reproducible (`contains_answer` + `f1`).
 *   - A deterministic judge that returns a fixed score.
 *
 * Usage:
 *   scripts/bench/bench-smoke.ts --seed 1 \
 *     --baseline tests/fixtures/bench-smoke/baseline.json
 *   scripts/bench/bench-smoke.ts --seed 1 --update-baseline
 *
 * Exit codes:
 *   0 — all metrics within tolerance
 *   1 — regression detected OR CLI usage error
 */

import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchResponder,
  Message,
  SearchResult,
} from "../../packages/bench/src/adapters/types.js";
import { locomoDefinition, runLoCoMoBenchmark } from "../../packages/bench/src/benchmarks/published/locomo/runner.js";
import {
  longMemEvalDefinition,
  runLongMemEvalBenchmark,
} from "../../packages/bench/src/benchmarks/published/longmemeval/runner.js";

// Tolerance for each metric. Issue #566 spec: fail if score drops > 5%
// vs committed baseline. This is a RELATIVE drop: a metric regresses
// when `(baseline - current) / |baseline| > tolerance`. Using a
// relative tolerance means the same 5% threshold is meaningful for
// both small-scale metrics (`f1` in [0, 1]) and larger unbounded
// metrics (`search_hits`, token counts) — an absolute 0.05 drop would
// be a silent no-op for a metric whose baseline is 100.
// When the baseline value is exactly 0 we fall back to an absolute
// delta threshold of `tolerance` to avoid divide-by-zero.
const REGRESSION_TOLERANCE = 0.05;

interface SmokeBaseline {
  schemaVersion: 1;
  /**
   * Baseline metrics keyed by benchmark ID. Intentionally carries NO
   * timestamp so the committed file is stable across runs — CI
   * compares the current metrics against these numbers.
   */
  benchmarks: Record<
    string,
    {
      metrics: Record<string, number>;
    }
  >;
}

interface CliArgs {
  seed: number;
  baselinePath: string;
  updateBaseline: boolean;
  tolerance: number;
}

/**
 * Consume the argument that follows a flag, rejecting option-looking
 * tokens (`--foo`, `-x`). This prevents `--baseline --update-baseline`
 * from silently swallowing the next flag as a path (CLAUDE.md rule 14).
 */
function requireFlagValue(argv: readonly string[], index: number, flag: string, kind: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires ${kind}`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${flag} requires ${kind}; got option-like token "${value}"`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let seed = 1;
  let baselinePath = path.resolve(process.cwd(), "tests/fixtures/bench-smoke/baseline.json");
  let updateBaseline = false;
  let tolerance = REGRESSION_TOLERANCE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--seed": {
        const value = requireFlagValue(argv, index, "--seed", "an integer argument");
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`--seed must be a non-negative integer; got ${value}`);
        }
        seed = parsed;
        index += 1;
        break;
      }
      case "--baseline": {
        const value = requireFlagValue(argv, index, "--baseline", "a file path");
        baselinePath = path.resolve(process.cwd(), value);
        index += 1;
        break;
      }
      case "--tolerance": {
        const value = requireFlagValue(argv, index, "--tolerance", "a number");
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`--tolerance must be a non-negative number; got ${value}`);
        }
        tolerance = parsed;
        index += 1;
        break;
      }
      case "--update-baseline":
        updateBaseline = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}. Run --help for usage.`);
    }
  }

  return { seed, baselinePath, updateBaseline, tolerance };
}

function printUsage(): void {
  process.stdout.write(
    [
      "bench-smoke.ts — LongMemEval + LoCoMo smoke regression gate",
      "",
      "Usage:",
      "  scripts/bench/bench-smoke.ts [--seed N] [--baseline PATH] [--tolerance N] [--update-baseline]",
      "",
      "Flags:",
      "  --seed N             RNG seed (default 1)",
      "  --baseline PATH      Baseline JSON path (default tests/fixtures/bench-smoke/baseline.json)",
      "  --tolerance N        Max allowed RELATIVE metric drop (default 0.05 = 5%)",
      "  --update-baseline    Overwrite the baseline JSON with current run",
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Deterministic adapter + responder + judge
// ---------------------------------------------------------------------------

export function createDeterministicAdapter(): BenchMemoryAdapter {
  const store = new Map<string, Message[]>();
  const responder: BenchResponder = {
    async respond(_question, recalledText) {
      // Echo the recalled text verbatim so scoring is deterministic.
      return {
        text: recalledText,
        model: "smoke-responder",
        latencyMs: 0,
        tokens: { input: 0, output: 0 },
      };
    },
  };
  const judge: BenchJudge = {
    async score() {
      return 1;
    },
    async scoreWithMetrics() {
      return {
        score: 1,
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        model: "smoke-judge",
      };
    },
  };

  return {
    responder,
    judge,
    async store(sessionId, messages) {
      store.set(sessionId, [...messages]);
    },
    async recall(sessionId) {
      const messages = store.get(sessionId) ?? [];
      return messages.map((message) => message.content).join("\n");
    },
    async search(query, limit) {
      const results: SearchResult[] = [];
      const lowered = query.toLowerCase();
      for (const [sessionId, messages] of store) {
        for (let turnIndex = 0; turnIndex < messages.length; turnIndex += 1) {
          const message = messages[turnIndex]!;
          if (typeof message.content === "string" && message.content.toLowerCase().includes(lowered)) {
            results.push({
              turnIndex,
              role: message.role,
              snippet: message.content,
              sessionId,
              score: 1,
            });
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }
      return results;
    },
    async reset() {
      store.clear();
    },
    async destroy() {
      store.clear();
    },
    async getStats() {
      return {
        totalMessages: [...store.values()].reduce((total, messages) => total + messages.length, 0),
        totalSummaryNodes: 0,
        maxDepth: 0,
      };
    },
  };
}

export async function runSmokeBenchmarks(
  seed: number,
  createAdapter: () => BenchMemoryAdapter = createDeterministicAdapter
) {
  const longmemeval = await runLongMemEvalBenchmark({
    benchmark: longMemEvalDefinition,
    mode: "quick",
    seed,
    system: createAdapter(),
  });

  const locomo = await runLoCoMoBenchmark({
    benchmark: locomoDefinition,
    mode: "quick",
    seed,
    system: createAdapter(),
  });

  return { longmemeval, locomo };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`bench-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    return 1;
  }

  process.stdout.write(`bench-smoke: running LongMemEval + LoCoMo smoke fixtures (seed=${args.seed})\n`);

  const { longmemeval, locomo } = await runSmokeBenchmarks(args.seed);

  const current: SmokeBaseline = {
    schemaVersion: 1,
    benchmarks: {
      longmemeval: { metrics: extractMetrics(longmemeval.results.aggregates) },
      locomo: { metrics: extractMetrics(locomo.results.aggregates) },
    },
  };

  if (args.updateBaseline) {
    await writeFile(args.baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    process.stdout.write(`bench-smoke: wrote baseline → ${args.baselinePath}\n`);
    return 0;
  }

  let baseline: SmokeBaseline;
  try {
    const raw = await readFile(args.baselinePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // CLAUDE.md rule 18: JSON.parse("null") succeeds but is not a
    // valid config. Validate shape before trusting it.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("baseline JSON must be a non-null object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      throw new Error(`baseline schemaVersion must be 1; got ${String(record.schemaVersion)}`);
    }
    if (!record.benchmarks || typeof record.benchmarks !== "object" || Array.isArray(record.benchmarks)) {
      throw new Error("baseline.benchmarks must be an object");
    }
    for (const [benchmarkId, bench] of Object.entries(record.benchmarks as Record<string, unknown>)) {
      if (!bench || typeof bench !== "object" || Array.isArray(bench)) {
        throw new Error(`baseline.benchmarks.${benchmarkId} must be an object`);
      }
      const metrics = (bench as { metrics?: unknown }).metrics;
      if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
        throw new Error(`baseline.benchmarks.${benchmarkId}.metrics must be an object`);
      }
      for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`baseline.benchmarks.${benchmarkId}.metrics.${metric} must be a finite number`);
        }
      }
    }
    baseline = parsed as SmokeBaseline;
  } catch (error) {
    process.stderr.write(
      `bench-smoke: failed to read baseline from ${args.baselinePath}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.stderr.write("bench-smoke: run with --update-baseline to generate one.\n");
    return 1;
  }

  const regressions: string[] = [];
  const missing: string[] = [];

  // 1) Compare every current metric against the baseline. Log deltas.
  for (const [benchmarkId, bench] of Object.entries(current.benchmarks)) {
    const baselineMetrics = baseline.benchmarks[benchmarkId]?.metrics ?? {};
    for (const [metric, value] of Object.entries(bench.metrics)) {
      const baselineValue = baselineMetrics[metric];
      if (baselineValue === undefined) {
        process.stdout.write(`bench-smoke: [${benchmarkId}] ${metric}=${value.toFixed(4)} (new metric, no baseline)\n`);
        continue;
      }
      const delta = value - baselineValue;
      // Relative drop: `(baseline - current) / |baseline|`. Fall back
      // to an absolute threshold when baseline === 0 to avoid
      // divide-by-zero; a 0-baseline metric regresses only if it
      // goes negative by more than `tolerance` in absolute terms.
      const denom = Math.abs(baselineValue);
      const relativeDrop = denom === 0 ? -delta : (baselineValue - value) / denom;
      const regressed = relativeDrop > args.tolerance;
      const verdict = regressed ? `REGRESSION (tol=${args.tolerance} relative)` : "ok";
      const relDisplay = denom === 0 ? `abs-delta=${delta.toFixed(4)}` : `rel-drop=${(relativeDrop * 100).toFixed(2)}%`;
      process.stdout.write(
        `bench-smoke: [${benchmarkId}] ${metric} baseline=${baselineValue.toFixed(4)} current=${value.toFixed(4)} delta=${delta >= 0 ? "+" : ""}${delta.toFixed(4)} ${relDisplay} ${verdict}\n`
      );
      if (regressed) {
        regressions.push(
          `${benchmarkId}.${metric} dropped ${Math.abs(delta).toFixed(4)} (baseline=${baselineValue.toFixed(4)}, current=${value.toFixed(4)}, relative=${(relativeDrop * 100).toFixed(2)}%, tolerance=${(args.tolerance * 100).toFixed(2)}%)`
        );
      }
    }
  }

  // 2) Verify every baseline benchmark + metric still exists in the
  // current run. A silently vanished metric (e.g. scorer bug drops
  // `f1`) must fail the gate instead of passing quietly.
  for (const [benchmarkId, benchBaseline] of Object.entries(baseline.benchmarks)) {
    const currentBench = current.benchmarks[benchmarkId];
    if (!currentBench) {
      missing.push(`${benchmarkId}: entire benchmark missing from current run`);
      process.stdout.write(`bench-smoke: [${benchmarkId}] MISSING (benchmark absent from current run)\n`);
      continue;
    }
    for (const metric of Object.keys(benchBaseline.metrics)) {
      if (currentBench.metrics[metric] === undefined) {
        missing.push(`${benchmarkId}.${metric}: present in baseline, absent in current run`);
        process.stdout.write(`bench-smoke: [${benchmarkId}] ${metric} MISSING (metric absent from current run)\n`);
      }
    }
  }

  if (regressions.length > 0 || missing.length > 0) {
    if (regressions.length > 0) {
      process.stderr.write(
        `\nbench-smoke: REGRESSION detected (${regressions.length} metric${regressions.length === 1 ? "" : "s"}):\n`
      );
      for (const regression of regressions) {
        process.stderr.write(`  - ${regression}\n`);
      }
    }
    if (missing.length > 0) {
      process.stderr.write(
        `\nbench-smoke: MISSING metric(s) present in baseline but absent in current run (${missing.length}):\n`
      );
      for (const entry of missing) {
        process.stderr.write(`  - ${entry}\n`);
      }
    }
    process.stderr.write("\nIf this change is intentional, re-run with --update-baseline.\n");
    return 1;
  }

  process.stdout.write("\nbench-smoke: all metrics within tolerance\n");
  return 0;
}

function extractMetrics(aggregates: Record<string, { mean: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(aggregates).sort()) {
    const mean = aggregates[key]?.mean;
    if (typeof mean === "number" && Number.isFinite(mean)) {
      out[key] = Number(mean.toFixed(6));
    }
  }
  return out;
}

async function isDirectInvocation(argvPath: string | undefined): Promise<boolean> {
  if (!argvPath) {
    return false;
  }

  const [invokedPath, modulePath] = await Promise.all([
    realpath(argvPath).catch(() => path.resolve(argvPath)),
    realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url)),
  ]);

  return pathToFileURL(invokedPath).href === pathToFileURL(modulePath).href;
}

if (await isDirectInvocation(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `bench-smoke crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
