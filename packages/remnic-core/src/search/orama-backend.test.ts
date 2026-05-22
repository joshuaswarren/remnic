import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveOramaCollectionDbFilePath } from "./orama-backend.js";

test("Orama collection filenames cannot escape dbPath", () => {
  const dbPath = path.join("/tmp", "remnic-orama-db");

  assert.equal(
    resolveOramaCollectionDbFilePath(dbPath, "openclaw-engram"),
    path.join(dbPath, "openclaw-engram.msp"),
  );
  for (const collection of [
    "../outside",
    "nested/name",
    "",
    ".hidden",
    "collection name",
  ]) {
    assert.throws(
      () => resolveOramaCollectionDbFilePath(dbPath, collection),
      /Invalid Orama collection/,
      collection,
    );
  }
});
