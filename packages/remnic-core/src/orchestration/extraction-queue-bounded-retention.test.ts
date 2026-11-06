import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "../config.js";
import { SmartBuffer } from "../buffer.js";
import type { BufferStorage } from "../buffer-persistence.js";
import type { CorrectionService } from "../correction/correction-service.js";
import type { StorageManager } from "../index.js";
import { SessionObserverState } from "../session-observer-state.js";
import { TranscriptManager } from "../transcript.js";
import type { BufferState, BufferTurn } from "../types.js";
import { ExtractionQueueCoordinator } from "./extraction-queue-coordinator.js";
import { queueBufferedCaptureScopeGroups } from "./extraction-task-queueing.js";
import { chainPrefixEquivalent, ExtractionSnapshotSharingRegistry, materializeChain, turnRepresentationEquivalent, type SnapshotChain } from "./extraction-queue-snapshot-sharing.js";
import { bufferTurnsEqual } from "../buffer-turn-helpers.js";
import {
  TurnIngestionCoordinator,
  type TurnIngestionDeps,
} from "./turn-ingestion.js";

/**
 * Controlled real-queue workload for the unbounded-retention flaw (#3324
 * follow-up). While the drain is blocked (the production OOM shape: LLM
 * latency >> trigger cadence), every new buffered turn re-triggers
 * extraction and enqueues a FULL prefix snapshot of the buffer. On current
 * main each queued closure retains its own deep copy of every overlapping
 * turn, so queued memory grows superlinearly with trigger count. The bounded
 * design shares turn objects across overlapping queued snapshots of the same
 * buffer key — exact value semantics (bufferTurnsEqual) with O(union)
 * retention instead of O(sum of snapshots).
 */

class FakeStorage implements BufferStorage {
  constructor(private readonly initial: BufferState) {}
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }
  async saveBuffer(): Promise<void> {}
}

interface Harness {
  coordinator: TurnIngestionCoordinator;
  queue: ExtractionQueueCoordinator;
  buffer: SmartBuffer;
  /** Turn arrays as they reached the extraction boundary, in drain order. */
  received: BufferTurn[][];
  /** Release the blocked drain; resolves when every accepted task exited. */
  release(): Promise<void>;
  /** Accepted tasks: running or queued. */
  outstanding(): number;
}

function makeTurn(content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-08-17T00:00:00.000Z",
    sessionKey: "k",
  };
}

interface BufferOverrides {
  namespacesEnabled?: boolean;
  namespacePolicies?: unknown[];
}

function makeHarness(bufferMaxTurns = 1, configOverrides: BufferOverrides = {}): Harness {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-queue-retention-"));
  const storage = new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 });
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns, bufferSaveDebounceMs: 0, memoryDir }),
    storage,
  );
  const queue = new ExtractionQueueCoordinator(1);
  const received: BufferTurn[][] = [];
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  let coordinatorRef: TurnIngestionCoordinator | undefined;
  const config = parseConfig({
    triggerMode: "every_n",
    bufferMaxTurns,
    bufferSaveDebounceMs: 0,
    memoryDir,
    ...configOverrides,
  });
  const deps: TurnIngestionDeps = {
    buffer,
    config,
    getStorage: async (): Promise<StorageManager> => {
      throw new Error("unexpected getStorage");
    },
    bulkImportWriteNamespace: () => "default",
    extractionQueueCoordinator: queue,
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set<string>(),
    passiveCorrectionService: (): CorrectionService => {
      throw new Error("unexpected passiveCorrectionService");
    },
    passiveCorrectionTelemetry: {
      detected: 0,
      queued: 0,
      autoApplied: 0,
      suppressedReasonCounts: {},
    },
    queueBufferedExtraction: (
      ...args: Parameters<TurnIngestionDeps["queueBufferedExtraction"]>
    ): Promise<void> => {
      const coordinator = coordinatorRef;
      assert.ok(coordinator, "coordinator must be constructed before queueing");
      return coordinator.queueBufferedExtraction(...args);
    },
    resolveMemoryIdOrHandle: () => {
      throw new Error("unexpected resolveMemoryIdOrHandle");
    },
    runExtraction: async (turns: BufferTurn[]) => {
      received.push(turns);
      await gate;
      return {
        status: "completed" as const,
        persistedCount: 0,
        durableOutputCount: 0,
      };
    },
    sessionObserver: new SessionObserverState({ memoryDir, debounceMs: 0, bands: [] }),
    shouldQueueExtraction: () => true,
    transcript: new TranscriptManager(config),
  };
  const coordinator = new TurnIngestionCoordinator(deps);
  coordinatorRef = coordinator;
  return {
    coordinator,
    queue,
    buffer,
    received,
    release: async () => {
      openGate();
      await queue.waitForIdle(30_000);
    },
    outstanding: () => queue.length + (queue.isProcessing ? 1 : 0),
  };
}

