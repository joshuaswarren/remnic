import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
import { OFFLINE_SYNC_CHANGESET_FORMAT, OFFLINE_SYNC_MAX_MTIME_MS } from "./offline-sync.js";
import { isEncryptedFile } from "./secure-store/index.js";
import { ContentHashIndex } from "./storage/content-hash-index.js";
import { StorageManager } from "./storage.js";

function createOfflineService(): EngramAccessService {
  return new EngramAccessService({
    config: {
      memoryDir: "/tmp/remnic-access-service-offline-file-content-test",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
    },
    getStorage: async () => ({
      dir: "/tmp/remnic-access-service-offline-file-content-test",
    }),
  } as any);
}

function memoryFile(options: {
  id: string;
  body: string;
  status?: string;
  contentHash?: string;
}): string {
  return [
    "---",
    `id: ${options.id}`,
    "category: fact",
    ...(options.status ? [`status: ${options.status}`] : []),
    ...(options.contentHash ? [`contentHash: ${options.contentHash}`] : []),
    "---",
    options.body,
  ].join("\n");
}

function createManifestService(options: {
  root: string;
  storage: StorageManager;
  namespacesEnabled?: boolean;
}): { service: EngramAccessService; getStorageCalls: string[] } {
  const getStorageCalls: string[] = [];
  const service = new EngramAccessService({
    config: {
      memoryDir: options.root,
      namespacesEnabled: options.namespacesEnabled === true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      namespacePolicies: options.namespacesEnabled
        ? [{ name: "team", readPrincipals: ["reader"], writePrincipals: [] }]
        : [],
      offlineSyncExcludes: [],
    },
    namespaceCatalog: {
      async listNamespaces() {
        return [];
      },
    },
    async drainPendingRecallImpressions() {
      return { folded: false, pendingDeferred: false };
    },
    async getStorage(namespace: string) {
      getStorageCalls.push(namespace);
      return options.storage;
    },
  } as unknown as ConstructorParameters<typeof EngramAccessService>[0]);
  return { service, getStorageCalls };
}

