import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
 import test from "node:test";

import {
  __benchDatasetTestHooks,
  type PairedAnswerReplayCache,
} from "./index.js";
import { resolveRepoDatasetRoot } from "./bench-dataset-store.js";
import { resolveHomeDir } from "./path-utils.js";

test("paired answer replay cache is exclusive to LoCoMo", () => {
  const cache = new Map();

  assert.equal(
    __benchDatasetTestHooks.pairedAnswerReplayCacheForBenchmark("locomo", cache),
    cache,
  );
  assert.equal(
    __benchDatasetTestHooks.pairedAnswerReplayCacheForBenchmark("longmemeval", cache),
    undefined,
  );
});

test("paired LoCoMo work executes baseline before real", () => {
  const workItems = [
    { benchmarkId: "longmemeval", runtimeProfile: "real" },
    { benchmarkId: "locomo", runtimeProfile: "real" },
    { benchmarkId: "memoryagentbench", runtimeProfile: "baseline" },
    { benchmarkId: "locomo", runtimeProfile: "baseline" },
  ] as const;

  assert.deepEqual(
    __benchDatasetTestHooks.orderPairedLoCoMoWorkItemsForTest(workItems),
    [
      { benchmarkId: "longmemeval", runtimeProfile: "real" },
      { benchmarkId: "locomo", runtimeProfile: "baseline" },
      { benchmarkId: "locomo", runtimeProfile: "real" },
      { benchmarkId: "memoryagentbench", runtimeProfile: "baseline" },
    ],
  );
});

test("resolveDownloadedBenchDatasetDir rejects explicit dataset paths without benchmark markers", async () => {

  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const invalidDataset = path.join(root, "not-downloaded");

  assert.equal(
    __benchDatasetTestHooks.resolveBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    invalidDataset,
  );
  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      invalidDataset,
    ),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir accepts explicit dataset paths with benchmark markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "shopping.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("resolveDownloadedBenchDatasetDir ignores MemoryArena WebShop sidecars as dataset markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memory-arena");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "webshop-products.jsonl"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memory-arena",
      false,
      datasetDir,
    ),
    undefined,
  );
});

test("resolveDownloadedBenchDatasetDir accepts non-ReDial MemoryAgentBench splits without entity mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "Test_Time_Learning.json"), "[]\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("resolveDownloadedBenchDatasetDir requires MemoryAgentBench ReDial entity mapping for ReDial bundles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-datasets-"));
  const datasetDir = path.join(root, "memoryagentbench");
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The user asked for cyberpunk action movies.",
        questions: ["User: I want a cyberpunk action movie. Recommender:"],
        answers: [["1"]],
        metadata: {
          source: "recsys_redial",
          qa_pair_ids: ["redial-1"],
          question_types: ["recommendation"],
        },
      },
    ]),
    "utf8",
  );

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    undefined,
  );

  await writeFile(path.join(datasetDir, "entity2id.json"), "{}\n");

  assert.equal(
    __benchDatasetTestHooks.resolveDownloadedBenchDatasetDir(
      "memoryagentbench",
      false,
      datasetDir,
    ),
    datasetDir,
  );
});

