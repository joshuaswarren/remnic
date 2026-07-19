import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
import { namespaceIdentityToken } from "./namespaces/identity.js";
import { namespaceCollectionName } from "./namespaces/search.js";
import { SecureStoreLockedError } from "./secure-store/index.js";
import { StorageManager } from "./storage.js";
import { serializeLifecycleAppendPayload } from "./storage/memory-lifecycle-ledger-access.js";
import type { MemoryLifecycleEvent, PluginConfig } from "./types.js";
import { LastRecallStore } from "./recall-state.js";
import type { DrainPendingImpressionsResult } from "./recall-state.js";

function makeConfig(): PluginConfig {
  return {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "team", readPrincipals: ["reader", "writer"], writePrincipals: ["writer"] },
    ],
    memoryDir: "/synthetic/mem",
    defaultRecallNamespaces: ["self", "shared"],
    principalFromSessionKeyMode: "disabled",
    principalFromSessionKeyRules: [],
    briefing: { enabled: false, defaultWindow: "yesterday" },
    daySum: { enabled: false },
    searchBackend: "orama",
    qmd: { enabled: false },
    qmdCollection: "test-memory",
    qmdMaxResults: 10,
    nativeKnowledge: { enabled: false },
    recall: { budget: {} },
    consolidation: { enabled: false },
    extraction: { enabled: false },
    lcm: { enabled: false },
  } as unknown as PluginConfig;
}

function makeService(): {
  service: EngramAccessService;
  storage: StorageManager;
  getStorageCalls: string[];
} {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const storage = {
    marker: "team-storage",
    async browseProjectedMemories() {
      return { total: 0, memories: [] };
    },
  } as unknown as StorageManager;
  const getStorageCalls: string[] = [];

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      qmd: {
        search(query: string, collection?: string, maxResults?: number): Promise<unknown[]>;
        searchGlobal(query: string, maxResults?: number): Promise<unknown[]>;
      };
      getStorage(namespace: string): Promise<StorageManager>;
      drainPendingRecallImpressions(): Promise<DrainPendingImpressionsResult>;
      searchAcrossNamespaces(params: {
        query: string;
        namespaces?: string[];
        maxResults?: number;
        mode?: string;
      }): Promise<unknown[]>;
    };
  }).orchestrator = {
    config: makeConfig(),
    qmd: {
      async search() {
        throw new Error("qmd.search should not run in namespace mode");
      },
      async searchGlobal() {
        throw new Error("qmd.searchGlobal should not run in namespace mode");
      },
    },
    async getStorage(namespace: string): Promise<StorageManager> {
      getStorageCalls.push(namespace);
      return storage;
    },
    async drainPendingRecallImpressions(): Promise<DrainPendingImpressionsResult> {
      return { folded: false, pendingDeferred: false };
    },
    async searchAcrossNamespaces() {
      return [];
    },
  };

  return { service, storage, getStorageCalls };
}

test("getWritableStorageForNamespace denies read-only principals before storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.getWritableStorageForNamespace("team", "reader"),
    /namespace is not writable: team/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("getWritableStorageForNamespace denies missing principals before storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.getWritableStorageForNamespace("team", undefined),
    /authentication required/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("getWritableStorageForNamespace resolves namespace storage for write principals", async () => {
  const { service, storage, getStorageCalls } = makeService();

  const resolved = await service.getWritableStorageForNamespace("team", "writer");

  assert.equal(resolved.namespace, "team");
  assert.equal(resolved.storage, storage);
  assert.deepEqual(getStorageCalls, ["team"]);
});

test("memoryBrowse denies missing principals before namespace storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.memoryBrowse({ namespace: "team" }),
    /authentication required/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("memoryBrowse denies principals without read access before namespace storage lookup", async () => {
  const { service, getStorageCalls } = makeService();

  await assert.rejects(
    () => service.memoryBrowse({ namespace: "team", authenticatedPrincipal: "stranger" }),
    /namespace is not readable: team/,
  );
  assert.deepEqual(getStorageCalls, []);
});

test("memoryBrowse resolves namespace storage for read principals", async () => {
  const { service, getStorageCalls } = makeService();

  const result = await service.memoryBrowse({
    namespace: "team",
    authenticatedPrincipal: "reader",
  });

  assert.equal(result.namespace, "team");
  assert.equal(result.count, 0);
  assert.deepEqual(getStorageCalls, ["team"]);
});

test("last recall serialization resolves namespace collection-prefixed result paths", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-ns-"));
  const teamDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("team"),
  );
  const memoryPath = path.join(
    teamDir,
    "archive",
    "facts",
    "2026-06-16",
    "fact-001.md",
  );
  const teamMemory = {
    path: memoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
      tags: ["discord"],
    },
    content: "Agent-authored status update from the channel.",
  };
  const readCalls: Array<{ namespace: string; path: string }> = [];
  const storages: Record<string, StorageManager> = {
    default: {
      dir: memoryRoot,
      async readMemoryByPath(filePath: string) {
        readCalls.push({ namespace: "default", path: filePath });
        return null;
      },
      async getMemoryById() {
        return null;
      },
    } as unknown as StorageManager,
    team: {
      dir: teamDir,
      async readMemoryByPath(filePath: string) {
        readCalls.push({ namespace: "team", path: filePath });
        return filePath === memoryPath ? teamMemory : null;
      },
      async getMemoryById() {
        return null;
      },
    } as unknown as StorageManager,
  };

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string) {
      return storages[namespace] ?? storages.default;
    },
  };

  const collection = namespaceCollectionName("test-memory", "team", {
    defaultNamespace: "default",
    useLegacyDefaultCollection: false,
  });
  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: [`${collection}/archive/facts/2026-06-16/fact-001.md`],
    },
    "summary",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "fact-001");
  assert.equal(result[0].path, memoryPath);
  assert.equal(result[0].status, "archived");
  assert.ok(result[0].preview.includes("Agent-authored status update"));
  assert.ok(
    readCalls.some(
      (call) => call.namespace === "team" && call.path === memoryPath,
    ),
    "expected collection-prefixed result path to resolve through team storage",
  );
});

