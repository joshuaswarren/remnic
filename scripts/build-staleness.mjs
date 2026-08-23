import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const FINGERPRINT_VERSION = 1;
const LOCK_POLL_INTERVAL_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export function runPnpm(repoRoot, args) {
  const result = spawnSync(pnpmCmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}
export function ensurePackageBuild(repoRoot, pkgName, distPath, sourcePaths, options = {}) {
  withBuildLock(repoRoot, pkgName, () => {
    if (fs.existsSync(distPath) && recordedFingerprintMatches(repoRoot, sourcePaths, distPath)) {
      return;
    }
    // Snapshot before building: an edit landing mid-build changes the tree,
    // so the recorded fingerprint no longer matches and the next run rebuilds.
    const fingerprint = computeSourceFingerprint(repoRoot, sourcePaths);
    if (options.runBuild) {
      options.runBuild();
    } else {
      runPnpm(repoRoot, ["--filter", pkgName, "build"]);
    }
    writeFingerprintSidecar(distPath, fingerprint);
  });
}

function fingerprintSidecarPath(distPath) {
  return `${distPath}.source-fingerprint.json`;
}

function recordedFingerprintMatches(repoRoot, sourcePaths, distPath) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(fingerprintSidecarPath(distPath), "utf8"));
  } catch {
    return false;
  }
  if (recorded?.version !== FINGERPRINT_VERSION || typeof recorded.fingerprint !== "string") {
    return false;
  }
  const current = computeSourceFingerprint(repoRoot, sourcePaths);
  return current !== null && current === recorded.fingerprint;
}

// Deterministic sha256 over repo-relative paths and file contents. Symlinks
// are not followed, matching the walk the old mtime check used. Returns null
// when any source file cannot be read; callers treat that as stale.
export function computeSourceFingerprint(repoRoot, sourcePaths) {
  const entries = [];
  const visit = (entryPath) => {
    if (!fs.existsSync(entryPath)) {
      return;
    }
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (stat.isFile()) {
      entries.push([path.relative(repoRoot, entryPath), hashFileContents(entryPath)]);
    }
  };
  for (const sourcePath of sourcePaths) {
    visit(sourcePath);
  }
  if (entries.some(([, fileHash]) => fileHash === null)) {
    return null;
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const combined = crypto.createHash("sha256");
  for (const [relPath, fileHash] of entries) {
    combined.update(relPath);
    combined.update("\0");
    combined.update(fileHash);
    combined.update("\n");
  }
  return combined.digest("hex");
}

function hashFileContents(entryPath) {
  let contents;
  try {
    contents = fs.readFileSync(entryPath);
  } catch {
    return null;
  }
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function writeFingerprintSidecar(distPath, fingerprint) {
  if (fingerprint === null) {
    // Unreadable source: leave nothing recorded so the next run rebuilds.
    return;
  }
  const sidecarPath = fingerprintSidecarPath(distPath);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const tempPath = `${sidecarPath}.tmp-${process.pid}`;
  fs.writeFileSync(
    tempPath,
    `${JSON.stringify({ version: FINGERPRINT_VERSION, fingerprint }, null, 2)}\n`,
  );
  fs.renameSync(tempPath, sidecarPath);
}

// Cross-process lock so concurrent ensurePackageBuild calls for one package
// trigger at most one build: the waiter re-checks freshness under the lock and
// skips. A lock whose owning pid is dead is reclaimed.
// ponytail: on timeout we run the build without the lock — a duplicate build
// beats a stuck workflow; per-package finer locking if waiting ever matters.
function withBuildLock(repoRoot, pkgName, fn) {
  const lockRoot = path.join(repoRoot, "node_modules", ".cache", "remnic-build-locks");
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockDir = path.join(lockRoot, lockSlug(pkgName));
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    if (acquireLockDir(lockDir)) {
      try {
        return fn();
      } finally {
        releaseLockDir(lockDir);
      }
    }
    if (Date.now() >= deadline) {
      return fn();
    }
    sleepSync(LOCK_POLL_INTERVAL_MS);
  }
}

function lockSlug(pkgName) {
  return pkgName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "") || "pkg";
}

function lockTimeoutMs() {
  const raw = Number(process.env.REMNIC_BUILD_LOCK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LOCK_TIMEOUT_MS;
}

function acquireLockDir(lockDir) {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    if (isLockHeldByLiveProcess(lockDir)) {
      return false;
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    try {
      fs.mkdirSync(lockDir);
    } catch {
      return false; // Lost the reclaim race; retry.
    }
  }
  try {
    fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
  } catch {
    // Holding the directory is the lock; a missing pid file only disables
    // stale reclaim until the holder exits.
  }
  return true;
}

function isLockHeldByLiveProcess(lockDir) {
  let pidText;
  try {
    pidText = fs.readFileSync(path.join(lockDir, "pid"), "utf8");
  } catch {
    return true; // Cannot inspect: assume held.
  }
  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // EPERM: pid exists under another user.
  }
}

function releaseLockDir(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort; a leaked lock dir is reclaimed via its pid file.
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
