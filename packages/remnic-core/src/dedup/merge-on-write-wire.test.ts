import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeOnWritePair } from "./merge-on-write.js";
import { applyMergeOnWriteAtPersist } from "./merge-on-write-wire.js";

function pair(overrides: Partial<MergeOnWritePair> = {}): MergeOnWritePair {
  return {
    category: "fact",
    score: 0.85,
    incomingContent: "User prefers dark mode on laptops.",
    existingContent: "User likes dark mode.",
    existingId: "mem-1",
    ...overrides,
  };
}

function trackers() {
  const merged: string[] = [];
  const created: number[] = [];
  return {
    merged,
    created,
    writeMerged: async (id: string) => {
      merged.push(id);
      return { action: "merged" as const, id };
    },
    writeNew: async () => {
      created.push(1);
      return { action: "created" as const };
    },
  };
}

test("merge-on-write-wire: disabled writes a new fact", async () => {
  let judged = 0;
  const io = trackers();
  const result = await applyMergeOnWriteAtPersist({
    enabled: false,
    pair: pair(),
    judge: async () => {
      judged += 1;
      return "merge";
    },
    writeMerged: io.writeMerged,
    writeNew: io.writeNew,
  });
  assert.equal(result.action, "created");
  assert.deepEqual(io.merged, []);
  assert.equal(io.created.length, 1);
  assert.equal(judged, 0);
});

test("merge-on-write-wire: mergeMin 0 writes a new fact", async () => {
  let judged = 0;
  const io = trackers();
  const result = await applyMergeOnWriteAtPersist({
    enabled: true,
    mergeMin: 0,
    pair: pair(),
    judge: async () => {
      judged += 1;
      return "merge";
    },
    writeMerged: io.writeMerged,
    writeNew: io.writeNew,
  });
  assert.equal(result.action, "created");
  assert.deepEqual(io.merged, []);
  assert.equal(io.created.length, 1);
  assert.equal(judged, 0);
});

test("merge-on-write-wire: merge updates the existing id", async () => {
  const io = trackers();
  const result = await applyMergeOnWriteAtPersist({
    enabled: true,
    pair: pair(),
    judge: async () => "merge",
    writeMerged: io.writeMerged,
    writeNew: io.writeNew,
  });
  assert.deepEqual(result, { action: "merged", id: "mem-1" });
  assert.deepEqual(io.merged, ["mem-1"]);
  assert.equal(io.created.length, 0);
});

test("merge-on-write-wire: create writes a new fact", async () => {
  const io = trackers();
  const result = await applyMergeOnWriteAtPersist({
    enabled: true,
    pair: pair(),
    judge: async () => "create",
    writeMerged: io.writeMerged,
    writeNew: io.writeNew,
  });
  assert.equal(result.action, "created");
  assert.deepEqual(io.merged, []);
  assert.equal(io.created.length, 1);
});
