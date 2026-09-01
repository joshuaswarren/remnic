#!/usr/bin/env node
/**
 * Windows CI test runner (issue #3034).
 *
 * Runs the `@remnic/core` unit suite on windows-latest, minus the files named
 * in scripts/windows-skip-list.json, and prints every skip by name so the job
 * log always states what was not covered.
 *
 * The skip list only ever SHRINKS. A Windows failure is fixed forward; it is
 * never silenced with `|| true` or `continue-on-error`. A skip must be a named,
 * issue-linked entry here or the suite fails. A listed path that no longer
 * exists is an error too, so a rename cannot turn an entry into dead weight
 * that quietly covers nothing.
 *
 * Node builtins only, plus the repo's existing root-test-runner helpers.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appendNodeOption } from "./root-test-runner-env.mjs";
import { chunkArgsByLength, parseTapSummary } from "./root-test-runner-lib.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKIP_LIST_PATH = path.join(REPO_ROOT, "scripts", "windows-skip-list.json");
export const SMOKE_LIST_PATH = path.join(REPO_ROOT, "scripts", "windows-smoke-list.json");

/** Suite under test: the `@remnic/core` unit tests, as posix repo-relative paths. */
export const CORE_TEST_DIR = "packages/remnic-core/src";

/** `#123` or a full github issue URL. Anchored, no nested quantifiers. */
const ISSUE_REF_RE =
  /^(?:#[0-9]{1,9}|https:\/\/github\.com\/[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64}\/issues\/[0-9]{1,9})$/;

/** Windows builds one bounded command line per spawn, so file lists are chunked. */
const ARGV_CHAR_BUDGET = 6000;

function requireOneLine(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required and must be a non-empty string`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must be a single line`);
  }
  return value.trim();
}

/**
 * Validate the parsed skip-list document into a list of `{file, issue, reason}`.
 * Every rejection is an explicit throw — an unrecognized shape is never
 * reinterpreted as "no skips".
 */
export function parseSkipList(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("windows-skip-list.json must contain a JSON object");
  }
  const { skips } = raw;
  if (!Array.isArray(skips)) {
    throw new Error('windows-skip-list.json: "skips" must be an array');
  }
  const seen = new Set();
  return skips.map((entry, index) => {
    const where = `windows-skip-list.json: skips[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`);
    }
    const file = requireOneLine(entry.file, `${where}.file`);
    const issue = requireOneLine(entry.issue, `${where}.issue`);
    const reason = requireOneLine(entry.reason, `${where}.reason`);
    if (!ISSUE_REF_RE.test(issue)) {
      throw new Error(`${where}.issue must be "#<number>" or a github issue URL, got "${issue}"`);
    }
    if (file.includes("\\") || file.startsWith("/") || file.split("/").includes("..")) {
      throw new Error(`${where}.file must be a repo-relative posix path, got "${file}"`);
    }
    if (seen.has(file)) {
      throw new Error(`${where}.file duplicates an earlier entry: ${file}`);
    }
    seen.add(file);
    return { file, issue, reason };
  });
}

/**
 * Validate the parsed smoke manifest into a sorted list of posix repo-relative
 * paths. Same explicit-rejection discipline as parseSkipList: an unrecognized
 * shape is never reinterpreted as "run everything".
 */
export function parseSmokeList(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("windows-smoke-list.json must contain a JSON object");
  }
  const { files } = raw;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('windows-smoke-list.json: "files" must be a non-empty array');
  }
  const seen = new Set();
  return files.map((file, index) => {
    const where = `windows-smoke-list.json: files[${index}]`;
    const entry = requireOneLine(file, where);
    if (entry.includes("\\") || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`${where} must be a repo-relative posix path, got "${entry}"`);
    }
    if (!(entry === CORE_TEST_DIR || entry.startsWith(`${CORE_TEST_DIR}/`))) {
      throw new Error(`${where} must live under ${CORE_TEST_DIR}, got "${entry}"`);
    }
    if (!entry.endsWith(".test.ts")) {
      throw new Error(`${where} must name a *.test.ts file, got "${entry}"`);
    }
    if (seen.has(entry)) {
      throw new Error(`${where} duplicates an earlier entry: ${entry}`);
    }
    seen.add(entry);
    return entry;
  });
}

/** Every `@remnic/core` test file, as sorted posix repo-relative paths. */
export function collectCoreTestFiles(repoRoot = REPO_ROOT) {
  const base = path.join(repoRoot, ...CORE_TEST_DIR.split("/"));
  return readdirSync(base, { recursive: true })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `${CORE_TEST_DIR}/${entry}`)
    .sort();
}

/**
 * Split `files` against the skip list.
 * `stale` holds entries whose file is absent — reported, never ignored.
 */
export function partitionSkipped(files, entries) {
  const present = new Set(files);
  const skipped = [];
  const stale = [];
  for (const entry of entries) {
    if (present.has(entry.file)) skipped.push(entry);
    else stale.push(entry);
  }
  const skippedFiles = new Set(skipped.map((entry) => entry.file));
  return { run: files.filter((file) => !skippedFiles.has(file)), skipped, stale };
}

/**
 * Log lines naming every skipped file. Printed even when the list is empty.
 * `scope` names the universe the report describes (undefined = the full
 * suite), so smoke mode never claims full-suite coverage it does not have.
 */
