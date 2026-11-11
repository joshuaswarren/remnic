import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";
import { confirmActiveFactDuplicate, persistUnderFactDedupWindow } from "./orchestration/fact-dedup-window.js";
import { persistExplicitCapture } from "./explicit-capture.js";
import { Orchestrator } from "./orchestrator.js";

const SKY_OPTS = {
  category: "fact",
  contentHashDedupKey: "the sky is blue",
  connector: undefined,
  citationEnabled: false,
  citationTemplate: "",
} as const;
const CONTENDED_LOCK_OPTIONS = { maxWaitMs: 40, pollMs: 10, retryMaxAttempts: 2, retryBaseMs: 10 };

/** Hold a fresh fact-hash index lock the way a peer mid-publish does; returns the release. */
async function holdIndexLock(root: string): Promise<() => Promise<void>> {
  const lockPath = path.join(root, "state", "fact-hashes.txt.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `99999 peer-owner ${new Date().toISOString()}\n`);
  return () => rm(lockPath, { force: true });
}

async function makeStorage(): Promise<{ storage: StorageManager; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-fact-dedup-window-"));
  return { storage: new StorageManager(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("confirmActiveFactDuplicate sees a fact another session committed into the same namespace", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const recheck = () => confirmActiveFactDuplicate(storage, SKY_OPTS);
    assert.equal(await recheck(), false, "clean namespace must not report a duplicate");

    // A concurrent session (separate manager, same dir) commits the fact.
    const peer = new StorageManager(storage["baseDir"]);
    await peer.writeMemory("fact", "The sky is BLUE!");

    assert.equal(await recheck(), true, "the committed fact must confirm as an active duplicate");
  } finally {
    await cleanup();
  }
});

test("persistUnderFactDedupWindow suppresses on recheck hit and writes on a miss", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    let writes = 0;
    const write = async () => {
      writes += 1;
      await storage.writeMemory("fact", "the sky is blue");
      return "written";
    };
    const recheck = () => confirmActiveFactDuplicate(storage, SKY_OPTS);

    // First session: recheck misses, write proceeds.
    const first = await persistUnderFactDedupWindow(storage["baseDir"], recheck, write);
    assert.deepEqual(first, { suppressed: false, result: "written" });
    assert.equal(writes, 1);

    // Second session racing the same content: recheck hits, write suppressed.
    const second = await persistUnderFactDedupWindow(storage["baseDir"], recheck, write);
    assert.deepEqual(second, { suppressed: true });
    assert.equal(writes, 1, "the raced duplicate must not be written");
    assert.equal(await storage.hasFactContentHash("the sky is blue"), true);
  } finally {
    await cleanup();
  }
});

test("persistUnderFactDedupWindow fails closed when a peer holds fact-dedup.lock", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const holderEntered = Promise.withResolvers<void>();
    const holderRelease = Promise.withResolvers<void>();
    const holder = withHeldFileLock(
      path.join(storage["baseDir"], "fact-dedup.lock"),
      { staleMs: 60_000 },
      async (acquired) => {
        assert.ok(acquired, "test holder must acquire the lock");
        holderEntered.resolve();
        await holderRelease.promise;
      },
    );
    await holderEntered.promise;

    let wrote = false;
    await assert.rejects(
      persistUnderFactDedupWindow(
        storage["baseDir"],
        async () => false,
        async () => {
          wrote = true;
          return "written";
        },
      ),
      /fact-dedup\.lock not acquired/,
    );
    assert.equal(wrote, false, "a locked-out writer must not write unlocked");

    holderRelease.resolve();
    await holder;
    const outcome = await persistUnderFactDedupWindow(
      storage["baseDir"],
      async () => false,
      async () => "written",
    );
    assert.deepEqual(outcome, { suppressed: false, result: "written" });
  } finally {
    await cleanup();
  }
});

