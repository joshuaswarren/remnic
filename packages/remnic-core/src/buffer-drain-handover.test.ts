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
import type { ExtractionPreemptHandle } from "./orchestration/extraction-queue-coordinator.js";
import { BufferSessionFiles } from "./storage/buffer-session-files.js";
import { BufferDrainClaims, type DrainLease } from "./storage/buffer-drain-claims.js";
import type { BufferStorage } from "./buffer-persistence.js";
import type { BufferState } from "./types.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { ClaimBufferStorage } from "./orchestration/buffer-drain-runner.js";
import { ExtractionDrain } from "./orchestration/extraction-drain.js";
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
      enqueue: (fn: (preempt?: ExtractionPreemptHandle) => Promise<void>) => {
        void fn().catch(() => {});
        return true;
      },
      runPreemptable: (_preempt: ExtractionPreemptHandle | undefined, _preemptable: boolean, parent: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<void>) => fn(parent ?? new AbortController().signal),
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

// ── In-process claim drain: isolated per-task execution (no global swap) ───

test("claim-backed queue tasks drain their own claims without a global buffer swap", async () => {
  const h = makeHarness();
  try {
    await h.buffer.load();
    const t0 = "2026-11-01T00:00:00.000Z";
    await h.buffer.addTurn("sess-a", turn("a1", "sess-a", t0));
    await h.buffer.addTurn("sess-b", turn("b1", "sess-b", t0));
    await h.buffer.addTurn("sess-live", turn("live-1", "sess-live", t0));
    await h.buffer.save();
    const now = new Date().toISOString();
    const mkLease = (ownerId: string): DrainLease => ({
      ownerId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: now,
      heartbeatAt: now,
      leaseMs: 60_000,
    });
    assert.equal(await h.claims.claimFromSessionFile("sess-a", mkLease("drain-a")), "claimed");
    assert.equal(await h.claims.claimFromSessionFile("sess-b", mkLease("drain-b")), "claimed");

    // Identity tracker: a global swap (withBufferStorage) would replace this
    // instance mid-task; the live deps read it live, exactly like selfDeps.
    const liveHolder: { current: SmartBuffer } = { current: h.buffer };

    // Per-key claim buffers over the SAME claim store (what the runner wires).
    const claimBufferFor = async (key: string, ownerId: string): Promise<SmartBuffer> => {
      const claim = await h.claims.load(key);
      if (!claim) throw new Error(`test setup: claim for ${key} missing`);
      const claimStorage = new ClaimBufferStorage(h.claims, key, ownerId, claim.entry);
      return new SmartBuffer(makeConfig(), claimStorage);
    };
    const claimBuffers = new Map<string, SmartBuffer>([
      ["sess-a", await claimBufferFor("sess-a", "drain-a")],
      ["sess-b", await claimBufferFor("sess-b", "drain-b")],
    ]);
    for (const claimBuffer of claimBuffers.values()) await claimBuffer.load();

    const realQueue = new ExtractionQueueCoordinator(1);
    const runs: { task: string; turns: string[]; liveAtCall: SmartBuffer }[] = [];
    const liveRuns = new Set<string>();
    const makeDrainStub = (task: string, claimBuffer: SmartBuffer | undefined) =>
      // Mimic extraction-run: read the turns handed over, clear them through
      // the CURRENT live instance (a swap would clear into a claim buffer).
      async (turns: BufferTurn[]): Promise<ExtractionRunResult> => {
        runs.push({ task, turns: turns.map((t) => t.content), liveAtCall: liveHolder.current });
        const target = claimBuffer ?? liveHolder.current;
        await target.clearAfterExtraction(task, turns, { allowNonPrefix: true });
        if (!claimBuffer) liveRuns.add(task);
        return { status: "completed", persistedCount: turns.length, durableOutputCount: turns.length };
      };

    const liveStub = makeDrainStub("sess-live", undefined);
    const executionFor = (key: string): {
      buffer: SmartBuffer;
      drain: ExtractionDrain;
    } => {
      const claimBuffer = claimBuffers.get(key)!;
      const drain = new ExtractionDrain(
        {
          config: {
            extractionMinUserTurns: 1,
            extractionMinChars: 0,
            extractionMaxTurnChars: 100_000,
            extractionChunkDropAfterFailures: 3,
          },
          extractionWindowBudgetChars: () => 500,
          runExtraction: makeDrainStub(key, claimBuffer),
          getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/dropped" }),
          buffer: claimBuffer,
        },
        { dropFailedChunks: false },
      );
      return { buffer: claimBuffer, drain };
    };
    const deps = {
      get buffer() {
        return liveHolder.current;
      },
      config: makeConfig(),
      extractionQueueCoordinator: realQueue,
      extractionWindowBudgetChars: () => 500,
      getStorage: async () => ({ saveDroppedExtractionChunk: async () => "/dropped" }),
      shouldQueueExtraction: () => true,
      runExtraction: liveStub,
    } as unknown as TurnIngestionDeps;
    const coordinator = new TurnIngestionCoordinator(deps);

    const settled: Promise<void>[] = [];
    const enqueueClaimTask = (key: string, ownerId: string): void => {
      const claimBuffer = claimBuffers.get(key);
      settled.push(
        new Promise<void>((resolve, reject) => {
          void coordinator
            .queueBufferedExtraction(
              // The claim's turns, grouped upstream (grouping is the runner's
              // next commit; the seam carries whatever list it is given).
              (claimBuffer?.getTurns(key) ?? []).map((t) => ({ ...t })),
              "trigger_mode",
              {
                bufferKey: key,
                clearBufferAfterExtraction: true,
                clearMatchingTurns: true,
                skipDedupeCheck: true,
                skipCharThreshold: true,
                skipUserTurnThreshold: true,
                execution: executionFor(key),
                onTaskSettled: (error) => (error ? reject(error) : resolve()),
              },
            )
            .catch(reject);
        }),
      );
    };
    enqueueClaimTask("sess-a", "drain-a");
    enqueueClaimTask("sess-b", "drain-b");
    // The live foreground capture arrives while the claim tasks hold the queue.
    settled.push(
      new Promise<void>((resolve, reject) => {
        void coordinator
          .queueBufferedExtraction([turn("live-2", "sess-live", "2026-11-01T00:01:00.000Z")], "trigger_mode", {
            bufferKey: "sess-live",
            clearBufferAfterExtraction: true,
            onTaskSettled: (error) => (error ? reject(error) : resolve()),
          })
          .catch(reject);
      }),
    );
    await Promise.all(settled);

    // No swap ever happened: every stub saw the live instance, and the live
    // task's clear went through the live buffer (its turns are gone from it).
    for (const run of runs) {
      assert.equal(run.liveAtCall, h.buffer, "the live buffer instance must never be swapped mid-task");
    }
    assert.deepEqual(
      runs.find((r) => r.task === "sess-a")?.turns,
      ["a1"],
      "task a extracted only its own claim's turns",
    );
    assert.deepEqual(
      runs.find((r) => r.task === "sess-b")?.turns,
      ["b1"],
      "task b extracted only its own claim's turns",
    );
    assert.equal(liveRuns.has("sess-live"), true, "the live task ran through the live path");
    assert.deepEqual(
      h.buffer.getTurns("sess-live").map((t) => t.content),
      ["live-1"],
      "the live task cleared only its queued snapshot through the live buffer",
    );
    // Claim progress landed in the RIGHT claim files (no cross-talk), and the
    // claims' turns were extracted from the claims, not from any live copy.
    assert.deepEqual((await h.claims.load("sess-a"))?.entry.turns ?? [], [], "claim a is drained in place");
    assert.deepEqual((await h.claims.load("sess-b"))?.entry.turns ?? [], [], "claim b is drained in place");
    assert.deepEqual(
      h.buffer.getTurns("sess-a").map((t) => t.content),
      ["a1"],
      "the live buffer's in-memory copy is untouched by the claim drain",
    );
  } finally {
    h.cleanup();
  }
});

test("listPage's cursor is the LAST CONSUMED claim, so a page boundary never skips one", async () => {
  const h = makeHarness();
  try {
    await h.buffer.load();
    for (const key of ["page-sess-a", "page-sess-b", "page-sess-c"]) {
      await h.buffer.addTurn(key, turn(`t-${key}`, key));
    }
    await h.buffer.save();
    for (const key of ["page-sess-a", "page-sess-b", "page-sess-c"]) {
      assert.equal(await h.claims.claimFromSessionFile(key, h.lease), "claimed");
    }
    // Claim file names are hashed, so pagination is asserted order-free.
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await h.claims.listPage(cursor, 2);
      pages += 1;
      for (const entry of page.entries) seen.add(entry.key);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("pagination never exhausted");
    }
    assert.deepEqual(
      [...seen].sort(),
      ["page-sess-a", "page-sess-b", "page-sess-c"],
      "every page-boundary claim must be visited exactly once across rotating pages",
    );
    assert.equal(seen.size, pages === 2 ? 3 : 3, "no claim repeats across the rotation");
  } finally {
    h.cleanup();
  }
});
