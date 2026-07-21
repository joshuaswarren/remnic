import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared temp-dir lifecycle for tests (#2083). Replaces the copy-pasted local
 * `withTempDir`/`makeTempDir` helpers with one cleaning source of truth, so
 * tests are self-cleaning rather than relying solely on the run-level TMPDIR
 * sandbox.
 *
 * `makeTempDir` / `makeTempDirSync` register the created directory for cleanup
 * via a single file-scoped `after()` hook (registered at import time, before
 * any test runs), so a bare `const dir = await makeTempDir()` call site needs
 * no per-test teardown wiring. `withTempDir` scopes the directory to a callback
 * and removes it in `finally`.
 */
const pendingCleanup = new Set();

// Registered at module load — importing this module from a test file installs
// one file-scoped after-all hook that removes every managed temp dir. Doing it
// here (not lazily inside a test) guarantees the hook binds to the file root
// rather than whichever test happened to allocate the first dir.
after(async () => {
  const dirs = [...pendingCleanup];
  pendingCleanup.clear();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

/** Create a temp dir that is removed automatically after the file's tests. */
export async function makeTempDir(prefix = "remnic-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  pendingCleanup.add(dir);
  return dir;
}

/** Synchronous {@link makeTempDir}. */
export function makeTempDirSync(prefix = "remnic-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pendingCleanup.add(dir);
  return dir;
}

/** Run `fn` with a fresh temp dir, removing it in `finally`. */
export async function withTempDir(fn, prefix = "remnic-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Synchronous {@link withTempDir}. */
export function withTempDirSync(fn, prefix = "remnic-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
