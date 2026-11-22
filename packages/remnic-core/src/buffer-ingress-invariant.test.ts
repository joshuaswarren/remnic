import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { SessionObserverState } from "./session-observer-state.js";
import { TranscriptManager } from "./transcript.js";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./orchestration/turn-ingestion.js";
import { parseConfig } from "./config.js";
import type { BufferState, BufferTurn, PluginConfig } from "./types.js";
import type { ReplayTurn } from "./replay/types.js";


class FakeStorage {
  public saved: BufferState | null = null;
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.saved ?? { turns: [], lastExtractionAt: null, extractionCount: 0 });
  }
  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }
}

function makeConfig(memoryDir: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return parseConfig({
    memoryDir,
    bufferSaveDebounceMs: 0,
    bufferMaxSessions: 8,
    bufferMaxTurnsPerSession: 6,
    ...overrides,
  });
}

function turn(content: string, overrides: Partial<BufferTurn> = {}): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-11-15T12:00:00.000Z",
    sessionKey: "kA",
    ...overrides,
  };
}

function charsOf(turns: readonly BufferTurn[]): number {
  return turns.reduce((sum, t) => sum + t.content.length, 0);
}

interface RunTrace {
  saved: BufferState | null;
  turns: Record<string, string[]>;
  decisions: string[];
  batchCounts: number[];
  refusalErrors: string[];
  batchNulls: boolean[];
}

async function runMixedSequence(memoryDir: string, countIngress: boolean): Promise<RunTrace> {
  const storage = new FakeStorage();
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress });
  const trace: RunTrace = { saved: null, turns: {}, decisions: [], batchCounts: [], refusalErrors: [], batchNulls: [] };

  const batchA = [turn("alpha memory"), turn("alpha memory"), turn(""), turn("   \n\t ")];
  const batchB = [turn("beta memory", { sessionKey: "kB", timestamp: "2026-11-15T12:00:01.000Z" })];
  const batchC = [turn("beta memory", { sessionKey: "kC", timestamp: "2026-11-15T12:00:02.000Z" })];
  const outcomes = await buffer.addTurnsBounded([
    { bufferKey: "kA", turns: batchA },
    { bufferKey: "kB", turns: batchB },
    { bufferKey: "kC", turns: batchC },
  ]);
  assert.ok(outcomes);
  trace.decisions.push(...outcomes.map((o) => o.outcome.decision));
  trace.batchCounts.push(...outcomes.map((o) => o.outcome.extractionTurns?.length ?? -1));

  await buffer.addTurn("kA", turn("alpha memory"));
  await buffer.addTurn("kA", turn("gamma memory"));

  await buffer.retainDeferredTurns("kA", [turn("gamma memory")], 10);
  await buffer.clearAfterExtraction("kA");
  await buffer.addTurn("kA", turn("gamma memory"));

  const overCap = [0, 1, 2, 3, 4, 5, 6].map((i) => turn(`over ${i}`, { sessionKey: "kF" }));
  trace.batchNulls.push((await buffer.addTurnsBounded([{ bufferKey: "kF", turns: overCap }])) === null);

  const pinnedBuffer = new SmartBuffer(makeConfig(memoryDir, { bufferMaxSessions: 3 }), new FakeStorage(), null, { countIngress });
  for (const key of ["p1", "p2"]) {
    await pinnedBuffer.addTurnsBounded([{ bufferKey: key, turns: [turn("pin", { sessionKey: key, acceptedCapture: true })] }]);
  }
  try {
    await pinnedBuffer.addTurn("p3", turn("beyond the entry cap"));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    trace.refusalErrors.push(`${error.name}: ${error.message}`);
  }

  const unreachable = (name: string): never => {
    throw new Error(`TurnIngestionDeps.${name} is unreachable in the replay-capacity fixture`);
  };
  const deps: TurnIngestionDeps = {
    buffer,
    config: makeConfig(memoryDir),
    bulkImportWriteNamespace: () => unreachable("bulkImportWriteNamespace"),
    extractionQueueCoordinator: new ExtractionQueueCoordinator(1),
    getStorage: async () => unreachable("getStorage"),
    heartbeatObserverChains: new Map(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set(),
    passiveCorrectionService: () => unreachable("passiveCorrectionService"),
    passiveCorrectionTelemetry: { detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {} },
    queueBufferedExtraction: async () => {},
    resolveMemoryIdOrHandle: (ref: string) => ref,
    runExtraction: () => unreachable("runExtraction"),
    sessionObserver: new SessionObserverState({ memoryDir, debounceMs: 0, bands: [] }),
    shouldQueueExtraction: () => false,
    transcript: new TranscriptManager(makeConfig(memoryDir)),
  };
  const coordinator = new TurnIngestionCoordinator(deps);
  const replay = (sessionKey: string, content: string, timestamp: string): ReplayTurn => ({
    source: "openclaw",
    sessionKey,
    role: "user",
    content,
    timestamp,
  });
  await coordinator.ingestReplayBatch(
    [
      replay("s1", "replay unique one", "2026-11-15T13:00:00.000Z"),
      replay("s1", "replay unique one", "2026-11-15T13:00:05.000Z"),
      replay("s2", "replay unique two", "2026-11-15T13:00:01.000Z"),
      replay("s2", "replay unique two", "2026-11-15T13:00:01.000Z"),
    ],
    { archiveLcm: false, extractionMode: "buffered" },
  );

  if (storage.saved) {
    storage.saved.lastExtractionAt = null;
    for (const entry of Object.values(storage.saved.entries ?? {})) entry.lastExtractionAt = null;
  }
  trace.saved = storage.saved;
  for (const key of ["kA", "kB", "kC", "s1", "s2"]) {
    trace.turns[key] = (await buffer.getTurns(key)).map((t) => `${t.role}:${t.timestamp}:${t.content}`);
  }
  return trace;
}

