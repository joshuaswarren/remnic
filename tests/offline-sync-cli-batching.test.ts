import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkOfflineFileContentBatches,
  formatOfflineLargeFilePushFailureMessage,
} from "../packages/remnic-cli/src/index.js";
import type { OfflineSyncFileState } from "@remnic/core";

function file(path: string, bytes: number): OfflineSyncFileState {
  return {
    path,
    bytes,
    sha256: "0".repeat(64),
    mtimeMs: 0,
  };
}

test("offline sync file content batches are bounded by expected bytes", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/a.md", 5 * 1024 * 1024),
    file("facts/b.md", 4 * 1024 * 1024),
    file("facts/c.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/a.md"], ["facts/b.md", "facts/c.md"]],
  );
});

test("offline sync file content batches keep oversized single files fetchable", () => {
  const batches = chunkOfflineFileContentBatches([
    file("facts/large.md", 12 * 1024 * 1024),
    file("facts/small.md", 1024),
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((entry) => entry.path)),
    [["facts/large.md"], ["facts/small.md"]],
  );
});

test("offline sync large-file push failures are explicit", () => {
  assert.equal(
    formatOfflineLargeFilePushFailureMessage([
      { path: "state/lcm.sqlite", error: "offline sync request failed: 500" },
    ]),
    "offline sync large-file push failed for 1 file: state/lcm.sqlite: offline sync request failed: 500",
  );
});
