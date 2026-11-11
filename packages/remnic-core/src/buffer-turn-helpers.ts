import type { BufferEntryState, BufferState, BufferTurn } from "./types.js";

/** Extracted identities retain whether they came from active or retained turns. */
export interface DrainedTurnSets {
  turns: BufferTurn[];
  retainedTurns: BufferTurn[];
}

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
  if (turn.sourceValidAt !== undefined) {
    copy.sourceValidAt = turn.sourceValidAt;
  }
  if (turn.parts !== undefined) {
    copy.parts = turn.parts;
  }
  if (turn.rawContent !== undefined) {
    copy.rawContent = turn.rawContent;
  }
  if (turn.sourceFormat !== undefined) {
    copy.sourceFormat = turn.sourceFormat;
  }
  // #3251 scope pins: strings copy by value; the plan object is an immutable
  // config-derived identity passed by reference.
  if (turn.writeNamespaceOverride !== undefined) {
    copy.writeNamespaceOverride = turn.writeNamespaceOverride;
  }
  if (turn.principalOverride !== undefined) {
    copy.principalOverride = turn.principalOverride;
  }
  if (turn.scopeProfileWritePlan !== undefined) {
    copy.scopeProfileWritePlan = turn.scopeProfileWritePlan;
  }
  if (turn.acceptedCapture === true) {
    copy.acceptedCapture = true;
  }
  const ctx = turn.codingContext;
  if (ctx) {
    // All four fields are identity inputs (branchScope uses branch) — copy
    // explicitly as-is; never a spread of external input.
    copy.codingContext = {
      projectId: ctx.projectId,
      branch: ctx.branch,
      rootPath: ctx.rootPath,
      defaultBranch: ctx.defaultBranch,
    };
  }
  return copy;
}

/**
 * Remove the turns that a drain already extracted (`drained`) from `turns`.
 * Identity-based (role/content/timestamp/session/...): the same comparison
 * the buffer uses to match live turns, so a stale owner can subtract exactly
 * what the drain took and keep everything else.
 */
export function subtractBufferTurns(turns: readonly BufferTurn[], drained: readonly BufferTurn[]): BufferTurn[] {
  if (drained.length === 0) return [...turns];
  const kept = [...turns];
  for (const gone of drained) {
    const at = kept.findIndex((live) => bufferTurnsEqual(live, gone));
    if (at >= 0) kept.splice(at, 1);
  }
  return kept;
}

/** Per-key pending counts over the IN-MEMORY buffer state (counts only — no
 *  turn payloads). The claim store's answer stays authoritative for claimed
 *  keys; callers must filter through `BufferDrainClaims.isClaimed` before
 *  treating a count here as work. */
export interface BufferEntryCounts {
  turns: number;
  retainedTurns: number;
}

export function bufferEntryCounts(state: BufferState): Map<string, BufferEntryCounts> {
  const out = new Map<string, BufferEntryCounts>();
  const entries = state.entries;
  if (!entries) return out;
  for (const [key, entry] of Object.entries(entries)) {
    out.set(key, { turns: entry.turns.length, retainedTurns: entry.retainedTurns?.length ?? 0 });
  }
  return out;
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
    left.ambientCapture === right.ambientCapture &&
    left.sourceValidAt === right.sourceValidAt &&
    left.acceptedCapture === right.acceptedCapture &&
    left.codingContext?.projectId === right.codingContext?.projectId &&
    left.codingContext?.rootPath === right.codingContext?.rootPath &&
    left.codingContext?.branch === right.codingContext?.branch &&
    left.codingContext?.defaultBranch === right.codingContext?.defaultBranch &&
    // #3251 scope pins compare by identity triple, not deep plan equality: a
    // restart-rehydrated plan must still match the pin it was accepted under.
    left.writeNamespaceOverride === right.writeNamespaceOverride &&
    left.principalOverride === right.principalOverride &&
    scopeProfilePlanIdentity(left.scopeProfileWritePlan) ===
      scopeProfilePlanIdentity(right.scopeProfileWritePlan)
  );
}

/**
 * Canonical identity key for a turn, injective over `bufferTurnsEqual`
 * equality classes. Every compared field is a primitive (or the #3251 plan
 * identity string), so set-membership replaces pairwise comparison and turn
 * merges run O(n + m) instead of O(n × m). JSON.stringify of a string is
 * injective (it escapes control characters), and the raw `\u0001` sentinels
 * distinguish undefined from null — a distinction `===` makes and plain
 * stringification would lose.
 */
