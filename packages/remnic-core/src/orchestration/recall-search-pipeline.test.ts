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

async function makeCoordinator(
  memoryDir: string,
  extractionScopeClassificationEnabled = true,
): Promise<RecallSearchPipelineCoordinator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespaces: true,
    extractionScopeClassificationEnabled,
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

test("recall safety derives sourceConnector exclusively from the hydrated memory (#2183)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-conn-prov-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    // Both results arrive carrying an UNTRUSTED sourceConnector (e.g. a remote
    // search backend casting arbitrary response objects). One's memory carries
    // a real connector; the other's memory is connectorless.
    const has = { ...result("default", "facts/has.md"), sourceConnector: "untrusted" };
    const none = { ...result("default", "facts/none.md"), sourceConnector: "untrusted" };
    const memHas = {
      path: "facts/has.md",
      content: "facts/has.md",
      frontmatter: { status: "active", memoryKind: "fact", created: "2026-07-19T00:00:00.000Z", updated: "2026-07-19T00:00:00.000Z", sourceConnector: "trusted-pi" } as unknown as MemoryFile["frontmatter"],
    };
    const memNone = {
      path: "facts/none.md",
      content: "facts/none.md",
      frontmatter: { status: "active", memoryKind: "fact", created: "2026-07-19T00:00:00.000Z", updated: "2026-07-19T00:00:00.000Z" } as unknown as MemoryFile["frontmatter"],
    };
    const memoryByPath = new Map<string, MemoryFile>([
      ["default\0facts/has.md", memHas],
      ["default\0facts/none.md", memNone],
    ]);
    const safe = coordinator.filterSearchResultsByRecallSafety([has, none], memoryByPath);
    const byPath = new Map(safe.map((r) => [r.path, r.sourceConnector]));
    assert.equal(byPath.get("facts/has.md"), "trusted-pi", "an untrusted result-supplied value is overwritten by the memory's connector");
    assert.equal(byPath.get("facts/none.md"), undefined, "an untrusted value is cleared when the memory is connectorless");
    // The shared/cached input objects are never mutated.
    assert.equal(has.sourceConnector, "untrusted", "the input result object is not mutated (copy semantics, no cross-recall leak)");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recall safety keeps support passport records out of generic recall", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-passport-recall-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const card = {
      path: "preferences/support-card.md",
      content: "Give me time to answer.",
      frontmatter: {
        status: "active",
        tags: ["support-passport-card"],
        created: "2026-07-19T00:00:00.000Z",
        updated: "2026-07-19T00:00:00.000Z",
      },
    } as unknown as MemoryFile;
    const audit = {
      path: "corrections/support-card-audit.md",
      content: "Superseded: Give me time to answer.",
      frontmatter: {
        status: "active",
        tags: ["support-passport-audit"],
        created: "2026-07-19T00:00:00.000Z",
        updated: "2026-07-19T00:00:00.000Z",
      },
    } as unknown as MemoryFile;
    const candidates = [result("default", card.path), result("default", audit.path)];
    const memoryByPath = new Map([
      [`default\0${card.path}`, card],
      [`default\0${audit.path}`, audit],
    ]);

    assert.deepEqual(coordinator.filterSearchResultsByRecallSafety(candidates, memoryByPath), []);
    assert.deepEqual(
      coordinator.filterSearchResultsByRecallSafety(candidates, memoryByPath, { allowDedicatedSurface: true }),
      [],
      "a generic-recall override must not disclose owner-controlled support records",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recall safety partitions tool-scoped memories by requesting connector", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-connector-partition-"));
  try {
    const coordinator = await makeCoordinator(memoryDir);
    const memories = [
      {
        path: "facts/same-tool.md",
        content: "Use the search tool with a path.",
        frontmatter: { status: "active", sourceConnector: "chatgpt", toolScoped: true },
      },
      {
        path: "facts/other-tool.md",
        content: "Use the search tool with a path.",
        frontmatter: { status: "active", sourceConnector: "pi", toolScoped: true },
      },
      {
        path: "facts/portable.md",
        content: "Prefer focused searches.",
        frontmatter: { status: "active", sourceConnector: "pi" },
      },
      {
        path: "facts/legacy.md",
        content: "Use the search tool with a path.",
        frontmatter: { status: "active", sourceConnector: "pi" },
      },
      {
        path: "facts/unattributed-tool.md",
        content: "Use the search tool with a path.",
        frontmatter: { status: "active", toolScoped: true },
      },
    ] as unknown as MemoryFile[];
    const results = memories.map((candidate, index) => ({
      ...result("default", candidate.path),
      ...(index === 1 ? { sourceConnector: "chatgpt" } : {}),
    }));
    const memoryByPath = new Map(
      memories.map((candidate) => [`default\0${candidate.path}`, candidate]),
    );

    const safe = coordinator.filterSearchResultsByRecallSafety(results, memoryByPath, {
      requestingConnector: "chatgpt",
    });

    assert.deepEqual(
      safe.map((candidate) => candidate.path),
      [
        "facts/same-tool.md",
        "facts/portable.md",
        "facts/legacy.md",
        "facts/unattributed-tool.md",
      ],
    );
    assert.equal(safe[0]?.sourceConnector, "chatgpt");
    assert.equal(results[1]?.sourceConnector, "chatgpt");
    assert.equal(
      coordinator.filterSearchResultsByRecallSafety(results, memoryByPath).length,
      results.length,
    );
    const gateDisabled = await makeCoordinator(memoryDir, false);
    assert.equal(
      gateDisabled.filterSearchResultsByRecallSafety(results, memoryByPath, {
        requestingConnector: "chatgpt",
      }).length,
      results.length,
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

test("QMD widening continues past archive-only pages", async () => {
  const archived = Array.from({ length: 45 }, (_, index) =>
    resultScored("default", `archive/2026-07-25/archive-${index}.md`, 2),
  );
  const live = resultScored("default", "facts/live.md", 1);
  const ranked = [...archived, live];
  const coordinator = new RecallSearchPipelineCoordinator({
    config: { memoryDir: "/mem", qmdSearchStrategy: "lex", searchBackend: "qmd" },
    qmd: {},
    namespaceFromPath: () => "default",
    searchAcrossNamespaces: async ({ maxResults }: { maxResults: number }) =>
      ranked.slice(0, maxResults),
  } as unknown as RecallSearchPipelineDeps);

  const out = await coordinator.fetchQmdMemoryResultsWithArtifactTopUp(
    "archive-starved",
    20,
    20,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      queryAwarePrefilter: {
        candidatePaths: null,
        temporalFromDate: null,
        matchedTags: [],
        expandedTags: [],
        combination: "none",
        filteredToFullSearch: false,
      },
    },
  );

  assert.deepEqual(out.map((candidate) => candidate.path), ["facts/live.md"]);
});

test("QMD hybrid top-up runs when primary results are archive-only", async () => {
  const archived = Array.from({ length: 20 }, (_, index) =>
    resultScored("default", `archive/2026-07-25/archive-${index}.md`, 2),
  );
  const live = resultScored("default", "facts/hybrid-live.md", 1);
  let hybridCalls = 0;
  const coordinator = new RecallSearchPipelineCoordinator({
    config: {
      memoryDir: "/mem",
      qmdSearchStrategy: "hybrid",
      searchBackend: "qmd",
    },
    qmd: {
      search: async (
        _query: string,
        _collection: string,
        maxResults: number,
      ) => archived.slice(0, maxResults),
      hybridSearch: async () => {
        hybridCalls += 1;
        return [live];
      },
    },
    namespaceFromPath: () => "default",
  } as unknown as RecallSearchPipelineDeps);

  const out = await coordinator.fetchQmdMemoryResultsWithArtifactTopUp(
    "archive-starved-hybrid",
    2,
    2,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: {
        candidatePaths: null,
        temporalFromDate: null,
        matchedTags: [],
        expandedTags: [],
        combination: "none",
        filteredToFullSearch: false,
      },
    },
  );

  assert.ok(hybridCalls > 0, "archive-only primary pages must trigger hybrid top-up");
  assert.deepEqual(out.map((candidate) => candidate.path), ["facts/hybrid-live.md"]);
});

test("QMD stops after an underfilled archive-only page", async () => {
  const archived = [resultScored("default", "archive/2026-07-25/only.md", 2)];
  let searchCalls = 0;
  const coordinator = new RecallSearchPipelineCoordinator({
    config: {
      memoryDir: "/mem",
      qmdSearchStrategy: "hybrid",
      searchBackend: "qmd",
    },
    qmd: {
      search: async () => {
        searchCalls += 1;
        return archived;
      },
      hybridSearch: async () => [],
    },
    namespaceFromPath: () => "default",
  } as unknown as RecallSearchPipelineDeps);

  const out = await coordinator.fetchQmdMemoryResultsWithArtifactTopUp(
    "archive-underfilled",
    20,
    20,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: {
        candidatePaths: null,
        temporalFromDate: null,
        matchedTags: [],
        expandedTags: [],
        combination: "none",
        filteredToFullSearch: false,
      },
    },
  );

  assert.deepEqual(out, []);
  assert.equal(searchCalls, 1, "an underfilled raw page must not trigger widening");
});
