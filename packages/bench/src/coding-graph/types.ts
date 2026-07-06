/**
 * Coding-graph benchmark types (issue #1557).
 *
 * These types define the metric report shape, the benchmark configuration,
 * and the regression-gate contract. The harness writes a {@link CodingGraphBenchReport};
 * the regression step compares it against a tracked {@link CodingGraphBaseline}.
 *
 * Design rules (from the issue):
 *   - Metrics are recorded as a tracked baseline (same philosophy as
 *     scripts/ratchet-baseline.json), NOT inline thresholds.
 *   - The comparison step hard-fails on gross regression (rule 50) with a
 *     generous tolerance — perf thresholds in CI flake.
 *   - Every metric that enters the report must have a plausible type so
 *     the smoke test can assert presence without knowing exact values.
 *   - The report includes a machine fingerprint so baselines are comparable
 *     across runs (the issue calls this out explicitly).
 */

// ---------------------------------------------------------------------------
// Generator config — parameterized synthetic repo (issue #1557 design (a)).
// ---------------------------------------------------------------------------

/**
 * Parameters for the deterministic synthetic repo generator. Same seed +
 * same params → byte-identical IR output (rule 38 — generator determinism).
 */
export interface SyntheticRepoConfig {
  /** PRNG seed — same seed + params = identical output. */
  readonly seed: number;
  /** Number of synthetic source files. */
  readonly fileCount: number;
  /** Symbols (functions/classes/methods) per file. */
  readonly symbolsPerFile: number;
  /**
   * Edge density — probability [0,1] that any given symbol calls another.
   * Higher = denser call graph (more edges per node).
   */
  readonly callDensity: number;
  /** Language tier label (informational — the IR is language-agnostic). */
  readonly language: string;
}

/**
 * Generated fixture — the IR plus approximate LOC and a structural summary.
 */
export interface GeneratedRepo {
  readonly files: readonly SyntheticFileIR[];
  /** Approximate LOC (symbolsPerFile × fileCount × avgLinesPerSymbol). */
  readonly approximateLoc: number;
  readonly config: SyntheticRepoConfig;
}

/**
 * Minimal IR shape for the synthetic generator. Matches the subset of
 * {@link StoreFileIR} the harness exercises: symbols + CALLS edges. The
 * generator emits this shape directly so the benchmark measures the STORE,
 * not the parser (parser benchmarks are a separate concern).
 */
export interface SyntheticFileIR {
  readonly path: string;
  readonly language: string;
  readonly contentHash: string;
  readonly symbols: readonly SyntheticSymbol[];
  readonly edges: readonly SyntheticEdge[];
}

