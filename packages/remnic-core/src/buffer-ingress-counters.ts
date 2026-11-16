/**
 * Buffer-ingress counters (issue #3444).
 *
 * Every turn offered to the SmartBuffer add path is classified into exactly
 * one outcome — accepted (appended to a buffer entry), deduplicated (skipped
 * as an identity or content duplicate already buffered/observed), filtered
 * (dropped before buffering: empty or whitespace-only), refused (capacity
 * refusal) — counted in turns and characters, process-local and instance-owned
 * (one instance per SmartBuffer, no module state), with a 24-hour hourly ring
 * and ONE aggregate info log line per hour (counts only: no content, no
 * session ids).
 *
 * The dedup memo is a WeakMap keyed by the buffer ENTRY object, valid while
 * `entry.turns` / `entry.retainedTurns` keep their array references; every
 * buffer mutation that removes or replaces turns reassigns a fresh array, so
 * the memo self-invalidates without epoch bookkeeping. Steady-state cost is
 * O(1) per turn (set membership), with an O(entry) rebuild only when a drain
 * replaced the arrays.
 */

import { bufferTurnIdentityKey, scopeProfilePlanIdentity } from "./buffer-turn-helpers.js";
import type { AddTurnMutationResult } from "./buffer-types.js";
import { log } from "./logger.js";
import type { BufferEntryState, BufferTurn } from "./types.js";

export type BufferIngressOutcome = "accepted" | "deduplicated" | "filtered" | "refused";

export interface BufferIngressOutcomeCount {
  turns: number;
  chars: number;
}

export interface BufferIngressHour {
  hourStart: string;
  accepted: BufferIngressOutcomeCount;
  deduplicated: BufferIngressOutcomeCount;
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
    deduplicated: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  },
  hours: [],
};

const HOUR_MS = 3_600_000;
const RING_SLOTS = 24;

const OUTCOMES: readonly BufferIngressOutcome[] = ["accepted", "deduplicated", "filtered", "refused"];

function zeroCounts(): Record<BufferIngressOutcome, BufferIngressOutcomeCount> {
  return {
    accepted: { turns: 0, chars: 0 },
    deduplicated: { turns: 0, chars: 0 },
    filtered: { turns: 0, chars: 0 },
    refused: { turns: 0, chars: 0 },
  };
}

interface RingSlot {
  hourStartMs: number;
  counts: Record<BufferIngressOutcome, BufferIngressOutcomeCount>;
}

/**
 * The mutation result SmartBuffer's add paths return for a turn that was
 * counted as filtered or deduplicated and therefore never entered an entry:
 * nothing buffered, nothing scheduled, no extraction trigger.
 */
const DROPPED_MUTATION: AddTurnMutationResult = {
  decision: "keep_buffering",
  signalLevel: "low",
  priorTurns: [],
  activeTurnsSnapshot: [],
  retainedTurnsSnapshot: [],
  turnCountInWindow: 0,
};

/**
 * Content-duplicate key (issue #3444): same message, same provenance, same
 * capture scope — but NOT the wall-clock capture fields (`timestamp`,
 * `turnFingerprint`, `persistProcessedFingerprint`, session/thread keys), so a
 * re-observed message counts as a duplicate while genuinely distinct captures
 * of identical text (different owner, namespace, pin, or bi-temporal event)
 * do not.
 */
function contentDuplicateKey(turn: BufferTurn): string {
  const opt = (value: string | null | undefined): string =>
    value === undefined ? "\u0001undefined" : value === null ? "\u0001null" : JSON.stringify(value);
  const optFlag = (value: boolean | undefined): string => (value === undefined ? "\u0001undefined" : String(value));
  const ctx = turn.codingContext;
  return JSON.stringify([
    turn.role,
    turn.content,
    opt(turn.sessionOwnerPrincipal),
    opt(turn.originRole),
    opt(turn.sourceConnector),
    opt(turn.sourceValidAt),
    optFlag(turn.ambientCapture),
    optFlag(turn.acceptedCapture),
    opt(turn.writeNamespaceOverride),
    opt(turn.principalOverride),
    turn.scopeProfileWritePlan === undefined ? "\u0001undefined" : scopeProfilePlanIdentity(turn.scopeProfileWritePlan),
    opt(ctx?.projectId),
    opt(ctx?.rootPath),
    opt(ctx?.branch),
    opt(ctx?.defaultBranch),
  ]);
}