test("last recall serialization does not fall back after namespace collection misses", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-ns-miss-"));
  const defaultMemoryPath = path.join(
    memoryRoot,
    "facts",
    "2026-06-16",
    "fact-001.md",
  );
  const defaultMemory = {
    path: defaultMemoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Default namespace content should not be reused.",
  };
  const teamDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("team"),
  );
  const readCalls: Array<{ namespace: string; path: string }> = [];
  const storages: Record<string, StorageManager> = {
    default: {
      dir: memoryRoot,
      async readMemoryByPath(filePath: string) {
        readCalls.push({ namespace: "default", path: filePath });
        return filePath === defaultMemoryPath ? defaultMemory : null;
      },
      async getMemoryById() {
        return null;
      },
    } as unknown as StorageManager,
    team: {
      dir: teamDir,
      async readMemoryByPath(filePath: string) {
        readCalls.push({ namespace: "team", path: filePath });
        return null;
      },
      async getMemoryById() {
        return null;
      },
    } as unknown as StorageManager,
  };

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string) {
      return storages[namespace] ?? storages.default;
    },
  };

  const collection = namespaceCollectionName("test-memory", "team", {
    defaultNamespace: "default",
    useLegacyDefaultCollection: false,
  });
  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: [`${collection}/2026-06-16/fact-001.md`],
    },
    "summary",
  );

  assert.deepEqual(result, []);
  assert.ok(
    readCalls.every((call) => call.namespace === "team"),
    "expected recognized collection-prefixed miss not to probe default storage",
  );
});

test("last recall serialization resolves cold collection paths through snapshot storage", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-cold-"));
  const coldMemoryPath = path.join(
    memoryRoot,
    "cold",
    "facts",
    "2026-06-16",
    "fact-001.md",
  );
  const coldMemory = {
    path: coldMemoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Cold namespace recall content.",
  };
  const readCalls: string[] = [];
  const storage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push(filePath);
      return filePath === coldMemoryPath ? coldMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: {
      ...makeConfig(),
      qmdColdCollection: "test-memory-cold",
    },
    async getStorage() {
      return storage;
    },
  };

  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: ["test-memory-cold/facts/2026-06-16/fact-001.md"],
    },
    "summary",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "fact-001");
  assert.equal(result[0].path, coldMemoryPath);
  assert.ok(result[0].preview.includes("Cold namespace recall content"));
  assert.ok(readCalls.includes(coldMemoryPath));
  assert.ok(
    !readCalls.includes(path.join(memoryRoot, "test-memory-cold", "facts", "2026-06-16", "fact-001.md")),
    "expected cold collection path to resolve under cold/ rather than a collection-named subdirectory",
  );
});

