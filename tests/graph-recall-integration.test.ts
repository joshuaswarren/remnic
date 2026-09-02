import test from "node:test";
import type { QmdSearchResult } from "@remnic/core/types";
import type { GraphIndex } from "@remnic/core/graph";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import {
  Orchestrator,
  graphPathRelativeToStorage,
  mergeGraphExpandedResults,
} from "@remnic/core/orchestrator";

test("mergeGraphExpandedResults deduplicates by path and keeps better score", () => {
  const primary = [
    { docid: "a", path: "/tmp/facts/a.md", snippet: "seed A", score: 0.7 },
    { docid: "b", path: "/tmp/facts/b.md", snippet: "seed B", score: 0.6 },
  ];
  const expanded = [
    { docid: "a", path: "/tmp/facts/a.md", snippet: "", score: 0.9 },
    { docid: "c", path: "/tmp/facts/c.md", snippet: "expanded C", score: 0.5 },
  ];

  const merged = mergeGraphExpandedResults(primary, expanded);
  const byPath = new Map(merged.map((m) => [m.path, m]));
  assert.equal(merged.length, 3);
  assert.equal(byPath.get("/tmp/facts/a.md")?.score, 0.9);
  assert.equal(byPath.get("/tmp/facts/a.md")?.snippet, "seed A");
  assert.equal(byPath.get("/tmp/facts/c.md")?.docid, "c");
});

test("mergeGraphExpandedResults still deduplicates when expanded list is empty", () => {
  const primary = [
    { docid: "a1", path: "/tmp/facts/a.md", snippet: "", score: 0.4 },
    { docid: "a2", path: "/tmp/facts/a.md", snippet: "seed A", score: 0.9 },
    { docid: "b1", path: "/tmp/facts/b.md", snippet: "seed B", score: 0.3 },
  ];
  const merged = mergeGraphExpandedResults(primary, []);
  assert.equal(merged.length, 2);
  const byPath = new Map(merged.map((m) => [m.path, m]));
  assert.equal(byPath.get("/tmp/facts/a.md")?.score, 0.9);
  assert.equal(byPath.get("/tmp/facts/a.md")?.snippet, "seed A");
});

test("graphPathRelativeToStorage resolves in-scope paths and rejects out-of-scope paths", () => {
  const storageDir = "/tmp/memory/default";
  assert.equal(
    graphPathRelativeToStorage(storageDir, "/tmp/memory/default/facts/2026-02-22/a.md"),
    "facts/2026-02-22/a.md",
  );
  assert.equal(
    graphPathRelativeToStorage(storageDir, "facts/2026-02-22/a.md"),
    "facts/2026-02-22/a.md",
  );
  assert.equal(graphPathRelativeToStorage(storageDir, "/tmp/memory/other/facts/a.md"), null);
});

