const BENCHMARK_RUN_ID_ENV = "REMNIC_BENCH_RUN_ID";

let generatedBenchmarkRunId: string | undefined;

export function resolveBenchmarkRunId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[BENCHMARK_RUN_ID_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  generatedBenchmarkRunId ??= [
    new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-"),
    process.pid,
    Math.random().toString(36).slice(2, 10),
  ].join("-");
  return generatedBenchmarkRunId;
}