export interface SyntheticSymbol {
  readonly qualifiedName: string;
  readonly name: string;
  readonly kind: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface SyntheticEdge {
  readonly srcQualifiedName: string;
  readonly dstQualifiedName: string;
  readonly type: string;
  readonly confidence: number;
  readonly provenance: string;
}

// ---------------------------------------------------------------------------
// Machine fingerprint — baselines are only comparable on the same machine.
// ---------------------------------------------------------------------------

export interface MachineFingerprint {
  readonly arch: string;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly cpuModel: string | null;
  readonly cpuCores: number;
  readonly totalMemoryMb: number;
}

// ---------------------------------------------------------------------------
// Metrics — one entry per metric key. p50/p95 computed over iterations.
// ---------------------------------------------------------------------------

/**
 * Micro-metric result with percentile distribution. `samples` is the raw
 * array of per-iteration measurements (ms); p50/p95 are computed from it.
 */
export interface MicroMetric {
  /** Median (p50) in milliseconds. */
  readonly p50: number;
  /** 95th percentile in milliseconds. */
  readonly p95: number;
  /** Number of iterations measured. */
  readonly iterations: number;
  /** Raw per-iteration timings (ms) — kept so the report is auditable. */
  readonly samplesMs: readonly number[];
}

/** A single wall-clock measurement (ms) with no distribution. */
export interface WallMetric {
  readonly ms: number;
  readonly detail?: string;
}

/**
 * All metric keys that the harness can produce. Each is lower-is-better
 * except `fullIndexLocsPerSecond` (higher is better).
 *
 * The regression gate compares only keys present in BOTH the report and
 * the baseline — new metrics are additive, never blocking.
 */
export type CodingGraphMetricKey =
  | "fullIndexMs"
  | "fullIndexLocsPerSecond"
  | "incrementalUpdateP50Ms"
  | "incrementalUpdateP95Ms"
  | "tracePathP95Ms"
  | "searchGraphP95Ms"
  | "deadCodeMs"
  | "dbBytesPerKloc";

// ---------------------------------------------------------------------------
// Benchmark report — the JSON artifact written to disk.
// ---------------------------------------------------------------------------

export interface CodingGraphBenchReport {
  /** Schema version — bump when the report shape changes. */
  readonly schemaVersion: number;
  readonly timestamp: string;
  readonly machine: MachineFingerprint;
  readonly fixture: {
    readonly config: SyntheticRepoConfig;
    readonly approximateLoc: number;
    readonly fileCount: number;
    readonly symbolCount: number;
    readonly edgeCount: number;
  };
  /** Full-index wall time (ms) for the entire fixture. */
  readonly fullIndexMs: WallMetric;
  /** LOC/s sustained during full index (higher is better). */
  readonly fullIndexLocsPerSecond: number;
  /** Incremental single-file update latency distribution. */
  readonly incrementalUpdate: MicroMetric;
  /** trace_path (depth ≤ 5) latency distribution. */
  readonly tracePath: MicroMetric;
  /** search_graph name-pattern latency distribution. */
  readonly searchGraph: MicroMetric;
  /** Dead-code query wall time (ms). */
  readonly deadCodeMs: WallMetric;
  /** DB bytes per KLOC after index. */
  readonly dbBytesPerKloc: number;
  /** Peak RSS (bytes) at the end of the run. */
  readonly peakRssBytes: number;
  /** DB file size in bytes after index. */
  readonly dbBytes: number;
  /** Total node + edge count after index. */
  readonly graphNodeCount: number;
  readonly graphEdgeCount: number;
}

// ---------------------------------------------------------------------------
// Regression gate — compares report against baseline with tolerance.
// ---------------------------------------------------------------------------

/**
 * Tracked baseline JSON (bench-owned, separate file from the structural
 * ratchets in scripts/ratchet-baseline.json per issue #1557).
 */
export interface CodingGraphBaseline {
  readonly schemaVersion: number;
  readonly machine: MachineFingerprint;
  readonly fixtureConfig: SyntheticRepoConfig;
  readonly metrics: Readonly<Record<string, number>>;
  readonly createdAt: string;
  /** Human-readable note about how the baseline was captured. */
  readonly note: string;
}

/**
 * Per-metric regression detail. `direction` encodes whether higher or
 * lower is better; `regressed` is true when the measured value exceeds
 * the tolerance-adjusted baseline.
 */
export interface RegressionMetricDetail {
  readonly key: string;
  readonly baseline: number;
  readonly measured: number;
  /** Percentage change relative to baseline (positive = worse). */
  readonly percentChange: number;
  readonly direction: "lower-is-better" | "higher-is-better";
  readonly tolerancePercent: number;
  readonly regressed: boolean;
}

export interface RegressionGateResult {
  readonly passed: boolean;
  readonly regressions: readonly RegressionMetricDetail[];
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Run configuration.
// ---------------------------------------------------------------------------

export interface CodingGraphBenchConfig {
  /** Fixture parameters. Defaults to a small, fast smoke fixture. */
  readonly fixture?: Partial<SyntheticRepoConfig>;
  /**
   * Iterations for micro-metrics (p50/p95). Minimum 20 per the issue.
   * Default 20.
   */
  readonly iterations?: number;
  /** BFS depth for trace_path measurements. Default 5. */
  readonly traceDepth?: number;
  /**
   * Regression tolerance (percent). A metric must regress by MORE than
   * this to count as a failure. Default 30 (generous — perf thresholds
   * in CI flake).
   */
  readonly tolerancePercent?: number;
}

/** Default fixture — small enough for a sub-second smoke run. */
export const DEFAULT_SMOKE_FIXTURE: SyntheticRepoConfig = {
  seed: 42,
  fileCount: 20,
  symbolsPerFile: 10,
  callDensity: 0.3,
  language: "typescript",
};

/** Default fixture for a 10k-node scale run (~1k files × 10 symbols). */
export const DEFAULT_10K_FIXTURE: SyntheticRepoConfig = {
  seed: 42,
  fileCount: 1000,
  symbolsPerFile: 10,
  callDensity: 0.2,
  language: "typescript",
};

/** Minimum iterations for percentile metrics (issue #1557: ≥20). */
export const MIN_ITERATIONS = 20;

/** Default regression tolerance (issue #1557: generous, e.g. 30%). */
export const DEFAULT_TOLERANCE_PERCENT = 30;

/** Report schema version — bump when the shape changes. */
export const CODING_GRAPH_BENCH_SCHEMA_VERSION = 1;
