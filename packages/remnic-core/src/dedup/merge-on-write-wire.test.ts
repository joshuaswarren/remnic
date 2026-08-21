import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeJudge, MergeJudgeVerdict, MergeOnWritePair } from "./merge-on-write.js";
import { applyMergeOnWriteAtPersist } from "./merge-on-write-wire.js";

type PersistResult = { action: "merged"; id: string } | { action: "created" };

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
    writeMerged: async (id: string): Promise<PersistResult> => {
      merged.push(id);
      return { action: "merged", id };
    },
    writeNew: async (): Promise<PersistResult> => {
      created.push(1);
      return { action: "created" };
    },
  };
}

const mergeJudge: MergeJudge = async (): Promise<MergeJudgeVerdict> => "merge";
const createJudge: MergeJudge = async (): Promise<MergeJudgeVerdict> => "create";

test("merge-on-write-wire: disabled writes a new fact", async () => {
  let judged = 0;
  const io = trackers();
  const result = await applyMergeOnWriteAtPersist({
    enabled: false,
    pair: pair(),
    judge: async (): Promise<MergeJudgeVerdict> => {
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
    judge: mergeJudge,
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
    judge: mergeJudge,
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
    judge: createJudge,
    writeMerged: io.writeMerged,
    writeNew: io.writeNew,
  });
  assert.equal(result.action, "created");
  assert.deepEqual(io.merged, []);
  assert.equal(io.created.length, 1);
});
