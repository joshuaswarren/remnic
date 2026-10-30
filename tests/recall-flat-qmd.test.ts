import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "@remnic/core/config";
import type { PluginConfig } from "@remnic/core/types";
import { Orchestrator, type QueryAwarePrefilter } from "@remnic/core/orchestrator";
import type { QmdSearchResult } from "@remnic/core/types";
import type { StorageManager } from "@remnic/core";
import type { SearchBackend } from "@remnic/core/search/port";
import type { RecallSearchPipelineCoordinator } from "@remnic/core/orchestration/recall-search-pipeline";
import type { NamespaceSearchRouter } from "@remnic/core/namespaces/search";

// Exercise the orchestrator's private delegates with a typed test-only view.
type FlatRecallHarness = Pick<RecallSearchPipelineCoordinator,
  "fetchQmdMemoryResultsWithArtifactTopUp" | "filterSearchResultsForRecall"> & {
  storage: StorageManager;
  qmd: Pick<SearchBackend, "search" | "hybridSearch">;
  namespaceSearchRouter: Pick<NamespaceSearchRouter, "searchAcrossNamespaces">;
  formatQmdResults(title: string, results: QmdSearchResult[]): string;
};

function isFlatRecallHarness(value: Orchestrator | FlatRecallHarness): value is FlatRecallHarness {
  return ["storage", "qmd", "namespaceSearchRouter", "fetchQmdMemoryResultsWithArtifactTopUp", "filterSearchResultsForRecall", "formatQmdResults"]
    .every((member) => member in value);
}

/** The orchestrator seen through the members these tests drive; fails loudly if one is renamed. */
function flatHarness(cfg: PluginConfig): FlatRecallHarness {
  const orchestrator: Orchestrator | FlatRecallHarness = new Orchestrator(cfg);
  if (!isFlatRecallHarness(orchestrator)) throw new Error("Orchestrator no longer exposes the flat recall members under test");
  return orchestrator;
}

const EMPTY_PREFILTER: QueryAwarePrefilter = {
  candidatePaths: null,
  temporalFromDate: null,
  matchedTags: [],
  expandedTags: [],
  combination: "none",
  filteredToFullSearch: false,
};
const RAW_CHUNK = "23: @@ -22,4 @@\n24: contentHash: metadata-not-memory-body";

