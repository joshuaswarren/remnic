import assert from "node:assert/strict";
import test from "node:test";

import { selectRecapForDay } from "./recap-fallback.js";

test("ai wins when present, body returned verbatim", () => {
  const result = selectRecapForDay({
    ai: { body: "  AI recap  ", kind: "ai" },
    previous: { body: "stored journal", kind: "previous" },
    deterministic: { body: "deterministic render", kind: "deterministic" },
  });
  assert.deepEqual(result, { ok: true, body: "  AI recap  ", kind: "ai" });
});

test("provider failure with a stored previous returns the previous body and carries the failure", () => {
  const result = selectRecapForDay({
    previous: { body: "stored journal", kind: "previous" },
    deterministic: { body: "deterministic render", kind: "deterministic" },
    failure: "provider_unavailable",
  });
  assert.deepEqual(result, {
    ok: true,
    body: "stored journal",
    kind: "previous",
    failure: "provider_unavailable",
  });
});

test("failure with no previous falls to deterministic and still carries the failure", () => {
  const result = selectRecapForDay({
    deterministic: { body: "deterministic render", kind: "deterministic" },
    failure: "timeout",
  });
  assert.deepEqual(result, {
    ok: true,
    body: "deterministic render",
    kind: "deterministic",
    failure: "timeout",
  });
});

test("blank ai body falls through to previous", () => {
  const result = selectRecapForDay({
    ai: { body: "   ", kind: "ai" },
    previous: { body: "stored journal", kind: "previous" },
  });
  assert.deepEqual(result, {
    ok: true,
    body: "stored journal",
    kind: "previous",
  });
});

test("blank previous falls through to deterministic", () => {
  const result = selectRecapForDay({
    previous: { body: "", kind: "previous" },
    deterministic: { body: "deterministic render", kind: "deterministic" },
  });
  assert.deepEqual(result, {
    ok: true,
    body: "deterministic render",
    kind: "deterministic",
  });
});

test("all candidates absent gives no_recap_available without failure key", () => {
  const result = selectRecapForDay({});
  assert.deepEqual(result, { ok: false, error: "no_recap_available" });
  assert.ok(!("failure" in result));
});

test("all candidates blank with a failure reports the failure", () => {
  const result = selectRecapForDay({
    ai: { body: " ", kind: "ai" },
    deterministic: { body: "", kind: "deterministic" },
    failure: "malformed_json",
  });
  assert.deepEqual(result, {
    ok: false,
    error: "no_recap_available",
    failure: "malformed_json",
  });
});

test("a mislabelled candidate throws", () => {
  assert.throws(
    () =>
      selectRecapForDay({
        previous: { body: "stored journal", kind: "ai" },
      }),
    /kind/,
  );
});

test("an unknown kind throws and lists the allow-list", () => {
  assert.throws(
    () =>
      selectRecapForDay({
        // @ts-expect-error deliberately invalid kind
        ai: { body: "AI recap", kind: "carrier-pigeon" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(String(error), /kind/);
      assert.match(String(error), /ai, deterministic, previous/);
      return true;
    },
  );
});

test("blank failure is omitted from the result object", () => {
  const result = selectRecapForDay({
    deterministic: { body: "deterministic render", kind: "deterministic" },
    failure: "   ",
  });
  assert.deepEqual(result, {
    ok: true,
    body: "deterministic render",
    kind: "deterministic",
  });
  assert.ok(!("failure" in result));

  const none = selectRecapForDay({
    failure: null,
  });
  assert.ok(!("failure" in none));
});

test("input is not mutated", () => {
  const input = {
    ai: { body: "  AI recap  ", kind: "ai" },
    previous: { body: "stored journal", kind: "previous" },
    deterministic: { body: "deterministic render", kind: "deterministic" },
    failure: "rate_limited",
  } as const;
  const snapshot = structuredClone(input);
  selectRecapForDay(input);
  assert.deepEqual(input, snapshot);
});
