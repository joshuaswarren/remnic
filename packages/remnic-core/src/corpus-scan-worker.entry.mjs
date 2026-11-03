// GENERATED FILE — do not edit.
// Source: packages/remnic-core/src/corpus-scan-worker.entry.ts
// Regenerate: npm run sync:corpus-scan-worker


// packages/remnic-core/src/corpus-scan-worker.entry.ts
import { parentPort } from "node:worker_threads";

// packages/remnic-core/src/abort-error.ts
function abortError(message) {
  const err = new Error(message);
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

// packages/remnic-core/src/corpus-scan.ts
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

// packages/remnic-core/src/utils/errno.ts
function isErrnoCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// packages/remnic-core/src/utils/macos-replication-junk.ts
function isMacOsReplicationJunkBasename(basename) {
  return basename === ".DS_Store" || basename.startsWith("._");
}

// packages/remnic-core/src/corpus-scan.ts
function isPropagatableReadError(error) {
  return error.code !== void 0 && error.code !== "ENOENT";
}
async function collectContainedMarkdownPaths(options) {
  const { baseDir, startDirs, propagateReadErrors = false, checkCancelled } = options;
  const filePaths = [];
  try {
    await realpath(baseDir);
  } catch (error) {
    const failure = error;
    if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
    return filePaths;
  }
  const collectPaths = async (dir) => {
    checkCancelled?.();
    let dirStat;
    try {
      dirStat = await lstat(dir);
    } catch (error) {
      const failure = error;
      if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
      return;
    }
    if (dirStat.isSymbolicLink()) return;
    if (!dirStat.isDirectory()) {
      if (propagateReadErrors) {
        throw new Error(`corpus scan: expected a directory but found a non-directory at ${dir}`);
      }
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const failure = error;
      if (propagateReadErrors && isPropagatableReadError(failure)) throw error;
      return;
    }
    const subdirs = [];
    for (const entry of entries) {
      checkCancelled?.();
      if (entry.isSymbolicLink()) continue;
      if (isMacOsReplicationJunkBasename(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.name.endsWith(".md")) {
        filePaths.push(fullPath);
      }
    }
    for (const subdir of subdirs) {
      await collectPaths(subdir);
    }
  };
  for (const dir of startDirs) {
    await collectPaths(dir);
  }
  checkCancelled?.();
  return filePaths;
}
async function fingerprintEntityEntries(entitiesDir) {
  let names;
  try {
    names = (await readdir(entitiesDir)).filter((name) => path.extname(name) === ".md" && !isMacOsReplicationJunkBasename(name)).sort();
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return "missing";
    throw error;
  }
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(`${name.length}:${name}:`);
    try {
      const entry = await lstat(path.join(entitiesDir, name), { bigint: true });
      hash.update(`${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
      hash.update("missing");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}
async function statMtimes(paths) {
  const results = new Array(paths.length).fill(null);
  await Promise.all(paths.map(async (filePath, index) => {
    try {
      const entry = await stat(filePath);
      results[index] = entry.mtimeMs;
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
  }));
  return results;
}

// packages/remnic-core/src/corpus-scan-worker.entry.ts
if (!parentPort) throw new Error("corpus scan worker must run as a worker thread");
var port = parentPort;
var cancelled = /* @__PURE__ */ new Set();
function serializeError(error) {
  const payload = {
    name: error.name,
    message: error instanceof Error ? error.message : String(error)
  };
  if (error.code !== void 0) payload.code = error.code;
  return payload;
}
async function runJob(id, payload) {
  const checkCancelled = () => {
    if (cancelled.has(id)) throw abortError("corpus read aborted");
  };
  switch (payload.kind) {
    case "walk":
      return await collectContainedMarkdownPaths({
        baseDir: payload.baseDir,
        startDirs: payload.startDirs,
        propagateReadErrors: payload.propagateReadErrors,
        checkCancelled
      });
    case "entity-entries-fingerprint":
      return await fingerprintEntityEntries(payload.entitiesDir);
    case "stat-mtimes":
      return await statMtimes(payload.paths);
  }
}
port.on("message", (message) => {
  if (message.cancel) {
    cancelled.add(message.id);
    return;
  }
  const { id } = message;
  const payload = message.payload;
  if (!payload) return;
  void runJob(id, payload).then((result) => {
    port.postMessage({ id, ok: true, result });
  }).catch((error) => {
    port.postMessage({ id, ok: false, error: serializeError(error) });
  }).finally(() => {
    cancelled.delete(id);
  });
});
