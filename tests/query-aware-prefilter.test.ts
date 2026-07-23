import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import {
  indexMemoriesBatchAsync as indexMemoriesBatch,
  queryByTagsAsync,
  resolvePromptTagPrefilterAsync,
} from "../src/temporal-index.js";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    queryAwareIndexingEnabled: true,
    queryAwareIndexingMaxCandidates: 50,
    qmdEnabled: true,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

test("queryByTagsAsync expands child-tag queries to safe parent-tag matches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-query-aware-tags-"));
  await indexMemoriesBatch(memoryDir, [
    {
      path: "/tmp/memory/facts/child.md",
      createdAt: "2026-03-09T00:00:00.000Z",
      tags: ["infra/ops/oncall"],
    },
    {
      path: "/tmp/memory/facts/parent.md",
      createdAt: "2026-03-09T00:00:00.000Z",
      tags: ["infra/ops"],
    },
  ]);

  const matches = await queryByTagsAsync(memoryDir, ["infra/ops/oncall"]);

  assert.ok(matches);
  assert.equal(matches?.has("/tmp/memory/facts/child.md"), true);
  assert.equal(matches?.has("/tmp/memory/facts/parent.md"), true);
});

test("resolvePromptTagPrefilterAsync matches tag aliases through punctuation-delimited prompts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-query-aware-alias-"));
  await indexMemoriesBatch(memoryDir, [
    {
      path: "/tmp/memory/facts/ops.md",
      createdAt: "2026-03-09T00:00:00.000Z",
      tags: ["infra/ops"],
    },
  ]);

  const match = await resolvePromptTagPrefilterAsync(memoryDir, "What happened with infra ops?");

  assert.deepEqual(match.matchedTags, ["infra/ops"]);
  assert.equal(match.paths?.has("/tmp/memory/facts/ops.md"), true);
});

test("resolvePromptTagPrefilterAsync reuses the writer-primed tag cache for path lookup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-query-aware-read-once-"));
  await indexMemoriesBatch(memoryDir, [
    {
      path: "/tmp/memory/facts/ops.md",
      createdAt: "2026-03-09T00:00:00.000Z",
      tags: ["infra/ops"],
    },
  ]);

  const originalOpen = fs.promises.open;
  let handleReadCount = 0;
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const originalHandleRead = handle.readFile.bind(handle);
    handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
      handleReadCount += 1;
      return originalHandleRead(...readArgs);
    }) as typeof handle.readFile;
    return handle;
  }) as typeof originalOpen;

  try {
    const match = await resolvePromptTagPrefilterAsync(memoryDir, "What happened with infra ops?");
    assert.deepEqual(match.matchedTags, ["infra/ops"]);
    assert.equal(match.paths?.has("/tmp/memory/facts/ops.md"), true);
    assert.equal(handleReadCount, 0);
  } finally {
    fs.promises.open = originalOpen;
  }
});

test("queryByTagsAsync preserves all paths when legacy tags collapse to one canonical key", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-query-aware-collision-"));
  const stateDir = path.join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "index_tags.json"),
    JSON.stringify({
      version: 1,
      tags: {
        infra_ops: ["/tmp/memory/facts/one.md"],
        "infra-ops": ["/tmp/memory/facts/two.md"],
      },
    }),
    "utf8",
  );

  const matches = await queryByTagsAsync(memoryDir, ["infra ops"]);

  assert.ok(matches);
  assert.equal(matches?.has("/tmp/memory/facts/one.md"), true);
  assert.equal(matches?.has("/tmp/memory/facts/two.md"), true);
});

test("fetchQmdMemoryResultsWithArtifactTopUp merges advisory query-aware seeds with backend search", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-hot-");
  const storage = (orchestrator as any).storage;

  const { id: infraId } = await storage.writeMemory(
    "fact",
    "We stabilized the api gateway during the infra ops incident this morning.",
    { tags: ["infra/ops"], confidence: 0.9 },
  );
  const { id: marketingId } = await storage.writeMemory(
    "fact",
    "We rewrote the homepage headline for the launch page.",
    { tags: ["marketing/content"], confidence: 0.9 },
  );

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  let backendCalls = 0;
  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      backendCalls += 1;
      return [
        {
          docid: marketingId,
          path: byId.get(marketingId)?.path,
          score: 0.91,
          snippet: "marketing result",
        },
      ];
    },
    hybridSearch: async () => {
      backendCalls += 1;
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp(
    "What happened with infra ops this morning?",
    4,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: [],
      resolveNamespace: () => "",
    },
  );

  assert.equal(backendCalls, 2);
  assert.equal(results.length, 2);
  assert.ok(results.some((result: { path: string }) => new RegExp(infraId).test(result.path)));
  assert.ok(results.some((result: { path: string }) => new RegExp(marketingId).test(result.path)));
});

