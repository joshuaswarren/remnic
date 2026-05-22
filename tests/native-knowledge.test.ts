import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import {
  collectNativeKnowledgeChunks,
  formatNativeKnowledgeSection,
  resolveCuratedIncludeFilesStatePath,
  searchNativeKnowledge,
  syncCuratedIncludeFiles,
} from "../src/native-knowledge.js";

test("collectNativeKnowledgeChunks reads configured workspace files and preserves heading ranges", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# Identity\n\nPrefers concise responses.\n\n## Work Style\n\nLikes deterministic tests.\n",
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nThe API rate limit issue was caused by a stale token.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["IDENTITY.md", "MEMORY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.sourcePath, "IDENTITY.md");
  assert.equal(chunks[1]?.title, "Work Style");
  assert.equal(chunks[2]?.sourcePath, "MEMORY.md");
});

test("collectNativeKnowledgeChunks ignores includeFiles outside the workspace", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-root-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const outsideFile = path.join(rootDir, "outside.md");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(outsideFile, "# Outside\n\nMust not be indexed.\n", "utf-8");

  try {
    const chunks = await collectNativeKnowledgeChunks({
      workspaceDir,
      config: {
        enabled: true,
        includeFiles: ["../outside.md"],
        maxChunkChars: 200,
        maxResults: 4,
        maxChars: 2400,
        stateDir: "state/native-knowledge",
        obsidianVaults: [],
      },
      defaultNamespace: "default",
    });

    assert.equal(chunks.length, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("collectNativeKnowledgeChunks includes namespaced identity files for allowed recall namespaces", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-ns-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "IDENTITY.shared.md"), "# Shared\n\nShared deployment notes.\n", "utf-8");

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["IDENTITY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sourcePath, "IDENTITY.shared.md");
});

test("collectNativeKnowledgeChunks preserves include file directory for namespaced identity variants", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-subdir-"));
  await mkdir(path.join(workspaceDir, "docs"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "docs", "IDENTITY.shared.md"),
    "# Shared\n\nShared notes in docs.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["docs/IDENTITY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sourcePath, "docs/IDENTITY.shared.md");
});

test("collectNativeKnowledgeChunks preserves exact line ranges when long sections split by paragraphs", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-lines-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    [
      "# Memory",
      "",
      "First paragraph is intentionally long to trigger paragraph chunking and keep exact line numbers.",
      "",
      "",
      "Second paragraph is also intentionally long so it becomes its own chunk with preserved metadata.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["MEMORY.md"],
      maxChunkChars: 90,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => ({
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkId: chunk.chunkId,
    })),
    [
      { startLine: 3, endLine: 3, chunkId: "MEMORY.md:3-3" },
      { startLine: 6, endLine: 6, chunkId: "MEMORY.md:6-6" },
    ],
  );
});

test("collectNativeKnowledgeChunks persists incremental state for includeFiles when memoryDir is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-sync-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nTrack rollout checkpoints here.\n",
    "utf-8",
  );

  const config = {
    enabled: true,
    includeFiles: ["MEMORY.md"],
    maxChunkChars: 200,
    maxResults: 4,
    maxChars: 2400,
    stateDir: "state/native-knowledge",
    obsidianVaults: [],
  };

  try {
    const first = await collectNativeKnowledgeChunks({
      workspaceDir,
      memoryDir,
      config,
      defaultNamespace: "default",
    });
    assert.equal(first.length, 1);

    const statePath = resolveCuratedIncludeFilesStatePath(memoryDir, config);
    const firstState = JSON.parse(await readFile(statePath, "utf-8")) as {
      version: number;
      files: Record<string, { deleted: boolean; chunks: unknown[] }>;
    };
    assert.equal(firstState.version, 1);
    assert.equal(firstState.files["MEMORY.md"]?.deleted, false);
    assert.equal(firstState.files["MEMORY.md"]?.chunks.length, 1);

    await unlink(path.join(workspaceDir, "MEMORY.md"));
    const second = await collectNativeKnowledgeChunks({
      workspaceDir,
      memoryDir,
      config,
      defaultNamespace: "default",
    });
    assert.equal(second.length, 0);

    const secondState = JSON.parse(await readFile(statePath, "utf-8")) as {
      files: Record<string, { deleted: boolean; chunks: unknown[] }>;
    };
    assert.equal(secondState.files["MEMORY.md"]?.deleted, true);
    assert.equal(secondState.files["MEMORY.md"]?.chunks.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("include-file sync keeps namespaced identity variants active across recall scopes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-sync-scope-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.shared.md"),
    "# Shared Identity\n\nShared operator guidance.\n",
    "utf-8",
  );

  const config = {
    enabled: true,
    includeFiles: ["IDENTITY.md"],
    maxChunkChars: 200,
    maxResults: 4,
    maxChars: 2400,
    stateDir: "state/native-knowledge",
    obsidianVaults: [],
  };

  const statePath = resolveCuratedIncludeFilesStatePath(memoryDir, config);
  await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  const sharedScopeState = JSON.parse(await readFile(statePath, "utf-8")) as {
    files: Record<string, { deleted: boolean; namespace?: string }>;
  };
  assert.equal(sharedScopeState.files["IDENTITY.shared.md"]?.deleted, false);
  assert.equal(sharedScopeState.files["IDENTITY.shared.md"]?.namespace, "shared");

  const defaultScopeChunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["default"],
    defaultNamespace: "default",
  });
  assert.equal(defaultScopeChunks.some((chunk) => chunk.sourcePath === "IDENTITY.shared.md"), false);

  const defaultScopeState = JSON.parse(await readFile(statePath, "utf-8")) as {
    files: Record<string, { deleted: boolean; namespace?: string }>;
  };
  assert.equal(defaultScopeState.files["IDENTITY.shared.md"]?.deleted, false);
  assert.equal(defaultScopeState.files["IDENTITY.shared.md"]?.namespace, "shared");
});

