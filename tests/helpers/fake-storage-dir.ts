import type { TestContext } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

/**
 * A real directory for a fake storage's `dir`. Fact captures commit inside the
 * per-dir fact-dedup window, which takes a lock file under `storage.dir`, so
 * the directory must exist. It is removed when the test ends.
 */
export async function makeStorageDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-fake-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
