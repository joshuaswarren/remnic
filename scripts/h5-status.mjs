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

function expectedRows(run) {
  let computed;
  if (Number.isInteger(run.limit) && run.limit > 0) computed = run.limit;
  else {
    if (!Array.isArray(run.seeds) || !Number.isInteger(run.variantsPerFamily)) {
      throw new Error("run.json is missing seeds or variantsPerFamily");
    }
    // Adaptive stages run a fixed two-arm grid (fencing + both); a frozen
    // `run.expectedRows` already wins over the formula when present.
    const stage = typeof run.stage === "string" ? run.stage : "base";
    const plannedArms = Array.isArray(run.arms) && run.arms.length > 0
      ? run.arms.length
      : stage.startsWith("adaptive-") ? 2 : ARMS;
    computed = run.seeds.length * run.variantsPerFamily * (run.family ? 1 : FAMILIES) * plannedArms;
  }
  if (run.expectedRows !== undefined && run.expectedRows !== computed) {
    throw new Error("run.json expectedRows does not match the frozen design");
  }
  return computed;
}

function trailingHostFaults(tries) {
  let count = 0;
  for (let index = tries.length - 1; index >= 0; index -= 1) {
    if (tries[index]?.outcome?.kind !== "HOST_API_FAULT") break;
    count += 1;
  }
  return count;
}

export async function h5Status(runDir, staleAfterMinutes = 20) {
  const root = path.resolve(runDir);
  const run = await jsonFile(path.join(root, "run.json"));
  const expected = expectedRows(run);
  const episodes = await rowsFromJsonl(path.join(root, "episodes.jsonl"));
  const episodeKeys = episodes.map((row) => row?.rowKey);
  const uniqueEpisodeKeys = new Set(episodeKeys);
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
  let latestMs = (await stat(path.join(root, "run.json"))).mtimeMs;
  for (const entry of claimEntries) {
    // Heartbeat writes owner.json; the lock directory itself is only stamped
    // when the row is claimed, so the directory mtime under-reports liveness
    // and quarantines a worker whose row is well within the lease. Read the
    // owner.json mtime (the same source `InjectionSuiteClaimLock` reclaims
    // against) and fall back to the directory mtime only when owner.json is
    // missing.
    const info = await stat(path.join(checkpointDir, entry.name));
    const ownerPath = path.join(checkpointDir, entry.name, "owner.json");
    let livenessMs = info.mtimeMs;
    try {
      livenessMs = (await stat(ownerPath)).mtimeMs;
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
  let pausedRows = 0;
  let inFlightRows = 0;
  let ambiguousRows = 0;
  let hostFaultTries = 0;

  for (const entry of checkpointFiles) {
    const file = path.join(checkpointDir, entry.name);
    const [checkpoint, info] = await Promise.all([jsonFile(file), stat(file)]);
    latestMs = Math.max(latestMs, info.mtimeMs);
    if (!Array.isArray(checkpoint.tries)) throw new Error(`${entry.name} has no tries array`);
    hostFaultTries += checkpoint.tries.filter((item) => item?.outcome?.kind === "HOST_API_FAULT").length;
    if (checkpoint.inFlight) {
      inFlightRows += 1;
      if (!activeClaimKeys.has(checkpoint.rowKey)) ambiguousRows += 1;
    }
    if (checkpoint.terminal) terminalCheckpoints += 1;
    else if (trailingHostFaults(checkpoint.tries) >= HOST_FAULT_LIMIT) pausedRows += 1;
  }

  const errors = [];
  if (uniqueEpisodeKeys.size !== episodeKeys.length) errors.push("duplicate episode rowKey");
  if (episodeKeys.some((key) => typeof key !== "string")) errors.push("episode missing rowKey");
  if (episodes.length > expected || terminalCheckpoints > expected) errors.push("terminal rows exceed design");
  if (uniqueEpisodeKeys.size > terminalCheckpoints) errors.push("episode has no terminal checkpoint");
  const recoveryRows = Math.max(0, terminalCheckpoints - uniqueEpisodeKeys.size);

  const ageMinutes = Math.max(0, (nowMs - latestMs) / 60_000);
  let state;
  if (errors.length > 0) state = "MALFORMED";
  else if (terminalCheckpoints === expected && recoveryRows === 0) state = "COMPLETE";
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
    remainingRows: expected - terminalCheckpoints,
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
