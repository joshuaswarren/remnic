import test from "node:test";
import assert from "node:assert/strict";
import { ExportManifestV1Schema } from "../src/transfer/types.js";

test("ExportManifestV1Schema validates required fields", () => {
  const m = ExportManifestV1Schema.parse({
    format: "openclaw-engram-export",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    pluginVersion: "2.2.3",
    includesTranscripts: false,
    files: [{ path: "profile.md", sha256: "a".repeat(64), bytes: 12 }],
  });
  assert.equal(m.schemaVersion, 1);
});

