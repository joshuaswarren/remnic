import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "pr-merge-ready.sh");
const headSha = "deadbeef1234567890abcdef1234567890abcdef";
const staleSha = "cafebabecafebabecafebabecafebabecafebabe";

async function writeGhStub(binDir) {
  const ghPath = path.join(binDir, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
log() { printf '%s\\n' "$*" >> "$GH_STUB_LOG"; }

if [[ "$1 $2" == "pr view" ]]; then
  json=""
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "--json" ]]; then json="$a"; fi
    prev="$a"
  done
  case "$json" in
    headRefOid,headRefName,state,mergeStateStatus)
      printf '${headSha}\\tfeat/example\\tOPEN\\tCLEAN\\n'
      ;;
    headRefOid)
      printf '${headSha}\\n'
      ;;
    state)
      if [[ "$GH_STUB_SCENARIO" == "never_merged" ]]; then
        printf 'OPEN\\n'
      elif [[ -f "$GH_STUB_DIR/merged" ]]; then
        printf 'MERGED\\n'
      else
        printf 'OPEN\\n'
      fi
      ;;
    *)
      echo "unexpected pr view fields: $json" >&2
      exit 2
      ;;
  esac
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/commits/${headSha}/check-runs" ]]; then
  case "$GH_STUB_SCENARIO" in
    red_check)
      printf 'ci\\tcompleted\\tsuccess\\t${headSha}\\n'
      printf 'ai-reviewers\\tcompleted\\tfailure\\t${headSha}\\n'
      printf 'unresolved-review-threads\\tcompleted\\tsuccess\\t${headSha}\\n'
      ;;
    pending_check)
      printf 'ci\\tin_progress\\t-\\t${headSha}\\n'
      printf 'ai-reviewers\\tcompleted\\tsuccess\\t${headSha}\\n'
      ;;
    rerun_green)
      printf 'ci\\tcompleted\\tfailure\\t${headSha}\\n'
      printf 'ci\\tcompleted\\tsuccess\\t${headSha}\\n'
      printf 'ai-reviewers\\tcompleted\\tsuccess\\t${headSha}\\n'
      printf 'unresolved-review-threads\\tcompleted\\tsuccess\\t${headSha}\\n'
      ;;
    *)
      printf 'ci\\tcompleted\\tsuccess\\t${headSha}\\n'
      printf 'ai-reviewers\\tcompleted\\tsuccess\\t${headSha}\\n'
      printf 'unresolved-review-threads\\tcompleted\\tsuccess\\t${headSha}\\n'
      ;;
  esac
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/pulls/7/reviews" ]]; then
  review_calls=$(( $(cat "$GH_STUB_REVIEWS_COUNT" 2>/dev/null || echo 0) + 1 ))
  printf '%s\\n' "$review_calls" > "$GH_STUB_REVIEWS_COUNT"
  # The gate-time query reads 3 columns (its jq mentions .user.login); the
  # pre-admin recheck reads 2 (node_id, commit_id). Branch on the jq shape so
  # each caller gets the column layout it parses.
  if [[ "$*" == *"user.login"* ]]; then
    case "$GH_STUB_SCENARIO" in
      stale_review)
        printf 'R_STALE\\tcoderabbitai[bot]\\t${staleSha}\\n'
        ;;
      current_head_changes)
        printf 'R_FRESH\\tcoderabbitai[bot]\\t${headSha}\\n'
        ;;
    esac
  elif [[ "$GH_STUB_SCENARIO" == "late_changes_requested" && "$review_calls" -ge 2 ]]; then
    printf 'R_LATE\\t${headSha}\\n'
  fi
  exit 0
fi

if [[ "$1 $2" == "api graphql" ]]; then
  if [[ "$*" == *dismissPullRequestReview* ]]; then
    id="" message=""
    for a in "$@"; do
      case "$a" in
        id=*) id="\${a#id=}" ;;
        message=*) message="\${a#message=}" ;;
      esac
    done
    log "dismiss|$id|$message"
    printf '{}\\n'
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "unresolved_thread" ]]; then
    printf '3\\t1\\tfalse\\t\\n'
  else
    printf '3\\t0\\tfalse\\t\\n'
  fi
  exit 0
fi

