import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
