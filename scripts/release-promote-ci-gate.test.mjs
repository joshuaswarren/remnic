/**
 * Tests for scripts/release-promote-ci-gate.mjs — the decision extracted from
 * the `Verify CI is green on the release commit step` of release-promote.yml.
 *
 * The script owns ONLY the decision given a list of check-run records and the
 * ruleset's required context list. Commit/parent/PR resolution and ruleset
 * fetch stay in the workflow (those data live there for the workflow, not in
 * unit-test fixtures).
 *
 * These tests intentionally use fixture shapes that match the real failure
 * shapes observed on the repo, not synthetic hand-waves:
 *   - own `promote` job (pending forever / failing once it has a result);
 *   - `Dependabot` (dynamic GH context, unrelated, runs on pushes only);
 *   - `latest-openclaw-scanner` (informational, not in the ruleset);
 *   - a `quality` required context that genuinely failed post-merge;
 *   - the squash-vs-merge-commit topology difference (evaluated sha choice
 *     lives outside the script, so we exercise the script against the
 *     records fetched from the actual PR head that the ruleset gated).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(
  new URL("./release-promote-ci-gate.mjs", import.meta.url),
);

const REQUIRED = [
  "quality",
  "dependency-review",
  "gitleaks",
  "analyze",
  "ai-reviewers",
  "unresolved-review-threads",
];

function run(records) {
  const result = execFileSync(
    process.execPath,
    [scriptPath, "--required-contexts", JSON.stringify(REQUIRED)],
    {
      input: JSON.stringify({ type: "check-runs", records }),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(result);
}

/** Variant that projects started_at + completed_at, like the workflow does. */
function crF(name, opts = {}) {
  // Records carry the timestamps the workflow actually projects:
  //   completed_at: present only when the run has concluded
  //   started_at:   present from the moment the run starts
  // Do NOT backfill one from the other — that would defeat the latest-
  // record test that relies on a queued rerun with started_at but no
  // completed_at.
  return {
    name,
    status: opts.status ?? "completed",
    conclusion: opts.conclusion ?? "success",
    started_at: opts.started_at,
    completed_at: opts.completed_at,
  };
}

/** Build a check-run record (shape = the trimmed fields the script needs). */
function cr(name, opts = {}) {
  return {
    name,
    status: opts.status ?? "completed",
    conclusion: opts.conclusion ?? "success",
    completed_at: opts.completed_at ?? "2026-10-02T00:30:00Z",
  };
}

let test = (await import("node:test")).default;

test("zero check-runs is refusal, not admission", () => {
  const result = run([]);
  assert.equal(result.decision, "refuse");
  assert.match(result.reasons.join(" "), /no check-runs/i);
});

test("all required contexts green allows promotion", () => {
  const result = run([
    cr("quality", { completed_at: "2026-10-02T00:30:00Z" }),
    cr("dependency-review", { completed_at: "2026-10-02T00:30:01Z" }),
    cr("gitleaks", { completed_at: "2026-10-02T00:30:02Z" }),
    cr("analyze", { completed_at: "2026-10-02T00:30:03Z" }),
    cr("ai-reviewers", { completed_at: "2026-10-02T00:30:04Z" }),
    cr("unresolved-review-threads", {
      completed_at: "2026-10-02T00:30:05Z",
    }),
  ]);
  assert.equal(result.decision, "allow");
  assert.deepEqual(result.reasons, []);
});

test("own promote job pending does NOT block (self-exclusion by name)", () => {
  const result = run([
    cr("quality", { completed_at: "2026-10-02T00:30:00Z" }),
    cr("dependency-review", { completed_at: "2026-10-02T00:30:01Z" }),
    cr("gitleaks", { completed_at: "2026-10-02T00:30:02Z" }),
    cr("analyze", { completed_at: "2026-10-02T00:30:03Z" }),
    cr("ai-reviewers", { completed_at: "2026-10-02T00:30:04Z" }),
    cr("unresolved-review-threads", {
      completed_at: "2026-10-02T00:30:05Z",
    }),
    cr("promote", { status: "in_progress", conclusion: null }),
  ]);
  assert.equal(result.decision, "allow");
});

test("own promote job failing does NOT block (self-exclusion by name)", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
    cr("promote", { conclusion: "failure" }),
  ]);
  assert.equal(result.decision, "allow");
});

test("non-required Dependabot failure does NOT block", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
    cr("Dependabot", { conclusion: "failure" }),
  ]);
  assert.equal(result.decision, "allow");
});

