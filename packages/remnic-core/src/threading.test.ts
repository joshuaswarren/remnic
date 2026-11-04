import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThreadingManager } from "./threading.js";
import type { BufferTurn, ConversationThread } from "./types.js";

function turn(sessionKey: string, content: string): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-04T10:00:00.000Z", sessionKey };
}

async function makeThreading(): Promise<{ threading: ThreadingManager; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-threads-"));
  return { threading: new ThreadingManager(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a recently used session is not evicted FIFO when the cap overflows", async () => {
  const { threading, cleanup } = await makeThreading();
  try {
    const threadA = await threading.processTurn(turn("session-a", "a1"), []);
    // Fill the map to exactly the cap with inactive sessions (session-a is
    // now the OLDEST entry).
    for (let i = 0; i < 511; i++) {
      await threading.processTurn(turn(`flood-${i}`, `flood ${i}`), []);
    }
    // Touch session-a: under LRU this makes it the most recent entry; under
    // FIFO it stays oldest and the next insertion evicts it.
    await threading.processTurn(turn("session-a", "a2"), ["episode-a2"]);
    await threading.processTurn(turn("flood-new", "the straw"), []);

    const idA3 = await threading.processTurn(turn("session-a", "a3"), ["episode-a3"]);
    assert.equal(idA3, threadA, "a just-used session must not be evicted before inactive ones");
    assert.ok((await threading.loadThread(threadA))?.episodeIds.includes("episode-a2"));
  } finally {
    await cleanup();
  }
});

test("concurrent turns for two sessions never share thread run state", async () => {
  const { threading, cleanup } = await makeThreading();
  try {
    const realSave = threading.saveThread.bind(threading);
    const aSaveEntered = Promise.withResolvers<void>();
    const aGate = Promise.withResolvers<void>();
    let holdArmed = false;
    // Hold session A's save open, and only let it resume after session B has
    // run a full processTurn to completion through the shared manager — the
    // exact interleaving a shared run-state slot corrupts.
    threading.saveThread = async (thread: ConversationThread): Promise<void> => {
      if (holdArmed && thread.sessionKey === "session-a") {
        aSaveEntered.resolve();
        await aGate.promise;
      }
      await realSave(thread);
    };
    holdArmed = true;
    const pendingA = threading.processTurn(turn("session-a", "a1"), []);
    await aSaveEntered.promise;
    const idB = await threading.processTurn(turn("session-b", "b1"), []);
    aGate.resolve();
    const idA = await pendingA;

    assert.notEqual(idA, idB);
    assert.equal((await threading.loadThread(idA))?.sessionKey, "session-a");
    assert.equal((await threading.loadThread(idB))?.sessionKey, "session-b");

    // Each session's follow-up turn must append to its OWN thread. With the
    // shared slot, A resumed last and left its session key in the global
    // state, so B's next turn sees "session-a" and starts a fresh thread.
    assert.equal(await threading.processTurn(turn("session-a", "a2"), []), idA);
    assert.equal(await threading.processTurn(turn("session-b", "b2"), []), idB);
  } finally {
    await cleanup();
  }
});

test("an in-flight session survives a 512-session flood arriving mid-await", async () => {
  const { threading, cleanup } = await makeThreading();
  try {
    const threadA = await threading.processTurn(turn("session-a", "a1"), []);

    const realSave = threading.saveThread.bind(threading);
    const gate = Promise.withResolvers<void>();
    const a2SaveEntered = Promise.withResolvers<void>();
    let floodArmed = false;
    threading.saveThread = async (thread: ConversationThread): Promise<void> => {
      if (floodArmed && thread.id === threadA) {
        a2SaveEntered.resolve();
        await gate.promise;
      }
      await realSave(thread);
    };
    floodArmed = true;
    const secondTurn = threading.processTurn(turn("session-a", "a2"), ["episode-a2"]);
    await a2SaveEntered.promise;

    // Session A is parked inside saveThread. 512 other sessions insert their
    // run state while it waits; eviction must not take an in-flight session's
    // state, or A's thread id is lost and its next turn starts a new thread.
    for (let i = 0; i < 512; i++) {
      await threading.processTurn(turn(`flood-${i}`, `flood ${i}`), []);
    }
    gate.resolve();

    const idA2 = await secondTurn;
    assert.equal(idA2, threadA, "resumed turn must still own its session's thread");
    const idA3 = await threading.processTurn(turn("session-a", "a3"), ["episode-a3"]);
    assert.equal(idA3, threadA);
    assert.ok((await threading.loadThread(threadA))?.episodeIds.includes("episode-a2"));
  } finally {
    await cleanup();
  }
});
