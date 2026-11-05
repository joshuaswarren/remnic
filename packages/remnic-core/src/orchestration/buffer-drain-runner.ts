/**
 * Claim-backed extraction-buffer drain (`remnic buffer drain` worker AND the
 * daemon's in-process backlog scheduler task body).
 *
 * The runner owns ONE claimed session at a time and drives it through the
 * SAME extraction pipeline the daemon uses — the same chunking
 * (`chunkExtractionWindow` + the model's input budget), the same retry /
 * provider-circuit semantics. It adds no extraction logic of its own.
 *
 * The difference is ownership: the claimed session's turns live in a drain
 * claim (a durable file), not in a live buffer. The runner wires a
 * claim-backed `SmartBuffer` into the extraction queue as the task's ISOLATED
 * execution context (no global buffer swap — the live buffer, foreground
 * observes and sibling claim drains keep their own state), and groups the
 * claim's turns by captured extraction scope so every group runs under its
 * exact namespace/principal/plan with CURRENT policy re-applied from the
 * turn's original coding binding. `dropFailedChunks: false`: a repeatedly
 * failing chunk stays in the claim as durable retryable backlog.
 */

import { BufferDrainClaims, type DrainLease } from "../storage/buffer-drain-claims.js";
import { shouldSkipImplicitExtraction } from "../explicit-capture.js";
import type { BufferStorage } from "../buffer-persistence.js";
import type { BufferTurn, BufferEntryState, BufferState, PluginConfig } from "../types.js";
import { SmartBuffer } from "../buffer.js";
import { hostname } from "node:os";
import { describeError, groupTurnsByExtractionScope, type ExtractionScopeGroup } from "../buffer-turn-helpers.js";
import { log } from "../logger.js";
import { selfDeps } from "./self-deps.js";
import { TurnIngestionCoordinator, type TurnIngestionDeps } from "./turn-ingestion.js";
import { ExtractionDrain } from "./extraction-drain.js";
import type { ExtractionRunResult } from "./extraction-run.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import { headerConnector, renderExtractionConversation, resolveSourceConnector } from "../source-agent-qualifier.js";
import { resolveMemoryLifecycleCapabilities } from "../capabilities.js";
import type { Orchestrator } from "../orchestrator.js";

export type DrainSessionStatus = "drained" | "deferred" | "failed" | "skipped";

export interface DrainSessionOutcome {
  key: string;
  status: DrainSessionStatus;
  /** Turns the claim held when the drain started. */
  turnsAtStart: number;
  /** Turns still in the claim when the drain stopped. */
  turnsRemaining: number;
  /** Facts the extraction persisted during this run. */
  persistedCount: number;
  /** Durable outputs (memories + entities) the extraction wrote. */
  durableOutputCount: number;
  /** Why the session was skipped or deferred (machine-readable). */
  reason?: string;
  /**
   * Current-policy denials: scope groups whose authorization no longer holds.
   * Their turns STAY in the claim (pending, never drained) and are surfaced
   * here so operators see denied backlog instead of a silently-empty drain.
   */
  denied?: { reason: string; turns: number }[];
}

/** Extraction results that mean "current policy refuses this scope": the
 * turns are valid backlog whose captured scope is no longer writable. */
const DENIED_SCOPE_REASONS: ReadonlySet<string> = new Set([
  "pinned_namespace_unavailable",
  "namespace_write_revoked",
  "scope_profile_revoked",
  // The resolved profile has no writable layer: the same current-policy
  // refusal family, surfaced from inside the shared runExtraction gate.
  "scope_profile_no_writable_layer",
  // captureMode=explicit: ordinary buffered conversation turns never create
  // memories; only deliberately accepted captures drain.
  "capture_mode_explicit",
]);

export interface BufferDrainRunnerOptions {
  /** Identity of this drainer; owns the lease it takes. */
  ownerId: string;
  /** Lease lifetime in ms. The heartbeat keeps it alive while draining. */
  leaseMs?: number;
  /** Cancels the run at the next chunk boundary. */
  signal?: AbortSignal;
  /** Progress callback (per session, and per claim transition). */
  onEvent?: (event: DrainRunnerEvent) => void;
}

/** A failed drain run: the reason a chunk or the session could not finish. */
export type DrainExtractionError = Error;

export type DrainRunnerEvent =
  | { type: "session_started"; key: string; turns: number }
  | { type: "session_finished"; key: string; outcome: DrainSessionOutcome };

const DEFAULT_LEASE_MS = 120_000;

