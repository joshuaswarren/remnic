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

function scopedCandidatesStub(
  seed: QmdSearchResult[],
): RecallSearchPipelineDeps["searchScopedMemoryCandidates"] {
  // Faithful to production: return only the requested candidates, capped to limit.
  return async (candidatePaths, _query, limit) =>
    seed.filter((r) => candidatePaths.has(r.path)).slice(0, Math.max(0, limit));
}

function fallbackCoordinator(seed: QmdSearchResult[], archived: MemoryFile[]): RecallSearchPipelineCoordinator {
  const readArchivedMemoriesForNamespaces: RecallSearchPipelineDeps["readArchivedMemoriesForNamespaces"] =
    async () => archived;
  const namespaceFromPath: RecallSearchPipelineDeps["namespaceFromPath"] = () => "default";
  const deps = {
    searchScopedMemoryCandidates: scopedCandidatesStub(seed),
    readArchivedMemoriesForNamespaces,
    namespaceFromPath,
    config: { memoryDir: "/mem" },
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

function prefilter(paths: string[]): QueryAwarePrefilter {
  return {
    candidatePaths: new Set(paths),
    temporalFromDate: null,
    matchedTags: [],
    expandedTags: [],
    combination: "none",
    filteredToFullSearch: false,
  };
}

const MEETING_RECORD = "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md";
const SEED_PATHS = [MEETING_RECORD, "facts/a.md", "artifacts/y.md"];
const SEED_WITH_NON_RECALLABLE = SEED_PATHS.map((p) => result("default", p));
const PREFILTER = prefilter(SEED_PATHS);

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

test("archive fallback applies the cap to FILTERED seeds, not raw non-recallable hits", async () => {
  // The scoped search returns a single non-recallable hit that would fill a cap
  // of 1 if counted raw; the method must count only recallable seeds, so it does
  // not early-return that hit and (archive empty) yields nothing.
  const coordinator = fallbackCoordinator([result("default", MEETING_RECORD)], []);
  const out = await coordinator.searchLongTermArchiveFallback("quarterly", ["default"], 1, prefilter([MEETING_RECORD]));
  assert.deepEqual(out.map((r) => r.path), []);
});

test("finding 1 — overfetches scoped seeds before exclusion so a capped fetch still yields recallable hits", async () => {
  // The scoped candidate order puts the NON-recallable meeting record FIRST;
  // capping the scoped fetch to the caller's limit (1) BEFORE the generic-recall
  // exclusion would return only the meeting record, which is then filtered out —
  // dropping facts/a.md with no refill. Overfetching the full candidate set first
  // and excluding afterward must still surface the recallable hit at the cap.
  const coordinator = fallbackCoordinator(
    [result("default", MEETING_RECORD), result("default", "facts/a.md")],
    [],
  );
  const out = await coordinator.searchLongTermArchiveFallback(
    "quarterly",
    ["default"],
    1,
    prefilter([MEETING_RECORD, "facts/a.md"]),
  );
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "an excluded-first seed must not starve the result of a recallable hit at the cap",
  );
});
