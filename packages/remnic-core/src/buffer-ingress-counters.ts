/**
 * Buffer-ingress counters (issue #3444) — OBSERVATION ONLY.
 *
 * Counts what the SmartBuffer add path already does, per offered turn, in
 * turns and characters:
 *   - accepted: the turn was appended to a buffer entry (always the case for
 *     non-refused offers; this layer invents no filtering),
 *   - acceptedExactDuplicate: observational SUB-COUNT of accepted — the
 *     appended turn's role+content exactly matches a turn already in that
 *     session's buffer entry (live turns or deferred-retained copies). This
 *     is the duplicate rate at ingress that #3443 needs; it changes nothing,
 *   - filtered: reserved for turns existing code drops before/at the buffer.
 *     The SmartBuffer add path itself drops nothing, so it is always 0 at
 *     this layer; upstream filters (captureMode=explicit skips in
 *     processTurn/ingestReplayBatch, the observe funnel's empty-content and
 *     fingerprint dedup) live outside the buffer add,
 *   - refused: capacity refusal (existing null-return and throw sites).
 *
 * Invariant: accepted + filtered + refused == turns offered.
 * acceptedExactDuplicate <= accepted (it is a sub-count, not a partition).
 *
 * Counters are process-local and instance-owned (one instance per
 * SmartBuffer, no module state), feed a 24-hour hourly ring with ONE
 * aggregate info log line per hour (counts only: no content, no session
 * ids, silent idle hours), and take an injectable clock for tests.
 *
 * Memory: duplicate detection hashes role+content to a sha256 digest (same
 * scheme as the drain hand-in memo) — turn content is never retained. The
 * per-entry digest set mirrors the entry's own turns (so it is bounded by
 * the session turn cap) and additionally enforces a hard FIFO cap of
 * DUPLICATE_DIGEST_CAP digests; beyond the cap the oldest digest is
 * evicted, so very old unique contents stop being recognized as
 * duplicates until the next rebuild (metric under-count, never a buffer
 * change).
 *
 * O(1) amortized per turn: memo validity is the entry's array references,
 * so any mutation that removes or replaces turns (all of them reassign a
 * fresh array) self-invalidates the memo without epoch bookkeeping.
 */

import { createHash } from "node:crypto";
import { log } from "./logger.js";
import type { BufferEntryState, BufferTurn } from "./types.js";

export type BufferIngressOutcome = "accepted" | "acceptedExactDuplicate" | "filtered" | "refused";

export interface BufferIngressOutcomeCount {
  turns: number;
  chars: number;
}

export interface BufferIngressHour {
  hourStart: string;
  accepted: BufferIngressOutcomeCount;
  acceptedExactDuplicate: BufferIngressOutcomeCount;
  filtered: BufferIngressOutcomeCount;
  refused: BufferIngressOutcomeCount;
}

export interface BufferIngressSnapshot {
  totals: Record<BufferIngressOutcome, BufferIngressOutcomeCount>;
  hours: BufferIngressHour[];
}

export const EMPTY_BUFFER_INGRESS_SNAPSHOT: BufferIngressSnapshot = {
  totals: {
    accepted: { turns: 0, chars: 0 },
    acceptedExactDuplicate: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  },
  hours: [],
};

const HOUR_MS = 3_600_000;
const RING_SLOTS = 24;
/**
 * Hard cap on the per-entry duplicate-digest set (defense against configs
 * with very large session caps). Beyond the cap the oldest digest is
 * FIFO-evicted: recognition of the oldest unique contents degrades to
 * "not a duplicate" (an under-count of acceptedExactDuplicate), never a
 * behavioral change.
 */
const DUPLICATE_DIGEST_CAP = 4096;

const OUTCOMES: readonly BufferIngressOutcome[] = ["accepted", "acceptedExactDuplicate", "filtered", "refused"];

function zeroCounts() {
  return {
    accepted: { turns: 0, chars: 0 },
    acceptedExactDuplicate: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  } satisfies Record<BufferIngressOutcome, BufferIngressOutcomeCount>;
}

function contentDigest(turn: BufferTurn): string {
  return createHash("sha256").update(`${turn.role}\u0000${turn.content}`).digest("base64");
}

interface RingSlot {
  hourStartMs: number;
  counts: Record<BufferIngressOutcome, BufferIngressOutcomeCount>;
}

interface EntryDigestMemo {
  turnsRef: BufferTurn[];
  retainedRef: BufferTurn[] | undefined;
  digests: Set<string>;
}

