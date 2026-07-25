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

function queryAwareFallbackCoordinator(
  seed: QmdSearchResult[],
): RecallSearchPipelineCoordinator {
  const namespaceFromPath: RecallSearchPipelineDeps["namespaceFromPath"] = () => "default";
  const deps = {
    searchScopedMemoryCandidates: scopedCandidatesStub(seed),
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

test("query-aware fallback filters non-recallable scoped candidates", async () => {
  const coordinator = queryAwareFallbackCoordinator(SEED_WITH_NON_RECALLABLE);
  const out = await coordinator.searchQueryAwareFallback("quarterly report", 10, PREFILTER);
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "meeting records and artifacts must not leak through query-aware fallback",
  );
});

test("query-aware fallback filters non-recallable scoped candidates for an empty query", async () => {
  const coordinator = queryAwareFallbackCoordinator(SEED_WITH_NON_RECALLABLE);
  const out = await coordinator.searchQueryAwareFallback("", 10, PREFILTER);
  assert.deepEqual(out.map((r) => r.path), ["facts/a.md"]);
});

test("query-aware fallback applies the cap after filtering", async () => {
  const coordinator = queryAwareFallbackCoordinator([result("default", MEETING_RECORD)]);
  const out = await coordinator.searchQueryAwareFallback("quarterly", 1, prefilter([MEETING_RECORD]));
  assert.deepEqual(out.map((r) => r.path), []);
});

test("query-aware fallback excludes root archive candidates before its cap", async () => {
  const archivePath = "archive/2026-02-23/fact-archived.md";
  const coordinator = queryAwareFallbackCoordinator([
    result("default", archivePath),
    result("default", "facts/a.md"),
  ]);

  const out = await coordinator.searchQueryAwareFallback(
    "quarterly",
    1,
    prefilter([archivePath, "facts/a.md"]),
  );

  assert.deepEqual(out.map((r) => r.path), ["facts/a.md"]);
});

test("query-aware fallback retains non-active candidates for historical filtering", async () => {
  let optionsSeen: { allowArchived?: boolean } | undefined;
  const searchScopedMemoryCandidates: RecallSearchPipelineDeps["searchScopedMemoryCandidates"] = async (
    candidatePaths,
    _query,
    limit,
    options,
  ) => {
    optionsSeen = options;
    return [result("default", "facts/superseded.md")]
      .filter((candidate) => candidatePaths.has(candidate.path))
      .slice(0, limit);
  };
  const coordinator = new RecallSearchPipelineCoordinator({
    config: { memoryDir: "/mem" },
    namespaceFromPath: () => "default",
    searchScopedMemoryCandidates,
  } as unknown as RecallSearchPipelineDeps);

  const out = await coordinator.searchQueryAwareFallback(
    "historical incident",
    1,
    prefilter(["facts/superseded.md"]),
  );

  assert.deepEqual(out.map((candidate) => candidate.path), ["facts/superseded.md"]);
  assert.deepEqual(optionsSeen, { allowArchived: true });
});

test("query-aware fallback overfetches scoped candidates before exclusion", async () => {
  // The scoped candidate order puts the NON-recallable meeting record FIRST;
  // capping the scoped fetch to the caller's limit (1) BEFORE the generic-recall
  // exclusion would return only the meeting record, which is then filtered out —
  // dropping facts/a.md with no refill. Overfetching the full candidate set first
  // and excluding afterward must still surface the recallable hit at the cap.
  const coordinator = queryAwareFallbackCoordinator([
    result("default", MEETING_RECORD),
    result("default", "facts/a.md"),
  ]);
  const out = await coordinator.searchQueryAwareFallback(
    "quarterly",
    1,
    prefilter([MEETING_RECORD, "facts/a.md"]),
  );
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "an excluded-first seed must not starve the result of a recallable hit at the cap",
  );
});


