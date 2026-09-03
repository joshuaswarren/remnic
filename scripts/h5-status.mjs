#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const ARMS = 4;
const FAMILIES = 4;
const HOST_FAULT_LIMIT = 6;
const CLAIM_LEASE_MS = 15 * 60_000;

async function jsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

 async function rowsFromJsonl(file) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function expectedRows(root, run, design) {
  // The frozen design is authoritative: run.json's expectedRows is checked
  // against it by every analyzer, and reconstructing the grid from metadata
  // misses `--arm` subsets and the online stage's iteration factor.
  if (design !== null) {
    if (run.expectedRows !== undefined && run.expectedRows !== design.rows.length) {
      throw new Error("run.json expectedRows does not match the frozen design");
    }
    return design.rows.length;
  }
  if (Number.isInteger(run.expectedRows) && run.expectedRows > 0) {
    if (Number.isInteger(run.limit) && run.limit > 0 && run.expectedRows > run.limit) {
      throw new Error("run.json expectedRows does not match the frozen design");
    }
    return run.expectedRows;
  }
  if (Number.isInteger(run.limit) && run.limit > 0) return run.limit;
  if (!Array.isArray(run.seeds) || !Number.isInteger(run.variantsPerFamily)) {
    throw new Error("run.json is missing seeds or variantsPerFamily");
  }
  const stage = typeof run.stage === "string" ? run.stage : "base";
  const plannedArms = Array.isArray(run.arms) && run.arms.length > 0
    ? run.arms.length
    : stage.startsWith("adaptive-") ? 2 : ARMS;
  return run.seeds.length * run.variantsPerFamily * (run.family ? 1 : FAMILIES) * plannedArms;
}

function trailingHostFaults(tries) {
  let count = 0;
  for (let index = tries.length - 1; index >= 0; index -= 1) {
    if (tries[index]?.outcome?.kind !== "HOST_API_FAULT") break;
    count += 1;
  }
  return count;
}

