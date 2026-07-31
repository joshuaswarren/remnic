/**
 * Bench CLI flag tables and validation, extracted from bench-args.ts under
 * the structural ratchet (issue #1995).
 *
 * The allow-lists here are the single source of truth for which flags each
 * `remnic bench <action>` accepts; parseBenchArgs consumes them via
 * validateBenchFlags/collectBenchmarks.
 */

import type { BenchAction } from "./bench-args.js";

export function readBenchOptionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || (value.startsWith("-") && !/^-\d/.test(value))) {
    throw new Error(`ERROR: ${flag} requires a value.`);
  }

  return value;
}

const BENCH_VALUE_FLAGS = Object.freeze([
  "--adapter",
  "--mcp-command",
  "--mcp-args",
  "--mcp-url",
  "--mcp-tool-map",
  "--dataset-dir",
  "--benchmark",
  "--results-dir",
  "--baselines-dir",
  "--runtime-profile",
  "--matrix",
  "--remnic-config",
  "--openclaw-config",
  "--model-source",
  "--gateway-agent-id",
  "--fast-gateway-agent-id",
  "--system-provider",
  "--system-model",
  "--system-base-url",
  "--system-api-key",
  "--system-codex-reasoning-effort",
  "--system-responder-context-budget-chars",
  "--system-responder-prompt-budget-chars",
  "--judge-provider",
  "--judge-model",
  "--judge-base-url",
  "--judge-api-key",
  "--judge-codex-reasoning-effort",
  "--judge-cache-dir",
  "--internal-provider",
  "--internal-model",
  "--internal-base-url",
  "--internal-api-key",
  "--internal-codex-reasoning-effort",
  "--threshold",
  "--custom",
  "--format",
  "--output",
  "--target",
  "--name",
  "--dataset",
  "--model",
  "--limit",
  "--trial-limit",
  "--trial-concurrency",
  "--ingest-concurrency",
  "--task-filter",
  "--seed",
  "--out",
  "--provider",
  "--base-url",
  "--request-timeout",
  "--local-judge-request-timeout",
  "--frontier-judge-request-timeout",
  "--calibration-dir",
  "--calibration-local-config-sha256",
  "--calibration-frontier-config-sha256",
  "--source-result-id",
  "--expected-answer-set-sha256",
  "--expected-question-id-list-sha256",
  "--task-ids-file",
  "--expected-task-id-list-sha256",
  "--drain-timeout",
  "--max-429-wait",
  "--ama-bench-judge-protocol",
  "--ama-bench-cross-judge-provider",
  "--ama-bench-cross-judge-model",
  "--ama-bench-cross-judge-base-url",
  "--ama-bench-cross-judge-api-key",
  "--ama-bench-cross-judge-codex-reasoning-effort",
  "--local-lab-manifest",
  "--memcorrect-adapter",
  "--run",
  "--memory-dir",
  "--qmd",
  "--collection",
  "--users",
  "--epochs",
  "--facts-per-epoch",
  "--drifting-ratio",
  "--contradicted-ratio",
] as const);

const BENCH_BOOLEAN_FLAGS = Object.freeze([
  "--mcp-demo",
  "--quick",
  "--all",
  "--json",
  "--detail",
  "--internal-disable-thinking",
  "--dry-run",
  "--disable-thinking",
  "--no-judge-cache",
  "--resume",
  "--retry-failed",
  "--help",
  "-h",
  "--explain",
] as const);

type BenchValueFlag = (typeof BENCH_VALUE_FLAGS)[number];
type BenchBooleanFlag = (typeof BENCH_BOOLEAN_FLAGS)[number];

const BENCH_VALUE_FLAG_SET: ReadonlySet<string> = new Set(BENCH_VALUE_FLAGS);
const BENCH_BOOLEAN_FLAG_SET: ReadonlySet<string> = new Set(BENCH_BOOLEAN_FLAGS);

function isBenchValueFlag(arg: string): arg is BenchValueFlag {
  return BENCH_VALUE_FLAG_SET.has(arg);
}

function isBenchBooleanFlag(arg: string): arg is BenchBooleanFlag {
  return BENCH_BOOLEAN_FLAG_SET.has(arg);
}