test("overlapping queued same-key snapshots share turn objects (bounded retention)", async () => {
  const h = makeHarness();
  const turns = 40;
  for (let index = 1; index <= turns; index += 1) {
    await h.coordinator.processTurn("user", `turn ${index} ${"x".repeat(64)}`, "k");
  }
  assert.equal(h.outstanding(), turns, "drain blocked: every trigger stays accepted");
  await h.release();

  assert.equal(h.received.length, turns, "every trigger extracts exactly its own window");
  for (let index = 0; index < h.received.length; index += 1) {
    assert.equal(h.received[index]?.length, index + 1, `window ${index} is the full prefix snapshot`);
  }
  // Bounded-memory proof: consecutive snapshots overlap by identity, so the
  // queue retains the union of turn objects, not one deep copy per snapshot.
  for (let index = 1; index < h.received.length; index += 1) {
    const previous = h.received[index - 1];
    const current = h.received[index];
    assert.ok(previous && current, "every trigger produced a window");
    for (let offset = 0; offset < previous.length; offset += 1) {
      assert.ok(
        previous[offset] === current[offset],
        `snapshot ${index} must alias snapshot ${index - 1}'s turn at offset ${offset}`,
      );
    }
  }
});

test("behavior unchanged: FIFO windows and value equality", async () => {
  const h = makeHarness();
  const turns = 12;
  for (let index = 1; index <= turns; index += 1) {
    await h.coordinator.processTurn("user", `content ${index}`, "k");
  }
  await h.release();

  assert.equal(h.received.length, turns);
  for (let index = 0; index < turns; index += 1) {
    const window = h.received[index];
    assert.ok(window, "window present in drain order");
    assert.equal(window.length, index + 1);
    for (let offset = 0; offset <= index; offset += 1) {
      assert.equal(window[offset]?.content, `content ${offset + 1}`);
    }
  }
  assert.equal(h.queue.isProcessing, false);
});

test("distinct scopes stay independent: different accepted pins never alias", async () => {
  const h = makeHarness(
    10_000,
    {
      namespacesEnabled: true,
      namespacePolicies: [
        { name: "ns-a", readPrincipals: ["*"], writePrincipals: ["principal-a"] },
        { name: "ns-b", readPrincipals: ["*"], writePrincipals: ["principal-b"] },
      ],
    },
  );
  const base = makeTurn("ordinary");
  const acceptedA: BufferTurn = {
    ...makeTurn("accepted A"),
    acceptedCapture: true,
    writeNamespaceOverride: "ns-a",
    principalOverride: "principal-a",
  };
  const acceptedB: BufferTurn = {
    ...makeTurn("accepted B"),
    acceptedCapture: true,
    writeNamespaceOverride: "ns-b",
    principalOverride: "principal-b",
  };
  const seeded = [base, acceptedA, acceptedB, { ...acceptedA, content: "accepted A2" }];
  for (const turn of seeded) await h.buffer.addTurn("k", turn);
  const settlementPromises: Promise<void>[] = [];
  queueBufferedCaptureScopeGroups(
    h.coordinator.queueBufferedExtraction.bind(h.coordinator),
    seeded,
    "k",
    { onExtractionQueued: (promise) => settlementPromises.push(promise) },
  );
  await h.release();
  await Promise.allSettled(settlementPromises);
  // Each scope group is its own queued task with its own window; no cross-scope
  // turn objects may be shared.
  const acceptedAWindow = h.received.find(
    (window) => window.some((turn) => turn.writeNamespaceOverride === "ns-a"),
  );
  const acceptedBWindow = h.received.find(
    (window) => window.some((turn) => turn.writeNamespaceOverride === "ns-b"),
  );
  assert.ok(acceptedAWindow && acceptedBWindow, "both scope groups drain");
  for (const a of acceptedAWindow) {
    for (const b of acceptedBWindow) {
      assert.ok(a !== b, "cross-scope turn objects must never alias");
    }
  }
  assert.ok(settlementPromises.length >= 1);
});

