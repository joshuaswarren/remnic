import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fixtureGitEnv } from "./helpers/fixture-git.mjs";

/**
 * Fixture repos must not inherit the host's global git config (issue #3627).
 * A machine-wide `core.hooksPath` identity guard — or global gpgsign,
 * aliases, url rewrites — turns fixture `git commit` calls into
 * environmental flakes. `fixtureGitEnv` discards ambient file config for the
 * child only.
 */

function hostileGlobalConfig(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-git-env-"));
  t.after(() => {
    // best-effort; rm may race other fixture tests under load
    try {
      spawnSync("rm", ["-rf", root]);
    } catch {}
  });
  const hooksDir = path.join(root, "hooks");
  mkdirSync(hooksDir);
  const preCommit = path.join(hooksDir, "pre-commit");
  writeFileSync(preCommit, "#!/bin/sh\necho 'identity guard: rejected' >&2\nexit 1\n");
  chmodSync(preCommit, 0o755);
  const config = path.join(root, "gitconfig");
  writeFileSync(config, `[core]\n\thooksPath = ${hooksDir}\n`);
  return config;
}

function initAndCommit(env) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "fixture-git-repo-"));
  const init = spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8", env });
  if (init.status !== 0) return init;
  return spawnSync(
    "git",
    ["-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "fixture"],
    { encoding: "utf8", env },
  );
}

test("fixtureGitEnv shields fixture commits from a hostile global hooksPath", (t) => {
  const hostile = hostileGlobalConfig(t);

  // The poison is real: without the helper env the same commit dies in the
  // global pre-commit hook. If this ever passes, the fixture below proves
  // nothing — fail the test instead of asserting a vacuous green.
  const poisoned = initAndCommit({ ...process.env, GIT_CONFIG_GLOBAL: hostile });
  assert.notEqual(poisoned.status, 0, "hostile global hooksPath did not fire; fixture assertion would be vacuous");

  const shielded = initAndCommit(fixtureGitEnv({ GIT_CONFIG_GLOBAL: hostile }));
  assert.equal(shielded.status, 0, `fixture commit blocked by ambient config: ${shielded.stderr}`);
});

test("fixtureGitEnv still honors caller GIT_CONFIG_KEY_n pairs", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-git-envkey-"));
  t.after(() => {
    try {
      spawnSync("rm", ["-rf", root]);
    } catch {}
  });
  const hooksDir = path.join(root, "hooks");
  mkdirSync(hooksDir);
  const preCommit = path.join(hooksDir, "pre-commit");
  writeFileSync(preCommit, "#!/bin/sh\nexit 1\n");
  chmodSync(preCommit, 0o755);

  // Tests that intentionally configure hooks (dev-worktree's post-checkout
  // fixture) rely on env config pairs outranking every file — including the
  // /dev/null global the helper selects.
  const result = initAndCommit(
    fixtureGitEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooksDir,
    }),
  );
  assert.notEqual(result.status, 0, "caller-supplied hooksPath via GIT_CONFIG_KEY_n was overridden");
});
