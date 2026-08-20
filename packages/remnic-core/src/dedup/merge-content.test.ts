import assert from "node:assert/strict";
import test from "node:test";

import {
  MERGE_CONTENT_LENGTH_FACTOR,
  checkMergedContent,
} from "./merge-content.js";

const INCOMING = "alpha";
const TARGET = "beta";

test("normal merge passes and returns the content unchanged", () => {
  const merged = "alpha and beta combined";
  const result = checkMergedContent({
    mergedContent: merged,
    incomingContent: INCOMING,
    targetContent: TARGET,
  });
  assert.deepEqual(result, { ok: true, content: merged });
});

test("merged content at exactly the limit is accepted", () => {
  const limit = MERGE_CONTENT_LENGTH_FACTOR * (INCOMING.length + TARGET.length);
  const merged = "x".repeat(limit);
  const result = checkMergedContent({
    mergedContent: merged,
    incomingContent: INCOMING,
    targetContent: TARGET,
  });
  assert.deepEqual(result, { ok: true, content: merged });
});

test("merged content one character over the limit is oversized with the reported limit", () => {
  const limit = MERGE_CONTENT_LENGTH_FACTOR * (INCOMING.length + TARGET.length);
  const result = checkMergedContent({
    mergedContent: "x".repeat(limit + 1),
    incomingContent: INCOMING,
    targetContent: TARGET,
  });
  assert.deepEqual(result, { ok: false, reason: "oversized", limit });
});

test("empty, whitespace-only, null, undefined, object, and bigint merged content are all empty refusals", () => {
  const cases: unknown[] = ["", "   ", "\t\n", null, undefined, { body: 1 }, 42n];
  for (const mergedContent of cases) {
    const result = checkMergedContent({
      mergedContent,
      incomingContent: INCOMING,
      targetContent: TARGET,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "empty",
      limit: MERGE_CONTENT_LENGTH_FACTOR * (INCOMING.length + TARGET.length),
    });
  }
});

test("two empty inputs make the limit zero, so any content is oversized", () => {
  const result = checkMergedContent({
    mergedContent: "x",
    incomingContent: "",
    targetContent: "",
  });
  assert.deepEqual(result, { ok: false, reason: "oversized", limit: 0 });
});

test("non-string incomingContent throws RangeError naming the field", () => {
  assert.throws(
    () =>
      checkMergedContent({
        mergedContent: "ok",
        incomingContent: 7 as unknown as string,
        targetContent: TARGET,
      }),
    (error: unknown) =>
      error instanceof RangeError && /incomingContent/.test(error.message),
  );
});

test("non-string targetContent throws RangeError naming the field", () => {
  assert.throws(
    () =>
      checkMergedContent({
        mergedContent: "ok",
        incomingContent: INCOMING,
        targetContent: null as unknown as string,
      }),
    (error: unknown) =>
      error instanceof RangeError && /targetContent/.test(error.message),
  );
});

test("the rejected merged content never appears in an error message or refusal result", () => {
  const sentinel = "UNIQUE-LEAK-SENTINEL";
  const leakyObject = { body: sentinel };

  const refusal = checkMergedContent({
    mergedContent: leakyObject,
    incomingContent: INCOMING,
    targetContent: TARGET,
  });
  assert.ok(!refusal.ok);
  assert.ok(!JSON.stringify(refusal).includes(sentinel));

  assert.throws(
    () =>
      checkMergedContent({
        mergedContent: sentinel,
        incomingContent: undefined as unknown as string,
        targetContent: TARGET,
      }),
    (error: unknown) =>
      error instanceof RangeError && !error.message.includes(sentinel),
  );
});
