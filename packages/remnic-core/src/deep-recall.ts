/**
 * Budgeted deep-recall loop (issue #2332, harmonic series P4).
 *
 * REFINE / EXPAND / STOP retrieval over the abstraction-node + cue-anchor
 * graph built by issue #2329, blended with QMD search. This is the deep
 * surface ONLY — never wired into `before_prompt_build` or any recall
 * section (that latency disqualifies the hot path; see the issue).
 *
 * The loop is dependency-injected: seeding, graph loading, memory loading,
 * and the policy LLM call arrive as `DeepRecallDeps`, so the loop is
 * deterministic under a scripted fake policy (tests) and thin when the
 * access service wires real deps. Pure decision helpers are reused from
 * the `recall-deep-*` primitives — never re-implemented here.
 */

import { z } from "zod";
import type { AbstractionNode } from "./abstraction-nodes.js";
import type { CueAnchor } from "./cue-anchors.js";
import { compareDeterministicStrings } from "./deterministic-order.js";
import { abortError, isAbortError, raceAbort, throwIfAborted } from "./abort-error.js";
import { extractJsonCandidates, stripCodeFences } from "./json-extract.js";
import { rankDeepRecallFrontier } from "./recall-deep-frontier.js";
import { selectExpandNodeIds } from "./recall-deep-expand-select.js";
import { validateRefineRewrite } from "./recall-deep-rewrite.js";
import type { DeepRecallConfig } from "./deep-recall-config.js";

export type { DeepRecallConfig } from "./deep-recall-config.js";

export interface DeepRecallEntry {
  memoryId: string;
  /** Trimmed to 500 chars for state rendering; full content only in final output. */
  content: string;
  /** Seed similarity, or expansion inheritance (parent score * 0.8). */
  score: number;
  origin: "seed" | "refine" | "expand";
  /** anchorValue that linked the entry, when origin === "expand". */
  viaAnchor?: string;
}

export interface DeepRecallFrontierItem {
  nodeId: string;
  title: string;
  /** e.g. `shares anchor "<anchorValue>" with <memoryId>`. */
  reason: string;
  sharedAnchorCount: number;
  /** Working-set memory the anchor was shared with; drives expansion scoring. */
  parentMemoryId: string;
  parentScore: number;
  anchorValue: string;
}

export interface DeepRecallTraceStep {
  step: number;
  action: "REFINE" | "EXPAND" | "STOP" | "BUDGET_EXHAUSTED";
  /** Rewritten query, chosen nodeIds, or stop reason. */
  detail: string;
  workingSetSize: number;
  frontierSize: number;
  durationMs: number;
}

export interface DeepRecallResult {
  /** false only for backend failure — NEVER conflated with empty (§22). */
  ok: boolean;
  error?: "backend_unavailable" | "timeout" | "disabled";
  entries: DeepRecallEntry[];
  trace: DeepRecallTraceStep[];
}

export interface DeepRecallGraphSnapshot {
  nodes: AbstractionNode[];
  anchors: CueAnchor[];
}

export interface DeepRecallSeedHit {
  memoryId: string;
  score: number;
}

export type DeepRecallSeedResult =
  | { ok: true; results: DeepRecallSeedHit[] }
  | { ok: false; error: "backend_unavailable" };

export interface DeepRecallMemoryView {
  memoryId: string;
  content: string;
  active: boolean;
}

export interface DeepRecallDeps {
  config: DeepRecallConfig;
  /** QMD (or equivalent) seed search. A thrown error means backend failure. */
  searchSeed(query: string, limit: number): Promise<DeepRecallSeedHit[]>;
  /** Nodes + anchors, loaded once per invocation. */
  loadGraph(): Promise<DeepRecallGraphSnapshot>;
  /** Namespace-scoped memory-by-id read; null when absent from the caller's namespace (§30). */
  loadMemory(memoryId: string): Promise<DeepRecallMemoryView | null>;
  /**
   * Raw policy LLM output (JSON text); null when the call failed. The
   * per-call timeout already spans both LLM legs (issue #2915).
   */
  callPolicy(statePrompt: string, timeoutMs: number): Promise<string | null>;
  /**
   * Cancellation from the transport (MCP tools/call cancelled, HTTP client
   * disconnected — issue #2915). Checked before every step and raced against
   * every dependency call; an abort surfaces as a standard AbortError, which
   * both transports already translate (silently end the dead socket / rethrow
   * the cancellation) instead of a partial `ok: true` result.
   */
  signal?: AbortSignal;
  nowMs?(): number;
}

