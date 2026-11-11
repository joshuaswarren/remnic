import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "./storage.js";
import { withHeldFileLock } from "./utils/serialize-mutations.js";
import { confirmActiveFactDuplicate, persistUnderFactDedupWindow } from "./orchestration/fact-dedup-window.js";

function probe(storage: StorageManager) {
  return { hasContentHashDedup: (s: StorageManager, key: string) => s.hasFactContentHash(key) };
}

async function makeStorage(): Promise<{ storage: StorageManager; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-fact-dedup-window-"));
  return { storage: new StorageManager(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("confirmActiveFactDuplicate sees a fact another session committed into the same namespace", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const recheck = () =>
      confirmActiveFactDuplicate(probe(storage), storage, {
        category: "fact",
        contentHashDedupKey: "the sky is blue",
        connector: undefined,
        citationEnabled: false,
        citationTemplate: "",
      });
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
    const recheck = () =>
      confirmActiveFactDuplicate(probe(storage), storage, {
        category: "fact",
        contentHashDedupKey: "the sky is blue",
        connector: undefined,
        citationEnabled: false,
        citationTemplate: "",
      });

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

test("confirmActiveFactDuplicate falls through when authority flips after a stale MISS", async () => {
  // Race: non-authoritative index answers MISS, then a rebuild finishes before
  // the authority check — trusting that post-probe true would admit a duplicate.
  let probed = false;
  const storage = {
    dir: "/tmp/fact-dedup-authority-race",
    isFactContentHashAuthoritative: async () => probed,
    readAllMemories: async () => [
      {
        frontmatter: { category: "fact", status: "active" },
        content: "the sky is blue",
      },
    ],
    readAllColdMemories: async () => [],
  };
  const raceProbe = {
    hasContentHashDedup: async () => {
      probed = true;
      return false;
    },
  };

  // SAFETY: confirmActiveFactDuplicate reads only isFactContentHashAuthoritative, readAllMemories and readAllColdMemories; the stub above implements exactly those.
  assert.equal(
    await confirmActiveFactDuplicate(raceProbe, storage as never, {
      category: "fact",
      contentHashDedupKey: "the sky is blue",
      connector: undefined,
      citationEnabled: false,
      citationTemplate: "",
    }),
    true,
    "stale MISS under non-authoritative index must confirm against the corpus",
  );
});

test("confirmActiveFactDuplicate keeps the authoritative MISS fast path", async () => {
  let corpusReads = 0;
  const storage = {
    dir: "/tmp/fact-dedup-authoritative-miss",
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => {
      corpusReads += 1;
      return [];
    },
    readAllColdMemories: async () => {
      corpusReads += 1;
      return [];
    },
  };
  const missProbe = { hasContentHashDedup: async () => false };

  // SAFETY: the authoritative fast path reads only the stub methods above; the corpus readers stay unused.
  assert.equal(
    await confirmActiveFactDuplicate(missProbe, storage as never, {
      category: "fact",
      contentHashDedupKey: "the sky is blue",
      connector: undefined,
      citationEnabled: false,
      citationTemplate: "",
    }),
    false,
  );
  assert.equal(corpusReads, 0, "authoritative MISS must not scan the corpus");
});

