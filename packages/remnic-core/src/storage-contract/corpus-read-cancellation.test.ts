/**
 * Issue #2307 — the shared full-corpus read primitives honour cancellation.
 *
 * Scenario matrix, applied to every primitive that walks a whole memory tree:
 *   1. no signal                    → unchanged behaviour
 *   2. signal that never fires      → unchanged behaviour
 *   3. signal already aborted       → throws, nothing read
 *   4. signal fires mid-scan        → throws, and NO partial corpus is cached
 *   5. coalesced read with a joiner → the starter's abort must not cancel it
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StorageManager } from "../storage.js";
import { resetStaticCaches } from "./harness.js";

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";

async function withStorage(
  prefix: string,
  body: (sm: StorageManager, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    resetStaticCaches();
    const sm = new StorageManager(dir);
    await sm.ensureDirectories();
    await body(sm, dir);
  } finally {
    resetStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Counts disk scans so "nothing was cached" is observable rather than assumed. */
function installScanSpy(sm: StorageManager): { scans: () => number } {
  const spy = sm as unknown as { _readAllMemoriesFromDisk: (...args: unknown[]) => Promise<unknown> };
  const orig = spy._readAllMemoriesFromDisk.bind(sm);
  let count = 0;
  spy._readAllMemoriesFromDisk = async (...args: unknown[]) => {
    count += 1;
    return orig(...args);
  };
  return { scans: () => count };
}

test("readAllMemories: an unfired signal changes nothing", async () => {
  await withStorage("remnic-2307-memories-inert-", async (sm) => {
    await sm.writeMemory("fact", "inert signal memory");
    const memories = await sm.readAllMemories({ abortSignal: new AbortController().signal });
    assert.ok(memories.some((m) => m.content === "inert signal memory"));
  });
});

test("readAllMemories: an already-aborted caller reads nothing at all", async () => {
  await withStorage("remnic-2307-memories-preabort-", async (sm) => {
    await sm.writeMemory("fact", "pre-abort memory");
    sm.invalidateAllMemoriesCacheForDir();
    const spy = installScanSpy(sm);
    const aborted = new AbortController();
    aborted.abort();

    await assert.rejects(sm.readAllMemories({ abortSignal: aborted.signal }), isAbort);
    assert.equal(spy.scans(), 0, "an abandoned caller must not start a disk scan");
  });
});

test("readAllMemories: a mid-scan abort caches nothing", async () => {
  await withStorage("remnic-2307-memories-midscan-", async (sm) => {
    await sm.writeMemory("fact", "mid-scan memory");
    sm.invalidateAllMemoriesCacheForDir();

    // Abort once the walk has produced paths: the next per-batch checkpoint in the
    // parse phase is a real boundary, not a synthetic one.
    const aborted = new AbortController();
    const inner = sm as unknown as {
      collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
    };
    const origCollect = inner.collectActiveMemoryPaths.bind(sm);
    inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
      const paths = await origCollect(...args);
      aborted.abort();
      return paths;
    };

    await assert.rejects(sm.readAllMemories({ abortSignal: aborted.signal }), isAbort);

    // The publish step is downstream of the checkpoint, so a truncated corpus must
    // never have reached the cache: a fresh read has to scan again.
    inner.collectActiveMemoryPaths = origCollect;
    const spy = installScanSpy(sm);
    const after = await sm.readAllMemories();
    assert.equal(spy.scans(), 1, "the aborted read must not have published a cache entry");
    assert.ok(after.some((m) => m.content === "mid-scan memory"), "the corpus is intact");
  });
});

