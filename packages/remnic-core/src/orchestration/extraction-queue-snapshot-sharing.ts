/**
 * Bounded-queue retention for automatic extraction snapshots (#3324
 * follow-up).
 *
 * The coordinator's queue keeps every accepted task's own snapshot (that is
 * the #3324 contract: per-entry captured scope and settlement), but nothing
 * requires each queued snapshot to RETAIN its own turn objects. Automatic
 * triggers hand out prefix-extended snapshots of the same buffer (the buffer
 * clears only when extraction runs), so consecutive queued snapshots overlap
 * almost entirely while their drain is slow. Retaining one deep copy per
 * snapshot grows quadratic overhead (demonstrated: scaling exponent 1.89 on
 * main, 36× the unique content at 1000 turns for one session).
 *
 * This registry makes the OVERLAP shared without changing ANY task's
 * semantics: a queued snapshot is stored as a chain node
 * `{ base, tail }` whose turns are verified element-wise equivalent to the
 * base chain at admit time. Each task materializes its own fresh array at
 * run time — identical values, same windows, same chunking, same clear
 * matching, same settlements. Sharing is data-structure only.
 *
 * Safety properties:
 * - Equivalence is CONSUMER-equivalence, not `bufferTurnsEqual` alone: the
 *   five fields `bufferTurnsEqual` ignores (extractionContextOnly, parts,
 *   rawContent, sourceFormat, importProvenance) are compared strictly
 *   (objects by reference identity), so an aliased segment is
 *   indistinguishable from a private copy to every downstream reader.
 * - Turn objects are immutable by audit: no code path writes a BufferTurn
 *   field or a parts array in place (all writes go to freshly constructed
 *   objects: `copyBufferTurn`, the replay `pinned` spread). Audited across
 *   the extraction call graph.
 * - Distinct scope pins can never share: pins are turn fields covered by
 *   `bufferTurnsEqual`, and the scope-class bucket is a lookup heuristic
 *   only — a wrong pairing fails the element-wise check and simply does not
 *   share.
 * - Replay, bulk import, force flush, fail-closed callers, and claim-backed
 *   execution contexts are excluded (they are not automatic snapshots of the
 *   live buffer).
 */

import type { BufferTurn } from "../types.js";
import { bufferTurnsEqual, scopeProfilePlanIdentity } from "../buffer-turn-helpers.js";

/** Option surface of `queueBufferedExtraction` relevant to eligibility. */
export interface AutomaticSharingOptions {
  /** Claim-backed backlog tasks own a different buffer view: never share. */
  execution?: unknown;
  /** Automatic trigger paths set this; forced replay/import do not. */
  preemptable?: boolean;
  failOnExtractionFailure?: boolean;
  forceExtractionAttempt?: boolean;
  /** Fail-closed front flush: never share. */
  preemptRunning?: boolean;
}

export function automaticSnapshotSharingEligible(options: AutomaticSharingOptions): boolean {
  return (
    options.execution === undefined &&
    options.preemptable === true &&
    options.failOnExtractionFailure !== true &&
    options.forceExtractionAttempt !== true &&
    options.preemptRunning !== true
  );
}

/** Consumer-visible equivalence: `bufferTurnsEqual` PLUS the fields it ignores. */
export function turnRepresentationEquivalent(left: BufferTurn, right: BufferTurn): boolean {
  return (
    bufferTurnsEqual(left, right) &&
    left.extractionContextOnly === right.extractionContextOnly &&
    left.importProvenance === right.importProvenance &&
    left.parts === right.parts &&
    left.rawContent === right.rawContent &&
    left.sourceFormat === right.sourceFormat
  );
}

/** Scope-class bucket key, the same composite `groupTurnsByExtractionScope` uses. */
function scopeClassKey(turn: BufferTurn): string {
  return [
    turn.writeNamespaceOverride ?? "",
    turn.principalOverride ?? "",
    scopeProfilePlanIdentity(turn.scopeProfileWritePlan),
    turn.acceptedCapture === true ? "accepted" : "",
    turn.codingContext?.projectId ?? "",
    turn.codingContext?.rootPath ?? "",
    turn.codingContext?.branch ?? "",
    turn.codingContext?.defaultBranch ?? "",
  ].join("\u0000");
}

/** One queued automatic snapshot: `base` chain plus this trigger's own new turns. */
export interface SnapshotChain {
  readonly key: string;
  readonly scopeClass: string;
  readonly base: SnapshotChain | undefined;
  /** Total turns retained by the base chain. */
  readonly baseLength: number;
  /** This trigger's non-shared suffix (fresh reference slots, disjoint across the chain). */
  readonly tail: readonly BufferTurn[];
  /** Total turns this snapshot represents. */
  readonly total: number;
  /** Outstanding tasks holding this node; the node leaves the registry when it reaches 0. */
  holders: number;
}

