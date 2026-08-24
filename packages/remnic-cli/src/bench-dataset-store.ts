// Benchmark dataset store: downloaded-content markers and the read-side
// discovery seam shared by `remnic bench datasets status`,
// `remnic bench datasets download`, and `remnic bench run` auto-selection.
// Extracted from the CLI entrypoint (issue #1995 line ratchet, #2867).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHomeDir } from "./path-utils.js";

// Same resolution as the CLI entrypoint: this file lives in
// packages/remnic-cli/src, so ../../.. is the monorepo root in a checkout
// and the package's install root under node_modules when published.
const CLI_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const DOWNLOADABLE_BENCHMARK_DATASETS = [
  "ama-bench",
  "memory-arena",
  "amemgym",
  "longmemeval",
  "locomo",
  "beam",
  "personamem",
  "membench",
  "memoryagentbench",
] as const;

const MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES = [
  "webshop-products.jsonl",
  "webshop-products.json",
  "memory-arena-webshop-products.jsonl",
  "memory-arena-webshop-products.json",
] as const;

const MEMORY_AGENT_BENCH_BUNDLE_FILENAMES = [
  "memoryagentbench.json",
  "memoryagentbench.jsonl",
  "MemoryAgentBench.json",
  "MemoryAgentBench.jsonl",
] as const;

const MEMORY_AGENT_BENCH_SPLIT_FILENAMES = [
  "Accurate_Retrieval.json",
  "Accurate_Retrieval.jsonl",
  "accurate_retrieval.json",
  "accurate_retrieval.jsonl",
  "Test_Time_Learning.json",
  "Test_Time_Learning.jsonl",
  "test_time_learning.json",
  "test_time_learning.jsonl",
  "Long_Range_Understanding.json",
  "Long_Range_Understanding.jsonl",
  "long_range_understanding.json",
  "long_range_understanding.jsonl",
  "Conflict_Resolution.json",
  "Conflict_Resolution.jsonl",
  "conflict_resolution.json",
  "conflict_resolution.jsonl",
] as const;

const MEMORY_AGENT_BENCH_ENTITY_MAPPING_CANDIDATES = [
  "entity2id.json",
  path.join("processed_data", "Recsys_Redial", "entity2id.json"),
  path.join("Recsys_Redial", "entity2id.json"),
] as const;

type DownloadedDatasetMarker = {
  anyOf?: string[];
  allOf?: string[];
  ext?: string;
  exclude?: readonly string[];
};