const RUN_VALUE_FLAGS = Object.freeze([
  "--adapter",
  "--mcp-command",
  "--mcp-args",
  "--mcp-url",
  "--mcp-tool-map",
  "--dataset-dir",
  "--results-dir",
  "--runtime-profile",
  "--matrix",
  "--remnic-config",
  "--openclaw-config",
  "--model-source",
  "--gateway-agent-id",
  "--fast-gateway-agent-id",
  "--system-provider",
  "--system-model",
  "--system-base-url",
  "--system-api-key",
  "--system-codex-reasoning-effort",
  "--system-responder-context-budget-chars",
  "--system-responder-prompt-budget-chars",
  "--judge-provider",
  "--judge-model",
  "--judge-base-url",
  "--judge-api-key",
  "--judge-codex-reasoning-effort",
  "--judge-cache-dir",
  "--internal-provider",
  "--internal-model",
  "--internal-base-url",
  "--internal-api-key",
  "--internal-codex-reasoning-effort",
  "--custom",
  "--dataset",
  "--model",
  "--limit",
  "--trial-limit",
  "--trial-concurrency",
  "--ingest-concurrency",
  "--task-filter",
  "--seed",
  "--provider",
  "--base-url",
  "--request-timeout",
  "--calibration-dir",
  "--calibration-local-config-sha256",
  "--calibration-frontier-config-sha256",
  "--task-ids-file",
  "--expected-task-id-list-sha256",
  "--drain-timeout",
  "--max-429-wait",
  "--ama-bench-judge-protocol",
  "--ama-bench-cross-judge-provider",
  "--ama-bench-cross-judge-model",
  "--ama-bench-cross-judge-base-url",
  "--ama-bench-cross-judge-api-key",
  "--ama-bench-cross-judge-codex-reasoning-effort",
  "--local-lab-manifest",
  "--memcorrect-adapter",
] as const satisfies readonly BenchValueFlag[]);

const RUN_BOOLEAN_FLAGS = Object.freeze([
  "--mcp-demo",
  "--quick",
  "--all",
  "--json",
  "--internal-disable-thinking",
  "--disable-thinking",
  "--no-judge-cache",
  "--resume",
  "--retry-failed",
  "--help",
  "-h",
] as const satisfies readonly BenchBooleanFlag[]);

const PUBLISHED_VALUE_FLAGS = Object.freeze([
  ...RUN_VALUE_FLAGS,
  "--name",
  "--out",
] as const satisfies readonly BenchValueFlag[]);

const PUBLISHED_BOOLEAN_FLAGS = Object.freeze([
  ...RUN_BOOLEAN_FLAGS,
  "--dry-run",
] as const satisfies readonly BenchBooleanFlag[]);

const BENCH_ACTION_FLAGS: Record<
  BenchAction,
  {
    value: readonly BenchValueFlag[];
    boolean: readonly BenchBooleanFlag[];
    legacyEqualsPrefixes?: readonly string[];
  }