const PolicyActionSchema = z.object({
  action: z.enum(["REFINE", "EXPAND", "STOP"]),
  refinedQuery: z.string().optional().nullable(),
  expandNodeIds: z.array(z.string()).optional().nullable(),
  reason: z.string(),
});

type PolicyAction = z.infer<typeof PolicyActionSchema>;

const MAX_SOURCE_MEMORY_IDS_PER_NODE = 5;
const EXPAND_SCORE_INHERITANCE = 0.8;
const STATE_WORKING_SET_ENTRIES = 12;
const STATE_ENTRY_SNIPPET_CHARS = 200;

/** Thrown when the shared whole-invocation deadline expires mid-await. */
class DeepRecallDeadlineExceeded extends Error {
  constructor() {
    super("deep recall total timeout reached");
  }
}

/**
 * Race one dependency call against the SHARED whole-invocation deadline AND
 * the transport cancellation signal — one helper, never two nested races
 * (issue #2915: an early abort return that abandons an already-started
 * deadline timer leaves its eventual rejection unhandled).
 *
 * `deadlineMs` is an absolute instant computed once per invocation, so every
 * await subtracts elapsed time instead of restarting the budget, and a stalled
 * seed search, graph load, or memory read can no longer outlive the documented
 * `totalTimeoutMs` just because the deadline is only *checked* between steps.
 * An infinite deadline (`totalTimeoutMs: 0`, a documented disable value) races
 * only the signal — no timer. The timer stays REFERENCED: it is the only thing
 * keeping the loop alive when the awaited dependency never settles. Every
 * arm is cleared in the `finally`, whichever wins.
 */
