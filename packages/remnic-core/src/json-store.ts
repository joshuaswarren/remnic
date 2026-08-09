import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function listJsonFilesStrictInner(dir: string, allowMissingDirectory: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (allowMissingDirectory && hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsonFilesStrictInner(fullPath, false)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(fullPath);
    }
  }
  return out.sort();
}

export async function listJsonFilesStrict(
  dir: string,
  options: { allowMissingDirectory?: boolean } = {}
): Promise<string[]> {
  return listJsonFilesStrictInner(dir, options.allowMissingDirectory === true);
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return await listJsonFilesStrict(dir);
  } catch {
    return [];
  }
}

export async function listNamedFiles(dir: string, fileName: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await listNamedFiles(fullPath, fileName)));
      } else if (entry.isFile() && entry.name === fileName) {
        out.push(fullPath);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

const jsonStoreMutationTails = new Map<string, Promise<void>>();

const JSON_STORE_LOCK_RETRY_MS = 25;
const JSON_STORE_LOCK_STALE_MS = 60_000;
const JSON_STORE_LOCK_TIMEOUT_MS = 10_000;

function waitForJsonStoreLock(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, JSON_STORE_LOCK_RETRY_MS);
  return promise;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function removeStaleJsonStoreLock(lockPath: string): Promise<void> {
  const lockStat = await lstat(lockPath);
  if (!lockStat.isFile()) {
    throw new Error(`JSON store mutation lock is not a regular file: ${lockPath}`);
  }
  if (Date.now() - lockStat.mtimeMs <= JSON_STORE_LOCK_STALE_MS) return;
  let ownerPid: number | undefined;
  try {
    const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    ownerPid = typeof metadata.pid === "number" && Number.isInteger(metadata.pid) ? metadata.pid : undefined;
  } catch {
    ownerPid = undefined;
  }
  if (ownerPid !== undefined && processIsRunning(ownerPid)) return;
  await unlink(lockPath).catch((error) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

async function acquireJsonStoreMutationFileLock(key: string): Promise<() => Promise<void>> {
  const lockPath = `${path.resolve(key)}.mutation.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + JSON_STORE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      } finally {
        await handle.close();
      }
      const heartbeat = setInterval(() => {
        void readFile(lockPath, "utf8")
          .then((content) => {
            const metadata = JSON.parse(content) as { token?: unknown };
            if (metadata.token !== token) return;
            const now = new Date();
            return utimes(lockPath, now, now);
          })
          .catch(() => undefined);
      }, JSON_STORE_LOCK_STALE_MS / 3);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        try {
          const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
          if (metadata.token === token) await unlink(lockPath);
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) throw error;
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await removeStaleJsonStoreLock(lockPath).catch((staleError) => {
        if (!hasErrorCode(staleError, "ENOENT")) throw staleError;
      });
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring JSON store mutation lock: ${lockPath}`);
      }
      await waitForJsonStoreLock();
    }
  }
}

export async function withJsonStoreMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = jsonStoreMutationTails.get(key) ?? Promise.resolve();
  const { promise: current, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.catch(() => undefined).then(() => current);
  jsonStoreMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireJsonStoreMutationFileLock(key);
    return await operation();
  } finally {
    try {
      await releaseFileLock?.();
    } finally {
      release();
      if (jsonStoreMutationTails.get(key) === tail) {
        jsonStoreMutationTails.delete(key);
      }
    }
  }
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
