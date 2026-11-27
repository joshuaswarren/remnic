#!/usr/bin/env node

import process from "node:process";

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "pending",
  "startup_failure",
]);

const ALLOW_CONCLUSIONS = new Set(["success"]);

const SELF_EXCLUDED_DEFAULT = ["promote"];

function parseArgs(argv) {
  const opts = {
    requiredContexts: null,
    selfExcluded: SELF_EXCLUDED_DEFAULT,
    input: null,
    inputFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--required-contexts") {
      opts.requiredContexts = JSON.parse(argv[++i]);
      if (!Array.isArray(opts.requiredContexts) || opts.requiredContexts.length === 0) {
        throw new Error("--required-contexts must be a non-empty JSON array (fail closed)");
      }
      opts.requiredContexts = opts.requiredContexts.map((required) => {
        const check = typeof required === "string" ? { context: required } : required;
        const id = check?.integration_id;
        if (
          !check || typeof check.context !== "string" || check.context.length === 0 ||
          !(id == null || id === -1 || (Number.isSafeInteger(id) && id > 0))
        ) {
          throw new Error("--required-contexts entries must be context strings or { context, integration_id?: positive integer | null | -1 }");
        }
        return check;
      });
    } else if (a === "--self-excluded") {
      opts.selfExcluded = JSON.parse(argv[++i]);
      if (!Array.isArray(opts.selfExcluded)) {
        throw new Error("--self-excluded must be a JSON array of strings");
      }
      opts.selfExcluded = opts.selfExcluded.map(String);
    } else if (a === "--input") {
      opts.input = argv[++i];
    } else if (a === "--input-file") {
      opts.inputFile = argv[++i];
    } else {
      throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (opts.requiredContexts === null) {
    throw new Error(
      "--required-contexts is required. Fail closed: without the ruleset's required list we cannot tell which contexts are blocking.",
    );
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/**
 * Decide. Pure over its inputs.
 * Returns { decision, reasons }. reasons is a sorted, stable list.
 */
export function decide(records, requiredContexts, selfExcluded = SELF_EXCLUDED_DEFAULT) {
  const selfSet = new Set(selfExcluded);

  if (!Array.isArray(records) || records.length === 0) {
    return {
      decision: "refuse",
      reasons: ["no check-runs on evaluated commit: zero CI evidence is a refusal"],
    };
  }

  const orderKey = (r) => ({
    timestamp: r.completed_at ?? r.started_at ?? null,
    id: Number(r.id ?? -1),
  });
  const compareIds = (a, b) => {
    const diff = a.id - b.id;
    return Number.isNaN(diff) ? 0 : diff;
  };
  const compareOrder = (a, b) => {
    if (a.timestamp === null && b.timestamp === null) return compareIds(a, b);
    if (a.timestamp === null) return 1;
    if (b.timestamp === null) return -1;
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return compareIds(a, b);
  };

  const sortedRequired = requiredContexts
    .map((required) => typeof required === "string" ? { context: required } : required)
    .sort((a, b) => a.context.localeCompare(b.context));
  const reasons = [];

  for (const { context: name, integration_id: integrationId } of sortedRequired) {
    if (selfSet.has(name)) continue;
    const pinned = integrationId != null && integrationId !== -1;
    const bySource = new Map();
    for (const r of records) {
      if (!r || r.name !== name) continue;
      const source = typeof r.source === "string" && r.source !== "" ? r.source : "check-run";
      if (pinned && ((source !== "check-run" && source !== "status") || r.app?.id !== integrationId)) continue;
      const prev = bySource.get(source);
      const comparison = prev ? compareOrder(orderKey(r), orderKey(prev)) : 1;
      if (
        comparison > 0 ||
        (comparison === 0 && r.conclusion !== "success" && prev.conclusion === "success")
      ) {
        bySource.set(source, r);
      }
    }
    const populatedSources = [...bySource.keys()].sort();
    if (populatedSources.length === 0) {
      reasons.push(`${name}: missing check-run on evaluated commit`);
      continue;
    }
    for (const source of populatedSources) {
      const record = bySource.get(source);
      const status = record.status ?? "completed";
      const conclusion = record.conclusion ?? null;
      if (status !== "completed" || conclusion === null) {
        reasons.push(
          `${name}: CI not finished (status=${status}, conclusion=${conclusion ?? "null"})`,
        );
        continue;
      }
      if (FAILURE_CONCLUSIONS.has(conclusion)) {
        reasons.push(`${name}: ${conclusion}`);
        continue;
      }
      if (!ALLOW_CONCLUSIONS.has(conclusion)) {
        reasons.push(`${name}: ${conclusion} (not a green verdict)`);
      }
    }
  }

  return reasons.length === 0
    ? { decision: "allow", reasons: [] }
    : { decision: "refuse", reasons: [...new Set(reasons)] };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let inputText;
  if (opts.inputFile !== null) {
    const { readFileSync } = await import("node:fs");
    inputText = readFileSync(opts.inputFile, "utf8");
  } else if (opts.input !== null) {
    inputText = opts.input;
  } else {
    inputText = await readStdin();
  }
  const payload = JSON.parse(inputText);
  if (payload?.type !== "check-runs") {
    throw new Error(
      `unsupported input type '${payload?.type}'; only 'check-runs' is accepted`,
    );
  }
  const result = decide(payload.records, opts.requiredContexts, opts.selfExcluded);
  process.stdout.write(JSON.stringify(result) + "\n");
}

// CLI only — importing the file does not auto-run main.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`release-promote-ci-gate: ${err.message}\n`);
    process.exit(2);
  });
}

export const __test__ = { FAILURE_CONCLUSIONS, SELF_EXCLUDED_DEFAULT };
