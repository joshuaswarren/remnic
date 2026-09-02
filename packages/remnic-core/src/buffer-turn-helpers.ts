import type { BufferEntryState, BufferTurn } from "./types.js";

export interface BufferTurnOwner {
  /**
   * Server-resolved principal that owns this session at the authenticated
   * observe/write boundary. Persisted with the buffered turn so lifecycle
   * flushes do not have to infer ownership from a client-chosen session key.
   */
  sessionOwnerPrincipal?: string;
}

export interface AmbientCaptureProvenance {
  /**
   * True when this turn's content came from an always-on ambient capture
   * device (a wearable recorder, a room microphone) and may therefore carry
   * speech the user never authored: TV, podcasts, music, overheard
   * conversation (issue #2294). Set by the ingesting subsystem, never from
   * tool arguments — extraction reads it to warn the model about media audio
   * and to clamp high-impact personal facts to the speculative tier.
   */
  ambientCapture?: boolean;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function copyBufferTurn(turn: BufferTurn): BufferTurn {
  const copy: BufferTurn = {
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
  };
  if (typeof turn.sessionKey === "string") copy.sessionKey = turn.sessionKey;
  if (typeof turn.logicalSessionKey === "string") {
    copy.logicalSessionKey = turn.logicalSessionKey;
  }
  if (turn.providerThreadId === null || typeof turn.providerThreadId === "string") {
    copy.providerThreadId = turn.providerThreadId;
  }
  if (typeof turn.sessionOwnerPrincipal === "string") {
    copy.sessionOwnerPrincipal = turn.sessionOwnerPrincipal;
  }
  if (typeof turn.turnFingerprint === "string") {
    copy.turnFingerprint = turn.turnFingerprint;
  }
  if (typeof turn.persistProcessedFingerprint === "boolean") {
    copy.persistProcessedFingerprint = turn.persistProcessedFingerprint;
  }
  if (typeof turn.sourceConnector === "string") {
    copy.sourceConnector = turn.sourceConnector;
  }
  if (turn.originRole === "user" || turn.originRole === "assistant" || turn.originRole === "tool") {
    copy.originRole = turn.originRole;
  }
  if (typeof turn.ambientCapture === "boolean") {
    copy.ambientCapture = turn.ambientCapture;
  }
  return copy;
}

export function bufferTurnsEqual(left: BufferTurn | undefined, right: BufferTurn): boolean {
  if (!left) return false;
  return (
    left.role === right.role &&
    left.content === right.content &&
    left.timestamp === right.timestamp &&
    left.sessionKey === right.sessionKey &&
    left.sessionOwnerPrincipal === right.sessionOwnerPrincipal &&
    left.logicalSessionKey === right.logicalSessionKey &&
    left.providerThreadId === right.providerThreadId &&
    left.turnFingerprint === right.turnFingerprint &&
    left.persistProcessedFingerprint === right.persistProcessedFingerprint &&
    left.sourceConnector === right.sourceConnector &&
    left.originRole === right.originRole &&
    left.ambientCapture === right.ambientCapture
  );
}

export function bufferTurnArraysEqual(
  left: readonly BufferTurn[],
  right: readonly BufferTurn[],
): boolean {
  return left.length === right.length && left.every((turn, index) => bufferTurnsEqual(turn, right[index]));
}

export function bufferTurnArrayIsSuffixOfSnapshot(
  liveTurns: readonly BufferTurn[],
  snapshot: readonly BufferTurn[],
): boolean {
  if (liveTurns.length === 0 || liveTurns.length > snapshot.length) {
    return false;
  }
  const offset = snapshot.length - liveTurns.length;
  return liveTurns.every((turn, index) => bufferTurnsEqual(turn, snapshot[offset + index]));
}

export function liveTurnsFromExtractionSnapshot(
  entry: BufferEntryState,
  extractedTurns: readonly BufferTurn[],
): readonly BufferTurn[] {
  const retainedTurns = entry.retainedTurns ?? [];
  if (
    retainedTurns.length > 0 &&
    extractedTurns.length >= retainedTurns.length &&
    retainedTurns.every((turn, index) => bufferTurnsEqual(extractedTurns[index], turn))
  ) {
    const withoutRetainedPrefix = extractedTurns.slice(retainedTurns.length);
    if (withoutRetainedPrefix.length > 0 && matchingPrefixLength(entry.turns, withoutRetainedPrefix) > 0) {
      return withoutRetainedPrefix;
    }
  }
  return extractedTurns;
}

function matchingPrefixLength(
  liveTurns: readonly BufferTurn[],
  extractedTurns: readonly BufferTurn[],
): number {
  let index = 0;
  while (
    index < liveTurns.length &&
    index < extractedTurns.length &&
    bufferTurnsEqual(liveTurns[index], extractedTurns[index])
  ) {
    index += 1;
  }
  return index;
}

export function matchingQueuedExtractionPrefixLength(
  liveTurns: readonly BufferTurn[],
  extractedTurns: readonly BufferTurn[],
): number {
  let bestMatchedCount = 0;
  for (let start = 0; start < extractedTurns.length; start += 1) {
    const matchedCount = matchingPrefixLength(liveTurns, extractedTurns.slice(start));
    if (matchedCount > bestMatchedCount) {
      bestMatchedCount = matchedCount;
      if (bestMatchedCount === liveTurns.length) break;
    }
  }
  return bestMatchedCount;
}

export class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`probe exceeded ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

export function probeWithTimeout<T>(inflight: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
  });
  return Promise.race([inflight, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