test("front preemption still works: front task runs first, queued work intact", async () => {
  const h = makeHarness();
  await h.coordinator.processTurn("user", "queued 1", "k");
  await h.coordinator.processTurn("user", "queued 2", "k");
  assert.equal(h.outstanding(), 2);
  const order: string[] = [];
  h.queue.enqueue(
    async () => {
      order.push("front");
    },
    { front: true, key: "k" },
  );
  await h.release();
  assert.deepEqual(order, ["front"]);
  assert.equal(h.received.length, 2, "queued extraction work survives a front task");
  assert.equal(h.received[0]?.[0]?.content, "queued 1", "per-key FIFO order preserved");
});

test("pre-aborted automatic capture settles without queueing", async () => {
  const h = makeHarness();
  const controller = new AbortController();
  controller.abort();
  const turns = [makeTurn("never extracted")];
  await h.coordinator.queueBufferedExtraction(turns, "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
    abortSignal: controller.signal,
  });
  await h.release();
  assert.equal(h.received.length, 0, "aborted before start: extraction never runs");
  assert.equal(h.queue.length, 0);
});

test("abort while queued: settled task starts, skips extraction, queue drains", async () => {
  const h = makeHarness();
  const controller = new AbortController();
  // Occupies the single worker (starts synchronously on enqueue).
  await h.coordinator.processTurn("user", "running", "k");
  // Same key: queues behind the running task while the drain is blocked.
  const settled: unknown[] = [];
  await h.coordinator.queueBufferedExtraction([makeTurn("queued then aborted")], "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
    abortSignal: controller.signal,
    onTaskSettled: (error) => settled.push(error),
  });
  assert.equal(h.outstanding(), 2);
  controller.abort();
  await h.release();
  assert.equal(h.queue.length, 0);
  assert.equal(h.queue.isProcessing, false);
  assert.equal(h.received.length, 1, "running window finishes; queued window never extracts");
  assert.equal(h.received[0]?.[0]?.content, "running");
  assert.equal(settled.length, 1, "queued task settles exactly once from the abort");
});

test("sharing bound: distinct reference slots equal the union, not the snapshot sum", async () => {
  const h = makeHarness();
  const turns = 30;
  for (let index = 1; index <= turns; index += 1) {
    await h.coordinator.processTurn("user", `bound ${index}`, "k");
  }
  const stats = h.coordinator.snapshotSharing.stats();
  assert.equal(stats.queuedNodes, turns, "one chain node per accepted automatic task");
  assert.equal(stats.queuedTailRefs, turns, "distinct reference slots = union of turns");
  // Documents what un-shared retention would be for the same workload: the
  // sum over full prefix snapshots (1+2+...+N), the quadratic term main pays.
  assert.equal(stats.queuedTotalRefs, (turns * (turns + 1)) / 2);
  await h.release();
  const drained = h.coordinator.snapshotSharing.stats();
  assert.equal(drained.queuedNodes, 0, "registry empties after the drain");
  assert.equal(drained.queuedTailRefs, 0);
  assert.equal(drained.queuedTotalRefs, 0);
});

