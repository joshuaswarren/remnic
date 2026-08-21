import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeRecapUserEdits,
  type RecapSection,
} from "./recap-merge-edits.js";

test("edited section survives regeneration", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [{ key: "highlights", body: "hand edit" }],
  });
  assert.deepEqual(result.sections, [{ key: "highlights", body: "hand edit" }]);
  assert.deepEqual(result.preserved, ["highlights"]);
  assert.deepEqual(result.regenerated, []);
});

test("reset discards every edit", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [{ key: "highlights", body: "hand edit" }],
    reset: true,
  });
  assert.deepEqual(result.sections, [{ key: "highlights", body: "new body" }]);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(result.regenerated, ["highlights"]);
});

test("edited-only section is kept and counted preserved", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [
      { key: "highlights", body: "hand edit" },
      { key: "zeta", body: "user section" },
      { key: "alpha", body: "another user section" },
    ],
  });
  assert.deepEqual(
    result.sections.map((s) => s.key),
    ["highlights", "alpha", "zeta"],
  );
  assert.deepEqual(result.preserved, ["highlights", "alpha", "zeta"]);
  assert.deepEqual(result.regenerated, []);
  const alpha = result.sections.find((s) => s.key === "alpha");
  assert.equal(alpha?.body, "another user section");
});

test("edited-only section is dropped on reset", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [{ key: "zeta", body: "user section" }],
    reset: true,
  });
  assert.deepEqual(
    result.sections.map((s) => s.key),
    ["highlights"],
  );
  assert.deepEqual(result.preserved, []);
});

test("generated-only section is included and counted regenerated", () => {
  const result = mergeRecapUserEdits({
    generated: [
      { key: "highlights", body: "new body" },
      { key: "notes", body: "generated notes" },
    ],
    edited: [{ key: "highlights", body: "hand edit" }],
  });
  const notes = result.sections.find((s) => s.key === "notes");
  assert.equal(notes?.body, "generated notes");
  assert.deepEqual(result.regenerated, ["notes"]);
});

test("whitespace-only edit falls back to generated body", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [{ key: "highlights", body: "  \n\t " }],
  });
  assert.deepEqual(result.sections, [{ key: "highlights", body: "new body" }]);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(result.regenerated, ["highlights"]);
});

test("whitespace-only edited-only key is dropped entirely", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "new body" }],
    edited: [{ key: "zeta", body: "   " }],
  });
  assert.deepEqual(
    result.sections.map((s) => s.key),
    ["highlights"],
  );
  assert.deepEqual(result.preserved, []);
});

test("duplicate keys keep the first occurrence", () => {
  const result = mergeRecapUserEdits({
    generated: [
      { key: "highlights", body: "first generated" },
      { key: "highlights", body: "second generated" },
    ],
    edited: [
      { key: "highlights", body: "first edit" },
      { key: "highlights", body: "second edit" },
    ],
  });
  assert.deepEqual(result.sections, [
    { key: "highlights", body: "first edit" },
  ]);
});

test("duplicate edited-only keys keep the first occurrence", () => {
  const result = mergeRecapUserEdits({
    generated: [{ key: "highlights", body: "gen" }],
    edited: [
      { key: "zeta", body: "first user section" },
      { key: "zeta", body: "second user section" },
    ],
  });
  const zeta = result.sections.find((s) => s.key === "zeta");
  assert.equal(zeta?.body, "first user section");
  assert.equal(result.sections.filter((s) => s.key === "zeta").length, 1);
});

test("output is deterministic across two calls on the same input", () => {
  const input = {
    generated: [
      { key: "notes", body: "generated notes" },
      { key: "highlights", body: "new body" },
    ],
    edited: [
      { key: "zeta", body: "user section" },
      { key: "highlights", body: "hand edit" },
      { key: "alpha", body: "another user section" },
    ],
  };
  const first = mergeRecapUserEdits(input);
  const second = mergeRecapUserEdits(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.sections.map((s) => s.key),
    ["notes", "highlights", "alpha", "zeta"],
  );
});

test("preserved and regenerated are disjoint and cover every output key", () => {
  const result = mergeRecapUserEdits({
    generated: [
      { key: "highlights", body: "new body" },
      { key: "notes", body: "generated notes" },
    ],
    edited: [
      { key: "highlights", body: "hand edit" },
      { key: "zeta", body: "user section" },
    ],
  });
  const outputKeys = result.sections.map((s) => s.key).sort();
  const accounted = [...result.preserved, ...result.regenerated].sort();
  assert.deepEqual(accounted, outputKeys);
  for (const key of result.preserved) {
    assert.equal(result.regenerated.includes(key), false);
  }
});

test("inputs are not mutated", () => {
  const generated: RecapSection[] = [
    { key: "highlights", body: "new body" },
    { key: "notes", body: "generated notes" },
  ];
  const edited: RecapSection[] = [
    { key: "highlights", body: "hand edit" },
    { key: "zeta", body: "user section" },
  ];
  const generatedSnapshot = structuredClone(generated);
  const editedSnapshot = structuredClone(edited);
  mergeRecapUserEdits({ generated, edited, reset: false });
  mergeRecapUserEdits({ generated, edited, reset: true });
  assert.deepEqual(generated, generatedSnapshot);
  assert.deepEqual(edited, editedSnapshot);
});