test("published dry-run validation forwards MemoryAgentBench trial limit", async () => {
  let captured:
    | {
        id: string;
        options: {
          benchmarkOptions?: Record<string, unknown>;
          datasetDir?: string;
          limit?: number;
          seed?: number;
          onTaskComplete?: (
            task: {
              taskId: string;
              scores: Record<string, number>;
              latencyMs: number;
              tokens: { input: number; output: number };
            },
            completedCount: number,
            totalCount?: number,
          ) => void;
        };
      }
    | undefined;
  const benchModule = {
    async runBenchmark(id: string, options: NonNullable<typeof captured>["options"]) {
      captured = { id, options };
      options.onTaskComplete?.(
        {
          taskId: "dry-run-check",
          scores: {},
          latencyMs: 0,
          tokens: { input: 0, output: 0 },
        },
        1,
        1,
      );
      throw new Error("dry-run adapter should stop benchmark execution");
    },
  };

  const benchmarkOptions =
    __benchDatasetTestHooks.buildPublishedBenchmarkOptionsForTest(
      "memoryagentbench",
      { publishedTrialLimit: 1 },
    );

  await __benchDatasetTestHooks
    .validateRunnerManagedPublishedDryRunDatasetWithModuleForTest(
      benchModule,
      "memoryagentbench",
      "full",
      "/tmp/memoryagentbench",
      10,
      123,
      benchmarkOptions,
    );

  assert.equal(captured?.id, "memoryagentbench");
  assert.equal(captured?.options.datasetDir, "/tmp/memoryagentbench");
  assert.equal(captured?.options.limit, 10);
  assert.equal(captured?.options.seed, 123);
  assert.deepEqual(captured?.options.benchmarkOptions, { trialLimit: 1 });
});

test("paired baseline-locomo failure path clears the shared replay cache", () => {
  type CacheEntry = { sourceRuntimeProfile: "baseline"; finalAnswer: string; answeredText: string };
  const cache = new Map<string, CacheEntry>();
  cache.set("seed", { sourceRuntimeProfile: "baseline", finalAnswer: "x", answeredText: "x" });
  let cleared = 0;
  const wrappedCache: PairedAnswerReplayCache = {
    size: cache.size,
    has: cache.has.bind(cache),
    get: cache.get.bind(cache),
    set: cache.set.bind(cache),
    delete: cache.delete.bind(cache),
    clear: () => {
      cleared++;
      cache.clear();
    },
    entries: cache.entries.bind(cache),
    keys: cache.keys.bind(cache),
    values: cache.values.bind(cache),
    forEach: cache.forEach.bind(cache),
    [Symbol.iterator]: cache[Symbol.iterator].bind(cache),
    [Symbol.toStringTag]: "Map",
  } as PairedAnswerReplayCache;
  __benchDatasetTestHooks.clearPairedAnswerReplayCacheOnFailureForTest(
    "baseline",
    "locomo",
    wrappedCache,
  );
  assert.equal(cleared, 1);
  assert.equal(cache.size, 0);

  __benchDatasetTestHooks.clearPairedAnswerReplayCacheOnFailureForTest(
    "real",
    "locomo",
    wrappedCache,
  );
  __benchDatasetTestHooks.clearPairedAnswerReplayCacheOnFailureForTest(
    "baseline",
    "longmemeval",
    wrappedCache,
  );
  assert.equal(cleared, 1);
});

// --- Legacy evals/datasets discovery (#2867) -------------------------------
//
// `locomo` is used as the fixture benchmark: its downloaded-marker is a
// single `locomo10.json` file, so a one-file directory is a complete
// dataset for discovery purposes.

async function writeLocomoDataset(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "locomo10.json"), "[]");
}

async function writeMemoryAgentBenchRedialDataset(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "The user asked for a comedy movie.",
        questions: ["User: recommend a comedy. Recommender:"],
        answers: [["7008"]],
        metadata: {
          source: "recsys_redial",
          qa_pair_ids: ["redial-1"],
          question_types: ["recommendation"],
        },
      },
    ]),
  );
}

// Deterministic content hash of a directory tree (names, structure, file
// bytes, symlink targets) — used to prove discovery never moves or mutates.
async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`${prefix}${entry.name}/\n`);
        await walk(entryPath, `${prefix}${entry.name}/`);
      } else if (entry.isSymbolicLink()) {
        hash.update(`${prefix}${entry.name}->${await realpath(entryPath)}\n`);
      } else {
        hash.update(`${prefix}${entry.name}\n`);
        hash.update(await readFile(entryPath));
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

function captureConsoleError(): { lines: () => string[]; restore: () => void } {
  const recorded: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    recorded.push(args.map((arg) => String(arg)).join(" "));
  };
  return { lines: () => recorded, restore: () => (console.error = original) };
}