/**
 * A `BufferStorage` view of one drain claim: the claim file IS the buffer.
 * Writes are the drain's progress (what is left to extract), so every
 * successfully extracted chunk is durably removed before the next one runs.
 */
export class ClaimBufferStorage implements BufferStorage {
  constructor(
    private readonly claims: BufferDrainClaims,
    private readonly key: string,
    private readonly ownerId: string,
    private readonly entry: BufferEntryState,
  ) {}

  async loadBuffer(): Promise<BufferState> {
    const entries: NonNullable<BufferState["entries"]> = Object.create(null);
    entries[this.key] = {
      turns: this.entry.turns,
      retainedTurns: this.entry.retainedTurns,
      lastExtractionAt: this.entry.lastExtractionAt,
      extractionCount: this.entry.extractionCount,
    };
    return {
      turns: this.entry.turns,
      lastExtractionAt: this.entry.lastExtractionAt,
      extractionCount: this.entry.extractionCount,
      entries,
    };
  }

  async saveBuffer(state: BufferState): Promise<void> {
    // Whole-state fallback (the claim covers one session): persist the entry.
    const entry = state.entries?.[this.key];
    await this.claims.writeEntry(this.key, this.ownerId, entry ?? { turns: [], lastExtractionAt: null, extractionCount: 0 }, this.entry);
  }

  async saveBufferSession(key: string, entry: BufferEntryState): Promise<void> {
    await this.claims.writeEntry(key, this.ownerId, entry, key === this.key ? this.entry : undefined);
  }

  async deleteBufferSession(): Promise<void> {
    // The claim is removed by the ack path, never by a buffer eviction: the
    // drain decides when the session is finished.
  }
}


/** Pending turns across canonical + retained copies (the honest backlog count). */
function pendingTurnCount(entry: BufferEntryState | undefined): number {
  if (!entry) return 0;
  return entry.turns.length + (entry.retainedTurns?.length ?? 0);
}

/** Load one claimed session. An unclaimed key is nothing to drain. */
async function loadClaimedSession(
  claims: BufferDrainClaims,
  key: string,
): Promise<{ kind: "notClaimed"; notClaimed: DrainSessionOutcome } | { kind: "claimed"; claim: { entry: BufferEntryState }; turnsAtStart: number }> {
  const claim = await claims.load(key);
  if (!claim) {
    return { kind: "notClaimed", notClaimed: { key, status: "skipped", turnsAtStart: 0, turnsRemaining: 0, persistedCount: 0, durableOutputCount: 0, reason: "not_claimed" } };
  }
  return { kind: "claimed", claim, turnsAtStart: pendingTurnCount(claim.entry) };
}

function busyLeaseOutcome(key: string, turnsAtStart: number): DrainSessionOutcome {
  return {
    key,
    status: "skipped",
    turnsAtStart,
    turnsRemaining: turnsAtStart,
    persistedCount: 0,
    durableOutputCount: 0,
    reason: "claimed_by_another_drain",
  };
}

/** Take the lease unless this drainer already holds it. A busy lease means
 *  another drainer owns the claim — skip without touching content. */
async function adoptLease(claims: BufferDrainClaims, key: string, ownerId: string, leaseMs: number): Promise<DrainSessionOutcome | null> {
  const held = await claims.adopt(key, {
    ownerId,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseMs,
  });
  return held === 'busy' ? busyLeaseOutcome(key, pendingTurnCount((await claims.load(key))?.entry)) : null;
}

function assembleOutcome(
  key: string,
  turnsAtStart: number,
  verdict: { status: DrainSessionStatus; reason?: string; turnsRemaining: number },
  counts: { persistedCount: number; durableOutputCount: number },
  denied: Map<string, number>,
): DrainSessionOutcome {
  const outcome: DrainSessionOutcome = {
    key,
    status: verdict.status,
    turnsAtStart,
    turnsRemaining: verdict.turnsRemaining,
    persistedCount: counts.persistedCount,
    durableOutputCount: counts.durableOutputCount,
  };
  if (denied.size > 0) outcome.denied = [...denied].map(([deniedReason, turns]) => ({ reason: deniedReason, turns }));
  if (verdict.reason !== undefined) outcome.reason = verdict.reason;
  return outcome;
}

/** Ack an EMPTY claim. The ack verdict is the truth: live ingress can merge
 *  between the empty read and the ack — a not_empty ack means pending work
 *  exists; reload it, release OUR lease, report deferred, never a false
 *  drained. */
