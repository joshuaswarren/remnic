import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "../config.js";
import { RecallSearchPipelineCoordinator } from "./recall-search-pipeline.js";
import type { RecallSearchPipelineDeps } from "./recall-search-pipeline.js";
import type { MemoryFile, QmdSearchResult } from "../types.js";
import type { StorageManager } from "../index.js";
import type { QueryAwarePrefilter } from "../orchestrator.js";

function result(namespace: string, path: string): QmdSearchResult {
  return { docid: `${namespace}:${path}`, namespace, path, score: 1, snippet: path };
}

function memory(path: string, status: string): MemoryFile {
  return {
    path,
    content: path,
    frontmatter: {
      status,
      memoryKind: "fact",
      created: "2026-07-19T00:00:00.000Z",
      updated: "2026-07-19T00:00:00.000Z",
    } as unknown as MemoryFile["frontmatter"],
  };
}

async function makeCoordinator(memoryDir: string): Promise<RecallSearchPipelineCoordinator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespaces: true,
  });
  const deps = {
    config,
    storage: {} as StorageManager,
    readQmdResultMemory: async (
      resultPath: string,
      _fallbackStorage: StorageManager,
      _recallNamespaces: readonly string[],
      preferredNamespace?: string,
    ) => memory(resultPath, preferredNamespace === "private" ? "forgotten" : "active"),
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

test("recall safety keeps same relative path distinct across namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-map-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const results = [result("shared", "facts/same.md"), result("private", "facts/same.md")];

    const loaded = await coordinator.loadSearchResultMemoryMap(results, undefined, {
      recallNamespaces: ["shared", "private"],
    });
    const safe = coordinator.filterSearchResultsByRecallSafety(results, loaded.memoryByPath);

    assert.equal(loaded.memoryByPath.size, 2, "each namespace must retain its own loaded memory");
    assert.deepEqual(
      safe.map((candidate) => candidate.namespace),
      ["shared"],
      "status filtering must use the memory belonging to each result namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function fallbackCoordinator(seed: QmdSearchResult[], archived: MemoryFile[]): RecallSearchPipelineCoordinator {
  const deps = {
    searchScopedMemoryCandidates: async () => seed,
    readArchivedMemoriesForNamespaces: async () => archived,
    namespaceFromPath: () => "default",
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

const SEED_WITH_NON_RECALLABLE = [
  result("default", "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"),
  result("default", "facts/a.md"),
  result("default", "artifacts/y.md"),
];
const PREFILTER = {
  candidatePaths: new Set([
    "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md",
    "facts/a.md",
    "artifacts/y.md",
  ]),
} as unknown as QueryAwarePrefilter;

test("archive fallback excludes non-recallable seeds on the archived-empty early return", async () => {
  const coordinator = fallbackCoordinator(SEED_WITH_NON_RECALLABLE, []);
  // limit 10 > filtered seed count, tokens non-empty, archived empty → the
  // `return scopedSeedResults` early path at the archived-empty guard.
  const out = await coordinator.searchLongTermArchiveFallback("quarterly report", ["default"], 10, PREFILTER);
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "meeting record + artifact must not leak through the direct-caller early return",
  );
});

test("archive fallback excludes non-recallable seeds on the empty-tokens early return", async () => {
  const coordinator = fallbackCoordinator(SEED_WITH_NON_RECALLABLE, [memory("facts/z.md", "archived")]);
  // Empty prompt → zero tokens → the `return scopedSeedResults` early path
  // before archive scoring is even attempted.
  const out = await coordinator.searchLongTermArchiveFallback("", ["default"], 10, PREFILTER);
  assert.deepEqual(out.map((r) => r.path), ["facts/a.md"]);
});

test("archive fallback excludes non-recallable seeds on the seed-fills-cap early return", async () => {
  const seed = [
    result("default", "facts/a.md"),
    result("default", "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md"),
    result("default", "facts/b.md"),
  ];
  const prefilter = {
    candidatePaths: new Set(["facts/a.md", "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md", "facts/b.md"]),
  } as unknown as QueryAwarePrefilter;
  const coordinator = fallbackCoordinator(seed, []);
  // After filtering the meeting record, two recallable seeds fill the cap of 2.
  const out = await coordinator.searchLongTermArchiveFallback("quarterly", ["default"], 2, prefilter);
  assert.deepEqual(out.map((r) => r.path), ["facts/a.md", "facts/b.md"]);
});