// Required content markers per benchmark. `anyOf` lists the filenames
// a benchmark runner will accept — a dataset directory is considered
// "downloaded" as soon as any one of them is present. `allOf` lists
// required sidecar files. `ext` matches any file in the directory with
// the given extension. The filename sets mirror the dataset loaders
// under packages/bench/src/benchmarks so `datasets status` and
// `resolveBenchDatasetDir` never disagree with the runner about whether
// a dataset is ready.
const DOWNLOADED_DATASET_MARKERS: Record<string, DownloadedDatasetMarker> = {
  "ama-bench": { anyOf: ["open_end_qa_set.jsonl"] },
  longmemeval: {
    // Keep this list in lock-step with `LONG_MEM_EVAL_DATASET_FILENAMES`
    // in packages/bench/src/benchmarks/published/dataset-loader.ts so
    // `datasets status` never disagrees with the runner about what
    // counts as "downloaded".
    anyOf: [
      "longmemeval_s_cleaned.json",
      "longmemeval_s.json",
      "longmemeval.json",
      "longmemeval_oracle.json",
    ],
  },
  amemgym: {
    anyOf: ["amemgym-v1-base.json", "amemgym-tasks.json", "data.json"],
  },
  locomo: { anyOf: ["locomo10.json", "locomo.json"] },
  "memory-arena": {
    ext: ".jsonl",
    exclude: MEMORY_ARENA_WEBSHOP_PRODUCT_SIDECAR_FILENAMES,
  },
  beam: {
    anyOf: [
      "beam_100k.json",
      "beam_500k.json",
      "beam_1m.json",
      "beam_10m.json",
      "100k.json",
      "500k.json",
      "1m.json",
      "10m.json",
      "data/100K-00000-of-00001.parquet",
      "data/500K-00000-of-00001.parquet",
      "data/1M-00000-of-00001.parquet",
      "data/10M-00000-of-00002.parquet",
      "data/10M-00001-of-00002.parquet",
    ],
  },
  personamem: {
    anyOf: [
      "benchmark/text/benchmark.csv",
      "benchmark/benchmark.csv",
      "benchmark.csv",
    ],
  },
  membench: {
    anyOf: [
      "membench.json",
      "membench.jsonl",
      "data.json",
      "FirstAgentDataLowLevel.json",
      "FirstAgentDataHighLevel.json",
      "ThirdAgentDataLowLevel.json",
      "ThirdAgentDataHighLevel.json",
      "FirstAgentDataLowLevel.jsonl",
      "FirstAgentDataHighLevel.jsonl",
      "ThirdAgentDataLowLevel.jsonl",
      "ThirdAgentDataHighLevel.jsonl",
    ],
  },
  memoryagentbench: {
    anyOf: [
      ...MEMORY_AGENT_BENCH_BUNDLE_FILENAMES,
      ...MEMORY_AGENT_BENCH_SPLIT_FILENAMES,
    ],
  },
};

const PERSONAMEM_DATASET_FILE_CANDIDATES = [
  "benchmark/text/benchmark.csv",
  "benchmark/benchmark.csv",
  "benchmark.csv",
] as const;

const PERSONAMEM_COMPLETION_MARKER = path.join(
  "data",
  "chat_history_32k",
  ".download-complete",
);

