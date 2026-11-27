
import type { BufferTurn } from "../types.js";
import { bufferTurnsEqual, scopeProfilePlanIdentity } from "../buffer-turn-helpers.js";

/** Option surface of `queueBufferedExtraction` relevant to eligibility. */
export interface AutomaticSharingOptions {
  execution?: unknown;
  /** Automatic trigger paths set this; forced replay/import do not. */
  preemptable?: boolean;
  failOnExtractionFailure?: boolean;
  forceExtractionAttempt?: boolean;
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
  /** Distinct content chains registered (not task count — see queuedHolders). */
  queuedNodes: number;
  /** Σ per-node window lengths over registered nodes. Sibling nodes sharing
   * a base chain count that base once per node (per-task window basis). */
  queuedTotalRefs: number;
  /** Distinct turn references REACHABLE from queued nodes, counting
   * released ancestors reached through `base` exactly once (visited-set). */
  queuedTailRefs: number;
  /** Longest base chain reachable from a queued node (must stay bounded). */
  queuedReachableDepth: number;
  /** Outstanding tasks holding nodes (per-task, not per-node). */
  queuedHolders: number;
  /** What retention would be WITHOUT sharing: Σ per-node window length ×
   * holders (each outstanding task would carry its own full window). */
  unsharedEquivalentRefs: number;
}

function chainNodes(chain: SnapshotChain): SnapshotChain[] {
  const nodes: SnapshotChain[] = [];
  for (let node: SnapshotChain | undefined = chain; node; node = node.base) nodes.push(node);
  return [...nodes].reverse();
}

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

  admit(bufferKey: string, turns: readonly BufferTurn[]): SnapshotChain {
    const scopeClass = turns.length > 0 ? scopeClassKey(turns[0]) : "";
    const bucketKey = `${bufferKey}\u0000${scopeClass}`;
    const list = this.buckets.get(bucketKey);
    const base = list !== undefined && list.length > 0 ? list[list.length - 1] : undefined;
    if (base && base.total === turns.length && chainPrefixEquivalent(base, turns)) {
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
    const visited = new Set<SnapshotChain>();
    let queuedNodes = 0;
    let queuedTailRefs = 0;
    let queuedReachableDepth = 0;
    let queuedHolders = 0;
    let unsharedEquivalentRefs = 0;
    let queuedTotalRefs = 0;
    for (const list of this.buckets.values()) {
      for (const node of list) {
        queuedNodes += 1;
        unsharedEquivalentRefs += node.total * node.holders;
        queuedTotalRefs += node.total;
        let depth = 0;
        for (let walk: SnapshotChain | undefined = node; walk; walk = walk.base) {
          depth += 1;
          if (visited.has(walk)) continue;
          visited.add(walk);
          queuedTailRefs += walk.tail.length;
          queuedHolders += walk.holders;
        }
        if (depth > queuedReachableDepth) queuedReachableDepth = depth;
      }
    }
    return { queuedNodes, queuedTotalRefs, queuedTailRefs, queuedReachableDepth, queuedHolders, unsharedEquivalentRefs };
  }
}
