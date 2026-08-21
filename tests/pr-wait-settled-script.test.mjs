import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "pr-wait-settled.sh");

const headSha = "0123456789abcdef0123456789abcdef01234567";

function createBannerGh(checksOutput = "ci\\tSUCCESS\\n") {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-pr-wait-gh-"));
  const ghPath = path.join(root, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
printf '%s\\n' 'mise ~/.config/mise/config.toml tools: gh@2.97.0'
case "$*" in
  *'pr view'*'headRefOid'*) printf '%s\\n' '${headSha}' ;;
  *'pr view'*'author'*) printf '%s\\n' 'false' ;;
  *'pr checks'*)
    if [[ '${checksOutput}' == '__GH_NO_CHECKS_ERROR__' ]]; then
      printf '%s\\n' 'no required checks reported on the main branch' >&2
      exit 1
    fi
    printf '%b' '${checksOutput}' ;;
  *'pulls/'*'/reviews'*)
    printf 'cursor\\t${headSha}\\tAPPROVED\\t\\n'
    printf 'coderabbitai\\t${headSha}\\tAPPROVED\\t\\n'
    printf 'chatgpt-codex-connector\\t${headSha}\\tAPPROVED\\t\\n'
    ;;
  *'check-suites'*) printf '%s\\n' '2026-08-16T00:00:00Z' ;;
  *'api graphql'*) printf '0\\t0\\tfalse\\t\\n' ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);
  return { root, ghPath };
}

test("handles mise banner output from gh before structured results", () => {
  const { root, ghPath } = createBannerGh();
  try {
    const result = spawnSync("bash", [scriptPath, "123", "--timeout", "5", "--interval", "0", "--json"], {
      env: { ...process.env, REMNIC_GH_BIN: ghPath },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "settled",
      head: headSha,
      outstanding: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settles when gh reports no required checks", () => {
  const { root, ghPath } = createBannerGh("__GH_NO_CHECKS_ERROR__");
  try {
    const result = spawnSync("bash", [scriptPath, "123", "--timeout", "5", "--interval", "0", "--json"], {
      env: { ...process.env, REMNIC_GH_BIN: ghPath },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "settled",
      head: headSha,
      outstanding: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps required checks whose names resemble banner or JSON lines", () => {
  const { root, ghPath } = createBannerGh("mise workspace tools: lint\\tPENDING\\n[check]\\tPENDING\\n");
  try {
    const result = spawnSync("bash", [scriptPath, "123", "--timeout", "0", "--interval", "0", "--json"], {
      env: { ...process.env, REMNIC_GH_BIN: ghPath },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.match(summary.outstanding.join(" "), /mise workspace tools: lint/);
    assert.match(summary.outstanding.join(" "), /\[check\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