function resolveRealpathWithinDataset(
  datasetPath: string,
  relativePath: string,
): string | null {
  try {
    const datasetRoot = fs.realpathSync(datasetPath);
    const candidatePath = path.resolve(datasetRoot, relativePath);
    const candidateRealPath = fs.realpathSync(candidatePath);
    const relativeToRoot = path.relative(datasetRoot, candidateRealPath);
    if (
      relativeToRoot.startsWith("..")
      || path.isAbsolute(relativeToRoot)
    ) {
      return null;
    }
    return candidateRealPath;
  } catch {
    return null;
  }
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  const pushRow = () => {
    const values = [...currentRow, currentField];
    const isHeader = rows.length === 0;
    const isBlank = values.every((value) => value.trim().length === 0);
    if (isHeader || !isBlank) {
      rows.push(values);
    }
    currentRow = [];
    currentField = "";
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      pushRow();
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  return rows;
}

function isPersonaMemDatasetComplete(datasetPath: string): boolean {
  try {
    const completionMarkerPath = path.join(datasetPath, PERSONAMEM_COMPLETION_MARKER);
    if (isRegularFileNoFollow(completionMarkerPath)) {
      return true;
    }
  } catch {
    // Fall back to verifying every CSV-linked history file for pre-marker mirrors.
  }

  const datasetFile = PERSONAMEM_DATASET_FILE_CANDIDATES.find((candidate) =>
    isRegularFileNoFollow(path.join(datasetPath, candidate)),
  );
  if (!datasetFile) {
    return false;
  }

  try {
    const rows = parseCsvRows(fs.readFileSync(path.join(datasetPath, datasetFile), "utf8"));
    if (rows.length < 2) {
      return false;
    }
    const [header, ...dataRows] = rows;
    const chatHistoryIndex = header.indexOf("chat_history_32k_link");
    if (chatHistoryIndex < 0) {
      return false;
    }
    const historyPaths = dataRows
      .map((row) => row[chatHistoryIndex]?.trim() ?? "")
      .filter((value) => value.length > 0);
    if (historyPaths.length === 0) {
      return false;
    }
    return historyPaths.every((relativePath) => {
      const resolvedPath = resolveRealpathWithinDataset(datasetPath, relativePath);
      return resolvedPath !== null && fs.statSync(resolvedPath).isFile();
    });
  } catch {
    return false;
  }
}

function isRegularFileNoFollow(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasMemoryAgentBenchEntityMapping(datasetPath: string): boolean {
  const absoluteDatasetPath = path.resolve(datasetPath);
  const roots = [absoluteDatasetPath, path.dirname(absoluteDatasetPath)];
  return (
    isRegularFileNoFollow(path.join(absoluteDatasetPath, "entity2id.json")) ||
    roots.some((root) =>
      MEMORY_AGENT_BENCH_ENTITY_MAPPING_CANDIDATES
        .filter((relativePath) => relativePath !== "entity2id.json")
        .some((relativePath) => isRegularFileNoFollow(path.join(root, relativePath))),
    )
  );
}

function memoryAgentBenchDatasetHasRecSysSamples(datasetPath: string): boolean {
  const candidateFilenames = [
    ...MEMORY_AGENT_BENCH_BUNDLE_FILENAMES,
    ...MEMORY_AGENT_BENCH_SPLIT_FILENAMES,
  ];
  return candidateFilenames.some((filename) => {
    const filePath = path.join(datasetPath, filename);
    try {
      if (!isRegularFileNoFollow(filePath)) {
        return false;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      return /"source"\s*:\s*"recsys[_-]/i.test(raw);
    } catch {
      return false;
    }
  });
}

function isMemoryAgentBenchDatasetComplete(datasetPath: string): boolean {
  if (hasMemoryAgentBenchEntityMapping(datasetPath)) {
    return true;
  }
  return !memoryAgentBenchDatasetHasRecSysSamples(datasetPath);
}

export function isDatasetDownloaded(datasetPath: string, benchmarkId: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(datasetPath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return false;
  }
  const marker = DOWNLOADED_DATASET_MARKERS[benchmarkId];
  if (!marker) {
    // Unknown benchmark: fall back to "directory has at least one file".
    try {
      return fs.readdirSync(datasetPath).length > 0;
    } catch {
      return false;
    }
  }
  if (marker.allOf) {
    const hasAllRequiredFiles = marker.allOf.every((name) =>
      isRegularFileNoFollow(path.join(datasetPath, name)),
    );
    if (!hasAllRequiredFiles) {
      return false;
    }
  }
  if (marker.anyOf) {
    const hasMarkerFile = marker.anyOf.some((name) =>
      isRegularFileNoFollow(path.join(datasetPath, name)),
    );
    if (!hasMarkerFile) {
      return false;
    }
    if (benchmarkId === "personamem") {
      return isPersonaMemDatasetComplete(datasetPath);
    }
    if (benchmarkId === "memoryagentbench") {
      return isMemoryAgentBenchDatasetComplete(datasetPath);
    }
    return true;
  }
  if (marker.ext) {
    try {
      return fs.readdirSync(datasetPath, { withFileTypes: true }).some((entry) =>
        entry.isFile() && entry.name.endsWith(marker.ext!) && !marker.exclude?.includes(entry.name),
      );
    } catch {
      return false;
    }
  }
  return false;
}

// After #2798 the canonical root is ~/.remnic/bench/datasets in both
// repo checkouts and published installs. The repo-local evals/datasets
// tree is reserved for read-only fallback discovery (#2867).
export function resolveRepoDatasetRoot(): string {
  return path.join(resolveHomeDir(), ".remnic", "bench", "datasets");
}

// Pre-#2798 repo-local dataset store. After #2798 the canonical root is
// ~/.remnic/bench/datasets everywhere; datasets already downloaded to the
// legacy location stay readable until the operator re-downloads (#2867).
const LEGACY_EVALS_DATASET_ROOT = path.join(CLI_REPO_ROOT, "evals", "datasets");

type BenchDatasetSource = "canonical" | "legacy-evals";

interface DiscoveredBenchDataset {
  dir: string;
  source: BenchDatasetSource;
}

const warnedLegacyDatasetBenchmarkIds = new Set<string>();

// Containment guard for legacy discovery: the resolved (real) path of
// `candidate` must be a strict subdirectory of the resolved `root`.
// Rejects `..` traversal, absolute-path smuggling, a symlink anywhere in
// the unresolved root/parent chain (evals -> outside/datasets), and a
// candidate that realpath-escapes the root.
function pathHasSymlinkComponent(target: string): boolean {
  let current = path.resolve(target);
  // Bound the walk to the dataset root, its parent (`evals`), and the
  // checkout/test base. Do not walk to `/` — `/tmp` is a symlink on macOS.
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return false;
}

function isPathContainedWithinRoot(candidate: string, root: string): boolean {
  try {
    if (pathHasSymlinkComponent(root)) {
      return false;
    }
    const rootReal = fs.realpathSync(root);
    const candidateReal = fs.realpathSync(candidate);
    const rel = path.relative(rootReal, candidateReal);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// In-tree symlink policy for a contained legacy dataset dir. `lstat` on a
// nested marker follows intermediate directory links (BEAM `data/…`), so
// the only complete check is a dirent walk that never follows links.
function datasetTreeHasSymlink(root: string): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        return true;
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
    }
  }
  return false;
}

// Single seam for read-side dataset discovery (#2867): canonical root wins;
// a dataset left at the legacy evals/datasets/<benchmark> location is used
// read-only with a once-per-process migration hint. Never moves, links, or
// otherwise mutates either tree. `roots` is injectable for tests only.
export function discoverBenchDatasetDir(
  benchmarkId: string,
  roots?: { canonicalRoot?: string; legacyRoot?: string },
): DiscoveredBenchDataset | undefined {
  const canonicalRoot = roots?.canonicalRoot ?? resolveRepoDatasetRoot();
  const canonicalDir = path.join(canonicalRoot, benchmarkId);
  if (isDatasetDownloaded(canonicalDir, benchmarkId)) {
    return { dir: canonicalDir, source: "canonical" };
  }

  const legacyRoot = roots?.legacyRoot ?? LEGACY_EVALS_DATASET_ROOT;
  const legacyDir = path.join(legacyRoot, benchmarkId);
  // Identical roots have nothing to fall back to (already probed above).
  if (legacyDir === canonicalDir) {
    return undefined;
  }
  if (
    !isPathContainedWithinRoot(legacyDir, legacyRoot) ||
    !isDatasetDownloaded(legacyDir, benchmarkId) ||
    datasetTreeHasSymlink(legacyDir)
  ) {
    return undefined;
  }

  if (!warnedLegacyDatasetBenchmarkIds.has(benchmarkId)) {
    warnedLegacyDatasetBenchmarkIds.add(benchmarkId);
    // Keep real filesystem paths out of the hint: name the command and the
    // path category, not the host-resolved locations.
    console.error(
      `Warning: benchmark "${benchmarkId}" dataset found at the legacy location ` +
        `"evals/datasets/${benchmarkId}" and will be used read-only. Re-download it to the ` +
        `canonical store with \`remnic bench datasets download ${benchmarkId}\` ` +
        "(writes under ~/.remnic/bench/datasets). Nothing is moved automatically.",
    );
  }
  return { dir: legacyDir, source: "legacy-evals" };
}

export function listDownloadableBenchmarks(): string[] {
  return [...DOWNLOADABLE_BENCHMARK_DATASETS];
}

// Test seam: reset the once-per-process legacy-location warning state.
export function resetLegacyDatasetWarningState(): void {
  warnedLegacyDatasetBenchmarkIds.clear();
}
