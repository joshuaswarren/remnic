#!/usr/bin/env node
/**
 * Compare a local Remnic BEAM result file against the current public AMB
 * leaderboard for the same split.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const RESULTS_API = "https://agentmemorybenchmark.ai/api/results";
const EPSILON = 1e-12;

function usage() {
  return [
    "Usage: node integrations/amb/compare-beam-result.mjs <result.json|result.json.gz>",
    "",
    "Exits 0 only when the local result is at least tied for current public",
    "BEAM SOTA on the same split.",
  ].join("\n");
}

function readResult(file) {
  const bytes = readFileSync(file);
  const text = file.endsWith(".gz")
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  return JSON.parse(text);
}

function normalizeAccuracy(result) {
  const accuracy = Number(result.accuracy);
  if (!Number.isFinite(accuracy)) {
    throw new Error("result.accuracy must be a finite number");
  }
  return accuracy;
}

async function fetchPublicBeamRows() {
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

function findSplitSota(rows, split) {
  const matching = rows.filter((row) => row.split === split);
  if (matching.length === 0) {
    throw new Error(`no public BEAM rows found for split ${split}`);
  }
  return matching.reduce((best, row) =>
    Number(row.accuracy) > Number(best.accuracy) ? row : best,
  );
}

const file = process.argv[2];
if (!file || file === "--help" || file === "-h") {
  console.error(usage());
  process.exit(file ? 0 : 2);
}

try {
  const local = readResult(file);
  if (local.dataset !== "beam") {
    throw new Error(`expected dataset=beam, received ${String(local.dataset)}`);
  }
  const split = String(local.split || "");
  if (!split) {
    throw new Error("result.split is required");
  }

  const localAccuracy = normalizeAccuracy(local);
  const publicRows = await fetchPublicBeamRows();
  const sota = findSplitSota(publicRows, split);
  const sotaAccuracy = Number(sota.accuracy);
  const delta = localAccuracy - sotaAccuracy;
  const isSota = delta + EPSILON >= 0;

  console.log(JSON.stringify({
    split,
    local: {
      run_name: local.run_name,
      memory_provider: local.memory_provider,
      mode: local.mode,
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
  }, null, 2));

  process.exit(isSota ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
