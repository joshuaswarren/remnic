import assert from "node:assert/strict";
import test from "node:test";

import { initLogger, resetLogger } from "./logger.js";
import {
  EMPTY_BUFFER_INGRESS_SNAPSHOT,
  BufferIngressCounters,
  type BufferIngressSnapshot,
} from "./buffer-ingress-counters.js";

const HOUR_MS = 3_600_000;

function captureInfo(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  initLogger({
    info: (msg: string) => lines.push(msg),
    warn: () => {},
    debug: () => {},
  });
  return { lines, restore: resetLogger };
}

test("counters aggregate per outcome in turns and characters", () => {
  const counters = new BufferIngressCounters();
  counters.record("accepted", 10);
  counters.record("accepted", 5);
  counters.record("deduplicated", 7);
  counters.record("filtered", 0);
  counters.record("refused", 3);

  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.totals.accepted, { turns: 2, chars: 15 });
  assert.deepEqual(snapshot.totals.deduplicated, { turns: 1, chars: 7 });
  assert.deepEqual(snapshot.totals.filtered, { turns: 1, chars: 0 });
  assert.deepEqual(snapshot.totals.refused, { turns: 1, chars: 3 });
});

test("snapshot is a fresh read-only structure and never aliases internals", () => {
  const counters = new BufferIngressCounters();
  counters.record("accepted", 4);
  const first = counters.snapshot();
  first.totals.accepted.turns = 99;
  first.hours.push({
    hourStart: "tampered",
    accepted: { turns: 0, chars: 0 },
    deduplicated: { turns: 0, chars: 0 },
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

  counters.record("accepted", 1);
  const hourZero = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  assert.deepEqual(counters.snapshot().hours, [
    {
      hourStart: new Date(hourZero).toISOString(),
      accepted: { turns: 1, chars: 1 },
      deduplicated: { turns: 0, chars: 0 },
      filtered: { turns: 0, chars: 0 },
      refused: { turns: 0, chars: 0 },
    },
  ]);

  // Same hour: counts land in the same bucket.
  counters.record("accepted", 2);
  assert.equal(counters.snapshot().hours.length, 1);

  // Next hour: a second bucket appears, the first is preserved.
  nowMs += HOUR_MS;
  counters.record("deduplicated", 3);
  const hours = counters.snapshot().hours;
  assert.equal(hours.length, 2);
  assert.equal(hours[0].accepted.turns, 2);
  assert.equal(hours[1].deduplicated.turns, 1);

  // Fill the ring: 24 distinct hours hold exactly 24 buckets, oldest first.
  for (let i = 2; i <= 23; i += 1) {
    nowMs += HOUR_MS;
    counters.record("accepted", i);
  }
  const full = counters.snapshot().hours;
  assert.equal(full.length, 24);
  assert.equal(new Date(full[0].hourStart).getTime(), hourZero);

  // One more hour evicts the oldest bucket; the ring never exceeds 24.
  nowMs += HOUR_MS;
  counters.record("refused", 4);
  const rolled = counters.snapshot().hours;
  assert.equal(rolled.length, 24);
  assert.ok(!rolled.some((hour) => hour.hourStart === new Date(hourZero).toISOString()));
  assert.equal(rolled.at(-1).refused.turns, 1);
});

test("totals survive hourly eviction (process-lifetime sums, not the ring)", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  counters.record("accepted", 1);
  nowMs += 30 * HOUR_MS;
  counters.record("accepted", 2);
  assert.deepEqual(counters.snapshot().totals.accepted, { turns: 2, chars: 3 });
});

test("exactly one aggregate info line per hour, counts only", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const { lines, restore } = captureInfo();
  try {
    // First hour of the process: nothing to log yet (empty bucket).
    counters.record("accepted", 6);
    assert.equal(lines.length, 0);

    // Same hour again: still no log.
    counters.record("deduplicated", 6);
    assert.equal(lines.length, 0);

    // Hour rolls: ONE line describing the previous hour.
    nowMs += HOUR_MS;
    counters.record("accepted", 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /buffer ingress/);
    assert.match(lines[0], /accepted=1/);
    assert.match(lines[0], /deduplicated=1/);

    // No further log within the same hour, even with more records.
    counters.record("filtered", 1);
    assert.equal(lines.length, 1);

    // Empty hours produce no log line (zero-noise): jump forward 3 hours.
    nowMs += 3 * HOUR_MS;
    counters.record("refused", 1);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /refused=0/);
  } finally {
    restore();
  }
});

test("log lines carry no content or session identifiers", () => {
  let nowMs = 1_700_000_000_000;
  const counters = new BufferIngressCounters(() => nowMs);
  const { lines, restore } = captureInfo();
  try {
    counters.record("accepted", "session-kaze-secret".length);
    nowMs += HOUR_MS;
    counters.record("accepted", "secret memory content".length);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("session-kaze-secret"));
    assert.ok(!lines[0].includes("secret memory content"));
  } finally {
    restore();
  }
});

test("EMPTY_BUFFER_INGRESS_SNAPSHOT is the zero snapshot for hosts without a buffer", () => {
  const empty: BufferIngressSnapshot = EMPTY_BUFFER_INGRESS_SNAPSHOT;
  assert.deepEqual(empty.totals, {
    accepted: { turns: 0, chars: 0 },
    deduplicated: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  });
  assert.deepEqual(empty.hours, []);
});