test("lookupContentHash never pairs a stale MISS with authority while a peer holds the index lock", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    storage.factHashIndexLockOptions = CONTENDED_LOCK_OPTIONS;
    assert.equal(await storage.isFactContentHashAuthoritative(), true, "starts authoritative");
    const peer = new StorageManager(storage["baseDir"]);
    await peer.writeMemory("fact", "The sky is BLUE!");
    const release = await holdIndexLock(storage["baseDir"]);
    try {
      assert.deepEqual(
        await storage.lookupContentHash(SKY_OPTS.contentHashDedupKey),
        { present: false, authoritative: false },
        "the rebuild cannot run, so the stale MISS must not claim authority",
      );
      assert.equal(await confirmActiveFactDuplicate(storage, SKY_OPTS), true, "the corpus confirms the peer's fact");
    } finally {
      await release();
    }
    assert.deepEqual(
      await storage.lookupContentHash(SKY_OPTS.contentHashDedupKey),
      { present: true, authoritative: true },
      "once the lock is free the rebuild publishes and the hit is authoritative",
    );
  } finally {
    await cleanup();
  }
});

test("confirmActiveFactDuplicate stays a duplicate when the peer releases the index lock right after the lookup", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    storage.factHashIndexLockOptions = CONTENDED_LOCK_OPTIONS;
    assert.equal(await storage.isFactContentHashAuthoritative(), true, "starts authoritative");
    const peer = new StorageManager(storage["baseDir"]);
    await peer.writeMemory("fact", "The sky is BLUE!");
    const release = await holdIndexLock(storage["baseDir"]);
    const lookup = storage.lookupContentHash.bind(storage);
    mock.method(storage, "lookupContentHash", async (content: string) => {
      const answer = await lookup(content);
      await release();
      return answer;
    });
    assert.equal(
      await confirmActiveFactDuplicate(storage, SKY_OPTS),
      true,
      "a lock released after the lookup must not turn the stale MISS into a clean not-duplicate",
    );
  } finally {
    await cleanup();
  }
});

test("two managers on one directory commit the same fact through the window exactly once", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const peer = new StorageManager(storage["baseDir"]);
    const commit = (manager: StorageManager) =>
      persistUnderFactDedupWindow(
        manager.dir,
        () => confirmActiveFactDuplicate(manager, SKY_OPTS),
        () => manager.writeMemory("fact", "The sky is blue"),
      );
    const outcomes = await Promise.all([commit(storage), commit(peer)]);
    assert.equal(outcomes.filter((outcome) => !outcome.suppressed).length, 1, "one writer wins, the other is suppressed");
    const stored = await new StorageManager(storage["baseDir"]).readAllMemories();
    assert.equal(stored.filter((memory) => memory.content.includes("sky is blue")).length, 1);
  } finally {
    await cleanup();
  }
});

test("explicit capture and an extraction write race the same new fact to exactly one active copy (#3354)", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const content = "An extraction run and an explicit capture hold this new fact.";
    // SAFETY: persistExplicitCapture reads only getStorage here (namespacePreResolved skips the config-based namespace resolver); the prototype stub exists for the type only.
    const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator;
    orchestrator.getStorage = async () => storage;
    const candidate = { content, category: "fact" as const, confidence: 0.9, tags: [], namespacePreResolved: true };
    const extractionCommit = persistUnderFactDedupWindow(
      storage.dir,
      () => confirmActiveFactDuplicate(storage, { ...SKY_OPTS, contentHashDedupKey: content }),
      () => storage.writeMemory("fact", content),
    );
    const [capture, extraction] = await Promise.all([
      persistExplicitCapture(orchestrator, candidate, "memory_store"),
      extractionCommit,
    ]);
    const stored = await storage.readAllMemories();
    const active = stored.filter(
      (memory) => memory.frontmatter.category === "fact" && (memory.frontmatter.status ?? "active") === "active",
    );
    assert.equal(active.length, 1, `exactly one active copy of the raced fact, got ${active.length}`);
    const winner = active[0];
    assert.ok(winner, "the single active copy must exist");
    assert.ok(winner.content.includes(content));
    if (capture.duplicateOf === undefined) {
      assert.equal(extraction.suppressed, true, "the extraction write is the loser and must be suppressed");
    } else {
      assert.equal(winner.frontmatter.id, capture.duplicateOf, "the capture reports the winning copy");
    }
  } finally {
    await cleanup();
  }
});

test("confirmActiveFactDuplicate keeps the authoritative MISS fast path", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    assert.equal(await storage.isFactContentHashAuthoritative(), true, "warm the index so no rebuild reads the corpus");
    const corpusReads = mock.method(storage, "readAllMemories");
    assert.equal(await confirmActiveFactDuplicate(storage, SKY_OPTS), false);
    assert.equal(corpusReads.mock.callCount(), 0, "authoritative MISS must not scan the corpus");
  } finally {
    await cleanup();
  }
});

