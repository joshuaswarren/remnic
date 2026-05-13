import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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

export function ensurePackageBuild(repoRoot, pkgName, distPath, sourcePaths) {
  if (
    fs.existsSync(distPath) &&
    !isAnySourceNewerThan(sourcePaths, distPath)
  ) {
    return;
  }

  runPnpm(repoRoot, ["--filter", pkgName, "build"]);
}

export function isAnySourceNewerThan(sourcePaths, distPath) {
  const distMtimeMs = fs.statSync(distPath).mtimeMs;
  const newestSource = newestMtime(sourcePaths);
  return newestSource !== undefined && newestSource > distMtimeMs + 1000;
}

function newestMtime(paths) {
  let newest;
  const visit = (entryPath) => {
    if (!fs.existsSync(entryPath)) {
      return;
    }
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (stat.isFile()) {
      newest = newest === undefined ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
    }
  };
  for (const sourcePath of paths) {
    visit(sourcePath);
  }
  return newest;
}
