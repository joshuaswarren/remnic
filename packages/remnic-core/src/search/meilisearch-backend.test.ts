import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MeilisearchBackend } from "./meilisearch-backend.js";

// Issue #3286: update() is fail-open on every backend, so the entity-migration
// pending marker asks updateCompleted() whether the re-index actually ran.
test("Meilisearch updateCompleted is false whenever the refresh returned early", async () => {
  const base = { host: "http://127.0.0.1:1", collection: "openclaw-engram", memoryDir: "/nonexistent" };
  assert.equal(await new MeilisearchBackend({ ...base, autoIndex: false }).updateCompleted(), false, "autoIndex off: nothing is pushed");
  assert.equal(await new MeilisearchBackend({ ...base, autoIndex: true }).updateCompleted(), false, "never probed: unavailable");
  assert.equal(await new MeilisearchBackend({ host: base.host, collection: base.collection, autoIndex: true }).updateCompleted(), false, "no memory dir");
});

/** A Meilisearch client double: waitForTask resolves with the task status, as the real 0.46 SDK does. */
function stubClient(status: string) {
  return {
    async health() {},
    async getIndex() {},
    index: () => ({
      async addDocuments() {
        return { taskUid: 1 };
      },
      async getDocuments() {
        return { results: [] };
      },
      async deleteDocuments() {
        return { taskUid: 2 };
      },
    }),
    // Resolves for failed and canceled tasks too; only a timeout rejects.
    async waitForTask() {
      return { status };
    },
  };
}

function reachableBackend(memoryDir: string, status: string): MeilisearchBackend {
  const backend = new MeilisearchBackend({ host: "http://127.0.0.1:1", collection: "openclaw-engram", autoIndex: true, memoryDir });
  Object.defineProperty(backend, "available", { value: true });
  Object.defineProperty(backend, "client", { value: stubClient(status) });
  return backend;
}

test("Meilisearch updateCompleted is true only when the add task succeeded (issue #3286)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-meili-completed-"));
  try {
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, "facts", "fact.md"), "---\nid: mem-meili\n---\nA fact to index.");
    assert.equal(await reachableBackend(root, "succeeded").updateCompleted(), true);
    for (const status of ["failed", "canceled", "enqueued", "processing"]) {
      assert.equal(await reachableBackend(root, status).updateCompleted(), false, `a ${status} task did not index anything`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Meilisearch updateCompleted is false for a reachable backend with no memory dir to index (issue #3286)", async () => {
  const backend = new MeilisearchBackend({ host: "http://127.0.0.1:1", collection: "openclaw-engram", autoIndex: true });
  Object.defineProperty(backend, "available", { value: true });
  Object.defineProperty(backend, "client", { value: stubClient("succeeded") });
  assert.equal(await backend.updateCompleted(), false);
});
