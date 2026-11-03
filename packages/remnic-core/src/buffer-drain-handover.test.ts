// Buffer-drain handover protocol: a live buffer owner (the daemon) must hand
// a claimed session's turns INTO the drain claim instead of writing a session
// file, so the out-of-process `remnic buffer drain` can extract them without
// the daemon resurrecting or losing content. Covers:
//   1. persist path: claimed key saves hand over + evict the in-memory entry,
//      merging the owner's newest turns into the claim (identity-deduped).
//   2. no resurrection: after handover the session file stays gone.
//   3. extraction gate: a claimed session's queued extraction settles skipped
//      (claimed_by_buffer_drain) without touching the LLM; turns stay in the
//      claim for the drain worker.
//   4. default-key mirror: handing over "default" clears the legacy mirror.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { BufferSessionFiles } from "./storage/buffer-session-files.js";
import { BufferDrainClaims, type DrainLease } from "./storage/buffer-drain-claims.js";
import type { BufferStorage } from "./buffer-persistence.js";
import type { BufferState } from "./types.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import type { BufferEntryState, BufferTurn, PluginConfig } from "./types.js";
import { parseConfig } from "./config.js";
import type { ExtractionRunResult } from "./orchestration/extraction-run.js";

function plainIo() {
  return {
    read: async (filePath: string) => readFileSync(filePath, "utf8"),
    write: async (filePath: string, content: string) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    },
  };
}

function turn(content: string, sessionKey = "sess-1", timestamp = "2026-11-01T00:00:00.000Z"): BufferTurn {
  return { role: "user", content, timestamp, sessionKey };
}

function entry(turns: ReturnType<typeof turn>[]): BufferEntryState {
  return { turns, lastExtractionAt: null, extractionCount: 0 };
}

function makeConfig(): PluginConfig {
  return parseConfig({
    bufferSaveDebounceMs: 0,
    triggerMode: "smart",
    bufferMaxTurns: 1000,
    bufferMaxMinutes: 100000,
    highSignalPatterns: [],
    extractionMinUserTurns: 1,
    extractionMinChars: 0,
  });
}

interface Harness {
  stateDir: string;
  buffer: SmartBuffer;
  claims: BufferDrainClaims;
  storage: BufferStorage;
  lease: DrainLease;
  cleanup(): void;
}

