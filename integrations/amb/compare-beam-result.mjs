#!/usr/bin/env node
/**
 * Compare a local Remnic BEAM result file against the current public AMB
 * leaderboard for the same split and comparable response mode.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const RESULTS_API = "https://agentmemorybenchmark.ai/api/results";
const EPSILON = 1e-12;
const PUBLIC_SINGLE_QUERY_MODE = "single-query";
const REQUIRED_ANSWER_LLM = "gemini:gemini-3.1-pro-preview";
const REQUIRED_JUDGE_LLM = "gemini:gemini-2.5-flash-lite";

function usage() {
  return [
    "Usage: node integrations/amb/compare-beam-result.mjs <result.json|result.json.gz>",
    "",
    "Exits 0 only when the local result is at least tied for current public",
    "BEAM SOTA on the same split.",
  ].join("\n");
}

export function readResult(file) {
  const bytes = readFileSync(file);
  const text = file.endsWith(".gz")
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("result file must contain a JSON object");
  }
  return parsed;
}

export function normalizeAccuracy(result) {
  if (typeof result.accuracy !== "number") {
    throw new Error("result.accuracy must be a finite number");
  }
  const accuracy = result.accuracy;
  if (!Number.isFinite(accuracy)) {
    throw new Error("result.accuracy must be a finite number");
  }
  return accuracy;
}

export async function fetchPublicBeamRows() {
  const response = await fetch(RESULTS_API);
  if (!response.ok) {
    throw new Error(`failed to fetch AMB results: ${response.status} ${response.statusText}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("AMB results API did not return an array");
  }
  return rows.filter((row) => row.dataset === "beam");
}

export function normalizeBeamMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return normalized === "rag" ? PUBLIC_SINGLE_QUERY_MODE : normalized;
}

function normalizePublicAccuracy(row, split, mode) {
  const value = row.accuracy;
  const accuracy =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(accuracy)) {
    throw new Error(
      `public BEAM row accuracy must be a finite number for split ${split} and mode ${mode}`,
    );
  }
  return accuracy;
}

export function assertPublicComparableBeamResult(result) {
  if (result.dataset !== "beam") {
    throw new Error(`expected dataset=beam, received ${String(result.dataset)}`);
  }
  const split = String(result.split || "");
  if (!split) {
    throw new Error("result.split is required");
  }
  const mode = normalizeBeamMode(result.mode);
  if (mode !== PUBLIC_SINGLE_QUERY_MODE) {
    throw new Error(
      `expected mode=rag or mode=single-query for public BEAM single-query comparison, received ${String(result.mode)}`,
    );
  }
  if (result.answer_llm !== REQUIRED_ANSWER_LLM) {
    throw new Error(
      `expected answer_llm=${REQUIRED_ANSWER_LLM}, received ${String(result.answer_llm)}`,
    );
  }
  if (result.judge_llm !== REQUIRED_JUDGE_LLM) {
    throw new Error(
      `expected judge_llm=${REQUIRED_JUDGE_LLM}, received ${String(result.judge_llm)}`,
    );
  }
  return { split, mode };
}

export function findSplitSota(rows, split, mode = PUBLIC_SINGLE_QUERY_MODE) {
  const normalizedMode = normalizeBeamMode(mode);
  const matching = rows.filter(
    (row) => row.split === split && normalizeBeamMode(row.mode) === normalizedMode,
  );
  if (matching.length === 0) {
    throw new Error(`no public BEAM rows found for split ${split} and mode ${normalizedMode}`);
  }
  const scored = matching.map((row) => ({
    ...row,
    accuracy: normalizePublicAccuracy(row, split, normalizedMode),
  }));
  return scored.reduce((best, row) =>
    row.accuracy > best.accuracy ? row : best,
  );
}

export function assertFullComparableRun(result, publicSota) {
  const localTotal = Number(result.total_queries);
  const publicTotal = Number(publicSota.total_queries);
  if (!Number.isInteger(localTotal) || localTotal <= 0) {
    throw new Error(`result.total_queries must be a positive integer, received ${String(result.total_queries)}`);
  }
  if (!Number.isInteger(publicTotal) || publicTotal <= 0) {
    throw new Error(`public SOTA total_queries is not a positive integer for split ${String(result.split)}`);
  }
  if (localTotal !== publicTotal) {
    throw new Error(
      `expected full split with total_queries=${publicTotal}, received ${localTotal}; partial query-limit runs are not public-comparable`,
    );
  }
  if (Array.isArray(result.results) && result.results.length !== localTotal) {
    throw new Error(
      `result.results length ${result.results.length} does not match total_queries=${localTotal}`,
    );
  }
}

export async function compareBeamResult(file) {
  const local = readResult(file);
  const { split, mode } = assertPublicComparableBeamResult(local);

  const localAccuracy = normalizeAccuracy(local);
  const publicRows = await fetchPublicBeamRows();
  const sota = findSplitSota(publicRows, split, mode);
  assertFullComparableRun(local, sota);
  const sotaAccuracy = Number(sota.accuracy);
  const delta = localAccuracy - sotaAccuracy;
  const isSota = delta + EPSILON >= 0;

  return {
    split,
    local: {
      run_name: local.run_name,
      memory_provider: local.memory_provider,
      mode: local.mode,
      comparable_mode: mode,
      accuracy: localAccuracy,
      total_queries: local.total_queries,
      answer_llm: local.answer_llm,
      judge_llm: local.judge_llm,
    },
    current_public_sota: {
      run_name: sota.run_name,
      memory: sota.memory,
      mode: sota.mode,
      accuracy: sotaAccuracy,
      total_queries: sota.total_queries,
      path: sota.path,
    },
    delta,
    is_sota: isSota,
  };
}

function isDirectEntrypoint() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  const file = process.argv[2];
  if (!file || file === "--help" || file === "-h") {
    console.error(usage());
    process.exit(file ? 0 : 2);
  }

  try {
    const comparison = await compareBeamResult(file);
    console.log(JSON.stringify(comparison, null, 2));
    process.exit(comparison.is_sota ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
