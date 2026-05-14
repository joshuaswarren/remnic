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
const EXPECTED_CODEX_LLM_ID = "codex:gpt-5.5:xhigh:fast";
const REMNIC_REPO_LABEL = "<remnic-repo>";
const AMB_REPO_LABEL = "<agent-memory-benchmark-checkout>";

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
  const memoryProviderResult = fieldValue(result, [
    ["memory_provider", "result.memory_provider"],
    ["memory", "result.memory"],
    ["memoryProvider", "result.memoryProvider"],
  ]);
  const memoryProvider = nonEmptyString(memoryProviderResult.value, memoryProviderResult.name);
  const runNameValue = fieldValue(result, [
    ["run_name", "result.run_name"],
    ["runName", "result.runName"],
  ]);
  const runName = typeof runNameValue.value === "string" ? runNameValue.value : "";
  const totalQueriesResult = fieldValue(result, [
    ["total_queries", "result.total_queries"],
    ["totalQueries", "result.totalQueries"],
  ]);
  const totalQueries = finiteNumber(totalQueriesResult.value, totalQueriesResult.name);
  if (totalQueries <= 0) {
    fail("result.total_queries must be greater than zero", 2);
  }
  if (args.minQueries === undefined) {
    fail(
      "--min-queries is required for SOTA verification; pass the exact full split query count so partial or merged runs cannot be marked SOTA",
      2,
    );
  }
  const minimumQueries = args.minQueries;
  if (totalQueries !== minimumQueries) {
    fail(
      `result has ${totalQueries} queries, expected exactly --min-queries ${minimumQueries}`,
      1,
    );
  }
  if (!isRemnicMemoryProvider(memoryProvider)) {
    fail(
      `${memoryProviderResult.name} must be "remnic" for SOTA verification; got ${JSON.stringify(memoryProvider)} (run_name=${JSON.stringify(runName)})`,
      2,
    );
  }
  const answerLlm = codexAnswerLlmId(result, totalQueries);
  const judgeLlm = requiredCodexLlmId(requiredLlmField(result, "judge"), "result.judge_llm");

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
    answerLlm,
    judgeLlm,
    expectedLlm: EXPECTED_CODEX_LLM_ID,
    totalQueries,
    accuracy,
    targetAccuracy: target,
    targetMemory: best.memory,
    targetSource: best.source_label ?? best.source_url ?? null,
    epsilon,
    sota: beatsTarget,
  };
  const provenance = await collectProvenance(args.ambDir);
  if (beatsTarget) {
    assertCleanSotaProvenance(provenance);
  }
  if (args.manifestOut) {
    await writeManifest(args.manifestOut, {
      verdict,
      result,
      resultPath: args.result,
      externalSource,
      command: args.command,
      provenance,
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

async function writeManifest(pathname, { verdict, result, resultPath, externalSource, command, provenance }) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resultPath: sanitizeManifestText(resultPath, provenance),
    externalResults: externalSource,
    command: command ? sanitizeManifestText(command, provenance) : null,
    remnic: publicProvenance(provenance.remnic),
    amb: provenance.amb ? publicProvenance(provenance.amb) : null,
    run: {
      dataset: verdict.dataset,
      split: verdict.split,
      memoryProvider: verdict.memoryProvider,
      runName: verdict.runName || null,
      mode: result.mode ?? null,
      oracle: result.oracle ?? null,
      totalQueries: verdict.totalQueries,
      correct: result.correct ?? null,
      accuracy: result.accuracy,
      ingestedDocs: optionalResultField(result, [
        ["ingested_docs", "result.ingested_docs"],
        ["ingestedDocs", "result.ingestedDocs"],
      ]),
      answerLlm: verdict.answerLlm,
      judgeLlm: verdict.judgeLlm,
      description:
        typeof result.description === "string"
          ? sanitizeManifestText(result.description, provenance)
          : result.description ?? null,
    },
    verdict,
  };
  await writeFile(pathname, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function collectProvenance(ambDir) {
  const ambRepoRoot = ambDir ? path.resolve(ambDir) : null;
  return {
    remnic: await gitProvenance(remnicRepoRoot, REMNIC_REPO_LABEL),
    amb: ambRepoRoot ? await gitProvenance(ambRepoRoot, AMB_REPO_LABEL) : null,
  };
}

async function gitProvenance(repoPath, repoLabel) {
  return {
    repo: repoLabel,
    sourcePath: repoPath,
    commit: await gitRev(repoPath),
    dirty: await gitDirty(repoPath),
  };
}

function publicProvenance(provenance) {
  return {
    repo: provenance.repo,
    commit: provenance.commit,
    dirty: provenance.dirty,
  };
}

function assertCleanSotaProvenance(provenance) {
  assertCleanRepoProvenance(provenance.remnic, "Remnic checkout");
  if (!provenance.amb) {
    fail("--amb-dir is required for SOTA verification so AMB provenance can be recorded", 2);
  }
  assertCleanRepoProvenance(provenance.amb, "AMB checkout");
}

function assertCleanRepoProvenance(provenance, label) {
  if (!provenance.commit) {
    fail(`${label} provenance is missing a git commit; SOTA verification requires a git checkout`, 2);
  }
  if (provenance.dirty !== false) {
    fail(`${label} provenance is dirty or unavailable; commit or discard changes before SOTA verification`, 2);
  }
}

function sanitizeManifestText(value, provenance) {
  let sanitized = value;
  for (const repo of [provenance.remnic, provenance.amb].filter(Boolean)) {
    sanitized = replaceAllLiteral(sanitized, repo.sourcePath, repo.repo);
  }
  sanitized = sanitized.replace(
    /\bREMNIC_AMB_NODE=(?:"[^"]+"|'[^']+'|\S+)/g,
    "REMNIC_AMB_NODE=<node>",
  );
  sanitized = sanitized.replace(
    /\bREMNIC_AMB_CODEX_BIN=(?:"[^"]+"|'[^']+'|\S+)/g,
    "REMNIC_AMB_CODEX_BIN=<codex>",
  );
  return sanitized;
}

function replaceAllLiteral(value, search, replacement) {
  return value.split(search).join(replacement);
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

function fieldValue(record, fields) {
  for (const [key, name] of fields) {
    if (record[key] !== undefined && record[key] !== null) {
      return { value: record[key], name };
    }
  }
  return { value: undefined, name: fields[0]?.[1] ?? "result field" };
}

function optionalResultField(record, fields) {
  const resolved = fieldValue(record, fields);
  return resolved.value ?? null;
}

function llmField(result, role) {
  const snakeName = `${role}_llm`;
  const camelName = `${role}Llm`;
  const direct = fieldValue(result, [
    [snakeName, `result.${snakeName}`],
    [camelName, `result.${camelName}`],
  ]);
  if (direct.value !== undefined && direct.value !== null) {
    return direct;
  }
  if (isPlainObject(result.llm)) {
    return fieldValue(result.llm, [
      [snakeName, `result.llm.${snakeName}`],
      [camelName, `result.llm.${camelName}`],
    ]);
  }
  return { value: undefined, name: `result.${snakeName}` };
}

function requiredLlmField(result, role) {
  const field = llmField(result, role);
  if (field.value === undefined || field.value === null) {
    fail(`${field.name} must be "${EXPECTED_CODEX_LLM_ID}" for SOTA verification; got absent`, 2);
  }
  return field.value;
}

function requiredCodexLlmId(value, name) {
  if (value === undefined || value === null) {
    fail(`${name} must be "${EXPECTED_CODEX_LLM_ID}" for SOTA verification; got absent`, 2);
  }
  if (typeof value !== "string") {
    fail(`${name} must be a string`, 2);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    fail(`${name} must be a non-empty string`, 2);
  }
  if (normalized !== EXPECTED_CODEX_LLM_ID) {
    fail(
      `${name} must be "${EXPECTED_CODEX_LLM_ID}" for SOTA verification; got ${JSON.stringify(value)}`,
      2,
    );
  }
  return normalized;
}

function codexAnswerLlmId(result, totalQueries) {
  const answerField = llmField(result, "answer");
  if (answerField.value !== undefined && answerField.value !== null) {
    return requiredCodexLlmId(answerField.value, answerField.name);
  }
  const mode = typeof result.mode === "string" ? result.mode.trim().toLowerCase() : "";
  if (mode === "agent" && hasAgentCodexAnswerProvenance(result.results, totalQueries)) {
    return EXPECTED_CODEX_LLM_ID;
  }
  fail(
    `result.answer_llm must be "${EXPECTED_CODEX_LLM_ID}" for SOTA verification, or agent-mode results must include ${EXPECTED_CODEX_LLM_ID} in every result.raw_response.answerModel`,
    2,
  );
}

function hasAgentCodexAnswerProvenance(results, totalQueries) {
  if (!Array.isArray(results) || results.length !== totalQueries) {
    return false;
  }
  return results.every((entry) => {
    const rawResponse = isPlainObject(entry)
      ? entry.raw_response ?? entry.rawResponse
      : null;
    return isPlainObject(rawResponse) &&
      rawResponse.answerModel === EXPECTED_CODEX_LLM_ID;
  });
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
  --amb-dir <dir>            Clean AMB git checkout used for the run.
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