export interface SnapshotSharingStats {
  queuedNodes: number;
  /** Reference slots retained across queued snapshots (the O(N²) term on main). */
  queuedTotalRefs: number;
  /** Distinct reference slots (what sharing actually retains). */
  queuedTailRefs: number;
  /** Longest base chain reachable from a queued node (must stay bounded). */
  queuedReachableDepth: number;
}

/** Iterative root-first walk: recursive `yield*` delegation costs O(depth)
 * per item and hangs production-scale chains (3,000+ turn sessions,
 * hours-long backlogs). Same order, bounded stack, no casts. */
function chainNodes(chain: SnapshotChain): SnapshotChain[] {
  const nodes: SnapshotChain[] = [];
  for (let node: SnapshotChain | undefined = chain; node; node = node.base) nodes.push(node);
  return [...nodes].reverse();
}

/**
 * Element-wise consumer-equivalence of the chain's turns against a snapshot
 * prefix. Cost is O(chain.total) compares per admit — required to prove the
 * shared prefix is consumer-equivalent to the incoming snapshot — so a chain
 * build is O(depth^2) compares in total (measured, acknowledged in the PR).
 */
export function chainPrefixEquivalent(chain: SnapshotChain, turns: readonly BufferTurn[]): boolean {
  let offset = 0;
  for (const node of chainNodes(chain)) {
    for (const chained of node.tail) {
      const incoming = turns[offset];
      if (incoming === undefined) return false;
      if (!turnRepresentationEquivalent(chained, incoming)) return false;
      offset += 1;
    }
  }
  return offset === chain.total;
}

/** Fresh array with exactly this snapshot's turns, in order. Run-time only. */
export function materializeChain(chain: SnapshotChain): BufferTurn[] {
  const out: BufferTurn[] = [];
  for (const node of chainNodes(chain)) {
    for (const turn of node.tail) out.push(turn);
  }
  return out;
}

export class ExtractionSnapshotSharingRegistry {
  private readonly buckets = new Map<string, SnapshotChain[]>();

  /**
   * Admit one automatic snapshot for `bufferKey`: chain it onto the newest
   * queued same-scope snapshot when that is a verified prefix-extension,
   * otherwise start a fresh chain. The caller's array is never mutated.
   */
  admit(bufferKey: string, turns: readonly BufferTurn[]): SnapshotChain {
    const scopeClass = turns.length > 0 ? scopeClassKey(turns[0]) : "";
    const bucketKey = `${bufferKey}\u0000${scopeClass}`;
    const list = this.buckets.get(bucketKey);
    const base = list !== undefined && list.length > 0 ? list[list.length - 1] : undefined;
    if (base && base.total === turns.length && chainPrefixEquivalent(base, turns)) {
      // Identical window: reuse the existing node. Creating a tail=[] node
      // here would chain onto the base and grow reachable depth (and admit
      // cost) by one per admission under continuous unchanged ingress, while
      // stats showed only the newest node. Sharing is exact: the element-wise
      // equivalence above proved this window equals the base's. The holder
      // count keeps the node registered until the LAST sharer releases.
      base.holders += 1;
      return base;
    }
    const node: SnapshotChain =
      base && base.total <= turns.length && chainPrefixEquivalent(base, turns)
        ? {
            key: bufferKey,
            scopeClass,
            base,
            baseLength: base.total,
            tail: turns.slice(base.total),
            total: turns.length,
            holders: 1,
          }
        : {
            key: bufferKey,
            scopeClass,
            base: undefined,
            baseLength: 0,
            tail: [...turns],
            total: turns.length,
            holders: 1,
          };
    if (list) list.push(node);
    else this.buckets.set(bucketKey, [node]);
    return node;
  }

  /** Release one holder of a node when its task exits (or on enqueue
   * refusal). The node leaves the registry only when its LAST holder
   * releases, so registry accounting stays truthful while any sharer is
   * still outstanding. Idempotent per task. */
  release(node: SnapshotChain): void {
    if (node.holders <= 0) return;
    node.holders -= 1;
    if (node.holders > 0) return;
    const list = this.buckets.get(`${node.key}\u0000${node.scopeClass}`);
    if (!list) return;
    const index = list.indexOf(node);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.buckets.delete(`${node.key}\u0000${node.scopeClass}`);
  }

  /** Proof seam: what the queue retains right now. */
  stats(): SnapshotSharingStats {
    let queuedNodes = 0;
    let queuedTotalRefs = 0;
    let queuedTailRefs = 0;
    let queuedReachableDepth = 0;
    for (const list of this.buckets.values()) {
      for (const node of list) {
        queuedNodes += 1;
        queuedTotalRefs += node.total;
        queuedTailRefs += node.tail.length;
        let depth = 0;
        for (let walk: SnapshotChain | undefined = node; walk; walk = walk.base) depth += 1;
        if (depth > queuedReachableDepth) queuedReachableDepth = depth;
      }
    }
    return { queuedNodes, queuedTotalRefs, queuedTailRefs, queuedReachableDepth };
  }
}
