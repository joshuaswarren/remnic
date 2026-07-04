/**
 * Capability probes for environment-dependent AMB tests (issue #1541, epic #1520).
 *
 * The pattern extends #1538 (better-sqlite3): a probe decides whether the host
 * environment can satisfy a test's external dependency, and a matching
 * `skipUnless*` helper returns either `false` (run it) or a human-readable
 * string suitable for node:test's `skip` option (skip with reason).
 *
 * Two probe kinds live here today:
 *
 * 1. commandAvailable — checks PATH for a binary the test (or a runner script
 *    the test invokes) needs at runtime. Use this for tests whose failure mode
 *    is "missing tool, exit 127", never for tests whose runner has a PATH bug.
 *    Pitfall #1 from #1541: a 127 may signal a real script bug, not a missing
 *    capability. Investigate before adding a probe.
 *
 * 2. cleanWorkingTreeProbe — runs `git status --porcelain` against the
 *    repository root the test was loaded from. The SOTA verifier test pins
 *    published benchmark provenance; that is a CI/release concern, not a
 *    local-dev concern (the issue: any uncommitted change breaks the run, so
 *    a local pre-commit loop can never go green). Locally: skip with reason.
 *    In CI: skip-with-reason becomes a failure — the manifest under
 *    scripts/native-dependent-tests.json plus the REMNIC_REQUIRE_CAPABILITY_TESTS=1
 *    convention make the SOTA suite hard-required when the host can satisfy it.
 *
 * Force seams (test-only):
 *   REMNIC_FORCE_COMMAND_UNAVAILABLE=1           → every commandAvailable() returns { ok: false }
 *   REMNIC_FORCE_DIRTY_WORKING_TREE=1            → cleanWorkingTreeProbe returns { ok: false }
 *
 * CI convention (wired in .github/workflows/ci.yml):
 *   REMNIC_REQUIRE_CAPABILITY_TESTS=1            → skipUnless*() throws instead of returning a skip string
 *
 * Probes cache within a process. That is fine for node:test, which runs each
 * file in a fresh process; cross-file caching only matters inside a single
 * file, where it avoids redundant fork/exec overhead.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const commandCache = new Map();
let dirtyTreeCached = null;

/**
 * Probe whether `tool` is on PATH and executable.
 * Resolved via the platform PATH separator; we do not consult /usr/bin/env
 * explicitly because spawnSync with shell=false already does the right thing
 * for `bash -lc` style runners on POSIX. On win32 the colon rule does not
 * apply; tests run on POSIX CI hosts (see scripts/run-root-tests.mjs), so we
 * keep this scoped to POSIX path lookup.
 *
 * @param {string} tool
 * @returns {{ ok: boolean, reason?: string }}
 */
export function commandAvailable(tool) {
  if (typeof tool !== "string" || tool.length === 0) {
    throw new TypeError("commandAvailable(tool) requires a non-empty string");
  }
  if (process.env.REMNIC_FORCE_COMMAND_UNAVAILABLE === "1") {
    return { ok: false, reason: "forced unavailable via REMNIC_FORCE_COMMAND_UNAVAILABLE" };
  }
  if (commandCache.has(tool)) return /** @type {{ok: boolean, reason?: string}} */ (commandCache.get(tool));
  // Mirror the existing AMB integrations probe (`integrations/amb/check-remnic-run.mjs`,
  // `integrations/amb/install-remnic-provider.test.mjs`) — invoke `command -v` via
  // `sh -c` so shell builtins are honored on hosts where `command` is not on
  // PATH (Linux CI). `command` is a bash/zsh builtin; `spawnSync("command", …)`
  // with `shell: false` returns ENOENT there.
  const probe = spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  let result;
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    result = { ok: true };
  } else {
    result = { ok: false, reason: `${tool} not found on PATH` };
  }
  commandCache.set(tool, result);
  return result;
}

/**
 * node:test `skip` value for commandAvailable: false when the tool is
 * available, otherwise a human-readable reason that includes the install
 * hint (caller-supplied — we do not try to guess).
 *
 * @param {string} tool
 * @param {string} [installHint]
 * @returns {false | string}
 */
export function skipUnlessCommand(tool, installHint) {
  const probe = commandAvailable(tool);
  if (probe.ok) return false;
  if (process.env.REMNIC_REQUIRE_CAPABILITY_TESTS === "1") {
    throw new Error(
      `Refusing to skip: REMNIC_REQUIRE_CAPABILITY_TESTS=1 forbids skipping capability tests ` +
        `(${probe.reason}). ${installHint ?? ""}`.trim(),
    );
  }
  const hint = installHint && installHint.length > 0 ? ` — ${installHint}` : "";
  return `${tool} unavailable (${probe.reason})${hint}`;
}

/**
 * Probe whether the repository root the helper was loaded from has a clean
 * working tree. We do not require a clean index vs. a clean working tree
 * separately — `git status --porcelain` reports both, which is what the SOTA
 * verifier (scripts/bench/verify-amb-sota.mjs) consumes.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function cleanWorkingTreeProbe() {
  if (dirtyTreeCached !== null) return dirtyTreeCached;
  if (process.env.REMNIC_FORCE_DIRTY_WORKING_TREE === "1") {
    dirtyTreeCached = { ok: false, reason: "forced dirty via REMNIC_FORCE_DIRTY_WORKING_TREE" };
    return dirtyTreeCached;
  }
  // Match `scripts/bench/verify-amb-sota.mjs:gitStatusEntries` exactly —
  // `--porcelain=v1 --untracked-files=all` — so the skip-with-reason guard
  // agrees with the verifier on what "dirty" means. Without `--untracked-files=all`,
  // a host with `status.showUntrackedFiles=no` would skip-with-reason locally
  // while the verifier still rejects provenance.
  const probe = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.status !== 0) {
    const message = probe.stderr ? probe.stderr.split("\n")[0].trim() : `git exited ${probe.status}`;
    dirtyTreeCached = { ok: false, reason: `git status failed: ${message}` };
    return dirtyTreeCached;
  }
  const dirty = probe.stdout.trim().length > 0;
  if (dirty) {
    const sample = probe.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 3)
      .join(", ");
    dirtyTreeCached = { ok: false, reason: `working tree is dirty (${sample})` };
    return dirtyTreeCached;
  }
  dirtyTreeCached = { ok: true };
  return dirtyTreeCached;
}

/**
 * node:test `skip` value for the working-tree probe. Locally the probe
 * downgrades to a counted skip; in CI (REMNIC_REQUIRE_CAPABILITY_TESTS=1)
 * a dirty tree is a hard failure because published SOTA numbers pin provenance.
 *
 * @returns {false | string}
 */
export function skipUnlessCleanWorkingTree() {
  const probe = cleanWorkingTreeProbe();
  if (probe.ok) return false;
  if (process.env.REMNIC_REQUIRE_CAPABILITY_TESTS === "1") {
    throw new Error(
      `Refusing to skip: REMNIC_REQUIRE_CAPABILITY_TESTS=1 forbids skipping SOTA provenance tests ` +
        `(${probe.reason}). Commit or stash changes before running.`,
    );
  }
  return `Remnic checkout is dirty (${probe.reason}); SOTA verifier pins provenance for published numbers, ` +
    `a CI/release concern — set REMNIC_REQUIRE_CAPABILITY_TESTS=1 to fail instead of skipping.`;
}