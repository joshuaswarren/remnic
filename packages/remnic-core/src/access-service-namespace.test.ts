import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
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
      getStorage(namespace: string): Promise<StorageManager>;
    };
  }).orchestrator = {
    config: makeConfig(),
    async getStorage(namespace: string): Promise<StorageManager> {
      getStorageCalls.push(namespace);
      return storage;
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
