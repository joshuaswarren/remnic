/** Bounded multi-session turn admission (#3368 split from buffer.ts). */

import { selectEvictedBufferKeys } from "./buffer-eviction.js";
import {
  hasBufferedAdmissionIdempotencyKey,
  recordBufferedAdmissionIdempotencyKey,
} from "./buffer-admission-idempotency.js";
import { refuseOverCapBatch, resolveMaxTurnsPerSession } from "./buffer-session-cap.js";
import type { BufferSessionPersistence } from "./buffer-persistence.js";
import type { BufferIngressCounters } from "./buffer-ingress-counters.js";
import type { AddTurnMutationResult, AddTurnOutcome } from "./buffer-types.js";
import { EVICTION_HOOKS } from "./buffer-turn-helpers.js";
import type { BufferEntryState, BufferState, BufferTurn, PluginConfig } from "./types.js";

export type AddTurnsBoundedOutcome =
  | Array<{ bufferKey: string; turn: BufferTurn; outcome: AddTurnOutcome }>
  | null
  | "duplicate";

export interface AddTurnsBoundedHost {
  readonly config: PluginConfig;
  readonly maxSessionEntries: number;
  get state(): BufferState;
  readonly persistence: BufferSessionPersistence;
  readonly ingress: BufferIngressCounters;
  enqueueMutation<T>(work: () => Promise<T>): Promise<T>;
  loadUnlocked(): Promise<void>;
  peekEntry(bufferKey: string): BufferEntryState | null;
  recordTurnUnlocked(bufferKey: string, turn: BufferTurn): Promise<AddTurnMutationResult>;
  completeAddTurnOutcome(
    bufferKey: string,
    turn: BufferTurn,
    mutation: AddTurnMutationResult,
  ): Promise<AddTurnOutcome>;
}

export async function addTurnsBoundedWithAdmissionKey(
  host: AddTurnsBoundedHost,
  batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[],
  admissionKey?: string,
): Promise<AddTurnsBoundedOutcome> {
  const pending = await host.enqueueMutation(async () => {
    await host.loadUnlocked();
    if (admissionKey && hasBufferedAdmissionIdempotencyKey(host.state, admissionKey)) {
      return "duplicate" as const;
    }
    const additions: Array<{ bufferKey: string; turn: BufferTurn }> = [];
    for (const batch of batches) {
      for (const turn of batch.turns) {
        additions.push({ bufferKey: batch.bufferKey, turn });
      }
    }

    if (refuseOverCapBatch((key) => host.peekEntry(key) ?? null, batches, resolveMaxTurnsPerSession(host.config.bufferMaxTurnsPerSession))) {
      return host.ingress.refuseAll(additions);
    }
    const entries = host.state.entries ?? {};
    const newKeys = [
      ...new Set(
        additions
          .map(({ bufferKey }) => bufferKey)
          .filter((bufferKey) => host.peekEntry(bufferKey) === null),
      ),
    ];
    const count = Object.keys(entries).length;
    const requiredEvictions = Math.max(0, count + newKeys.length - host.maxSessionEntries);
    if (requiredEvictions > 0) {
      const target = Math.max(0, host.maxSessionEntries - newKeys.length);
      const evicted = selectEvictedBufferKeys(entries, newKeys, target, EVICTION_HOOKS);
      if (newKeys.length > 0 && evicted.length < requiredEvictions) return host.ingress.refuseAll(additions);
      for (const key of evicted) delete entries[key];
      host.persistence.markEvicted(evicted);
    }

    const recorded: Array<{ bufferKey: string; turn: BufferTurn; mutation: AddTurnMutationResult }> = [];
    for (const { bufferKey, turn } of additions) {
      recorded.push({ bufferKey, turn, mutation: await host.recordTurnUnlocked(bufferKey, turn) });
    }
    if (admissionKey) {
      recordBufferedAdmissionIdempotencyKey(host.state, admissionKey, recorded.length);
      host.persistence.markAdmissionIdempotencyDirty();
    }
    return recorded;
  });
  if (pending === "duplicate") return "duplicate";
  if (pending === null) return null;

  const outcomes: Array<{ bufferKey: string; turn: BufferTurn; outcome: AddTurnOutcome }> = [];
  for (const item of pending) {
    outcomes.push({
      bufferKey: item.bufferKey,
      turn: item.turn,
      outcome: await host.completeAddTurnOutcome(item.bufferKey, item.turn, item.mutation),
    });
  }
  return outcomes;
}