test("temporal query-aware seeds survive alongside backend results", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-time-");
  const storage = (orchestrator as any).storage;

  const { id: recentId } = await storage.writeMemory(
    "fact",
    "Today we mitigated the paging incident and stabilized the service.",
    { tags: ["infra/incident"], confidence: 0.9 },
  );
  const { id: olderId } = await storage.writeMemory(
    "fact",
    "Last month we updated the billing FAQ and help center copy.",
    {
      tags: ["docs/billing"],
      confidence: 0.9,
      created: "2026-01-10T12:00:00.000Z",
      updated: "2026-01-10T12:00:00.000Z",
    } as any,
  );

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));
  let backendCalls = 0;
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      backendCalls += 1;
      return [
        {
          docid: olderId,
          path: byId.get(olderId)?.path,
          score: 0.97,
          snippet: "older result",
        },
      ];
    },
    hybridSearch: async () => {
      backendCalls += 1;
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp(
    "What happened today with the incident?",
    4,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: [],
      resolveNamespace: () => "",
    },
  );

  assert.equal(backendCalls, 2);
  assert.ok(results.some((result: { path: string }) => new RegExp(recentId).test(result.path)));
  assert.ok(results.some((result: { path: string }) => new RegExp(olderId).test(result.path)));
});

test("recallInternal applies query-aware prefilter parity to embedding fallback results", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-embed-", {
    qmdEnabled: false,
    embeddingFallbackEnabled: true,
  });
  const storage = (orchestrator as any).storage;

  const { id: infraId } = await storage.writeMemory(
    "fact",
    "The infra ops team mitigated the gateway outage and documented the incident.",
    { tags: ["infra/ops"], confidence: 0.9 },
  );
  const { id: marketingId } = await storage.writeMemory(
    "fact",
    "The marketing team updated homepage messaging for the spring launch.",
    { tags: ["marketing/content"], confidence: 0.9 },
  );

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));
  (orchestrator as any).embeddingFallback = {
    isAvailable: async () => true,
    search: async () => [
      {
        id: marketingId,
        path: byId.get(marketingId)?.path,
        score: 0.99,
      },
      {
        id: infraId,
        path: byId.get(infraId)?.path,
        score: 0.45,
      },
    ],
  };

  const context = await (orchestrator as any).recallInternal(
    "Remind me what happened with infra ops",
    "user:test:query-aware-embed",
  );

  assert.match(context, /infra ops team mitigated the gateway outage/i);
  assert.doesNotMatch(context, /marketing team updated homepage messaging/i);
});

test("query-aware max candidate limit treats 0 as uncapped for advisory seed results", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-zero-", {
    queryAwareIndexingMaxCandidates: 0,
  });
  const storage = (orchestrator as any).storage;

  await storage.writeMemory("fact", "infra ops stabilized the first incident", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });
  await storage.writeMemory("fact", "infra ops stabilized the second incident", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  let backendCalls = 0;
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      backendCalls += 1;
      return [];
    },
    hybridSearch: async () => {
      backendCalls += 1;
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp(
    "What did infra ops stabilize?",
    10,
    10,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
    },
  );

  assert.equal(backendCalls, 2);
  assert.equal(results.length, 2);
});

test("explicit tag misses preserve an empty prefilter through QMD retrieval", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-tag-miss-");
  const storage = (orchestrator as any).storage;

  const { id: unrelatedId } = await storage.writeMemory(
    "fact",
    "The marketing team updated homepage messaging for the spring launch.",
    { tags: ["marketing/content"], confidence: 0.9 },
  );
  const { id: alphaId } = await storage.writeMemory(
    "fact",
    "Alpha-tagged infrastructure note that should not match beta.",
    { tags: ["alpha"], confidence: 0.9 },
  );

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));
  let backendCalls = 0;
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      backendCalls += 1;
      return [
        {
          docid: unrelatedId,
          path: byId.get(unrelatedId)?.path,
          score: 0.99,
          snippet: "unrelated result",
        },
      ];
    },
    hybridSearch: async () => {
      backendCalls += 1;
      return [
        {
          docid: alphaId,
          path: byId.get(alphaId)?.path,
          score: 0.9,
          snippet: "alpha result",
        },
      ];
    },
  };

  const prefilter = await (orchestrator as any).buildQueryAwarePrefilter(
    "What happened with #beta?",
    ["default"],
  );
  assert.equal(prefilter.candidatePaths?.size, 0);
  assert.equal(prefilter.combination, "tag");

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp(
    "What happened with #beta?",
    5,
    5,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      queryAwarePrefilter: prefilter,
    },
  );

  assert.equal(backendCalls, 0);
  assert.deepEqual(results, []);
});

