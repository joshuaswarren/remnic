import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { upsertAbstractionNode } from "./abstraction-nodes.js";
import { pruneOrphanCueAnchors, upsertCueAnchor, validateCueAnchor } from "./cue-anchors.js";

const RECORDED_AT = "2026-08-08T20:00:00.000Z";

function anchor(sourceMemoryIds: string[]) {
  return {
    schemaVersion: 1 as const,
    anchorId: "cue-provenance",
    anchorType: "tool" as const,
    anchorValue: "storage tool",
    normalizedCue: "storage tool",
    recordedAt: RECORDED_AT,
    sessionKey: "session:test",
    nodeRefs: ["node-storage"],
    sourceMemoryIdsByNodeRef: { "node-storage": sourceMemoryIds },
  };
}

test("repeated same-node upserts retain only live node source IDs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cue-anchor-provenance-upsert-"));
  try {
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "node-storage",
        recordedAt: RECORDED_AT,
        sessionKey: "session:test",
        kind: "episode",
        abstractionLevel: "micro",
        title: "Storage episode",
        summary: "The storage episode remains live.",
        sourceMemoryIds: ["mem-0", "mem-1"],
      },
    });

    let filePath = "";
    for (let index = 0; index < 100; index++) {
      filePath = await upsertCueAnchor({
        memoryDir,
        anchor: anchor([`mem-${index}`, "mem-1", `stale-${index}`]),
      });
    }

    const persisted = validateCueAnchor(JSON.parse(await readFile(filePath, "utf8")));
    assert.deepEqual(persisted.sourceMemoryIdsByNodeRef, {
      "node-storage": ["mem-0", "mem-1"],
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pruneOrphanCueAnchors trims stale provenance from a live node", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cue-anchor-provenance-prune-"));
  try {
    const anchorPath = await upsertCueAnchor({
      memoryDir,
      anchor: anchor(["mem-keep", "mem-stale"]),
    });
    await upsertAbstractionNode({
      memoryDir,
      node: {
        schemaVersion: 1,
        nodeId: "node-storage",
        recordedAt: RECORDED_AT,
        sessionKey: "session:test",
        kind: "episode",
        abstractionLevel: "micro",
        title: "Storage episode",
        summary: "The storage episode remains live.",
        sourceMemoryIds: ["mem-keep"],
      },
    });

    assert.equal(await pruneOrphanCueAnchors({ memoryDir }), 0);
    const persisted = validateCueAnchor(JSON.parse(await readFile(anchorPath, "utf8")));
    assert.deepEqual(persisted.sourceMemoryIdsByNodeRef, {
      "node-storage": ["mem-keep"],
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