test("discoverBenchDatasetDir uses the canonical store when the legacy tree is absent", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-discovery-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  await writeLocomoDataset(path.join(canonicalRoot, "locomo"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    const discovered = __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
      canonicalRoot,
      legacyRoot,
    });
    assert.ok(discovered);
    assert.equal(discovered.source, "canonical");
    assert.equal(discovered.dir, path.join(canonicalRoot, "locomo"));
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir: canonical wins when both locations exist, legacy left alone", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-discovery-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  await writeLocomoDataset(path.join(canonicalRoot, "locomo"));
  await writeLocomoDataset(path.join(legacyRoot, "locomo"));
  const legacyHashBefore = await hashTree(legacyRoot);

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    const discovered = __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
      canonicalRoot,
      legacyRoot,
    });
    assert.ok(discovered);
    assert.equal(discovered.source, "canonical");
    assert.equal(discovered.dir, path.join(canonicalRoot, "locomo"));
    // Canonical winning is not worth a warning; the legacy copy is simply
    // ignored, untouched.
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
  assert.equal(await hashTree(legacyRoot), legacyHashBefore);
});

test("discoverBenchDatasetDir uses a legacy dataset read-only with a once-per-process migration hint", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-discovery-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const legacyDir = path.join(legacyRoot, "locomo");
  await writeLocomoDataset(legacyDir);
  const legacyHashBefore = await hashTree(legacyRoot);
  const canonicalEntriesBefore = await listDir(canonicalRoot);

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    const first = __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
      canonicalRoot,
      legacyRoot,
    });
    assert.ok(first);
    assert.equal(first.source, "legacy-evals");
    assert.equal(first.dir, legacyDir);

    const second = __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
      canonicalRoot,
      legacyRoot,
    });
    assert.equal(second?.dir, legacyDir);

    const warnings = captured.lines();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /`remnic bench datasets download locomo`/);
    assert.match(warnings[0]!, /~\/\.remnic\/bench\/datasets/);
    assert.match(warnings[0]!, /evals\/datasets\/locomo/);
    assert.match(warnings[0]!, /read-only/);
    // No host-resolved paths in the hint.
    assert.ok(!warnings[0]!.includes(base));
    assert.ok(!warnings[0]!.includes(os.homedir()));
  } finally {
    captured.restore();
  }

  // No movement, link, or mutation: the legacy tree is byte-identical and
  // nothing appeared in the canonical root.
  assert.equal(await hashTree(legacyRoot), legacyHashBefore);
  assert.deepEqual(await listDir(canonicalRoot), canonicalEntriesBefore);
});