function hotSeedCoordinator(seed: QmdSearchResult[]): RecallSearchPipelineCoordinator {
  const deps = {
    config: { memoryDir: "/mem", qmdSearchStrategy: "lex", searchBackend: "qmd" },
    qmd: {},
    searchScopedMemoryCandidates: scopedCandidatesStub(seed),
    searchAcrossNamespaces: async () => [],
    namespaceFromPath: () => "default",
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

test("finding 1 (round-4) — hot QMD seed path overfetches scoped seeds before exclusion", async () => {
  // The query-aware candidate order puts the NON-recallable meeting record FIRST.
  // The hot seed fetch previously capped the scoped fetch to qmdFetchLimit (1)
  // BEFORE the generic-recall exclusion, so the sole fetched seed was the meeting
  // record — filtered out, dropping facts/a.md with no refill. Overfetching the
  // full candidate set and excluding afterward must still surface the recallable
  // hit at the cap.
  const coordinator = hotSeedCoordinator([
    result("default", MEETING_RECORD),
    result("default", "facts/a.md"),
  ]);
  const out = await coordinator.fetchQmdMemoryResultsWithArtifactTopUp("quarterly", 1, 1, {
    namespacesEnabled: false,
    recallNamespaces: ["default"],
    resolveNamespace: () => "default",
    queryAwarePrefilter: prefilter([MEETING_RECORD, "facts/a.md"]),
  });
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "an excluded-first candidate must not starve the hot seed of a recallable hit at the cap",
  );
});

function resultScored(namespace: string, path: string, score: number): QmdSearchResult {
  return { docid: `${namespace}:${path}`, namespace, path, score, snippet: path };
}

function meetingRecordPath(hash: string): string {
  return `meetings/2026-03-10/mtg-2026-03-10-${hash}.md`;
}

function starvedPrimaryCoordinator(
  seed: QmdSearchResult[],
  primary: QmdSearchResult[],
): RecallSearchPipelineCoordinator {
  const deps = {
    config: { memoryDir: "/mem", qmdSearchStrategy: "lex", searchBackend: "qmd" },
    qmd: {},
    searchScopedMemoryCandidates: scopedCandidatesStub(seed),
    // Faithful to the QMD backend: cap the primary hits to the requested budget.
    searchAcrossNamespaces: async ({ maxResults }: { maxResults: number }) =>
      [...primary].sort((a, b) => b.score - a.score).slice(0, Math.max(0, maxResults)),
    namespaceFromPath: () => "default",
  } as unknown as RecallSearchPipelineDeps;
  return new RecallSearchPipelineCoordinator(deps);
}

test("finding 1 (round-5) — excluded seeds must not fill the merge cap and starve a primary hit", async () => {
  // Excluded meeting records dominate the query-aware SEED set (higher score),
  // while the sole recallable memory arrives from the PRIMARY QMD search — so the
  // scoped-seed overfetch fix and the seed-derived `bestFiltered` fallback cannot
  // rescue it. The seed MERGE `[...seeds, ...primary]` capped to fetchLimit BEFORE
  // filterRecallCandidates ran, so every cap slot (even after the two-attempt
  // fetchLimit growth) went to meeting records later filtered out — dropping
  // facts/a.md with no refill. Excluding non-recallable paths BEFORE the cap must
  // let the primary hit survive at qmdFetchLimit=1.
  const meetings = [
    "aaaaaaaa",
    "bbbbbbbb",
    "cccccccc",
    "dddddddd",
    "eeeeeeee",
    "ffffffff",
  ].map((h) => resultScored("default", meetingRecordPath(h), 2));
  const coordinator = starvedPrimaryCoordinator(meetings, [
    resultScored("default", "facts/a.md", 1),
  ]);
  const out = await coordinator.fetchQmdMemoryResultsWithArtifactTopUp("quarterly", 1, 1, {
    namespacesEnabled: false,
    recallNamespaces: ["default"],
    resolveNamespace: () => "default",
    queryAwarePrefilter: prefilter(meetings.map((m) => m.path)),
  });
  assert.deepEqual(
    out.map((r) => r.path),
    ["facts/a.md"],
    "excluded seeds ranked ahead must not fill the fetchLimit cap and starve the recallable primary hit",
  );
});