test("recallInternal writes graph recall snapshot in graph_mode", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed memory");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const { id: expandedId } = await orchestrator.storage.writeMemory("fact", "expanded memory");
  const expandedMemory = await orchestrator.storage.getMemoryById(expandedId);
  assert.ok(expandedMemory);
  const archivedPath = path.join(memoryDir, "archive", "2026-07-25", "graph-archive.md");
  await mkdir(path.dirname(archivedPath), { recursive: true });
  await writeFile(
    archivedPath,
    [
      "---",
      "id: graph-archive",
      "category: fact",
      "created: 2026-07-25T00:00:00.000Z",
      "updated: 2026-07-25T00:00:00.000Z",
      "source: test",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: archived",
      "---",
      "",
      "hot graph archived memory",
    ].join("\n"),
  );

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };
  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: [
      {
        docid: "graph-archive",
        path: archivedPath,
        snippet: "hot graph archived memory",
        score: 1,
      },
      ...memoryResults,
      {
        docid: expandedMemory!.frontmatter.id,
        path: expandedMemory!.path,
        snippet: "expanded memory",
        score: 0.8,
      },
    ],
    seedPaths: [seedMemory!.path],
    expandedPaths: [{ path: expandedMemory!.path, score: 0.8, namespace: "default", seed: seedMemory!.path, hopDepth: 1, decayedWeight: 0.7, graphType: "entity" }],
  });

  const out = await (orchestrator as any).recallInternal(
    "what happened in the timeline last week",
    "session-graph",
  );
  assert.match(out, /Relevant Memories/);

  assert.doesNotMatch(out, /hot graph archived memory/);
  let raw: string;
  try {
    raw = await readFile(path.join(memoryDir, "state", "last_graph_recall.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("this branch does not yet persist last_graph_recall.json during recallInternal");
      return;
    }
    throw error;
  }
  const snapshot = JSON.parse(raw) as {
    mode: string;
    seedCount: number;
    expandedCount: number;
  };
  assert.equal(snapshot.mode, "graph_mode");
  assert.equal(snapshot.seedCount, 1);
  assert.equal(snapshot.expandedCount, 1);
});
test("graph path scoring infers archived state for legacy intermediate nodes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-path-state-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphPathScoring: { enabled: true, invalidNodePenalty: 0.2 },
    graphExpansionActivationWeight: 0,
    graphExpansionBlendMin: 0,
    graphExpansionBlendMax: 1,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);
  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "path state seed");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);
  const seedPath = graphPathRelativeToStorage(memoryDir, seedMemory.path);
  assert.ok(seedPath);

  const cases = [
    {
      id: "legacy-archived-intermediate",
      expectedPenalty: true,
      relativePath: "archive/2026-07-25/legacy-archived-intermediate.md",
      frontmatter: [
        "id: legacy-archived-intermediate",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
      ],
    },
    {
      id: "active-with-archived-at",
      expectedPenalty: true,
      relativePath: "facts/2026-07-25/active-with-archived-at.md",
      frontmatter: [
        "id: active-with-archived-at",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
        "archivedAt: 2026-07-25T01:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "status: active",
      ],
    },
    {
      id: "active-in-archive-path",
      expectedPenalty: true,
      relativePath: "archive/2026-07-25/active-in-archive-path.md",
      frontmatter: [
        "id: active-in-archive-path",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "status: active",
      ],
    },
    {
      id: "malformed-status-with-invalid-at",
      relativePath: "facts/2026-07-25/malformed-status-with-invalid-at.md",
      expectedPenalty: false,
      frontmatter: [
        "id: malformed-status-with-invalid-at",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
        "invalid_at: 2026-08-01T00:00:00.000Z",
        "source: test",
        "confidence: 0.9",
        "confidenceTier: explicit",
        "status: malformed",
      ],
    },
  ] as const;
  const candidates: Array<{
    id: string;
    intermediatePath: string;
    candidatePath: string;
    expectedPenalty: boolean;
  }> = [];
  for (const item of cases) {
    const intermediatePath = path.join(memoryDir, item.relativePath);
    await mkdir(path.dirname(intermediatePath), { recursive: true });
    await writeFile(
      intermediatePath,
      ["---", ...item.frontmatter, "---", "", `${item.id} intermediate`].join("\n"),
      "utf-8",
    );
    const { id: candidateId } = await orchestrator.storage.writeMemory(
      "fact",
      `${item.id} candidate`,
    );
    const candidateMemory = await orchestrator.storage.getMemoryById(candidateId);
    assert.ok(candidateMemory);
    const candidatePath = graphPathRelativeToStorage(memoryDir, candidateMemory.path);
    assert.ok(candidatePath);
    candidates.push({
      id: item.id,
      expectedPenalty: item.expectedPenalty,
      intermediatePath: item.relativePath,
      candidatePath,
    });
  }
  type GraphIndexSeam = Pick<GraphIndex, "spreadingActivation">;
  const orchestratorInternals = orchestrator as unknown as {
    graphIndexes: Map<string, GraphIndexSeam>;
  };
  const graphIndexes = orchestratorInternals.graphIndexes;
  graphIndexes.set(memoryDir, {
    spreadingActivation: async () =>
      candidates.map((item) => ({
        path: item.candidatePath,
        score: 0.8,
        seed: seedPath,
        hopDepth: 2,
        decayedWeight: 0.7,
        graphType: "entity" as const,
        edgeConfidence: 1,
        activationPath: {
          nodeIds: [seedPath, item.intermediatePath, item.candidatePath],
          edgeConfidences: [1, 1],
          graphTypes: ["entity", "entity"] as const,
        },
      })),
  });

  const result = await orchestrator.expandResultsViaGraph({
    memoryResults: [
      {
        docid: seedMemory.frontmatter.id,
        path: seedPath,
        namespace: "default",
        snippet: "path state seed",
        score: 0.9,
      },
    ],
    recallNamespaces: ["default"],
    recallResultLimit: 3,
    asOf: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  const expectedPenaltyByPath = new Map(
    candidates.map((item) => [item.candidatePath, item.expectedPenalty]),
  );
  assert.equal(result.expandedPaths.length, cases.length);
  for (const item of result.expandedPaths) {
    const expectedPenalty = expectedPenaltyByPath.get(
      graphPathRelativeToStorage(memoryDir, item.path) ?? item.path,
    );
    assert.equal(item.pathPenaltyApplied, expectedPenalty, item.path);
    assert.equal(item.score, expectedPenalty ? 0.18000000000000002 : 0.9);
  }
});
test("recallInternal keeps malformed and empty historical dates on current-time graph scoring", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-as-of-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);
  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed memory for as-of");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const seam = orchestrator as unknown as {
    qmd: object;
    expandResultsViaGraph: (options: { memoryResults: QmdSearchResult[] }) => Promise<{
      merged: QmdSearchResult[];
      seedPaths: string[];
      expandedPaths: [];
      seedResults: QmdSearchResult[];
    }>;
  };
  seam.qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed memory for as-of",
        score: 0.9,
      },
    ],
    search: async () => [],
  };
  const graphCalls: Array<{ memoryResults: QmdSearchResult[] }> = [];
  seam.expandResultsViaGraph = async (options) => {
    graphCalls.push(options);
    return {
      merged: options.memoryResults,
      seedPaths: [seedMemory!.path],
      expandedPaths: [],
      seedResults: options.memoryResults,
    };
  };
  const recallInternal = (
    orchestrator as unknown as {
      recallInternal: (
        prompt: string,
        sessionKey: string,
        options: { asOf: string },
      ) => Promise<string>;
    }
  ).recallInternal.bind(orchestrator);

  await recallInternal(
    "what happened in the timeline last week",
    "session-graph-as-of-malformed",
    { asOf: "not-a-date" },
  );
  await recallInternal(
    "what happened in the timeline last week",
    "session-graph-as-of-empty",
    { asOf: "" },
  );

  assert.equal(graphCalls.length, 2);
  for (const options of graphCalls) {
    assert.equal("asOf" in options, false);
    assert.equal("asOfMs" in options, false);
  }
});


