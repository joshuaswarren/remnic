import assert from "node:assert/strict";
import test from "node:test";

import { buildStateEvidencePackets } from "./recall-state-view-packet.js";
import type { StateViewEntry } from "./recall-state-view-packet.js";

test("two-step predecessor chain is ordered nearest to head first", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "head", stateLabel: "current" },
    { memoryId: "old-2", stateLabel: "historical", supersededById: "old-1" },
    { memoryId: "old-1", stateLabel: "historical", supersededById: "head" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "head", historyIds: ["old-1", "old-2"] }],
    orphanHistoryIds: [],
  });
});

test("two independent packets never interleave", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "b-head", stateLabel: "transition" },
    { memoryId: "a-head", stateLabel: "current" },
    { memoryId: "b-old", stateLabel: "historical", supersededById: "b-head" },
    { memoryId: "a-old", stateLabel: "historical", supersededById: "a-head" },
  ]);
  assert.deepEqual(result, {
    packets: [
      { headId: "a-head", historyIds: ["a-old"] },
      { headId: "b-head", historyIds: ["b-old"] },
    ],
    orphanHistoryIds: [],
  });
});

test("historical entry pointing at an absent successor becomes an orphan", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "head", stateLabel: "current" },
    { memoryId: "dangling", stateLabel: "historical", supersededById: "missing" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "head", historyIds: [] }],
    orphanHistoryIds: ["dangling"],
  });
});

test("historical entry with no supersededById becomes an orphan", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "rootless", stateLabel: "historical" },
  ]);
  assert.deepEqual(result, {
    packets: [],
    orphanHistoryIds: ["rootless"],
  });
});

test("supersededById cycle terminates and yields orphans", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "head", stateLabel: "current" },
    { memoryId: "loop-a", stateLabel: "historical", supersededById: "loop-b" },
    { memoryId: "loop-b", stateLabel: "historical", supersededById: "loop-a" },
    { memoryId: "into-loop", stateLabel: "historical", supersededById: "loop-a" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "head", historyIds: [] }],
    orphanHistoryIds: ["into-loop", "loop-a", "loop-b"],
  });
});

test("lone current entry yields a packet with empty history", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "solo", stateLabel: "current" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "solo", historyIds: [] }],
    orphanHistoryIds: [],
  });
});

test("unknown state label throws TypeError listing the allowed values", () => {
  assert.throws(
    () =>
      buildStateEvidencePackets([
        { memoryId: "x", stateLabel: "archived" as StateViewEntry["stateLabel"] },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      const message = String((error as Error).message);
      assert.match(message, /state label/);
      assert.ok(message.includes('"current"'));
      assert.ok(message.includes('"historical"'));
      assert.ok(message.includes('"transition"'));
      return true;
    },
  );
});

test("blank memoryId is ignored", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "", stateLabel: "historical", supersededById: "head" },
    { memoryId: "   ", stateLabel: "current" },
    { memoryId: "head", stateLabel: "current" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "head", historyIds: [] }],
    orphanHistoryIds: [],
  });
});

test("duplicate memoryId keeps the first entry", () => {
  const result = buildStateEvidencePackets([
    { memoryId: "dup", stateLabel: "current" },
    { memoryId: "dup", stateLabel: "historical", supersededById: "other" },
    { memoryId: "old", stateLabel: "historical", supersededById: "dup" },
  ]);
  assert.deepEqual(result, {
    packets: [{ headId: "dup", historyIds: ["old"] }],
    orphanHistoryIds: [],
  });
});

test("shuffled input produces a deep-equal result", () => {
  const entries: StateViewEntry[] = [
    { memoryId: "h2", stateLabel: "transition" },
    { memoryId: "h1", stateLabel: "current" },
    { memoryId: "a1", stateLabel: "historical", supersededById: "h1" },
    { memoryId: "a2", stateLabel: "historical", supersededById: "a1" },
    { memoryId: "b1", stateLabel: "historical", supersededById: "h2" },
    { memoryId: "lost", stateLabel: "historical" },
  ];
  const expected = {
    packets: [
      { headId: "h1", historyIds: ["a1", "a2"] },
      { headId: "h2", historyIds: ["b1"] },
    ],
    orphanHistoryIds: ["lost"],
  };
  assert.deepEqual(buildStateEvidencePackets(entries), expected);
  const byId = new Map(entries.map((entry) => [entry.memoryId, entry]));
  const orders = [
    ["lost", "b1", "a2", "a1", "h2", "h1"],
    ["h2", "lost", "h1", "b1", "a2", "a1"],
    ["a2", "h1", "lost", "h2", "a1", "b1"],
  ];
  for (const order of orders) {
    const shuffled = order.map((id) => byId.get(id) as StateViewEntry);
    assert.deepEqual(buildStateEvidencePackets(shuffled), expected);
  }
});

test("input entries are not mutated", () => {
  const entries: StateViewEntry[] = [
    { memoryId: "head", stateLabel: "current" },
    { memoryId: "old", stateLabel: "historical", supersededById: "head" },
  ];
  const snapshot = structuredClone(entries);
  buildStateEvidencePackets(entries);
  assert.deepEqual(entries, snapshot);
});
