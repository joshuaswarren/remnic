import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import {
  listPairs,
  migrateUnscopedPairsToNamespace,
  readPair,
} from "../packages/remnic-core/src/contradiction/contradiction-review.js";

test("contradiction review queue ignores symlinked JSON files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-review-"));
  const externalDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-review-external-"));
  try {
    const reviewDir = path.join(memoryDir, ".review", "contradictions");
    await mkdir(reviewDir, { recursive: true });
    const externalPairPath = path.join(externalDir, "leak.json");
    await writeFile(
      externalPairPath,
      JSON.stringify({
        memoryIds: ["a", "b"],
        pairId: "leak",
        verdict: "contradicts",
        rationale: "external",
        confidence: 1,
        detectedAt: "2026-05-21T10:00:00.000Z",
      }),
      "utf8",
    );
    await symlink(externalPairPath, path.join(reviewDir, "leak.json"));

    assert.equal(readPair(memoryDir, "leak"), null);
    assert.deepEqual(listPairs(memoryDir).pairs, []);
    assert.equal(migrateUnscopedPairsToNamespace(memoryDir, "tenant-a"), 0);
    assert.deepEqual(listPairs(memoryDir, { namespace: "tenant-a" }).pairs, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});
