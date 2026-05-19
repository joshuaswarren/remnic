import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMode, BenchmarkResult } from "./types.js";
import { loadBenchmarkResult, listBenchmarkResults } from "./results-store.js";
import { resolveBenchmarkRunId } from "./run-identity.js";

export const BENCHMARK_REPRO_MANIFEST_FILENAME = "MANIFEST.json";
export const BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION = 1;

export interface BenchmarkReproManifestFile {
  path: string;
  kind: "file" | "symlink";
  sizeBytes: number;
  sha256: string;
  target?: string;
}

export interface BenchmarkReproManifestDataset {
  benchmark: string;
  status: "not-provided" | "missing" | "hashed";
  path?: string;
  realpath?: string;
  fileCount: number;
  totalBytes: number;
  sha256?: string;
  files: BenchmarkReproManifestFile[];
}

export interface BenchmarkReproManifestResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  resultId: string;
  benchmark: string;
  mode: BenchmarkMode;
  gitSha: string;
  runCount: number;
  seeds: number[];
  taskCount: number;
  configHash: string;
}

export interface BenchmarkReproManifest {
  schemaVersion: number;
  generatedAt: string;
  run: {
    id: string;
    mode?: BenchmarkMode;
    selectedBenchmarks: string[];
    runtimeProfiles: string[];
    selectedWorkItems: Array<{
      benchmark: string;
      runtimeProfile: string;
    }>;
    limit?: number;
    seed?: number;
  };
  git: {
    commit: string;
    shortCommit: string;
    dirty: boolean;
    dirtyEntryCount: number;
  };
  command: {
    cwd: string;
    argv: string[];
    envKeys: string[];
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    hostname: string;
    packageManager?: string;
  };
  qmd?: {
    configDir?: string;
    cacheDir?: string;
    collections: string[];
  };
  configFiles: Array<{
    label: string;
    path: string;
    sha256?: string;
    sizeBytes?: number;
    missing?: boolean;
  }>;
  datasets: BenchmarkReproManifestDataset[];
  results: BenchmarkReproManifestResult[];
  artifactHash: string;
}

export interface BuildBenchmarkReproManifestOptions {
  resultPaths?: string[];
  runId?: string;
  selectedBenchmarks?: string[];
  runtimeProfiles?: string[];
  selectedWorkItems?: Array<{
    benchmark: string;
    runtimeProfile: string;
  }>;
  mode?: BenchmarkMode;
  limit?: number;
  seed?: number;
  datasetDirs?: Record<string, string | undefined>;
  command?: {
    cwd?: string;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    envKeys?: string[];
  };
  configFiles?: Array<{ label: string; path?: string }>;
  qmd?: {
    configDir?: string;
    cacheDir?: string;
    collections?: string[];
  };
}

const SECRET_ARG_FLAGS = new Set([
  "--api-key",
  "--system-api-key",
  "--judge-api-key",
  "--token",
  "--auth-token",
]);