test("readAllMemories: a second reader protects the coalesced scan from the starter's abort", async () => {
  await withStorage("remnic-2307-memories-joiner-", async (sm) => {
    await sm.writeMemory("fact", "joined memory");
    sm.invalidateAllMemoriesCacheForDir();

    // Hold the scan open so the joiner provably attaches while it is in flight.
    const scanReached = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    const inner = sm as unknown as {
      collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
    };
    const origCollect = inner.collectActiveMemoryPaths.bind(sm);
    let held = false;
    inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
      if (!held) {
        held = true;
        scanReached.resolve();
        await releaseScan.promise;
      }
      return origCollect(...args);
    };

    const spy = installScanSpy(sm);
    const starterAbort = new AbortController();
    const starter = sm.readAllMemories({ abortSignal: starterAbort.signal });
    await scanReached.promise;
    const joiner = sm.readAllMemories();

    starterAbort.abort();
    releaseScan.resolve();

    const joined = await joiner;
    assert.ok(
      joined.some((m) => m.content === "joined memory"),
      "a joiner must never be handed a cancelled or truncated read",
    );
    // The starter shares that same settled scan, so it succeeds too.
    assert.deepEqual(
      (await starter).map((m) => m.content),
      joined.map((m) => m.content),
    );
    assert.equal(spy.scans(), 1, "the joiner reused the in-flight scan rather than starting its own");
  });
});

test("readAllMemories: a joiner arriving after the starter aborted starts a fresh scan", async () => {
  await withStorage("remnic-2307-memories-late-joiner-", async (sm) => {
    await sm.writeMemory("fact", "late joiner memory");
    sm.invalidateAllMemoriesCacheForDir();

    // The starter's scan is doomed the instant its signal fires. Withdrawing it
    // from the registry first is what stops a late joiner inheriting that
    // AbortError for a request it never cancelled (issue #2307 review).
    const scanReached = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    const inner = sm as unknown as {
      collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
    };
    const origCollect = inner.collectActiveMemoryPaths.bind(sm);
    let held = false;
    inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
      if (!held) {
        held = true;
        scanReached.resolve();
        await releaseScan.promise;
      }
      return origCollect(...args);
    };

    const starterAbort = new AbortController();
    const starter = sm.readAllMemories({ abortSignal: starterAbort.signal });
    await scanReached.promise;
    starterAbort.abort();

    // Joins only AFTER the abort — must not attach to the doomed scan.
    const lateJoiner = sm.readAllMemories();
    releaseScan.resolve();

    await assert.rejects(starter, isAbort);
    const joined = await lateJoiner;
    assert.ok(
      joined.some((m) => m.content === "late joiner memory"),
      "a late joiner must get its own scan, not the starter's AbortError",
    );
  });
});

test("readAllMemories: a joiner honours its own signal without cancelling the shared scan", async () => {
  await withStorage("remnic-2307-memories-joiner-abort-", async (sm) => {
    await sm.writeMemory("fact", "shared scan memory");
    sm.invalidateAllMemoriesCacheForDir();

    const scanReached = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    const inner = sm as unknown as {
      collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
    };
    const origCollect = inner.collectActiveMemoryPaths.bind(sm);
    let held = false;
    inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
      if (!held) {
        held = true;
        scanReached.resolve();
        await releaseScan.promise;
      }
      return origCollect(...args);
    };

    const starter = sm.readAllMemories();
    await scanReached.promise;
    const joinerAbort = new AbortController();
    const joiner = sm.readAllMemories({ abortSignal: joinerAbort.signal });
    joinerAbort.abort();

    // The joiner stops waiting immediately, before the scan is even released.
    await assert.rejects(joiner, isAbort);

    releaseScan.resolve();
    const starterResult = await starter;
    assert.ok(
      starterResult.some((m) => m.content === "shared scan memory"),
      "a joiner's cancellation must never reach the shared scan",
    );
  });
});

test("readAllMemories: a sole waiter's abort does stop the scan", async () => {
  await withStorage("remnic-2307-memories-sole-", async (sm) => {
    await sm.writeMemory("fact", "sole waiter memory");
    sm.invalidateAllMemoriesCacheForDir();

    const scanReached = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    const inner = sm as unknown as {
      collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
    };
    const origCollect = inner.collectActiveMemoryPaths.bind(sm);
    inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
      scanReached.resolve();
      await releaseScan.promise;
      return origCollect(...args);
    };

    const aborted = new AbortController();
    const pending = sm.readAllMemories({ abortSignal: aborted.signal });
    await scanReached.promise;
    aborted.abort();
    releaseScan.resolve();

    await assert.rejects(pending, isAbort);
  });
});

