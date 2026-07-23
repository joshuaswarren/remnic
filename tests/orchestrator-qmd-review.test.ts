import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { registerTools } from "../src/tools.ts";

const EMPTY_PREFILTER = {
  candidatePaths: null,
  temporalFromDate: null,
  matchedTags: [],
  expandedTags: [],
  combination: "none",
  filteredToFullSearch: false,
} as const;

test("fetchQmdMemoryResultsWithArtifactTopUp forwards QMD search options and skips hybrid top-up under intent hints", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdIntentHintsEnabled: true,
    qmdExplainEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let searchArgs: unknown[] | null = null;
  let hybridCalls = 0;
  const snapshotBox: { value: Record<string, unknown> | null } = { value: null };
  orchestrator.qmd = {
    resolveSupportedSearchOptions: (options: Record<string, unknown>) => options,
    search: async (...args: unknown[]) => {
      searchArgs = args;
      return [
        {
          docid: "fact-1",
          path: "facts/2026-03-11/fact-1.md",
          snippet: "fact one",
          score: 0.9,
          transport: "daemon",
        },
      ];
    },
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
      searchOptions: {
        intent: "goal:review action:review entities:repo",
        explain: true,
      },
      onDebugSnapshot: async (payload: Record<string, unknown>) => {
        snapshotBox.value = payload;
      },
    },
  );

  assert.equal(hybridCalls, 0);
  assert.deepEqual(searchArgs, [
    "review the last recall",
    "openclaw-engram",
    4,
    {
      intent: "goal:review action:review entities:repo",
      explain: true,
    },
    // Degradation observer threading (#1536); unset in this fixture.
    { onDegradation: undefined },
  ]);
  assert.equal(results.length, 1);
  const snapshot = snapshotBox.value;
  assert.ok(snapshot);
  assert.equal(snapshot?.hybridTopUpSkippedReason, "intent_hint_active");
  assert.equal(snapshot?.intentHint, "goal:review action:review entities:repo");
  assert.equal(snapshot?.explainEnabled, true);
});

test("fetchQmdMemoryResultsWithArtifactTopUp still uses hybrid top-up when no QMD intent hint is present", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-hybrid-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let hybridCalls = 0;
  orchestrator.qmd = {
    search: async () => [
      {
        docid: "fact-1",
        path: "facts/2026-03-11/fact-1.md",
        snippet: "fact one",
        score: 0.7,
        transport: "subprocess",
      },
    ],
    resolveSupportedSearchOptions: () => undefined,
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
    },
  );

  assert.equal(hybridCalls, 1);
  assert.equal(results.length, 2);
});

test("fetchQmdMemoryResultsWithArtifactTopUp keeps hybrid top-up active when QMD strips unsupported intent hints", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-unsupported-intent-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdIntentHintsEnabled: true,
    qmdExplainEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let searchArgs: unknown[] | null = null;
  let hybridCalls = 0;
  const snapshotBox: { value: Record<string, unknown> | null } = { value: null };
  orchestrator.qmd = {
    resolveSupportedSearchOptions: () => ({ explain: true }),
    search: async (...args: unknown[]) => {
      searchArgs = args;
      return [
        {
          docid: "fact-1",
          path: "facts/2026-03-11/fact-1.md",
          snippet: "fact one",
          score: 0.7,
          transport: "subprocess",
        },
      ];
    },
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
      searchOptions: {
        intent: "goal:review action:review",
        explain: true,
      },
      onDebugSnapshot: async (payload: Record<string, unknown>) => {
        snapshotBox.value = payload;
      },
    },
  );

  assert.deepEqual(searchArgs, [
    "review the last recall",
    "openclaw-engram",
    4,
    {
      explain: true,
    },
    // Degradation observer threading (#1536); unset in this fixture.
    { onDegradation: undefined },
  ]);
  assert.equal(hybridCalls, 1);
  assert.equal(results.length, 2);
  const snapshot = snapshotBox.value;
  assert.ok(snapshot);
  assert.equal(snapshot?.intentHint, undefined);
  assert.equal(snapshot?.explainEnabled, true);
  assert.equal(snapshot?.hybridTopUpSkippedReason, undefined);
});

