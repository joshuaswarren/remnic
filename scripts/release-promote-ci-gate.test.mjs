
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

function run(records, requiredContexts = REQUIRED) {
  const result = execFileSync(
    process.execPath,
    [scriptPath, "--required-contexts", JSON.stringify(requiredContexts)],
    {
      input: JSON.stringify({ type: "check-runs", records }),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(result);
}

function crF(name, opts = {}) {
  return {
    name,
    status: opts.status ?? "completed",
    conclusion: opts.conclusion ?? "success",
    started_at: opts.started_at,
    completed_at: opts.completed_at,
  };
}

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
    cr("dependency-review"),
    cr("analyze"),
  ]);
  assert.equal(result.decision, "refuse");
  assert.ok(result.reasons.length >= 4, `got ${result.reasons.length} reasons`);
});

test("REQUIRED contexts evaluate against the PR head, not the chore/squash commit", () => {
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

test("timestamp-less rows without ids keep the failing record (false-approval regression)", () => {
  const qualityRows = [
    {
      name: "quality",
      status: "completed",
      conclusion: "success",
      started_at: null,
      completed_at: null,
    },
    {
      name: "quality",
      status: "completed",
      conclusion: "failure",
      started_at: null,
      completed_at: null,
    },
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  for (const records of [qualityRows, [qualityRows[1], qualityRows[0], ...qualityRows.slice(2)]]) {
    const result = run(records);
    assert.equal(result.decision, "refuse");
    assert.ok(result.reasons.some((r) => r === "quality: failure"));
  }
});

test("timestampless completed records tie-break by numeric id (multi-digit, order-independent)", () => {
  const green = [
    { name: "quality", status: "completed", conclusion: "success", id: 9 },
    { name: "quality", status: "completed", conclusion: "failure", id: 10 },
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

test("equal timestamps tie-break by numeric id; a full tie keeps the non-success record", () => {
  const base = [
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  const timestamps = { started_at: "2026-10-02T00:30:00Z", completed_at: "2026-10-02T00:31:00Z" };
  const sameSecond = [
    { name: "quality", status: "completed", conclusion: "success", id: 40, ...timestamps },
    { name: "quality", status: "completed", conclusion: "failure", id: 41, ...timestamps },
    ...base,
  ];
  assert.ok(run(sameSecond).reasons.some((r) => r === "quality: failure"));
  const fullTie = [
    { name: "quality", status: "completed", conclusion: "success", ...timestamps },
    { name: "quality", status: "completed", conclusion: "failure", ...timestamps },
    ...base,
  ];
  assert.ok(run(fullTie).reasons.some((r) => r === "quality: failure"));
});

test("same-second legacy statuses with ids allow when the higher id succeeded", () => {
  const statuses = [
    { name: "quality", status: "completed", conclusion: "success", id: 510, started_at: "2026-10-02T00:31:00Z", completed_at: "2026-10-02T00:31:00Z" },
    { name: "quality", status: "completed", conclusion: "failure", id: 509, started_at: "2026-10-02T00:31:00Z", completed_at: "2026-10-02T00:31:00Z" },
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  assert.equal(run(statuses).decision, "allow");
  assert.deepEqual(run(statuses).reasons, []);
  assert.equal(run([statuses[1], statuses[0], ...statuses.slice(2)]).decision, "allow");
  const failingNewest = [
    { name: "quality", status: "completed", conclusion: "success", id: 509, started_at: "2026-10-02T00:31:00Z", completed_at: "2026-10-02T00:31:00Z" },
    { name: "quality", status: "completed", conclusion: "failure", id: 510, started_at: "2026-10-02T00:31:00Z", completed_at: "2026-10-02T00:31:00Z" },
    ...statuses.slice(2),
  ];
  assert.ok(run(failingNewest).reasons.some((r) => r === "quality: failure"));
});

test("mixed check-run and status records for one context both gate the verdict", () => {
  const base = [
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  const row = (conclusion, id, source, completed_at) => ({
    name: "quality",
    status: "completed",
    conclusion,
    id,
    source,
    started_at: completed_at,
    completed_at,
  });
  const at = "2026-10-02T00:31:00Z";
  const checkRunFailure = [
    row("failure", 100, "check-run", at),
    row("success", 9000, "status", at),
    ...base,
  ];
  const statusFailure = [
    row("success", 100, "check-run", at),
    row("failure", 9000, "status", at),
    ...base,
  ];
  for (const records of [checkRunFailure, statusFailure]) {
    assert.equal(run(records).decision, "refuse");
    assert.ok(run(records).reasons.some((r) => r === "quality: failure"));
  }
  const bothGreen = [
    row("success", 100, "check-run", at),
    row("success", 9000, "status", at),
    ...base,
  ];
  assert.deepEqual(run(bothGreen), { decision: "allow", reasons: [] });
});

test("mixed sources keep independent verdicts across different timestamps", () => {
  const base = [
    crF("dependency-review"),
    crF("gitleaks"),
    crF("analyze"),
    crF("ai-reviewers"),
    crF("unresolved-review-threads"),
  ];
  const row = (conclusion, id, source, completed_at) => ({
    name: "quality",
    status: "completed",
    conclusion,
    id,
    source,
    started_at: completed_at,
    completed_at,
  });
  const newerCheckRunFailure = [
    row("failure", 100, "check-run", "2026-10-02T01:00:00Z"),
    row("success", 9000, "status", "2026-10-02T00:00:00Z"),
    ...base,
  ];
  assert.ok(run(newerCheckRunFailure).reasons.some((r) => r === "quality: failure"));
  const olderStatusFailure = [
    row("success", 100, "check-run", "2026-10-02T01:00:00Z"),
    row("failure", 9000, "status", "2026-10-02T00:00:00Z"),
    ...base,
  ];
  assert.ok(run(olderStatusFailure).reasons.some((r) => r === "quality: failure"));
  const bothGreen = [
    row("success", 100, "check-run", "2026-10-02T01:00:00Z"),
    row("success", 9000, "status", "2026-10-02T00:00:00Z"),
    ...base,
  ];
  assert.deepEqual(run(bothGreen), { decision: "allow", reasons: [] });
});

test("conclusion=neutral IS refusal (round-2: allow-list on success only)", () => {
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

test("an app-pinned required check cannot be satisfied by another app or an unverified legacy status", () => {
  const required = [{ context: "quality", integration_id: 15368 }];
  for (const record of [
    { ...cr("quality"), app: { id: 999 } },
    cr("quality"),
    { ...cr("quality"), source: "status", creator: { id: 15368 } },
  ]) {
    const result = run([record], required);
    assert.equal(result.decision, "refuse");
    assert.match(result.reasons.join(" "), /quality: missing/);
  }
});

test("only the pinned app's latest run determines its required verdict", () => {
  const required = [{ context: "quality", integration_id: 15368 }];
  const pinned = { ...cr("quality"), app: { id: 15368 }, source: "check-run" };
  const other = { ...cr("quality", { completed_at: "2026-10-03T00:00:00Z" }), app: { id: 999 }, source: "check-run" };
  assert.deepEqual(run([pinned, { ...other, conclusion: "failure" }], required), { decision: "allow", reasons: [] });
  assert.deepEqual(run([pinned, { ...other, status: "queued", conclusion: null }], required), { decision: "allow", reasons: [] });
  const failure = run([{ ...pinned, conclusion: "failure" }, other], required);
  assert.equal(failure.decision, "refuse");
  assert.deepEqual(failure.reasons, ["quality: failure"]);
  const queued = {
    ...pinned, status: "queued", conclusion: null,
    started_at: "2026-10-04T00:00:00Z", completed_at: null,
  };
  const pending = run([pinned, queued, other], required);
  assert.equal(pending.decision, "refuse");
  assert.match(pending.reasons.join(" "), /quality: CI not finished/);
});

test("same context pinned to two integrations requires both integration verdicts", () => {
  const required = [
    { context: "quality", integration_id: 15368 },
    { context: "quality", integration_id: 999 },
  ];
  const first = { ...cr("quality"), app: { id: 15368 } };
  const second = { ...cr("quality"), app: { id: 999 } };
  assert.equal(run([first], required).decision, "refuse");
  assert.deepEqual(run([first, second], required), { decision: "allow", reasons: [] });
  assert.equal(run([first, { ...second, conclusion: "failure" }], required).decision, "refuse");
});

test("string and unpinned object requirements retain check-run and status gating", () => {
  const records = [
    { ...cr("quality"), source: "check-run", app: { id: 999 } },
    { ...cr("quality"), source: "status", conclusion: "failure" },
  ];
  for (const required of [
    ["quality"],
    [{ context: "quality" }],
    [{ context: "quality", integration_id: null }],
    [{ context: "quality", integration_id: -1 }],
  ]) {
    assert.equal(run(records, required).decision, "refuse");
    assert.deepEqual(run(records.slice(0, 1), required), { decision: "allow", reasons: [] });
  }
});

test("malformed integration requirements fail closed instead of becoming strings", () => {
  for (const requirement of [
    { context: "quality", integration_id: "15368" },
    { context: "quality", integration_id: 0 },
    { context: "quality", integration_id: 1.5 },
    { integration_id: 15368 },
    { context: "" },
  ]) {
    assert.throws(
      () => run([cr("[object Object]")], [requirement]),
      (err) => err.status === 2 && /entries must be context strings/.test(String(err.stderr)),
    );
  }
});

test("a pinned integration can satisfy its required context with a verified legacy status", () => {
  const required = [{ context: "quality", integration_id: 15368 }];
  const status = { ...cr("quality"), source: "status", app: { id: 15368 } };
  const otherApp = { ...cr("quality"), source: "status", app: { id: 999 } };
  assert.deepEqual(run([status], required), { decision: "allow", reasons: [] });
  assert.deepEqual(run([status, { ...otherApp, conclusion: "failure" }], required), { decision: "allow", reasons: [] });
  const check = { ...cr("quality"), source: "check-run", app: { id: 15368 } };
  for (const records of [
    [status, { ...check, conclusion: "failure" }],
    [check, { ...status, conclusion: "failure" }],
  ]) assert.deepEqual(run(records, required), { decision: "refuse", reasons: ["quality: failure"] });
});

test("an empty required-contexts list fails closed at the CLI", () => {
  assert.throws(() => run([cr("quality")], []), (err) => {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /must be a non-empty JSON array/);
    assert.doesNotMatch(String(err.stdout), /"decision":"allow"/);
    return true;
  });
});