test("differential: counters on vs off — identical state, results and refusals", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-diff-"));
  try {
    const enabled = await runMixedSequence(memoryDir, true);
    const control = await runMixedSequence(memoryDir, false);
    assert.deepEqual(enabled, control, "counters must not change any buffer behavior");
    assert.equal(enabled.refusalErrors.length, 1, "the entry-cap refusal still refuses");
    assert.match(enabled.refusalErrors[0], /session-entry cap/);
    assert.ok(enabled.batchNulls.every((isNull) => isNull), "the over-cap batch is still refused whole");
    assert.deepEqual(enabled.turns.kC.length, 1);
    assert.ok(enabled.turns.kC[0].endsWith("beta memory"));
    assert.deepEqual(enabled.turns.kA, [
      "user:2026-11-15T12:00:00.000Z:gamma memory", // retained copy
      "user:2026-11-15T12:00:00.000Z:gamma memory", // re-appended offer
    ]);
    assert.equal(enabled.turns.s1.length, 2, "replay content duplicate is appended");
    assert.equal(enabled.turns.s2.length, 2, "replay identity duplicate is appended");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("partition: accepted + filtered + refused equals turns offered; duplicates are a sub-count", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-partition-"));
  try {
    const buffer = new SmartBuffer(makeConfig(memoryDir), new FakeStorage());
    const snap = () => buffer.ingress.snapshot();
    let offered = 0;
    let offeredChars = 0;
    const offer = (turns: readonly BufferTurn[]) => {
      offered += turns.length;
      offeredChars += charsOf(turns);
    };

    const batchA = [turn("alpha memory"), turn("alpha memory"), turn(""), turn("   \n\t ")];
    const batchB = [turn("beta memory", { sessionKey: "kB", timestamp: "2026-11-15T12:00:01.000Z" })];
    offer([...batchA, ...batchB]);
    await buffer.addTurnsBounded([
      { bufferKey: "kA", turns: batchA },
      { bufferKey: "kB", turns: batchB },
    ]);
    const replayed = turn("alpha memory");
    const fresh = turn("gamma memory");
    offer([replayed, fresh]);
    await buffer.addTurn("kA", replayed);
    await buffer.addTurn("kA", fresh);

    let s = snap();
    assert.deepEqual(s.totals.filtered, { turns: 0, chars: 0 });
    assert.deepEqual(s.totals.accepted, { turns: 7, chars: charsOf([...batchA, ...batchB, replayed, fresh]) });
    assert.deepEqual(s.totals.acceptedExactDuplicate, { turns: 2, chars: 2 * charsOf([turn("alpha memory")]) });
    assert.ok(s.totals.acceptedExactDuplicate.turns <= s.totals.accepted.turns);
    assert.equal(s.totals.accepted.turns + s.totals.filtered.turns + s.totals.refused.turns, offered);
    assert.equal(
      s.totals.accepted.chars + s.totals.filtered.chars + s.totals.refused.chars,
      offeredChars,
    );

    const overCap = [0, 1, 2, 3, 4, 5, 6].map((i) => turn(`over ${i}`, { sessionKey: "kF" }));
    offer(overCap);
    assert.equal(await buffer.addTurnsBounded([{ bufferKey: "kF", turns: overCap }]), null);
    s = snap();
    assert.deepEqual(s.totals.refused, { turns: 7, chars: charsOf(overCap) });
    assert.equal(s.totals.accepted.turns + s.totals.filtered.turns + s.totals.refused.turns, offered);
    assert.equal(
      s.totals.accepted.chars + s.totals.filtered.chars + s.totals.refused.chars,
      offeredChars,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("duplicate digests are memory-bounded (FIFO cap) and never retain content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-cap-"));
  try {
    const buffer = new SmartBuffer(makeConfig(memoryDir, { bufferMaxTurnsPerSession: 10_000 }), new FakeStorage());
    const unique = (i: number) => turn(`unique-${i}`);
    for (let i = 0; i < 4_096; i += 1) await buffer.addTurn("kA", unique(i));
    await buffer.addTurn("kA", turn("brand-new"));
    await buffer.addTurn("kA", unique(0));
    await buffer.addTurn("kA", turn("brand-new"));
    const s = buffer.ingress.snapshot().totals;
    assert.equal(s.accepted.turns, 4_099);
    assert.deepEqual(s.acceptedExactDuplicate, { turns: 1, chars: turn("brand-new").content.length });
    assert.equal((await buffer.getTurns("kA")).length, 4_099);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