test("fetchQmdMemoryResultsWithArtifactTopUp keeps hybrid top-up active when the active backend ignores QMD hint options", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-non-qmd-backend-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    searchBackend: "orama",
    qmdIntentHintsEnabled: true,
    qmdExplainEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;

  let searchArgs: unknown[] | null = null;
  let hybridCalls = 0;
  const snapshotBox: { value: Record<string, unknown> | null } = { value: null };
  orchestrator.qmd = {
    search: async (...args: unknown[]) => {
      searchArgs = args;
      return [
        {
          docid: "fact-1",
          path: "facts/2026-03-11/fact-1.md",
          snippet: "fact one",
          score: 0.7,
          transport: "subprocess",
        },
      ];
    },
    hybridSearch: async () => {
      hybridCalls += 1;
      return [
        {
          docid: "fact-2",
          path: "facts/2026-03-11/fact-2.md",
          snippet: "fact two",
          score: 0.8,
        },
      ];
    },
  };

  const results = await orchestrator.fetchQmdMemoryResultsWithArtifactTopUp(
    "review the last recall",
    2,
    4,
    {
      namespacesEnabled: false,
      recallNamespaces: ["default"],
      resolveNamespace: () => "default",
      collection: "openclaw-engram",
      queryAwarePrefilter: EMPTY_PREFILTER,
      searchOptions: {
        intent: "goal:review action:review",
        explain: true,
      },
      onDebugSnapshot: async (payload: Record<string, unknown>) => {
        snapshotBox.value = payload;
      },
    },
  );

  assert.deepEqual(searchArgs, [
    "review the last recall",
    "openclaw-engram",
    4,
    {
      intent: "goal:review action:review",
      explain: true,
    },
    // Degradation observer threading (#1536); unset in this fixture.
    { onDegradation: undefined },
  ]);
  assert.equal(hybridCalls, 1);
  assert.equal(results.length, 2);
  const snapshot = snapshotBox.value;
  assert.ok(snapshot);
  assert.equal(snapshot?.intentHint, undefined);
  assert.equal(snapshot?.explainEnabled, false);
  assert.equal(snapshot?.hybridTopUpSkippedReason, undefined);
});

test("cold-tier recall forwards explain traces even when intent hints are disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-explain-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
    qmdExplainEnabled: true,
    qmdIntentHintsEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const { id: memoryId } = await orchestrator.storage.writeMemory(
    "fact",
    "cold explain trace memory",
  );
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await orchestrator.storage.migrateMemoryToTier(memory, "cold");

  let capturedOptions: Record<string, unknown> | undefined;
  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
    _prompt: string,
    _qmdFetchLimit: number,
    _qmdHybridFetchLimit: number,
    options: { searchOptions?: Record<string, unknown> },
  ) => {
    capturedOptions = options.searchOptions;
    return [
      {
        docid: memory.frontmatter.id,
        path: migrated.targetPath,
        snippet: "cold explain trace memory",
        score: 0.9,
      },
    ];
  };

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review the archive",
    recallNamespaces: ["default"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(capturedOptions, { explain: true });
});

test("cold-tier recall reads encrypted cold collection paths through primary storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-secure-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
    secureStoreEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;
  orchestrator.storage.setSecureStoreKey(Buffer.alloc(32, 9), true);
  const { id: memoryId } = await orchestrator.storage.writeMemory(
    "fact",
    "encrypted cold collection memory",
  );
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await orchestrator.storage.migrateMemoryToTier(memory, "cold");
  const coldRelativePath = path
    .relative(path.join(orchestrator.storage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: `openclaw-engram-cold/${coldRelativePath}`,
      snippet: "encrypted cold collection memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review encrypted archive",
    recallNamespaces: ["default"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].docid, memory.frontmatter.id);
  assert.equal(results[0].path, `openclaw-engram-cold/${coldRelativePath}`);
});

