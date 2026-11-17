import assert from "node:assert/strict";
import test from "node:test";

import {
  BufferIngressCounters,
  type BufferIngressSnapshot,
  EMPTY_BUFFER_INGRESS_SNAPSHOT,
} from "./buffer-ingress-counters.js";
import { initLogger, resetLogger } from "./logger.js";
import type { BufferEntryState, BufferTurn } from "./types.js";

const HOUR_MS = 3_600_000;

function captureInfo() {
  // SAFETY: implements LoggerBackend for log capture; error is a no-op because these tests never log errors.
  const lines: string[] = [];
  initLogger({
    info: (msg: string) => lines.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
  });
  return { lines, restore: resetLogger };
}

function fakeEntry(turns: BufferTurn[] = []): BufferEntryState {
  return { turns, lastExtractionAt: null, extractionCount: 0 };
}

function turn(content: string): BufferTurn {
  return { role: "user", content, timestamp: "2026-04-12T12:00:00.000Z", sessionKey: "kA" };
}

test("aggregates accepted, its exact-duplicate sub-count and refusals in turns and chars", () => {
  const counters = new BufferIngressCounters();
  const entry = fakeEntry();
  counters.noteAppendedTurn(entry, turn("alpha memory"));
  counters.noteAppendedTurn(entry, turn("beta memory"));
  counters.noteAppendedTurn(entry, turn("alpha memory")); // exact duplicate, still appended
  counters.refuseOne(turn("refused offer"));

  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.totals.accepted, { turns: 3, chars: 35 });
  assert.deepEqual(snapshot.totals.acceptedExactDuplicate, { turns: 1, chars: 12 });
  assert.deepEqual(snapshot.totals.filtered, { turns: 0, chars: 0 });
  assert.deepEqual(snapshot.totals.refused, { turns: 1, chars: 13 });
});

test("refuseThrow counts and returns the original error; refuseAll counts every turn", () => {
  const counters = new BufferIngressCounters();
  const original = new Error("cap");
  const returned = counters.refuseThrow(turn("x"), original);
  assert.equal(returned, original);
  const batch = [turn("a"), turn("bb")];
  assert.equal(counters.refuseAll(batch.map((t) => ({ turn: t }))), null);
  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.totals.refused, { turns: 3, chars: 1 + 1 + 2 });
});

test("the duplicate digest set follows the entry's turns (self-invalidating memo)", () => {
  const counters = new BufferIngressCounters();
  const entry = fakeEntry([turn("seeded")]);
  counters.noteAppendedTurn(entry, turn("seeded")); // matches the seeded turn
  assert.equal(counters.snapshot().totals.acceptedExactDuplicate.turns, 1);
  // A drain reassigns the array: the old content is no longer tracked.
  entry.turns = [turn("fresh")];
  counters.noteAppendedTurn(entry, turn("seeded"));
  assert.equal(counters.snapshot().totals.acceptedExactDuplicate.turns, 1);
  // Retained turns participate too.
  entry.turns = [];
  entry.retainedTurns = [turn("kept")];
  counters.noteAppendedTurn(entry, turn("kept"));
  assert.equal(counters.snapshot().totals.acceptedExactDuplicate.turns, 2);
});

test("counters-disabled control records nothing (differential seam)", () => {
  const counters = new BufferIngressCounters(undefined, false);
  const entry = fakeEntry();
  counters.noteAppendedTurn(entry, turn("anything"));
  assert.equal(counters.refuseOne(turn("anything")), null);
  assert.deepEqual(counters.snapshot(), EMPTY_BUFFER_INGRESS_SNAPSHOT);
});

test("snapshot drops hour buckets older than 24h while totals stay cumulative", () => {
  let t = Date.parse("2026-04-12T12:00:00.000Z");
  const counters = new BufferIngressCounters(() => t);
  const entry = fakeEntry();
  counters.noteAppendedTurn(entry, turn("old"));
  assert.equal(counters.snapshot().hours.length, 1);
  t += 30 * HOUR_MS; // 30 h later
  counters.noteAppendedTurn(entry, turn("new"));
  const snapshot = counters.snapshot();
  assert.equal(snapshot.hours.length, 1);
  assert.equal(snapshot.hours[0].accepted.turns, 1);
  assert.equal(snapshot.totals.accepted.turns, 2);
});