test("non-overlapping snapshots start fresh chains and stay exact", async () => {
  const h = makeHarness();
  await h.coordinator.queueBufferedExtraction([makeTurn("first era")], "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
  });
  await h.coordinator.queueBufferedExtraction([makeTurn("second era")], "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
  });
  const stats = h.coordinator.snapshotSharing.stats();
  assert.equal(stats.queuedNodes, 2);
  assert.equal(stats.queuedTailRefs, 2, "no overlap: nothing shared");
  await h.release();
  assert.equal(h.received[0]?.[0]?.content, "first era");
  assert.equal(h.received[1]?.[0]?.content, "second era");
});

test("representation guard: bufferTurnsEqual turns differing in ignored fields never share", async () => {
  const registry = new ExtractionSnapshotSharingRegistry();
  const plain: BufferTurn = makeTurn("identical");
  const withParts: BufferTurn = { ...makeTurn("identical"), parts: [{ kind: "text", payload: { text: "identical" } }] };
  const contextOnly: BufferTurn = { ...makeTurn("identical"), extractionContextOnly: true };
  assert.ok(bufferTurnsEqual(plain, withParts), "precondition: bufferTurnsEqual ignores parts");
  registry.admit("k", [plain]);
  registry.admit("k", [withParts]);
  registry.admit("k", [contextOnly]);
  const stats = registry.stats();
  assert.equal(stats.queuedNodes, 3, "each differing-representation turn starts its own chain");
  assert.equal(stats.queuedTailRefs, 3, "nothing shared across representation-inequivalent turns");
  // The representation check is strictly stronger than bufferTurnsEqual.
  assert.ok(!turnRepresentationEquivalent(plain, withParts));
  assert.ok(!turnRepresentationEquivalent(plain, contextOnly));
});

test("continuous enqueue/dequeue cycles: released ancestors erode, retention returns to zero", async () => {
  // Codex P2 reproduction attempt: under continuous single-key
  // enqueue/dequeue, completed ("released") ancestors stay reachable via
  // `base` while any descendant is queued. Their content is the descendant's
  // own window prefix (verified element-wise at admit), so retention is the
  // union of the still-owed windows — and when every task has exited, the
  // registry must return to exactly zero with no historical remainder.
  const registry = new ExtractionSnapshotSharingRegistry();
  const cycles = 500;
  const live: { node: SnapshotChain }[] = [];
  let peakQueuedTotalRefs = 0;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const turns: BufferTurn[] = [];
    for (let offset = 1; offset <= cycle; offset += 1) turns.push(makeTurn(`cycle ${offset}`));
    live.push({ node: registry.admit("k", turns) });
    // Interleaved drain: the oldest live task exits before the next admit,
    // exactly the continuous enqueue/dequeue shape.
    if (live.length > 2) {
      const oldest = live.shift();
      assert.ok(oldest, "oldest live entry present");
      registry.release(oldest.node);
    }
    const stats = registry.stats();
    if (stats.queuedTotalRefs > peakQueuedTotalRefs) peakQueuedTotalRefs = stats.queuedTotalRefs;
  }
  // Drain everything.
  for (const entry of live) registry.release(entry.node);
  const final = registry.stats();
  assert.equal(final.queuedNodes, 0, "no historical nodes survive full drain");
  assert.equal(final.queuedTailRefs, 0, "no historical reference slots survive");
  assert.equal(final.queuedTotalRefs, 0, "no historical total survives");
  assert.ok(peakQueuedTotalRefs > 0, "peak was observed");
});