test("cold-tier recall resolves the default cold collection when config omits it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-default-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdColdTierEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;
  orchestrator.config.qmdColdCollection = undefined;
  const { id: memoryId } = await orchestrator.storage.writeMemory(
    "fact",
    "default cold collection memory",
  );
  const memory = await orchestrator.storage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await orchestrator.storage.migrateMemoryToTier(memory, "cold");
  const coldRelativePath = path
    .relative(path.join(orchestrator.storage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: `openclaw-engram-cold/${coldRelativePath}`,
      snippet: "default cold collection memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review default cold collection",
    recallNamespaces: ["default"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].docid, memory.frontmatter.id);
});

test("cold-tier recall resolves collection-prefixed paths from active recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-ns-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const namespaceStorage = await orchestrator.getStorage("project-cold");
  const { id: memoryId } = await namespaceStorage.writeMemory(
    "fact",
    "project cold namespace memory",
  );
  const memory = await namespaceStorage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await namespaceStorage.migrateMemoryToTier(memory, "cold");
  const coldRelativePath = path
    .relative(path.join(namespaceStorage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: `openclaw-engram-cold/${coldRelativePath}`,
      snippet: "project cold namespace memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review project cold namespace",
    recallNamespaces: ["project-cold"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].docid, memory.frontmatter.id);
  assert.equal(results[0].path, migrated.targetPath);
});

test("cold-tier recall drops collection-prefixed paths outside active recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-ns-drop-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const otherStorage = await orchestrator.getStorage("other-cold");
  const { id: memoryId } = await otherStorage.writeMemory(
    "fact",
    "other namespace cold memory",
  );
  const memory = await otherStorage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await otherStorage.migrateMemoryToTier(memory, "cold");
  const coldRelativePath = path
    .relative(path.join(otherStorage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: `openclaw-engram-cold/${coldRelativePath}`,
      snippet: "other namespace cold memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review project cold namespace",
    recallNamespaces: ["project-cold"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.deepEqual(results, []);
});

test("cold-tier recall resolves absolute cold paths from runtime recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-abs-ns-"));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-runtime-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const StorageManagerCtor = orchestrator.storage.constructor as new (
    dir: string,
  ) => typeof orchestrator.storage;
  const runtimeStorage = new StorageManagerCtor(runtimeDir);
  const { id: memoryId } = await runtimeStorage.writeMemory(
    "fact",
    "runtime cold namespace absolute memory",
  );
  const memory = await runtimeStorage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await runtimeStorage.migrateMemoryToTier(memory, "cold");

  const originalStorageFor = orchestrator.storageRouter.storageFor.bind(
    orchestrator.storageRouter,
  );
  orchestrator.storageRouter.storageFor = async (namespace: string) =>
    namespace === "runtime-cold"
      ? runtimeStorage
      : originalStorageFor(namespace);

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async () => [
    {
      docid: memory.frontmatter.id,
      path: migrated.targetPath,
      snippet: "runtime cold namespace absolute memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review runtime cold namespace",
    recallNamespaces: ["runtime-cold"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].docid, memory.frontmatter.id);
  assert.equal(results[0].path, migrated.targetPath);
});

test("cold fallback keeps absolute fallback hits under active runtime recall roots", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-archive-abs-ns-"));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-archive-runtime-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    qmdColdTierEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const StorageManagerCtor = orchestrator.storage.constructor as new (
    dir: string,
  ) => typeof orchestrator.storage;
  const runtimeStorage = new StorageManagerCtor(runtimeDir);
  const { id: memoryId } = await runtimeStorage.writeMemory(
    "fact",
    "runtime archive fallback absolute memory",
  );
  const memory = await runtimeStorage.getMemoryById(memoryId);
  assert.ok(memory);

  const originalStorageFor = orchestrator.storageRouter.storageFor.bind(
    orchestrator.storageRouter,
  );
  orchestrator.storageRouter.storageFor = async (namespace: string) =>
    namespace === "runtime-archive"
      ? runtimeStorage
      : originalStorageFor(namespace);

  orchestrator.qmd = {
    isAvailable: () => false,
  };
  orchestrator.searchLongTermArchiveFallback = async () => [
    {
      docid: memory.frontmatter.id,
      path: memory.path,
      snippet: "runtime archive fallback absolute memory",
      score: 0.9,
    },
  ];

  const results = await orchestrator.applyColdFallbackPipeline({
    prompt: "review runtime archive fallback",
    recallNamespaces: ["runtime-archive"],
    recallResultLimit: 2,
    recallMode: "full",
    queryAwarePrefilter: EMPTY_PREFILTER,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].docid, memory.frontmatter.id);
  assert.equal(results[0].path, memory.path);
});

