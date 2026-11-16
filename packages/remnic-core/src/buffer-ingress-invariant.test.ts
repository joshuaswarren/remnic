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
 * Issue #3444: every turn offered to the SmartBuffer add path is counted
 * exactly once across the four outcomes — accepted + deduplicated + filtered
 * + refused must equal turns offered, in turns and in characters.
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

test("mixed batch: accepted + deduplicated + filtered + refused equals turns offered (turns and chars)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-mixed-"));
  try {
    const buffer = new SmartBuffer(makeConfig(memoryDir), new FakeStorage());
    const snap = () => buffer.ingress.snapshot();
    let offered = 0;
    let offeredChars = 0;
    const offer = (turns: readonly BufferTurn[]) => {
      offered += turns.length;
      offeredChars += charsOf(turns);
    };

    // Batch 1 (addTurnsBounded, multi-session): uniques, in-batch duplicates,
    // empty and whitespace-only turns.
    const batchA = [
      turn("alpha memory"),
      turn("alpha memory"), // duplicate within the offer
      turn(""), // filtered: empty
      turn("   \n\t "), // filtered: whitespace-only
    ];
    const batchB = [turn("beta memory", { sessionKey: "kB", timestamp: "2026-11-15T12:00:01.000Z" })];
    const batchC = [
      // same role+content as batchB's turn, different session: still a
      // duplicate offered to the buffer (already seen within this offer).
      turn("beta memory", { sessionKey: "kC", timestamp: "2026-11-15T12:00:02.000Z" }),
    ];
    offer([...batchA, ...batchB, ...batchC]);
    const outcomes = await buffer.addTurnsBounded([
      { bufferKey: "kA", turns: batchA },
      { bufferKey: "kB", turns: batchB },
      { bufferKey: "kC", turns: batchC },
    ]);
    assert.ok(outcomes, "batch capacity-admitted");
    assert.equal(outcomes.length, 6, "every offered turn yields an outcome entry");
    assert.ok(outcomes.every((o) => o.decision === "keep_buffering"), "no offered turn triggers extraction here");

    // Sequential adds: exact re-offer of a buffered turn (identity duplicate,
    // byte-identical turn value) and a fresh turn.
    const replayed = turn("alpha memory");
    const fresh = turn("gamma memory");
    offer([replayed, fresh]);
    await buffer.addTurn("kA", replayed);
    await buffer.addTurn("kA", fresh);

    // Retained turns count as "already observed": clear live turns, keep u2
    // in the retention window, re-offer it.
    await buffer.retainDeferredTurns("kA", [fresh], 10);
    await buffer.clearAfterExtraction("kA");
    const reoffer = turn("gamma memory");
    offer([reoffer]);
    await buffer.addTurn("kA", reoffer);

    let s = snap();
    assert.deepEqual(s.totals.accepted, { turns: 3, chars: charsOf([turn("alpha memory"), turn("beta memory"), turn("gamma memory")]) });
    assert.deepEqual(s.totals.deduplicated, { turns: 3, chars: charsOf([turn("alpha memory"), turn("beta memory"), turn("gamma memory")]) });
    assert.deepEqual(s.totals.filtered, { turns: 2, chars: 0 });
    assert.deepEqual(s.totals.refused, { turns: 0, chars: 0 });
    assert.equal(s.totals.accepted.turns + s.totals.deduplicated.turns + s.totals.filtered.turns + s.totals.refused.turns, offered);
    assert.equal(
      s.totals.accepted.chars + s.totals.deduplicated.chars + s.totals.filtered.chars + s.totals.refused.chars,
      offeredChars,
    );

    // Refusal: per-session turn cap (6) — a 7-turn batch is refused whole.
    const overCap = [0, 1, 2, 3, 4, 5, 6].map((i) => turn(`over ${i}`, { sessionKey: "kF" }));
    offer(overCap);
    assert.equal(await buffer.addTurnsBounded([{ bufferKey: "kF", turns: overCap }]), null);
    assert.deepEqual(snap().totals.refused, { turns: 7, chars: charsOf(overCap) });

    // Refusal: session-entry cap — accepted-capture entries are pinned, so a
    // new live session beyond the cap is refused (live-admission bound).
    const pinnedConfig = makeConfig(memoryDir, { bufferMaxSessions: 2 });
    const pinnedBuffer = new SmartBuffer(pinnedConfig, new FakeStorage());
    for (const key of ["p1", "p2"]) {
      const pinnedOffer = [turn("pin", { sessionKey: key, acceptedCapture: true })];
      await pinnedBuffer.addTurnsBounded([{ bufferKey: key, turns: pinnedOffer }]);
    }
    const refusedTurn = turn("beyond the entry cap");
    offer([refusedTurn]);
    await assert.rejects(
      () => pinnedBuffer.addTurn("p3", refusedTurn),
      /session-entry cap/,
    );
    assert.deepEqual(pinnedBuffer.ingress.snapshot().totals.refused, { turns: 1, chars: refusedTurn.content.length });

    // The invariant holds on the pinned buffer too.
    const p = pinnedBuffer.ingress.snapshot().totals;
    const pOffered = 2 + 1; // two pinned accepts + one refused
    assert.equal(p.accepted.turns + p.deduplicated.turns + p.filtered.turns + p.refused.turns, pOffered);

    s = snap();
    assert.equal(s.totals.accepted.turns + s.totals.deduplicated.turns + s.totals.filtered.turns + s.totals.refused.turns, offered);
    assert.equal(
      s.totals.accepted.chars + s.totals.deduplicated.chars + s.totals.filtered.chars + s.totals.refused.chars,
      offeredChars,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("replay (buffered observe capture) offers are counted exactly once", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-replay-"));
  try {
    const config = makeConfig(memoryDir);
    const buffer = new SmartBuffer(config, new FakeStorage());
    const coordinator = new TurnIngestionCoordinator({
      buffer,
      config,
      queueBufferedExtraction: async () => {},
    } as never);

    const replayTurn = (sessionKey: string, content: string, timestamp: string): ReplayTurn => ({
      source: "openclaw",
      sessionKey,
      role: "user",
      content,
      timestamp,
    });
    const turns: ReplayTurn[] = [
      replayTurn("s1", "replay unique one", "2026-11-15T13:00:00.000Z"),
      replayTurn("s1", "replay unique one", "2026-11-15T13:00:05.000Z"), // content duplicate
      replayTurn("s2", "replay unique two", "2026-11-15T13:00:01.000Z"),
      replayTurn("s2", "replay unique two", "2026-11-15T13:00:01.000Z"), // identity duplicate
    ];
    await coordinator.ingestReplayBatch(turns, { archiveLcm: false, extractionMode: "buffered" });

    const s = buffer.ingress.snapshot().totals;
    assert.deepEqual(s.accepted, { turns: 2, chars: "replay unique one".length + "replay unique two".length });
    assert.deepEqual(s.deduplicated, { turns: 2, chars: 2 * "replay unique one".length });
    assert.deepEqual(s.filtered, { turns: 0, chars: 0 });
    assert.deepEqual(s.refused, { turns: 0, chars: 0 });
    assert.equal(s.accepted.turns + s.deduplicated.turns + s.filtered.turns + s.refused.turns, turns.length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("filtering does not create phantom buffer entries for empty offers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ingress-empty-"));
  try {
    const buffer = new SmartBuffer(makeConfig(memoryDir), new FakeStorage());
    await buffer.addTurn("brand-new-key", turn("   "));
    const snapshot = await buffer.getBufferSnapshot();
    assert.equal(snapshot.bufferedSessionCount, 0, "no entry is created for a filtered offer");
    assert.deepEqual(buffer.ingress.snapshot().totals.filtered, { turns: 1, chars: 3 });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