for (const explicitCollection of [false, true]) {
  test(`flat QMD ${explicitCollection ? "explicit collection" : "namespace fanout bypass"} preserves candidate union and merges native identity (#3194)`, async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flat-qmd-"));
    try {
      const cfg = parseConfig({ memoryDir, namespacesEnabled: false, qmdSearchStrategy: "lex-vec" });
      // Pin the Oct 19 recall budgets: this fix must never buy correctness by timing out earlier.
      assert.deepEqual(
        [cfg.recallOuterTimeoutMs, cfg.recallCoreDeadlineMs, cfg.recallEnrichmentDeadlineMs, cfg.qmdDaemonTimeoutMs],
        [75_000, 75_000, 60_000, 60_000],
      );
      const orchestrator = flatHarness(cfg);
      const memories = await Promise.all(["shared", "qmd-only", "native-only", "hybrid-only"].map(async (label) => {
        const { id } = await orchestrator.storage.writeMemory("fact", `Recall regression ${label} body.`);
        const memory = await orchestrator.storage.getMemoryById(id);
        assert.ok(memory);
        return memory;
      }));
      assert.ok(memories.every(Boolean));
      const [shared, qmdOnly, nativeOnly, hybridOnly] = memories;
      const relative = (p: string) => path.relative(memoryDir, p).split(path.sep).join("/");
      const hit = (docid: string, p: string, score: number): QmdSearchResult => ({
        docid, path: p, score, snippet: RAW_CHUNK, line: 23, transport: "daemon",
      });
      const primary = [
        hit("qmd-shared", `${cfg.qmdCollection}/${relative(shared.path)}`, 1.01),
        hit("qmd-only", `qmd://${cfg.qmdCollection}/${relative(qmdOnly.path)}`, 0.9),
        hit("stale", `${cfg.qmdCollection}/facts/stale.md`, 0.5),
      ];
      const hybrid = [hit("hybrid", `${cfg.qmdCollection}/${relative(hybridOnly.path)}`, 0.8)];
      const calls: unknown[][] = [];
      const controller = new AbortController();
      const onDegradation = () => {};
      const searchOptions = { explain: true, candidateLimit: 96, rerank: false };
      orchestrator.qmd = {
        search: async (...args: unknown[]) => { calls.push(["search", ...args]); return primary; },
        hybridSearch: async (...args: unknown[]) => { calls.push(["hybrid", ...args]); return hybrid; },
      };
      const seedPaths = new Set<string>([shared.path, nativeOnly.path]);
      const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp("Recall regression", 8, 12, {
        namespacesEnabled: false,
        recallNamespaces: ["default"],
        resolveNamespace: () => "default",
        collection: explicitCollection ? cfg.qmdCollection : undefined,
        queryAwarePrefilter: { ...EMPTY_PREFILTER, candidatePaths: seedPaths },
        searchOptions,
        abortSignal: controller.signal,
        onDegradation,
      });
      const execution = { signal: controller.signal, onDegradation };
      const collection = explicitCollection ? cfg.qmdCollection : undefined;
      assert.deepEqual(calls, [
        ["search", "Recall regression", collection, 12, searchOptions, execution],
        ["hybrid", "Recall regression", collection, 12, execution],
      ], "both sources, collection selection, candidate headroom, search hints and cancellation are unchanged");
      assert.deepEqual([...seedPaths].sort(), [shared.path, nativeOnly.path].sort());
      assert.deepEqual(results.map((r: QmdSearchResult) => r.path).sort(),
        [...memories.map((m) => m.path), path.join(memoryDir, "facts/stale.md")].sort(),
        "every unique primary, hybrid and native candidate survives, including unresolved hits");
      assert.equal(results.filter((r: QmdSearchResult) => r.path === shared.path).length, 1);
      assert.equal(results.find((r: QmdSearchResult) => r.path === shared.path)?.score, 1.01);
      assert.equal(controller.signal.aborted, false);
      assert.equal(primary[0].path.startsWith(cfg.qmdCollection + "/"), true, "backend hits are not mutated");
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
}

test("flat QMD-only hits render hydrated memory bodies, not front matter or chunk line markers (#3194)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flat-render-"));
  try {
    const cfg = parseConfig({ memoryDir, namespacesEnabled: false });
    const orchestrator = flatHarness(cfg);
    const { id } = await orchestrator.storage.writeMemory("preference", "Prefer a concise memory body over YAML metadata.");
    const memory = await orchestrator.storage.getMemoryById(id);
    assert.ok(memory);
    // Use the canonical absolute identity to test rendering independently of path normalization.
    const input = [{ docid: "qmd-hash", path: memory.path, snippet: RAW_CHUNK, line: 23, score: 1 }];
    const filtered = await orchestrator.filterSearchResultsForRecall(input, undefined, { recallNamespaces: ["default"] });
    assert.equal(filtered.results.length, 1);
    assert.equal(filtered.memoryByPath.size, 1);
    const rendered = orchestrator.formatQmdResults("Relevant Memories", filtered.results);
    assert.match(rendered, /Prefer a concise memory body over YAML metadata\./);
    assert.doesNotMatch(rendered, /contentHash|@@|metadata-not-memory-body|\.md:23/);
    assert.equal(input[0].snippet, RAW_CHUNK, "cached backend chunks are not mutated");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

for (const budget of [undefined, 90_000, 0]) {
  test(`flat QMD retains primary and hybrid candidates until the original ${budget ?? "default"} deadline (#3194)`, async (t) => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flat-budget-"));
    try {
      const cfg = parseConfig({ memoryDir, namespacesEnabled: false, recallEnrichmentDeadlineMs: budget });
      const orchestrator = flatHarness(cfg);
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const lateElapsed = budget === 0 ? 120_000 : (budget ?? 60_000) - 1;
      const methods: string[] = [];
      orchestrator.qmd = {
        search: async (_query, _collection, limit, _options, execution) => {
          assert.equal(limit, 12);
          assert.equal(execution?.signal?.aborted, false);
          methods.push("primary");
          now += lateElapsed;
          return [{ docid: "late-primary", path: `${cfg.qmdCollection}/facts/primary.md`, snippet: "primary", score: 1 }];
        },
        hybridSearch: async (_query, _collection, limit, execution) => {
          assert.equal(limit, 12);
          assert.equal(execution?.signal?.aborted, false);
          methods.push("hybrid");
          return [{ docid: "late-hybrid", path: `${cfg.qmdCollection}/facts/hybrid.md`, snippet: "hybrid", score: 0.9 }];
        },
      };
      const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp("late recall", 8, 12, {
        namespacesEnabled: false,
        recallNamespaces: ["default"],
        resolveNamespace: () => "default",
        collection: cfg.qmdCollection,
        queryAwarePrefilter: EMPTY_PREFILTER,
        abortSignal: new AbortController().signal,
      });
      assert.deepEqual(methods, ["primary", "hybrid"], "no shorter internal budget may suppress hybrid recall");
      assert.deepEqual(results.map((r) => r.path).sort(),
        ["hybrid", "primary"].map((name) => path.join(memoryDir, `facts/${name}.md`)));
      assert.equal(cfg.recallEnrichmentDeadlineMs, budget ?? 60_000);
    } finally {
      t.mock.restoreAll();
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
}

test("namespaced recall keeps every namespace candidate and its fanout options (#3194)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-namespace-parity-"));
  try {
    const cfg = parseConfig({ memoryDir, namespacesEnabled: true });
    const orchestrator = flatHarness(cfg);
    const namespaces = ["team-a", "team-b"];
    const hits = namespaces.map((namespace) => ({
      docid: namespace, namespace, path: path.join(memoryDir, "namespaces", namespace, "facts/same.md"),
      score: 1, snippet: namespace, transport: "daemon" as const,
    }));
    const controller = new AbortController();
    const searchOptions = { candidateLimit: 96, explain: true };
    let calls = 0;
    orchestrator.qmd = {
      search: async () => { throw new Error("namespace fanout must not use flat search"); },
      hybridSearch: async () => { throw new Error("namespace fanout must not use flat hybrid"); },
    };
    orchestrator.namespaceSearchRouter = {
      searchAcrossNamespaces: async (options) => {
        calls += 1;
        assert.deepEqual(options, {
          query: "namespace parity", namespaces, maxResults: 12,
          mode: calls === 1 ? "search" : "hybrid",
          searchOptions: calls === 1 ? searchOptions : undefined,
          execution: { signal: controller.signal, onDegradation: undefined },
        });
        return hits;
      },
    };
    const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp("namespace parity", 8, 12, {
      namespacesEnabled: true, recallNamespaces: namespaces,
      resolveNamespace: (p) => p.includes("team-a") ? "team-a" : "team-b",
      queryAwarePrefilter: EMPTY_PREFILTER, searchOptions, abortSignal: controller.signal,
    });
    assert.equal(calls, 2);
    assert.deepEqual(results, hits);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("namespaces on: an explicit flat collection keeps its hit paths and the QMD snippet (#3194 guards)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-namespace-guard-"));
  try {
    const cfg = parseConfig({ memoryDir, namespacesEnabled: true });
    const orchestrator = flatHarness(cfg);
    // Search side: the path normalizer must leave namespace mode alone even for the primary collection.
    const hit = { docid: "same", path: `${cfg.qmdCollection}/facts/same.md`, score: 1, snippet: "qmd snippet" };
    orchestrator.qmd = { search: async () => [hit], hybridSearch: async () => [] };
    const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp("guard", 8, 12, {
      namespacesEnabled: true, recallNamespaces: ["default"], resolveNamespace: () => "default",
      collection: cfg.qmdCollection, queryAwarePrefilter: EMPTY_PREFILTER,
      searchOptions: { candidateLimit: 96, explain: true },
    });
    assert.deepEqual(results.map((r) => r.path), [hit.path], "namespace-mode hit paths are not rewritten");

    // Render side: a hydrated memory in namespace mode keeps QMD's snippet (the stored body is for flat recall only).
    const { id } = await orchestrator.storage.writeMemory("preference", "Stored body that flat recall would render.");
    const memory = await orchestrator.storage.getMemoryById(id);
    assert.ok(memory);
    const input = [{ docid: "qmd-hash", path: memory.path, snippet: "qmd snippet for the namespaced row", line: 7, score: 1 }];
    const filtered = await orchestrator.filterSearchResultsForRecall(input, undefined, { recallNamespaces: ["default"] });
    assert.equal(filtered.results.length, 1);
    assert.equal(filtered.results[0]?.snippet, "qmd snippet for the namespaced row");
    assert.equal(filtered.results[0]?.line, 7);
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("flat explicit cold and foreign collections retain their candidates and collection selection (#3194)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-collection-parity-"));
  try {
    const cfg = parseConfig({ memoryDir, namespacesEnabled: false });
    const orchestrator = flatHarness(cfg);
    for (const collection of [cfg.qmdColdCollection, "external-notes"]) {
      assert.ok(collection);
      const hit = { docid: collection, path: `${collection}/facts/same.md`, score: 1, snippet: collection };
      const calls: string[] = [];
      orchestrator.qmd = {
        search: async (_query, selected, limit) => {
          assert.equal(selected, collection);
          assert.equal(limit, 12);
          calls.push("primary");
          return [hit];
        },
        hybridSearch: async (_query, selected, limit) => {
          assert.equal(selected, collection);
          assert.equal(limit, 12);
          calls.push("hybrid");
          return [hit];
        },
      };
      const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp("collection parity", 8, 12, {
        namespacesEnabled: false, recallNamespaces: ["default"], resolveNamespace: () => "default",
        collection, queryAwarePrefilter: EMPTY_PREFILTER,
      });
      assert.deepEqual(calls, ["primary", "hybrid"]);
      assert.deepEqual(results.map((r) => [r.docid, r.path]), [[hit.docid, hit.path]]);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