test("graph expansion resolves cold collection seeds from active recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-graph-"));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-cold-graph-runtime-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    qmdColdTierEnabled: true,
    qmdColdCollection: "openclaw-engram-cold",
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const StorageManagerCtor = orchestrator.storage.constructor as new (
    dir: string,
  ) => typeof orchestrator.storage;
  const runtimeStorage = new StorageManagerCtor(runtimeDir);
  const { id: memoryId } = await runtimeStorage.writeMemory(
    "fact",
    "runtime cold graph seed memory",
  );
  const memory = await runtimeStorage.getMemoryById(memoryId);
  assert.ok(memory);
  const migrated = await runtimeStorage.migrateMemoryToTier(memory, "cold");
  const coldRelativePath = path
    .relative(path.join(runtimeStorage.dir, "cold"), migrated.targetPath)
    .split(path.sep)
    .join("/");

  const originalStorageFor = orchestrator.storageRouter.storageFor.bind(
    orchestrator.storageRouter,
  );
  orchestrator.storageRouter.storageFor = async (namespace: string) =>
    namespace === "runtime-cold"
      ? runtimeStorage
      : originalStorageFor(namespace);

  // #1526 seam 11: readQmdResultMemory moved to QmdResultResolver coordinator.
  const resolver = orchestrator.qmdResultResolver;
  const originalReadQmdResultMemory =
    resolver.readQmdResultMemory.bind(resolver);
  let qmdMemoryReads = 0;
  resolver.readQmdResultMemory = async (...args: unknown[]) => {
    qmdMemoryReads += 1;
    return originalReadQmdResultMemory(...args);
  };

  let graphSeedPaths: string[] = [];
  orchestrator.graphIndexFor = () => ({
    spreadingActivation: async (seedPaths: string[]) => {
      graphSeedPaths = seedPaths;
      return [];
    },
  });

  const expanded = await orchestrator.expandResultsViaGraph({
    memoryResults: [
      {
        docid: memory.frontmatter.id,
        path: `openclaw-engram-cold/${coldRelativePath}`,
        snippet: "runtime cold graph seed memory",
        score: 0.9,
      },
    ],
    recallNamespaces: ["missing-cold", "runtime-cold", "other-cold"],
    recallResultLimit: 2,
  });

  assert.equal(qmdMemoryReads, 1);
  assert.deepEqual(expanded.seedPaths, [migrated.targetPath]);
  assert.deepEqual(graphSeedPaths, [
    path.relative(runtimeStorage.dir, migrated.targetPath).split(path.sep).join("/"),
  ]);
});

test("recall safety resolves absolute QMD paths from runtime recall namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-runtime-ns-"));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-runtime-root-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg) as any;
  const StorageManagerCtor = orchestrator.storage.constructor as new (
    dir: string,
  ) => typeof orchestrator.storage;
  const runtimeStorage = new StorageManagerCtor(runtimeDir);
  const { id: memoryId } = await runtimeStorage.writeMemory(
    "fact",
    "runtime namespace absolute QMD memory",
  );
  const memory = await runtimeStorage.getMemoryById(memoryId);
  assert.ok(memory);

  const originalStorageFor = orchestrator.storageRouter.storageFor.bind(
    orchestrator.storageRouter,
  );
  orchestrator.storageRouter.storageFor = async (namespace: string) =>
    namespace === "runtime-overlay"
      ? runtimeStorage
      : originalStorageFor(namespace);

  const result = {
    docid: memory.frontmatter.id,
    path: memory.path,
    snippet: "runtime namespace absolute QMD memory",
    score: 0.9,
  };
  const withoutRuntimeNamespace = await orchestrator.filterSearchResultsForRecall(
    [result],
    undefined,
    { dropUnresolved: true },
  );
  assert.equal(withoutRuntimeNamespace.results.length, 0);

  const withRuntimeNamespace = await orchestrator.filterSearchResultsForRecall(
    [result],
    undefined,
    { dropUnresolved: true, recallNamespaces: ["runtime-overlay"] },
  );
  assert.equal(withRuntimeNamespace.results.length, 1);
  assert.equal(
    withRuntimeNamespace.memoryByPath.get(memory.path)?.frontmatter.id,
    memory.frontmatter.id,
  );
});

