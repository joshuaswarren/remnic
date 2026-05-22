import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "../storage.js";
import { runMemoryGovernance } from "./memory-governance.js";

test("governance restore manifest marks actions applied only after mutation succeeds", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-governance-restore-"));
  try {
    const storage = new StorageManager(memoryDir);
    const memoryId = await storage.writeMemory("fact", "This memory is disputed.", {
      source: "test",
      confidence: 0.9,
    });
    await storage.updateMemoryFrontmatter(memoryId, {
      verificationState: "disputed",
    });

    const now = new Date("2026-05-21T10:11:12.000Z");
    const runId = `gov-${now.toISOString().replace(/[:.]/g, "-")}`;
    const restorePath = path.join(memoryDir, "state", "memory-governance", "runs", runId, "restore.json");
    const mock = t.mock.method(
      StorageManager.prototype,
      "writeMemoryFrontmatter",
      async () => {
        throw new Error("simulated frontmatter write failure");
      },
    );

    await assert.rejects(
      () =>
        runMemoryGovernance({
          memoryDir,
          mode: "apply",
          now,
        }),
      /simulated frontmatter write failure/,
    );
    mock.mock.restore();

    const restore = JSON.parse(await readFile(restorePath, "utf8")) as {
      entries: Array<{ memoryId: string; applied: boolean }>;
    };
    assert.equal(restore.entries.length, 1);
    assert.equal(restore.entries[0]?.memoryId, memoryId);
    assert.equal(restore.entries[0]?.applied, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