test("non-required latest-openclaw-scanner failure does NOT block", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
    cr("latest-openclaw-scanner", { conclusion: "failure" }),
  ]);
  assert.equal(result.decision, "allow");
});

test("informational `checks` failure does NOT block (real CI shape on 2e02177ac)", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
    cr("checks", { conclusion: "failure" }),
    cr("tests (packages-1)", { conclusion: "failure" }),
  ]);
  assert.equal(result.decision, "allow");
});

test("required context failing on evaluated sha IS refusal", () => {
  const result = run([
    cr("quality", { conclusion: "failure" }),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some((r) => r.startsWith("quality:") && r.includes("failure")),
    `expected a reason naming quality=failure, got: ${JSON.stringify(result.reasons)}`,
  );
});

test("required context missing on evaluated sha IS refusal (fail closed)", () => {
  // `dependency-review`, `ai-reviewers`, `unresolved-review-threads` absent.
  // Real on a merge commit sha for a true merge — the workflow must retarget
  // to the PR head before calling the script, which then sees all six present.
  // Missing this test = absent-required is a silent pass.
  const result = run([
    cr("quality"),
    cr("gitleaks"),
    cr("analyze"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some((r) => /dependency-review/.test(r)),
    `expected a reason naming missing dependency-review, got: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    result.reasons.some((r) => /ai-reviewers/.test(r)),
    `expected a reason naming missing ai-reviewers, got: ${JSON.stringify(result.reasons)}`,
  );
  assert.ok(
    result.reasons.some((r) => /unresolved-review-threads/.test(r)),
    `expected a reason naming missing unresolved-review-threads, got: ${JSON.stringify(result.reasons)}`,
  );
});

test("required context timed_out IS refusal", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads", { conclusion: "timed_out" }),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some((r) =>
      r.startsWith("unresolved-review-threads:") && r.includes("timed_out"),
    ),
  );
});

test("required context cancelled IS refusal", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers", { conclusion: "cancelled" }),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("required context action_required IS refusal", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze", { conclusion: "action_required" }),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("required context stale IS refusal", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks", { conclusion: "stale" }),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("required context still in_progress IS refusal (CI not finished)", () => {
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers", { status: "in_progress", conclusion: null }),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("latest run per context wins (older success is superseded by newer failure)", () => {
  // Same name twice. The script must take the newest one and refuse on failure,
  // not silently use the older success. Latest is by completed_at, and pending
  // runs with completed_at=null are NOT preferred over completed ones — only
  // completed runs are eligible as the "latest conclusion".
  const result = run([
    cr("quality", { conclusion: "success", completed_at: "2026-10-01T00:00:00Z" }),
    cr("quality", { conclusion: "failure", completed_at: "2026-10-02T00:30:00Z" }),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("script reports both failing required AND missing required in one verdict", () => {
  const result = run([
    cr("quality", { conclusion: "failure" }),
    // gitleaks, ai-reviewers, unresolved-review-threads all missing.
    cr("dependency-review"),
    cr("analyze"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.length >= 4, `got ${result.reasons.length} reasons`);
});

test("REQUIRED contexts evaluate against the PR head, not the chore/squash commit", () => {
  // The workflow fetches the records to hand the script. This test enforces
  // that the script trusts what it's given. The PR-head-vs-squash-commit
  // retarget is owned by the workflow, not the script.
  //
  // Fixture shape mirrors PR #3155's head (f4e2c028) — all six required green,
  // no informational churn. Squash commit 2e02177ac, given the same input,
  // would still pass because the gate evaluates evidence it was handed.
  const records = [
    cr("ai-reviewers", { completed_at: "2026-10-01T23:59:00Z" }),
    cr("analyze", { completed_at: "2026-10-01T23:59:01Z" }),
    cr("dependency-review", { completed_at: "2026-10-01T23:59:02Z" }),
    cr("gitleaks", { completed_at: "2026-10-01T23:59:03Z" }),
    cr("quality", { completed_at: "2026-10-01T23:59:04Z" }),
    cr("unresolved-review-threads", { completed_at: "2026-10-01T23:59:05Z" }),
  ];
  assert.equal(run(records).decision, "allow");
});

test("--input-file accepts a JSON path (the workflow's invocation shape)", () => {
  // The workflow writes a JSON file to $RUNNER_TEMP/ci-gate-input.json and
  // invokes the script with --input-file. The script must read that file,
  // not treat the path as the JSON string (the previous bug).
  const tmpFile = path.join(os.tmpdir(), `ci-gate-input-${process.pid}-${Date.now()}.json`);
  const payload = {
    type: "check-runs",
    records: [
      cr("quality"),
      cr("dependency-review"),
      cr("gitleaks"),
      cr("analyze"),
      cr("ai-reviewers"),
      cr("unresolved-review-threads"),
    ],
  };
  writeFileSync(tmpFile, JSON.stringify(payload));
  try {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          scriptPath,
          "--required-contexts",
          JSON.stringify(REQUIRED),
          "--input-file",
          tmpFile,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(result.decision, "allow");
  } finally {
    unlinkSync(tmpFile);
  }
});

test("required context conclusion=startup_failure IS refusal (reviewer finding)", () => {
  // Code review caught: startup_failure is a real CI failure (the job never
  // started), and was missing from the failure-conclusion set. The CI
  // machinery elsewhere in the repo treats it as a failure; this gate must
  // match.
  const result = run([
    cr("quality", { conclusion: "startup_failure" }),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some(
      (r) => r.startsWith("quality:") && r.includes("startup_failure"),
    ),
    `expected a reason naming quality=startup_failure, got: ${JSON.stringify(result.reasons)}`,
  );
});

test("latest run wins: a newer in_progress refiuses (latest IS unfinished)", () => {
  // When the LATEST run is unfinished, refuse.
  // Rulesets block on the latest run, not any historical record.
  const result = run([
    cr("quality", { conclusion: "success", completed_at: "2026-09-01T00:00:00Z" }),
    cr("quality", { status: "in_progress", conclusion: null }),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
});

test("conclusion=skipped IS refusal (round-2: allow-list on success only)", () => {
  // `skipped` is what path-filtered jobs post. A required context that
  // skipped has not run its real check; treating it as green lets a missing
  // verdict authorise a promotion. Allow-list says only `success` is green.
  const result = run([
    cr("quality", { conclusion: "skipped" }),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers"),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some(
      (r) => r.startsWith("quality:") && /not a green verdict/.test(r),
    ),
  );
});

test("latest run wins with started_at fallback (round-3 workflow now sends started_at)", () => {
  // Round-3 caught: the workflow was projecting only completed_at, so an
  // unfinished rerun with started_at but no completed_at had an empty
  // order key, and the older completed success was selected. With the
  // workflow now projecting both, the unfinished rerun is correctly the
  // latest record and the gate refuses.
  const result = run([
    crF("quality", { conclusion: "success", completed_at: "2026-09-01T00:00:00Z" }),
    crF("quality", { status: "queued", conclusion: null, started_at: "2026-10-02T00:30:00Z", completed_at: null }),
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some(
      (r) => r.startsWith("quality:") && /CI not finished/.test(r),
    ),
  );
});

test("a never-started check-run (no timestamps) supersedes timestamped records and fails closed", () => {
  const result = run([
    cr("quality", { conclusion: "success", completed_at: "2026-10-01T00:00:00Z" }),
    crF("quality", { status: "queued", conclusion: null, started_at: null, completed_at: null }),
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some((r) => r.startsWith("quality:") && /CI not finished/.test(r)),
  );
});

test("timestampless completed records tie-break by id (higher id wins, order-independent)", () => {
  const green = [
    { name: "quality", status: "completed", conclusion: "success", id: 1 },
    { name: "quality", status: "completed", conclusion: "failure", id: 2 },
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  assert.equal(run(green).decision, "refuse");
  assert.ok(run(green).reasons.some((r) => r === "quality: failure"));
  const flipped = [green[1], green[0], ...green.slice(2)];
  assert.deepEqual(run(flipped), run(green));
});

test("conclusion=neutral IS refusal (round-2: allow-list on success only)", () => {
  // The repo's ai-reviewers gate posts `neutral` for superseded runs.
  // Treat as refusal so a required review that produced no real verdict
  // cannot authorise a promotion.
  const result = run([
    cr("quality"),
    cr("dependency-review"),
    cr("gitleaks"),
    cr("analyze"),
    cr("ai-reviewers", { conclusion: "neutral" }),
    cr("unresolved-review-threads"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(
    result.reasons.some(
      (r) =>
        r.startsWith("ai-reviewers:") && /not a green verdict/.test(r),
    ),
  );
});

test("script fails fast when --required-contexts is not provided", () => {
  // The gate must fail closed if the ruleset could not be read. This case
  // asserts the script refuses (or errors) without a required-contexts list
  // — i.e. it must NOT silently treat the absence as "no required contexts".
  assert.throws(
    () =>
      execFileSync(process.execPath, [scriptPath], {
        input: JSON.stringify({ type: "check-runs", records: [cr("quality")] }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    (err) => err.status !== 0,
  );
});