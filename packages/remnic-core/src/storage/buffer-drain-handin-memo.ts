/**
 * What a live buffer owner has already handed to a drain claim's inbox, so the
 * next hand-in carries only what is new (COS-666i).
 *
 * `mergeIntoClaim` used to append the owner's WHOLE entry on every save. For a
 * claimed session that is never drained, the inbox grew by the full buffer per
 * observe (quadratic), and every reader that parsed it stalled the event loop
 * (a production inbox reached 799 MB). The claim fold keeps, per turn identity,
 * the largest occurrence count any record holds, so a record only has to carry
 * every occurrence of the identities whose count grew: folding the deltas gives
 * the same claim as folding the full snapshots.
 *
 * The memo is only trusted while the claim is exactly as this process left it
 * (`stamp`: the inbox file's identity, size and mtime, read under the claim lock). Any other
 * writer, a drainer compaction (it deletes the inbox), a release or a re-claim changes the stamp, and
 * the next hand-in is the whole entry again, which is always correct.
 */

import { createHash } from "node:crypto";

import { bufferTurnIdentityKey } from "../buffer-turn-helpers.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

/** Claims remembered at once; an evicted claim just gets a full hand-in next. */
const MAX_REMEMBERED_CLAIMS = 64;

interface Remembered {
  stamp: string;
  active: Map<string, number>;
  retained: Map<string, number>;
  lastExtractionAt: string | null;
  extractionCount: number;
}

/** Digests, not identity keys: a key embeds the whole turn text. */
function identities(turns: readonly BufferTurn[]): string[] {
  return turns.map((turn) => createHash("sha256").update(bufferTurnIdentityKey(turn)).digest("base64"));
}

function tally(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function largest(into: Map<string, number>, counts: ReadonlyMap<string, number>): Map<string, number> {
  for (const [id, count] of counts) if (count > (into.get(id) ?? 0)) into.set(id, count);
  return into;
}

/** Every occurrence of each identity whose count exceeds what was handed in. */
function grown(turns: readonly BufferTurn[], ids: readonly string[], counts: ReadonlyMap<string, number>, handed: ReadonlyMap<string, number>): BufferTurn[] {
  return turns.filter((_, index) => (counts.get(ids[index] ?? "") ?? 0) > (handed.get(ids[index] ?? "") ?? 0));
}

export interface HandInPlan {
  /** What to append: the whole entry, or only what grew. */
  record: BufferEntryState;
  /** Call after the append landed, with the claim's stamp read afterwards (null forgets the claim). */
  remember(stampAfter: string | null): void;
}

export class HandInMemo {
  private readonly byKey = new Map<string, Remembered>();

  /** The hand-in to append for `incoming`, or null when the claim already holds all of it. */
  plan(key: string, stamp: string | null, incoming: BufferEntryState): HandInPlan | null {
    const ids = identities(incoming.turns);
    const retainedIds = identities(incoming.retainedTurns ?? []);
    const counts = tally(ids);
    const retainedCounts = tally(retainedIds);
    const known = stamp === null ? undefined : this.byKey.get(key);
    const valid = known !== undefined && known.stamp === stamp ? known : undefined;

    let record = incoming;
    if (valid) {
      const turns = grown(incoming.turns, ids, counts, valid.active);
      const retained = grown(incoming.retainedTurns ?? [], retainedIds, retainedCounts, valid.retained);
      const unchanged = valid.lastExtractionAt === incoming.lastExtractionAt && valid.extractionCount === incoming.extractionCount;
      if (turns.length === 0 && retained.length === 0 && unchanged) return null;
      record = { ...incoming, turns };
      if (incoming.retainedTurns) record.retainedTurns = retained;
    }

    return {
      record,
      remember: (stampAfter) => {
        this.byKey.delete(key);
        if (stampAfter === null) return;
        this.byKey.set(key, {
          stamp: stampAfter,
          active: largest(new Map(valid?.active), counts),
          retained: largest(new Map(valid?.retained), retainedCounts),
          lastExtractionAt: incoming.lastExtractionAt,
          extractionCount: incoming.extractionCount,
        });
        const oldest = this.byKey.keys().next().value;
        if (this.byKey.size > MAX_REMEMBERED_CLAIMS && oldest !== undefined) this.byKey.delete(oldest);
      },
    };
  }
}
