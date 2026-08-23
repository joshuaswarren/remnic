#!/usr/bin/env node
/**
 * Validate-before-write state helper for pr-loop watchers (issue #2781).
 *
 * Watchers derive state-file fields from `gh` reads. When GitHub answers a
 * read with a RATE_LIMIT error body, that body can leak into a field and the
 * written `.pr-loop/pr-<n>-state.json` stops parsing as JSON — every later
 * state read then fails. This module validates each gh-derived field against
 * its expected shape BEFORE any write:
 *
 * - a rate-limited read writes an explicit `terminal: "RATE_LIMITED"` record
 *   (valid JSON, `ready: false`) instead of the error body;
 * - any other malformed read refuses to overwrite the last good state;
 * - `terminal: "MERGE_READY"` is never taken from the caller: it is computed
 *   from the validated fields, and `--terminal MERGE_READY` while a blocking
 *   field remains is rejected, because the supervisor stops on that exact
 *   value. Terminal values describing conditions (RATE_LIMITED etc.) may
 *   still be supplied;
 * - the PR number must be a complete positive integer within
 *   Number.MAX_SAFE_INTEGER, so `--pr abc` or `12junk` is rejected instead
 *   of parsed into null / a prefix number, and an all-digit argument like
 *   99999999999999999999 is rejected instead of serializing with precision
 *   loss that attributes state to the wrong PR;
 * - writes go to a sibling temp file renamed over the destination, so a
 *   crash mid-write leaves the previous valid state intact.
 *
 * A RATE_LIMITED record is recoverable: the next healthy iteration overwrites
 * it. The supervisor stop-grep only matches MERGE_READY, so a rate-limited
 * watcher keeps looping and heals itself once the window resets.
 */

import { realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TERMINAL_RATE_LIMITED = "RATE_LIMITED";

const RATE_LIMIT_TEXT_PATTERN = /rate.?limit/i;

const CURSOR_STATES = new Set(["pass", "fail", "pending", "skipping", "neutral", "missing"]);
const DECISIONS = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "", "none"]);

function parseMaybeJson(value) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Parse a PR number; the COMPLETE argument must be a positive safe integer. */
export function parsePrNumber(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** True when a gh read returned a rate-limit error body or message. */
export function detectRateLimit(value) {
  if (typeof value !== "string" || value === "") return false;
  const parsed = parseMaybeJson(value);
  if (parsed) {
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    if (errors.some((error) => RATE_LIMIT_TEXT_PATTERN.test(String(error?.type ?? "")))) return true;
    if (RATE_LIMIT_TEXT_PATTERN.test(String(parsed.message ?? ""))) return true;
  }
  return RATE_LIMIT_TEXT_PATTERN.test(value);
}

function integerField(name, value, fields, failures) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim()) ) {
    failures.push(`${name} must be a non-negative integer, got: ${JSON.stringify(value)}`);
    return;
  }
  fields[name] = Number.parseInt(value.trim(), 10);
}

/** Validate the gh-derived watcher fields; never mutates on failure. */
export function validateStateFields({
  requiredNonPass,
  cursor,
  positiveVerdict,
  unresolvedThreads,
  decision,
}) {
  const raw = { requiredNonPass, cursor, positiveVerdict, unresolvedThreads, decision };
  if (Object.values(raw).some((value) => detectRateLimit(value))) {
    return { ok: false, rateLimited: true, reason: "gh returned a RATE_LIMIT error body" };
  }

  const fields = {};
  const failures = [];
  integerField("requiredNonPass", requiredNonPass, fields, failures);
  integerField("unresolvedThreads", unresolvedThreads, fields, failures);

  const cursorTrimmed = typeof cursor === "string" ? cursor.trim() : "";
  if (cursorTrimmed === "") {
    fields.cursor = "missing";
  } else if (CURSOR_STATES.has(cursorTrimmed)) {
    fields.cursor = cursorTrimmed;
  } else {
    failures.push(`cursor must be one of ${[...CURSOR_STATES].join("|")}, got: ${JSON.stringify(cursor)}`);
  }

  if (positiveVerdict === "1" || positiveVerdict === 1) {
    fields.positiveVerdict = 1;
  } else if (positiveVerdict === "0" || positiveVerdict === 0) {
    fields.positiveVerdict = 0;
  } else {
    failures.push(`positiveVerdict must be 0 or 1, got: ${JSON.stringify(positiveVerdict)}`);
  }

  const decisionTrimmed = typeof decision === "string" ? decision.trim() : "";
  const normalizedDecision = decisionTrimmed === "" ? "none" : decisionTrimmed;
  if (DECISIONS.has(normalizedDecision)) {
    fields.decision = normalizedDecision;
  } else {
    failures.push(`decision must be one of ${[...DECISIONS].join("|")}, got: ${JSON.stringify(decision)}`);
  }

  if (failures.length > 0) {
    return { ok: false, rateLimited: false, reason: failures.join("; ") };
  }
  return { ok: true, fields };
}

