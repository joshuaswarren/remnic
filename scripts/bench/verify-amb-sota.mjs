#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_EXTERNAL_RESULTS_URL =
  "https://raw.githubusercontent.com/vectorize-io/agent-memory-benchmark/main/external_results.json";
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const remnicRepoRoot = path.resolve(__dirname, "../..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage(0);
  }
  if (!args.result) {
    fail("--result is required", 2);
  }

  const result = await readJson(args.result, "AMB result");
  if (result.oracle === true) {
    fail("oracle-aided AMB runs cannot be verified for SOTA", 2);
  }
  const external = args.external
    ? await readJson(args.external, "external results")
    : await fetchJson(DEFAULT_EXTERNAL_RESULTS_URL);
  const externalSource = args.external ?? DEFAULT_EXTERNAL_RESULTS_URL;

  const dataset = nonEmptyString(result.dataset, "result.dataset");
  const split = nonEmptyString(result.split, "result.split");
  const accuracy = finiteNumber(result.accuracy, "result.accuracy");
  const memoryProviderField = result.memory_provider === undefined
    ? "result.memory"
    : "result.memory_provider";
  const memoryProvider = nonEmptyString(result.memory_provider ?? result.memory, memoryProviderField);
  const runName = typeof result.run_name === "string" ? result.run_name : "";
  const totalQueries = finiteNumber(result.total_queries, "result.total_queries");
  if (totalQueries <= 0) {
    fail("result.total_queries must be greater than zero", 2);
  }
  if (args.minQueries === undefined) {
    fail(
      "--min-queries is required for SOTA verification; pass the full split query count so partial runs cannot be marked SOTA",
      2,
    );
  }
  const minimumQueries = args.minQueries;
  if (totalQueries < minimumQueries) {
    fail(
      `result has ${totalQueries} queries, below required --min-queries ${minimumQueries}`,
      1,
    );
  }
  if (!isRemnicMemoryProvider(memoryProvider)) {
    fail(
      `${memoryProviderField} must be "remnic" for SOTA verification; got ${JSON.stringify(memoryProvider)} (run_name=${JSON.stringify(runName)})`,
      2,
    );
  }

  const entries = external?.[dataset]?.[split];
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`no external results found for ${dataset}/${split}`, 2);
  }
  const best = entries.reduce((currentBest, entry) => {
    const entryAccuracy = typeof entry?.accuracy === "number" ? entry.accuracy : -Infinity;
    const bestAccuracy =
      typeof currentBest?.accuracy === "number" ? currentBest.accuracy : -Infinity;
    return entryAccuracy > bestAccuracy ? entry : currentBest;
  }, entries[0]);
  const target = finiteNumber(best.accuracy, `external_results.${dataset}.${split}.accuracy`);
  const epsilon = args.epsilon ?? 0;
  const beatsTarget = accuracy > target + epsilon;
  const verdict = {
    dataset,
    split,
    memoryProvider,
    runName,
    totalQueries,
    accuracy,
    targetAccuracy: target,
    targetMemory: best.memory,
    targetSource: best.source_label ?? best.source_url ?? null,
    epsilon,
    sota: beatsTarget,
  };
  if (args.manifestOut) {
    await writeManifest(args.manifestOut, {
      verdict,
      result,
      resultPath: args.result,
      externalSource,
      command: args.command,
      ambDir: args.ambDir,
    });
  }

  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!beatsTarget) {
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--result") {
      args.result = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--result=")) {
      args.result = arg.slice("--result=".length);
      continue;
    }
    if (arg === "--external-results") {
      args.external = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--manifest-out") {
      args.manifestOut = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--manifest-out=")) {
      args.manifestOut = arg.slice("--manifest-out=".length);
      continue;
    }
    if (arg === "--command") {
      args.command = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--command=")) {
      args.command = arg.slice("--command=".length);
      continue;
    }
    if (arg === "--amb-dir") {
      args.ambDir = requiredValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--amb-dir=")) {
      args.ambDir = arg.slice("--amb-dir=".length);
      continue;
    }
    if (arg.startsWith("--external-results=")) {
      args.external = arg.slice("--external-results=".length);
      continue;
    }
    if (arg === "--min-queries") {
      args.minQueries = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg.startsWith("--min-queries=")) {
      args.minQueries = parsePositiveInteger(arg.slice("--min-queries=".length), "--min-queries");
      continue;
    }
    if (arg === "--epsilon") {
      args.epsilon = parseNonNegativeNumber(requiredValue(argv, ++index, arg), arg);
      continue;
    }
    if (arg.startsWith("--epsilon=")) {
      args.epsilon = parseNonNegativeNumber(arg.slice("--epsilon=".length), "--epsilon");
      continue;
    }
    fail(`unknown argument: ${arg}`, 2);
  }
  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    fail(`${flag} requires a value`, 2);
  }
  return value;
}

async function readJson(filePath, label) {
  try {
    return jsonObject(JSON.parse(await readFile(filePath, "utf8")), label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`failed to read ${label} from ${filePath}: ${message}`, 2);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`failed to fetch external results: HTTP ${response.status} ${response.statusText}`, 2);
  }
  return jsonObject(await response.json(), "external results");
}

function jsonObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a JSON object`, 2);
  }
  return value;
}

async function writeManifest(pathname, { verdict, result, resultPath, externalSource, command, ambDir }) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resultPath,
    externalResults: externalSource,
    command: command ?? null,
    remnic: {
      repo: remnicRepoRoot,
      commit: await gitRev(remnicRepoRoot),
      dirty: await gitDirty(remnicRepoRoot),
    },
    amb: ambDir
      ? {
          repo: path.resolve(ambDir),
          commit: await gitRev(ambDir),
          dirty: await gitDirty(ambDir),
        }
      : null,
    run: {
      dataset: result.dataset,
      split: result.split,
      memoryProvider: result.memory_provider ?? result.memory ?? null,
      runName: result.run_name ?? null,
      mode: result.mode ?? null,
      oracle: result.oracle ?? null,
      totalQueries: result.total_queries,
      correct: result.correct ?? null,
      accuracy: result.accuracy,
      ingestedDocs: result.ingested_docs ?? null,
      answerLlm: result.answer_llm ?? null,
      judgeLlm: result.judge_llm ?? null,
      description: result.description ?? null,
    },
    verdict,
  };
  await writeFile(pathname, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function gitRev(repo) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitDirty(repo) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} must be a non-empty string`, 2);
  }
  return value;
}

function isRemnicMemoryProvider(value) {
  return value.trim().toLowerCase() === "remnic";
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`, 2);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer`, 2);
  }
  return parsed;
}

function parseNonNegativeNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`${flag} must be a non-negative number`, 2);
  }
  return parsed;
}

function usage(exitCode) {
  process.stdout.write(`Usage:
  scripts/bench/verify-amb-sota.mjs --result <amb-result.json> [options]

Options:
  --external-results <file>  Use a local AMB external_results.json file.
  --manifest-out <file>      Write a reproducibility manifest JSON.
  --command <string>         Command used to produce the AMB result.
  --amb-dir <dir>            AMB checkout used for the run.
  --min-queries <n>          Required full split query count.
  --epsilon <n>              Require accuracy to exceed current best by n.
  -h, --help                 Show this help.
\n`);
  process.exit(exitCode);
}

function fail(message, code) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  fail(message, 2);
});
