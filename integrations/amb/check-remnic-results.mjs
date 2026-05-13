#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const DEFAULT_SPLITS = ["100k", "500k", "1m", "10m"];
const DEFAULT_ANSWER_LLM = "gemini:gemini-3.1-pro-preview";
const DEFAULT_JUDGE_LLM = "gemini:gemini-2.5-flash-lite";

function usage() {
  console.log(`Usage:
  integrations/amb/check-remnic-results.mjs --amb-dir /path/to/agent-memory-benchmark [options]

Options:
  --amb-dir DIR       Required. Agent Memory Benchmark checkout.
  --run-name NAME     Remnic AMB run/output name. Default: remnic.
  --mode MODE         AMB mode directory. Use "any" to discover exactly one result per split. Default: rag.
  --output-dir DIR    AMB output directory. Relative paths resolve under --amb-dir. Default: outputs.
  --splits LIST       Comma-separated BEAM splits. Default: 100k,500k,1m,10m.
  --answer-llm ID     Required answer LLM id. Default: ${DEFAULT_ANSWER_LLM}.
  --judge-llm ID      Required judge LLM id. Default: ${DEFAULT_JUDGE_LLM}.
  --allow-equal       Treat a tie with public best as SOTA. Default: require strictly greater.
  --allow-extra-queries
                     Allow total_queries above the public full split count. Default: require exact count.
`);
}

function parseArgs(argv) {
  const args = {
    ambDir: "",
    runName: "remnic",
    mode: "rag",
    outputDir: "outputs",
    splits: DEFAULT_SPLITS,
    answerLlm: DEFAULT_ANSWER_LLM,
    judgeLlm: DEFAULT_JUDGE_LLM,
    allowEqual: false,
    allowExtraQueries: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--amb-dir":
        args.ambDir = argv[++index] ?? "";
        break;
      case "--run-name":
        args.runName = argv[++index] ?? "";
        break;
      case "--mode":
        args.mode = argv[++index] ?? "";
        break;
      case "--output-dir":
        args.outputDir = argv[++index] ?? "";
        break;
      case "--splits":
        args.splits = (argv[++index] ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "--answer-llm":
        args.answerLlm = argv[++index] ?? "";
        break;
      case "--judge-llm":
        args.judgeLlm = argv[++index] ?? "";
        break;
      case "--allow-equal":
        args.allowEqual = true;
        break;
      case "--allow-extra-queries":
        args.allowExtraQueries = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.ambDir) {
    throw new Error("--amb-dir is required");
  }
  if (!args.runName) {
    throw new Error("--run-name must not be empty");
  }
  if (!args.mode) {
    throw new Error("--mode must not be empty");
  }
  if (!args.outputDir) {
    throw new Error("--output-dir must not be empty");
  }
  if (args.splits.length === 0) {
    throw new Error("--splits must include at least one split");
  }
  if (!args.answerLlm) {
    throw new Error("--answer-llm must not be empty");
  }
  if (!args.judgeLlm) {
    throw new Error("--judge-llm must not be empty");
  }
  return args;
}

function readJson(file) {
  const raw = readFileSync(file);
  const text = file.endsWith(".gz")
    ? gunzipSync(raw).toString("utf8")
    : raw.toString("utf8");
  return JSON.parse(text);
}

function resolveOutputRoot(ambDir, outputDir) {
  return path.isAbsolute(outputDir)
    ? path.resolve(outputDir)
    : path.resolve(ambDir, outputDir);
}

function existingResultFile(base, split) {
  const jsonPath = path.join(base, `${split}.json`);
  const gzipPath = path.join(base, `${split}.json.gz`);
  if (existsSync(jsonPath)) return jsonPath;
  if (existsSync(gzipPath)) return gzipPath;
  return undefined;
}

function directoryExists(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function expectedResultPath(outputRoot, runName, mode, split) {
  return path.join(outputRoot, "beam", runName, mode, `${split}.json`);
}

function findResultFile(outputRoot, runName, mode, split) {
  if (mode !== "any") {
    const base = path.join(outputRoot, "beam", runName, mode);
    return {
      status: "ok",
      mode,
      file: existingResultFile(base, split) ??
        expectedResultPath(outputRoot, runName, mode, split),
    };
  }

  const runRoot = path.join(outputRoot, "beam", runName);
  if (!directoryExists(runRoot)) {
    return {
      status: "missing",
      mode: null,
      file: path.join(runRoot, "*", `${split}.json`),
    };
  }

  const candidates = readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      mode: entry.name,
      file: existingResultFile(path.join(runRoot, entry.name), split),
    }))
    .filter((entry) => entry.file)
    .sort((a, b) => a.mode.localeCompare(b.mode));

  if (candidates.length === 1) {
    return {
      status: "ok",
      mode: candidates[0].mode,
      file: candidates[0].file,
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      mode: null,
      file: null,
      candidates,
    };
  }

  return {
    status: "missing",
    mode: null,
    file: path.join(runRoot, "*", `${split}.json`),
  };
}

