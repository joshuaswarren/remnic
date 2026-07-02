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
    cursor_check_ok:1|unrelated_cursor_check:1|all_required_check_runs_ok:1|codex_issue_comment_ok:1|codex_issue_comment_short_sha:1|codex_issue_comment_stale:1|codex_issue_comment_not_verdict:1|codex_verdict_sha_in_prose:1|codex_verdict_unpinned:1|generic_issue_comment_ignored:1|issue_comments_fail:1|codex_reaction_ok:1|codex_reaction_stale:1|codex_reaction_negative:1|reaction_wrong_user:1|reactions_read_fail:1|reaction_head_date_missing:1)
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
  if [[ "$GH_STUB_SCENARIO" == codex_issue_comment_* || "$GH_STUB_SCENARIO" == "codex_verdict_sha_in_prose" || "$GH_STUB_SCENARIO" == "generic_issue_comment_ignored" || "$GH_STUB_SCENARIO" == codex_reaction_* || "$GH_STUB_SCENARIO" == "reaction_wrong_user" || "$GH_STUB_SCENARIO" == "reactions_read_fail" || "$GH_STUB_SCENARIO" == "reaction_head_date_missing" ]]; then
    printf 'cursor[bot]\\n'
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

if [[ "$1" == "api" && "$2" == "repos/example/repo/issues/7/comments" ]]; then
  if [[ "$GH_STUB_SCENARIO" == "issue_comments_fail" ]]; then
    echo "issue comments unavailable" >&2
    exit 3
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_issue_comment_ok" ]]; then
    printf "chatgpt-codex-connector[bot]\\tCodex Review: Didn't find any major issues. **Reviewed commit:** deadbeef12\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_issue_comment_short_sha" ]]; then
    printf "chatgpt-codex-connector[bot]\\tCodex Review: Didn't find any major issues. Reviewed commit: deadbee\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_issue_comment_stale" ]]; then
    printf "chatgpt-codex-connector[bot]\\tCodex Review: Didn't find any major issues. **Reviewed commit:** cafebabe12\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_issue_comment_not_verdict" ]]; then
    printf "chatgpt-codex-connector[bot]\\tFound 2 major issues in the diff. **Reviewed commit:** deadbeef12\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_verdict_sha_in_prose" ]]; then
    printf "chatgpt-codex-connector[bot]\\tCodex Review: Didn't find any major issues. Compare with deadbeef12 later. **Reviewed commit:** cafebabe12\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "codex_verdict_unpinned" ]]; then
    printf "chatgpt-codex-connector[bot]\\tCodex Review: Didn't find any major issues. Hooray!\\n"
    exit 0
  fi
  if [[ "$GH_STUB_SCENARIO" == "generic_issue_comment_ignored" ]]; then
    printf "someuser\\tLooks good to me! Reviewed commit: deadbeef12\\n"
    exit 0
  fi
  exit 0
fi

# Head commit metadata (committer date) — used to reject stale reaction sign-offs.
if [[ "$1" == "api" && "$2" == "repos/example/repo/commits/deadbeef1234567890abcdef1234567890abcdef" ]]; then
  if [[ "$GH_STUB_SCENARIO" == "reaction_head_date_missing" ]]; then
    exit 0  # empty body -> HEAD_COMMIT_DATE unknown
  fi
  printf '2026-06-01T00:00:00Z\\n'
  exit 0
fi

# PR-body reactions: login <TAB> content <TAB> created_at. Head commit date in
# the stub is 2026-06-01T00:00:00Z, so "…06-02…" is fresh and "…05-01…" is stale.
if [[ "$1" == "api" && "$2" == "repos/example/repo/issues/7/reactions" ]]; then
  case "$GH_STUB_SCENARIO" in
    reactions_read_fail)
      echo "reactions unavailable" >&2
      exit 3
      ;;
    codex_reaction_ok|reaction_head_date_missing)
      printf 'chatgpt-codex-connector[bot]\\t+1\\t2026-06-02T00:00:00Z\\n'
      ;;
    codex_reaction_stale)
      printf 'chatgpt-codex-connector[bot]\\t+1\\t2026-05-01T00:00:00Z\\n'
      ;;
    codex_reaction_negative)
      printf 'chatgpt-codex-connector[bot]\\tconfused\\t2026-06-02T00:00:00Z\\n'
      printf 'chatgpt-codex-connector[bot]\\t-1\\t2026-06-02T00:00:00Z\\n'
      ;;
    reaction_wrong_user)
      printf 'someuser\\t+1\\t2026-06-02T00:00:00Z\\n'
      ;;
  esac
  exit 0
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$*" != *"--repo example/repo"* ]]; then
    echo "gh pr view must pass --repo" >&2
    exit 5
  fi
  printf 'deadbeef1234567890abcdef1234567890abcdef\\n'
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/example/repo/commits/deadbeef1234567890abcdef1234567890abcdef/check-runs" ]]; then
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

