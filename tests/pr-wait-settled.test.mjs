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
  printf '%s\\n' '${headSha}'
  exit 0
fi
if [[ "$1 $2" == "pr checks" ]]; then
  case "$GH_STUB_SCENARIO" in
    pending-check)
      printf '[{"name":"ci","state":"PENDING"},{"name":"ai-reviewers","state":"SUCCESS"}]\\n'
      exit 8
      ;;
    *) printf '[{"name":"ci","state":"SUCCESS"},{"name":"ai-reviewers","state":"NEUTRAL"}]\\n' ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  printf '2\\t%s\\tfalse\\t\\n' "$([[ "$GH_STUB_SCENARIO" == unresolved-thread ]] && echo 1 || echo 0)"
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/pulls/7/reviews" ]]; then
  case "$GH_STUB_SCENARIO" in
    green|superseded-neutral)
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'coderabbitai[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      printf 'chatgpt-codex-connector[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
    missing-bot)
      printf 'cursor[bot]\\t%s\\tAPPROVED\\n' '${headSha}'
      ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/pulls/7/comments" ]]; then
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/issues/7/comments" ]]; then
  if [[ "$GH_STUB_SCENARIO" == round-ledger ]]; then
    printf 'github-actions[bot]\\t<!-- remnic-review-round:v1 {\"headSha\":\"${headSha}\",\"status\":\"closed\",\"closeReason\":\"round-complete\"} -->\\n'
  fi
  exit 0
fi
if [[ "$1 $2" == "api repos/example/repo/commits/${headSha}/check-runs" ]]; then
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
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
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.head, headSha);
    assert.deepEqual(summary.outstanding, []);
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

test("wait accepts a completed current-head round ledger", async () => {
  await withGhStub("round-ledger", async (env) => {
    const result = runWait(env, ["--timeout", "0", "--json"]);
    assert.equal(result.status, 0, result.stderr);
  });
});
