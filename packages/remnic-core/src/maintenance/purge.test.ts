import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeMemories } from "./purge.js";
import type { MemoryFile } from "../types.js";

test("purgeMemories fails closed when pre-delete audit cannot be written", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-purge-"));
  try {
    const memoryPath = path.join(dir, "cold-memory.md");
    await writeFile(memoryPath, "content", "utf8");
    await mkdir(path.join(dir, "state"), { recursive: true });
    await writeFile(path.join(dir, "state", "observation-ledger"), "not a directory", "utf8");

    const memory: MemoryFile = {
      path: memoryPath,
      content: "old cold memory",
      frontmatter: {
        id: "cold-1",
        category: "fact",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        source: "test",
        confidence: 0.8,
        confidenceTier: "explicit",
        tags: [],
      },
    };

    const storage = {
      dir,
      readAllMemories: async () => [],
      readAllColdMemories: async () => [memory],
      readArchivedMemories: async () => [],
    };

    const result = await purgeMemories({
      storage: storage as never,
      olderThanMs: 1,
      dryRun: false,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    assert.equal(result.purgedCount, 0);
    assert.equal(result.errorCount, 1);
    assert.equal(result.errors[0]?.id, "(purge-audit)");
    assert.equal(await fileExists(memoryPath), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
