/**
 * Action-site failure gate (issue #2382, slice 1 — core contract).
 *
 * The H6 study (#1963) measured that a failure memory delivered in the prompt
 * preamble barely changes behaviour, while the same memory delivered at the
 * moment the agent proposes the matched action removes the repeated failure.
 * This module productionises that delivery point: `ActionGateService` wraps the
 * experimental `PreActionFailureGate` primitive, adds failure-class memory
 * candidates, a per-turn budget, cross-channel suppression, and telemetry.
 *
 * Scope, per the study's honest limit: the gate removes a known failure mode.
 * It does not improve task completion. It is advisory only — it never blocks an
 * action, never outruns its deadline, and fails open on every error path.
 */
import type { ActionIntent, ActionStrategyId } from "../causal-trajectory.js";
import { coerceBool, coerceNumber } from "../connectors/coerce.js";
import type { CodingContext, MemoryFile } from "../types.js";
import {
  PRE_ACTION_GATE_DEFAULT_TIMEOUT_MS,
  type PreActionFailureGate,
  normalizeActionIntent,
  sanitizePayloadString,
} from "./pre-action-gate.js";

export const ACTION_GATE_DEFAULT_MAX_ADVISORIES_PER_TURN = 3;
/** Bound on a single advisory payload, above the primitive's citation bound. */
const MAX_ADVISORY_CHARS = 400;
/** Bounded lexical matching: terms considered from one proposed action. */
const MAX_ACTION_TERMS = 24;
const MIN_TERM_CHARS = 3;
/** Fraction of action terms a failure memory must mention to be a candidate. */
const MIN_TERM_OVERLAP_RATIO = 0.6;
/** Sessions tracked for suppression before the oldest is evicted. */
const MAX_TRACKED_SESSIONS = 200;
/** Memory ids remembered per session for cross-channel suppression. */
const MAX_TRACKED_IDS_PER_SESSION = 200;

export interface ActionGateConfig {
  /**
   * Master gate. Default `false`: when disabled no lookup, no matching, and no
   * suppression bookkeeping runs on any path.
   */
  enabled: boolean;
  /** Hard latency cap for a whole gate evaluation. Overrun fails open. */
  timeoutMs: number;
  /** Advisories injected per turn. `0` disables injection and all lookups. */
  maxAdvisoriesPerTurn: number;
}

export const ACTION_GATE_DEFAULTS: ActionGateConfig = {
  enabled: false,
  timeoutMs: PRE_ACTION_GATE_DEFAULT_TIMEOUT_MS,
  maxAdvisoriesPerTurn: ACTION_GATE_DEFAULT_MAX_ADVISORIES_PER_TURN,
};

export function parseActionGateConfig(raw: unknown): ActionGateConfig {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(
      `actionGate must be an object (got ${JSON.stringify(raw)}). Use actionGate: { enabled: true } to opt in.`
    );
  }
  const block = (raw ?? {}) as Record<string, unknown>;
  const rawEnabled = block.enabled;
  let enabled = ACTION_GATE_DEFAULTS.enabled;
  if (rawEnabled !== undefined) {
    const coerced = coerceBool(rawEnabled);
    if (coerced === undefined) {
      throw new Error(
        `actionGate.enabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(rawEnabled)}).`
      );
    }
    enabled = coerced;
  }
  const rawTimeout = coerceNumber(block.timeoutMs);
  const timeoutMs =
    rawTimeout !== undefined && Number.isFinite(rawTimeout)
      ? Math.min(5000, Math.max(1, Math.floor(rawTimeout)))
      : ACTION_GATE_DEFAULTS.timeoutMs;
  const rawMax = coerceNumber(block.maxAdvisoriesPerTurn);
  // Zero-limit semantics are a compatibility contract: `0` stays `0`.
  const maxAdvisoriesPerTurn =
    rawMax !== undefined && Number.isFinite(rawMax)
      ? Math.min(20, Math.max(0, Math.floor(rawMax)))
      : ACTION_GATE_DEFAULTS.maxAdvisoriesPerTurn;
  return { enabled, timeoutMs, maxAdvisoriesPerTurn };
}