test("explicit tag misses dominate temporal matches and skip non-QMD fallbacks", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-tag-temporal-miss-", {
    qmdEnabled: false,
    embeddingFallbackEnabled: true,
  });
  const storage = (orchestrator as any).storage;

  const { id: alphaId } = await storage.writeMemory(
    "fact",
    "Alpha-tagged incident note from today that should not match beta.",
    { tags: ["alpha"], confidence: 0.9 },
  );

  const memories = await storage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));
  let embeddingCalls = 0;
  (orchestrator as any).embeddingFallback = {
    isAvailable: async () => true,
    search: async () => {
      embeddingCalls += 1;
      return [
        {
          id: alphaId,
          path: byId.get(alphaId)?.path,
          score: 0.99,
        },
      ];
    },
  };

  const prefilter = await (orchestrator as any).buildQueryAwarePrefilter(
    "What happened today with #beta?",
    ["default"],
  );
  assert.equal(prefilter.candidatePaths?.size, 0);
  assert.equal(prefilter.combination, "tag");

  const context = await (orchestrator as any).recallInternal(
    "What happened today with #beta?",
    "user:test:query-aware-tag-temporal-miss",
  );

  assert.equal(embeddingCalls, 0);
  assert.doesNotMatch(context, /Alpha-tagged incident note/i);
});

test("explicit tag misses suppress fresh QMD cache hits", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-tag-cache-miss-");
  const storage = (orchestrator as any).storage;

  const { id: alphaId } = await storage.writeMemory(
    "fact",
    "Alpha-tagged cached QMD result that should not match beta.",
    { tags: ["alpha"], confidence: 0.9 },
  );
  const memories = await storage.readAllMemories();
  const byId = new Map<string, any>(memories.map((memory: any) => [memory.frontmatter.id, memory]));

  let qmdCalls = 0;
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      qmdCalls += 1;
      return [
        {
          docid: alphaId,
          path: byId.get(alphaId)?.path,
          score: 0.99,
          snippet: "alpha result",
        },
      ];
    },
    hybridSearch: async () => {
      qmdCalls += 1;
      return [];
    },
  };

  const cachedContext = await (orchestrator as any).recallInternal(
    "What happened with #beta?",
    "user:test:query-aware-tag-cache-miss",
  );
  assert.match(cachedContext, /alpha result/i);
  assert.equal(qmdCalls, 2);

  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    memories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const context = await (orchestrator as any).recallInternal(
    "What happened with #beta?",
    "user:test:query-aware-tag-cache-miss",
  );

  assert.equal(qmdCalls, 2);
  assert.doesNotMatch(context, /alpha result/i);
});

test("query-aware prefilter scopes candidate paths to authorized namespaces", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-ns-", {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    qmdEnabled: false,
  });
  const defaultStorage = await (orchestrator as any).getStorage("default");
  const sharedStorage = await (orchestrator as any).getStorage("shared");
  await defaultStorage.ensureDirectories();
  await sharedStorage.ensureDirectories();

  await defaultStorage.writeMemory("fact", "default namespace infra ops note", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });
  await sharedStorage.writeMemory("fact", "shared namespace infra ops note", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });

  const defaultMemories = await defaultStorage.readAllMemories();
  const sharedMemories = await sharedStorage.readAllMemories();
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    [...defaultMemories, ...sharedMemories].map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const prefilter = await (orchestrator as any).buildQueryAwarePrefilter(
    "What happened with infra ops?",
    ["default"],
  );
  const results = prefilter.candidatePaths
    ? await (orchestrator as any).searchScopedMemoryCandidates(
      prefilter.candidatePaths,
      "What happened with infra ops?",
      10,
    )
    : [];

  assert.equal(results.length, 1);
  assert.match(results[0]?.snippet ?? "", /default namespace infra ops note/i);
  assert.doesNotMatch(results[0]?.path ?? "", /namespaces[\\/]+shared/i);
});

