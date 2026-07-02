/**
 * Strong better-sqlite3 availability probe for test files (issue #1538).
 *
 * Importing the better-sqlite3 JS wrapper succeeds even when the native
 * binary is missing — only constructing a real database proves the binding
 * works. Individual tests that need sqlite (memory projection store, sqlite
 * import/export) use this to skip-with-reason instead of failing when the
 * binding is unavailable, so mixed suites keep their non-native coverage.
 *
 * Wholly native suites are excluded at the runner level instead — see
 * scripts/native-dependent-tests.json and scripts/run-root-tests.mjs.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

let cached = null;

/** @returns {{ ok: boolean, reason?: string }} */
export function betterSqlite3Probe() {
  if (cached !== null) return cached;
  if (process.env.REMNIC_FORCE_NATIVE_UNAVAILABLE === "1") {
    cached = { ok: false, reason: "forced unavailable via REMNIC_FORCE_NATIVE_UNAVAILABLE" };
    return cached;
  }
  try {
    const anchor = pathToFileURL(path.join(repoRoot, "packages", "remnic-core", "package.json"));
    const req = createRequire(anchor);
    const loaded = req("better-sqlite3");
    const Database = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof Database !== "function") {
      cached = { ok: false, reason: "module did not export a constructor" };
      return cached;
    }
    const db = new Database(":memory:");
    db.pragma("journal_mode = MEMORY");
    db.close();
    cached = { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cached = { ok: false, reason: message.split("\n")[0] };
  }
  return cached;
}

/**
 * node:test `skip` option value: false when the binding works, otherwise a
 * human-readable reason including the remediation command.
 */
export function skipUnlessBetterSqlite3() {
  const probe = betterSqlite3Probe();
  return probe.ok
    ? false
    : `better-sqlite3 native binding unavailable (${probe.reason}) — run: pnpm rebuild better-sqlite3`;
}
