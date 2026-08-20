import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListQuery,
  buildResolveMutation,
  collectPageInfo,
  collectUnresolved,
  uniqueThreadIds,
} from "../scripts/pr-review-threads.mjs";

test("one query covers every PR", () => {
  const query = buildListQuery("owner", "repo", [10, 11]);
  assert.match(query, /pr10: pullRequest\(number: 10\)/);
  assert.match(query, /pr11: pullRequest\(number: 11\)/);
  // The whole point: a single repository selection, not one request per PR.
  assert.equal(query.match(/repository\(/g).length, 1);
});

test("invalid PR numbers are refused", () => {
  assert.throws(() => buildListQuery("o", "r", []), /no PR numbers/);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildListQuery("o", "r", [bad]), /positive integer/);
  }
});

test("one mutation covers every thread and drops duplicates", () => {
  const mutation = buildResolveMutation(["PRRT_a", "PRRT_b", "PRRT_a"]);
  assert.equal(mutation.match(/resolveReviewThread/g).length, 2);
  assert.match(mutation, /t0: resolveReviewThread\(input: \{ threadId: "PRRT_a" \}\)/);
  assert.match(mutation, /t1: resolveReviewThread\(input: \{ threadId: "PRRT_b" \}\)/);
});

test("blank, padded, and non-string thread ids are refused", () => {
  assert.throws(() => buildResolveMutation([]), /no thread ids/);
  for (const bad of ["", "   ", " PRRT_a", 7]) {
    assert.throws(() => buildResolveMutation([bad]), /trimmed non-blank string/);
  }
});

test("only unresolved threads are collected, in deterministic order", () => {
  const rows = collectUnresolved({
    data: {
      repository: {
        pr20: {
          reviewThreads: {
            nodes: [
              { id: "PRRT_z", isResolved: false, comments: { nodes: [{ author: { login: "bot-b" } }] } },
              { id: "PRRT_a", isResolved: false, comments: { nodes: [{ author: { login: "bot-a" } }] } },
              { id: "PRRT_done", isResolved: true, comments: { nodes: [] } },
            ],
          },
        },
        pr9: {
          reviewThreads: {
            nodes: [{ id: "PRRT_m", isResolved: false, comments: { nodes: [] } }],
          },
        },
      },
    },
  });
  assert.deepEqual(
    rows.map((row) => `PR${row.pr}:${row.threadId}:${row.author}`),
    ["PR9:PRRT_m:unknown", "PR20:PRRT_a:bot-a", "PR20:PRRT_z:bot-b"],
    "PRs sort numerically, threads by id, resolved threads are excluded",
  );
});

test("a missing or null PR field does not throw", () => {
  const rows = collectUnresolved({ data: { repository: { pr1: null, other: {} } } });
  assert.deepEqual(rows, []);
});

// Review: a PR with more than one page of threads silently truncated, so the
// helper could report "none unresolved" while the review guard stayed red.
test("pagination cursors are threaded into the query", () => {
  const first = buildListQuery("o", "r", [7]);
  assert.match(first, /reviewThreads\(first: 50\)/);
  assert.match(first, /pageInfo \{ hasNextPage endCursor \}/);
  const next = buildListQuery("o", "r", [7], { 7: "CURSOR1" });
  assert.match(next, /reviewThreads\(first: 50, after: "CURSOR1"\)/);
});

test("only truncated PRs are revisited", () => {
  const more = collectPageInfo({
    data: {
      repository: {
        pr1: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [] } },
        pr2: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: "C2" }, nodes: [] } },
      },
    },
  });
  assert.deepEqual(more, { 1: "C1" }, "a completed PR is not requeried");
});

// Review: the exit status compared against the caller's duplicate-inclusive
// count, so a fully successful resolve exited 1.
test("unique ids are what a resolve run is measured against", () => {
  assert.deepEqual(uniqueThreadIds(["PRRT_a", "PRRT_b", "PRRT_a"]), ["PRRT_a", "PRRT_b"]);
  assert.throws(() => uniqueThreadIds([" PRRT_a"]), /trimmed non-blank string/);
  const mutation = buildResolveMutation(["PRRT_a", "PRRT_a"]);
  assert.equal(mutation.match(/resolveReviewThread/g).length, 1);
});