export type ActionGateStatus = "DISABLED" | "NO_MATCH" | "MATCH_WARN" | "ERROR_FAIL_OPEN";

export interface ActionGateRequest {
  sessionKey: string;
  /** Turn identity: the per-turn budget and dedupe reset when this changes. */
  turnId: string;
  strategyId: ActionStrategyId;
  intent: ActionIntent;
  codingContext: CodingContext;
  /** Memory directory ALREADY resolved for the caller's readable namespace. */
  memoryDir: string;
  /** Resolved readable namespace, passed verbatim to candidate sources. */
  namespace?: string;
  causalTrajectoryStoreDir?: string;
  signal?: AbortSignal;
}

export interface ActionGateAdvisory {
  /** Trajectory id or memory id — the unit of dedupe and suppression. */
  memoryId: string;
  sourceId: string;
  text: string;
}

export interface ActionGateDecision {
  status: ActionGateStatus;
  advisories: ActionGateAdvisory[];
  /** Candidates withheld: already delivered this turn/session, or over budget. */
  suppressedIds: string[];
  /** Source failures, kept distinct from "no candidates" (rule 22). */
  degradations: string[];
  fingerprint?: string;
  reason?: string;
  latencyMs: number;
}

export interface ActionGateCandidate {
  memoryId: string;
  advisoryText: string;
  /** Deterministic ranking key; higher wins, ties break on `memoryId`. */
  score?: number;
}

export interface ActionGateCandidateQuery {
  sessionKey: string;
  fingerprint: string;
  /** Normalized, deduplicated lexical terms describing the proposed action. */
  actionTerms: string[];
  strategyId: ActionStrategyId;
  intent: ActionIntent;
  codingContext: CodingContext;
  memoryDir: string;
  namespace?: string;
  causalTrajectoryStoreDir?: string;
  signal?: AbortSignal;
}

export type ActionGateSourceResult = { ok: true; candidates: ActionGateCandidate[] } | { ok: false; reason: string };

export interface ActionGateCandidateSource {
  readonly id: string;
  find(query: ActionGateCandidateQuery): Promise<ActionGateSourceResult>;
}

export interface ActionGateAuditRecord {
  ts: string;
  sessionKey: string;
  turnId: string;
  status: ActionGateStatus;
  latencyMs: number;
  fingerprint?: string;
  deliveredIds: string[];
  suppressedIds: string[];
  degradations: string[];
  reason?: string;
}

export type ActionGateAuditSink = (record: ActionGateAuditRecord) => void | Promise<void>;

export interface ActionGateServiceDependencies {
  sources?: ActionGateCandidateSource[];
  audit?: ActionGateAuditSink;
  clock?: () => number;
  now?: () => Date;
}

/**
 * Deterministic, local term extraction from a proposed action. No LLM and no
 * I/O: this runs in the hot path ahead of the tool call.
 */
export function actionTermsFor(intent: ActionIntent): string[] {
  const raw =
    intent.kind === "command"
      ? [intent.command, ...(intent.args ?? [])]
      : [intent.filePath, intent.editKind, intent.symbol ?? "", intent.range ?? ""];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw) {
    for (const token of sanitizePayloadString(piece ?? "")
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)) {
      const term = token.replace(/^[._-]+|[._-]+$/g, "");
      if (term.length < MIN_TERM_CHARS || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= MAX_ACTION_TERMS) return terms;
    }
  }
  return terms;
}

/**
 * Failure-class markers on stored memories, read from frontmatter only so the
 * decision stays deterministic: explicit corrections, procedures flagged for
 * repair by library maintenance, and memories whose recorded outcomes are
 * failure-dominant.
 */
