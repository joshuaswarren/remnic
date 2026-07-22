import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assertSafePrefix(prefix: string): void {
  if (/[\\/]/.test(prefix)) {
    throw new Error("Temporary directory prefix must not contain a path separator");
  }
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  assertSafePrefix(prefix);
  const dir = await mkdtemp(path.join(os.tmpdir(), `remnic-belief-ledger-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
