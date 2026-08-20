import test from "node:test";
import assert from "node:assert/strict";

import { computeWeeklyConfigHash, type WeeklyConfigInput } from "./week-config-hash.js";

const BASE: WeeklyConfigInput = {
  timezone: "Europe/Paris",
  weekStartsOn: "monday",
  categories: [
    { id: "development", name: "Development" },
    { id: "communication", name: "Communication" },
    { id: "system.unknown", name: "Uncategorized" },
  ],
};

test("identical inputs produce identical hashes", () => {
  const again: WeeklyConfigInput = {
    timezone: "Europe/Paris",
    weekStartsOn: "monday",
    categories: BASE.categories.map((category) => ({ id: category.id, name: category.name })),
  };
  assert.strictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(again));
});

test("category order does not change the hash", () => {
  const reordered: WeeklyConfigInput = {
    ...BASE,
    categories: [...BASE.categories].reverse(),
  };
  assert.strictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(reordered));
});

test("key insertion order does not change the hash", () => {
  const rotated: WeeklyConfigInput = {
    categories: [
      { name: "Development", id: "development" },
      { name: "Communication", id: "communication" },
      { name: "Uncategorized", id: "system.unknown" },
    ],
    weekStartsOn: "monday",
    timezone: "Europe/Paris",
  };
  assert.strictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(rotated));
});

test("a renamed category changes the hash", () => {
  const renamed: WeeklyConfigInput = {
    ...BASE,
    categories: BASE.categories.map((category) =>
      category.id === "development" ? { id: "development", name: "Coding" } : category,
    ),
  };
  assert.notStrictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(renamed));
});

test("an added category changes the hash", () => {
  const added: WeeklyConfigInput = {
    ...BASE,
    categories: [...BASE.categories, { id: "design", name: "Design" }],
  };
  assert.notStrictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(added));
});

test("a removed category changes the hash", () => {
  const removed: WeeklyConfigInput = {
    ...BASE,
    categories: BASE.categories.slice(0, 2),
  };
  assert.notStrictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(removed));
});

test("a different timezone changes the hash", () => {
  const shifted: WeeklyConfigInput = { ...BASE, timezone: "UTC" };
  assert.notStrictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(shifted));
});

test("a different weekStartsOn changes the hash", () => {
  const shifted: WeeklyConfigInput = { ...BASE, weekStartsOn: "sunday" };
  assert.notStrictEqual(computeWeeklyConfigHash(BASE), computeWeeklyConfigHash(shifted));
});

test("duplicate category ids throw RangeError", () => {
  const duplicated: WeeklyConfigInput = {
    ...BASE,
    categories: [
      { id: "development", name: "Development" },
      { id: "development", name: "Dev" },
    ],
  };
  assert.throws(() => computeWeeklyConfigHash(duplicated), RangeError);
  assert.throws(() => computeWeeklyConfigHash(duplicated), /duplicate/);
});

test("blank fields throw RangeError naming the field", () => {
  assert.throws(
    () => computeWeeklyConfigHash({ ...BASE, timezone: "" }),
    RangeError,
  );
  assert.throws(
    () => computeWeeklyConfigHash({ ...BASE, timezone: "   " }),
    /timezone/,
  );
  assert.throws(
    () => computeWeeklyConfigHash({ ...BASE, weekStartsOn: "" }),
    /weekStartsOn/,
  );
  assert.throws(
    () => computeWeeklyConfigHash({ ...BASE, categories: [{ id: "", name: "Dev" }] }),
    /categories\[0\]\.id/,
  );
  assert.throws(
    () => computeWeeklyConfigHash({ ...BASE, categories: [{ id: "dev", name: " " }] }),
    /categories\[0\]\.name/,
  );
});

test("digest is lowercase hex of the documented length", () => {
  const digest = computeWeeklyConfigHash(BASE);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.strictEqual(digest.length, 64);
});

test("the caller's category array is not mutated", () => {
  const input: WeeklyConfigInput = {
    timezone: "UTC",
    weekStartsOn: "monday",
    categories: [
      { id: "b", name: "B" },
      { id: "a", name: "A" },
    ],
  };
  const before = structuredClone(input);
  computeWeeklyConfigHash(input);
  assert.deepStrictEqual(input, before);
});
