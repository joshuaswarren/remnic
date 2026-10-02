#!/usr/bin/env node
/**
 * CI gate for release-promote.yml (extracted into a script for testability,
 * issue #3032). Owns only the decision; commit/parent/PR resolution and the
 * ruleset fetch stay in the workflow (those touch the network and the
 * workflow already owns that surface).
 *
 * Input (one of):
 *   --input <JSON STRING>   pipe a JSON document directly
 *   --input-file <path>    read the JSON document from a file (the workflow
 *                          writes the merged check-run + commit-status record
 *                          set to RUNNER_TEMP and passes the path here)
 *   stdin                  default when neither --input nor --input-file
 *                          is given
 * Document shape:
 *   { "type": "check-runs", "records": [ { name, status, conclusion,
 *                                           completed_at? }, ... ] }
 *   Records may be check-runs (from /commits/{sha}/check-runs) and/or
 *   commit statuses (from /commits/{sha}/status), normalized to the same
 *   shape by the workflow before being handed to this script.
 *
 * CLI:
 *   --required-contexts <JSON array of strings>   required, fail closed
 *   --self-excluded    <JSON array of strings>    optional, names that never
 *                                                 block even if required
 *
 * Output: { decision: "allow" | "refuse", reasons: string[] }
 *
 * Rules:
 *   - Zero records is refuse ("no CI evidence"). Zero records cannot be a
 *     pass; it is evidence the evaluated commit was never tested.
 *   - Required contexts are the single source of truth. Non-required
 *     contexts (Dependabot, latest-openclaw-scanner, `checks`, etc.) cannot
 *     block. If the ruleset API cannot be read the workflow must NOT call
 *     this script with an empty required list — it fails the step.
 *   - For each required context, take the LATEST record (per
 *     `completed_at`; falls back to `started_at`; falls back to "" for
 *     records that have neither). Rulesets evaluate the latest run per
 *     context — earlier runs are superseded. Refuse if that latest record
 *     is unfinished (status != "completed" or conclusion == null) OR its
 *     conclusion is in the failure set {failure, cancelled, timed_out,
 *     action_required, stale, pending, startup_failure}.
 *   - The verdict is allow-list on the conclusion: only `success` is green.
 *     `skipped`, `neutral`, and unknown values are NOT green. The repo's
 *     own `ai-reviewers` gate deliberately posts `neutral` for superseded
 *     runs and `skipped` for path-filtered jobs; treating those as green
 *     would let a required review gate with no real verdict authorise a
 *     promotion.
 *   - A required context that has NO records at all is refuse (fail closed).
 *     This fires when the ruleset gained a new required context after the
 *     merge OR when the required context is reported only as a commit status
 *     and the workflow's records fetch missed it (the workflow merges both
 *     endpoints to minimise this).
 *   - Records for `promote` (the workflow's own job) never block, even if
 *     it ever leaks into the required list. Defence in depth — the
 *     promoter dispatching against its own sources should never self-block.
 *
 * The script reads either stdin or --input/--input-file; it does not call
 * the network. Its `decide` export is a pure function over its inputs.
 */

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

// Only `success` is green. `skipped` (path-filtered) and `neutral`
// (superseded) are not verdicts the gate can rely on; they are recorded as
// refusal triggers so a required review that never produced a real opinion
// cannot authorise a promotion.
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
      if (!Array.isArray(opts.requiredContexts)) {
        throw new Error(
          "--required-contexts must be a JSON array of strings (fail closed)",
        );
      }
      opts.requiredContexts = opts.requiredContexts.map(String);
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
  const reasons = [];

  if (!Array.isArray(records) || records.length === 0) {
    return {
      decision: "refuse",
      reasons: ["no check-runs on evaluated commit: zero CI evidence is a refusal"],
    };
  }

  // Group records by name; per name, take the SINGLE latest record
  // (by completed_at falling back to started_at falling back to id) for
  // the verdict. Rulesets evaluate the latest run per context — an older
  // queued or in_progress record is superseded by a newer completed one,
  // and the verdict must match what the merge gate actually saw.
  // Falling back past '' would let two records with no timestamp compete
  // and produce the wrong latest; we use id as the ultimate tiebreaker.
  //
  // Records from different sources (check-runs vs commit statuses) keep
  // distinct source-tinged ids so an accidental collision between a
  // check-run's numeric id and a status's row id cannot make the older
  // record win. Check-runs always carry a numeric id; statuses always
  // carry their updated_at; the workflow tags the source explicitly.
  const byName = new Map();
  const orderKey = (r) => {
    const stamp =
      r.completed_at ?? r.started_at ?? `id:${r.id ?? ""}`;
    return `${stamp}|${r._source ?? "check-runs"}`;
  };
  for (const r of records) {
    if (!r || typeof r.name !== "string") continue;
    const prev = byName.get(r.name);
    if (!prev || orderKey(r) > orderKey(prev)) {
      byName.set(r.name, r);
    }
  }

  // Sort required contexts so reasons come out in a deterministic order —
  // makes diffs readable and tests stable.
  const sortedRequired = [...requiredContexts].sort();

  for (const name of sortedRequired) {
    if (selfSet.has(name)) continue;
    const record = byName.get(name);
    if (!record) {
      reasons.push(`${name}: missing check-run on evaluated commit`);
      continue;
    }
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
      // `skipped` (path-filtered), `neutral` (superseded), and any unknown
      // value are not verdicts. Fail closed so a required review with no
      // real opinion cannot authorise a promotion.
      reasons.push(`${name}: ${conclusion} (not a green verdict)`);
      continue;
    }
    // success → green.
  }

  return reasons.length === 0
    ? { decision: "allow", reasons: [] }
    : { decision: "refuse", reasons };
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