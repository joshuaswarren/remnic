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

function gateFixture(isClaimed: boolean) {
  const runs: { turns: BufferTurn[] }[] = [];
  const config = {
    extractionChunkDropAfterFailures: 3,
    extractionMinUserTurns: 1,
    extractionMinChars: 0,
    extractionMaxTurnChars: 100_000,
  };
  const coordinator = new TurnIngestionCoordinator({
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
      runPreemptable: (_preemptable: boolean, parent: unknown, fn: (signal: unknown) => Promise<void>) => fn(parent),
      beginPreemptable: () => {},
    },
    extractionWindowBudgetChars: () => 500,
    getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/dropped" }),
    shouldQueueExtraction: () => true,
    runExtraction: (async (turns: BufferTurn[]) => {
      runs.push({ turns });
      return { status: "completed", persistedCount: 0, durableOutputCount: 0 };
    }),
  } as unknown as TurnIngestionDeps);
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
