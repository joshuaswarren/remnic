import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REFINES_PER_INVOCATION,
  validateRefineRewrite,
} from "./recall-deep-rewrite.js";

const base = {
  currentQuery: "who met at the cafe",
  refinesUsed: 0,
};

test("genuine rewrite succeeds and is trimmed", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinedQuery: "  which people met at the cafe on friday  ",
    }),
    { ok: true, refinedQuery: "which people met at the cafe on friday" },
  );
});

test("success keeps internal whitespace as written", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinedQuery: "which  people  met at the cafe",
    }),
    { ok: true, refinedQuery: "which  people  met at the cafe" },
  );
});

test("refinesUsed 0 is allowed", () => {
  assert.equal(
    validateRefineRewrite({
      ...base,
      refinesUsed: 0,
      refinedQuery: "which people met at the cafe",
    }).ok,
    true,
  );
});

test("refinesUsed 1 is allowed", () => {
  assert.equal(
    validateRefineRewrite({
      ...base,
      refinesUsed: 1,
      refinedQuery: "which people met at the cafe",
    }).ok,
    true,
  );
});

test("refinesUsed 2 gives refine_budget_spent", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinesUsed: 2,
      refinedQuery: "which people met at the cafe",
    }),
    { ok: false, stop: true, reason: "refine_budget_spent" },
  );
});

test("refinesUsed 3 gives refine_budget_spent", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinesUsed: 3,
      refinedQuery: "which people met at the cafe",
    }),
    { ok: false, stop: true, reason: "refine_budget_spent" },
  );
});

test("budget check wins over a valid rewrite", () => {
  assert.deepEqual(
    validateRefineRewrite({
      currentQuery: "who met at the cafe",
      refinedQuery: "completely different and clearly better query",
      refinesUsed: MAX_REFINES_PER_INVOCATION,
    }),
    { ok: false, stop: true, reason: "refine_budget_spent" },
  );
});

test("negative refinesUsed throws", () => {
  assert.throws(
    () => validateRefineRewrite({ ...base, refinedQuery: "new query", refinesUsed: -1 }),
    RangeError,
  );
  assert.throws(
    () => validateRefineRewrite({ ...base, refinedQuery: "new query", refinesUsed: -1 }),
    /refinesUsed/,
  );
});

test("float refinesUsed throws", () => {
  assert.throws(
    () => validateRefineRewrite({ ...base, refinedQuery: "new query", refinesUsed: 1.5 }),
    /refinesUsed/,
  );
});

test("NaN refinesUsed throws", () => {
  assert.throws(
    () => validateRefineRewrite({ ...base, refinedQuery: "new query", refinesUsed: Number.NaN }),
    /refinesUsed/,
  );
});

test("empty string rewrite gives empty_rewrite", () => {
  assert.deepEqual(validateRefineRewrite({ ...base, refinedQuery: "" }), {
    ok: false,
    stop: true,
    reason: "empty_rewrite",
  });
});

test("whitespace-only rewrite gives empty_rewrite", () => {
  assert.deepEqual(validateRefineRewrite({ ...base, refinedQuery: "   " }), {
    ok: false,
    stop: true,
    reason: "empty_rewrite",
  });
});

test("null rewrite gives empty_rewrite", () => {
  assert.deepEqual(validateRefineRewrite({ ...base, refinedQuery: null }), {
    ok: false,
    stop: true,
    reason: "empty_rewrite",
  });
});

test("undefined rewrite gives empty_rewrite", () => {
  assert.deepEqual(validateRefineRewrite({ ...base, refinedQuery: undefined }), {
    ok: false,
    stop: true,
    reason: "empty_rewrite",
  });
});

test("number rewrite gives empty_rewrite", () => {
  assert.deepEqual(validateRefineRewrite({ ...base, refinedQuery: 42 }), {
    ok: false,
    stop: true,
    reason: "empty_rewrite",
  });
});

test("exact duplicate gives identical_rewrite", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinedQuery: "who met at the cafe",
    }),
    { ok: false, stop: true, reason: "identical_rewrite" },
  );
});

test("case-different duplicate gives identical_rewrite", () => {
  assert.deepEqual(
    validateRefineRewrite({
      ...base,
      refinedQuery: "  Who Met At The Cafe  ",
    }),
    { ok: false, stop: true, reason: "identical_rewrite" },
  );
});

test("extra internal whitespace duplicate gives identical_rewrite", () => {
  assert.deepEqual(
    validateRefineRewrite({
      currentQuery: "who met",
      refinedQuery: "who  met",
      refinesUsed: 0,
    }),
    { ok: false, stop: true, reason: "identical_rewrite" },
  );
});

test("every failure carries stop true", () => {
  const failures = [
    validateRefineRewrite({
      ...base,
      refinedQuery: "fine",
      refinesUsed: 2,
    }),
    validateRefineRewrite({ ...base, refinedQuery: "   " }),
    validateRefineRewrite({ ...base, refinedQuery: "who met at the cafe" }),
  ];
  for (const failure of failures) {
    assert.equal(failure.ok, false);
    assert.equal(failure.stop, true);
  }
});
