import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseConfig } from "../../config.js";
import type { EmbeddingFallback } from "../../embedding-fallback.js";
import {
  type PrefilterAndArtifactDeps,
  buildQueryAwarePrefilter,
  fetchActiveArtifactsForNamespace,
  searchEmbeddingFallback,
  searchQueryAwareFallback,
} from "../../orchestration/recall-search-prefilter.js";
import type { QueryAwarePrefilter } from "../../orchestrator.js";
import { StorageManager } from "../../storage.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { cleanupDir, mkTempMemoryDir } from "../orchestrator-lite.js";

interface RecallSearchPrefilterState {
  memoryDir: string;
  config: PluginConfig;
  storage: StorageManager;
  fetchLimitsSeen: number[];
  activeArtifactsResult?: MemoryFile[];
  prefilterResult?: QueryAwarePrefilter;
  prefilterOverflowResult?: QueryAwarePrefilter;
  embeddingResult?: QmdSearchResult[];
  embeddingDisabledResult?: QmdSearchResult[];
  queryAwareFallbackResult?: QmdSearchResult[];
  queryAwareFallbackEmptyResult?: QmdSearchResult[];
  scopedOptionsSeen?: { allowArchived?: boolean };
  scopedNamespacesSeen?: string[];
}

const subject: LifecycleSubject<RecallSearchPrefilterState> = {
  appliesTo(row: MatrixRow): boolean | string {
    if (row.id === "explicit-provider-identity" || row.id === "restart-reload-recovery") {
      return true;
    }
    return `recall search prefilter helper pipeline has no ${row.id} session/flush/dedupe semantics to realize`;
  },

  async setup(row: MatrixRow): Promise<RecallSearchPrefilterState> {
    const memoryDir = await mkTempMemoryDir(`recall-search-prefilter-${row.id}`);
    try {
      const config = parseConfig({
        memoryDir,
        queryAwareIndexingEnabled: true,
        queryAwareIndexingMaxCandidates: 100,
        embeddingFallbackEnabled: true,
      });
      const storage = new StorageManager(memoryDir);
      return {
        memoryDir,
        config,
        storage,
        fetchLimitsSeen: [],
      };
    } catch (error) {
      await cleanupDir(memoryDir);
      throw error;
    }
  },

  async exercise(state: RecallSearchPrefilterState, row: MatrixRow): Promise<void> {
    await state.storage.ensureDirectories();
    const stateDir = path.join(state.memoryDir, "state");
    await mkdir(stateDir, { recursive: true });

    await writeFile(
      path.join(stateDir, "index_tags.json"),
      JSON.stringify({
        version: 2,
        tags: {
          review: { paths: ["facts/a.md", "facts/b.md"] },
          report: { paths: ["facts/b.md", "facts/c.md"] },
        },
        aliases: {},
      }),
      "utf8"
    );
    await writeFile(
      path.join(stateDir, "index_time.json"),
      JSON.stringify({
        version: 2,
        dates: {
          "2026-07-31": ["facts/a.md"],
        },
        events: {},
      }),
      "utf8"
    );

    const writtenMem = await state.storage.writeMemory(
      "fact",
      "Embedding fallback test memory content for hydration verification.",
      { source: "test-source" }
    );
    const memFile = await state.storage.getMemoryById(writtenMem.id);
    assert.ok(memFile, "stored memory file must exist for embedding test");
    const memPath = memFile.path;

    if (row.dimensions.restart) {
      state.storage = new StorageManager(state.memoryDir);
    }

    const mockArtifacts: MemoryFile[] = [
      {
        path: "artifacts/stale.md",
        content: "stale artifact",
        frontmatter: { sourceMemoryId: "src-stale" },
      } as unknown as MemoryFile,
      {
        path: "artifacts/active1.md",
        content: "active artifact 1",
        frontmatter: { sourceMemoryId: "src-active1" },
      } as unknown as MemoryFile,
      {
        path: "artifacts/active2.md",
        content: "active artifact 2",
        frontmatter: { sourceMemoryId: "src-active2" },
      } as unknown as MemoryFile,
      {
        path: "artifacts/missing.md",
        content: "missing artifact",
        frontmatter: { sourceMemoryId: "src-missing" },
      } as unknown as MemoryFile,
    ];

    const storageRouter = {
      storageFor: async () =>
        ({
          searchArtifacts: async (_prompt: string, limit: number) => {
            state.fetchLimitsSeen.push(limit);
            if (state.fetchLimitsSeen.length === 1) {
              return [mockArtifacts[1], ...Array.from({ length: limit - 1 }, () => mockArtifacts[0])];
            }
            return mockArtifacts;
          },
        }) as unknown as StorageManager,
    } as unknown as PrefilterAndArtifactDeps["storageRouter"];

    const resolveArtifactSourceStatuses = async (
      _stg: unknown,
      sourceIds: string[]
    ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">> => {
      const map = new Map<string, "active" | "superseded" | "archived" | "missing">();
      for (const id of sourceIds) {
        if (id === "src-stale") map.set(id, "superseded");
        else if (id === "src-active1" || id === "src-active2") map.set(id, "active");
        else if (id === "src-missing") map.set(id, "missing");
      }
      return map;
    };

    state.activeArtifactsResult = await fetchActiveArtifactsForNamespace(
      {
        storageRouter,
        resolveArtifactSourceStatuses,
      },
      "default",
      "artifact prompt",
      2
    );

    const scopeQueryAwarePaths = (paths: Set<string> | null, namespaces: string[]): Set<string> | null => {
      state.scopedNamespacesSeen = namespaces;
      return paths;
    };

    state.prefilterResult = await buildQueryAwarePrefilter(
      {
        config: state.config,
        scopeQueryAwarePaths,
      },
      "2026-07-31 #review quarterly report",
      ["default"]
    );

    const overflowConfig = parseConfig({
      memoryDir: state.memoryDir,
      queryAwareIndexingEnabled: true,
      queryAwareIndexingMaxCandidates: 1,
    });

    state.prefilterOverflowResult = await buildQueryAwarePrefilter(
      {
        config: overflowConfig,
        scopeQueryAwarePaths,
      },
      "#review quarterly report",
      ["default"]
    );

    const embeddingFallback: EmbeddingFallback = {
      isAvailable: async () => true,
      search: async (_query: string, _limit: number) => [
        {
          id: "emb-hit-1",
          path: memPath,
          score: 0.95,
        },
      ],
    } as unknown as EmbeddingFallback;

    state.embeddingResult = await searchEmbeddingFallback(
      {
        config: state.config,
        embeddingFallback,
        storage: state.storage,
      },
      "hydration query",
      5
    );

    const disabledConfig = parseConfig({
      memoryDir: state.memoryDir,
      embeddingFallbackEnabled: false,
    });

    state.embeddingDisabledResult = await searchEmbeddingFallback(
      {
        config: disabledConfig,
        embeddingFallback,
        storage: state.storage,
      },
      "hydration query",
      5
    );

    const meetingRecordPath = "meetings/2026-03-10/mtg-2026-03-10-abcdef01.md";
    const recallablePath = "facts/quarterly-report.md";

    const searchScopedMemoryCandidates = async (
      candidatePaths: Set<string>,
      _query: string,
      limit: number,
      options?: { allowArchived?: boolean }
    ): Promise<QmdSearchResult[]> => {
      state.scopedOptionsSeen = options;
      const all: QmdSearchResult[] = [
        { docid: "doc-mtg", path: meetingRecordPath, score: 0.99, snippet: "meeting" },
        { docid: "doc-fact", path: recallablePath, score: 0.88, snippet: "fact" },
      ];
      return all.filter((item) => candidatePaths.has(item.path)).slice(0, limit);
    };

    const prefilterForFallback: QueryAwarePrefilter = {
      candidatePaths: new Set([meetingRecordPath, recallablePath]),
      temporalFromDate: null,
      matchedTags: ["review"],
      expandedTags: ["review"],
      combination: "tag",
      filteredToFullSearch: false,
    };

    state.queryAwareFallbackResult = await searchQueryAwareFallback(
      {
        config: state.config,
        searchScopedMemoryCandidates,
      },
      "quarterly",
      1,
      prefilterForFallback
    );

    state.queryAwareFallbackEmptyResult = await searchQueryAwareFallback(
      {
        config: state.config,
        searchScopedMemoryCandidates,
      },
      "quarterly",
      0,
      prefilterForFallback
    );
  },

  async invariants(state: RecallSearchPrefilterState, _row: MatrixRow): Promise<void> {
    assert.ok(state.activeArtifactsResult, "activeArtifactsResult must be populated");
    assert.equal(state.activeArtifactsResult.length, 2, "must adaptively retrieve targetCount active artifacts");
    assert.deepEqual(
      state.activeArtifactsResult.map((a) => a.path),
      ["artifacts/active1.md", "artifacts/active2.md"],
      "must filter out stale and missing source artifacts"
    );
    assert.ok(
      state.fetchLimitsSeen.length > 1,
      "must attempt top-up with grown fetch limit when initial results yield fewer active artifacts than targetCount"
    );
    assert.ok(
      state.fetchLimitsSeen[1] > state.fetchLimitsSeen[0],
      "fetchLimit must adaptively increase across top-up attempts"
    );

    assert.ok(state.prefilterResult, "prefilterResult must be populated");
    assert.ok(state.prefilterResult.matchedTags.includes("review"), "must extract matched tags from prompt");
    assert.ok(
      state.prefilterResult.candidatePaths instanceof Set,
      "candidatePaths must be a Set when candidate count <= maxCandidates"
    );
    assert.equal(state.prefilterResult.filteredToFullSearch, false, "must not set filteredToFullSearch when under cap");
    assert.equal(
      state.prefilterResult.temporalFromDate,
      "2026-07-31",
      "must combine temporal and tag prefilter inputs"
    );
    assert.deepEqual(
      state.prefilterResult.candidatePaths,
      new Set(["facts/a.md"]),
      "must intersect temporal and tag candidates"
    );
    assert.deepEqual(state.scopedNamespacesSeen, ["default"], "must scope query-aware paths to the recall namespaces");

    assert.ok(state.prefilterOverflowResult, "prefilterOverflowResult must be populated");
    assert.equal(
      state.prefilterOverflowResult.candidatePaths,
      null,
      "candidatePaths must be reset to null when exceeding maxCandidates"
    );
    assert.equal(
      state.prefilterOverflowResult.filteredToFullSearch,
      true,
      "filteredToFullSearch must be true when candidates exceed maxCandidates"
    );

    assert.ok(state.embeddingResult, "embeddingResult must be populated");
    assert.equal(state.embeddingResult.length, 1, "must return hydrated search hit");
    assert.equal(state.embeddingResult[0].docid, "emb-hit-1");
    assert.equal(state.embeddingResult[0].score, 0.95);
    assert.match(
      state.embeddingResult[0].snippet,
      /Embedding fallback test memory content for hydration verification/,
      "must hydrate memory content into search snippet"
    );

    assert.ok(state.embeddingDisabledResult, "embeddingDisabledResult must be populated");
    assert.deepEqual(
      state.embeddingDisabledResult,
      [],
      "must return empty array when embeddingFallback capability is disabled"
    );

    assert.ok(state.queryAwareFallbackResult, "queryAwareFallbackResult must be populated");
    assert.equal(state.queryAwareFallbackResult.length, 1, "must respect result limit cap");
    assert.equal(
      state.queryAwareFallbackResult[0].path,
      "facts/quarterly-report.md",
      "must exclude meeting record before applying result cap so valid candidate is returned at the cap"
    );
    assert.deepEqual(
      state.scopedOptionsSeen,
      { allowArchived: true },
      "must request allowArchived when searching candidate paths for historical filtering"
    );

    assert.deepEqual(state.queryAwareFallbackEmptyResult, [], "must return empty array when limit is zero");
  },

  async teardown(state: RecallSearchPrefilterState): Promise<void> {
    await cleanupDir(state.memoryDir);
  },
};

runLifecycleMatrix("recall-search-prefilter", subject);