test("snapshot is a fresh read-only structure and never aliases internals", () => {
  const counters = new BufferIngressCounters();
  const entry = fakeEntry();
  counters.noteAppendedTurn(entry, turn("note"));
  const first = counters.snapshot();
  first.totals.accepted.turns = 99;
  first.hours.push({
    hourStart: "tampered",
    accepted: { turns: 0, chars: 0 },
    acceptedExactDuplicate: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  });
  const second = counters.snapshot();
  assert.equal(second.totals.accepted.turns, 1);
  assert.equal(second.hours.length, 1);
});

test("hourly ring rolls with an injected clock and keeps the last 24 hours", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const entry = fakeEntry();

  counters.noteAppendedTurn(entry, turn("a"));
  const hourZero = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  assert.deepEqual(counters.snapshot().hours, [
    {
      hourStart: new Date(hourZero).toISOString(),
      accepted: { turns: 1, chars: 1 },
      acceptedExactDuplicate: { turns: 0, chars: 0 },
      filtered: { turns: 0, chars: 0 },
      refused: { turns: 0, chars: 0 },
    },
  ]);

  // Same hour: counts land in the same bucket.
  counters.noteAppendedTurn(entry, turn("b"));
  assert.equal(counters.snapshot().hours.length, 1);

  // Next hour: a second bucket appears, the first is preserved.
  nowMs += HOUR_MS;
  counters.refuseOne(turn("c"));
  const hours = counters.snapshot().hours;
  assert.equal(hours.length, 2);
  assert.equal(hours[0].accepted.turns, 2);
  assert.equal(hours[1].refused.turns, 1);

  // Fill the ring: 24 distinct hours hold exactly 24 buckets, oldest first.
  for (let i = 2; i <= 23; i += 1) {
    nowMs += HOUR_MS;
    counters.noteAppendedTurn(entry, turn(String(i)));
  }
  const full = counters.snapshot().hours;
  assert.equal(full.length, 24);
  assert.equal(new Date(full[0].hourStart).getTime(), hourZero);

  // One more hour evicts the oldest bucket; the ring never exceeds 24.
  nowMs += HOUR_MS;
  counters.refuseOne(turn("d"));
  const rolled = counters.snapshot().hours;
  assert.equal(rolled.length, 24);
  assert.ok(!rolled.some((hour) => hour.hourStart === new Date(hourZero).toISOString()));
  const newest = rolled.at(-1);
  assert.ok(newest !== undefined, "the ring keeps the newest hour after eviction");
  assert.equal(newest.refused.turns, 1);
});

test("totals survive hourly eviction (process-lifetime sums, not the ring)", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const entry = fakeEntry();
  counters.noteAppendedTurn(entry, turn("a"));
  nowMs += 30 * HOUR_MS;
  counters.noteAppendedTurn(entry, turn("bb"));
  assert.deepEqual(counters.snapshot().totals.accepted, { turns: 2, chars: 3 });
});

test("exactly one aggregate info line per hour, counts only", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const entry = fakeEntry();
  const { lines, restore } = captureInfo();
  try {
    // First hour of the process: nothing to log yet (empty bucket).
    counters.noteAppendedTurn(entry, turn("a"));
    assert.equal(lines.length, 0);

    // Hour rolls: ONE line describing the previous hour.
    nowMs += HOUR_MS;
    counters.refuseOne(turn("b"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /buffer ingress/);
    assert.match(lines[0], /accepted=1\//);
    assert.match(lines[0], /refused=0\//);

    // No further log within the same hour, even with more records.
    counters.noteAppendedTurn(entry, turn("c"));
    assert.equal(lines.length, 1);

    // Empty hours produce no log line (zero-noise): jump forward 3 hours.
    nowMs += 3 * HOUR_MS;
    counters.refuseOne(turn("d"));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /refused=1\//);
  } finally {
    restore();
  }
});

test("log lines carry no content or session identifiers", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const entry = fakeEntry();
  const { lines, restore } = captureInfo();
  try {
    counters.noteAppendedTurn(entry, turn("secret-session-kaze"));
    nowMs += HOUR_MS;
    counters.noteAppendedTurn(entry, turn("secret memory content"));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("secret-session-kaze"));
    assert.ok(!lines[0].includes("secret memory content"));
  } finally {
    restore();
  }
});

test("EMPTY_BUFFER_INGRESS_SNAPSHOT is the zero snapshot for hosts without a buffer", () => {
  const empty: BufferIngressSnapshot = EMPTY_BUFFER_INGRESS_SNAPSHOT;
  assert.deepEqual(empty.totals, {
    accepted: { turns: 0, chars: 0 },
    acceptedExactDuplicate: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  });
  assert.deepEqual(empty.hours, []);
});