if [[ "$1 $2" == "pr merge" ]]; then
  if [[ "$*" != *"--squash"* ]]; then
    echo "merge must be --squash" >&2
    exit 9
  fi
  if [[ "$*" != *"--match-head-commit ${headSha}"* ]]; then
    echo "merge must pin --match-head-commit to the verified head" >&2
    exit 9
  fi
  if [[ "$*" == *--admin* ]]; then
    if [[ "$GH_STUB_SCENARIO" == "merge_refused_twice" ]]; then
      log "merge:admin:refused"
      echo "admin merge refused too" >&2
      exit 1
    fi
    log "merge:admin"
    touch "$GH_STUB_DIR/merged"
    exit 0
  fi

  case "$GH_STUB_SCENARIO" in
    admin_retry|merge_refused_twice|late_changes_requested)
      log "merge:plain:refused"
      echo "Pull request is not mergeable: merge state is BLOCKED" >&2
      exit 1
      ;;
    never_merged)
      log "merge:plain"
      exit 0
      ;;
    *)
      log "merge:plain"
      touch "$GH_STUB_DIR/merged"
      exit 0
      ;;
  esac
fi

echo "unexpected gh invocation: $*" >&2
exit 2
`
  );
  await chmod(ghPath, 0o755);
  const gitPath = path.join(binDir, "git");
  await writeFile(
    gitPath,
    `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$GIT_STUB_LOG"