test("discoverBenchDatasetDir returns undefined when neither location has the dataset", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-discovery-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  // Canonical dir exists but lacks the marker file; legacy root is absent.
  await mkdir(path.join(canonicalRoot, "locomo"), { recursive: true });

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects legacy paths that escape the legacy root via symlink", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-discovery-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const outside = path.join(base, "outside", "locomo");
  await writeLocomoDataset(outside);
  await mkdir(legacyRoot, { recursive: true });
  await symlink(outside, path.join(legacyRoot, "locomo"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects a symlinked legacy dataset root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-root-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const outsideRoot = path.join(base, "outside");
  await writeLocomoDataset(path.join(outsideRoot, "locomo"));
  await mkdir(path.dirname(legacyRoot), { recursive: true });
  await symlink(outsideRoot, legacyRoot);
  const outsideHashBefore = await hashTree(outsideRoot);

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
  assert.equal(await hashTree(outsideRoot), outsideHashBefore);
});

test("discoverBenchDatasetDir rejects a symlinked file inside a contained legacy dataset dir", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-file-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const legacyDir = path.join(legacyRoot, "locomo");
  const outsideFile = path.join(base, "outside", "locomo10.json");
  await mkdir(path.dirname(outsideFile), { recursive: true });
  await writeFile(outsideFile, "[]");
  await mkdir(legacyDir, { recursive: true });
  await symlink(outsideFile, path.join(legacyDir, "locomo10.json"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects a symlinked ancestor of the legacy root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-ancestor-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const outsideRoot = path.join(base, "outside");
  await writeLocomoDataset(path.join(outsideRoot, "datasets", "locomo"));
  await symlink(outsideRoot, path.join(base, "evals"));
  const legacyRoot = path.join(base, "evals", "datasets");

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects a nested directory symlink inside a legacy dataset dir", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-dir-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const outsideData = path.join(base, "outside", "data");
  await mkdir(outsideData, { recursive: true });
  await writeFile(path.join(outsideData, "100K-00000-of-00001.parquet"), "x");
  const legacyDir = path.join(legacyRoot, "beam");
  await mkdir(legacyDir, { recursive: true });
  await symlink(outsideData, path.join(legacyDir, "data"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("beam", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects an unused directory symlink in a complete legacy dataset", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-unused-dir-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const legacyDir = path.join(legacyRoot, "locomo");
  await writeLocomoDataset(legacyDir);
  const outsideDir = path.join(base, "outside", "extra");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "note.txt"), "x");
  await symlink(outsideDir, path.join(legacyDir, "extra"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("locomo", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects a sibling processed_data mapping symlink", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-processed-data-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const outsideMapping = path.join(base, "outside", "Recsys_Redial");
  await writeMemoryAgentBenchRedialDataset(path.join(legacyRoot, "memoryagentbench"));
  await mkdir(outsideMapping, { recursive: true });
  await writeFile(path.join(outsideMapping, "entity2id.json"), '{"/movie/The_Big_Lebowski_(1998)":7008}\n');
  await symlink(path.join(base, "outside"), path.join(legacyRoot, "processed_data"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("memoryagentbench", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir rejects a sibling Recsys_Redial mapping symlink", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-recsys-redial-symlink-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const outsideMapping = path.join(base, "outside", "Recsys_Redial");
  await writeMemoryAgentBenchRedialDataset(path.join(legacyRoot, "memoryagentbench"));
  await mkdir(outsideMapping, { recursive: true });
  await writeFile(path.join(outsideMapping, "entity2id.json"), '{"/movie/The_Big_Lebowski_(1998)":7008}\n');
  await symlink(outsideMapping, path.join(legacyRoot, "Recsys_Redial"));

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    assert.equal(
      __benchDatasetTestHooks.discoverBenchDatasetDir("memoryagentbench", {
        canonicalRoot,
        legacyRoot,
      }),
      undefined,
    );
    assert.deepEqual(captured.lines(), []);
  } finally {
    captured.restore();
  }
});

test("discoverBenchDatasetDir accepts a real sibling Recsys mapping under the legacy root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-dataset-recsys-mapping-ok-"));
  const canonicalRoot = path.join(base, "canonical");
  const legacyRoot = path.join(base, "evals", "datasets");
  const legacyDir = path.join(legacyRoot, "memoryagentbench");
  const mappingDir = path.join(legacyRoot, "processed_data", "Recsys_Redial");
  await writeMemoryAgentBenchRedialDataset(legacyDir);
  await mkdir(mappingDir, { recursive: true });
  await writeFile(path.join(mappingDir, "entity2id.json"), '{"/movie/The_Big_Lebowski_(1998)":7008}\n');

  __benchDatasetTestHooks.resetLegacyDatasetDiscoveryWarningForTest();
  const captured = captureConsoleError();
  try {
    const discovered = __benchDatasetTestHooks.discoverBenchDatasetDir("memoryagentbench", {
      canonicalRoot,
      legacyRoot,
    });
    assert.ok(discovered);
    assert.equal(discovered.source, "legacy-evals");
    assert.equal(discovered.dir, legacyDir);
    assert.equal(captured.lines().length, 1);
  } finally {
    captured.restore();
  }
});

test("resolveRepoDatasetRoot uses the post-migration home store in a repo checkout", () => {
  assert.equal(
    resolveRepoDatasetRoot(),
    path.join(resolveHomeDir(), ".remnic", "bench", "datasets"),
  );
});
