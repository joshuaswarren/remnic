import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
import { namespaceCollectionName } from "./namespaces/search.js";
import type { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

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