test("persistExtraction auto-promotes shared facts so shared-only recall still succeeds", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-shared-promote-", {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["shared"],
    autoPromoteToSharedEnabled: true,
    autoPromoteToSharedCategories: ["fact"],
    queryAwareIndexingEnabled: false,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const defaultStorage = await (orchestrator as any).getStorage("default");
  const sharedStorage = await (orchestrator as any).getStorage("shared");

  const { persistedIds } = await (orchestrator as any).persistExtraction(
    {
      facts: [
        {
          category: "fact",
          content: "Shared infra ops memory promoted for every agent.",
          confidence: 0.96,
          tags: ["infra/ops"],
        },
      ],
      entities: [],
      questions: [],
      profileUpdates: [],
    },
    defaultStorage,
  );

  const sharedMemories = await sharedStorage.readAllMemories();
  assert.equal(persistedIds.length, 1);
  assert.equal(sharedMemories.length, 1);
  assert.equal(sharedMemories[0]?.frontmatter.sourceMemoryId?.startsWith("fact-"), true);
  assert.equal(sharedMemories[0]?.frontmatter.tags?.includes("shared-promotion"), true);

  const context = await (orchestrator as any).recallInternal(
    "What happened with infra ops?",
    "agent:worker:shared-only",
  );

  assert.match(context, /Shared infra ops memory promoted for every agent/i);
});

test("persistExtraction keeps primary fact persistence when shared promotion write fails", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-shared-promote-write-fail-", {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    autoPromoteToSharedEnabled: true,
    autoPromoteToSharedCategories: ["fact"],
    queryAwareIndexingEnabled: false,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const defaultStorage = await (orchestrator as any).getStorage("default");
  const sharedStorage = await (orchestrator as any).getStorage("shared");
  const originalWriteMemory = sharedStorage.writeMemory.bind(sharedStorage);
  sharedStorage.writeMemory = (async () => {
    throw new Error("shared promotion write failed");
  }) as typeof sharedStorage.writeMemory;

  try {
    const { persistedIds } = await (orchestrator as any).persistExtraction(
      {
        facts: [
          {
            category: "fact",
            content: "Default namespace memory must survive shared promotion failures.",
            confidence: 0.96,
            tags: ["infra/ops"],
          },
        ],
        entities: [],
        questions: [],
        profileUpdates: [],
      },
      defaultStorage,
    );

    const defaultMemories = await defaultStorage.readAllMemories();
    const sharedMemories = await sharedStorage.readAllMemories();

    assert.equal(persistedIds.length, 1);
    assert.equal(defaultMemories.length, 1);
    assert.match(defaultMemories[0]?.content ?? "", /survive shared promotion failures/i);
    assert.equal(sharedMemories.length, 0);
  } finally {
    sharedStorage.writeMemory = originalWriteMemory;
  }
});

test("persistExtraction keeps primary fact persistence when shared promotion indexing fails", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-shared-promote-index-fail-", {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    autoPromoteToSharedEnabled: true,
    autoPromoteToSharedCategories: ["fact"],
    queryAwareIndexingEnabled: false,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const defaultStorage = await (orchestrator as any).getStorage("default");
  const sharedStorage = await (orchestrator as any).getStorage("shared");
  const originalIndexPersistedMemory = (orchestrator as any).indexPersistedMemory.bind(orchestrator);
  (orchestrator as any).indexPersistedMemory = async (targetStorage: typeof defaultStorage, memoryId: string) => {
    if (targetStorage.dir === sharedStorage.dir) {
      throw new Error(`shared promotion indexing failed for ${memoryId}`);
    }
    return originalIndexPersistedMemory(targetStorage, memoryId);
  };

  try {
    const { persistedIds } = await (orchestrator as any).persistExtraction(
      {
        facts: [
          {
            category: "fact",
            content: "Default namespace memory must survive shared indexing failures.",
            confidence: 0.96,
            tags: ["infra/ops"],
          },
        ],
        entities: [],
        questions: [],
        profileUpdates: [],
      },
      defaultStorage,
    );

    const defaultMemories = await defaultStorage.readAllMemories();
    const sharedMemories = await sharedStorage.readAllMemories();

    assert.equal(persistedIds.length, 1);
    assert.equal(defaultMemories.length, 1);
    assert.match(defaultMemories[0]?.content ?? "", /survive shared indexing failures/i);
    assert.equal(sharedMemories.length, 1);
    assert.match(sharedMemories[0]?.content ?? "", /survive shared indexing failures/i);
  } finally {
    (orchestrator as any).indexPersistedMemory = originalIndexPersistedMemory;
  }
});