test("include-file sync chunkCount reports synced chunks even when recall filtering hides them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-sync-count-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.shared.md"),
    "# Shared Identity\n\nShared operator guidance.\n",
    "utf-8",
  );

  const config = {
    enabled: true,
    includeFiles: ["IDENTITY.md"],
    maxChunkChars: 200,
    maxResults: 4,
    maxChars: 2400,
    stateDir: "state/native-knowledge",
    obsidianVaults: [],
  };

  const result = await syncCuratedIncludeFiles({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["default"],
    defaultNamespace: "default",
  });

  assert.equal(result.activeChunks.length, 0);
  assert.equal(result.chunkCount, 1);
});

test("include-file sync preserves prior tombstones instead of recounting deleted files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-sync-tombstone-"));
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  await writeFile(identityPath, "# Identity\n\nTemporary note.\n", "utf-8");

  const config = {
    enabled: true,
    includeFiles: ["IDENTITY.md"],
    maxChunkChars: 200,
    maxResults: 4,
    maxChars: 2400,
    stateDir: "state/native-knowledge",
    obsidianVaults: [],
  };

  await syncCuratedIncludeFiles({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["default"],
    defaultNamespace: "default",
  });
  await unlink(identityPath);

  const firstDeletion = await syncCuratedIncludeFiles({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["default"],
    defaultNamespace: "default",
  });
  const secondDeletion = await syncCuratedIncludeFiles({
    workspaceDir,
    memoryDir,
    config,
    recallNamespaces: ["default"],
    defaultNamespace: "default",
  });

  assert.equal(firstDeletion.deletedFiles, 1);
  assert.equal(secondDeletion.deletedFiles, 0);
});

test("default private curated chunks remain visible when shared recall also includes default namespace", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-private-default-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    ["---", "privacyClass: private", "---", "# Identity", "", "Default-only operator note.", ""].join("\n"),
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "IDENTITY.shared.md"),
    ["---", "privacyClass: private", "---", "# Shared Identity", "", "Shared private note.", ""].join("\n"),
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["IDENTITY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
    recallNamespaces: ["default", "shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.some((chunk) => chunk.sourcePath === "IDENTITY.md"), true);
  assert.equal(chunks.some((chunk) => chunk.sourcePath === "IDENTITY.shared.md"), false);
});

test("searchNativeKnowledge ranks identity and phrase matches highest", () => {
  const results = searchNativeKnowledge({
    query: "deterministic tests",
    maxResults: 3,
    chunks: [
      {
        chunkId: "a",
        sourcePath: "MEMORY.md",
        title: "Memory",
        sourceKind: "memory",
        startLine: 1,
        endLine: 2,
        content: "This mentions tests in passing.",
      },
      {
        chunkId: "b",
        sourcePath: "IDENTITY.md",
        title: "Work Style",
        sourceKind: "identity",
        startLine: 3,
        endLine: 4,
        content: "Likes deterministic tests and small review loops.",
      },
    ],
  });

  assert.equal(results[0]?.sourcePath, "IDENTITY.md");
  assert.match(formatNativeKnowledgeSection({ results, maxChars: 1000 }) ?? "", /Curated Workspace Knowledge/);
});
