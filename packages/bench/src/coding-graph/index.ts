/**
 * Coding-graph benchmark suite — public re-exports (issue #1557).
 *
 * The CLI reaches this surface only through the optional loader
 * (packages/remnic-cli/src/optional-bench.ts). Nothing bench-related enters
 * the base `dependencies`/`noExternal` (rule 57).
 */

export {
  createSeededRng,
  generateSyntheticRepo,
  pickStableQualifiedName,
} from "./generator.js";

export {
  runCodingGraphBenchmark,
  captureMachineFingerprint,
} from "./harness.js";

export {
  checkCodingGraphRegression,
  extractMetrics,
  buildBaselineFromReport,
  compareMachineFingerprints,
  METRIC_DIRECTION,
} from "./regression.js";
export type { RegressionMetricKey } from "./regression.js";

export type {
  SyntheticRepoConfig,
  GeneratedRepo,
  SyntheticFileIR,
  SyntheticSymbol,
  SyntheticEdge,
  MachineFingerprint,
  MicroMetric,
  WallMetric,
  CodingGraphMetricKey,
  CodingGraphBenchReport,
  CodingGraphBaseline,
  RegressionMetricDetail,
  RegressionGateResult,
  CodingGraphBenchConfig,
} from "./types.js";

export {
  DEFAULT_SMOKE_FIXTURE,
  DEFAULT_10K_FIXTURE,
  MIN_ITERATIONS,
  DEFAULT_TOLERANCE_PERCENT,
  CODING_GRAPH_BENCH_SCHEMA_VERSION,
} from "./types.js";