function mergeReady(fields) {
  return (
    fields.requiredNonPass === 0 &&
    fields.positiveVerdict === 1 &&
    fields.unresolvedThreads === 0 &&
    fields.decision !== "CHANGES_REQUESTED" &&
    fields.cursor === "pass"
  );
}

/**
 * Validate the PR number and gh-derived fields, then write the state file.
 * Returns `{ wrote, terminal }`; on a rate-limited read the file receives a
 * TERMINAL_RATE_LIMITED record, and on invalid input the last good state
 * file is left untouched.
 */
export function writePrLoopState({
  stateFile,
  repo,
  pr,
  terminal = "RUNNING",
  timestamp = new Date().toISOString(),
  ...rawFields
}) {
  const prNumber = parsePrNumber(pr);
  if (prNumber === null) {
    return {
      wrote: false,
      reason: `pr must be a complete positive integer between 1 and 9007199254740991 (Number.MAX_SAFE_INTEGER), e.g. --pr 1234, got: ${JSON.stringify(pr)}`,
    };
  }
  const validation = validateStateFields(rawFields);
  const ready = validation.ok ? mergeReady(validation.fields) : false;
  if (terminal === "MERGE_READY" && !ready) {
    return {
      wrote: false,
      reason:
        "terminal MERGE_READY conflicts with the validated fields (ready=false): " +
        "MERGE_READY is computed from required_non_pass/cursor/positive_verdict/" +
        "unresolved/decision, never caller-supplied",
    };
  }
  if (validation.ok) {
    const { fields } = validation;
    // Keys mirror the legacy watcher state file exactly, so records written
    // by the helper and by the fallback heredoc stay interchangeable.
    const record = {
      timestamp,
      repo: String(repo),
      pr: prNumber,
      terminal: ready ? "MERGE_READY" : terminal,
      required_non_pass: fields.requiredNonPass,
      cursor: fields.cursor,
      positive_verdict: fields.positiveVerdict,
      unresolved_cursor_threads: fields.unresolvedThreads,
      review_decision: fields.decision,
      ready,
    };
    writeStateAtomically(stateFile, record);
    return { wrote: true, terminal: record.terminal };
  }
  if (validation.rateLimited) {
    const record = {
      timestamp,
      repo: String(repo),
      pr: prNumber,
      terminal: TERMINAL_RATE_LIMITED,
      rateLimited: true,
      ready: false,
    };
    writeStateAtomically(stateFile, record);
    return { wrote: true, terminal: TERMINAL_RATE_LIMITED };
  }
  return { wrote: false, reason: validation.reason };
}

/** Write to a sibling temp file, then rename over the destination. */
function writeStateAtomically(stateFile, record) {
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmpFile, stateFile);
  } catch (error) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best-effort cleanup; the previous state file was never touched.
    }
    throw error;
  }
}

function usage() {
  console.error(
    "Usage: node scripts/pr-loop-state.mjs --state-file <path> --repo <owner/name> --pr <n> " +
      "--required-non-pass <n> --cursor <state> --positive-verdict <0|1> " +
      "--unresolved <n> --decision <state> [--terminal <t>]",
  );
}

function parseArgs(argv) {
  const named = {};
  const keys = {
    "--state-file": "stateFile",
    "--repo": "repo",
    "--pr": "pr",
    "--terminal": "terminal",
    "--required-non-pass": "requiredNonPass",
    "--cursor": "cursor",
    "--positive-verdict": "positiveVerdict",
    "--unresolved": "unresolvedThreads",
    "--decision": "decision",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || i + 1 >= argv.length) return null;
    named[key] = argv[i + 1];
  }
  if (!named.stateFile || !named.repo || !named.pr) return null;
  return named;
}
function isDirectRunPath(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRunPath(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(2);
  }
  const outcome = writePrLoopState(args);
  if (!outcome.wrote) {
    console.error(`[pr-loop-state] refusing to write: ${outcome.reason}`);
    process.exit(1);
  }
  console.log(`[pr-loop-state] terminal=${outcome.terminal}`);
}
