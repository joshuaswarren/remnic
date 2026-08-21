import test from "node:test";
import assert from "node:assert/strict";
import {
  createSeededRng,
  rotateDistractors,
  selectFixtureVariant,
  shuffleTasks,
} from "./randomize.ts";

test("createSeededRng is deterministic for a fixed seed", () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  const sampleA = Array.from({ length: 5 }, () => a.next());
  const sampleB = Array.from({ length: 5 }, () => b.next());
  assert.deepEqual(sampleA, sampleB);
  for (const value of sampleA) {
    assert.ok(value >= 0 && value < 1);
  }
});

test("shuffleTasks returns a permutation of the input", () => {
  const items = [1, 2, 3, 4, 5];
  const shuffled = shuffleTasks(items, 7);
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
});

test("shuffleTasks is deterministic for the same seed", () => {
  const items = ["a", "b", "c", "d", "e"];
  const first = shuffleTasks(items, 13);
  const second = shuffleTasks(items, 13);
  assert.deepEqual(first, second);
});

test("shuffleTasks produces different orderings for different seeds", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const first = shuffleTasks(items, 1);
  const second = shuffleTasks(items, 9999);
  assert.notDeepEqual(first, second);
});

test("rotateDistractors preserves the correct answer at a potentially new index", () => {
  const question = { correct: "A", distractors: ["B", "C", "D"] };
  const rotated = rotateDistractors(question, 3);
  assert.equal(rotated.choices.length, 4);
  assert.equal(rotated.choices[rotated.correctIndex], "A");
  assert.ok(rotated.correctIndex >= 0 && rotated.correctIndex < rotated.choices.length);
});

test("rotateDistractors deduplicates when correct is also in distractors", () => {
  const question = { correct: "A", distractors: ["A", "B", "C"] };
  const rotated = rotateDistractors(question, 0);
  const seen = new Set(rotated.choices);
  assert.equal(seen.size, rotated.choices.length);
});

test("selectFixtureVariant is stable by seed", () => {
  const variants = [
    { id: "v1", value: "one" },
    { id: "v2", value: "two" },
    { id: "v3", value: "three" },
  ];
  const a = selectFixtureVariant(variants, 5);
  const b = selectFixtureVariant(variants, 5);
  assert.equal(a.id, b.id);
});

test("selectFixtureVariant rejects empty variant lists", () => {
  assert.throws(() => selectFixtureVariant([], 1));
});