async function guardCall<T>(
  work: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<T> {
  if (signal?.aborted) throw abortError("deep recall aborted");
  if (!Number.isFinite(deadlineMs)) {
    return await raceAbort(work, signal, "deep recall aborted");
  }
  const remaining = deadlineMs - now();
  if (remaining <= 0) throw new DeepRecallDeadlineExceeded();
  const expiry = Promise.withResolvers<never>();
  const timer = setTimeout(() => expiry.reject(new DeepRecallDeadlineExceeded()), remaining);
  let onAbort: (() => void) | undefined;
  try {
    const racers: Promise<T | never>[] = [work, expiry.promise];
    if (signal) {
      racers.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(abortError("deep recall aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parsePolicyOutput(raw: string | null): PolicyAction | null {
  if (raw === null) return null;
  const candidates = [stripCodeFences(raw), ...extractJsonCandidates(raw)];
  for (const candidate of candidates) {
    if (candidate.trim().length === 0) continue;
    try {
      const parsed = PolicyActionSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

interface WorkingEntry extends DeepRecallEntry {
  content: string;
}

function mergeIntoWorkingSet(
  workingSet: Map<string, WorkingEntry>,
  hits: readonly DeepRecallSeedHit[],
  origin: "seed" | "refine",
  contentFor: (memoryId: string) => string
): void {
  for (const hit of hits) {
    if (typeof hit.memoryId !== "string" || hit.memoryId.length === 0) continue;
    if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) continue;
    const existing = workingSet.get(hit.memoryId);
    // Duplicates keep the higher score and the earlier origin (§13: one
    // content form, one merge rule, everywhere).
    if (existing && existing.score >= hit.score) continue;
    workingSet.set(hit.memoryId, {
      memoryId: hit.memoryId,
      content: contentFor(hit.memoryId),
      score: hit.score,
      origin: existing ? existing.origin : origin,
      ...(existing?.viaAnchor ? { viaAnchor: existing.viaAnchor } : {}),
    });
  }
}

interface FrontierIndex {
  memoryIdToNodeIds: Map<string, string[]>;
  nodeIdToNode: Map<string, AbstractionNode>;
  nodeIdToAnchorIds: Map<string, string[]>;
  anchorIdToAnchor: Map<string, CueAnchor>;
}

function buildFrontierIndex(graph: DeepRecallGraphSnapshot): FrontierIndex {
  const memoryIdToNodeIds = new Map<string, string[]>();
  const nodeIdToNode = new Map<string, AbstractionNode>();
  for (const node of graph.nodes) {
    nodeIdToNode.set(node.nodeId, node);
    for (const memoryId of node.sourceMemoryIds ?? []) {
      const list = memoryIdToNodeIds.get(memoryId) ?? [];
      list.push(node.nodeId);
      memoryIdToNodeIds.set(memoryId, list);
    }
  }
  const nodeIdToAnchorIds = new Map<string, string[]>();
  const anchorIdToAnchor = new Map<string, CueAnchor>();
  for (const anchor of graph.anchors) {
    anchorIdToAnchor.set(anchor.anchorId, anchor);
    for (const nodeRef of anchor.nodeRefs) {
      const list = nodeIdToAnchorIds.get(nodeRef) ?? [];
      list.push(anchor.anchorId);
      nodeIdToAnchorIds.set(nodeRef, list);
    }
  }
  return { memoryIdToNodeIds, nodeIdToNode, nodeIdToAnchorIds, anchorIdToAnchor };
}

/**
 * A candidate node adds nothing when every source memory the EXPAND path would
 * load is already in the working set (or when it has none): offering it as an
 * unretrieved candidate lets the policy burn steps re-expanding a node that can
 * only re-add what is already present.
 */
function nodeAddsNothing(node: AbstractionNode, workingSet: ReadonlyMap<string, WorkingEntry>): boolean {
  return (node.sourceMemoryIds ?? [])
    .slice(0, MAX_SOURCE_MEMORY_IDS_PER_NODE)
    .every((memoryId) => workingSet.has(memoryId));
}

/**
 * Frontier refresh (after every working-set change): for each working-set
 * memory, anchors whose nodeRefs include a node listing that memory make
 * every OTHER referenced node a frontier candidate. `sharedAnchorCount`
 * counts DISTINCT anchors (issue #2915): one anchor adds one no matter how
 * many working-set memories or nodes reach the candidate through it. Ranked
 * by the shared pure helper (shared-anchor count desc, nodeId asc — total
 * comparator).
 *
 * Nodes in `expandedNodeIds` are dropped: a node EXPAND already followed is
 * not an unretrieved candidate, even when some of its source memories never
 * entered the working set (an inactive or foreign read is skipped), so
 * re-offering it would let the policy spend every remaining step adding
 * nothing.
 */
function refreshFrontier(
  workingSet: ReadonlyMap<string, WorkingEntry>,
  graph: FrontierGraph,
  expandedNodeIds: ReadonlySet<string>
): DeepRecallFrontierItem[] {
  const index = graph.index;
  interface Candidate {
    nodeId: string;
    // Distinct shared anchors ONLY (issue #2915): one anchor counts once no
    // matter how many working-set memories reach the candidate through it,
    // so a candidate sharing one anchor can never outrank one sharing two.
    sharedAnchorIds: Set<string>;
    parentMemoryId: string;
    parentScore: number;
    anchorValue: string;
  }
  const byNodeId = new Map<string, Candidate>();
  for (const [memoryId, entry] of workingSet) {
    for (const nodeId of index.memoryIdToNodeIds.get(memoryId) ?? []) {
      for (const anchorId of index.nodeIdToAnchorIds.get(nodeId) ?? []) {
        const anchor = index.anchorIdToAnchor.get(anchorId);
        if (!anchor) continue;
        for (const otherNodeRef of anchor.nodeRefs) {
          if (otherNodeRef === nodeId) continue;
          if (expandedNodeIds.has(otherNodeRef)) continue;
          const otherNode = index.nodeIdToNode.get(otherNodeRef);
          if (!otherNode || nodeAddsNothing(otherNode, workingSet)) continue;
          const current = byNodeId.get(otherNodeRef);
          if (current === undefined) {
            byNodeId.set(otherNodeRef, {
              nodeId: otherNodeRef,
              sharedAnchorIds: new Set([anchorId]),
              parentMemoryId: memoryId,
              parentScore: entry.score,
              anchorValue: anchor.anchorValue,
            });
          } else {
            current.sharedAnchorIds.add(anchorId);
            if (entry.score > current.parentScore) {
              current.parentMemoryId = memoryId;
              current.parentScore = entry.score;
              current.anchorValue = anchor.anchorValue;
            }
          }
        }
      }
    }
  }
  const ranked = rankDeepRecallFrontier(
    [...byNodeId.values()].map((candidate) => ({
      nodeId: candidate.nodeId,
      sharedAnchorCount: candidate.sharedAnchorIds.size,
    })),
  );
  return ranked.flatMap((rankedCandidate) => {
    const candidate = byNodeId.get(rankedCandidate.nodeId);
    const node = index.nodeIdToNode.get(rankedCandidate.nodeId);
    if (!candidate || !node) return [];
    return [
      {
        nodeId: candidate.nodeId,
        title: node.title,
        reason: `shares anchor "${candidate.anchorValue}" with ${candidate.parentMemoryId}`,
        sharedAnchorCount: rankedCandidate.sharedAnchorCount,
        parentMemoryId: candidate.parentMemoryId,
        parentScore: candidate.parentScore,
        anchorValue: candidate.anchorValue,
      },
    ];
  });
}

interface FrontierGraph {
  index: FrontierIndex;
}


function renderStatePrompt(input: {
  query: string;
  workingSet: ReadonlyMap<string, WorkingEntry>;
  frontier: readonly DeepRecallFrontierItem[];
  stepsRemaining: number;
}): string {
  const lines: string[] = [
    "You are guiding a multi-hop memory retrieval loop. Pick exactly one action.",
    "REFINE when the retrieved memories look misaligned with the question (return a rewritten query).",
    "EXPAND to follow named frontier nodes that plausibly hold the answer (return their nodeIds).",
    "STOP when the working set is sufficient to answer.",
    "",
    `QUESTION: ${input.query}`,
    `STEPS REMAINING: ${input.stepsRemaining}`,
    "",
    "WORKING SET (retrieved memories):",
  ];
  const entries = [...input.workingSet.values()]
    .sort((a, b) => b.score - a.score || compareDeterministicStrings(a.memoryId, b.memoryId))
    .slice(0, STATE_WORKING_SET_ENTRIES);
  if (entries.length === 0) lines.push("(empty)");
  for (const entry of entries) {
    const snippet = entry.content.slice(0, STATE_ENTRY_SNIPPET_CHARS).replace(/\s+/g, " ");
    lines.push(`- ${entry.memoryId} (score=${entry.score.toFixed(3)}, origin=${entry.origin}): ${snippet}`);
  }
  lines.push("", "FRONTIER (anchor-linked candidates not yet retrieved):");
  if (input.frontier.length === 0) lines.push("(empty)");
  for (const item of input.frontier) {
    lines.push(`- ${item.nodeId}: ${item.title} — ${item.reason}`);
  }
  lines.push(
    "",
    'Respond with JSON only: {"action":"REFINE","refinedQuery":"...","reason":"..."}',
    'or {"action":"EXPAND","expandNodeIds":["..."],"reason":"..."}',
    'or {"action":"STOP","reason":"..."}',
  );
  return lines.join("\n");
}

function finalRank(entries: readonly DeepRecallEntry[]): DeepRecallEntry[] {
  return [...entries].sort(
    (a, b) => b.score - a.score || compareDeterministicStrings(a.memoryId, b.memoryId)
  );
}

/**
 * The budgeted loop. Seed (QMD + graph) -> policy steps -> ranked, capped
 * output. Only a SEED backend failure returns `ok: false`; timeout and
 * budget exhaustion mid-loop return the partial working set with
 * `ok: true` and a BUDGET_EXHAUSTED trace tail.
 */
export async function runBudgetedDeepRecall(deps: DeepRecallDeps, query: string): Promise<DeepRecallResult> {
  const cfg = deps.config;
  const now = deps.nowMs ?? Date.now;
  const startedMs = now();
  const deadlineMs = cfg.totalTimeoutMs > 0 ? startedMs + cfg.totalTimeoutMs : Number.POSITIVE_INFINITY;
  // Every dependency await races BOTH bounds: the shared whole-invocation
  // deadline and the transport cancellation signal (issue #2915). An abort
  // propagates as a standard AbortError — never as ok:false backend failure
  // and never as a partial result — so each transport applies its own
  // cancelled-response semantics.
  const guarded = <T>(work: Promise<T>): Promise<T> =>
    guardCall(work, deadlineMs, deps.signal, now);


  const trace: DeepRecallTraceStep[] = [];
  const contentCache = new Map<string, string>();
  const contentFor = (memoryId: string): string => contentCache.get(memoryId) ?? "";
  const workingSet = new Map<string, WorkingEntry>();
  let graph: FrontierGraph = { index: buildFrontierIndex({ nodes: [], anchors: [] }) };
  // Nodes already followed by EXPAND leave the frontier for good.
  const expandedNodeIds = new Set<string>();
  /**
   * Hydrate one working-set entry from `loadMemory`, DROPPING it when the read
   * is missing or reports a non-active memory: QMD can still index a memory
   * whose governance status moved out of the active set, and hydrating it
   * would surface content the active-set check excluded.
   */
  const hydrateOrDrop = async (memoryId: string): Promise<void> => {
    const memory = await guarded(deps.loadMemory(memoryId));
    if (!memory || !memory.active) {
      workingSet.delete(memoryId);
      contentCache.delete(memoryId);
      return;
    }
    contentCache.set(memoryId, memory.content);
    const entry = workingSet.get(memoryId);
    if (entry) entry.content = memory.content;
  };
  // Pre-policy work (seed search, graph load, seed hydration) is bounded by the
  // SAME deadline as the policy calls; exhausting it here yields the partial
  // working set rather than blocking the later check from ever running.
  let exhaustedDetail: string | null = null;
  try {
    throwIfAborted(deps.signal, "deep recall aborted");
    const seedHits = await guarded(deps.searchSeed(query, cfg.maxResults));
    mergeIntoWorkingSet(workingSet, seedHits, "seed", contentFor);
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!(err instanceof DeepRecallDeadlineExceeded)) {
      // Seed backend failure is the only ok:false path (§22: an empty index
      // proceeds; a thrown search does not).
      return { ok: false, error: "backend_unavailable", entries: [], trace: [] };
    }
    exhaustedDetail = "total timeout reached during seed search";
  }
  if (exhaustedDetail === null) {
    try {
      graph = { index: buildFrontierIndex(await guarded(deps.loadGraph())) };
      // Seed hydration also enforces the active set: a stale or non-active
      // QMD hit leaves the working set instead of being hydrated in place.
      for (const memoryId of [...workingSet.keys()]) {
        await hydrateOrDrop(memoryId);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!(err instanceof DeepRecallDeadlineExceeded)) throw err;
      exhaustedDetail = "total timeout reached loading the graph or hydrating seeds";
    }
  }

  let frontier = refreshFrontier(workingSet, graph, expandedNodeIds);
  let currentQuery = query;
  let refinesUsed = 0;

  const pushStep = (step: number, action: DeepRecallTraceStep["action"], detail: string, stepStartMs: number): void => {
    trace.push({
      step,
      action,
      detail,
      workingSetSize: workingSet.size,
      frontierSize: frontier.length,
      durationMs: Math.max(0, now() - stepStartMs),
    });
  };

  if (exhaustedDetail !== null) {
    // Pre-policy work already spent the whole-invocation budget: report the
    // partial working set (ok:true, §22) instead of starting a policy call
    // that cannot finish inside the deadline.
    pushStep(0, "BUDGET_EXHAUSTED", exhaustedDetail, startedMs);
  } else if (cfg.maxSteps <= 0) {
    // `maxSteps: 0` is a documented disable value (§33): seed-only retrieval,
    // with no policy call at all. The zero check dominates the step threshold
    // instead of relying on the loop condition falling through.
    pushStep(0, "STOP", "policy loop disabled (maxSteps=0)", startedMs);
  }
  let step = 0;
  try {
    while (exhaustedDetail === null && cfg.maxSteps > 0 && step < cfg.maxSteps) {
      const stepStartMs = now();
      throwIfAborted(deps.signal, "deep recall aborted");
      if (now() >= deadlineMs) {
        pushStep(step, "BUDGET_EXHAUSTED", "total timeout reached before policy call", stepStartMs);
        break;
      }
      // Two independent axes bound the policy call: its own per-step timeout and
      // whatever is left of the shared deadline. `stepTimeoutMs: 0` disables only
      // its own axis (§33) — a finite total budget still applies, so the call can
      // never outlive `totalTimeoutMs`. `timeoutMs: 0` reaches the policy only
      // when BOTH axes are disabled.
      const stepBudgetMs = cfg.stepTimeoutMs > 0 ? cfg.stepTimeoutMs : Number.POSITIVE_INFINITY;
      const effectiveBudgetMs = Math.min(stepBudgetMs, deadlineMs - now());
      const timeoutMs = Number.isFinite(effectiveBudgetMs) ? Math.max(1, effectiveBudgetMs) : 0;
      const raw = await guarded(
        deps.callPolicy(
          renderStatePrompt({ query: currentQuery, workingSet, frontier, stepsRemaining: cfg.maxSteps - step }),
          timeoutMs
        )
      );
      const parsed = parsePolicyOutput(raw);
      if (parsed === null) {
        pushStep(step, "STOP", "invalid_policy_output", stepStartMs);
        break;
      }
      if (parsed.action === "STOP") {
        pushStep(step, "STOP", parsed.reason || "policy stop", stepStartMs);
        break;
      }
      if (parsed.action === "REFINE") {
        const rewrite = validateRefineRewrite({
          currentQuery,
          refinedQuery: parsed.refinedQuery ?? null,
          refinesUsed,
        });
        if (!rewrite.ok) {
          pushStep(step, "STOP", rewrite.reason, stepStartMs);
          break;
        }
        currentQuery = rewrite.refinedQuery;
        refinesUsed += 1;
        try {
          const refinedHits = await guarded(deps.searchSeed(currentQuery, cfg.maxResults));
          mergeIntoWorkingSet(workingSet, refinedHits, "refine", contentFor);
          for (const hit of refinedHits) {
            if (workingSet.has(hit.memoryId) && !contentCache.has(hit.memoryId)) {
              await hydrateOrDrop(hit.memoryId);
            }
          }
        } catch (err) {
          // Re-search failure mid-loop is partial, not fatal (§22): the loop
          // keeps what it has and the policy decides the next move. Deadline
          // expiry and cancellation are NOT partial failures — they end the
          // invocation.
          if (err instanceof DeepRecallDeadlineExceeded || isAbortError(err)) throw err;
        }
        frontier = refreshFrontier(workingSet, graph, expandedNodeIds);
        pushStep(step, "REFINE", currentQuery, stepStartMs);
        step += 1;
        continue;
      }
      // EXPAND. A configured ceiling of 0 is a documented no-op limit (§33):
      // the action is honored but selects nothing.
      const selection =
        cfg.maxExpandPerStep <= 0
          ? { ok: true as const, nodeIds: [] as string[], truncated: false }
          : selectExpandNodeIds({
              frontierIds: frontier.map((item) => item.nodeId),
              requestedIds: parsed.expandNodeIds ?? [],
              maxExpandPerStep: cfg.maxExpandPerStep,
            });
      if (!selection.ok) {
        pushStep(step, "STOP", "invalid_policy_output", stepStartMs);
        break;
      }
      const chosen = new Map(frontier.map((item) => [item.nodeId, item]));
      for (const nodeId of selection.nodeIds) {
        const item = chosen.get(nodeId);
        const node = graph.index.nodeIdToNode.get(nodeId);
        if (!item || !node) continue;
        for (const memoryId of (node.sourceMemoryIds ?? []).slice(0, MAX_SOURCE_MEMORY_IDS_PER_NODE)) {
          if (workingSet.has(memoryId)) continue;
          const memory = await guarded(deps.loadMemory(memoryId));
          // Only active memories enter the working set (§41); a null read
          // (foreign namespace, §30) skips the same way.
          if (!memory || !memory.active) continue;
          workingSet.set(memoryId, {
            memoryId,
            content: memory.content,
            score: item.parentScore * EXPAND_SCORE_INHERITANCE,
            origin: "expand",
            viaAnchor: item.anchorValue,
          });
          contentCache.set(memoryId, memory.content);
        }
        expandedNodeIds.add(nodeId);
      }
      frontier = refreshFrontier(workingSet, graph, expandedNodeIds);
      pushStep(step, "EXPAND", selection.nodeIds.join(", "), stepStartMs);
      step += 1;
    }
  } catch (err) {
    if (!(err instanceof DeepRecallDeadlineExceeded)) throw err;
    // A dependency call inside a step outran the shared deadline: the per-step
    // timeout is not the wall clock, so record exhaustion and keep the partial
    // working set. durationMs spans the whole invocation.
    pushStep(step, "BUDGET_EXHAUSTED", "total timeout reached mid-step", startedMs);
  }

  if (cfg.maxSteps > 0 && step >= cfg.maxSteps && trace[trace.length - 1]?.action !== "STOP") {
    pushStep(step, "BUDGET_EXHAUSTED", "maxSteps policy calls reached", startedMs);
    // durationMs for the exhaustion marker is the whole invocation so far.
    const marker = trace[trace.length - 1];
    if (marker) marker.durationMs = Math.max(0, now() - startedMs);
  }

  // Final output carries full content; the 200-char trim is state rendering only.
  const entries = finalRank([...workingSet.values()]).map((entry) => ({ ...entry }));
  return {
    ok: true,
    entries: cfg.maxResults > 0 ? entries.slice(0, cfg.maxResults) : [],
    trace,
  };
}
