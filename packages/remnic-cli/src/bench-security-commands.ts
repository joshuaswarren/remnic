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

Additional commands:
  remnic bench security injection-suite-analyze --run DIR
  remnic bench security injection-suite-publication-analyze --run DIR
  remnic bench security injection-suite-publication-utility --observations FILE --out FILE
  remnic bench security injection-suite-replay --run DIR
  remnic bench security injection-suite-utility [injection-suite options] [--dataset-dir DIR]
  remnic bench security injection-suite-decide --base DIR --base DIR --utility FILE --utility FILE [--adaptive DIR --adaptive DIR] --out DIR

Options:
  --seeds N                 Positive seed count (required)
  --seed-base N             First deterministic corpus seed (default: 71)
  --variants-per-family N   Variants per attack family (default: 25)
  --family FAMILY           Target one dev/pilot attack family; forbidden for main
  --model-profile ID        Profile label recorded on each row (default: local-dry)
  --stage base|adaptive-r1|adaptive-r2|adaptive-r3|benign|benign-use
                            Frozen corpus stage (default: base)
  --arm ID                  Repeat to select frozen defense arms
  --run-kind dev|pilot|main Run gate to enforce (default: dev)
  --executor local|ollama|openai-compat
                            local = deterministic screen/fence (default)
                            ollama = native /api/chat
                            openai-compat = /v1/chat/completions
                            (api.openai.com / integrate.api.nvidia.com /
                            router.huggingface.co require https + provider key;
                            other hosts require REMNIC_OPENAI_COMPAT_API_KEY
                            and https, except loopback HTTP)
  --base-url URL            Endpoint (default: http://127.0.0.1:11434)
  --model NAME              Model id (default: qwen3.8-27b-64k:latest)
  --model-digest SHA256     Immutable served-model digest (required for main)
  --model-context-tokens N  Native context length (required for main)
  --request-timeout-ms N    Per-call timeout (default: 300000)
  --out DIR                 New run directory (default: ~/.remnic/bench/results/h5-injection-suite)
  --run DIR                 Existing run directory; implies --resume
  --capture-responses       Write raw responses.jsonl beside the checkpoints
  --resume                  Continue an existing run (required if DIR already has run.json)
  --retry-ambiguous         Retry a persisted in-flight paid request after operator review
  --limit N                 Execute at most N planned rows (dry-run / smoke)
  --utility-benchmark ID    Repeat: locomo, longmemeval, or drift-gen
  --longmemeval-dataset-dir DIR
                            Frozen LongMemEval dataset for utility runs
`;

interface InjectionSuiteCommand {
  seeds: number;
  seedBase?: number;
  variantsPerFamily: number;
  family?: "minja" | "sleeper" | "cross-session" | "tool-hijack";
  modelProfileId: string;
  stage:
    | "base"
    | "adaptive-r1"
    | "adaptive-r2"
    | "adaptive-r3"
    | "benign"
    | "benign-use";
  arms?: Array<
    | "none"
    | "fencing"
    | "quarantine"
    | "both"
    | "structured-boundary"
    | "spotlighting-marking"
    | "source-authenticated-fencing"
    | "control-data-isolation"
    | "layered-fence-quarantine"
  >;
  runKind: "dev" | "pilot" | "main";
  outputDir: string;
  resume: boolean;
  retryAmbiguous: boolean;
  limit?: number;
  executor: "local" | "ollama" | "openai-compat";
  datasetDir?: string;
  longmemevalDatasetDir?: string;
  utilityBenchmarks?: Array<"locomo" | "longmemeval" | "drift-gen">;
  baseUrl?: string;
  model?: string;
  modelDigest?: string;
  modelContextTokens?: number;
  requestTimeoutMs?: number;
  captureResponses: boolean;
}

function parsePositiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function parseBenchSecurityArgs(
  args: readonly string[],
): InjectionSuiteCommand | { help: true } {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
    return { help: true };
  if (args[0] !== "injection-suite") {
    throw new Error(`unknown bench security subcommand ${args[0]}`);
  }

  let seeds: number | undefined;
  let seedBase: number | undefined;
  let variantsPerFamily = 25;
  let family: InjectionSuiteCommand["family"];
  let modelProfileId = "local-dry";
  let stage: InjectionSuiteCommand["stage"] = "base";
  const arms: NonNullable<InjectionSuiteCommand["arms"]> = [];
  let runKind: InjectionSuiteCommand["runKind"] = "dev";
  let outputDir = DEFAULT_OUTPUT_DIR;
  let resume = false;
  let retryAmbiguous = false;
  let limit: number | undefined;
  let executor: InjectionSuiteCommand["executor"] = "local";
  let datasetDir: string | undefined;
  let longmemevalDatasetDir: string | undefined;
  const utilityBenchmarks: Array<"locomo" | "longmemeval" | "drift-gen"> = [];
  let baseUrl: string | undefined;
  let model: string | undefined;
  let modelDigest: string | undefined;
  let modelContextTokens: number | undefined;
  let requestTimeoutMs: number | undefined;
  let captureResponses = false;

  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    const next = args[index + 1];
    if (flag === "--seeds") {
      seeds = parsePositiveInteger(next, "--seeds");
      index += 1;
    } else if (flag === "--seed-base") {
      seedBase = parsePositiveInteger(next, "--seed-base");
      index += 1;
    } else if (flag === "--variants-per-family") {
      variantsPerFamily = parsePositiveInteger(next, "--variants-per-family");
      index += 1;
    } else if (flag === "--family") {
      if (
        next !== "minja" &&
        next !== "sleeper" &&
        next !== "cross-session" &&
        next !== "tool-hijack"
      ) {
        throw new Error(
          "--family must be minja, sleeper, cross-session, or tool-hijack",
        );
      }
      family = next;
      index += 1;
    } else if (flag === "--model-profile") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --model-profile");
      modelProfileId = next;
      index += 1;
    } else if (flag === "--stage") {
      if (
        next !== "base" &&
        next !== "adaptive-r1" &&
        next !== "adaptive-r2" &&
        next !== "adaptive-r3" &&
        next !== "benign" &&
        next !== "benign-use"
      ) {
        throw new Error(
          "--stage must be base, adaptive-r1, adaptive-r2, adaptive-r3, benign, or benign-use",
        );
      }
      stage = next;
      index += 1;
    } else if (flag === "--arm") {
      if (
        next !== "none" &&
        next !== "fencing" &&
        next !== "quarantine" &&
        next !== "both" &&
        next !== "structured-boundary" &&
        next !== "spotlighting-marking" &&
        next !== "source-authenticated-fencing" &&
        next !== "control-data-isolation" &&
        next !== "layered-fence-quarantine"
      ) {
        throw new Error("unknown --arm defense baseline");
      }
      if (arms.includes(next)) throw new Error(`duplicate --arm ${next}`);
      arms.push(next);
      index += 1;
    } else if (flag === "--run-kind") {
      if (next !== "dev" && next !== "pilot" && next !== "main") {
        throw new Error("--run-kind must be dev, pilot, or main");
      }
      runKind = next;
      index += 1;
    } else if (flag === "--executor") {
      if (next !== "local" && next !== "ollama" && next !== "openai-compat") {
        throw new Error("--executor must be local, ollama, or openai-compat");
      }
      executor = next;
      index += 1;
    } else if (flag === "--base-url") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --base-url");
      baseUrl = next;
      index += 1;
    } else if (flag === "--model") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --model");
      model = next;
      index += 1;
    } else if (flag === "--model-digest") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --model-digest");
      modelDigest = next;
      index += 1;
    } else if (flag === "--dataset-dir") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --dataset-dir");
      datasetDir = expandTilde(next);
      index += 1;
    } else if (flag === "--longmemeval-dataset-dir") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --longmemeval-dataset-dir");
      longmemevalDatasetDir = expandTilde(next);
      index += 1;
    } else if (flag === "--utility-benchmark") {
      if (next !== "locomo" && next !== "longmemeval" && next !== "drift-gen") {
        throw new Error(
          "--utility-benchmark must be locomo, longmemeval, or drift-gen",
        );
      }
      utilityBenchmarks.push(next);
      index += 1;
    } else if (flag === "--model-context-tokens") {
      modelContextTokens = parsePositiveInteger(next, "--model-context-tokens");
      index += 1;
    } else if (flag === "--request-timeout-ms") {
      requestTimeoutMs = parsePositiveInteger(next, "--request-timeout-ms");
      index += 1;
    } else if (flag === "--out") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --out");
      outputDir = expandTilde(next);
      index += 1;
    } else if (flag === "--run") {
      if (next === undefined || next.startsWith("-"))
        throw new Error("missing value for --run");
      outputDir = expandTilde(next);
      resume = true;
      index += 1;
    } else if (flag === "--resume") {
      resume = true;
    } else if (flag === "--retry-ambiguous") {
      retryAmbiguous = true;
    } else if (flag === "--limit") {
      limit = parsePositiveInteger(next, "--limit");
      index += 1;
    } else if (flag === "--capture-responses") {
      captureResponses = true;
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }

  if (seeds === undefined)
    throw new Error("injection-suite requires --seeds N");
  if (retryAmbiguous && !resume)
    throw new Error("--retry-ambiguous requires --run or --resume");
  return {
    seeds,
    ...(seedBase === undefined ? {} : { seedBase }),
    variantsPerFamily,
    ...(family === undefined ? {} : { family }),
    modelProfileId,
    stage,
    ...(arms.length === 0 ? {} : { arms }),
    runKind,
    outputDir,
    resume,
    executor,
    retryAmbiguous,
    ...(limit === undefined ? {} : { limit }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(modelDigest === undefined ? {} : { modelDigest }),
    ...(modelContextTokens === undefined ? {} : { modelContextTokens }),
    ...(datasetDir === undefined ? {} : { datasetDir }),
    ...(longmemevalDatasetDir === undefined ? {} : { longmemevalDatasetDir }),
    ...(utilityBenchmarks.length === 0 ? {} : { utilityBenchmarks }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    captureResponses,
  };
}

export async function cmdBenchSecurity(args: readonly string[]): Promise<void> {
  try {
    if (args[0] === "injection-suite-publication-utility") {
      if (
        args.length !== 5 ||
        args[1] !== "--observations" ||
        !args[2] ||
        args[3] !== "--out" ||
        !args[4]
      ) {
        throw new Error(
          "injection-suite-publication-utility requires --observations FILE --out FILE",
        );
      }
      const bench = await loadBenchModule();
      const analyze = bench.analyzeInjectionSuitePublicationUtilityFile;
      if (typeof analyze !== "function")
        throw new Error(
          "Installed @remnic/bench lacks H5 publication utility analysis",
        );
      const analysis = await analyze(
        expandTilde(args[2]),
        expandTilde(args[4]),
      );
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }
    if (args[0] === "injection-suite-decide") {
      const baseRunDirs: string[] = [];
      const utilityStatisticsPaths: string[] = [];
      const adaptiveRunDirs: string[] = [];
      let outputDir: string | undefined;
      for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value)
          throw new Error(`missing value for ${flag ?? "campaign flag"}`);
        if (flag === "--base") baseRunDirs.push(expandTilde(value));
        else if (flag === "--utility")
          utilityStatisticsPaths.push(expandTilde(value));
        else if (flag === "--adaptive")
          adaptiveRunDirs.push(expandTilde(value));
        else if (flag === "--out") outputDir = expandTilde(value);
        else throw new Error(`unknown campaign option ${flag}`);
      }
      if (!outputDir)
        throw new Error("injection-suite-decide requires --out DIR");
      const campaignBench = await loadBenchModule();
      const decide = campaignBench.decideInjectionSuiteCampaign;
      if (typeof decide !== "function")
        throw new Error("Installed @remnic/bench lacks H5 campaign decision");
      const decision = await decide({
        baseRunDirs,
        utilityStatisticsPaths,
        ...(adaptiveRunDirs.length > 0 ? { adaptiveRunDirs } : {}),
        outputDir,
      });
      console.log(JSON.stringify(decision, null, 2));
      return;
    }
    if (
      args[0] === "injection-suite-analyze" ||
      args[0] === "injection-suite-publication-analyze" ||
      args[0] === "injection-suite-replay"
    ) {
      if (args.length !== 3 || args[1] !== "--run" || !args[2]) {
        throw new Error(`${args[0]} requires --run DIR`);
      }
      const analysisBench = await loadBenchModule();
      const runDir = expandTilde(args[2]);
      if (args[0] === "injection-suite-analyze") {
        const analyze = analysisBench.analyzeInjectionSuiteRun;
        if (typeof analyze !== "function")
          throw new Error("Installed @remnic/bench lacks H5 analysis");
        const analysis = await analyze(runDir);
        console.log(JSON.stringify(analysis, null, 2));
      } else if (args[0] === "injection-suite-publication-analyze") {
        const analyze = analysisBench.analyzeInjectionSuitePublicationRun;
        if (typeof analyze !== "function")
          throw new Error(
            "Installed @remnic/bench lacks H5 publication analysis",
          );
        const analysis = await analyze(runDir);
        console.log(JSON.stringify(analysis, null, 2));
      } else {
        const replay = analysisBench.replayInjectionSuiteStatistics;
        if (typeof replay !== "function")
          throw new Error("Installed @remnic/bench lacks H5 replay");
        await replay(runDir);
        console.log(JSON.stringify({ replay: "ok", runDir }));
      }
      return;
    }
    const utilityMode = args[0] === "injection-suite-utility";
    const parsed = parseBenchSecurityArgs(
      utilityMode ? ["injection-suite", ...args.slice(1)] : args,
    );
    if ("help" in parsed) {
      console.log(BENCH_SECURITY_USAGE);
      return;
    }
    const bench = await loadBenchModule();
    if (utilityMode) {
      const utility = bench.runInjectionSuiteUtility;
      if (typeof utility !== "function")
        throw new Error("Installed @remnic/bench lacks H5 utility runner");
      const analysis = await utility({
        seeds: parsed.seeds,
        variantsPerFamily: parsed.variantsPerFamily,
        modelProfileId: parsed.modelProfileId,
        outputDir: parsed.outputDir,
        executor: parsed.executor,
        stage: parsed.stage,
        runKind: parsed.runKind,
        ...(parsed.resume ? { resume: true } : {}),
        ...(parsed.retryAmbiguous ? { retryAmbiguous: true } : {}),
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.modelDigest === undefined
          ? {}
          : { modelDigest: parsed.modelDigest }),
        ...(parsed.modelContextTokens === undefined
          ? {}
          : { modelContextTokens: parsed.modelContextTokens }),
        ...(parsed.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: parsed.requestTimeoutMs }),
        ...(parsed.datasetDir === undefined
          ? {}
          : { locomoDatasetDir: parsed.datasetDir }),
        ...(parsed.longmemevalDatasetDir === undefined
          ? {}
          : { longmemevalDatasetDir: parsed.longmemevalDatasetDir }),
        ...(parsed.utilityBenchmarks === undefined
          ? {}
          : { utilityBenchmarks: parsed.utilityBenchmarks }),
      });
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }
    const run = bench.runInjectionSuiteCliCommand;
    if (typeof run !== "function") {
      throw new Error(
        "Installed @remnic/bench is missing runInjectionSuiteCliCommand",
      );
    }
    const result = await run({
      seeds: parsed.seeds,
      ...(parsed.seedBase === undefined ? {} : { seedBase: parsed.seedBase }),
      variantsPerFamily: parsed.variantsPerFamily,
      modelProfileId: parsed.modelProfileId,
      outputDir: parsed.outputDir,
      executor: parsed.executor,
      stage: parsed.stage,
      runKind: parsed.runKind,
      ...(parsed.arms === undefined ? {} : { arms: parsed.arms }),
      ...(parsed.family === undefined ? {} : { family: parsed.family }),
      ...(parsed.resume ? { resume: true } : {}),
      ...(parsed.retryAmbiguous ? { retryAmbiguous: true } : {}),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.modelDigest === undefined
        ? {}
        : { modelDigest: parsed.modelDigest }),
      ...(parsed.modelContextTokens === undefined
        ? {}
        : { modelContextTokens: parsed.modelContextTokens }),
      ...(parsed.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: parsed.requestTimeoutMs }),
      ...(parsed.captureResponses ? { captureResponses: true } : {}),
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
