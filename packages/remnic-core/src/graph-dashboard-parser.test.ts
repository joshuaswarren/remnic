import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { graphSnapshotFromMemoryDir } from "./graph-dashboard-parser.js";

test("graphSnapshotFromMemoryDir reports only absent graph files as missing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-parser-missing-"));
  try {
    const snapshot = await graphSnapshotFromMemoryDir(memoryDir);
    assert.deepEqual(snapshot.stats.filesMissing, ["entity", "time", "causal"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("graphSnapshotFromMemoryDir throws for unreadable graph file paths", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-parser-unreadable-"));
  try {
    await mkdir(path.join(memoryDir, "state", "graphs", "entity.jsonl"), { recursive: true });

    await assert.rejects(
      () => graphSnapshotFromMemoryDir(memoryDir),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EISDIR",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
