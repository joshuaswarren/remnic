import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "pre-merge-check.sh");

async function writeGhStub(binDir) {
  const ghPath = path.join(binDir, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "api" && "$2" == "graphql" ]]; then
  if [[ "$*" != *'$after: String = null'* ]]; then
    echo "graphql query must default after to null" >&2
    exit 4
  fi
  count="$(cat "$GH_STUB_COUNT" 2>/dev/null || echo 0)"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$GH_STUB_COUNT"
  case "$GH_STUB_SCENARIO:$count" in
    all_resolved:1)
      printf '150\\t0\\ttrue\\tcursor-1\\n'
      ;;
    all_resolved:2)
      printf '999\\t0\\tfalse\\t\\n'
      ;;
    unresolved_second_page:1)
      printf '150\\t0\\ttrue\\tcursor-1\\n'
      ;;
    unresolved_second_page:2)
      printf '150\\t1\\tfalse\\t\\n'
      ;;
    reviews_fail:1)
      printf '3\\t0\\tfalse\\t\\n'
      ;;
    malformed_page:1)
      printf '5\\t0\\n'
      ;;
    cursor_check_ok:1|unrelated_cursor_check:1|all_required_check_runs_ok:1)
      printf '3\\t0\\tfalse\\t\\n'
      ;;
    repeated_cursor:1)
      printf '150\\t0\\ttrue\\tcursor-1\\n'
      ;;
    repeated_cursor:2)
      printf '150\\t0\\ttrue\\tcursor-1\\n'
      ;;
    *)
      echo "unexpected graphql page $count for $GH_STUB_SCENARIO" >&2
      exit 2
      ;;
  esac
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/pulls/7/reviews" ]]; then
  if [[ "$GH_STUB_SCENARIO" == "reviews_fail" ]]; then
    echo "reviews unavailable" >&2
    exit 3
  fi
  if [[ "$GH_STUB_SCENARIO" == "cursor_check_ok" || "$GH_STUB_SCENARIO" == "unrelated_cursor_check" ]]; then
    printf 'chatgpt-codex-connector[bot]\\n'
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "all_required_check_runs_ok" ]]; then
    exit 0
  fi
  printf 'cursor[bot]\\nchatgpt-codex-connector[bot]\\n'
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/pulls/7/comments" ]]; then
  exit 0
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$*" != *"--repo example/repo"* ]]; then
    echo "gh pr view must pass --repo" >&2
    exit 5
  fi
  printf 'deadbeef\\n'
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/commits/deadbeef/check-runs" ]]; then
  if [[ "$GH_STUB_SCENARIO" == "cursor_check_ok" ]]; then
    printf 'cursor\\tCursor Bugbot\\n'
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "all_required_check_runs_ok" ]]; then
    printf 'cursor\\tCursor Bugbot\\n'
    printf 'chatgpt-codex-connector\\tCodex Review\\n'
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "unrelated_cursor_check" ]]; then
    printf 'cursor\\tunit tests\\n'
    exit 0
  fi
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 2
`,
  );
  await chmod(ghPath, 0o755);
}

async function withGhStub(scenario, fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-pre-merge-check-"));
  try {
    const binDir = path.join(tmp, "bin");
    await mkdir(binDir);
    await writeGhStub(binDir);
    const countPath = path.join(tmp, "graphql-count");
    const env = {
      ...process.env,
      GH_STUB_COUNT: countPath,
      GH_STUB_SCENARIO: scenario,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      REMNIC_REPO: "example/repo",
    };
    await fn(env, countPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function runPreMergeCheck(env) {
  return spawnSync("bash", [scriptPath, "7"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

test("pre-merge check scans all review-thread pages before allowing merge", async () => {
  await withGhStub("all_resolved", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Review threads: 150 total, 0 unresolved/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "2");
  });
});

test("pre-merge check blocks unresolved review threads after the first page", async () => {
  await withGhStub("unresolved_second_page", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Review threads: 150 total, 1 unresolved/);
    assert.match(result.stdout, /BLOCKED: 1 unresolved review thread/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "2");
  });
});

test("pre-merge check reports GitHub API failures separately from missing reviewers", async () => {
  await withGhStub("reviews_fail", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Review threads: 3 total, 0 unresolved/);
    assert.match(result.stdout, /BLOCKED: Failed to read PR reviews from GitHub/);
    assert.doesNotMatch(result.stdout, /Missing reviews/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});

test("pre-merge check rejects malformed review-thread pagination output", async () => {
  await withGhStub("malformed_page", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /BLOCKED: GitHub returned malformed review thread data/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});

test("pre-merge check fails closed when GitHub pagination does not advance", async () => {
  await withGhStub("repeated_cursor", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /BLOCKED: GitHub review thread pagination did not advance/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "2");
  });
});

test("pre-merge check accepts the Cursor Bugbot check run as reviewer activity", async () => {
  await withGhStub("cursor_check_ok", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});

test("pre-merge check accepts required reviewer check runs as reviewer activity", async () => {
  await withGhStub("all_required_check_runs_ok", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});

test("pre-merge check rejects unrelated checks from a matching app slug", async () => {
  await withGhStub("unrelated_cursor_check", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: cursor\[bot\]/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});
