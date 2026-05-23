import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";

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
});
