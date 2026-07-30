import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
import { OFFLINE_SYNC_MAX_MTIME_MS } from "./offline-sync.js";

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
