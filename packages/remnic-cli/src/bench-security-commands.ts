/**
 * `remnic bench security injection-suite` (#1962).
 *
 * Sibling of bench-coding-commands.ts so index.ts stays inside its ratchet.
 * Output defaults outside the checkout, matching H6.
 */

import path from "node:path";
import { loadBenchModule } from "./optional-bench.js";
import { expandTilde, resolveHomeDir } from "./path-utils.js";

const DEFAULT_OUTPUT_DIR = path.join(
  resolveHomeDir(),
  ".remnic",
  "bench",
  "results",
  "h5-injection-suite",
);

export const BENCH_SECURITY_USAGE = `Usage: remnic bench security injection-suite --seeds N [options]

H5 injection-suite runner. Resume, host-fault pause, multi-host claim
leases, and --limit follow the H6 contract (issue #1963 / PR #2312).

Options:
  --seeds N                 Positive seed count (required)
  --variants-per-family N   Variants per attack family (default: 25)
  --model-profile ID        Profile label recorded on each row (default: local-dry)
  --executor local|ollama|openai-compat
                            local = deterministic screen/fence (tests)
                            ollama = native /api/chat (default live)
                            openai-compat = /v1/chat/completions
  --base-url URL            Endpoint (default: http://127.0.0.1:11434)
  --model NAME              Model id (default: qwen2.5:7b-instruct)
  --request-timeout-ms N    Per-call timeout (default: 120000)
  --out DIR                 New run directory (default: ~/.remnic/bench/results/h5-injection-suite)
  --run DIR                 Existing run directory; implies --resume
  --resume                  Continue an existing run (required if DIR already has run.json)
  --limit N                 Execute at most N planned rows (dry-run / smoke)
`;

interface InjectionSuiteCommand {
  seeds: number;
  variantsPerFamily: number;
  modelProfileId: string;
  outputDir: string;
  resume: boolean;
  limit?: number;
  executor: "local" | "ollama" | "openai-compat";
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
}

function parsePositiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function parseBenchSecurityArgs(args: readonly string[]): InjectionSuiteCommand | { help: true } {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return { help: true };
  if (args[0] !== "injection-suite") {
    throw new Error(`unknown bench security subcommand ${args[0]}`);
  }

  let seeds: number | undefined;
  let variantsPerFamily = 25;
  let modelProfileId = "local-dry";
  let outputDir = DEFAULT_OUTPUT_DIR;
  let resume = false;
  let limit: number | undefined;
  let executor: InjectionSuiteCommand["executor"] = "local";
  let baseUrl: string | undefined;
  let model: string | undefined;
  let requestTimeoutMs: number | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    const next = args[index + 1];
    if (flag === "--seeds") {
      seeds = parsePositiveInteger(next, "--seeds");
      index += 1;
    } else if (flag === "--variants-per-family") {
      variantsPerFamily = parsePositiveInteger(next, "--variants-per-family");
      index += 1;
    } else if (flag === "--model-profile") {
      if (next === undefined || next.startsWith("-")) throw new Error("missing value for --model-profile");
      modelProfileId = next;
      index += 1;
    } else if (flag === "--executor") {
      if (next !== "local" && next !== "ollama" && next !== "openai-compat") {
        throw new Error("--executor must be local, ollama, or openai-compat");
      }
      executor = next;
      index += 1;
    } else if (flag === "--base-url") {
      if (next === undefined || next.startsWith("-")) throw new Error("missing value for --base-url");
      baseUrl = next;
      index += 1;
    } else if (flag === "--model") {
      if (next === undefined || next.startsWith("-")) throw new Error("missing value for --model");
      model = next;
      index += 1;
    } else if (flag === "--request-timeout-ms") {
      requestTimeoutMs = parsePositiveInteger(next, "--request-timeout-ms");
      index += 1;
    } else if (flag === "--out") {
      if (next === undefined || next.startsWith("-")) throw new Error("missing value for --out");
      outputDir = expandTilde(next);
      index += 1;
    } else if (flag === "--run") {
      if (next === undefined || next.startsWith("-")) throw new Error("missing value for --run");
      outputDir = expandTilde(next);
      resume = true;
      index += 1;
    } else if (flag === "--resume") {
      resume = true;
    } else if (flag === "--limit") {
      limit = parsePositiveInteger(next, "--limit");
      index += 1;
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }

  if (seeds === undefined) throw new Error("injection-suite requires --seeds N");
  return {
    seeds,
    variantsPerFamily,
    modelProfileId,
    outputDir,
    resume,
    executor,
    ...(limit === undefined ? {} : { limit }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

export async function cmdBenchSecurity(args: readonly string[]): Promise<void> {
  try {
    const parsed = parseBenchSecurityArgs(args);
    if ("help" in parsed) {
      console.log(BENCH_SECURITY_USAGE);
      return;
    }
    const bench = await loadBenchModule();
    const run = bench.runInjectionSuiteCliCommand;
    if (typeof run !== "function") {
      throw new Error("Installed @remnic/bench is missing runInjectionSuiteCliCommand");
    }
    const result = await run({
      seeds: parsed.seeds,
      variantsPerFamily: parsed.variantsPerFamily,
      modelProfileId: parsed.modelProfileId,
      outputDir: parsed.outputDir,
      executor: parsed.executor,
      ...(parsed.resume ? { resume: true } : {}),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: parsed.requestTimeoutMs }),
    });
    if (result.exitCode === 0) console.log(result.output);
    else console.error(result.output);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\n${BENCH_SECURITY_USAGE}`);
    process.exitCode = 1;
  }
}