test("single unchanged turn, one outstanding: reachable chain depth stays bounded", async () => {
  // Exact Codex P2 shape: 10,000 cycles of one-unchanged-turn admissions
  // with exactly one outstanding node (admit, then release the previous).
  // Every admission against an equivalent base creates a tail=[] node
  // chained onto the previous one: reachable depth grew to 10,000 while
  // stats reported nodes=1 / tailRefs=0.
  const registry = new ExtractionSnapshotSharingRegistry();
  const cycles = 10_000;
  const turn: BufferTurn = makeTurn("unchanged");
  let previous: SnapshotChain | undefined;
  let maxReachableDepth = 0;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const node = registry.admit("k", [turn]);
    if (previous) registry.release(previous);
    previous = node;
    let depth = 0;
    for (let walk: SnapshotChain | undefined = node; walk; walk = walk.base) depth += 1;
    if (depth > maxReachableDepth) maxReachableDepth = depth;
  }
  assert.equal(maxReachableDepth, 1, "identical windows reuse the same chain node: depth stays 1");
  const stats = registry.stats();
  // The final release may or may not remove the shared node depending on
  // which sharer exited last; either way at most one bounded node remains.
  assert.ok(stats.queuedNodes <= 1, "at most one bounded node remains");
  assert.ok(stats.queuedTailRefs <= 1, "truthful distinct reference count");
  assert.ok(stats.queuedTotalRefs <= 1, "truthful total");
  assert.ok(stats.queuedReachableDepth <= 1, "truthful reachable depth");
});

test("overlapping identical tasks keep the shared node until the last holder releases", async () => {
  // Main follow-up to the Codex P2 fix: node reuse must keep registry
  // accounting truthful while ANY sharer is still outstanding — the first
  // completion may not drop the only bucket entry, and later identical
  // admissions must keep aliasing onto the shared node.
  const registry = new ExtractionSnapshotSharingRegistry();
  const turn: BufferTurn = makeTurn("shared window");
  const a = registry.admit("k", [turn]);
  const b = registry.admit("k", [turn]);
  const c = registry.admit("k", [turn]);
  assert.ok(a === b && b === c, "three overlapping identical tasks share one node");
  assert.equal(registry.stats().queuedNodes, 1);
  registry.release(a);
  // RED on current code: the first release must not empty the registry while
  // b and c still hold the node.
  let stats = registry.stats();
  assert.equal(stats.queuedNodes, 1, "shared node survives until the last holder releases");
  assert.equal(stats.queuedTailRefs, 1, "content still counted while sharers remain");
  assert.equal(stats.queuedHolders, 2, "per-task holder count tracks outstanding sharers");
  assert.equal(stats.unsharedEquivalentRefs, 2, "unshared equivalent: 2 tasks x 1-turn chain");
  assert.equal(stats.queuedReachableDepth, 1);
  const d = registry.admit("k", [turn]);
  assert.equal(d, b, "later identical admission keeps aliasing onto the shared node");
  registry.release(b);
  stats = registry.stats();
  assert.equal(stats.queuedNodes, 1, "c and d still hold the shared node");
  registry.release(c);
  registry.release(d);
  stats = registry.stats();
  assert.equal(stats.queuedNodes, 0, "registry empties when the last holder releases");
  assert.equal(stats.queuedTailRefs, 0);
  assert.equal(stats.queuedTotalRefs, 0);
  assert.equal(stats.queuedHolders, 0);
  assert.equal(stats.unsharedEquivalentRefs, 0);
  assert.equal(stats.queuedReachableDepth, 0);
});

test("refusal path releases exactly once: registry stays balanced for later work", async () => {
  const h = makeHarness();
  h.queue.stopAccepting();
  await h.coordinator.queueBufferedExtraction([makeTurn("refused")], "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
  });
  // The refusal branch releases the node before any closure existed; the
  // accounting must be back to zero with no phantom holder, or the next
  // admission cycle would drift.
  assert.deepEqual(h.coordinator.snapshotSharing.stats(), {
    queuedNodes: 0,
    queuedTotalRefs: 0,
    queuedTailRefs: 0,
    queuedReachableDepth: 0,
    queuedHolders: 0,
    unsharedEquivalentRefs: 0,
  });
  h.queue.resumeAccepting();
  await h.coordinator.queueBufferedExtraction([makeTurn("after refusal")], "trigger_mode", {
    bufferKey: "k",
    preemptable: true,
  });
  const stats = h.coordinator.snapshotSharing.stats();
  assert.equal(stats.queuedNodes, 1, "post-refusal admission registers normally");
  assert.equal(stats.queuedHolders, 1);
  await h.release();
  assert.equal(h.coordinator.snapshotSharing.stats().queuedHolders, 0);
});