> = {
  help: { value: [], boolean: ["--help", "-h"] },
  list: { value: [], boolean: ["--json", "--help", "-h"] },
  run: { value: RUN_VALUE_FLAGS, boolean: RUN_BOOLEAN_FLAGS },
  datasets: {
    value: [],
    boolean: ["--all", "--json", "--help", "-h"],
  },
  runs: {
    value: ["--results-dir"],
    boolean: ["--detail", "--json", "--help", "-h"],
  },
  compare: {
    value: ["--results-dir", "--threshold"],
    boolean: ["--json", "--help", "-h"],
  },
  ui: { value: ["--results-dir"], boolean: ["--help", "-h"] },
  results: {
    value: ["--results-dir"],
    boolean: ["--detail", "--json", "--help", "-h"],
  },
  baseline: {
    value: ["--results-dir", "--baselines-dir"],
    boolean: ["--json", "--help", "-h"],
  },
  export: {
    value: ["--results-dir", "--format", "--output"],
    boolean: ["--json", "--help", "-h"],
  },
  providers: { value: [], boolean: ["--json", "--help", "-h"] },
  publish: {
    value: ["--results-dir", "--target", "--output"],
    boolean: ["--json", "--help", "-h"],
  },
  "judge-calibrate": {
    value: [
      "--results-dir",
      "--benchmark",
      "--local-lab-manifest",
      "--judge-provider",
      "--judge-model",
      "--judge-base-url",
      "--judge-api-key",
      "--local-judge-request-timeout",
      "--frontier-judge-request-timeout",
      "--max-429-wait",
      "--calibration-dir",
      "--source-result-id",
      "--expected-answer-set-sha256",
      "--expected-question-id-list-sha256",
    ],
    boolean: ["--disable-thinking", "--json", "--help", "-h"],
  },
  published: {
    value: PUBLISHED_VALUE_FLAGS,
    boolean: PUBLISHED_BOOLEAN_FLAGS,
  },
  check: {
    value: [],
    boolean: ["--json", "--explain", "--help", "-h"],
    legacyEqualsPrefixes: ["--baseline=", "--report="],
  },
  report: {
    value: [],
    boolean: ["--json", "--explain", "--help", "-h"],
    legacyEqualsPrefixes: ["--baseline=", "--report="],
  },
  attribute: {
    value: ["--run", "--results-dir", "--memory-dir", "--threshold", "--qmd", "--collection"],
    boolean: ["--json", "--help", "-h"],
  },
  "drift-gen": {
    value: [
      "--users",
      "--epochs",
      "--seed",
      "--out",
      "--facts-per-epoch",
      "--drifting-ratio",
      "--contradicted-ratio",
    ],
    boolean: ["--json", "--help", "-h"],
  },
};

function formatBenchOptions(
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
  legacyEqualsPrefixes: readonly string[] = [],
): string {
  return [...valueFlags, ...booleanFlags, ...legacyEqualsPrefixes]
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
}

export function validateBenchFlags(action: BenchAction, args: string[]): void {
  const allowed = BENCH_ACTION_FLAGS[action];
  const allowedValue = new Set<string>(allowed.value);
  const allowedBoolean = new Set<string>(allowed.boolean);
  const supportedOptions = formatBenchOptions(
    allowed.value,
    allowed.boolean,
    allowed.legacyEqualsPrefixes,
  );
  const allOptions = formatBenchOptions(BENCH_VALUE_FLAGS, BENCH_BOOLEAN_FLAGS, [
    "--baseline=",
    "--report=",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      continue;
    }

    const legacyEqualsPrefix = allowed.legacyEqualsPrefixes?.find((prefix) => arg.startsWith(prefix));
    if (legacyEqualsPrefix) {
      const value = arg.slice(legacyEqualsPrefix.length);
      if (value.trim().length === 0) {
        throw new Error(`ERROR: ${legacyEqualsPrefix.slice(0, -1)} requires a value.`);
      }
      continue;
    }

    if (isBenchValueFlag(arg)) {
      if (!allowedValue.has(arg)) {
        throw new Error(
          `ERROR: ${arg} is not supported for bench ${action}. Supported options: ${supportedOptions || "(none)"}.`,
        );
      }
      const value = args[index + 1];
      if (!value || (value.startsWith("-") && !/^-\d/.test(value))) {
        throw new Error(`ERROR: ${arg} requires a value.`);
      }
      index += 1;
      continue;
    }

    if (isBenchBooleanFlag(arg)) {
      if (!allowedBoolean.has(arg)) {
        throw new Error(
          `ERROR: ${arg} is not supported for bench ${action}. Supported options: ${supportedOptions || "(none)"}.`,
        );
      }
      continue;
    }

    throw new Error(
      `ERROR: unknown bench option ${arg}. Supported options: ${allOptions}.`,
    );
  }
}

export function collectBenchmarks(argv: string[]): string[] {
  const benchmarks: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (isBenchValueFlag(arg)) {
      index += 1;
      continue;
    }
    if (isBenchBooleanFlag(arg)) {
      continue;
    }
    if (!arg.startsWith("-")) {
      benchmarks.push(arg);
    }
  }
  return benchmarks;
}
