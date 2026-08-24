import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

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

  // #1645: checkForContradiction defers auto-resolve to after writeMemory so
  // the caller can gate the supersede on the new write's tombstone status.
  // The old memory must stay active here — the caller performs the retire.
  const oldAfterDetect = await sharedStorage.getMemoryById(sharedId);
  assert.equal(
    oldAfterDetect?.frontmatter.status,
    "active",
    "#1645: checkForContradiction must not eagerly retire the old memory",
  );
});

test("#1645: contradictionAutoResolve defers supersede when new write is tombstone-blocked", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1645-tombstone-contradiction-"));
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

  // Enable tombstones on the shared namespace so a tombstone-matched write
  // lands pending_review (tombstoneBlocked=true on the writeMemory result).
  sharedStorage.setTombstonesConfig({
    enabled: true,
    semanticMatch: false,
    semanticThreshold: 0.9,
    namespace: "shared",
  });

  // Existing active memory that the new fact contradicts.
  const { id: oldId } = await sharedStorage.writeMemory(
    "fact",
    "The server runs on port 3000",
  );
  const oldMemory = await sharedStorage.getMemoryById(oldId);
  assert.ok(oldMemory);

  // Tombstone for the NEW content — writeMemory will block this as pending_review.
  await sharedStorage.appendTombstone({
    reason: "correction",
    createdBy: "user_correction",
    sourceMemoryId: oldId,
    rawContent: "The server runs on port 8080",
  });

  orchestrator.qmd = { isAvailable: () => false };
  orchestrator.searchAcrossNamespaces = async () => [
    {
      docid: oldId,
      path: oldMemory!.path,
      snippet: "The server runs on port 3000",
      score: 0.95,
    },
  ];
  orchestrator.extraction = {
    verifyContradiction: async () => ({
      isContradiction: true,
      confidence: 0.95,
      reasoning: "port changed from 3000 to 8080",
      whichIsNewer: "second",
    }),
  };

  // checkForContradiction detects but does NOT supersede (#1645 deferral).
  const contradiction = await orchestrator.checkForContradiction(
    "The server runs on port 8080",
    "fact",
    "shared",
  );
  assert.ok(contradiction);
  assert.equal(contradiction.supersededId, oldId);

  // Old memory is still active — the supersede was deferred.
  const oldAfterDetect = await sharedStorage.getMemoryById(oldId);
  assert.equal(oldAfterDetect?.frontmatter.status, "active");

  // The new write matches a tombstone → tombstoneBlocked (pending_review).
  const newWrite = await sharedStorage.writeMemory(
    "fact",
    "The server runs on port 8080",
    { source: "extraction" },
  );
  assert.ok(
    newWrite.tombstoneBlocked,
    "new fact matching a tombstone must be blocked (pending_review)",
  );

  // The post-write guard sees tombstoneBlocked → does NOT call supersedeMemory.
  // Old memory stays active — neither copy is lost. This is the #1645 fix.
  const oldAfterBlock = await sharedStorage.getMemoryById(oldId);
  assert.equal(
    oldAfterBlock?.frontmatter.status,
    "active",
    "#1645: a tombstone-blocked contradiction must NOT retire the old active memory",
  );
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

test("#1645 yG2: applyDeferredContradictionResolve clears supersedes on a tombstone-blocked write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-1645-tombstone-supersedes-clear-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: false,
    contradictionAutoResolve: true,
  });
  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage();
  await storage.ensureDirectories();
  storage.setTombstonesConfig({
    enabled: true,
    semanticMatch: false,
    semanticThreshold: 0.9,
    namespace: "default",
  });

  const { id: oldId } = await storage.writeMemory("fact", "The cache TTL is 60 seconds");
  await storage.appendTombstone({
    reason: "correction",
    createdBy: "user",
    sourceMemoryId: oldId,
    rawContent: "The cache TTL is 300 seconds",
  });

  // New write that is tombstone-blocked AND carries the pre-write supersedes
  // link (mirrors the extraction path when contradictionAutoResolve sets
  // supersedes before tombstone status is known).
  const blocked = await storage.writeMemory("fact", "The cache TTL is 300 seconds", {
    source: "extraction",
    supersedes: oldId,
  });
  assert.equal(blocked.tombstoneBlocked, true, "write must be tombstone-blocked");
  const before = await storage.getMemoryById(blocked.id);
  assert.equal(
    before?.frontmatter.supersedes,
    oldId,
    "blocked row carries the pre-write supersedes link",
  );

  await orchestrator.applyDeferredContradictionResolve(
    {
      supersededId: oldId,
      reason: "ttl changed",
      supersededPath: before!.path,
      supersededCreated: before!.frontmatter.created,
      supersededTags: [],
    },
    storage,
    blocked.id,
    true, // postWriteGuard — the new write is tombstone-blocked
  );

  const after = await storage.getMemoryById(blocked.id);
  assert.equal(
    after?.frontmatter.supersedes,
    undefined,
    "#1645 yG2: supersedes must be cleared on a blocked row so it does not claim to supersede a still-active memory",
  );

  // The old memory stays active — neither copy is lost.
  const oldAfter = await storage.getMemoryById(oldId);
  assert.equal(oldAfter?.frontmatter.status, "active");
});