async function ackEmptyClaim(claims: BufferDrainClaims, key: string, ownerId: string, turnsAtStart: number): Promise<DrainSessionOutcome> {
  const ackOutcome = await claims.ack(key, ownerId);
  if (ackOutcome !== "acked") {
    const reloaded = await claims.load(key);
    const turnsRemaining = pendingTurnCount(reloaded?.entry);
    await claims.releaseLease(key, ownerId);
    return {
      key,
      status: "deferred",
      turnsAtStart,
      turnsRemaining,
      persistedCount: 0,
      durableOutputCount: 0,
      reason: ackOutcome === "not_empty" ? "ack_not_empty" : "ack_not_owner",
    };
  }
  return { key, status: "drained", turnsAtStart, turnsRemaining: 0, persistedCount: 0, durableOutputCount: 0 };
}

/** Keep the lease alive while a long extraction runs; a lost lease means
 *  another drainer took the claim, so this run must stop instead of writing
 *  progress into a claim it no longer owns. A heartbeat that cannot be
 *  renewed is a lease that cannot be held — stop cleanly at the next chunk
 *  boundary (the next run resumes it). */
function startLeaseHeartbeat(claims: BufferDrainClaims, key: string, ownerId: string, leaseMs: number, abort: AbortController): NodeJS.Timeout {
  const heartbeat = setInterval(() => {
    void claims
      .heartbeat(key, ownerId, leaseMs)
      .then((state) => {
        if (state === "lost") abort.abort(new Error(`buffer drain: lease lost for session ${key}`));
      })
      .catch((err: Error) => {
        // A heartbeat that cannot be renewed is a lease that cannot be held:
        // stop this run cleanly at the next chunk boundary (the next run
        // resumes it).
        abort.abort(new Error(`buffer drain: lease heartbeat failed for session ${key}: ${describeError(err)}`));
      });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  return heartbeat;
}

/** The isolated per-task execution context: a claim-backed SmartBuffer, a
 *  coordinator bound to it, and the no-drop chunked drain. Built per
 *  invocation — the live buffer and every other drain task keep their own
 *  state, so two claim drains or a foreground observe can interleave safely. */
function buildClaimExecution(
  orchestrator: Orchestrator,
  claims: BufferDrainClaims,
  key: string,
  ownerId: string,
  claim: { entry: BufferEntryState },
): { claimBuffer: SmartBuffer; coordinator: TurnIngestionCoordinator; executionDrain: ExtractionDrain } {
  const claimBuffer = new SmartBuffer(orchestrator.config, new ClaimBufferStorage(claims, key, ownerId, claim.entry));
  const isolatedRun = orchestrator.extractionRunCoordinatorForBuffer(claimBuffer);
  const coordinator = new TurnIngestionCoordinator(selfDeps<TurnIngestionDeps>(orchestrator));
  const config = orchestrator.config;
  const ingestionDeps = selfDeps<TurnIngestionDeps>(orchestrator);
  // No-drop: a repeatedly failing chunk stays in the claim as durable
  // retryable backlog — never side-filed, never counted as processed.
  const executionDrain = new ExtractionDrain(
    {
      config: {
        extractionMinUserTurns: config.extractionMinUserTurns,
        extractionMinChars: config.extractionMinChars,
        extractionMaxTurnChars: config.extractionMaxTurnChars,
        extractionChunkDropAfterFailures: config.extractionChunkDropAfterFailures,
      },
      extractionWindowBudgetChars: () => ingestionDeps.extractionWindowBudgetChars?.() ?? Number.POSITIVE_INFINITY,
      // Render-exact chunk sizing: the model clamp bounds the CONVERSATION
      // (truncateLocalExtractionConversation), so measure exactly that —
      // with the SAME source-classification gate extract() applies when it
      // prepends the connector header (header margin included when the
      // engine would render it).
      measureRenderedTurns: (turns) => {
        const sourceConnector = resolveMemoryLifecycleCapabilities(config).extractionScopeClassification
          ? resolveSourceConnector(turns)
          : undefined;
        return renderExtractionConversation(
          turns.map((turn) => ({ ...turn, content: turn.content.trim().slice(0, config.extractionMaxTurnChars) })),
          headerConnector(sourceConnector),
        ).conversation.length;
      },
      runExtraction: (turns, runOptions) => isolatedRun.runExtraction(turns, runOptions),
      getStorage: () => ingestionDeps.getStorage(),
      buffer: claimBuffer,
    },
    { dropFailedChunks: false },
  );
  return { claimBuffer, coordinator, executionDrain };
}

/** Plan semantics for one scope group: a pinned plan forwards as-is; a
 *  planless ACCEPTED group pins null (existing flush behavior); unpinned
 *  legacy groups pass NO option so runExtraction resolves the CURRENT
 *  profile. */
function planOptionForGroup(group: ExtractionScopeGroup): { scopeProfileWritePlan?: ResolvedScopeProfilePlan | null } {
  if (group.scopeProfileWritePlan !== undefined) return { scopeProfileWritePlan: group.scopeProfileWritePlan };
  if (group.turns.some((turn) => turn.acceptedCapture === true)) return { scopeProfileWritePlan: null };
  return {};
}

/** captureMode=explicit: ordinary buffered conversation turns never create
 *  memories — only deliberately accepted captures drain. */
function explicitModeDenied(group: ExtractionScopeGroup, config: PluginConfig): boolean {
  return shouldSkipImplicitExtraction(config) && !group.turns.some((turn) => turn.acceptedCapture === true);
}

interface GroupOutcome {
  turns: number;
  result?: ExtractionRunResult;
}

interface ScopeDrainContext {
  config: PluginConfig;
  key: string;
  signal: AbortSignal;
  claimBuffer: SmartBuffer;
  coordinator: TurnIngestionCoordinator;
  executionDrain: ExtractionDrain;
  turns: BufferTurn[];
}

/** Drain a claimed session's turns ONE captured-scope group at a time: each
 *  group keeps its own namespace/principal/plan pins, and the shared
 *  extraction boundary re-applies CURRENT authorization from the turn's
 *  ORIGINAL coding binding before any write. Groups run sequentially (FIFO
 *  per key — the queue's same-key exclusion would serialize them anyway); a
 *  denied group never blocks or clears the other groups. */
async function drainScopeGroups(ctx: ScopeDrainContext): Promise<{ groupOutcomes: GroupOutcome[]; groupError?: DrainExtractionError }> {
  const groupOutcomes: GroupOutcome[] = [];
  let groupError: DrainExtractionError | undefined;
  for (const group of groupTurnsByExtractionScope(ctx.turns)) {
    if (ctx.signal.aborted) break;
    if (explicitModeDenied(group, ctx.config)) {
      log.warn(
        `buffer drain: session ${ctx.key} denied capture_mode_explicit (${group.turns.length} ordinary turn(s) retained)`,
      );
      groupOutcomes.push({
        turns: group.turns.length,
        result: { status: "skipped", reason: "capture_mode_explicit", persistedCount: 0, durableOutputCount: 0 },
      });
      continue;
    }
    const { promise, resolve } = Promise.withResolvers<{ error?: unknown; result?: ExtractionRunResult }>();
    let done = false;
    const settle = (error?: unknown, result?: ExtractionRunResult): void => {
      if (done) return;
      done = true;
      resolve({ error, result });
    };
    void ctx.coordinator
      .queueBufferedExtraction(group.turns, "trigger_mode", {
        bufferKey: ctx.key,
        clearBufferAfterExtraction: true,
        clearMatchingTurns: true,
        skipDedupeCheck: true,
        skipCharThreshold: true,
        skipUserTurnThreshold: true,
        abortSignal: ctx.signal,
        writeNamespaceOverride: group.writeNamespaceOverride,
        principalOverride: group.principalOverride,
        ...planOptionForGroup(group),
        execution: { buffer: ctx.claimBuffer, drain: ctx.executionDrain },
        onTaskSettled: settle,
      })
      .catch((error: DrainExtractionError) => settle(error));
    const settled = await promise;
    if (settled.error !== undefined) {
      groupError = settled.error as DrainExtractionError;
      break;
    }
    groupOutcomes.push({ turns: group.turns.length, result: settled.result });
  }
  return { groupOutcomes, groupError };
}

/** Denied scope groups: policy refusals leave their turns pending (the group
 *  result's turns were NOT cleared), aggregated per reason so a drain is
 *  never reported complete while denied backlog remains. */
function deniedByReason(groupOutcomes: readonly GroupOutcome[]): Map<string, number> {
  const denied = new Map<string, number>();
  for (const entry of groupOutcomes) {
    if (entry.result?.status !== "skipped" || !DENIED_SCOPE_REASONS.has(entry.result.reason ?? "")) continue;
    denied.set(entry.result.reason!, (denied.get(entry.result.reason!) ?? 0) + entry.turns);
  }
  return denied;
}

function lastGroupReason(groupOutcomes: readonly GroupOutcome[]): string | undefined {
  for (let index = groupOutcomes.length - 1; index >= 0; index -= 1) {
    const reason = groupOutcomes[index]?.result?.reason;
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Settle the drain verdict. Everything extracted: the claim is finished and
 *  the session file is gone for good — but the ack verdict is the truth (live
 *  ingress merged between our read and the ack leaves the claim non-empty:
 *  report deferred, never a false drained). A failed run and a deferred run
 *  keep the remaining turns for the next attempt. */
async function settleDrainVerdict(
  claims: BufferDrainClaims,
  key: string,
  ownerId: string,
  groupOutcomes: readonly GroupOutcome[],
  groupError: DrainExtractionError | undefined,
  turnsRemaining: number,
): Promise<{ status: DrainSessionStatus; reason?: string; turnsRemaining: number }> {
  if (turnsRemaining === 0) return await ackOrReload(claims, key, ownerId);
  if (groupError) {
    await claims.releaseLease(key, ownerId);
    return { status: "failed", reason: describeError(groupError), turnsRemaining };
  }
  await claims.releaseLease(key, ownerId);
  const reason =
    groupOutcomes.find((entry) => entry.result?.reason !== undefined && DENIED_SCOPE_REASONS.has(entry.result.reason!))?.result?.reason ??
    lastGroupReason(groupOutcomes) ??
    "deferred";
  return { status: "deferred", reason, turnsRemaining };
}

/** Ack an emptied claim; a not-acked verdict means live ingress merged (or
 *  the lease moved) — reload the honest pending count and release OUR lease,
 *  keeping the source. */
async function ackOrReload(
  claims: BufferDrainClaims,
  key: string,
  ownerId: string,
): Promise<{ status: DrainSessionStatus; reason?: string; turnsRemaining: number }> {
  const ackOutcome = await claims.ack(key, ownerId);
  if (ackOutcome === 'acked') return { status: 'drained', turnsRemaining: 0 };
  const reloaded = await claims.load(key);
  const turnsRemaining = pendingTurnCount(reloaded?.entry);
  await claims.releaseLease(key, ownerId);
  return { status: 'deferred', reason: ackOutcome === 'not_empty' ? 'ack_not_empty' : 'ack_not_owner', turnsRemaining };
}

function groupCounts(groupOutcomes: readonly GroupOutcome[]): { persistedCount: number; durableOutputCount: number } {
  return {
    persistedCount: groupOutcomes.reduce((sum, entry) => sum + (entry.result?.persistedCount ?? 0), 0),
    durableOutputCount: groupOutcomes.reduce((sum, entry) => sum + (entry.result?.durableOutputCount ?? 0), 0),
  };
}

export interface DrainScanEntry {
  key: string;
  turns: number;
  claimed: boolean;
}

/** Session-buffer listings: a claimed session reports its CLAIM's pending
 *  count (the live buffer copy may lag the claim), an unclaimed one its
 *  buffer entry. */
async function bufferSessionListings(
  claims: BufferDrainClaims,
  entries: Record<string, BufferEntryState>,
): Promise<{ listings: DrainScanEntry[]; seen: Set<string> }> {
  const listings: DrainScanEntry[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(entries)) {
    seen.add(key);
    const claim = claims.isClaimed(key) ? await claims.load(key) : null;
    listings.push({ key, turns: claim ? pendingTurnCount(claim.entry) : pendingTurnCount(entry), claimed: claim !== null });
  }
  return { listings, seen };
}

/** Claims the buffer state no longer lists (drained by an earlier run whose
 *  claim file outlived its session file). */
async function orphanClaimListings(claims: BufferDrainClaims, seen: Set<string>): Promise<DrainScanEntry[]> {
  const out: DrainScanEntry[] = [];
  for (const listed of await claims.list()) {
    if (seen.has(listed.key)) continue;
    out.push({ key: listed.key, turns: listed.turnCount, claimed: true });
  }
  return out;
}

/** The drain runs on the caller's abort signal combined with this run's own
 *  lease-loss controller. */
function drainAbortSignal(callerSignal: AbortSignal | undefined, abort: AbortController): AbortSignal {
  return callerSignal ? AbortSignal.any([callerSignal, abort.signal]) : abort.signal;
}

/** One heartbeat-protected claim drain: run every scope group, settle the
 *  verdict against the claim store, and assemble the honest outcome. The
 *  heartbeat is cleared by the caller on every exit path. */
async function runClaimDrain(
  ctx: {
    orchestrator: Orchestrator;
    claims: BufferDrainClaims;
    key: string;
    ownerId: string;
    claimBuffer: SmartBuffer;
    coordinator: TurnIngestionCoordinator;
    executionDrain: ExtractionDrain;
    turns: BufferTurn[];
    turnsAtStart: number;
    config: PluginConfig;
    signal: AbortSignal;
  },
  options: BufferDrainRunnerOptions,
  heartbeat: NodeJS.Timeout,
): Promise<DrainSessionOutcome> {
  // An emptied claim acks here: the ack verdict is the truth (drained), or
  // live ingress merged between the read and the ack — deferred, source kept.
  if (ctx.turns.length === 0) {
    const outcome = await ackEmptyClaim(ctx.claims, ctx.key, ctx.ownerId, ctx.turnsAtStart);
    options.onEvent?.({ type: "session_finished", key: ctx.key, outcome });
    return outcome;
  }
  const { groupOutcomes, groupError } = await drainScopeGroups(ctx);
  // Heartbeat cleared on EVERY exit path: a rejected drain must not keep
  // renewing the lease forever (cleared in the caller's finally).
  const remaining = await ctx.claims.load(ctx.key);
  const { status, reason, turnsRemaining } = await settleDrainVerdict(
    ctx.claims,
    ctx.key,
    ctx.ownerId,
    groupOutcomes,
    groupError,
    pendingTurnCount(remaining?.entry),
  );
  const outcome = assembleOutcome(
    ctx.key,
    ctx.turnsAtStart,
    { status, reason, turnsRemaining },
    groupCounts(groupOutcomes),
    deniedByReason(groupOutcomes),
  );
  log.info(`buffer drain: session ${ctx.key} ${status} (${outcome.turnsRemaining} turn(s) remaining)`);
  options.onEvent?.({ type: "session_finished", key: ctx.key, outcome });
  return outcome;
}


export class BufferDrainRunner {
  constructor(private readonly orchestrator: Orchestrator) {}

  /** The claim store of this orchestrator's memory root. */
  get claims(): BufferDrainClaims {
    return this.orchestrator.storage.bufferDrainClaims();
  }

  /**
   * Drain one claimed session. The caller owns the lease (it may have taken
   * it already); this method verifies ownership before touching content.
   */
  async drainSession(key: string, options: BufferDrainRunnerOptions): Promise<DrainSessionOutcome> {
    const claims = this.claims;
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const claimed = await loadClaimedSession(claims, key);
    if (claimed.kind === 'notClaimed') return claimed.notClaimed;
    const { claim, turnsAtStart } = claimed;
    options.onEvent?.({ type: "session_started", key, turns: turnsAtStart });

    // Take the lease unless this drainer already holds it.
    const busy = await adoptLease(claims, key, options.ownerId, leaseMs);
    if (busy !== null) {
      const outcome = busy;
      options.onEvent?.({ type: "session_finished", key, outcome });
      return outcome;
    }

    // The claim is the buffer for this run: every successful chunk is removed
    // from it, so a kill leaves exactly the un-extracted turns.
    const { claimBuffer, coordinator, executionDrain } = buildClaimExecution(this.orchestrator, claims, key, options.ownerId, claim);
    await claimBuffer.load();

    // The claim's turns (retained first, like the live buffer's order).
    const turns = [...(claim.entry.retainedTurns ?? []), ...claim.entry.turns];

    // A lost lease means another drainer took the claim: stop instead of
    // writing progress into a claim this run no longer owns.
    const abort = new AbortController();
    const signal = drainAbortSignal(options.signal, abort);
    const heartbeat = startLeaseHeartbeat(claims, key, options.ownerId, leaseMs, abort);
    try {
      return await runClaimDrain(
        { orchestrator: this.orchestrator, claims, key, ownerId: options.ownerId, claimBuffer, coordinator, executionDrain, turns, turnsAtStart, config: this.orchestrator.config, signal },
        options,
        heartbeat,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Claim a session file for the drain. Returns false when it is not claimable. */
  async claim(key: string, ownerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    const lease: DrainLease = {
      ownerId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs,
    };
    return (await this.claims.claimFromSessionFile(key, lease)) === "claimed";
  }

  /** Sessions with buffered turns, claimed or not (CLI scan). */
  async scan(): Promise<DrainScanEntry[]> {
    const sessions = await this.orchestrator.storage.loadBuffer();
    const { listings, seen } = await bufferSessionListings(this.claims, sessions.entries ?? {});
    return [...listings, ...(await orphanClaimListings(this.claims, seen))];
  }
}
