import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared temp-dir lifecycle for `@remnic/core` tests (#2083). The single source
 * of truth within this package, so its tests are self-cleaning rather than
 * relying solely on the run-level TMPDIR sandbox (Tier 1).
 *
 * `makeTempDir` / `makeTempDirSync` register the created directory for cleanup
 * via a single file-scoped `after()` hook (registered at import time, before
 * any test runs), so a bare `const dir = await makeTempDir()` call site needs
 * no per-test teardown wiring. `withTempDir` scopes the directory to a callback
 * and removes it in `finally`.
 */
const pendingCleanup = new Set<string>();

// Registered at module load — importing this module from a test file installs
// one file-scoped after-all hook that removes every managed temp dir. Doing it
// here (not lazily inside a test) guarantees the hook binds to the file root
// rather than whichever test happened to allocate the first dir.
after(async () => {
  const dirs = [...pendingCleanup];
  pendingCleanup.clear();
  // Surface cleanup failures (do not swallow): a dir that cannot be removed is
  // a real signal. `force: true` already ignores a missing dir, so a rejection
  // here means an actual teardown problem and should fail the file loudly.
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Create a temp dir that is removed automatically after the file's tests. */
export async function makeTempDir(prefix = "remnic-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  pendingCleanup.add(dir);
  return dir;
}

/** Synchronous {@link makeTempDir}. */
export function makeTempDirSync(prefix = "remnic-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pendingCleanup.add(dir);
  return dir;
}

/** Run `fn` with a fresh temp dir, removing it in `finally`. */
export async function withTempDir<T>(
  fn: (dir: string) => T | Promise<T>,
  prefix = "remnic-test-",
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Synchronous {@link withTempDir}. */
export function withTempDirSync<T>(fn: (dir: string) => T, prefix = "remnic-test-"): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