function publicBestBySplit(manifest) {
  const best = new Map();
  for (const entry of manifest) {
    if (
      !entry ||
      entry.dataset !== "beam" ||
      typeof entry.split !== "string" ||
      typeof entry.accuracy !== "number"
    ) {
      continue;
    }
    const previous = best.get(entry.split);
    if (!previous || entry.accuracy > previous.accuracy) {
      best.set(entry.split, {
        memory: entry.run_name || entry.memory || entry.memory_provider || "unknown",
        accuracy: entry.accuracy,
        totalQueries:
          typeof entry.total_queries === "number" ? entry.total_queries : null,
        path: entry.path,
      });
    }
  }
  return best;
}

function invalidResultStatus(result) {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray(result.results) &&
    !Object.hasOwn(result, "accuracy")
  ) {
    return "retrieval-only";
  }
  return "invalid";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ambDir = path.resolve(args.ambDir);
  const manifestPath = path.join(ambDir, "results-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`AMB results manifest not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest)) {
    throw new Error(`AMB results manifest must be a JSON array: ${manifestPath}`);
  }
  const outputRoot = resolveOutputRoot(ambDir, args.outputDir);
  const best = publicBestBySplit(manifest);
  let allPresent = true;
  let allSota = true;
  const rows = [];

  for (const split of args.splits) {
    const target = best.get(split);
    const resultLocation = findResultFile(outputRoot, args.runName, args.mode, split);
    if (resultLocation.status === "ambiguous") {
      allPresent = false;
      allSota = false;
      rows.push({
        split,
        status: "ambiguous",
        remnic: null,
        publicBest: target?.accuracy ?? null,
        publicBestMemory: target?.memory ?? null,
        candidates: resultLocation.candidates,
      });
      continue;
    }
    const file = resultLocation.file;
    if (!file || !existsSync(file)) {
      allPresent = false;
      allSota = false;
      rows.push({
        split,
        status: "missing",
        remnic: null,
        publicBest: target?.accuracy ?? null,
        publicBestMemory: target?.memory ?? null,
        file,
        mode: resultLocation.mode,
      });
      continue;
    }
    const result = readJson(file);
    if (result?.dataset !== "beam" || result?.split !== split) {
      allSota = false;
      rows.push({
        split,
        status: "wrong-artifact",
        remnic: null,
        publicBest: target?.accuracy ?? null,
        publicBestMemory: target?.memory ?? null,
        dataset: result?.dataset ?? null,
        artifactSplit: result?.split ?? null,
        requiredDataset: "beam",
        requiredSplit: split,
        file,
        mode: resultLocation.mode,
      });
      continue;
    }
    const accuracy = Number(result.accuracy);
    if (!Number.isFinite(accuracy)) {
      allSota = false;
      rows.push({
        split,
        status: invalidResultStatus(result),
        remnic: null,
        publicBest: target?.accuracy ?? null,
        publicBestMemory: target?.memory ?? null,
        file,
        mode: resultLocation.mode,
      });
      continue;
    }
    const targetAccuracy = target?.accuracy;
    const totalQueries = Number(result.total_queries);
    const requiredTotalQueries = target?.totalQueries ?? null;
    const hasComparableQueryCount =
      typeof requiredTotalQueries !== "number" ||
      (Number.isInteger(totalQueries) &&
        (args.allowExtraQueries
          ? totalQueries >= requiredTotalQueries
          : totalQueries === requiredTotalQueries));
    const answerLlm = String(result.answer_llm ?? "");
    const judgeLlm = String(result.judge_llm ?? "");
    const hasComparableModels =
      answerLlm === args.answerLlm && judgeLlm === args.judgeLlm;
    const isSota =
      typeof targetAccuracy !== "number"
        ? false
        : args.allowEqual
          ? accuracy >= targetAccuracy
          : accuracy > targetAccuracy;
    if (!isSota || !hasComparableQueryCount || !hasComparableModels) {
      allSota = false;
    }
    const status = !hasComparableModels
      ? "wrong-models"
      : !hasComparableQueryCount
        ? "partial"
        : isSota
          ? "sota"
          : "below";
    rows.push({
      split,
      status,
      remnic: accuracy,
      publicBest: targetAccuracy ?? null,
      publicBestMemory: target?.memory ?? null,
      totalQueries: Number.isInteger(totalQueries) ? totalQueries : null,
      requiredTotalQueries,
      correct: result.correct ?? null,
      answerLlm: answerLlm || null,
      judgeLlm: judgeLlm || null,
      requiredAnswerLlm: args.answerLlm,
      requiredJudgeLlm: args.judgeLlm,
      file,
      mode: resultLocation.mode,
    });
  }

  console.log(JSON.stringify({
    ok: allPresent && allSota,
    allPresent,
    allSota,
    outputRoot,
    requiredAnswerLlm: args.answerLlm,
    requiredJudgeLlm: args.judgeLlm,
    requirement: args.allowEqual
      ? `Remnic accuracy must be >= current public best, total_queries must ${args.allowExtraQueries ? "cover" : "equal"} the public full split, and answer/judge LLM ids must match for every requested split.`
      : `Remnic accuracy must be > current public best, total_queries must ${args.allowExtraQueries ? "cover" : "equal"} the public full split, and answer/judge LLM ids must match for every requested split.`,
    rows,
  }, null, 2));

  if (!allPresent || !allSota) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