test("offline manifest streams body-free active, archived, old, bad, and encrypted memory rows lazily", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-access-manifest-"));
  try {
    const activeBody = "active body must never leave the service";
    const archivedBody = "archived body must never leave the service";
    const oldBody = "legacy body must never leave the service";
    const encryptedBody = "encrypted body must never leave the service";
    const activeContentHash = ContentHashIndex.computeHash(activeBody);
    const files = new Map<string, string>([
      [
        "facts/active.md",
        memoryFile({
          id: "active-memory",
          body: activeBody,
          status: "active",
          contentHash: activeContentHash,
        }),
      ],
      [
        "archive/facts/archived.md",
        memoryFile({ id: "archived-memory", body: archivedBody, status: "active" }),
      ],
      ["facts/old.md", memoryFile({ id: "old-memory", body: oldBody })],
      ["facts/bad.md", `not valid memory frontmatter\n${activeBody}`],
    ]);
    for (const [relativePath, content] of files) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    const storage = new StorageManager(root);
    await storage.ensureDirectories();
    storage.setSecureStoreKey(Buffer.alloc(32, 11));
    storage.setSecureStoreRequired(true);
    const encryptedRelativePath = "facts/encrypted.md";
    await storage.writeOfflineSyncFile(
      path.join(root, encryptedRelativePath),
      Buffer.from(memoryFile({ id: "encrypted-memory", body: encryptedBody, status: "active" })),
    );
    assert.equal(isEncryptedFile(await readFile(path.join(root, encryptedRelativePath))), true);

    let digestReads = 0;
    let bodyReads = 0;
    const digestOfflineSyncFile = storage.digestOfflineSyncFile.bind(storage);
    const readOfflineSyncFile = storage.readOfflineSyncFile.bind(storage);
    storage.digestOfflineSyncFile = async (filePath: string) => {
      digestReads += 1;
      return digestOfflineSyncFile(filePath);
    };
    storage.readOfflineSyncFile = async (filePath: string) => {
      bodyReads += 1;
      return readOfflineSyncFile(filePath);
    };
    const { service } = createManifestService({ root, storage });

    const manifest = await service.offlineSyncManifestStream();
    assert.equal(manifest.format, "remnic-reconcile-manifest");
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(Array.isArray(manifest.files), false);
    assert.equal(digestReads, 0);
    assert.equal(bodyReads, 0);

    const iterator = manifest.files[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.path, "archive/facts/archived.md");
    assert.equal(digestReads, 1);
    assert.equal(bodyReads, 1);

    const rows = first.value ? [first.value] : [];
    for await (const row of { [Symbol.asyncIterator]: () => iterator }) rows.push(row);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    assert.deepEqual(rowsByPath.get("facts/active.md")?.memory, {
      id: "active-memory",
      category: "fact",
      contentHash: activeContentHash,
      status: "active",
    });
    assert.notEqual(rowsByPath.get("facts/active.md")?.sha256, activeContentHash);
    assert.equal(rowsByPath.get("archive/facts/archived.md")?.memory?.status, "archived");
    assert.equal(
      rowsByPath.get("facts/old.md")?.memory?.contentHash,
      ContentHashIndex.computeHash(oldBody),
    );
    assert.equal(rowsByPath.get("facts/old.md")?.memory?.status, "active");
    assert.equal(rowsByPath.get("facts/bad.md")?.memory, undefined);
    assert.equal(rowsByPath.get(encryptedRelativePath)?.memory?.id, "encrypted-memory");
    for (const row of rows) {
      assert.equal("content" in row, false);
      assert.equal("contentBase64" in row, false);
      assert.doesNotMatch(JSON.stringify(row), /body must never leave the service/);
      assert.equal(typeof row.sha256, "string");
      assert.equal(typeof row.bytes, "number");
      assert.equal(typeof row.mtimeMs, "number");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline manifest uses snapshot namespace authorization and storage routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-access-manifest-namespace-"));
  try {
    const storage = new StorageManager(path.join(root, "namespaces", "team"));
    await storage.ensureDirectories();
    const { service, getStorageCalls } = createManifestService({
      root,
      storage,
      namespacesEnabled: true,
    });
    await assert.rejects(
      () => service.offlineSyncManifestStream({ namespace: "team", principal: "outsider" }),
      /namespace is not readable: team/,
    );
    const manifest = await service.offlineSyncManifestStream({
      namespace: "team",
      principal: "reader",
      includeTranscripts: false,
    });
    assert.equal(manifest.namespace, "team");
    assert.deepEqual(getStorageCalls, ["team"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline file-transfer endpoints reject internal Remnic state paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-access-internal-state-"));
  try {
    const storage = new StorageManager(root);
    await storage.ensureDirectories();
    const { service } = createManifestService({ root, storage });
    const internalPath = ".remnic/state/converge-cursors/peer.json";
    const internalFilePath = path.join(root, internalPath);
    await mkdir(path.dirname(internalFilePath), { recursive: true });
    await writeFile(internalFilePath, "cursor");

    await assert.rejects(
      () => service.offlineSyncFiles({ paths: [internalPath] }),
      (error) =>
        error instanceof EngramAccessInputError
        && /offline sync snapshot path is excluded/.test(error.message),
    );
    await assert.rejects(
      () => service.offlineSyncFileContent({ path: internalPath, offset: 0, length: 1 }),
      (error) =>
        error instanceof EngramAccessInputError
        && /offline sync file content path is excluded/.test(error.message),
    );
    await assert.rejects(
      () => service.offlineSyncApplyFileContent({
        sourceId: "peer",
        path: internalPath,
        sha256: "a".repeat(64),
        bytes: 0,
        mtimeMs: 0,
        offset: 0,
        content: Buffer.alloc(0),
      }),
      (error) =>
        error instanceof EngramAccessInputError
        && /offline sync file content path is excluded/.test(error.message),
    );
    const applyResult = await service.offlineSyncApply({
      changeset: {
        format: OFFLINE_SYNC_CHANGESET_FORMAT,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        sourceId: "peer",
        includeTranscripts: true,
        changes: [{
          type: "delete",
          path: internalPath,
          baseSha256: "b".repeat(64),
        }],
      },
    });
    assert.equal(applyResult.appliedDeletes, 0);
    assert.equal(await readFile(internalFilePath, "utf8"), "cursor");

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline apply-file-content reports invalid metadata as input errors", async () => {
  const service = createOfflineService();
  await assert.rejects(
    () => service.offlineSyncApplyFileContent({
      includeTranscripts: true,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: "not-a-sha",
      bytes: 0,
      mtimeMs: 0,
      offset: 0,
      content: Buffer.alloc(0),
    }),
    (error) =>
      error instanceof EngramAccessInputError &&
      /sha256 must be a 64-character sha256/.test(error.message),
  );

  await assert.rejects(
    () => service.offlineSyncApplyFileContent({
      includeTranscripts: true,
      sourceId: "laptop",
      path: "state/lcm.sqlite",
      sha256: "a".repeat(64),
      bytes: 0,
      mtimeMs: OFFLINE_SYNC_MAX_MTIME_MS + 1,
      offset: 0,
      content: Buffer.alloc(0),
    }),
    (error) =>
      error instanceof EngramAccessInputError &&
      /mtimeMs must be within JavaScript Date range/.test(error.message),
  );
});

test("offline convergence completion refreshes authorized namespaces as one batch and rejects other sources", async () => {
  const refreshed: string[][] = [];
  const orchestratorStub = {
    config: {
      memoryDir: "/tmp/remnic-access-service-convergence-test",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
    },
    refreshNamespacesAfterConvergence: async (namespaces: readonly string[]) => {
      refreshed.push([...namespaces]);
    },
  };
  const service = new EngramAccessService(
    orchestratorStub as unknown as ConstructorParameters<typeof EngramAccessService>[0],
  );
  const convergenceService = service as unknown as {
    offlineSyncFinalizeConvergence(options: {
      namespaces?: string[];
      principal?: string;
      sourceId: string;
    }): Promise<{ namespaces: string[]; refreshed: true }>;
  };

  await assert.rejects(
    () => convergenceService.offlineSyncFinalizeConvergence({ sourceId: "laptop" }),
    (error) =>
      error instanceof EngramAccessInputError
      && /sourceId must be remnic-converge/.test(error.message),
  );
  assert.deepEqual(refreshed, []);

  const result = await convergenceService.offlineSyncFinalizeConvergence({
    sourceId: "remnic-converge",
  });

  assert.deepEqual(result, { namespaces: ["global"], refreshed: true });
  assert.deepEqual(refreshed, [["global"]]);
});