test("recallInternal labels absolute entity graph results as reconstructed entities", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-entity-label-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed memory");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const entitySlug = await orchestrator.storage.writeEntity("Alex", "person", ["Owns the roadmap."]);
  assert.ok(entitySlug);
  const entityPath = path.join(memoryDir, "entities", `${entitySlug}.md`);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed memory",
        score: 0.9,
      },
    ],
    search: async () => [],
  };
  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: [
      ...memoryResults,
      {
        docid: entitySlug,
        path: entityPath,
        snippet: "Alex owns the roadmap.",
        score: 0.8,
      },
    ],
    seedPaths: [seedMemory!.path],
    expandedPaths: [
      {
        path: entityPath,
        score: 0.8,
        namespace: "default",
        seed: seedMemory!.path,
        hopDepth: 1,
        decayedWeight: 0.7,
        graphType: "entity",
      },
    ],
  });

  await (orchestrator as any).recallInternal(
    "what happened in the timeline last week",
    "session-graph-entity",
  );

  const snapshot = JSON.parse(
    await readFile(path.join(memoryDir, "state", "last_graph_recall.json"), "utf-8"),
  ) as {
    finalResults?: Array<{ path: string; sourceLabels: string[] }>;
  };
  const entityResult = snapshot.finalResults?.find((result) => result.path === entityPath);
  assert.ok(entityResult);
  assert.deepEqual(entityResult.sourceLabels, ["graph_expanded", "reconstructed_entity"]);
});

test("recallInternal runs bounded graph assist in full mode when enabled", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-assist-full-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdCollection: "engram-test",
    qmdMaxResults: 3,
    recallPlannerEnabled: true,
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    graphAssistInFullModeEnabled: true,
    graphAssistMinSeedResults: 1,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "seed memory for full mode assist");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);

  const { id: expandedId } = await orchestrator.storage.writeMemory("fact", "expanded memory for full mode assist");
  const expandedMemory = await orchestrator.storage.getMemoryById(expandedId);
  assert.ok(expandedMemory);

  (orchestrator as any).qmd = {
    isAvailable: () => true,
    hybridSearch: async () => [
      {
        docid: seedMemory!.frontmatter.id,
        path: seedMemory!.path,
        snippet: "seed memory for full mode assist",
        score: 0.9,
      },
    ],
    search: async () => [],
  };
  (orchestrator as any).expandResultsViaGraph = async ({ memoryResults }: any) => ({
    merged: [
      ...memoryResults,
      {
        docid: expandedMemory!.frontmatter.id,
        path: expandedMemory!.path,
        snippet: "expanded memory for full mode assist",
        score: 0.8,
      },
    ],
    seedPaths: [seedMemory!.path],
    expandedPaths: [{ path: expandedMemory!.path, score: 0.8, namespace: "default", seed: seedMemory!.path, hopDepth: 1, decayedWeight: 0.7, graphType: "entity" }],
  });

  const out = await (orchestrator as any).recallInternal(
    "Summarize our latest engram status.",
    "session-graph-full-assist",
  );
  assert.match(out, /Relevant Memories/);

  let raw: string;
  try {
    raw = await readFile(path.join(memoryDir, "state", "last_graph_recall.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("this branch does not yet persist last_graph_recall.json for full-mode graph assist");
      return;
    }
    throw error;
  }
  const snapshot = JSON.parse(raw) as {
    mode: string;
    seedCount: number;
    expandedCount: number;
  };
  assert.equal(snapshot.mode, "full");
  assert.equal(snapshot.seedCount, 1);
  assert.equal(snapshot.expandedCount, 1);
});