const SECRET_KEY_PATTERN = /(^|[-_])(?:api[-_]?key|secret|password|authorization|credential|access[-_]?token|auth[-_]?token|refresh[-_]?token|id[-_]?token|token)$/i;

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sanitizeArgv(argv: string[]): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const isOptionFlag = arg.startsWith("-");
    const [flagName] = arg.split("=", 1);
    if (
      isOptionFlag &&
      (SECRET_ARG_FLAGS.has(flagName) || SECRET_KEY_PATTERN.test(flagName))
    ) {
      if (arg.includes("=")) {
        sanitized.push(`${flagName}=[redacted]`);
      } else {
        sanitized.push(arg);
        if (index + 1 < argv.length) {
          sanitized.push("[redacted]");
          index += 1;
        }
      }
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

function sanitizeEnvKeys(
  env: NodeJS.ProcessEnv | undefined,
  explicitKeys: string[] | undefined,
): string[] {
  const sourceKeys = explicitKeys ?? Object.keys(env ?? {});
  return [...new Set(sourceKeys)]
    .filter((key) => typeof key === "string" && key.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function buildGitInfo(cwd: string): BenchmarkReproManifest["git"] {
  const commit = gitOutput(["rev-parse", "HEAD"], cwd) || "unknown";
  const shortCommit = gitOutput(["rev-parse", "--short", "HEAD"], cwd) || "unknown";
  const dirtyEntries = gitOutput(["status", "--porcelain", "--untracked-files=all"], cwd)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return {
    commit,
    shortCommit,
    dirty: dirtyEntries.length > 0,
    dirtyEntryCount: dirtyEntries.length,
  };
}

function buildArtifactHashIdentity(manifest: Omit<BenchmarkReproManifest, "artifactHash">): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: manifest.run.id,
      ...(manifest.run.mode ? { mode: manifest.run.mode } : {}),
      selectedBenchmarks: manifest.run.selectedBenchmarks,
      runtimeProfiles: manifest.run.runtimeProfiles,
      selectedWorkItems: manifest.run.selectedWorkItems,
      ...(manifest.run.limit !== undefined ? { limit: manifest.run.limit } : {}),
      ...(manifest.run.seed !== undefined ? { seed: manifest.run.seed } : {}),
    },
    git: {
      commit: manifest.git.commit,
      shortCommit: manifest.git.shortCommit,
    },
    command: {
      argv: manifest.command.argv,
      envKeys: manifest.command.envKeys,
    },
    environment: {
      platform: manifest.environment.platform,
      arch: manifest.environment.arch,
      nodeVersion: manifest.environment.nodeVersion,
      ...(manifest.environment.packageManager
        ? { packageManager: manifest.environment.packageManager }
        : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
  };
}

async function scanDatasetFiles(root: string): Promise<BenchmarkReproManifestFile[]> {
  const files: BenchmarkReproManifestFile[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      if (entryStat.isSymbolicLink()) {
        const target = await readlink(entryPath);
        files.push({
          path: relativePath,
          kind: "symlink",
          sizeBytes: Buffer.byteLength(target, "utf8"),
          sha256: sha256String(target),
          target,
        });
        continue;
      }
      if (entryStat.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (entryStat.isFile()) {
        files.push({
          path: relativePath,
          kind: "file",
          sizeBytes: entryStat.size,
          sha256: await sha256File(entryPath),
        });
      }
    }
  };

  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function lstatPathWithoutSymlinkComponents(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const parsed = path.parse(targetPath);
  const relativePath = path.relative(parsed.root, targetPath);
  const parts = relativePath.length > 0 ? relativePath.split(path.sep) : [];
  let currentPath = parsed.root;
  let currentStat: Awaited<ReturnType<typeof lstat>> | undefined;

  try {
    if (parts.length === 0) {
      currentStat = await lstat(currentPath);
    }
    for (const part of parts) {
      currentPath = path.join(currentPath, part);
      currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }

  return currentStat;
}

async function buildDatasetManifest(
  benchmark: string,
  datasetDir: string | undefined,
): Promise<BenchmarkReproManifestDataset> {
  if (!datasetDir) {
    return {
      benchmark,
      status: "not-provided",
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  const datasetRoot = path.resolve(datasetDir);
  const datasetStat = await lstatPathWithoutSymlinkComponents(datasetRoot);
  if (!datasetStat) {
    return {
      benchmark,
      status: "missing",
      path: datasetDir,
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  if (!datasetStat.isDirectory()) {
    return {
      benchmark,
      status: "missing",
      path: datasetDir,
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  const realDatasetDir = await realpath(datasetRoot);
  const files = await scanDatasetFiles(realDatasetDir);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const digest = sha256String(stableStringify(files));
  return {
    benchmark,
    status: "hashed",
    path: datasetDir,
    realpath: realDatasetDir,
    fileCount: files.length,
    totalBytes,
    sha256: digest,
    files,
  };
}

async function buildResultManifest(
  resultsDir: string,
  resultPath: string,
  result: BenchmarkResult,
): Promise<BenchmarkReproManifestResult> {
  const fileStats = await stat(resultPath);
  return {
    path: path.relative(resultsDir, resultPath).split(path.sep).join("/"),
    sha256: await sha256File(resultPath),
    sizeBytes: fileStats.size,
    resultId: result.meta.id,
    benchmark: result.meta.benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    configHash: sha256String(stableStringify(result.config)),
  };
}

async function resolveResultPaths(
  resultsDir: string,
  explicitPaths: string[] | undefined,
): Promise<string[]> {
  if (explicitPaths !== undefined) {
    return [...new Set(explicitPaths.map((entry) => path.resolve(entry)))]
      .sort((left, right) => left.localeCompare(right));
  }
  const summaries = await listBenchmarkResults(resultsDir);
  return summaries.map((summary) => path.resolve(summary.path));
}

async function buildConfigFileEntries(
  configFiles: BuildBenchmarkReproManifestOptions["configFiles"] = [],
): Promise<BenchmarkReproManifest["configFiles"]> {
  const entries: BenchmarkReproManifest["configFiles"] = [];
  for (const configFile of configFiles) {
    if (!configFile.path) {
      continue;
    }
    try {
      const fileStats = await stat(configFile.path);
      if (!fileStats.isFile()) {
        entries.push({ label: configFile.label, path: configFile.path, missing: true });
        continue;
      }
      entries.push({
        label: configFile.label,
        path: configFile.path,
        sizeBytes: fileStats.size,
        sha256: await sha256File(configFile.path),
      });
    } catch {
      entries.push({ label: configFile.label, path: configFile.path, missing: true });
    }
  }
  return entries;
}

function collectQmdCollections(
  explicitCollections: string[] | undefined,
  results: BenchmarkResult[],
): string[] {
  const collections = new Set(explicitCollections ?? []);
  for (const result of results) {
    const config = result.config.remnicConfig ?? {};
    for (const key of [
      "qmdCollection",
      "qmdColdCollection",
      "conversationIndexQmdCollection",
    ]) {
      const value = config[key];
      if (typeof value === "string" && value.trim().length > 0) {
        collections.add(value);
      }
    }
  }
  return [...collections].sort((left, right) => left.localeCompare(right));
}

function resolvePackageManager(cwd: string): string | undefined {
  try {
    return execFileSync("pnpm", ["--version"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export async function buildBenchmarkReproManifest(
  resultsDir: string,
  options: BuildBenchmarkReproManifestOptions = {},
): Promise<BenchmarkReproManifest> {
  const resolvedResultsDir = path.resolve(resultsDir);
  const cwd = options.command?.cwd ?? process.cwd();
  const resultPaths = await resolveResultPaths(resolvedResultsDir, options.resultPaths);
  const loadedResults = await Promise.all(resultPaths.map((resultPath) => loadBenchmarkResult(resultPath)));
  const resultEntries = await Promise.all(
    resultPaths.map((resultPath, index) =>
      buildResultManifest(resolvedResultsDir, resultPath, loadedResults[index]!),
    ),
  );
  const selectedBenchmarks = options.selectedBenchmarks ??
    [...new Set(loadedResults.map((result) => result.meta.benchmark))].sort();
  const selectedWorkItems = options.selectedWorkItems ??
    loadedResults.map((result) => ({
      benchmark: result.meta.benchmark,
      runtimeProfile: result.config.runtimeProfile ?? "unknown",
    }));
  const datasetDirs = options.datasetDirs ?? {};
  const datasets = await Promise.all(
    selectedBenchmarks.map((benchmark) => buildDatasetManifest(benchmark, datasetDirs[benchmark])),
  );
  const qmdCollections = collectQmdCollections(options.qmd?.collections, loadedResults);
  const pnpmVersion = resolvePackageManager(cwd);
  const manifestWithoutHash = {
    schemaVersion: BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      id: options.runId ?? resolveBenchmarkRunId(),
      ...(options.mode ? { mode: options.mode } : {}),
      selectedBenchmarks,
      runtimeProfiles: options.runtimeProfiles ?? [],
      selectedWorkItems,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    },
    git: buildGitInfo(cwd),
    command: {
      cwd,
      argv: sanitizeArgv(options.command?.argv ?? process.argv.slice(2)),
      envKeys: sanitizeEnvKeys(options.command?.env, options.command?.envKeys),
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      hostname: os.hostname(),
      ...(pnpmVersion ? { packageManager: `pnpm@${pnpmVersion}` } : {}),
    },
    ...(options.qmd || qmdCollections.length > 0
      ? {
          qmd: {
            ...(options.qmd?.configDir ? { configDir: options.qmd.configDir } : {}),
            ...(options.qmd?.cacheDir ? { cacheDir: options.qmd.cacheDir } : {}),
            collections: qmdCollections,
          },
        }
      : {}),
    configFiles: await buildConfigFileEntries(options.configFiles),
    datasets,
    results: resultEntries.sort((left, right) => left.path.localeCompare(right.path)),
  };

  return {
    ...manifestWithoutHash,
    artifactHash: sha256String(stableStringify(buildArtifactHashIdentity(manifestWithoutHash))),
  };
}

export async function writeBenchmarkReproManifest(
  resultsDir: string,
  options: BuildBenchmarkReproManifestOptions = {},
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const manifest = await buildBenchmarkReproManifest(resultsDir, options);
  const manifestPath = path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
