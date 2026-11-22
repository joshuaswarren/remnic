/**
 * Chain-resolution benchmark for buildStateEvidencePackets (#3565).
 * One long supersededById chain is the worst case: each historical entry
 * re-walks the remainder of the chain, so resolution is O(N^2) without
 * memoization. Reports wall time per chain length; O(N) should look flat
 * per element, O(N^2) quadratic.
 * Usage: node ./node_modules/.bin/tsx scripts/bench-state-packet-chains.ts
 */
import { buildStateEvidencePackets, type StateViewEntry } from "../packages/remnic-core/src/recall-state-view-packet.js";

function chain(n: number): StateViewEntry[] {
  const entries: StateViewEntry[] = [{ memoryId: "head", stateLabel: "current" }];
  for (let i = n - 1; i >= 0; i--) {
    entries.push({
      memoryId: `h${i}`,
      stateLabel: "historical",
      supersededById: i === n - 1 ? "head" : `h${i + 1}`,
    });
  }
  return entries;
}

for (const n of [500, 1000, 2000, 4000]) {
  const entries = chain(n);
  const t0 = process.hrtime.bigint();
  const out = buildStateEvidencePackets(entries);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const packet = out.packets.find((p) => p.headId === "head");
  console.log(
    `n=${n}\t${ms.toFixed(1)}ms\t${(ms / n).toFixed(4)}ms/entry\thistory=${packet?.historyIds.length ?? -1}\torphans=${out.orphanHistoryIds.length}`,
  );
}