export function formatSkipReport(skipped, scope) {
  const label = scope ? ` within ${scope}` : "";
  if (skipped.length === 0) {
    return [`[windows-tests] skip list is empty — every test file${label} runs.`];
  }
  return [
    `[windows-tests] SKIPPING ${skipped.length} test file(s) per scripts/windows-skip-list.json${label}:`,
    ...skipped.map((entry) => `[windows-tests]   [SKIP] ${entry.file} — ${entry.reason} (${entry.issue})`),
    "[windows-tests] this list only shrinks: fix the defect, then delete the entry.",
  ];
}

/** Run one `node --import tsx --test` invocation, streaming output. */
function runNodeTest(files, env) {
  return new Promise((resolve) => {
    // Spawn the node executable directly: on Windows a `.cmd` shim cannot be
    // spawned without a shell, and going through one would re-quote paths.
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
      cwd: REPO_ROOT,
      env,
      stdio: ["inherit", "pipe", "inherit"],
    });

    const TAIL_LIMIT = 64 * 1024;
    let tail = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString("utf-8")).slice(-TAIL_LIMIT);
    });

    child.on("error", (error) => {
      console.error(`[windows-tests] ERROR: failed to launch node --test: ${error.message}`);
      resolve({ status: 1, summary: null });
    });

    child.on("close", (status) => {
      resolve({ status: status ?? 1, summary: parseTapSummary(tail) });
    });
  });
}

async function main() {
  const smoke = process.argv.includes("--smoke");
  let entries;
  let smokeFiles;
  try {
    entries = parseSkipList(JSON.parse(readFileSync(SKIP_LIST_PATH, "utf8")));
    if (smoke) {
      smokeFiles = parseSmokeList(JSON.parse(readFileSync(SMOKE_LIST_PATH, "utf8")));
    }
  } catch (error) {
    console.error(`[windows-tests] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const all = collectCoreTestFiles();
  if (all.length === 0) {
    console.error(
      `[windows-tests] ERROR: no *.test.ts files under ${CORE_TEST_DIR} — coverage would be silently lost.`
    );
    process.exit(1);
  }

  // Stale smoke entries are validated against the full collected set so a
  // renamed file fails loudly instead of silently shrinking the subset.
  if (smoke) {
    const present = new Set(all);
    const missing = smokeFiles.filter((file) => !present.has(file));
    if (missing.length > 0) {
      console.error(
        "[windows-tests] ERROR: scripts/windows-smoke-list.json lists files that no longer exist — delete or correct these entries:"
      );
      for (const file of missing) console.error(`[windows-tests]   [STALE] ${file}`);
      process.exit(1);
    }
  }
  const universe = smoke ? smokeFiles : all;

  const { skipped, stale } = partitionSkipped(all, entries);
  if (stale.length > 0) {
    console.error(
      "[windows-tests] ERROR: scripts/windows-skip-list.json lists files that no longer exist — delete or correct these entries:"
    );
    for (const entry of stale) {
      console.error(`[windows-tests]   [STALE] ${entry.file} (${entry.issue})`);
    }
    process.exit(1);
  }

  // Name only skips that apply to the universe being run: a full-suite
  // entry outside the curated subset would overstate what smoke omits.
  const universeSet = new Set(universe);
  const skippedInScope = skipped.filter((entry) => universeSet.has(entry.file));
  for (const line of formatSkipReport(skippedInScope, smoke ? "the curated smoke subset" : undefined)) {
    console.warn(line);
  }
  if (smoke) {
    console.warn(
      `[windows-tests] the curated subset omits ${all.length - universe.length} of ${all.length}`
        + " @remnic/core test file(s); full coverage runs only where the budget allows."
    );
  }

  const skippedFiles = new Set(skipped.map((entry) => entry.file));
  const run = universe.filter((file) => !skippedFiles.has(file));
  if (run.length === 0) {
    console.error("[windows-tests] ERROR: every test file is skipped — the job would prove nothing.");
    process.exit(1);
  }
  console.warn(
    `[windows-tests] running ${run.length}/${universe.length} @remnic/core test file(s)`
      + (smoke ? " per scripts/windows-smoke-list.json" : ""),
  );

  const env = {
    ...process.env,
    NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, "--conditions=remnic-source"),
  };

  const chunks = chunkArgsByLength(run, ARGV_CHAR_BUDGET);
  let totalFail = 0;
  let worstStatus = 0;
  for (const [index, chunk] of chunks.entries()) {
    console.warn(`[windows-tests] chunk ${index + 1}/${chunks.length} (${chunk.length} file(s))`);
    const { status, summary } = await runNodeTest(chunk, env);
    if (summary === null) {
      console.error("[windows-tests] ERROR: no TAP summary in test output — treating as failure.");
      process.exit(status === 0 ? 1 : status);
    }
    totalFail += summary.fail;
    if (status !== 0) worstStatus = status;
  }

  if (totalFail > 0 && worstStatus === 0) {
    console.error(
      `[windows-tests] ERROR: runner exited 0 but TAP reports ${totalFail} failing test(s) — failing the run.`
    );
    process.exit(1);
  }
  process.exit(worstStatus);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  await main();
}