test("last recall serialization propagates locked namespace collection errors", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-lock-"));
  const teamDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("team"),
  );
  const storage = {
    dir: memoryRoot,
    async readMemoryByPath() {
      return null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;
  const teamStorage = {
    dir: teamDir,
    async readMemoryByPath() {
      throw new SecureStoreLockedError("locked namespace store");
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string) {
      return namespace === "team" ? teamStorage : storage;
    },
  };

  const collection = namespaceCollectionName("test-memory", "team", {
    defaultNamespace: "default",
    useLegacyDefaultCollection: false,
  });

  await assert.rejects(
    async () =>
      await (service as unknown as {
        serializeRecallResults(
          snapshot: unknown,
          disclosure: "summary",
        ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
      }).serializeRecallResults(
        {
          sessionKey: "session-1",
          recordedAt: "2026-06-16T12:00:00.000Z",
          queryHash: "hash",
          queryLen: 4,
          memoryIds: [],
          namespace: "default",
          resultPaths: [`${collection}/2026-06-16/fact-001.md`],
        },
        "summary",
      ),
    SecureStoreLockedError,
  );
});

test("last recall serialization does not treat date paths as collection prefixes", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-date-miss-"));
  const rootMemoryPath = path.join(memoryRoot, "fact-001.md");
  const rootMemory = {
    path: rootMemoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Root basename content should not be reused.",
  };
  const readCalls: string[] = [];
  const storage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push(filePath);
      return filePath === rootMemoryPath ? rootMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage() {
      return storage;
    },
  };

  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: ["2026-06-16/fact-001.md"],
    },
    "summary",
  );

  assert.deepEqual(result, []);
  assert.ok(
    !readCalls.includes(rootMemoryPath),
    "expected date-relative miss not to probe storage root basename",
  );
});

test("last recall serialization does not strip invalid collection prefixes", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-invalid-prefix-"));
  const defaultMemoryPath = path.join(
    memoryRoot,
    "facts",
    "2026-06-16",
    "fact-001.md",
  );
  const defaultMemory = {
    path: defaultMemoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Default namespace content should not be reused.",
  };
  const readCalls: string[] = [];
  const storage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push(filePath);
      return filePath === defaultMemoryPath ? defaultMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage() {
      return storage;
    },
  };

  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: ["test-memory--not-a-token/2026-06-16/fact-001.md"],
    },
    "summary",
  );

  assert.deepEqual(result, []);
  assert.ok(
    !readCalls.includes(defaultMemoryPath),
    "expected invalid collection prefix not to probe stripped default path",
  );
});

test("last recall serialization preserves absolute paths from readable namespace storage", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-cross-ns-"));
  const teamDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("team"),
  );
  const sharedDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("shared"),
  );
  const sharedMemoryPath = path.join(
    sharedDir,
    "facts",
    "2026-06-16",
    "fact-shared.md",
  );
  const sharedMemory = {
    path: sharedMemoryPath,
    frontmatter: {
      id: "fact-shared",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Shared namespace content should survive serialization.",
  };
  const readCalls: Array<{ namespace: string; path: string }> = [];
  const defaultStorage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "default", path: filePath });
      return null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;
  const teamStorage = {
    dir: teamDir,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "team", path: filePath });
      return null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;
  const sharedStorage = {
    dir: sharedDir,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "shared", path: filePath });
      return filePath === sharedMemoryPath ? sharedMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string) {
      if (namespace === "team") return teamStorage;
      if (namespace === "shared") return sharedStorage;
      return defaultStorage;
    },
  };

  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "team",
      resultPaths: [sharedMemoryPath],
    },
    "summary",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "fact-shared");
  assert.equal(result[0].path, sharedMemoryPath);
  assert.deepEqual(readCalls, [{ namespace: "shared", path: sharedMemoryPath }]);
});

test("last recall serialization preserves absolute paths from dynamic namespace storage", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-dynamic-ns-"));
  const dynamicNamespace = "team-project-alpha";
  const dynamicDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
  );
  const dynamicMemoryPath = path.join(
    dynamicDir,
    "facts",
    "2026-06-16",
    "fact-dynamic.md",
  );
  const dynamicMemory = {
    path: dynamicMemoryPath,
    frontmatter: {
      id: "fact-dynamic",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Dynamic namespace content should survive serialization.",
  };
  const readCalls: Array<{ namespace: string; path: string }> = [];
  const defaultStorage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "default", path: filePath });
      return null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;
  const dynamicStorage = {
    dir: dynamicDir,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: dynamicNamespace, path: filePath });
      return filePath === dynamicMemoryPath ? dynamicMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: { ...makeConfig(), memoryDir: memoryRoot },
    async getStorage(namespace: string) {
      return namespace === dynamicNamespace ? dynamicStorage : defaultStorage;
    },
  };

  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "team",
      resultPaths: [dynamicMemoryPath],
    },
    "summary",
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "fact-dynamic");
  assert.deepEqual(readCalls, [
    { namespace: dynamicNamespace, path: dynamicMemoryPath },
  ]);
});