async function frozenDesign(root) {
  try {
    const design = await jsonFile(path.join(root, "expected-design.json"));
    if (!Array.isArray(design.rows)) throw new Error("expected-design.json has no rows array");
    return design;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

/** Design rows whose attacker rewrite was durably rejected (online stage): they never get an episode. */
async function rejectedRewriteRowKeys(root, design) {
  const rejected = new Set();
  if (design === null) return rejected;
  const invalid = new Set();
  for (const line of await rowsFromJsonl(path.join(root, "online-corpus.jsonl"))) {
    if (line?.valid === false) invalid.add(`${line.arm}\0${line.variantId}`);
  }
  for (const row of design.rows) {
    if (invalid.has(`${row?.identity?.arm}\0${row?.identity?.variantId}`)) rejected.add(row.rowKey);
  }
  return rejected;
}

export async function h5Status(runDir, staleAfterMinutes = 20, statImpl = stat) {
  const root = path.resolve(runDir);
  const run = await jsonFile(path.join(root, "run.json"));
  const design = await frozenDesign(root);
  const expected = await expectedRows(root, run, design);
  const rejectedKeys = await rejectedRewriteRowKeys(root, design);
  const episodes = await rowsFromJsonl(path.join(root, "episodes.jsonl"));
  const episodeKeys = episodes.map((row) => row?.rowKey);
  const uniqueEpisodeKeys = new Set(episodeKeys);
  // episodes.jsonl is an append-only projection; concurrent workers may
  // re-append a resumed terminal row. Byte-identical repeats of one rowKey
  // are one row (the analyzers dedupe the same way); conflicting repeats
  // are malformed.
  const projectionByKey = new Map();
  let conflictingEpisodes = 0;
  for (const row of episodes) {
    const serialized = JSON.stringify(row);
    const prior = projectionByKey.get(row?.rowKey);
    if (prior === undefined) projectionByKey.set(row?.rowKey, serialized);
    else if (prior !== serialized) conflictingEpisodes += 1;
  }
  const checkpointDir = path.join(root, "checkpoints");
  let entries = [];
  try {
    entries = await readdir(checkpointDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const checkpointFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const claimEntries = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".lock"));
  const nowMs = Date.now();
  const activeClaimKeys = new Set();
  let activeClaims = 0;
  let staleClaims = 0;
  let latestMs = (await statImpl(path.join(root, "run.json"))).mtimeMs;
  for (const entry of claimEntries) {
    // Heartbeat writes owner.json; the lock directory itself is only stamped
    // when the row is claimed, so the directory mtime under-reports liveness
    // and quarantines a worker whose row is well within the lease. Read the
    // owner.json mtime (the same source `InjectionSuiteClaimLock` reclaims
    // against) and fall back to the directory mtime only when owner.json is
    // missing.
    let info;
    try {
      info = await statImpl(path.join(checkpointDir, entry.name));
    } catch (error) {
      // Lock directory removed between readdir and stat: the claim is gone,
      // not broken — skip it rather than failing the whole scan.
      if (error?.code !== "ENOENT") throw error;
      continue;
    }
    const ownerPath = path.join(checkpointDir, entry.name, "owner.json");
    let livenessMs = info.mtimeMs;
    try {
      livenessMs = (await statImpl(ownerPath)).mtimeMs;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    latestMs = Math.max(latestMs, livenessMs);
    if (nowMs - livenessMs <= CLAIM_LEASE_MS) {
      activeClaims += 1;
      activeClaimKeys.add(entry.name.slice(0, -".lock".length));
    } else {
      staleClaims += 1;
    }
  }
  let terminalCheckpoints = 0;
  const terminalKeys = new Set();
  let pausedRows = 0;
  let inFlightRows = 0;
  let ambiguousRows = 0;
  let hostFaultTries = 0;

  for (const entry of checkpointFiles) {
    const file = path.join(checkpointDir, entry.name);
    const [checkpoint, info] = await Promise.all([jsonFile(file), statImpl(file)]);
    latestMs = Math.max(latestMs, info.mtimeMs);
    if (!Array.isArray(checkpoint.tries)) throw new Error(`${entry.name} has no tries array`);
    hostFaultTries += checkpoint.tries.filter((item) => item?.outcome?.kind === "HOST_API_FAULT").length;
    if (checkpoint.inFlight) {
      inFlightRows += 1;
      if (!activeClaimKeys.has(checkpoint.rowKey)) ambiguousRows += 1;
    }
    if (checkpoint.terminal) {
      terminalCheckpoints += 1;
      terminalKeys.add(checkpoint.rowKey);
    } else if (rejectedKeys.has(checkpoint.rowKey)) {
      // A durably rejected rewrite is this row's completion; nothing is owed.
    } else if (trailingHostFaults(checkpoint.tries) >= HOST_FAULT_LIMIT) pausedRows += 1;
  }
  // Online-stage rows whose attacker rewrite was durably rejected (corpus
  // line with valid=false) never get a defended episode.
  const rejectedRewriteRows = [...rejectedKeys].filter((key) => !terminalKeys.has(key)).length;

  const errors = [];
  if (conflictingEpisodes > 0) errors.push("duplicate episode rowKey");
  if (episodeKeys.some((key) => typeof key !== "string")) errors.push("episode missing rowKey");
  const completedRows = terminalCheckpoints + rejectedRewriteRows;
  if (uniqueEpisodeKeys.size > expected || completedRows > expected) errors.push("terminal rows exceed design");
  if (uniqueEpisodeKeys.size > terminalCheckpoints) errors.push("episode has no terminal checkpoint");
  const recoveryRows = Math.max(0, terminalCheckpoints - uniqueEpisodeKeys.size);

  const ageMinutes = Math.max(0, (nowMs - latestMs) / 60_000);
  let state;
  if (errors.length > 0) state = "MALFORMED";
  else if (completedRows === expected && recoveryRows === 0) state = "COMPLETE";
  else if (pausedRows > 0 || ambiguousRows > 0 || recoveryRows > 0) state = "PAUSED";
  else if (activeClaims > 0 || ageMinutes <= staleAfterMinutes) state = "RUNNING";
  else state = "STALLED";

  return {
    schemaVersion: 1,
    state,
    stage: run.stage ?? "base",
    runKind: run.runKind ?? "dev",
    modelProfileHash: run.modelProfileHash ?? null,
    expectedRows: expected,
    terminalRows: terminalCheckpoints,
    rejectedRewriteRows,
    remainingRows: expected - completedRows,
    activeClaims,
    staleClaims,
    pausedRows,
    inFlightRows,
    ambiguousRows,
    recoveryRows,
    hostFaultTries,
    ageMinutes: Number(ageMinutes.toFixed(1)),
    errors,
  };
}

async function main() {
  const [runDir, staleRaw] = process.argv.slice(2);
  if (!runDir) throw new Error("usage: node scripts/h5-status.mjs RUN_DIR [STALE_MINUTES]");
  const stale = staleRaw === undefined ? 20 : Number(staleRaw);
  if (!Number.isFinite(stale) || stale <= 0) throw new Error("STALE_MINUTES must be positive");
  const status = await h5Status(runDir, stale);
  console.log(JSON.stringify(status));
  if (status.state === "PAUSED" || status.state === "STALLED") process.exitCode = 2;
  if (status.state === "MALFORMED") process.exitCode = 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
