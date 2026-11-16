import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { TurnIngestionCoordinator } from "./orchestration/turn-ingestion.js";
import { parseConfig } from "./config.js";
import type { BufferState, BufferTurn, PluginConfig } from "./types.js";
import type { ReplayTurn } from "./replay/types.js";

/**
 * Issue #3444, observation-only contract: the counters change NOTHING the
 * buffer does. Two guarantees are pinned here:
 *
 * 1. Partition: accepted + filtered + refused == turns offered (in turns and
 *    in characters). The SmartBuffer add path drops nothing, so `filtered`
 *    is always 0 at this layer; upstream filters (captureMode=explicit
 *    skips in processTurn/ingestReplayBatch; the observe funnel's
 *    empty-content guard and fingerprint dedup) live outside this boundary.
 * 2. Differential: the exact same mixed sequence of offers run against a
 *    counters-enabled buffer and a counters-disabled control produces
 *    identical buffer state, identical mutation results and identical
 *    refusal errors.
 *
 * `acceptedExactDuplicate` is a sub-count of accepted (appended AND counted),
 * giving #3443 the true duplicate rate at ingress.
 */

class FakeStorage {
  public saved: BufferState | null = null;
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.saved ?? { turns: [], lastExtractionAt: null, extractionCount: 0 });
  }
  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }
}

function makeConfig(memoryDir: string, overrides: Record<string, unknown> = {}): PluginConfig {
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
  /** Whole persisted buffer state after the sequence. */
  saved: BufferState | null;
  /** Live turns per buffer key, in order. */
  turns: Record<string, string[]>;
  /** Trigger decisions per addTurnsBounded outcome entry. */
  decisions: string[];
  /** Per-key turn counts reported by each batch outcome entry. */
  batchCounts: number[];
  /** Names of refusal errors thrown, in order. */
  refusalErrors: string[];
  /** addTurnsBounded null (refused) returns, in order. */
  batchNulls: boolean[];
}

async function runMixedSequence(memoryDir: string, countIngress: boolean): Promise<RunTrace> {
  const storage = new FakeStorage();
  const buffer = new SmartBuffer(makeConfig(memoryDir), storage, null, { countIngress });
  const trace: RunTrace = { saved: null, turns: {}, decisions: [], batchCounts: [], refusalErrors: [], batchNulls: [] };

  // Multi-session batch: uniques, exact in-batch duplicate, empty, whitespace.
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

  // Sequential adds: exact re-offer of a buffered turn, then a fresh one.
  await buffer.addTurn("kA", turn("alpha memory"));
  await buffer.addTurn("kA", turn("gamma memory"));

  // Retained-turn re-offer: still appended (observation only).
  await buffer.retainDeferredTurns("kA", [turn("gamma memory")], 10);
  await buffer.clearAfterExtraction("kA");
  await buffer.addTurn("kA", turn("gamma memory"));

  // Refusal: per-session turn cap — a 7-turn batch is refused whole.
  const overCap = [0, 1, 2, 3, 4, 5, 6].map((i) => turn(`over ${i}`, { sessionKey: "kF" }));
  trace.batchNulls.push((await buffer.addTurnsBounded([{ bufferKey: "kF", turns: overCap }])) === null);

  // Refusal: session-entry cap — accepted-capture entries are pinned, so a
  // new live session beyond the cap throws (the implicit "default" entry is
  // protected too, hence cap 3 for 2 pins).
  const pinnedBuffer = new SmartBuffer(makeConfig(memoryDir, { bufferMaxSessions: 3 }), new FakeStorage(), null, { countIngress });
  for (const key of ["p1", "p2"]) {
    await pinnedBuffer.addTurnsBounded([{ bufferKey: key, turns: [turn("pin", { sessionKey: key, acceptedCapture: true })] }]);
  }
  try {
    await pinnedBuffer.addTurn("p3", turn("beyond the entry cap"));
  } catch (error) {
    trace.refusalErrors.push(`${(error as Error).name}: ${(error as Error).message}`);
  }

  // Buffered replay: identity duplicate and content duplicate are appended.
  const coordinator = new TurnIngestionCoordinator({
    buffer,
    config: makeConfig(memoryDir),
    queueBufferedExtraction: async () => {},
  } as never);
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

  // Normalize wall-clock stamps the buffer itself writes (lastExtractionAt)
  // so the two runs differ only where counters could possibly matter.
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
    // Appended duplicates really are in the buffer (observation, not skip):
    // kC holds the batch's cross-session beta duplicate, kA was cleared by the
    // extraction clear and holds only the re-appended retained content, and
    // both replay duplicates were appended.
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
    // filtered is structurally 0 here: the add path drops nothing.
    assert.deepEqual(s.totals.filtered, { turns: 0, chars: 0 });
    // accepted: 6 appended (alpha, alpha-dup, "", ws, beta, then replayed+fresh = 7).
    assert.deepEqual(s.totals.accepted, { turns: 7, chars: charsOf([...batchA, ...batchB, replayed, fresh]) });
    // exact duplicates: in-batch alpha, re-offered alpha — still appended.
    assert.deepEqual(s.totals.acceptedExactDuplicate, { turns: 2, chars: 2 * charsOf([turn("alpha memory")]) });
    assert.ok(s.totals.acceptedExactDuplicate.turns <= s.totals.accepted.turns);
    assert.equal(s.totals.accepted.turns + s.totals.filtered.turns + s.totals.refused.turns, offered);
    assert.equal(
      s.totals.accepted.chars + s.totals.filtered.chars + s.totals.refused.chars,
      offeredChars,
    );

    // Refusals enter the partition: per-session cap refuses a whole 7-turn batch.
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
    // No-save storage: this test only observes counting, not persistence.
    const storage = { loadBuffer: async () => ({ turns: [], lastExtractionAt: null, extractionCount: 0 }), saveBuffer: async () => {} };
    const buffer = new SmartBuffer(makeConfig(memoryDir, { bufferMaxTurnsPerSession: 10_000 }), storage as never);
    const unique = (i: number) => turn(`unique-${i}`);
    // Fill the digest set to its 4,096 cap.
    for (let i = 0; i < 4_096; i += 1) await buffer.addTurn("kA", unique(i));
    // A new unique content FIFO-evicts the oldest digest…
    await buffer.addTurn("kA", turn("brand-new"));
    // …so re-offering the very first content is no longer recognized, while
    // the still-tracked recent one is — an under-count, never a behavior change.
    await buffer.addTurn("kA", unique(0));
    await buffer.addTurn("kA", turn("brand-new"));
    const s = buffer.ingress.snapshot().totals;
    assert.equal(s.accepted.turns, 4_099);
    assert.deepEqual(s.acceptedExactDuplicate, { turns: 1, chars: turn("brand-new").content.length });
    // All offered turns were appended: nothing was dropped.
    assert.equal((await buffer.getTurns("kA")).length, 4_099);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
