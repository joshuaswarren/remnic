import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LifecyclePolicyCoordinator,
  type LifecyclePolicyCoordinatorDeps,
} from "./lifecycle-policy-coordinator.js";
import { indexMemoryAsync } from "../temporal-index.js";
import type { StorageManager } from "../index.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { ExtractionEngine } from "../extraction.js";
import type { MemoryFile, PluginConfig } from "../types.js";

// Regression for the #1911B Cursor finding: the maintenance de-index loops
// collect removals for a single batch flush. If a LATER iteration throws before
// the flush, memories already archived/invalidated on disk must still be
// de-indexed — the flush now lives in a `finally`. runFactArchival is the
// smallest self-contained loop with this shape; the same finally guard is
// applied to the consolidation-run INVALIDATE/MERGE and semantic-consolidation
// archive loops.

function makeFact(id: string, path: string, created: string): MemoryFile {
  const memory = {
    path,
    content: `fact ${id}`,
    frontmatter: {
      id,
      category: "fact",
      created,
      tags: ["project/remnic", "shared", `flat-${id}`],
    },
  };
  // Test fixture: MemoryFile carries many optional fields the archival loop
  // never reads; a full literal would be noise. Narrow, deliberate cast.
  return memory as unknown as MemoryFile;
}

async function temporalDates(memoryDir: string): Promise<Record<string, string[]>> {
  const raw: unknown = JSON.parse(
    await readFile(join(memoryDir, "state", "index_time.json"), "utf8"),
  );
  if (raw && typeof raw === "object" && "dates" in raw) {
    return raw.dates as Record<string, string[]>;
  }
  throw new Error("temporal index missing dates map");
}

test("#1911B fact-archival flushes prior de-index entries when a later iteration throws", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-batch-deindex-flush-"));
  try {
    const memA = makeFact("mem-a", "/tmp/mem-a.md", "2020-01-01T09:00:00.000Z");
    const memB = makeFact("mem-b", "/tmp/mem-b.md", "2020-02-02T09:00:00.000Z");

    // Seed the on-disk temporal index so a successful de-index is observable as
    // the removal of the memory's date bucket.
    await indexMemoryAsync(memoryDir, memA.path, memA.frontmatter.created, memA.frontmatter.tags ?? []);
    await indexMemoryAsync(memoryDir, memB.path, memB.frontmatter.created, memB.frontmatter.tags ?? []);

    const beforeDates = await temporalDates(memoryDir);
    assert.deepEqual(beforeDates["2020-01-01"], [memA.path]);
    assert.deepEqual(beforeDates["2020-02-02"], [memB.path]);

    const archived: string[] = [];
    const fakeStorage = {
      // Both memories archive successfully on disk.
      async archiveMemory(memory: MemoryFile): Promise<string> {
        archived.push(memory.frontmatter.id);
        return memory.frontmatter.id;
      },
    };
    // runFactArchival only calls archiveMemory on the storage; the rest of the
    // StorageManager surface is unused here.
    const storage = fakeStorage as unknown as StorageManager;

    const embeddingFallback = {
      async removeFromIndex(): Promise<void> {},
    } as unknown as EmbeddingFallback;

    // Minimal config: the archival loop reads only these fields plus the
    // queryAwareIndexing capability flag. A full PluginConfig literal is noise.
    const config = {
      memoryDir,
      queryAwareIndexingEnabled: true,
      factArchivalAgeDays: 0,
      factArchivalProtectedCategories: [],
      factArchivalMaxImportance: 1,
      factArchivalMaxAccessCount: 1000,
    } as unknown as PluginConfig;

    const boom = new Error("content-hash removal exploded on a later iteration");
    const deps: LifecyclePolicyCoordinatorDeps = {
      config,
      getStorage: () => storage,
      extraction: {} as unknown as ExtractionEngine,
      embeddingFallback,
      getEffectiveLifecycleThresholds: () => ({
        promoteHeatThreshold: 0,
        staleDecayThreshold: 0,
        archiveDecayThreshold: 0,
      }),
      // Throws for mem-b — the later iteration — after mem-b is already archived
      // AND queued for de-index, but before its content-hash cleanup completes.
      // Asserts the production call passes the target storage instance and the
      // fact-archival context.
      async removeContentHashForMemory(targetStorage, memory, context): Promise<void> {
        assert.equal(
          targetStorage,
          storage,
          "removeContentHashForMemory must receive the target storage instance",
        );
        assert.equal(
          context,
          "fact-archival",
          "removeContentHashForMemory must receive the fact-archival context",
        );
        if (memory.frontmatter.id === "mem-b") throw boom;
      },
      async saveContentHashIndexes(): Promise<void> {},
    };

    const coordinator = new LifecyclePolicyCoordinator(deps);

    await assert.rejects(
      () => coordinator.runFactArchival([memA, memB]),
      /content-hash removal exploded/,
    );

    // Both were archived on disk before the failure.
    assert.deepEqual(archived, ["mem-a", "mem-b"]);

    // Both facts were archived on disk AND queued for de-index — the queue push
    // now precedes the throwing content-hash cleanup — so the finally-path flush
    // must remove BOTH date buckets even though a later iteration threw. This
    // fails on either ordering regression: move the flush out of `finally` and
    // nothing is de-indexed (mem-a fails); move the queue push back after the
    // throwing cleanup and mem-b is never queued (mem-b fails).
    const afterDates = await temporalDates(memoryDir);
    assert.equal(afterDates["2020-01-01"], undefined, "mem-a must be de-indexed via the finally flush");
    assert.equal(afterDates["2020-02-02"], undefined, "mem-b must be de-indexed even though later cleanup threw");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
