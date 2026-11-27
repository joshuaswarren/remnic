import { log } from "./logger.js";
import type { BufferEntryState, BufferTurn } from "./types.js";

export const FALLBACK_MAX_TURNS_PER_SESSION = 2000;

export function resolveMaxTurnsPerSession(configured: number | undefined): number {
  return configured ?? FALLBACK_MAX_TURNS_PER_SESSION;
}

/** Live turns plus deferred retention copies: one session, one count. */
export function heldTurnCount(entry: BufferEntryState | null): number {
  return entry === null ? 0 : (entry.retainedTurns?.length ?? 0) + entry.turns.length;
}

/** True when held plus incoming exceeds the cap. New keys hold 0. */
export function sessionTurnCapReached(entry: BufferEntryState | null, incoming: number, maxTurns: number): boolean {
  return heldTurnCount(entry) + incoming > maxTurns;
}

function warnTurnCapRefused(bufferKey: string, maxTurns: number): void {
  log.warn(`buffer[${bufferKey}]: durable capture refused at the per-session turn cap (${maxTurns})`);
}

/** Single-turn paths: true means refuse (live path throws, bounded paths return null). */
export function refuseOverCapSingle(entry: BufferEntryState | null, maxTurns: number, bufferKey: string): boolean {
  if (!sessionTurnCapReached(entry, 1, maxTurns)) return false;
  warnTurnCapRefused(bufferKey, maxTurns);
  return true;
}

/** Batch path: sums incoming turns per key across all batches, new keys included. Returns the first over-cap key. */
export function refuseOverCapBatch(
  peekEntry: (key: string) => BufferEntryState | null,
  batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[],
  maxTurns: number,
): string | null {
  const incomingByKey = new Map<string, number>();
  for (const batch of batches) incomingByKey.set(batch.bufferKey, (incomingByKey.get(batch.bufferKey) ?? 0) + batch.turns.length);
  for (const [bufferKey, incoming] of incomingByKey) {
    if (heldTurnCount(peekEntry(bufferKey)) + incoming > maxTurns) {
      warnTurnCapRefused(bufferKey, maxTurns);
      return bufferKey;
    }
  }
  return null;
}
