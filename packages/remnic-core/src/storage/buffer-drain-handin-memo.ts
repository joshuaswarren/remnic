
import { createHash } from "node:crypto";

import { bufferTurnIdentityKey } from "../buffer-turn-helpers.js";
import type { BufferEntryState, BufferTurn } from "../types.js";

const MAX_REMEMBERED_CLAIMS = 64;

interface Remembered {
  stamp: string;
  active: Map<string, number>;
  retained: Map<string, number>;
  lastExtractionAt: string | null;
  extractionCount: number;
}

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

function grown(turns: readonly BufferTurn[], ids: readonly string[], counts: ReadonlyMap<string, number>, handed: ReadonlyMap<string, number>): BufferTurn[] {
  return turns.filter((_, index) => (counts.get(ids[index] ?? "") ?? 0) > (handed.get(ids[index] ?? "") ?? 0));
}

export interface HandInPlan {
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