interface EntryMemo {
  turnsRef: BufferTurn[];
  retainedRef: BufferTurn[] | undefined;
  identity: Set<string>;
  content: Set<string>;
}

export class BufferIngressCounters {
  private readonly ring: (RingSlot | null)[] = Array.from({ length: RING_SLOTS }, () => null);
  private readonly totals: Record<BufferIngressOutcome, BufferIngressOutcomeCount> = zeroCounts();
  private readonly memos = new WeakMap<BufferEntryState, EntryMemo>();
  /** Hour of the most recent record; its bucket is logged when the hour ends. */
  private lastActiveHourMs: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Classify one offered turn against the entry it targets (peeked, never
   * created — filtered offers must not conjure phantom entries) and the other
   * turns offered in the same capacity transaction (`batchSeen`). Returns the
   * shared DROPPED_MUTATION for filtered/deduplicated turns, or null meaning
   * "admit: push the turn". Counts the outcome either way.
   */
  classifyAndCountUnlocked(
    peekedEntry: BufferEntryState | null,
    turn: BufferTurn,
    batchSeen: Set<string> | undefined
  ): AddTurnMutationResult | null {
    const chars = typeof turn.content === "string" ? turn.content.length : 0;
    if (typeof turn.content !== "string" || turn.content.trim().length === 0) {
      this.record("filtered", chars);
      return DROPPED_MUTATION;
    }
    const identityKey = bufferTurnIdentityKey(turn);
    const contentKey = contentDuplicateKey(turn);
    const memo = peekedEntry === null ? null : this.memoFor(peekedEntry);
    if (
      batchSeen?.has(identityKey) === true ||
      batchSeen?.has(contentKey) === true ||
      memo?.identity.has(identityKey) === true ||
      memo?.content.has(contentKey) === true
    ) {
      this.record("deduplicated", chars);
      return DROPPED_MUTATION;
    }
    batchSeen?.add(identityKey);
    batchSeen?.add(contentKey);
    memo?.identity.add(identityKey);
    memo?.content.add(contentKey);
    this.record("accepted", chars);
    return null;
  }

  /** Count a single capacity-refused turn; returns null for `return` sites. */
  refuseOne(turn: BufferTurn): null {
    this.record("refused", typeof turn.content === "string" ? turn.content.length : 0);
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
    const hours = this.ring
      .filter((slot): slot is RingSlot => slot !== null)
      .sort((a, b) => a.hourStartMs - b.hourStartMs)
      .map((slot) => ({
        hourStart: new Date(slot.hourStartMs).toISOString(),
        accepted: { ...slot.counts.accepted },
        deduplicated: { ...slot.counts.deduplicated },
        filtered: { ...slot.counts.filtered },
        refused: { ...slot.counts.refused },
      }));
    return {
      totals: {
        accepted: { ...this.totals.accepted },
        deduplicated: { ...this.totals.deduplicated },
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
      this.ring[slotIndex] = {
        hourStartMs,
        counts: {
          ...zeroCounts(),
          [outcome]: { turns: 1, chars },
        } as Record<BufferIngressOutcome, BufferIngressOutcomeCount>,
      };
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

  private memoFor(entry: BufferEntryState): EntryMemo {
    const retained = entry.retainedTurns;
    const memo = this.memos.get(entry);
    if (memo && memo.turnsRef === entry.turns && memo.retainedRef === retained) return memo;
    const fresh: EntryMemo = {
      turnsRef: entry.turns,
      retainedRef: retained,
      identity: new Set([...entry.turns, ...(retained ?? [])].map(bufferTurnIdentityKey)),
      content: new Set([...entry.turns, ...(retained ?? [])].map(contentDuplicateKey)),
    };
    this.memos.set(entry, fresh);
    return fresh;
  }
}