test("stats report per-task holders and unshared equivalent separately from nodes", async () => {
  const registry = new ExtractionSnapshotSharingRegistry();
  const turns: BufferTurn[] = [makeTurn("a"), makeTurn("b")];
  registry.admit("k", turns);
  registry.admit("k", turns);
  registry.admit("k", turns);
  const stats = registry.stats();
  assert.equal(stats.queuedNodes, 1, "one distinct chain");
  assert.equal(stats.queuedHolders, 3, "three outstanding tasks");
  assert.equal(stats.queuedTotalRefs, 2, "chain content slots");
  assert.equal(stats.unsharedEquivalentRefs, 6, "3 tasks x 2-turn chain without sharing");
});

test("released ancestors reachable via base are counted exactly once", async () => {
  // Main stats-defect shape: admit [a], admit [a,b], release the first node.
  // The first node is out of the bucket but still reachable through the
  // second node's base, so both turn references are retained while only one
  // direct tail remains — bucket-node sums under-reported this (tailRefs=1).
  const registry = new ExtractionSnapshotSharingRegistry();
  const a = registry.admit("k", [makeTurn("a")]);
  const b = registry.admit("k", [makeTurn("a"), makeTurn("b")]);
  registry.release(a);
  const stats = registry.stats();
  assert.equal(stats.queuedNodes, 1, "one registered node");
  assert.equal(stats.queuedTailRefs, 2, "both reachable turn references counted");
  assert.equal(stats.queuedReachableDepth, 2, "released ancestor still reachable via base");
  assert.equal(stats.queuedHolders, 1, "one outstanding task");
  assert.equal(stats.unsharedEquivalentRefs, 2, "1 task x 2-turn window");
  assert.equal(stats.queuedTotalRefs, 2, "per-node window basis");
  // Sibling nodes sharing a base chain: shared ancestors count once in the
  // reachable tail set but once per node in the per-task window basis.
  const c = registry.admit("k", [makeTurn("a"), makeTurn("b"), makeTurn("c")]);
  assert.equal(c.base, b, "chains onto the queued sibling");
  const siblingStats = registry.stats();
  assert.equal(siblingStats.queuedTailRefs, 3, "shared ancestors counted once");
  assert.equal(siblingStats.unsharedEquivalentRefs, 5, "2 + 3 per-task windows");
  registry.release(b);
  registry.release(c);
  assert.equal(registry.stats().queuedTailRefs, 0, "all reachable slots released with the chain");
});

test("10,000-deep queued chain materializes without stack overflow", async () => {
  const registry = new ExtractionSnapshotSharingRegistry();
  const depth = 10_000;
  let last: ReturnType<ExtractionSnapshotSharingRegistry["admit"]> | undefined;
  // One shared array grown in place mirrors the real pump: every trigger
  // hands out a full prefix snapshot of the same buffer.
  const turns: BufferTurn[] = [];
  for (let index = 1; index <= depth; index += 1) {
    turns.push(makeTurn(`deep ${index}`));
    last = registry.admit("k", turns);
  }
  const stats = registry.stats();
  assert.equal(stats.queuedNodes, depth, "one node per trigger");
  assert.equal(stats.queuedTailRefs, depth, "shared suffix refs equal the union");
  assert.ok(last, "deepest node recorded");
  const materialized = materializeChain(last);
  assert.equal(materialized.length, depth);
  assert.equal(materialized[0]?.content, "deep 1");
  assert.equal(materialized[depth - 1]?.content, `deep ${depth}`);
  turns.push(makeTurn(`deep ${depth + 1}`));
  assert.ok(last && chainPrefixEquivalent(last, turns), "prefix equivalence at depth");
});
