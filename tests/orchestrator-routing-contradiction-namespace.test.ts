import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("checkForContradiction resolves candidate memory in routed namespace storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-contradiction-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    contradictionDetectionEnabled: true,
    contradictionAutoResolve: true,
    contradictionSimilarityThreshold: 0.2,
    contradictionMinConfidence: 0.7,
  });

  const orchestrator = new Orchestrator(config) as any;
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.ensureDirectories();

  const { id: sharedId } = await sharedStorage.writeMemory("fact", "legacy shared fact");
  const sharedMemory = await sharedStorage.getMemoryById(sharedId);
  assert.ok(sharedMemory);

  orchestrator.qmd = {
    isAvailable: () => false,
  };
  orchestrator.searchAcrossNamespaces = async () => [
      {
        docid: sharedId,
        path: sharedMemory!.path,
        snippet: "legacy shared fact",
        score: 0.95,
      },
    ];
  orchestrator.extraction = {
    verifyContradiction: async () => ({
      isContradiction: true,
      confidence: 0.95,
      reasoning: "new memory supersedes old shared fact",
      whichIsNewer: "second",
    }),
  };

  const contradiction = await orchestrator.checkForContradiction("new shared fact", "fact", "shared");
  assert.ok(contradiction);
  assert.equal(contradiction.supersededId, sharedId);

  const superseded = await sharedStorage.getMemoryById(sharedId);
  assert.equal(superseded?.frontmatter.status, "superseded");
});

test("checkForContradiction ignores candidates outside target write namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-contradiction-scope-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    contradictionDetectionEnabled: true,
    contradictionAutoResolve: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.ensureDirectories();

  const { id: sharedId } = await sharedStorage.writeMemory("fact", "shared tenant memory");
  const sharedMemory = await sharedStorage.getMemoryById(sharedId);
  assert.ok(sharedMemory);

  orchestrator.qmd = {
    isAvailable: () => true,
  };
  orchestrator.searchAcrossNamespaces = async () => [
      {
        docid: sharedId,
        path: sharedMemory!.path,
        snippet: "shared tenant memory",
        score: 0.95,
      },
    ];
  orchestrator.extraction = {
    verifyContradiction: async () => ({
      isContradiction: true,
      confidence: 0.95,
      reasoning: "would supersede if namespace matched",
      whichIsNewer: "second",
    }),
  };

  const contradiction = await orchestrator.checkForContradiction("new default fact", "fact", "default");
  assert.equal(contradiction, null);

  const sharedAfter = await sharedStorage.getMemoryById(sharedId);
  assert.equal(sharedAfter?.frontmatter.status ?? "active", "active");
});

test("suggestLinksForMemory still uses namespace router when default qmd backend is unavailable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-links-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    memoryLinkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  const sharedStorage = await orchestrator.getStorage("shared");
  await sharedStorage.ensureDirectories();

  const { id: sharedId } = await sharedStorage.writeMemory("fact", "shared tenant memory");
  const sharedMemory = await sharedStorage.getMemoryById(sharedId);
  assert.ok(sharedMemory);

  orchestrator.qmd = {
    isAvailable: () => false,
  };
  orchestrator.searchAcrossNamespaces = async () => [
    {
      docid: sharedId,
      path: sharedMemory!.path,
      snippet: "shared tenant memory",
      score: 0.95,
    },
  ];
  orchestrator.extraction = {
    suggestLinks: async () => ({
      links: [
        {
          targetId: sharedId,
          linkType: "supports",
          strength: 0.9,
          reason: "same tenant context",
        },
      ],
    }),
  };

  const links = await orchestrator.suggestLinksForMemory("new shared fact", "fact", "shared");
  assert.equal(links.length, 1);
  assert.equal(links[0]?.targetId, sharedId);
});

test("contradiction and link checks fail open when search is unavailable without namespaces", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-no-qmd-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: false,
    contradictionDetectionEnabled: true,
    memoryLinkingEnabled: true,
  });

  const orchestrator = new Orchestrator(config) as any;
  orchestrator.qmd = {
    isAvailable: () => false,
    search: async () => {
      throw new Error("search should not run when backend is unavailable");
    },
    hybridSearch: async () => {
      throw new Error("hybrid search should not run when backend is unavailable");
    },
    bm25Search: async () => {
      throw new Error("bm25 search should not run when backend is unavailable");
    },
    vectorSearch: async () => {
      throw new Error("vector search should not run when backend is unavailable");
    },
  };

  const contradiction = await orchestrator.checkForContradiction("fact", "fact", "default");
  const links = await orchestrator.suggestLinksForMemory("fact", "fact", "default");

  assert.equal(contradiction, null);
  assert.deepEqual(links, []);
});