test("recall safety keeps signal-only memory reads concurrent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-review-signal-concurrency-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg) as any;
  let activeReads = 0;
  let maxActiveReads = 0;
  orchestrator.readQmdResultMemory = async (resultPath: string) => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeReads -= 1;
    return {
      path: resultPath,
      content: "memory",
      frontmatter: {
        id: resultPath,
        category: "fact",
        created: "2026-03-11T12:00:00.000Z",
        updated: "2026-03-11T12:00:00.000Z",
      },
    };
  };

  const controller = new AbortController();
  const loaded = await orchestrator.loadSearchResultMemoryMap(
    Array.from({ length: 8 }, (_, index) => ({
      docid: `fact-${index}`,
      path: `facts/2026-03-11/fact-${index}.md`,
      snippet: "memory",
      score: 0.9,
    })),
    undefined,
    { abortSignal: controller.signal },
  );

  assert.equal(loaded.completed, true);
  assert.equal(loaded.memoryByPath.size, 8);
  assert.ok(maxActiveReads > 1);
});

test("QMD recall snapshot helpers read persisted snapshots and memory_qmd_debug is registered", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-debug-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
  });
  const orchestrator = new Orchestrator(cfg);
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "state", "last_qmd_recall.json"),
    JSON.stringify(
      {
        recordedAt: "2026-03-11T12:00:00.000Z",
        queryHash: "query-123",
        queryLength: 24,
        collection: "openclaw-engram",
        namespaces: ["default"],
        fetchLimit: 12,
        primaryResultCount: 5,
        hybridResultCount: 0,
        queryAwareSeedCount: 1,
        resultCount: 3,
        intentHint: "goal:review action:review",
        explainEnabled: true,
        hybridTopUpUsed: false,
        hybridTopUpSkippedReason: "intent_hint_active",
        results: [
          {
            docid: "fact-1",
            path: "facts/2026-03-11/fact-1.md",
            snippet: "fact one",
            score: 0.91,
            transport: "daemon",
            explain: {
              blendedScore: 0.91,
              rerankScore: 0.66,
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );

  const snapshot =
    await orchestrator.recallIntrospection.getLastQmdRecallSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.intentHint, "goal:review action:review");

  const explanation =
    await orchestrator.recallIntrospection.explainLastQmdRecall();
  assert.match(explanation, /Last QMD Recall/);
  assert.match(explanation, /intent hint/i);
  assert.match(explanation, /hybrid top-up skipped reason/i);

  const tools = new Map<string, {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  }>();
  registerTools({
    registerTool(spec: {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }) {
      tools.set(spec.name, spec);
    },
  } as never, {
    config: {
      defaultNamespace: "default",
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
      identityContinuityEnabled: false,
    },
    recallIntrospection: {
      explainLastIntent: async () => "noop",
      explainLastQmdRecall: async () => "## Last QMD Recall\n\nIntent hint: goal:review",
      explainLastGraphRecall: async () => "noop",
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
      readIdentityAnchor: async () => null,
      writeIdentityAnchor: async () => {},
    },
    getStorageForNamespace: async () => ({
      readProfile: async () => "",
      readIdentityReflections: async () => "",
    }),
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      loadCheckpoint: async () => null,
      clearCheckpoint: async () => {},
    },
    searchAcrossNamespaces: async () => [],
  } as never);

  const tool = tools.get("memory_qmd_debug");
  assert.ok(tool);
  const result = await tool.execute("call-1", {});
  const text = result.content.map((item) => item.text).join("\n");
  assert.match(text, /Last QMD Recall/);
  await readFile(path.join(memoryDir, "state", "last_qmd_recall.json"), "utf-8");
});
