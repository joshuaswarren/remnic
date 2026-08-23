import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TERMINAL_RATE_LIMITED,
  detectRateLimit,
  validateStateFields,
  writePrLoopState,
} from "../scripts/pr-loop-state.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VALID_FIELDS = {
  requiredNonPass: "0",
  cursor: "pass",
  positiveVerdict: "1",
  unresolvedThreads: "0",
  decision: "APPROVED",
};

const RATE_LIMIT_BODY = JSON.stringify({
  data: null,
  errors: [
    {
      type: "RATE_LIMITED",
      message: "API rate limit exceeded for installation.",
    },
  ],
});

function scratchDir() {
  return mkdtempSync(path.join(os.tmpdir(), "remnic-pr-loop-state-"));
}

test("detectRateLimit recognizes gh RATE_LIMIT error bodies", () => {
  assert.equal(detectRateLimit(RATE_LIMIT_BODY), true);
  assert.equal(detectRateLimit(`${RATE_LIMIT_BODY}\n999`), true);
  assert.equal(detectRateLimit("API rate limit exceeded"), true);
  assert.equal(detectRateLimit(VALID_FIELDS.requiredNonPass), false);
  assert.equal(detectRateLimit(VALID_FIELDS.cursor), false);
  assert.equal(detectRateLimit(""), false);
});

test("validateStateFields accepts well-shaped gh reads", () => {
  const result = validateStateFields(VALID_FIELDS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields, {
    requiredNonPass: 0,
    cursor: "pass",
    positiveVerdict: 1,
    unresolvedThreads: 0,
    decision: "APPROVED",
  });
});

test("validateStateFields rejects a RATE_LIMIT body leaking into a field", () => {
  const result = validateStateFields({ ...VALID_FIELDS, requiredNonPass: RATE_LIMIT_BODY });
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
});

test("validateStateFields rejects non-rate-limit garbage without flagging rate limit", () => {
  const result = validateStateFields({ ...VALID_FIELDS, cursor: "explode(pass)" });
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, false);
  assert.match(result.reason, /cursor/);
});