test("pre-merge check accepts a codex clean-verdict ISSUE comment as reviewer activity", async () => {
  // Codex posts "no major issues" verdicts as issue comments, not reviews or
  // review comments — the endpoint gap this PR fixes.
  await withGhStub("codex_issue_comment_ok", async (env, countPath) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
    assert.equal((await readFile(countPath, "utf8")).trim(), "1");
  });
});

test("pre-merge check accepts codex verdicts with a short (7-char) reviewed-commit SHA", async () => {
  // Codex controls its own short-SHA length; the gate must accept any git
  // short SHA (>= 7 hex chars) that is a prefix of the current head.
  await withGhStub("codex_issue_comment_short_sha", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
  });
});

test("pre-merge check anchors the SHA pin to the Reviewed commit label, not prose", async () => {
  // The head SHA appearing elsewhere in the body must not satisfy the pin
  // when the verdict's own "Reviewed commit" points at a different SHA.
  await withGhStub("codex_verdict_sha_in_prose", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check ignores unpinned codex verdicts without aborting the gate", async () => {
  // A legacy clean verdict with no "Reviewed commit" label must be skipped —
  // not crash the errexit/pipefail script — so reviewers satisfied via
  // reviews/check runs still pass.
  await withGhStub("codex_verdict_unpinned", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
  });
});

test("pre-merge check rejects codex verdicts pinned to a different commit", async () => {
  // A clean verdict earned on a previous head must not carry over to new
  // commits — the comment feed is PR-wide, not SHA-scoped. The verdict's
  // embedded "Reviewed commit" SHA must be a prefix of the current head.
  await withGhStub("codex_issue_comment_stale", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check ignores codex issue comments that are not clean verdicts", async () => {
  await withGhStub("codex_issue_comment_not_verdict", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check never counts non-codex issue comments as reviewer activity", async () => {
  await withGhStub("generic_issue_comment_ignored", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check blocks when issue comments cannot be read", async () => {
  await withGhStub("issue_comments_fail", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /Failed to read PR issue comments/);
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

test("pre-merge check accepts a codex thumbs-up reaction on the PR body as sign-off", async () => {
  // Codex often signs off on a clean PR with a +1 reaction on the PR
  // description rather than a review/comment/check run — the gap this fix
  // closes. cursor[bot] is satisfied via its review; codex only via the
  // reaction.
  await withGhStub("codex_reaction_ok", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: All reviewers posted/);
  });
});

test("pre-merge check rejects a codex reaction left before the current head commit", async () => {
  // A +1 on an earlier revision must not satisfy the reviewer once a newer
  // commit is pushed — the reaction predates the head commit's committer date.
  await withGhStub("codex_reaction_stale", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check does not count reactions when the head commit date is unknown", async () => {
  // Fail closed: without the head commit date there is no way to prove a
  // reaction is fresh, so even a positive codex reaction must not sign off.
  await withGhStub("reaction_head_date_missing", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Head commit date unknown/);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check ignores negative codex reactions (confused/-1) as sign-off", async () => {
  await withGhStub("codex_reaction_negative", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check never credits a reviewer for another user's positive reaction", async () => {
  await withGhStub("reaction_wrong_user", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});

test("pre-merge check degrades gracefully when reactions cannot be read", async () => {
  // A reactions-endpoint failure is non-fatal: the gate falls back to the
  // other detection paths (here codex is otherwise absent, so it still blocks
  // — but on a missing-reviewer verdict, not an API-read crash).
  await withGhStub("reactions_read_fail", async (env) => {
    const result = runPreMergeCheck(env);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Could not read PR body reactions/);
    assert.match(result.stdout, /Missing reviews from: chatgpt-codex-connector\[bot\]/);
  });
});
