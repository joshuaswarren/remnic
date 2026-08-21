import test from "node:test";
import assert from "node:assert/strict";
import { expandQuery } from "../src/retrieval.ts";
import { parseRerankResponse } from "../src/rerank.ts";

test("expandQuery returns original query first", () => {
  const q = "mission control cron issues and timeouts";
  const out = expandQuery(q, { maxQueries: 4, minTokenLen: 3 });
  assert.equal(out[0], q);
});

test("expandQuery produces at least one expansion for multi-word input", () => {
  const q = "mission control cron issues and timeouts";
  const out = expandQuery(q, { maxQueries: 4, minTokenLen: 3 });
  assert.ok(out.length >= 2);
});

test("parseRerankResponse handles missing ids deterministically", () => {
  const raw = JSON.stringify({
    scores: [
      { id: "a", score: 90 },
      { id: "missing", score: 100 },
      { id: "b", score: 10 },
    ],
  });
  const candidates = [
    { id: "a", originalIndex: 0 },
    { id: "b", originalIndex: 1 },
    { id: "c", originalIndex: 2 },
  ];

  const scored = parseRerankResponse(raw, candidates);
  assert.deepEqual(
    scored.map((x) => x.id),
    ["a", "b", "c"],
  );
});