test("query-aware prefilter fails open when the tag index is corrupt", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-corrupt-");
  const stateDir = path.join(orchestrator.config.memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "index_tags.json"), "{ not-json", "utf8");

  let backendCalls = 0;
  (orchestrator as any).qmd = {
    isAvailable: () => true,
    debugStatus: () => "available",
    search: async () => {
      backendCalls += 1;
      return [
        {
          docid: "fallback-doc",
          path: "/tmp/fallback-doc.md",
          score: 0.5,
          snippet: "fallback result",
        },
      ];
    },
    hybridSearch: async () => {
      backendCalls += 1;
      return [];
    },
  };

  const results = await (orchestrator as any).fetchQmdMemoryResultsWithArtifactTopUp(
    "What happened with #infra?",
    5,
    5,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
    },
  );

  assert.equal(backendCalls > 0, true);
  assert.equal(results[0]?.path, "/tmp/fallback-doc.md");
});

test("resolvePromptTagPrefilterAsync fails open when the tag index is corrupt", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-query-aware-helper-corrupt-"));
  const stateDir = path.join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "index_tags.json"), "{ not-json", "utf8");

  const result = await resolvePromptTagPrefilterAsync(memoryDir, "What happened with #infra?");

  assert.deepEqual(result.matchedTags, ["infra"]);
  assert.deepEqual(result.expandedTags, ["infra"]);
  assert.equal(result.paths, null);
});

test("qmd-unavailable recall sends archived-only query-aware matches to cold fallback", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-archive-only-", {
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const storage = (orchestrator as any).storage;

  await storage.writeMemory("fact", "recent unrelated launch note", {
    tags: ["marketing/content"],
    confidence: 0.9,
  });
  const { id: archivedId } = await storage.writeMemory("fact", "infra ops archived incident summary", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });
  const archivedMemory = (await storage.readAllMemories()).find(
    (memory: any) => memory.frontmatter.id === archivedId,
  );
  await storage.archiveMemory(archivedMemory);

  const corpus = await Promise.all([
    storage.readAllMemories(),
    (orchestrator as any).readArchivedMemoriesForNamespaces(["default"]),
  ]);
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    corpus.flat().map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const context = await (orchestrator as any).recallInternal(
    "What happened with infra ops?",
    "user:test:query-aware-archive-only",
  );

  assert.match(context, /infra ops archived incident summary/i);
  assert.doesNotMatch(context, /recent unrelated launch note/i);
});

test("archive-scan cold fallback fills budget after excluding artifact paths", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-archive-artifacts-", {
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const storage = (orchestrator as any).storage;

  await storage.writeArtifact("archived infra ops artifact one", {
    tags: ["infra/ops"],
    confidence: 0.9,
    artifactType: "fact",
  });
  await storage.writeArtifact("archived infra ops artifact two", {
    tags: ["infra/ops"],
    confidence: 0.9,
    artifactType: "fact",
  });
  const { id: archivedMemoryId } = await storage.writeMemory("fact", "archived infra ops memory result", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });

  for (const memory of await storage.readAllMemories()) {
    await storage.archiveMemory(memory);
  }

  const archivedMemories = await (orchestrator as any).readArchivedMemoriesForNamespaces(["default"]);
  await indexMemoriesBatch(
    orchestrator.config.memoryDir,
    archivedMemories.map((memory: any) => ({
      path: memory.path,
      createdAt: memory.frontmatter.created,
      tags: memory.frontmatter.tags ?? [],
    })),
  );

  const results = await (orchestrator as any).searchLongTermArchiveFallback(
    "What happened with infra ops?",
    ["default"],
    1,
  );

  assert.equal(results.length, 1);
  assert.match(results[0]?.path ?? "", new RegExp(archivedMemoryId));
  assert.doesNotMatch(results[0]?.path ?? "", /artifacts[\\/]/i);
});

test("recent-scan fallback preserves artifact isolation when query-aware indexing is inactive", async () => {
  const orchestrator = await makeOrchestrator("engram-query-aware-artifact-", {
    qmdEnabled: false,
    queryAwareIndexingEnabled: false,
    embeddingFallbackEnabled: false,
  });
  const storage = (orchestrator as any).storage;

  await storage.writeMemory("fact", "Persistent memory about the infra outage.", {
    tags: ["infra/ops"],
    confidence: 0.9,
  });
  await storage.writeArtifact("Quoted artifact about the infra outage.", {
    tags: ["infra/ops"],
    confidence: 0.9,
    artifactType: "fact",
  });

  const context = await (orchestrator as any).recallInternal(
    "What do we remember about the infra outage?",
    "user:test:query-aware-artifact",
  );

  assert.match(context, /Persistent memory about the infra outage/i);
  assert.doesNotMatch(context, /Quoted artifact about the infra outage/i);
});
