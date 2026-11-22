
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

  const repo = generateSyntheticRepo(fixtureConfig);
  const storeFiles = toStoreFiles(repo);

  let peakRss = 0;
  const sampleRss = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };

  const dir = await mkdtemp(path.join(tmpdir(), "coding-graph-bench-"));
  const dbPath = path.join(dir, "bench.sqlite");

  try {
    const store = await GraphStore.open({ dbPath });
    try {
      const FULL_INDEX_SAMPLES = 3;
      const fullIndexSamples: number[] = [];
      for (let s = 0; s < FULL_INDEX_SAMPLES; s++) {
        const sampleStore =
          s === 0
            ? store
            : await GraphStore.open({ dbPath: path.join(dir, `bench-warm-${s}.sqlite`) });
        const fi = await timeAsync(() => sampleStore.upsertFileBatch(storeFiles));
        if (!fi.result.ok) {
          if (sampleStore !== store) await sampleStore.close();
          throw new Error(`full-index failed: ${fi.result.code}`);
        }
        fullIndexSamples.push(fi.ms);
        if (sampleStore !== store) await sampleStore.close();
      }
      const fullIndexMsValue = percentile(
        [...fullIndexSamples].sort((a, b) => a - b),
        50,
      );

      const locsPerSecond =
        fullIndexMsValue > 0 ? repo.approximateLoc / (fullIndexMsValue / 1000) : 0;

      sampleRss();

      const stats = store.schemaStats();
      const graphNodeCount = stats.ok ? stats.stats.nodes : 0;
      const graphEdgeCount = stats.ok ? stats.stats.edges : 0;

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

      const startName = repo.files[0]?.symbols[0]?.qualifiedName;
      const traceSamples: number[] = [];
      if (startName) {
        for (let i = 0; i < iterations; i++) {
          const traceRes = timeSync(() =>
            store.traverse({
              start: startName,
              maxDepth: traceDepth,
              direction: "outgoing",
            } satisfies TraverseQuery),
          );
          if (!traceRes.result.ok) {
            throw new Error(
              `trace_path failed: ${traceRes.result.code}`,
            );
          }
          traceSamples.push(traceRes.ms);
        }
      }

      const searchSamples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const searchRes = timeSync(() =>
          store.searchGraph({
            namePattern: "%function%",
            limit: 50,
          } satisfies SearchQuery),
        );
        if (!searchRes.result.ok) {
          throw new Error(
            `search_graph failed: ${searchRes.result.code}`,
          );
        }
        searchSamples.push(searchRes.ms);
      }

      const deadCode = timeSync(() => store.deadCode());
      if (!deadCode.result.ok) {
        throw new Error(`dead_code failed: ${deadCode.result.code}`);
      }

      await store.drain();
      let dbBytes = statSync(dbPath).size;
      try {
        dbBytes += statSync(dbPath + "-wal").size;
      } catch {
        // No WAL file — already checkpointed or deleted on close.
      }
      const kloc = Math.max(1, repo.approximateLoc / 1000);
      const dbBytesPerKloc = dbBytes / kloc;

      const modifiedSamples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const fileIdx = i % storeFiles.length;
        const original = storeFiles[fileIdx];
        if (!original) continue;
        const ownSyms = new Set(original.symbols.map((sym) => sym.qualifiedName));
        const churnName = `mod.benchChurnSymbol${i}`;
        const representativeEdges: EdgeIR[] = (original.edges ?? [])
          .filter((e) => !ownSyms.has(e.dstQualifiedName))
          .slice(0, 2)
          .map((e) => ({ ...e, srcQualifiedName: churnName }));
        const modified: StoreFileIR = {
          ...original,
          contentHash: `${original.contentHash}-mod-${i}`,
          symbols: [
            {
              qualifiedName: churnName,
              name: `benchChurnSymbol${i}`,
              kind: "function" as SymbolKind,
              span: { startByte: 0, endByte: 0 },
            },
          ],
          edges: representativeEdges,
        };
        const modResult = await timeAsync(() =>
          store.upsertFileBatch([modified]),
        );
        if (!modResult.result.ok) {
          throw new Error(`modified update failed: ${modResult.result.code}`);
        }
        modifiedSamples.push(modResult.ms);
        const restoreResult = await store.upsertFileBatch(storeFiles);
        if (!restoreResult.ok) {
          throw new Error(`restore failed: ${restoreResult.code}`);
        }
        sampleRss();
      }

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
        fullIndexMs: { ms: fullIndexMsValue },
        fullIndexLocsPerSecond: Math.round(locsPerSecond),
        incrementalUpdate: computeMicroMetric(incrementalSamples),
        incrementalModifiedUpdate: computeMicroMetric(
          modifiedSamples.length > 0 ? modifiedSamples : [0],
        ),
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