test("readAllEntityFiles: an already-aborted caller reads nothing and caches nothing", async () => {
  await withStorage("remnic-2307-entities-", async (sm) => {
    await sm.writeEntity("Cancelled Person", "person", ["Cancelled Person owns this test."]);

    let entityFileReads = 0;
    const inner = sm as unknown as {
      readStorageSecureFile: (filePath: string) => Promise<string>;
    };
    const origRead = inner.readStorageSecureFile.bind(sm);
    inner.readStorageSecureFile = async (filePath: string) => {
      entityFileReads += 1;
      return origRead(filePath);
    };

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(sm.readAllEntityFiles({ abortSignal: aborted.signal }), isAbort);
    assert.equal(entityFileReads, 0, "an abandoned caller must not read entity files");

    // Nothing was published, so the corpus still reads correctly afterwards.
    const entities = await sm.readAllEntityFiles();
    assert.ok(entities.some((e) => e.name === "Cancelled Person"));
  });
});

test("readAllEntityFiles: a mid-scan abort publishes no partial entity cache", async () => {
  await withStorage("remnic-2307-entities-midscan-", async (sm) => {
    await sm.writeEntity("First Person", "person", ["First Person owns this test."]);
    await sm.writeEntity("Second Person", "person", ["Second Person owns this test too."]);

    // Abort once the first entity file has been read: the post-loop checkpoint is
    // what stops that partial batch reaching setCachedEntities.
    const aborted = new AbortController();
    const inner = sm as unknown as {
      readStorageSecureFile: (filePath: string) => Promise<string>;
    };
    const origRead = inner.readStorageSecureFile.bind(sm);
    let reads = 0;
    inner.readStorageSecureFile = async (filePath: string) => {
      reads += 1;
      aborted.abort();
      return origRead(filePath);
    };

    await assert.rejects(sm.readAllEntityFiles({ abortSignal: aborted.signal }), isAbort);
    assert.ok(reads >= 1, "the scan started before it was cancelled");

    inner.readStorageSecureFile = origRead;
    const entities = await sm.readAllEntityFiles();
    assert.deepEqual(
      entities.map((e) => e.name).sort(),
      ["First Person", "Second Person"],
      "the aborted scan must not have cached a partial entity set",
    );
  });
});

test("searchArtifacts: an already-aborted caller never reads the artifact tier", async () => {
  await withStorage("remnic-2307-artifacts-preabort-", async (sm) => {
    await sm.writeArtifact("deploy runbook rollback quote", { sourceMemoryId: "src-1" });

    let artifactReads = 0;
    const inner = sm as unknown as {
      readMemoryByPath: (filePath: string) => Promise<unknown>;
    };
    const origRead = inner.readMemoryByPath.bind(sm);
    inner.readMemoryByPath = async (filePath: string) => {
      artifactReads += 1;
      return origRead(filePath);
    };

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      sm.searchArtifacts("deploy runbook", 5, { abortSignal: aborted.signal }),
      isAbort,
    );
    assert.equal(artifactReads, 0, "an abandoned caller must not walk the artifact tier");
  });
});

test("searchArtifacts: a mid-walk abort caches nothing", async () => {
  await withStorage("remnic-2307-artifacts-midwalk-", async (sm) => {
    await sm.writeArtifact("deploy runbook rollback quote", { sourceMemoryId: "src-1" });
    await sm.writeArtifact("second deploy runbook quote", { sourceMemoryId: "src-2" });

    // Abort from inside the walk, at the per-entry checkpoint.
    const aborted = new AbortController();
    const inner = sm as unknown as {
      readMemoryByPath: (filePath: string) => Promise<unknown>;
    };
    const origRead = inner.readMemoryByPath.bind(sm);
    let reads = 0;
    inner.readMemoryByPath = async (filePath: string) => {
      reads += 1;
      aborted.abort();
      return origRead(filePath);
    };

    await assert.rejects(
      sm.searchArtifacts("deploy runbook", 5, { abortSignal: aborted.signal }),
      isAbort,
    );
    assert.ok(reads >= 1, "the walk started before it was cancelled");

    // A partial walk must not have been published as the artifact index: the next
    // search sees every artifact.
    inner.readMemoryByPath = origRead;
    const matches = await sm.searchArtifacts("deploy runbook", 5);
    assert.equal(matches.length, 2, "the aborted walk must not have cached a partial tier");
  });
});