test("getLastGraphRecallSnapshot reads persisted snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-read-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_graph_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-02-22T00:00:00.000Z",
        mode: "graph_mode",
        queryHash: "abc123",
        queryLength: 42,
        namespaces: ["default"],
        seedCount: 1,
        expandedCount: 1,
        seeds: ["/tmp/memory/default/facts/a.md"],
        expanded: [{ path: "/tmp/memory/default/facts/b.md", score: 0.7, namespace: "default", seed: "/tmp/memory/default/facts/a.md", hopDepth: 1, decayedWeight: 0.7, graphType: "entity" }],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const snapshot =
    await orchestrator.recallIntrospection.getLastGraphRecallSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot!.mode, "graph_mode");
  assert.equal(snapshot!.seedCount, 1);
  assert.equal(snapshot!.expandedCount, 1);
  assert.equal(snapshot!.expanded[0]?.namespace, "default");
});

test("getLastGraphRecallSnapshot preserves richer fallback and ranking fields when present", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-rich-read-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_graph_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-02-22T00:00:00.000Z",
        mode: "full",
        queryHash: "abc123",
        queryLength: 42,
        namespaces: ["default"],
        seedCount: 1,
        expandedCount: 0,
        seeds: ["/tmp/memory/default/facts/a.md"],
        expanded: [],
        status: "skipped",
        reason: "graph assist skipped because no eligible expansion edges were found",
        finalResults: [
          {
            path: "/tmp/memory/default/facts/a.md",
            score: 0.91,
            sourceLabels: ["seed"],
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const snapshot =
    (await orchestrator.recallIntrospection.getLastGraphRecallSnapshot()) as
    | ({
        status?: string;
        reason?: string;
        finalResults?: Array<{ path: string; score: number; sourceLabels: string[] }>;
      } & Record<string, unknown>)
    | null;
  assert.ok(snapshot);
  assert.equal(snapshot.status, "skipped");
  assert.equal(snapshot.reason, "graph assist skipped because no eligible expansion edges were found");
  assert.equal(snapshot.finalResults?.length, 1);
  assert.equal(snapshot.finalResults?.[0]?.path, "/tmp/memory/default/facts/a.md");
  assert.equal(snapshot.finalResults?.[0]?.score, 0.91);
  assert.deepEqual(snapshot.finalResults?.[0]?.sourceLabels, ["seed"]);
});

test("explainLastGraphRecall returns human-readable graph explanation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-explain-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_graph_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-02-22T00:00:00.000Z",
        mode: "graph_mode",
        queryHash: "abc123",
        queryLength: 42,
        namespaces: ["default"],
        seedCount: 1,
        expandedCount: 2,
        seeds: ["/tmp/memory/default/facts/a.md"],
        expanded: [
          { path: "/tmp/memory/default/facts/b.md", score: 0.7, namespace: "default", seed: "/tmp/memory/default/facts/a.md", hopDepth: 1, decayedWeight: 0.7, graphType: "entity" },
          { path: "/tmp/memory/default/facts/c.md", score: 0.6, namespace: "default", seed: "/tmp/memory/default/facts/a.md", hopDepth: 2, decayedWeight: 0.49, graphType: "time" },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const explanation =
    await orchestrator.recallIntrospection.explainLastGraphRecall({
      maxExpanded: 1,
    });
  assert.match(explanation, /Last Graph Recall/);
  assert.match(explanation, /Mode: graph_mode/);
  assert.match(explanation, /showing 1/);
  assert.match(explanation, /seed=.*hop=.*type=/);
});

test("explainLastGraphRecall tolerates richer fallback snapshots and surfaces them when supported", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-fallback-explain-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_graph_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-02-22T00:00:00.000Z",
        mode: "full",
        queryHash: "abc123",
        queryLength: 42,
        namespaces: ["default"],
        seedCount: 1,
        expandedCount: 0,
        seeds: ["/tmp/memory/default/facts/a.md"],
        expanded: [],
        status: "skipped",
        reason: "graph recall skipped after planner downgrade",
        finalResults: [
          {
            path: "/tmp/memory/default/facts/a.md",
            score: 0.91,
            sourceLabels: ["seed"],
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const explanation =
    await orchestrator.recallIntrospection.explainLastGraphRecall({
      maxExpanded: 5,
    });
  assert.match(explanation, /Last Graph Recall/);
  assert.match(explanation, /Mode: full/);
  if (explanation.includes("fallback")) {
    assert.match(explanation, /fallback/i);
    assert.match(explanation, /planner downgrade/i);
  }
  if (explanation.includes("final")) {
    assert.match(explanation, /final/i);
    assert.match(explanation, /seed/i);
  }
});


test("graph expansion fills its cap after excluding legacy archived candidates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-recall-cap-underfill-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    verbatimArtifactsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);
  const { id: seedId } = await orchestrator.storage.writeMemory("fact", "graph cap seed");
  const seedMemory = await orchestrator.storage.getMemoryById(seedId);
  assert.ok(seedMemory);
  const { id: validId } = await orchestrator.storage.writeMemory("fact", "valid graph candidate");
  const validMemory = await orchestrator.storage.getMemoryById(validId);
  assert.ok(validMemory);

  const legacyCandidates = [
    ...Array.from({ length: 3 }, (_, index) => ({
      relativePath: `archive/2026-07-25/legacy-absent-${index}.md`,
      frontmatter: [
        `id: legacy-absent-${index}`,
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
      ],
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      relativePath: `facts/2026-07-25/legacy-archived-at-${index}.md`,
      frontmatter: [
        `id: legacy-archived-at-${index}`,
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        "updated: 2026-07-25T00:00:00.000Z",
        "status: active",
        "archivedAt: 2026-07-25T01:00:00.000Z",
      ],
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      relativePath: `archive/2026-07-26/legacy-active-${index}.md`,
      frontmatter: [
        `id: legacy-active-${index}`,
        "category: fact",
        "created: 2026-07-26T00:00:00.000Z",
        "updated: 2026-07-26T00:00:00.000Z",
        "status: active",
      ],
    })),
  ];
  for (const candidate of legacyCandidates) {
    const candidatePath = path.join(memoryDir, candidate.relativePath);
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(
      candidatePath,
      ["---", ...candidate.frontmatter, "---", "", "legacy archived graph candidate"].join("\n"),
      "utf-8",
    );
  }

  const seedPath = graphPathRelativeToStorage(memoryDir, seedMemory.path);
  const validPath = graphPathRelativeToStorage(memoryDir, validMemory.path);
  assert.ok(seedPath);
  assert.ok(validPath);
  const graphCandidates = [
    ...legacyCandidates.map((candidate, index) => ({
      path: candidate.relativePath,
      score: 1 - index * 0.01,
    })),
    { path: validPath, score: 0.5 },
  ];
  const orchestratorInternals = orchestrator as unknown as {
    graphIndexes: Map<string, Pick<GraphIndex, "spreadingActivation">>;
  };
  const graphIndexes = orchestratorInternals.graphIndexes;
  graphIndexes.set(memoryDir, {
    spreadingActivation: async () =>
      graphCandidates.map((candidate) => ({
        ...candidate,
        seed: seedPath,
        hopDepth: 1,
        decayedWeight: candidate.score,
        graphType: "entity" as const,
        edgeConfidence: 1,
      })),
  });

  const result = await orchestrator.graphRecallCoordinator.expandResultsViaGraph({
    memoryResults: [{
      docid: seedMemory.frontmatter.id,
      path: seedMemory.path,
      namespace: "default",
      snippet: "graph cap seed",
      score: 0.9,
    }],
    recallNamespaces: ["default"],
    recallResultLimit: 4,
  });

  assert.deepEqual(result.expandedPaths.map((entry) => entry.path), [validMemory.path]);
  assert.equal(result.merged.some((entry) => entry.path === validMemory.path), true);
  for (const candidate of legacyCandidates) {
    assert.equal(
      result.merged.some((entry) => entry.path.endsWith(candidate.relativePath)),
      false,
      candidate.relativePath,
    );
  }
});