test("last recall serialization rejects traversing collection paths", async () => {
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const memoryRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-access-qmd-traversal-"));
  const defaultMemoryPath = path.join(
    memoryRoot,
    "facts",
    "2026-06-16",
    "fact-001.md",
  );
  const defaultMemory = {
    path: defaultMemoryPath,
    frontmatter: {
      id: "fact-001",
      created: "2026-06-16T12:00:00.000Z",
      updated: "2026-06-16T12:00:00.000Z",
      category: "fact",
      status: "active",
    },
    content: "Default namespace content should not be reused.",
  };
  const teamDir = path.join(
    memoryRoot,
    "namespaces",
    namespaceIdentityToken("team"),
  );
  const readCalls: Array<{ namespace: string; path: string }> = [];
  const storage = {
    dir: memoryRoot,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "default", path: filePath });
      return filePath === defaultMemoryPath ? defaultMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;
  const teamStorage = {
    dir: teamDir,
    async readMemoryByPath(filePath: string) {
      readCalls.push({ namespace: "team", path: filePath });
      return filePath === defaultMemoryPath ? defaultMemory : null;
    },
    async getMemoryById() {
      return null;
    },
  } as unknown as StorageManager;

  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string) {
      return namespace === "team" ? teamStorage : storage;
    },
  };

  const collection = namespaceCollectionName("test-memory", "team", {
    defaultNamespace: "default",
    useLegacyDefaultCollection: false,
  });
  const result = await (service as unknown as {
    serializeRecallResults(
      snapshot: unknown,
      disclosure: "summary",
    ): Promise<Array<{ id: string; path: string; preview: string; status: string }>>;
  }).serializeRecallResults(
    {
      sessionKey: "session-1",
      recordedAt: "2026-06-16T12:00:00.000Z",
      queryHash: "hash",
      queryLen: 4,
      memoryIds: [],
      namespace: "default",
      resultPaths: [`${collection}/../../facts/2026-06-16/fact-001.md`],
    },
    "summary",
  );

  assert.deepEqual(result, []);
  assert.ok(
    !readCalls.some((call) => call.path === defaultMemoryPath),
    "expected traversing collection path not to probe escaped default path",
  );
});

test("memorySearch without an explicit namespace uses readable recall namespaces", async () => {
  const { service } = makeService();
  let searchParams: unknown;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<Array<{ path: string; score: number; snippet: string }>>;
    };
  }).orchestrator.searchAcrossNamespaces = async (params) => {
    searchParams = params;
    return [{ path: "default/facts/a.md", score: 0.7, snippet: "matched" }];
  };

  const result = await service.memorySearch({
    query: "deployment notes",
    maxResults: 3,
    principal: "reader",
  });

  assert.deepEqual(searchParams, {
    query: "deployment notes",
    namespaces: ["default", "shared"],
    maxResults: 3,
    mode: "search",
  });
  assert.equal(result.count, 1);
});

test("memorySearch with an explicit namespace searches only that readable namespace", async () => {
  const { service } = makeService();
  let searchParams: unknown;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async (params) => {
    searchParams = params;
    return [];
  };

  await service.memorySearch({
    query: "release note",
    namespace: "team",
    maxResults: 2,
    principal: "reader",
  });

  assert.deepEqual(searchParams, {
    query: "release note",
    namespaces: ["team"],
    maxResults: 2,
    mode: "search",
  });
});

test("memorySearch rejects unreadable namespaces before collection routing", async () => {
  const { service } = makeService();
  let searchCalls = 0;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async () => {
    searchCalls += 1;
    return [];
  };

  await assert.rejects(
    () =>
      service.memorySearch({
        query: "release note",
        namespace: "team",
        collection: namespaceCollectionName("test-memory", "team", {
          defaultNamespace: "default",
          useLegacyDefaultCollection: false,
        }),
        principal: "stranger",
      }),
    /namespace is not readable: team/,
  );
  assert.equal(searchCalls, 0);
});

test("memorySearch rejects empty collection names", async () => {
  const { service } = makeService();
  let searchCalls = 0;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async () => {
    searchCalls += 1;
    return [];
  };

  await assert.rejects(
    () =>
      service.memorySearch({
        query: "deployment notes",
        collection: "   ",
        principal: "reader",
      }),
    /collection must be a non-empty string/,
  );
  assert.equal(searchCalls, 0);
});

