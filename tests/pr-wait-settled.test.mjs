import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "pr-wait-settled.sh");
const headSha = "deadbeef1234567890abcdef1234567890abcdef";

async function withGhStub(scenario, fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-wait-"));
  const binDir = path.join(tmp, "bin");
  const countPath = path.join(tmp, "count");
  await mkdir(binDir);
  await writeFile(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$GH_STUB_COUNT" 2>/dev/null || echo 0)"
count=$((count + 1))
printf '%s\\n' "$count" > "$GH_STUB_COUNT"

if [[ "$1 $2" == "pr view" ]]; then
  if [[ "$*" == *"author,files"* ]]; then
    printf '{"author":{"login":"someone"},"files":[{"path":"src/main.ts"}]}\\n'
  else
    printf '%s\\n' '${headSha}'
  fi
  exit 0
fi
if [[ "$1 $2" == "pr checks" ]]; then
  case "$GH_STUB_SCENARIO" in
    pending-check)
      printf '[{"name":"ci","state":"PENDING"},{"name":"ai-reviewers","state":"SUCCESS"}]\\n'
      exit 8
      ;;
    superseded-neutral) printf '[{"name":"ci","state":"SUCCESS"},{"name":"ai-reviewers","state":"CANCELLED"},{"name":"ai-reviewers","state":"NEUTRAL"}]\\n' ;;
    *) printf '[{"name":"ci","state":"SUCCESS"},{"name":"ai-reviewers","state":"NEUTRAL"}]\\n' ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  printf '2\\t%s\\tfalse\\t\\n' "$([[ "$GH_STUB_SCENARIO" == unresolved-thread || "$GH_STUB_SCENARIO" == rate-limited-unresolved ]] && echo 1 || echo 0)"
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/pulls/7/reviews" ]]; then
  case "$GH_STUB_SCENARIO" in
    green|superseded-neutral|codex-reaction)
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      if [[ "$GH_STUB_SCENARIO" != codex-reaction ]]; then
        printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      fi
      ;;
    rate-limited-review|rate-limited-unresolved)
      printf 'cursor[bot]\\t%s\\tCOMMENTED\\tReview rate limited\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    empty-body-review)
      printf 'cursor[bot]\\t%s\\tCOMMENTED\\t\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    missing-bot)
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    pending-review)
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    negative-review)
      printf 'cursor[bot]\\t%s\\tCHANGES_REQUESTED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    dismissed-review)
      printf 'cursor[bot]\\t%s\\tDISMISSED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    neutral-then-approved)
      printf 'cursor[bot]\\t%s\\tCOMMENTED\\tReview rate limited\\n' '${headSha}'
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/pulls/7/comments" ]]; then
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/commits/${headSha}/check-suites" ]]; then
  if [[ "$GH_STUB_SCENARIO" == codex-reaction ]]; then
    printf '2026-06-01T00:00:00Z\\n'
  fi
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/issues/7/reactions" ]]; then
  if [[ "$GH_STUB_SCENARIO" == codex-reaction ]]; then
    printf 'chatgpt-codex-connector[bot]\\t+1\\t2026-06-02T00:00:00Z\\n'
  fi
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/issues/7/comments" ]]; then
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/commits/${headSha}/check-runs" ]]; then
  if [[ "$GH_STUB_SCENARIO" == skipped-reviewer ]]; then
    printf 'Cursor Bugbot\\tcursor\\tcompleted\\tskipped\\t%s\\n' '${headSha}'
  fi
  exit 0
fi
exit 2
`
  );
  await chmod(path.join(binDir, "gh"), 0o755);
  const env = {
    ...process.env,
    GH_STUB_COUNT: countPath,
    GH_STUB_SCENARIO: scenario,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    REMNIC_REPO: "example/repo",
  };
  try {
    await fn(env);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function runWait(env, args) {
  return spawnSync("bash", [scriptPath, "7", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

test("wait settles a fully reviewed PR", async () => {
  await withGhStub("green", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0", "--json"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.head, headSha);
    assert.deepEqual(summary.outstanding, []);
  });
});
test("wait treats a rate-limited review as terminal neutral", async () => {
  await withGhStub("rate-limited-review", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Review rate limited/);
  });
});
test("wait prints neutral evidence in settled JSON mode", async () => {
  await withGhStub("rate-limited-review", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0", "--json"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    JSON.parse(result.stdout);
    assert.match(result.stderr, /Review rate limited/);
  });
});

test("wait clears neutral evidence after a later approval", async () => {
  await withGhStub("neutral-then-approved", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /reviewer neutral/i);
  });
});

test("wait treats an empty-body review as terminal neutral", async () => {
  await withGhStub("empty-body-review", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /empty review body/);
  });
});

test("wait downgrades a pending reviewer after reviewer timeout", async () => {
  await withGhStub("pending-review", async (env) => {
    const result = runWait(env, [
      "--timeout",
      "0",
      "--reviewer-timeout",
      "0",
      "--interval",
      "0",
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /reviewer timeout/i);
    assert.match(result.stdout, /warning/i);
  });
});
test("wait keeps an explicit negative reviewer verdict blocking", async () => {
  await withGhStub("negative-review", async (env) => {
    const result = runWait(env, [
      "--timeout",
      "0",
      "--reviewer-timeout",
      "0",
      "--interval",
      "0",
      "--json",
    ]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /CHANGES_REQUESTED/);
  });
});
test("wait keeps a dismissed reviewer verdict blocking", async () => {
  await withGhStub("dismissed-review", async (env) => {
    const result = runWait(env, [
      "--timeout",
      "0",
      "--reviewer-timeout",
      "0",
      "--interval",
      "0",
      "--json",
    ]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /DISMISSED/);
  });
});

test("wait keeps timeout JSON valid while printing neutral evidence", async () => {
  await withGhStub("rate-limited-unresolved", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0"]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /thread/i);
    assert.match(result.stderr, /Review rate limited/);
  });
});

test("wait keeps a pending reviewer without reviewer-timeout", async () => {
  await withGhStub("pending-review", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--interval", "0", "--json"]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /codex/i);
  });
});

test("wait reports a pending check after the timeout", async () => {
  await withGhStub("pending-check", async (env) => {
    const result = runWait(env, ["--timeout", "0.1", "--interval", "0.05"]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /ci/);
  });
});

test("wait reports a reviewer missing on the current head", async () => {
  await withGhStub("missing-bot", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /coderabbit|codex/i);
  });
});

test("wait reports unresolved review threads", async () => {
  await withGhStub("unresolved-thread", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /thread/i);
  });
});

test("wait accepts a superseded neutral ai-reviewers check", async () => {
  await withGhStub("superseded-neutral", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("wait accepts a fresh Codex positive reaction", async () => {
  await withGhStub("codex-reaction", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("wait does not count a skipped reviewer check", async () => {
  await withGhStub("skipped-reviewer", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /cursor-bugbot/);
  });
});