export function bufferTurnIdentityKey(turn: BufferTurn): string {
  const opt = (value: string | null | undefined): string =>
    value === undefined ? "\u0001undefined" : value === null ? "\u0001null" : JSON.stringify(value);
  const optFlag = (value: boolean | undefined): string =>
    value === undefined ? "\u0001undefined" : String(value);
  const ctx = turn.codingContext;
  return JSON.stringify([
    turn.role,
    turn.content,
    turn.timestamp,
    opt(turn.sessionKey),
    opt(turn.sessionOwnerPrincipal),
    opt(turn.logicalSessionKey),
    turn.providerThreadId === undefined ? "\u0001undefined" : turn.providerThreadId === null ? "\u0001null" : JSON.stringify(turn.providerThreadId),
    opt(turn.turnFingerprint),
    optFlag(turn.persistProcessedFingerprint),
    opt(turn.sourceConnector),
    opt(turn.originRole),
    optFlag(turn.ambientCapture),
    opt(turn.sourceValidAt),
    optFlag(turn.acceptedCapture),
    opt(ctx?.projectId),
    opt(ctx?.rootPath),
    opt(ctx?.branch),
    opt(ctx?.defaultBranch),
    opt(turn.writeNamespaceOverride),
    opt(turn.principalOverride),
    opt(turn.scopeProfileWritePlan ? scopeProfilePlanIdentity(turn.scopeProfileWritePlan) : undefined),
  ]);
}

/**
 * Identity-dedupe `incoming` turns into `existing` (same contract as the
 * claim-merge `mergeTurns`): identical turns are dropped — the EXISTING
 * entry is kept — genuinely-new turns append in arrival order, and
 * duplicates within `incoming` collapse to their first occurrence. O(n + m)
 * via `bufferTurnIdentityKey` membership instead of pairwise equality.
 */
export function mergeBufferTurnsByIdentity(
  existing: readonly BufferTurn[],
  incoming: readonly BufferTurn[],
): BufferTurn[] {
  const merged = [...existing];
  const seen = new Set(merged.map(bufferTurnIdentityKey));
  for (const turn of incoming) {
    const key = bufferTurnIdentityKey(turn);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(turn);
  }
  return merged;
}

/** Replace only the processed snapshot; callers without one retain legacy whole-slot semantics. */
export function selectRetainedDeferredTurns(
  existing: readonly BufferTurn[],
  turns: BufferTurn[],
  max: number,
  originalTurns?: readonly BufferTurn[],
): BufferTurn[] {
  const others = originalTurns === undefined ? [] : existing.filter(
    (turn) => !originalTurns.some((original) => bufferTurnsEqual(turn, original)),
  );
  if (!Array.isArray(turns) || max <= 0) return others;
  return [...others, ...turns.slice(-max).map(copyBufferTurn)];
}

export function hasPinnedCaptureScope(turn: BufferTurn): boolean {
  return turn.acceptedCapture === true ||
    turn.writeNamespaceOverride !== undefined ||
    turn.scopeProfileWritePlan !== undefined;
}

/** Stable identity string for a pinned scope-profile plan (#3251). */
export function scopeProfilePlanIdentity(
  plan: BufferTurn["scopeProfileWritePlan"],
): string {
  if (!plan) return "";
  return `${plan.profileId}\u0000${plan.writeLayer}\u0000${plan.writeNamespace}`;
}

export interface ExtractionScopeGroup {
  writeNamespaceOverride?: string;
  principalOverride?: string;
  scopeProfileWritePlan?: BufferTurn["scopeProfileWritePlan"];
  codingContext?: BufferTurn["codingContext"];
  turns: BufferTurn[];
}

/**
 * Partition extraction turns by their durable scope pins (#3251). Turns
 * captured under different namespaces / principals / scope profiles /
 * project bindings must never be extracted together — each group runs its
 * own extraction under its own scope. Native (unpinned) turns form their own
 * group and keep today's single-store routing.
 */
export function groupTurnsByExtractionScope(turns: BufferTurn[]): ExtractionScopeGroup[] {
  const groups = new Map<string, ExtractionScopeGroup>();
  for (const turn of turns) {
    const key = [
      turn.writeNamespaceOverride ?? "",
      turn.principalOverride ?? "",
      scopeProfilePlanIdentity(turn.scopeProfileWritePlan),
      // Accepted captures are deliberately accepted content: they must never
      // share a scope group with ordinary turns, or a group-level capture
      // policy (the explicit-mode gate, the planless-accepted null pin) is
      // applied to ordinary conversation turns because `.some(acceptedCapture)`
      // only looked at the merged group.
      turn.acceptedCapture === true ? "accepted" : "",
      turn.codingContext?.projectId ?? "",
      turn.codingContext?.rootPath ?? "",
      turn.codingContext?.branch ?? "",
      turn.codingContext?.defaultBranch ?? "",
    ].join("\u0000");
    const group = groups.get(key);
    if (group) {
      group.turns.push(turn);
    } else {
      const created: ExtractionScopeGroup = { turns: [turn] };
      if (turn.writeNamespaceOverride !== undefined) created.writeNamespaceOverride = turn.writeNamespaceOverride;
      if (turn.principalOverride !== undefined) created.principalOverride = turn.principalOverride;
      if (turn.scopeProfileWritePlan !== undefined) created.scopeProfileWritePlan = turn.scopeProfileWritePlan;
      if (turn.codingContext !== undefined) created.codingContext = turn.codingContext;
      groups.set(key, created);
    }
  }
  return [...groups.values()];
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