test("memorySearch treats global collection as ACL-scoped when namespaces are enabled", async () => {
  const { service } = makeService();
  let globalSearchCalls = 0;
  let searchParams: unknown;
  (service as unknown as {
    orchestrator: {
      qmd: {
        searchGlobal(query: string, maxResults?: number): Promise<unknown[]>;
      };
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.qmd.searchGlobal = async () => {
    globalSearchCalls += 1;
    return [];
  };
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async (params) => {
    searchParams = params;
    return [];
  };

  await service.memorySearch({
    query: "runbook",
    collection: "global",
    principal: "reader",
  });

  assert.equal(globalSearchCalls, 0);
  assert.deepEqual(searchParams, {
    query: "runbook",
    namespaces: ["default", "shared"],
    maxResults: undefined,
    mode: "search",
  });
});

test("memorySearch accepts a namespace-scoped collection for the requested namespace", async () => {
  const { service } = makeService();
  let searchParams: unknown;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async (params) => {
    searchParams = params;
    return [];
  };

  await service.memorySearch({
    query: "release note",
    namespace: "team",
    collection: namespaceCollectionName("test-memory", "team", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: false,
    }),
    principal: "reader",
  });

  assert.deepEqual(searchParams, {
    query: "release note",
    namespaces: ["team"],
    maxResults: undefined,
    mode: "search",
  });
});

test("memorySearch accepts a readable namespace-scoped collection without duplicate namespace", async () => {
  const { service } = makeService();
  let searchParams: unknown;
  (service as unknown as {
    orchestrator: {
      searchAcrossNamespaces(params: unknown): Promise<unknown[]>;
    };
  }).orchestrator.searchAcrossNamespaces = async (params) => {
    searchParams = params;
    return [];
  };

  await service.memorySearch({
    query: "release note",
    collection: namespaceCollectionName("test-memory", "team", {
      defaultNamespace: "default",
      useLegacyDefaultCollection: false,
    }),
    principal: "reader",
  });

  assert.deepEqual(searchParams, {
    query: "release note",
    namespaces: ["team"],
    maxResults: undefined,
    mode: "search",
  });
});

test("memorySearch rejects arbitrary custom collections when namespaces are enabled", async () => {
  const { service } = makeService();
  let qmdSearchCalls = 0;
  (service as unknown as {
    orchestrator: {
      qmd: {
        search(query: string, collection?: string, maxResults?: number): Promise<unknown[]>;
      };
    };
  }).orchestrator.qmd.search = async () => {
    qmdSearchCalls += 1;
    return [];
  };

  await assert.rejects(
    () =>
      service.memorySearch({
        query: "deployment notes",
        collection: "custom-collection",
        principal: "reader",
      }),
    /collection is not namespace-scoped for the requested principal/,
  );
  assert.equal(qmdSearchCalls, 0);
});

test("memorySearch honors custom collections when namespaces are disabled", async () => {
  const { service } = makeService();
  (service as unknown as { orchestrator: { config: PluginConfig } }).orchestrator.config = {
    ...makeConfig(),
    namespacesEnabled: false,
  };
  let qmdSearchArgs: unknown[] | undefined;
  (service as unknown as {
    orchestrator: {
      qmd: {
        search(query: string, collection?: string, maxResults?: number): Promise<unknown[]>;
      };
    };
  }).orchestrator.qmd.search = async (...args) => {
    qmdSearchArgs = args;
    return [{ path: "facts/a.md", score: 0.5, snippet: "matched" }];
  };

  const result = await service.memorySearch({
    query: "deployment notes",
    collection: "custom-collection",
    maxResults: 4,
  });

  assert.deepEqual(qmdSearchArgs, ["deployment notes", "custom-collection", 4]);
  assert.equal(result.count, 1);
});

test("memorySearch rejects unsupported namespaces when namespaces are disabled", async () => {
  const { service } = makeService();
  (service as unknown as { orchestrator: { config: PluginConfig } }).orchestrator.config = {
    ...makeConfig(),
    namespacesEnabled: false,
  };
  let qmdSearchCalls = 0;
  (service as unknown as {
    orchestrator: {
      qmd: {
        search(query: string, collection?: string, maxResults?: number): Promise<unknown[]>;
      };
    };
  }).orchestrator.qmd.search = async () => {
    qmdSearchCalls += 1;
    return [];
  };

  await assert.rejects(
    () =>
      service.memorySearch({
        query: "deployment notes",
        namespace: "team",
        collection: "custom-collection",
      }),
    /unsupported namespace: team/,
  );
  assert.equal(qmdSearchCalls, 0);
});

test("offlineSyncFiles reports invalid requested paths as input errors", async () => {
  const { service } = makeService();
  (service as unknown as {
    orchestrator: {
      config: PluginConfig;
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator.getStorage = async () => ({
    dir: os.tmpdir(),
    async readOfflineSyncFile() {
      throw new Error("should not read invalid paths");
    },
  } as unknown as StorageManager);

  await assert.rejects(
    () =>
      service.offlineSyncFiles({
        namespace: "team",
        principal: "reader",
        paths: ["../escape"],
      }),
    (error: unknown) =>
      error instanceof EngramAccessInputError &&
      /paths\[\]: record path contains unsafe segments/.test(error.message),
  );
});

test("offlineSyncFiles reports symlink requested paths as input errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-files-symlink-"));
  try {
    await symlink("/tmp", path.join(root, "linked"));
    const { service } = makeService();
    (service as unknown as {
      orchestrator: {
        config: PluginConfig;
        getStorage(namespace: string): Promise<StorageManager>;
      };
    }).orchestrator.getStorage = async () => ({
      dir: root,
      async readOfflineSyncFile() {
        throw new Error("should not read symlink paths");
      },
    } as unknown as StorageManager);

    await assert.rejects(
      () =>
        service.offlineSyncFiles({
          namespace: "team",
          principal: "reader",
          paths: ["linked"],
        }),
      (error: unknown) =>
        error instanceof EngramAccessInputError &&
        /buildOfflineSyncSnapshotForPaths: record path targets a symlink/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offlineSyncSnapshot does not trust client base capture time for server fast-base scans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-snapshot-client-clock-"));
  try {
    const relPath = "facts/a.md";
    const filePath = path.join(root, relPath);
    const content = Buffer.from("alpha");
    const mtimeMs = 1_700_000_000_000;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
    const baseFile = {
      path: relPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
      mtimeMs,
    };

    const { service } = makeService();
    let digestReads = 0;
    (service as unknown as {
      orchestrator: {
        config: PluginConfig;
        getStorage(namespace: string): Promise<StorageManager>;
      };
    }).orchestrator.getStorage = async () => ({
      dir: root,
      async drainPendingMemoryLifecycleEventsForSync() {
        return { folded: false, pendingDeferred: false };
      },
      async readOfflineSyncFile(targetPath: string) {
        return readFile(targetPath);
      },
      async digestOfflineSyncFile(targetPath: string) {
        digestReads += 1;
        const content = await readFile(targetPath);
        return {
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    } as unknown as StorageManager);

    const snapshot = await service.offlineSyncSnapshot({
      namespace: "team",
      principal: "reader",
      includeContent: false,
      baseFiles: [baseFile],
      baseCapturedAt: new Date(Date.now() + 60_000),
    });

    assert.equal(digestReads, 1);
    assert.deepEqual(snapshot.files, [baseFile]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offlineSyncSnapshot drains pending recall-impression spills so a recorded impression reaches the snapshot (#2033)", async () => {
  // A record() that timed out on the rotation lock spills to the offline-sync
  // EXCLUDED recall_impressions.jsonl.pending.d/. Without a pre-snapshot drain
  // the impression is absent from the pushed snapshot and lost if this node is
  // discarded. offlineSyncSnapshot() must fold the spill into the synced active
  // recall_impressions.jsonl before building.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-impression-drain-"));
  try {
    const impressionsPath = path.join(root, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const row = `${JSON.stringify({ sessionKey: "s1", writeNonce: "n-1", memoryIds: ["m-1"] })}\n`;
    await writeFile(path.join(pendingDir, "spill-1.jsonl"), row, "utf-8");

    const { service } = makeService();
    const orchestrator = (service as unknown as {
      orchestrator: {
        config: PluginConfig;
        getStorage(namespace: string): Promise<StorageManager>;
        drainPendingRecallImpressions(): Promise<DrainPendingImpressionsResult>;
      };
    }).orchestrator;
    // The writer store roots at config.memoryDir — the SAME instance the drain
    // must fold from. Here memoryDir === storage.dir (the offline-synced root),
    // so the folded active file lands in the snapshot.
    orchestrator.config.memoryDir = root;
    const writerStore = new LastRecallStore(root, {
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
    });
    orchestrator.drainPendingRecallImpressions = () => writerStore.drainPendingImpressions();
    orchestrator.getStorage = async () => ({
      dir: root,
      async drainPendingMemoryLifecycleEventsForSync() {
        return { folded: false, pendingDeferred: false };
      },
      async readOfflineSyncFile(targetPath: string) {
        return readFile(targetPath);
      },
      async digestOfflineSyncFile(targetPath: string) {
        const content = await readFile(targetPath);
        return {
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    } as unknown as StorageManager);

    const snapshot = await service.offlineSyncSnapshot({
      namespace: "team",
      principal: "reader",
      includeContent: true,
    });

    const active = snapshot.files.find((f) => f.path === "state/recall_impressions.jsonl");
    assert.ok(active, "drained active impressions file is present in the snapshot");
    assert.equal(
      Buffer.from(active!.contentBase64!, "base64").toString("utf-8"),
      row,
      "the recorded impression was folded into the synced active file",
    );
    // The node-local pending spill dir stays excluded from the snapshot...
    assert.ok(
      !snapshot.files.some((f) => f.path.startsWith("state/recall_impressions.jsonl.pending.d")),
      "pending spill dir remains offline-sync excluded",
    );
    // ...because the drain already emptied it.
    assert.deepEqual(await readdir(pendingDir), [], "pending spill drained before the snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offlineSyncSnapshot drains pending impression spills at the writer root, not the namespace storage.dir (#2033)", async () => {
  // Recall impressions are appended by the orchestrator's single LastRecallStore
  // rooted at config.memoryDir, never per-namespace. A record() that times out on
  // the rotation lock spills to config.memoryDir/state/recall_impressions.jsonl.pending.d.
  // The pre-snapshot drain MUST fold from that writer root; draining the resolved
  // namespace's storage.dir (which can differ, e.g. namespaces/<token>/) looks
  // under the wrong tree and strands the impression in the offline-sync-EXCLUDED
  // pending queue — the exact defect this regression guards.
  const writerRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-writer-"));
  const nsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-impression-drain-ns-"));
  try {
    const impressionsPath = path.join(writerRoot, "state", "recall_impressions.jsonl");
    const pendingDir = `${impressionsPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const row = `${JSON.stringify({ sessionKey: "s1", writeNonce: "n-1", memoryIds: ["m-1"] })}\n`;
    await writeFile(path.join(pendingDir, "spill-1.jsonl"), row, "utf-8");

    const { service } = makeService();
    const orchestrator = (service as unknown as {
      orchestrator: {
        config: PluginConfig;
        getStorage(namespace: string): Promise<StorageManager>;
        drainPendingRecallImpressions(): Promise<DrainPendingImpressionsResult>;
      };
    }).orchestrator;
    // Writer root (config.memoryDir) is deliberately DISTINCT from the resolved
    // namespace's storage.dir so a storage.dir-rooted drain would miss the spill.
    orchestrator.config.memoryDir = writerRoot;
    const writerStore = new LastRecallStore(writerRoot, {
      impressionsRotateBytes: 0,
      impressionsRotateKeep: 5,
    });
    orchestrator.drainPendingRecallImpressions = () => writerStore.drainPendingImpressions();
    orchestrator.getStorage = async () => ({
      dir: nsDir,
      async drainPendingMemoryLifecycleEventsForSync() {
        return { folded: false, pendingDeferred: false };
      },
      async readOfflineSyncFile(targetPath: string) {
        return readFile(targetPath);
      },
      async digestOfflineSyncFile(targetPath: string) {
        const content = await readFile(targetPath);
        return {
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    } as unknown as StorageManager);

    const snapshot = await service.offlineSyncSnapshot({
      namespace: "team",
      principal: "reader",
      includeContent: true,
    });

    // Drained into the WRITER root's synced active recall_impressions.jsonl — the
    // offline-sync-ALWAYS file — so the recorded impression is included wherever
    // that writer root is synced, not lost in the excluded pending queue.
    assert.equal(
      await readFile(impressionsPath, "utf-8"),
      row,
      "spill folded into the writer-root active recall_impressions.jsonl",
    );
    assert.deepEqual(await readdir(pendingDir), [], "writer-root pending spill drained");
    // The drain did NOT write under the namespace storage.dir (the pre-fix target).
    await assert.rejects(
      () => readFile(path.join(nsDir, "state", "recall_impressions.jsonl"), "utf-8"),
      /ENOENT/,
      "drain must not fold under the namespace storage.dir",
    );
    // The namespace-rooted snapshot enumerates storage.dir (nsDir), which never
    // holds the writer-root impressions; inclusion in a writer-root snapshot is
    // covered by the aligned-root test above.
    assert.ok(
      !snapshot.files.some((f) => f.path === "state/recall_impressions.jsonl"),
      "namespace-rooted snapshot does not carry the writer-root active file",
    );
  } finally {
    await rm(writerRoot, { recursive: true, force: true });
    await rm(nsDir, { recursive: true, force: true });
  }
});

test("offlineSyncSnapshot drains a pending memory-lifecycle spill so the append-only row reaches the snapshot (#2033)", async () => {
  // An appendMemoryLifecycleEvents() that timed out on the ledger lock spills the
  // durable row into the offline-sync-EXCLUDED memory-lifecycle-ledger.jsonl.pending.d/.
  // Without a pre-snapshot drain the promotion/import/explicit-capture row is
  // absent from the pushed snapshot and lost if this node is discarded before a
  // later append or maintenance pass folds it. Unlike recall impressions (writer
  // root), the lifecycle ledger is per-namespace, so the drain runs on the
  // RESOLVED-namespace storage and the folded ledger lands in the snapshot.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-offline-lifecycle-drain-"));
  try {
    const storage = new StorageManager(root);
    const ledgerPath = path.join(root, "state", "memory-lifecycle-ledger.jsonl");
    const pendingDir = `${ledgerPath}.pending.d`;
    await mkdir(pendingDir, { recursive: true });
    const event: MemoryLifecycleEvent = {
      eventId: "evt-spilled-1",
      memoryId: "memory-a",
      eventType: "promoted",
      timestamp: "2026-03-08T00:00:00.000Z",
      actor: "system",
      ruleVersion: "v1",
    };
    // Spill file written exactly as a lock-timed-out append leaves it (plaintext
    // here: no secure key is configured on this store).
    const spillPayload = serializeLifecycleAppendPayload([event]);
    await writeFile(path.join(pendingDir, "spill-1.jsonl"), spillPayload, "utf-8");

    const { service } = makeService();
    const orchestrator = (service as unknown as {
      orchestrator: { config: PluginConfig; getStorage(namespace: string): Promise<StorageManager> };
    }).orchestrator;
    orchestrator.getStorage = async () => storage;

    const snapshot = await service.offlineSyncSnapshot({
      namespace: "team",
      principal: "reader",
      includeContent: true,
    });

    const active = snapshot.files.find((f) => f.path === "state/memory-lifecycle-ledger.jsonl");
    assert.ok(active, "drained active lifecycle ledger is present in the snapshot");
    assert.equal(
      Buffer.from(active!.contentBase64!, "base64").toString("utf-8"),
      spillPayload,
      "the spilled lifecycle event was folded into the synced active ledger",
    );
    // The node-local pending spill dir stays excluded from the snapshot...
    assert.ok(
      !snapshot.files.some((f) => f.path.startsWith("state/memory-lifecycle-ledger.jsonl.pending.d")),
      "pending spill dir remains offline-sync excluded",
    );
    // ...because the drain already folded and emptied it.
    assert.deepEqual(await readdir(pendingDir), [], "pending spill drained before the snapshot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offlineSyncSnapshot aborts when pending lifecycle rows cannot be drained (#2033)", async () => {
  // When the ledger lock is held by a peer the drain leaves durable rows in the
  // EXCLUDED pending queue and reports pendingDeferred. A snapshot built then
  // would silently omit those append-only rows, so both the buffered and the
  // streaming snapshot entrypoints MUST abort rather than report success.
  const { service } = makeService();
  const orchestrator = (service as unknown as {
    orchestrator: { getStorage(namespace: string): Promise<StorageManager> };
  }).orchestrator;
  let drainAttempts = 0;
  orchestrator.getStorage = async () =>
    ({
      dir: "/unused",
      async drainPendingMemoryLifecycleEventsForSync() {
        drainAttempts++;
        return { folded: false, pendingDeferred: true };
      },
    }) as unknown as StorageManager;

  await assert.rejects(
    () => service.offlineSyncSnapshot({ namespace: "team", principal: "reader" }),
    /lifecycle drain could not fold pending memory-lifecycle events.*aborting snapshot/s,
    "buffered snapshot aborts on a persistent lifecycle deferral",
  );
  await assert.rejects(
    () => service.offlineSyncSnapshotStream({ namespace: "team", principal: "reader" }),
    /lifecycle drain could not fold pending memory-lifecycle events.*aborting snapshot/s,
    "streaming snapshot aborts on a persistent lifecycle deferral",
  );
  assert.ok(drainAttempts >= 6, "each aborted snapshot retried the drain before giving up");
});
