import process from "node:process";

/**
 * Env for `git` invocations that create or mutate throwaway fixture repos
 * (issue #3627). Fixture commits must not inherit the host's system/global
 * git config: a `core.hooksPath` pre-commit hook (identity guards), a global
 * `commit.gpgsign`, aliases, or `url.*.insteadOf` rewrites all turn a fixture
 * `git commit`/`git init` into an environmental flake that has nothing to do
 * with the code under test.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` discard ambient file
 * config for the child only — every fixture already supplies its own identity
 * via `-c` flags or repo-local `git config`. Command-line `-c` and explicit
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env pairs still
 * win, so tests that intentionally set config keep working.
 *
 * `extra` is merged first and the two overrides are applied last, so callers
 * cannot accidentally re-enable ambient config.
 */
export function fixtureGitEnv(extra = {}) {
  return { ...process.env, ...extra, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
