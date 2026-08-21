import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STALE_BUILD_TOLERANCE_MS = 1_000;

export interface BenchBuildFreshness {
  stale: boolean;
  reason?: string;
  sourcePath?: string;
  sourceMtimeMs?: number;
  distPath?: string;
  distMtimeMs?: number;
}

export function assertLocalBenchBuildFreshForDevelopment(
  currentModuleUrl: string,
): void {
  if (isTruthyEnv(process.env.REMNIC_BENCH_ALLOW_STALE_DIST)) {
    return;
  }

  const currentDir = path.dirname(fileURLToPath(currentModuleUrl));
  const benchPackageDir = path.resolve(currentDir, "../../bench");
  const freshness = checkBenchBuildFreshness(benchPackageDir);
  if (!freshness.stale) {
    return;
  }

  throw new Error(
    [
      "Local @remnic/bench build is stale; refusing to run benchmarks with outdated harness code.",
      freshness.reason,
      freshness.sourcePath && freshness.sourceMtimeMs !== undefined
        ? `Newest source: ${freshness.sourcePath} (${new Date(freshness.sourceMtimeMs).toISOString()})`
        : undefined,
      freshness.distPath && freshness.distMtimeMs !== undefined
        ? `Current build: ${freshness.distPath} (${new Date(freshness.distMtimeMs).toISOString()})`
        : undefined,
      "Run `pnpm --filter @remnic/bench build` before launching the benchmark.",
      "For diagnostics only, set REMNIC_BENCH_ALLOW_STALE_DIST=1 to bypass this guard.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
}

export function checkBenchBuildFreshness(
  benchPackageDir: string,
): BenchBuildFreshness {
  const packageJsonPath = path.join(benchPackageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { stale: false };
  }

  let packageName: unknown;
  try {
    packageName = JSON.parse(readFileSync(packageJsonPath, "utf8")).name;
  } catch {
    return { stale: false };
  }
  if (packageName !== "@remnic/bench") {
    return { stale: false };
  }

  const srcDir = path.join(benchPackageDir, "src");
  if (!isDirectory(srcDir)) {
    return { stale: false };
  }

  const sourceRoots = [
    srcDir,
    packageJsonPath,
    path.join(benchPackageDir, "tsup.config.ts"),
    path.join(benchPackageDir, "tsconfig.json"),
  ];
  const distPath = path.join(benchPackageDir, "dist", "index.js");
  if (!existsSync(distPath)) {
    return {
      stale: true,
      reason: `Missing build output: ${distPath}`,
      distPath,
    };
  }

  const newestSource = newestMtime(sourceRoots);
  if (!newestSource) {
    return { stale: false };
  }

  const distMtimeMs = statSync(distPath).mtimeMs;
  if (newestSource.mtimeMs > distMtimeMs + STALE_BUILD_TOLERANCE_MS) {
    return {
      stale: true,
      reason: "Source files are newer than packages/bench/dist/index.js.",
      sourcePath: newestSource.path,
      sourceMtimeMs: newestSource.mtimeMs,
      distPath,
      distMtimeMs,
    };
  }

  return {
    stale: false,
    sourcePath: newestSource.path,
    sourceMtimeMs: newestSource.mtimeMs,
    distPath,
    distMtimeMs,
  };
}

function newestMtime(
  roots: string[],
): { path: string; mtimeMs: number } | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  const visit = (entryPath: string): void => {
    if (!existsSync(entryPath)) {
      return;
    }
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (!stat.isFile()) {
      return;
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: entryPath, mtimeMs: stat.mtimeMs };
    }
  };

  for (const root of roots) {
    visit(root);
  }
  return newest;
}

function isDirectory(entryPath: string): boolean {
  try {
    return statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}
