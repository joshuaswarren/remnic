
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

function holdFirstScan(sm: StorageManager): {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const scanReached = Promise.withResolvers<void>();
  const releaseScan = Promise.withResolvers<void>();
  const inner = sm as unknown as {
    collectActiveMemoryPaths: (...args: unknown[]) => Promise<string[]>;
  };
  const orig = inner.collectActiveMemoryPaths.bind(sm);
  let held = false;
  inner.collectActiveMemoryPaths = async (...args: unknown[]) => {
    if (!held) {
      held = true;
      scanReached.resolve();
      await releaseScan.promise;
    }
    return orig(...args);
  };
  return {
    reached: scanReached.promise,
    release: () => releaseScan.resolve(),
    restore: () => {
      releaseScan.resolve();
      inner.collectActiveMemoryPaths = orig;
    },
  };
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

    const hold = holdFirstScan(sm);
    const spy = installScanSpy(sm);
    const starterAbort = new AbortController();
    const starter = sm.readAllMemories({ abortSignal: starterAbort.signal });
    const starterOutcome = starter.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await hold.reached;
      const joiner = sm.readAllMemories();

      starterAbort.abort();
      hold.release();

      const joined = await joiner;
      assert.ok(
        joined.some((m) => m.content === "joined memory"),
        "a joiner must never be handed a cancelled or truncated read",
      );
      const outcome = await starterOutcome;
      assert.equal(outcome.ok, false, "the starter must not be handed data it cancelled");
      assert.ok(!outcome.ok && isAbort(outcome.error));
      assert.equal(spy.scans(), 1, "the joiner reused the in-flight scan rather than starting its own");
    } finally {
      hold.restore();
      await starterOutcome;
    }
  });
});

test("readAllMemories: a joiner arriving after the starter aborted starts a fresh scan", async () => {
  await withStorage("remnic-2307-memories-late-joiner-", async (sm) => {
    await sm.writeMemory("fact", "late joiner memory");
    sm.invalidateAllMemoriesCacheForDir();

    const hold = holdFirstScan(sm);
    const starterAbort = new AbortController();
    const starter = sm.readAllMemories({ abortSignal: starterAbort.signal });
    try {
      await hold.reached;
      starterAbort.abort();

      const lateJoiner = sm.readAllMemories();
      hold.release();

      await assert.rejects(starter, isAbort);
      const joined = await lateJoiner;
      assert.ok(
        joined.some((m) => m.content === "late joiner memory"),
        "a late joiner must get its own scan, not the starter's AbortError",
      );
    } finally {
      hold.restore();
      await starter.catch(() => {});
    }
  });
});

test("readAllMemories: a joiner honours its own signal without cancelling the shared scan", async () => {
  await withStorage("remnic-2307-memories-joiner-abort-", async (sm) => {
    await sm.writeMemory("fact", "shared scan memory");
    sm.invalidateAllMemoriesCacheForDir();

    const hold = holdFirstScan(sm);
    const starter = sm.readAllMemories();
    try {
      await hold.reached;
      const joinerAbort = new AbortController();
      const joiner = sm.readAllMemories({ abortSignal: joinerAbort.signal });
      joinerAbort.abort();

      await assert.rejects(joiner, isAbort);

      hold.release();
      const starterResult = await starter;
      assert.ok(
        starterResult.some((m) => m.content === "shared scan memory"),
        "a joiner's cancellation must never reach the shared scan",
      );
    } finally {
      hold.restore();
      await starter.catch(() => {});
    }
  });
});

test("readAllMemories: the scan is cancelled once its LAST waiter leaves", async () => {
  await withStorage("remnic-2307-memories-last-waiter-", async (sm) => {
    await sm.writeMemory("fact", "last waiter memory");
    sm.invalidateAllMemoriesCacheForDir();

    const hold = holdFirstScan(sm);
    const starterAbort = new AbortController();
    const joinerAbort = new AbortController();
    const starter = sm.readAllMemories({ abortSignal: starterAbort.signal });
    try {
      await hold.reached;
      const joiner = sm.readAllMemories({ abortSignal: joinerAbort.signal });

      joinerAbort.abort();
      await assert.rejects(joiner, isAbort);
      starterAbort.abort();
      hold.release();

      await assert.rejects(starter, isAbort);

      hold.restore();
      const spy = installScanSpy(sm);
      const after = await sm.readAllMemories();
      assert.equal(spy.scans(), 1, "the abandoned scan must not have published a cache entry");
      assert.ok(after.some((m) => m.content === "last waiter memory"));
    } finally {
      hold.restore();
      await starter.catch(() => {});
    }
  });
});

test("readAllMemories: a sole waiter's abort does stop the scan", async () => {
  await withStorage("remnic-2307-memories-sole-", async (sm) => {
    await sm.writeMemory("fact", "sole waiter memory");
    sm.invalidateAllMemoriesCacheForDir();

    const hold = holdFirstScan(sm);
    const aborted = new AbortController();
    const pending = sm.readAllMemories({ abortSignal: aborted.signal });
    try {
      await hold.reached;
      aborted.abort();
      hold.release();
      await assert.rejects(pending, isAbort);
    } finally {
      hold.restore();
      await pending.catch(() => {});
    }
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

    const entities = await sm.readAllEntityFiles();
    assert.ok(entities.some((e) => e.name === "Cancelled Person"));
  });
});

test("readAllEntityFiles: a mid-scan abort publishes no partial entity cache", async () => {
  await withStorage("remnic-2307-entities-midscan-", async (sm) => {
    await sm.writeEntity("First Person", "person", ["First Person owns this test."]);
    await sm.writeEntity("Second Person", "person", ["Second Person owns this test too."]);

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

    inner.readMemoryByPath = origRead;
    const matches = await sm.searchArtifacts("deploy runbook", 5);
    assert.equal(matches.length, 2, "the aborted walk must not have cached a partial tier");
  });
});
