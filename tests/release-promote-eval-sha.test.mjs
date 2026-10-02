/**
 * Regression test for the quoted-EVAL_SHA bug found by real dry run
 * 37008248423 (v9.69.93 beta): the squash-retarget jq lacked -r, so
 * EVAL_SHA was emitted as a JSON-quoted string ("sha") and the next gh api
 * call failed with HTTP 422.
 *
 * Strategy: extract the `Verify CI is green on the release commit` step's
 * run: body from the workflow YAML, execute it under bash with a stub `gh`
 * on PATH that returns the squash-path fixture chain (chore(release) tag
 * commit -> 1 parent -> merged PR with matching merge_commit_sha), and
 * assert that the exported EVAL_SHA is a bare 40-hex sha with no quotes.
 * This is the test that would have caught the bug: it runs the actual
 * shell glue, not a transcription of it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_SHA = "a".repeat(40);
const PARENT_SHA = "c".repeat(40);
const PR_HEAD_SHA = "b".repeat(40);

function readStepRun() {
  const workflow = parse(
    readFileSync(path.join(REPO_ROOT, ".github/workflows/release-promote.yml"), "utf8"),
  );
  const step = workflow.jobs.promote.steps.find(
    (s) => s.name === "Verify CI is green on the release commit",
  );
  assert.ok(step, "CI gate step must exist");
  return step.run;
}

/**
 * Stub `gh` that simulates the exact post-jq output the step expects from
 * each call shape. Calls whose output the step pipes through real jq (the
 * /pulls lookup) get raw JSON; calls that use gh's own --jq get the
 * already-filtered text.
 */
function writeStubGh(binDir) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
# Join args for simple matching.
joined="$*"
case "$joined" in
  *"rules/branches/main"*)
    # gh-side --jq already applied: emit the filtered context list JSON.
    echo '["quality","dependency-review","gitleaks","analyze","ai-reviewers","unresolved-review-threads"]'
    exit 0
    ;;
  *"check-runs"*)
    # gh-side --jq applied: emit trimmed check-run records for the PR head.
    cat "${binDir}/check-runs.jsonl"
    exit 0
    ;;
  *"/status"*)
    # gh-side --jq applied: no statuses.
    echo ''
    exit 0
    ;;
  *"pulls"*)
    # Raw JSON array; the step pipes this through real jq itself.
    cat "${binDir}/pulls.json"
    exit 0
    ;;
  *"commit.message"*)
    # gh-side --jq applied: first line of the commit message.
    case "$joined" in
      *"${PARENT_SHA}"*)
        echo 'feat: base commit'
        ;;
      *)
        echo 'chore(release): v9.69.93 [skip ci]'
        ;;
    esac
    exit 0
    ;;
  *".parents[0].sha"*)
    echo "${PARENT_SHA}"
    exit 0
    ;;
  *".parents | length"*)
    echo '1'
    exit 0
    ;;
  *)
    echo "stub gh: unexpected call: $joined" >&2
    exit 1
    ;;
esac
`;
  writeFileSync(path.join(binDir, "gh"), stub, { mode: 0o755 });
}

const CONTEXTS = [
  "quality",
  "dependency-review",
  "gitleaks",
  "analyze",
  "ai-reviewers",
  "unresolved-review-threads",
];

/**
 * Runs the real "Verify CI" step body under bash with the stub gh. `prHeadSha`
 * is what the merged-PR lookup returns as head.sha, so a test can feed the
 * step a good or a malformed value.
 */
function runGate({ prHeadSha }) {
  const run = readStepRun();
  const work = mkdtempSync(path.join(tmpdir(), "evalsha-"));
  const binDir = path.join(work, "bin");
  const githubEnv = path.join(work, "github_env");
  try {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(path.join(work, "runner-temp"), { recursive: true });
    writeFileSync(githubEnv, "");
    writeStubGh(binDir);
    writeFileSync(
      path.join(binDir, "pulls.json"),
      JSON.stringify([
        {
          number: 3157,
          merged_at: "2026-10-02T12:07:00Z",
          merge_commit_sha: PARENT_SHA,
          base: { ref: "main" },
          head: { sha: prHeadSha },
        },
      ]),
    );
    writeFileSync(
      path.join(binDir, "check-runs.jsonl"),
      CONTEXTS.map(
        (name) =>
          JSON.stringify({
            name,
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-02T12:00:00Z",
            completed_at: "2026-10-02T12:01:00Z",
          }) + "\n",
      ).join(""),
    );
    const script = path.join(work, "step.sh");
    writeFileSync(script, run, { mode: 0o755 });
    const proc = spawnSync("bash", [script], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: "joshuaswarren/remnic",
        RELEASE_SHA: SOURCE_SHA,
        WORKFLOW_SRC: REPO_ROOT,
        RUNNER_TEMP: path.join(work, "runner-temp"),
        GITHUB_ENV: githubEnv,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      },
      encoding: "utf8",
    });
    return {
      status: proc.status,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      envText: readFileSync(githubEnv, "utf8"),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("squash-path glue exports a bare 40-hex EVAL_SHA (regression: quoted sha, run 37008248423)", () => {
  const r = runGate({ prHeadSha: PR_HEAD_SHA });
  assert.equal(r.status, 0, `step should succeed on all-green fixtures; stderr: ${r.stderr.slice(0, 800)}`);

  const retargetLine = r.stdout.split("\n").find((l) => l.includes("retargeting to associated PR HEAD"));
  assert.ok(retargetLine, "retarget log line must be printed");
  assert.doesNotMatch(retargetLine, /PR HEAD "/, `EVAL_SHA echoed with quotes: ${retargetLine}`);
  assert.match(retargetLine, new RegExp(`PR HEAD ${PR_HEAD_SHA}\\.$`));

  const evalLine = r.envText.split("\n").find((l) => l.startsWith("EVAL_SHA="));
  assert.ok(evalLine, "EVAL_SHA must be exported to GITHUB_ENV");
  assert.match(evalLine, /^EVAL_SHA=[0-9a-f]{40}$/);
});

test("a malformed EVAL_SHA is refused, never exported, and cannot inject a workflow command", () => {
  // A valid-looking first line followed by a second line that is a workflow
  // command. A line-oriented check would accept the first line, and an
  // unescaped newline would let the second line run as a command.
  const hostile = `${"d".repeat(40)}\n::warning::injected`;
  const r = runGate({ prHeadSha: hostile });

  assert.notEqual(r.status, 0, "a malformed EVAL_SHA must fail the step");
  assert.equal(
    r.envText.split("\n").some((l) => l.startsWith("EVAL_SHA=")),
    false,
    "a malformed EVAL_SHA must never be exported to GITHUB_ENV",
  );
  const lines = r.stdout.split("\n");
  assert.equal(
    lines.filter((l) => l.startsWith("::error title=Bad evaluated SHA::")).length,
    1,
    "the refusal must be reported once as an ::error",
  );
  assert.equal(
    lines.some((l) => l.startsWith("::warning::")),
    false,
    "the embedded newline must not start a second workflow command",
  );
});