exit 0
`,
  );
  await chmod(gitPath, 0o755);
}

async function readLog(logPath) {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

async function withStubs(scenario, fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-merge-ready-"));
  try {
    const binDir = path.join(tmp, "bin");
    await mkdir(binDir);
    await writeGhStub(binDir);
    const ghLog = path.join(tmp, "gh.log");
    const gitLog = path.join(tmp, "git.log");
    const env = {
      ...process.env,
      GH_STUB_DIR: tmp,
      GH_STUB_LOG: ghLog,
      GH_STUB_REVIEWS_COUNT: path.join(tmp, "reviews-count"),
      GIT_STUB_LOG: gitLog,
      GH_STUB_SCENARIO: scenario,
      REMNIC_GH_BIN: path.join(binDir, "gh"),
      REMNIC_GIT_BIN: path.join(binDir, "git"),
      REMNIC_REPO: "example/repo",
    };
    await fn(env, { ghLog, gitLog });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function run(env, args) {
  return spawnSync("bash", [scriptPath, "7", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}


test("merges a green PR with --squash and deletes the branch only after MERGED", async () => {
  await withStubs("green", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);

    // Evidence block: head SHA, per-gate conclusions, thread count.
    assert.match(result.stdout, new RegExp(headSha));
    assert.match(result.stdout, /ci: success/);
    assert.match(result.stdout, /ai-reviewers: success/);
    assert.match(result.stdout, /unresolved-review-threads: success/);
    assert.match(result.stdout, /0 unresolved \/ 3 total/);
    assert.match(result.stdout, /verdict:\s+READY/);

    const ghLogText = await readLog(ghLog);
    assert.match(ghLogText, /merge:plain/);

    const gitLogText = await readLog(gitLog);
    assert.match(gitLogText, /git push origin --delete feat\/example/, `${result.stderr}\n${result.stdout}`);
  });
});

test("dismisses only stale CHANGES_REQUESTED reviews, with a reason string", async () => {
  await withStubs("stale_review", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    const ghLogText = await readLog(ghLog);
    assert.match(ghLogText, /^dismiss\|R_STALE\|/m);
    assert.match(ghLogText, /superseded/);
    assert.match(ghLogText, /pr-merge-ready\.sh/);
    // Stale dismissal is step 2; merge still happens and the branch is deleted.
    assert.match(ghLogText, /merge:plain/);
    const gitLogText = await readLog(gitLog);
    assert.match(gitLogText, /git push origin --delete feat\/example/);
  });
});

test("retries once with --admin when preconditions held, and logs WHY", async () => {
  await withStubs("admin_retry", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    const ghLogText = await readLog(ghLog);
    const plainIndex = ghLogText.indexOf("merge:plain:refused");
    const adminIndex = ghLogText.indexOf("merge:admin");
    assert.ok(plainIndex >= 0, "plain merge attempted");
    assert.ok(adminIndex > plainIndex, "admin retry happens after the plain refusal");

    assert.match(result.stdout, /retrying ONCE with --admin\. WHY:/);
    assert.match(result.stdout, /mergeStateStatus BLOCKED-after-dismissal/);
    assert.match(result.stdout, /plain merge refused:.*BLOCKED/);

    const gitLogText = await readLog(gitLog);
    assert.match(gitLogText, /git push origin --delete feat\/example/);
  });
});

test("fails closed when even --admin is refused", async () => {
  await withStubs("merge_refused_twice", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--admin merge also refused/);

    const gitLogText = await readLog(gitLog);
    assert.equal(gitLogText, "");
  });
});

test("never deletes the branch when the PR does not reach MERGED", async () => {
  await withStubs("never_merged", async (env, { ghLog, gitLog }) => {
    const result = run(env, ["--timeout", "1", "--interval", "0"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not reach MERGED within 1s/);
    assert.match(result.stderr, /NOT deleted/);

    const ghLogText = await readLog(ghLog);
    assert.match(ghLogText, /merge:plain/);
    const gitLogText = await readLog(gitLog);
    assert.equal(gitLogText, "", "branch deletion must be gated on state=MERGED");
  });
});

test("blocks on a red head check without dismissing, merging, or deleting", async () => {
  await withStubs("red_check", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /ai-reviewers: completed\/failure \(RED\)/);
    assert.match(result.stdout, /verdict:\s+BLOCKED/);
    assert.match(result.stderr, /gates not satisfied/);

    const ghLogText = await readLog(ghLog);
    assert.doesNotMatch(ghLogText, /dismiss\|/);
    assert.doesNotMatch(ghLogText, /merge:/);
    assert.equal(await readLog(gitLog), "");
  });
});

test("blocks on a pending head check", async () => {
  await withStubs("pending_check", async (env) => {
    const result = run(env, []);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /ci: in_progress\/- \(RED\)/);
  });
});

test("blocks on unresolved review threads", async () => {
  await withStubs("unresolved_thread", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /1 unresolved \/ 3 total/);
    assert.match(result.stdout, /verdict:\s+BLOCKED/);
    assert.doesNotMatch(await readLog(ghLog), /merge:/);
    assert.equal(await readLog(gitLog), "");
  });
});

test("blocks on a current-head CHANGES_REQUESTED and never dismisses it", async () => {
  await withStubs("current_head_changes", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /1 current-head CHANGES_REQUESTED \(blocking\)/);

    const ghLogText = await readLog(ghLog);
    assert.doesNotMatch(ghLogText, /dismiss\|/);
    assert.doesNotMatch(ghLogText, /merge:/);
    assert.equal(await readLog(gitLog), "");
  });
});

test("--check prints the plan without acting", async () => {
  await withStubs("stale_review", async (env, { ghLog, gitLog }) => {
    const result = run(env, ["--check"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    assert.match(result.stdout, /plan \(--check, no actions taken\)/);
    assert.match(result.stdout, /dismiss 1 stale CHANGES_REQUESTED review/);
    assert.match(result.stdout, /R_STALE \(coderabbitai\[bot\], commit cafebab != head deadbee/);
    assert.match(result.stdout, /gh pr merge 7 --repo example\/repo --squash --match-head-commit/);
    assert.match(result.stdout, /poll state until MERGED, then git push origin --delete feat\/example/);

    assert.equal(await readLog(ghLog), "", "dry run must not call any mutating gh command");
    assert.equal(await readLog(gitLog), "");
  });
});

test("--check exits nonzero when gates are blocked", async () => {
  await withStubs("red_check", async (env) => {
    const result = run(env, ["--check"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /verdict:\s+BLOCKED/);
  });
});

test("usage errors exit 2", async () => {
  const result = spawnSync("bash", [scriptPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: scripts\/pr-merge-ready\.sh/);
});
test("a superseded failed re-run row does not block a green latest run", async () => {
  await withStubs("rerun_green", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /ci: success/);
    assert.match(result.stdout, /verdict:\s+READY/);
    assert.match(await readLog(ghLog), /merge:plain/);
    assert.match(await readLog(gitLog), /git push origin --delete feat\/example/);
  });
});

test("refuses --admin retry when a live verdict lands on the head after gate verification", async () => {
  await withStubs("late_changes_requested", async (env, { ghLog, gitLog }) => {
    const result = run(env, []);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHANGES_REQUESTED review\(s\) now target the current head/);
    const ghLogText = await readLog(ghLog);
    assert.match(ghLogText, /merge:plain:refused/);
    assert.doesNotMatch(ghLogText, /merge:admin/);
    assert.equal(await readLog(gitLog), "");
  });
});

test("rejects a fractional --timeout and a non-numeric PR number with usage exit 2", async () => {
  await withStubs("green", async (env) => {
    const fractional = run(env, ["--timeout", "1.5"]);
    assert.equal(fractional.status, 2);
    assert.match(fractional.stderr, /Invalid --timeout value/);

    const flagFirst = spawnSync("bash", [scriptPath, "--check", "7"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    assert.equal(flagFirst.status, 2);
  });
});
