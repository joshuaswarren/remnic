import assert from "node:assert/strict";
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