export function isFailureClassMemory(memory: MemoryFile): boolean {
  const fm = memory.frontmatter;
  if (fm.status !== undefined && fm.status !== "active") return false;
  if (fm.category === "correction") return true;
  if (fm.structuredAttributes?.needsRepair === "true") return true;
  const failures = typeof fm.mw_fail === "number" ? fm.mw_fail : 0;
  const successes = typeof fm.mw_success === "number" ? fm.mw_success : 0;
  return failures > 0 && failures > successes;
}

export interface FailureMemorySourceDependencies {
  /**
   * Namespace-scoped listing of candidate memories. Callers wire this to a
   * storage read for the SAME namespace the gate request resolved, so a
   * principal can never receive another principal's advisories.
   */
  listMemories: (options: {
    namespace?: string;
    memoryDir: string;
    signal?: AbortSignal;
  }) => Promise<MemoryFile[]>;
}

/**
 * Failure-class memory candidates, matched by bounded lexical overlap against
 * the proposed action's terms. Deterministic and local by construction.
 */
export function createFailureMemoryCandidateSource(deps: FailureMemorySourceDependencies): ActionGateCandidateSource {
  return {
    id: "failure-memory",
    async find(query) {
      if (query.actionTerms.length === 0) return { ok: true, candidates: [] };
      let memories: MemoryFile[];
      try {
        memories = await deps.listMemories({
          namespace: query.namespace,
          memoryDir: query.memoryDir,
          signal: query.signal,
        });
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const required = Math.max(1, Math.ceil(query.actionTerms.length * MIN_TERM_OVERLAP_RATIO));
      const candidates: ActionGateCandidate[] = [];
      for (const memory of memories) {
        if (!isFailureClassMemory(memory)) continue;
        const haystack = `${memory.content} ${(memory.frontmatter.tags ?? []).join(" ")}`.toLowerCase();
        let hits = 0;
        for (const term of query.actionTerms) if (haystack.includes(term)) hits += 1;
        if (hits < required) continue;
        candidates.push({
          memoryId: memory.frontmatter.id,
          score: hits,
          advisoryText: `[ActionGate] A stored failure memory matches this action: "${memory.content}".`,
        });
      }
      candidates.sort((left, right) => {
        const byScore = (right.score ?? 0) - (left.score ?? 0);
        return byScore !== 0 ? byScore : left.memoryId.localeCompare(right.memoryId);
      });
      return { ok: true, candidates };
    },
  };
}

/**
 * Candidate source over recorded causal-trajectory failures, delegating the
 * fingerprint match to the existing `PreActionFailureGate` primitive.
 */
export function createTrajectoryCandidateSource(gate: PreActionFailureGate): ActionGateCandidateSource {
  return {
    id: "causal-trajectory",
    async find(query) {
      const result = await gate.evaluate({
        sessionKey: query.sessionKey,
        strategyId: query.strategyId,
        intent: query.intent,
        codingContext: query.codingContext,
        memoryDir: query.memoryDir,
        causalTrajectoryStoreDir: query.causalTrajectoryStoreDir,
        signal: query.signal,
      });
      if (result.status === "ERROR_FAIL_OPEN") {
        return { ok: false, reason: result.reason ?? "pre-action gate failed open" };
      }
      if (result.status !== "MATCH_WARN" || !result.matchedTrajectoryId || !result.advisoryText) {
        return { ok: true, candidates: [] };
      }
      return {
        ok: true,
        candidates: [
          {
            memoryId: result.matchedTrajectoryId,
            // Trajectory matches are exact fingerprint hits: rank above lexical ones.
            score: Number.MAX_SAFE_INTEGER,
            advisoryText: result.advisoryText,
          },
        ],
      };
    },
  };
}

interface SessionSuppression {
  turnId: string;
  /** Ids the gate delivered during `turnId`. */
  deliveredThisTurn: Set<string>;
  /** Ids the gate delivered anywhere in the session; turn-start must skip them. */
  deliveredByGate: Set<string>;
  /** Ids turn-start injection already delivered; the gate must skip them. */
  deliveredByTurnStart: Set<string>;
}

/**
 * Advisory gate evaluated immediately before an agent action.
 *
 * Delivery is bounded three ways: a hard deadline, `maxAdvisoriesPerTurn`, and
 * dedupe per memory per turn. Cross-channel suppression keeps one memory from
 * arriving twice in a session — once here and once from turn-start recall.
 */
export class ActionGateService {
  private readonly config: ActionGateConfig;
  private readonly sources: ActionGateCandidateSource[];
  private readonly audit?: ActionGateAuditSink;
  private readonly clock: () => number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionSuppression>();

  constructor(config: ActionGateConfig, deps: ActionGateServiceDependencies = {}) {
    this.config = config;
    this.sources = deps.sources ?? [];
    this.audit = deps.audit;
    this.clock = deps.clock ?? Date.now;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Memory ids the gate already delivered in this session. Turn-start recall
   * filters these out before its own cap, honouring the filter-then-cap order.
   */
  public suppressedForTurnStart(sessionKey: string): string[] {
    if (!this.config.enabled) return [];
    return [...(this.sessions.get(sessionKey)?.deliveredByGate ?? [])];
  }

  /** Record ids turn-start recall injected, so the gate will not repeat them. */
  public noteTurnStartDelivery(sessionKey: string, memoryIds: readonly string[]): void {
    if (!this.config.enabled || memoryIds.length === 0) return;
    const state = this.sessionState(sessionKey, undefined);
    for (const id of memoryIds) this.addTracked(state.deliveredByTurnStart, id);
  }

  public resetSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  async evaluate(request: ActionGateRequest): Promise<ActionGateDecision> {
    const startedAt = this.clock();
    if (!this.config.enabled) {
      return {
        status: "DISABLED",
        advisories: [],
        suppressedIds: [],
        degradations: [],
        reason: "actionGate.enabled is false",
        latencyMs: 0,
      };
    }
    if (this.config.maxAdvisoriesPerTurn === 0) {
      return this.finish(request, startedAt, {
        status: "DISABLED",
        advisories: [],
        suppressedIds: [],
        degradations: [],
        reason: "actionGate.maxAdvisoriesPerTurn is 0",
      });
    }

    let fingerprint: string;
    try {
      fingerprint = normalizeActionIntent(request.intent, request.strategyId, request.codingContext).fingerprint;
    } catch (error) {
      return this.finish(request, startedAt, {
        status: "ERROR_FAIL_OPEN",
        advisories: [],
        suppressedIds: [],
        degradations: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const deadline = startedAt + this.config.timeoutMs;
    const collected = await this.collect(request, fingerprint, deadline);
    const state = this.sessionState(request.sessionKey, request.turnId);
    const advisories: ActionGateAdvisory[] = [];
    const suppressedIds: string[] = [];
    for (const { sourceId, candidate } of collected.candidates) {
      if (state.deliveredThisTurn.has(candidate.memoryId) || state.deliveredByTurnStart.has(candidate.memoryId)) {
        suppressedIds.push(candidate.memoryId);
        continue;
      }
      if (advisories.length >= this.config.maxAdvisoriesPerTurn) {
        suppressedIds.push(candidate.memoryId);
        continue;
      }
      advisories.push({
        memoryId: candidate.memoryId,
        sourceId,
        text: sanitizePayloadString(candidate.advisoryText).replace(/\s+/g, " ").slice(0, MAX_ADVISORY_CHARS),
      });
      this.addTracked(state.deliveredThisTurn, candidate.memoryId);
      this.addTracked(state.deliveredByGate, candidate.memoryId);
    }

    const status: ActionGateStatus =
      advisories.length > 0 ? "MATCH_WARN" : collected.degradations.length > 0 ? "ERROR_FAIL_OPEN" : "NO_MATCH";
    return this.finish(request, startedAt, {
      status,
      advisories,
      suppressedIds,
      degradations: collected.degradations,
      fingerprint,
      reason: status === "ERROR_FAIL_OPEN" ? collected.degradations[0] : undefined,
    });
  }

  private async collect(
    request: ActionGateRequest,
    fingerprint: string,
    deadline: number
  ): Promise<{
    candidates: Array<{ sourceId: string; candidate: ActionGateCandidate }>;
    degradations: string[];
  }> {
    if (this.sources.length === 0) return { candidates: [], degradations: [] };
    const timeoutAbort = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutAbort.signal])
      : timeoutAbort.signal;
    const query: ActionGateCandidateQuery = {
      sessionKey: request.sessionKey,
      fingerprint,
      actionTerms: actionTermsFor(request.intent),
      strategyId: request.strategyId,
      intent: request.intent,
      codingContext: request.codingContext,
      memoryDir: request.memoryDir,
      namespace: request.namespace,
      causalTrajectoryStoreDir: request.causalTrajectoryStoreDir,
      signal,
    };
    const remaining = Math.max(1, deadline - this.clock());
    let onTimeout!: (value: ActionGateSourceResult) => void;
    const timeoutResult = new Promise<ActionGateSourceResult>((resolve) => {
      onTimeout = resolve;
    });
    const timer = setTimeout(() => {
      timeoutAbort.abort();
      onTimeout({ ok: false, reason: `action gate timed out after ${this.config.timeoutMs}ms` });
    }, remaining);
    try {
      const settled = await Promise.all(
        this.sources.map(async (source) => {
          let result: ActionGateSourceResult;
          try {
            result = await Promise.race([source.find(query), timeoutResult]);
          } catch (error) {
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
          }
          return { source, result };
        })
      );
      const candidates: Array<{ sourceId: string; candidate: ActionGateCandidate }> = [];
      const degradations: string[] = [];
      for (const { source, result } of settled) {
        if (!result.ok) {
          degradations.push(`${source.id}: ${result.reason}`);
          continue;
        }
        for (const candidate of result.candidates) candidates.push({ sourceId: source.id, candidate });
      }
      candidates.sort((left, right) => {
        const byScore = (right.candidate.score ?? 0) - (left.candidate.score ?? 0);
        if (byScore !== 0) return byScore;
        const bySource = left.sourceId.localeCompare(right.sourceId);
        return bySource !== 0 ? bySource : left.candidate.memoryId.localeCompare(right.candidate.memoryId);
      });
      return { candidates, degradations };
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(
    request: ActionGateRequest,
    startedAt: number,
    decision: Omit<ActionGateDecision, "latencyMs">
  ): ActionGateDecision {
    const latencyMs = Math.max(0, this.clock() - startedAt);
    const result: ActionGateDecision = { ...decision, latencyMs };
    if (this.audit) {
      const record: ActionGateAuditRecord = {
        ts: this.now().toISOString(),
        sessionKey: request.sessionKey,
        turnId: request.turnId,
        status: result.status,
        latencyMs,
        fingerprint: result.fingerprint,
        deliveredIds: result.advisories.map((advisory) => advisory.memoryId),
        suppressedIds: result.suppressedIds,
        degradations: result.degradations,
        reason: result.reason,
      };
      // Telemetry must never break the action it observes.
      void Promise.resolve()
        .then(() => this.audit?.(record))
        .catch(() => undefined);
    }
    return result;
  }

  private sessionState(sessionKey: string, turnId: string | undefined): SessionSuppression {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      state = {
        turnId: turnId ?? "",
        deliveredThisTurn: new Set(),
        deliveredByGate: new Set(),
        deliveredByTurnStart: new Set(),
      };
      this.sessions.set(sessionKey, state);
    }
    if (turnId !== undefined && state.turnId !== turnId) {
      state.turnId = turnId;
      state.deliveredThisTurn.clear();
    }
    return state;
  }

  private addTracked(set: Set<string>, value: string): void {
    if (set.has(value)) return;
    if (set.size >= MAX_TRACKED_IDS_PER_SESSION) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    set.add(value);
  }
}