/** A SmartBuffer wired exactly like the daemon wires it: storage methods backed by BufferSessionFiles. */
function makeHarness(): Harness {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remnic-handover-"));
  const files = new BufferSessionFiles(stateDir, plainIo());
  const claims = new BufferDrainClaims(stateDir, plainIo());
  const storage: BufferStorage = {
    loadBuffer: () => files.load(),
    saveBuffer: (state: BufferState) => files.reconcile(state),
    saveBufferSession: (key: string, entryState: BufferEntryState) => files.save(key, entryState),
    deleteBufferSession: (key: string) => files.remove(key),
    isBufferSessionClaimed: (key: string) => files.isClaimed(key),
  };
  const buffer = new SmartBuffer(makeConfig(), storage);
  const now = new Date().toISOString();
  return {
    stateDir,
    buffer,
    claims,
    storage,
    lease: { ownerId: "worker-1", pid: process.pid, host: hostname(), acquiredAt: now, heartbeatAt: now, leaseMs: 60_000 },
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

test("a claimed session's save hands over and evicts instead of writing a session file", async () => {
  const h = makeHarness();
  try {
    await h.buffer.load();
    await h.buffer.addTurn("sess-1", turn("old-1"));
    await h.buffer.addTurn("sess-1", turn("old-2"));
    assert.ok(readdirSync(path.join(h.stateDir, "buffer")).some((name) => name.endsWith(".json")), "seeded turns persisted as a session file");

    const outcome = await h.claims.claimFromSessionFile("sess-1", h.lease);
    assert.equal(outcome, "claimed");

    // The daemon owner buffers one more turn for the claimed session and its
    // debounced-off save fires: this is the resurrection path, and it must
    // hand over instead.
    await h.buffer.addTurn("sess-1", turn("new-3"));
    await h.buffer.save();

    const claim = await h.claims.load("sess-1");
    assert.ok(claim, "claim must exist after handover");
    assert.deepEqual(
      claim.entry.turns.map((t) => t.content),
      ["old-1", "old-2", "new-3"],
      "the owner's newest turn merges into the claim; nothing duplicates",
    );
    const topLevel = readdirSync(path.join(h.stateDir, "buffer")).filter((name) => name.endsWith(".json"));
    assert.deepEqual(topLevel, [], "a claimed session must never be written back as a session file");

    // The in-memory entry was evicted with the handover: the next observe
    // starts fresh (its turns flow into the claim at the next handover).
    await h.buffer.addTurn("sess-1", turn("post-eviction", "sess-1", "2026-11-01T00:05:00.000Z"));
    await h.buffer.save();
    const claimAfter = await h.claims.load("sess-1");
    assert.ok(claimAfter);
    assert.deepEqual(
      claimAfter.entry.turns.map((t) => t.content),
      ["old-1", "old-2", "new-3", "post-eviction"],
      "post-handover observes keep flowing into the claim",
    );
    assert.deepEqual(
      readdirSync(path.join(h.stateDir, "buffer")).filter((name) => name.endsWith(".json")),
      [],
    );
  } finally {
    h.cleanup();
  }
});

test("handover of the default key clears the legacy top-level mirror", async () => {
  const h = makeHarness();
  try {
    await h.buffer.load();
    await h.buffer.addTurn("default", turn("legacy", "legacy-session"));
    const outcome = await h.claims.claimFromSessionFile("default", h.lease);
    assert.equal(outcome, "claimed");
    await h.buffer.addTurn("default", turn("legacy-2", "legacy-session"));
    await h.buffer.save();
    const claim = await h.claims.load("default");
    assert.ok(claim);
    assert.deepEqual(claim.entry.turns.map((t) => t.content), ["legacy", "legacy-2"]);
    // No duplicate writes: the snapshot must settle empty after handover.
    assert.deepEqual(
      readdirSync(path.join(h.stateDir, "buffer")).filter((name) => name.endsWith(".json")),
      [],
    );
  } finally {
    h.cleanup();
  }
});

/**
 * Narrow a test double to the dependency contract. The fixture provides the
 * members the drain path reads; the rest are unused by that path.
 */
/** The dependency members the drain path reads. */
interface DrainDepsFixture {
  buffer: unknown;
  config: unknown;
  extractionQueueCoordinator: unknown;
  extractionWindowBudgetChars: unknown;
  getStorage: unknown;
  shouldQueueExtraction: unknown;
  runExtraction: unknown;
}

function asDeps<T extends object>(value: DrainDepsFixture): T {
  // SAFETY: the fixture provides the members the drain path reads; the
  // remaining contract members are unused by that path.
  return value as T;
}

function gateFixture(isClaimed: boolean) {
  const runs: { turns: BufferTurn[] }[] = [];
  const config = {
    extractionChunkDropAfterFailures: 3,
    extractionMinUserTurns: 1,
    extractionMinChars: 0,
    extractionMaxTurnChars: 100_000,
  };
  const deps = {
    buffer: {
      isSessionClaimed: () => isClaimed,
      getTurns: () => [],
      dropExtractionChunk: async () => 0,
    },
    config,
    extractionQueueCoordinator: {
      enqueue: (fn: () => Promise<void>) => {
        void fn().catch(() => {});
        return true;
      },
      runPreemptable: (_preemptable: boolean, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<void>) => fn(parent ?? new AbortController().signal),
      beginPreemptable: () => {},
    },
    extractionWindowBudgetChars: () => 500,
    getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/dropped" }),
    shouldQueueExtraction: () => true,
    runExtraction: (async (turns: BufferTurn[]) => {
      runs.push({ turns });
      return { status: "completed", persistedCount: 0, durableOutputCount: 0 };
    }),
    // SAFETY: the fixture provides exactly the deps the coordinator reads
    // for the drain path (buffer, queue coordinator, budget, storage, dedupe
    // gate and runExtraction); the cast only fills the unused members.
  };
  const coordinator = new TurnIngestionCoordinator(asDeps<TurnIngestionDeps>(deps));
  return { coordinator, runs };
}

test("a claimed session's queued extraction settles skipped without an LLM call", async () => {
  const claimed = gateFixture(true);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  void claimed.coordinator.queueBufferedExtraction([turn("blocked")], "trigger_mode", {
    bufferKey: "sess-1",
    clearBufferAfterExtraction: true,
    onTaskSettled: (error, result) => {
      try {
        assert.equal(error, undefined);
        assert.equal(result?.status, "skipped");
        assert.equal(result?.reason, "claimed_by_buffer_drain");
        assert.equal(claimed.runs.length, 0, "the LLM must not run for a claimed session");
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  await promise;
});

test("an unclaimed session still extracts normally (gate is claim-only)", async () => {
  const unclaimed = gateFixture(false);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  void unclaimed.coordinator.queueBufferedExtraction([turn("flows")], "trigger_mode", {
    bufferKey: "sess-2",
    clearBufferAfterExtraction: true,
    onTaskSettled: (error, result) => {
      try {
        assert.equal(error, undefined);
        assert.notEqual(result?.reason, "claimed_by_buffer_drain");
        assert.equal(unclaimed.runs.length, 1);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
  await promise;
});

test("the owner keeps the claim while a drain is still running on it", async () => {
  const h = makeHarness();
  try {
    await h.buffer.load();
    await h.buffer.addTurn("sess-1", turn("old-1"));
    await h.buffer.addTurn("sess-1", turn("old-2"));
    const claimOutcome = await h.claims.claimFromSessionFile("sess-1", h.lease);
    assert.equal(claimOutcome, "claimed");

    // The drainer extracts old-1 (progress write moves it to `drained`) but
    // old-2 is still pending, and the drainer holds the lease.
    const loaded = await h.claims.load("sess-1");
    assert.ok(loaded);
    await h.claims.writeEntry("sess-1", h.lease.ownerId, entry([turn("old-2")]), loaded.entry);

    // The owner saves while the drain is mid-flight: this must hand over into
    // the claim (keeping the claim AND the lease), not consume the tombstone.
    await h.buffer.addTurn("sess-1", turn("new-3"));
    await h.buffer.save();
    const saveSession = h.storage.saveBufferSession;
    assert.ok(saveSession, "the harness wires saveBufferSession");
    const saveOutcome = await saveSession("sess-1", {
      turns: [turn("old-1"), turn("old-2"), turn("new-3")],
      lastExtractionAt: null,
      extractionCount: 0,
    });
    assert.equal(saveOutcome?.status, "handed_over", "a running drain keeps its claim");
    assert.equal(await h.claims.load("sess-1") !== null, true, "the claim survives the owner's mid-drain save");
    assert.equal(existsSync(h.claims.leasePathForTest("sess-1")), true, "the lease survives the owner's mid-drain save");

    // The drain finishes: everything extracted, the drainer acks (drops its
    // lease, leaving the tombstone). Only now does the owner's save consume it.
    const current = await h.claims.load("sess-1");
    assert.ok(current);
    await h.claims.writeEntry("sess-1", h.lease.ownerId, entry([]), current.entry);
    await h.claims.releaseLease("sess-1", h.lease.ownerId);
    const finalOutcome = await saveSession("sess-1", {
      turns: [turn("old-1"), turn("old-2"), turn("new-3")],
      lastExtractionAt: null,
      extractionCount: 0,
    });
    assert.equal(finalOutcome?.status, "saved", "the acked tombstone is consumed");
    assert.equal(await h.claims.load("sess-1"), null, "the tombstone is gone after the consume");
  } finally {
    h.cleanup();
  }
});