test("writePrLoopState never writes a RATE_LIMIT body into the state file", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  try {
    const outcome = writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "RUNNING",
      ...VALID_FIELDS,
      requiredNonPass: `${RATE_LIMIT_BODY}\n999`,
    });

    assert.equal(outcome.wrote, true);
    assert.equal(outcome.terminal, TERMINAL_RATE_LIMITED);
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.terminal, TERMINAL_RATE_LIMITED);
    assert.equal(parsed.rateLimited, true);
    assert.equal(parsed.ready, false);
    assert.doesNotMatch(raw, /RATE_LIMITED",?\s*"message/, "raw error body must not reach the state file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePrLoopState computes MERGE_READY for a clean iteration and keeps gh fields", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  try {
    const outcome = writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "RUNNING",
      ...VALID_FIELDS,
    });
    assert.equal(outcome.terminal, "MERGE_READY");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(parsed.terminal, "MERGE_READY");
    assert.equal(parsed.ready, true);
    assert.equal(parsed.required_non_pass, 0);
    assert.equal(parsed.cursor, "pass");
    assert.equal(parsed.positive_verdict, 1);
    assert.equal(parsed.unresolved_cursor_threads, 0);
    assert.equal(parsed.review_decision, "APPROVED");
    assert.equal(parsed.repo, "owner/repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePrLoopState refuses to overwrite a good state file with garbage", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  try {
    writePrLoopState({ stateFile, repo: "owner/repo", pr: 1234, terminal: "RUNNING", ...VALID_FIELDS });
    const before = readFileSync(stateFile, "utf8");
    const outcome = writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "RUNNING",
      ...VALID_FIELDS,
      unresolvedThreads: "garbage-not-a-count",
    });
    assert.equal(outcome.wrote, false);
    assert.notEqual(outcome.reason, undefined);
    assert.equal(readFileSync(stateFile, "utf8"), before, "last good state must survive an invalid read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePrLoopState overwrites a stale RATE_LIMITED state after recovery", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  try {
    writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "RUNNING",
      ...VALID_FIELDS,
      requiredNonPass: RATE_LIMIT_BODY,
    });
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).terminal, TERMINAL_RATE_LIMITED);
    const outcome = writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "RUNNING",
      ...VALID_FIELDS,
    });
    assert.equal(outcome.terminal, "MERGE_READY");
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).terminal, "MERGE_READY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI mode rejects missing arguments with usage and writes nothing", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-42-state.json");
  try {
    const run = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "pr-loop-state.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // No args must fail with usage, never write anything.
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--state-file/);
    assert.equal(existsSync(stateFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caller-supplied terminal MERGE_READY with a blocking field is rejected", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  try {
    writePrLoopState({ stateFile, repo: "owner/repo", pr: 1234, terminal: "RUNNING", ...VALID_FIELDS });
    const before = readFileSync(stateFile, "utf8");
    const outcome = writePrLoopState({
      stateFile,
      repo: "owner/repo",
      pr: 1234,
      terminal: "MERGE_READY",
      ...VALID_FIELDS,
      cursor: "pending",
    });
    assert.equal(outcome.wrote, false);
    assert.match(outcome.reason, /MERGE_READY/);
    assert.match(outcome.reason, /computed/);
    assert.equal(
      readFileSync(stateFile, "utf8"),
      before,
      "no MERGE_READY record may be written while ready=false",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects --terminal MERGE_READY when validated fields still block", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-42-state.json");
  try {
    writePrLoopState({ stateFile, repo: "owner/repo", pr: 42, terminal: "RUNNING", ...VALID_FIELDS });
    const before = readFileSync(stateFile, "utf8");
    const run = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "pr-loop-state.mjs"),
        "--state-file", stateFile,
        "--repo", "owner/repo",
        "--pr", "42",
        "--required-non-pass", "0",
        "--cursor", "pending",
        "--positive-verdict", "1",
        "--unresolved", "0",
        "--decision", "CHANGES_REQUESTED",
        "--terminal", "MERGE_READY",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /MERGE_READY/);
    assert.equal(readFileSync(stateFile, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupted mid-write leaves the previous valid state intact", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-1234-state.json");
  // The atomic write targets this sibling temp path; making it a directory
  // fails the temp write the way an interrupt/ENOSPC would mid-write.
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  try {
    writePrLoopState({ stateFile, repo: "owner/repo", pr: 1234, terminal: "RUNNING", ...VALID_FIELDS });
    const before = readFileSync(stateFile, "utf8");
    mkdirSync(tmpFile);
    assert.throws(() =>
      writePrLoopState({ stateFile, repo: "owner/repo", pr: 1234, terminal: "RUNNING", ...VALID_FIELDS }),
    );
    assert.equal(readFileSync(stateFile, "utf8"), before, "normal branch must keep the last good state");
    assert.throws(() =>
      writePrLoopState({
        stateFile,
        repo: "owner/repo",
        pr: 1234,
        terminal: "RUNNING",
        ...VALID_FIELDS,
        requiredNonPass: RATE_LIMIT_BODY,
      }),
    );
    assert.equal(readFileSync(stateFile, "utf8"), before, "rate-limited branch must keep the last good state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects invalid PR numbers at the boundary", () => {
  const dir = scratchDir();
  try {
    for (const badPr of ["abc", "12junk", "-1", "0", "9007199254740992", "99999999999999999999"]) {
      const stateFile = path.join(dir, `pr-${badPr}-state.json`);
      const run = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "pr-loop-state.mjs"),
          "--state-file", stateFile,
          "--repo", "owner/repo",
          "--pr", badPr,
          "--required-non-pass", "0",
          "--cursor", "pass",
          "--positive-verdict", "1",
          "--unresolved", "0",
          "--decision", "APPROVED",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(run.status, 0, `--pr ${badPr} must fail`);
      assert.match(run.stderr, /positive integer/, `--pr ${badPr} must name the expected form`);
      assert.equal(existsSync(stateFile), false, `--pr ${badPr} must not write state`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI still accepts a valid PR number and computes MERGE_READY", () => {
  const dir = scratchDir();
  const stateFile = path.join(dir, "pr-42-state.json");
  try {
    const run = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "pr-loop-state.mjs"),
        "--state-file", stateFile,
        "--repo", "owner/repo",
        "--pr", "42",
        "--required-non-pass", "0",
        "--cursor", "pass",
        "--positive-verdict", "1",
        "--unresolved", "0",
        "--decision", "APPROVED",
        "--terminal", "RUNNING",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(parsed.pr, 42);
    assert.equal(parsed.terminal, "MERGE_READY");
    assert.equal(parsed.ready, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
