/**
 * Coding-graph benchmark harness (issue #1557).
 *
 * Runs the full metric set against a synthetic fixture and produces a
 * {@link CodingGraphBenchReport}. The harness is the authority for
 * performance claims — no number ships in docs without a harness
 * measurement behind it (rule 55).
 *
 * Metrics measured (per the issue):
 *   - full-index wall time + LOC/s
 *   - incremental single-file update latency p50/p95
 *   - trace_path (depth ≤ 5) p95
 *   - search_graph name-pattern p95
 *   - dead-code query wall time
 *   - DB bytes per KLOC
 *   - peak RSS
 *
 * Timing uses `performance.now()` (monotonic). p95 computed over ≥20
 * iterations for micro metrics. The report includes a machine fingerprint
 * so baselines are comparable.
 */

import { performance } from "node:perf_hooks";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";

import {
  GraphStore,
  type StoreFileIR,
  type EdgeIR,
  type TraverseQuery,
  type SearchQuery,
  type SymbolKind,
  type CodingGraphLanguage,
  type UpsertBatchResult,
} from "@remnic/coding-graph";

import { generateSyntheticRepo } from "./generator.js";
import {
  CODING_GRAPH_BENCH_SCHEMA_VERSION,
  DEFAULT_SMOKE_FIXTURE,
  MIN_ITERATIONS,
  type CodingGraphBenchConfig,
  type CodingGraphBenchReport,
  type GeneratedRepo,
  type MachineFingerprint,
  type MicroMetric,
  type SyntheticRepoConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Machine fingerprint — captured once per run so baselines are comparable.
// ---------------------------------------------------------------------------

export function captureMachineFingerprint(): MachineFingerprint {
  const cpus = os.cpus();
  return {
    arch: process.arch,
    platform: process.platform,
    nodeVersion: process.version,
    cpuModel: cpus.length > 0 ? cpus[0].model : null,
    cpuCores: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

// ---------------------------------------------------------------------------
// Percentile helpers.
// ---------------------------------------------------------------------------

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeMicroMetric(samplesMs: number[]): MicroMetric {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    iterations: samplesMs.length,
    samplesMs,
  };
}

// ---------------------------------------------------------------------------
// Convert GeneratedRepo → StoreFileIR[] for the GraphStore.
// ---------------------------------------------------------------------------

function toStoreFiles(repo: GeneratedRepo): StoreFileIR[] {
  return repo.files.map((f) => ({
    path: f.path,
    language: f.language as CodingGraphLanguage,
    contentHash: f.contentHash,
    symbols: f.symbols.map((s) => ({
      qualifiedName: s.qualifiedName,
      name: s.name,
      kind: s.kind as SymbolKind,
      span: { startByte: s.startByte, endByte: s.endByte },
    })),
    edges: f.edges.map(
      (e): EdgeIR => ({
        srcQualifiedName: e.srcQualifiedName,
        dstQualifiedName: e.dstQualifiedName,
        type: e.type,
        confidence: e.confidence,
        provenance: e.provenance as EdgeIR["provenance"],
      }),
    ),
  }));
}

// ---------------------------------------------------------------------------
// Timing helpers — monotonic clock.
// ---------------------------------------------------------------------------

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

function timeSync<T>(fn: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

// ---------------------------------------------------------------------------
// The harness entry point.
// ---------------------------------------------------------------------------

/**
 * Run the coding-graph benchmark suite against a synthetic fixture.
 *
 * Produces a {@link CodingGraphBenchReport} with every metric key. The
 * report is fully JSON-serializable so it can be written to disk, compared
 * against a baseline, or embedded in docs.
 *
 * @param config Run configuration. Defaults to a small smoke fixture.
 */
export async function runCodingGraphBenchmark(
  config: CodingGraphBenchConfig = {},
): Promise<CodingGraphBenchReport> {
  const fixtureConfig: SyntheticRepoConfig = {
    ...DEFAULT_SMOKE_FIXTURE,
    ...config.fixture,
  };
  const iterations = Math.max(MIN_ITERATIONS, config.iterations ?? MIN_ITERATIONS);
  const traceDepth = config.traceDepth ?? 5;

  // Generate the fixture (deterministic — rule 38).
  const repo = generateSyntheticRepo(fixtureConfig);
  const storeFiles = toStoreFiles(repo);

  // Track peak RSS across the entire run — a single end-of-run sample
  // misses the peak from index/traverse/dead-code operations.
  let peakRss = 0;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  // Open a temp DB.
  const dir = await mkdtemp(path.join(tmpdir(), "coding-graph-bench-"));
  const dbPath = path.join(dir, "bench.sqlite");

  try {
    const store = await GraphStore.open({ dbPath });
    try {
      // ── Metric 1: full-index wall time ──
      const fullIndex = await timeAsync(() => store.upsertFileBatch(storeFiles));
      if (!fullIndex.result.ok) {
        throw new Error(`full-index failed: ${fullIndex.result.code}`);
      }

      const locsPerSecond =
        fullIndex.ms > 0 ? repo.approximateLoc / (fullIndex.ms / 1000) : 0;

      sampleRss();

      // ── Metric 2: graph stats (node/edge counts for the report) ──
      const stats = store.schemaStats();
      const graphNodeCount = stats.ok ? stats.stats.nodes : 0;
      const graphEdgeCount = stats.ok ? stats.stats.edges : 0;

      // ── Metric 3: incremental single-file update p50/p95 ──
      // Re-ingest one file at a time (same content = idempotent upsert).
      const incrementalSamples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const fileIdx = i % storeFiles.length;
        const incResult = await timeAsync(() =>
          store.upsertFileBatch([storeFiles[fileIdx]]),
        );
        if (!incResult.result.ok) {
          throw new Error(`incremental update failed: ${incResult.result.code}`);
        }
        incrementalSamples.push(incResult.ms);
      }

      // ── Metric 4: trace_path (depth ≤ 5) p50/p95 ──
      // Pick a stable start node from the fixture.
      const startName = repo.files[0]?.symbols[0]?.qualifiedName;
      const traceSamples: number[] = [];
      if (startName) {
        for (let i = 0; i < iterations; i++) {
          const { ms } = timeSync(() =>
            store.traverse({
              start: startName,
              maxDepth: traceDepth,
              direction: "outgoing",
            } satisfies TraverseQuery),
          );
          traceSamples.push(ms);
        }
      }

      // ── Metric 5: search_graph name-pattern p50/p95 ──
      const searchSamples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const { ms } = timeSync(() =>
          store.searchGraph({
            namePattern: "%function%",
            limit: 50,
          } satisfies SearchQuery),
        );
        searchSamples.push(ms);
      }

      // ── Metric 6: dead-code query wall time ──
      const deadCode = timeSync(() => store.deadCode());

      // ── Metric 7: DB size ──
      await store.drain();
      // Include WAL files in DB-size measurement — GraphStore opens in WAL
      // mode, so the -wal file holds committed writes that haven't
      // checkpointed yet. Measuring only the main DB file underreports.
      let dbBytes = statSync(dbPath).size;
      try {
        dbBytes += statSync(dbPath + "-wal").size;
      } catch {
        // No WAL file — already checkpointed or deleted on close.
      }
      const kloc = Math.max(1, repo.approximateLoc / 1000);
      const dbBytesPerKloc = dbBytes / kloc;

      // ── Metric 8: peak RSS (tracked across the run) ──
      sampleRss();
      const peakRssBytes = peakRss;

      return {
        schemaVersion: CODING_GRAPH_BENCH_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        machine: captureMachineFingerprint(),
        fixture: {
          config: fixtureConfig,
          approximateLoc: repo.approximateLoc,
          fileCount: repo.files.length,
          symbolCount: repo.files.reduce((sum, f) => sum + f.symbols.length, 0),
          edgeCount: repo.files.reduce((sum, f) => sum + f.edges.length, 0),
        },
        fullIndexMs: { ms: fullIndex.ms },
        fullIndexLocsPerSecond: Math.round(locsPerSecond),
        incrementalUpdate: computeMicroMetric(incrementalSamples),
        tracePath: computeMicroMetric(traceSamples.length > 0 ? traceSamples : [0]),
        searchGraph: computeMicroMetric(searchSamples),
        deadCodeMs: { ms: deadCode.ms },
        dbBytesPerKloc: Math.round(dbBytesPerKloc),
        peakRssBytes,
        dbBytes,
        graphNodeCount,
        graphEdgeCount,
      };
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