export class BufferIngressCounters {
  private readonly ring: (RingSlot | null)[] = Array.from({ length: RING_SLOTS }, () => null);
  private readonly totals: Record<BufferIngressOutcome, BufferIngressOutcomeCount> = zeroCounts();
  private readonly memos = new WeakMap<BufferEntryState, EntryDigestMemo>();
  /** Hour of the most recent record; its bucket is logged when the hour ends. */
  private lastActiveHourMs: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    /** Test seam: the disabled control proves counting does not touch the buffer. */
    private readonly enabled = true,
  ) {}

  /**
   * Observe an appended turn (called AFTER the buffer pushed it). Counts
   * `accepted` and, when an identical role+content digest is already tracked
   * for this entry, the `acceptedExactDuplicate` sub-count. Returns nothing;
   * the buffer behaves identically either way.
   */
  noteAppendedTurn(entry: BufferEntryState, turn: BufferTurn): void {
    if (!this.enabled) return;
    const chars = turn.content.length;
    this.record("accepted", chars);
    const memo = this.memoFor(entry);
    const digest = contentDigest(turn);
    if (memo.digests.has(digest)) this.record("acceptedExactDuplicate", chars);
    memo.digests.add(digest);
    if (memo.digests.size > DUPLICATE_DIGEST_CAP) {
      for (const oldest of memo.digests) {
        memo.digests.delete(oldest);
        break;
      }
    }
  }

  /** Count a single capacity-refused turn; returns null for `return` sites. */
  refuseOne(turn: BufferTurn): null {
    if (!this.enabled) return null;
    this.record("refused", turn.content.length);
    return null;
  }

  /** Count a refused ERROR for `throw` sites; the error propagates unchanged. */
  refuseThrow(turn: BufferTurn, error: Error): Error {
    this.refuseOne(turn);
    return error;
  }

  /** Count a WHOLE-BATCH refusal (every offered turn is dropped). */
  refuseAll(offered: readonly { turn: BufferTurn }[]): null {
    for (const { turn } of offered) this.refuseOne(turn);
    return null;
  }

  snapshot(): BufferIngressSnapshot {
    const nowHourMs = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
    const hours = this.ring
      .filter((slot): slot is RingSlot => slot !== null && nowHourMs - slot.hourStartMs < HOUR_MS * RING_SLOTS)
      .sort((a, b) => a.hourStartMs - b.hourStartMs)
      .map((slot) => ({
        hourStart: new Date(slot.hourStartMs).toISOString(),
        accepted: { ...slot.counts.accepted },
        acceptedExactDuplicate: { ...slot.counts.acceptedExactDuplicate },
        filtered: { ...slot.counts.filtered },
        refused: { ...slot.counts.refused },
      }));
    return {
      totals: {
        accepted: { ...this.totals.accepted },
        acceptedExactDuplicate: { ...this.totals.acceptedExactDuplicate },
        filtered: { ...this.totals.filtered },
        refused: { ...this.totals.refused },
      },
      hours,
    };
  }

  private record(outcome: BufferIngressOutcome, chars: number): void {
    const hourStartMs = Math.floor(this.now() / HOUR_MS) * HOUR_MS;
    if (hourStartMs !== this.lastActiveHourMs) {
      if (this.lastActiveHourMs !== null) this.logHourBucket(this.lastActiveHourMs);
      this.lastActiveHourMs = hourStartMs;
    }
    const slotIndex = (hourStartMs / HOUR_MS) % RING_SLOTS;
    const slot = this.ring[slotIndex];
    if (slot !== null && slot.hourStartMs === hourStartMs) {
      slot.counts[outcome].turns += 1;
      slot.counts[outcome].chars += chars;
    } else {
      // Slot reuse after 24h: the stale bucket was logged when its own hour
      // ended, so eviction here is silent.
      const counts = {
        ...zeroCounts(),
        [outcome]: { turns: 1, chars },
      } satisfies Record<BufferIngressOutcome, BufferIngressOutcomeCount>;
      this.ring[slotIndex] = { hourStartMs, counts };
    }
    this.totals[outcome].turns += 1;
    this.totals[outcome].chars += chars;
  }

  /** ONE aggregate line per hour, at roll time, describing the ending hour. */
  private logHourBucket(hourStartMs: number): void {
    const slot = this.ring[(hourStartMs / HOUR_MS) % RING_SLOTS];
    if (slot === null || slot.hourStartMs !== hourStartMs) return;
    const counts = slot.counts;
    if (OUTCOMES.every((outcome) => counts[outcome].turns === 0)) return; // zero-noise: silent idle hours
    log.info(
      `buffer ingress ${new Date(hourStartMs).toISOString()}: ${OUTCOMES.map((outcome) => `${outcome}=${counts[outcome].turns}/${counts[outcome].chars}c`).join(" ")}`,
    );
  }

  private memoFor(entry: BufferEntryState): EntryDigestMemo {
    const retained = entry.retainedTurns;
    const memo = this.memos.get(entry);
    if (memo && memo.turnsRef === entry.turns && memo.retainedRef === retained) return memo;
    const fresh: EntryDigestMemo = {
      turnsRef: entry.turns,
      retainedRef: retained,
      digests: new Set([...entry.turns, ...(retained ?? [])].map(contentDigest)),
    };
    this.memos.set(entry, fresh);
    return fresh;
  }
}
