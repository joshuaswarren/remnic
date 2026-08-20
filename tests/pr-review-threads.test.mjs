import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListQuery,
  buildResolveMutation,
  assertCursorsAdvance,
  assertRepoIdentifier,
  assertThreadId,
  collectPageInfo,
  collectUnresolved,
  graphqlString,
  parseRepoSlug,
  threadIdsFromStdin,
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

// Review round 2: interpolated values could change the GraphQL operation that
// runs under the configured gh credential (GraphQL injection, not shell).
test("string values are serialized, not pasted", () => {
  assert.equal(graphqlString('a"b', "x"), '"a\\"b"');
  assert.equal(graphqlString("a\\b", "x"), '"a\\\\b"');
  assert.throws(() => graphqlString("", "x"), /non-empty string/);
});

test("repo identifiers and thread ids are charset-checked", () => {
  assert.throws(() => assertRepoIdentifier('r" ) { x }', "repo"), /must match/);
  assert.throws(() => assertThreadId('PRRT_" ) { a }'), /must match/);
  assert.equal(assertThreadId("PRRT_kwDO-a_b="), "PRRT_kwDO-a_b=");
});

test("a hostile cursor cannot escape its string literal", () => {
  const query = buildListQuery("o", "r", [1], { 1: 'x" ) { evil }' });
  assert.match(query, /after: "x\\" \) \{ evil \}"/, "the quote is escaped in place");
  assert.equal(query.match(/reviewThreads\(/g).length, 1, "no extra selection was injected");
});

// Review round 2: the documented `list | resolve` pipe read only argv.
test("thread ids are recovered from piped list output", () => {
  const piped = "PR2759 PRRT_aaa coderabbitai\nPR2760 PRRT_bbb codex\n";
  assert.deepEqual(threadIdsFromStdin(() => piped), ["PRRT_aaa", "PRRT_bbb"]);
  assert.deepEqual(threadIdsFromStdin(() => ""), []);
});

// Review round 3: an adjacent-duplicate check misses a longer cycle, which
// keeps issuing requests until the rate limiter stops them.
test("a cursor cycle longer than one step is caught", () => {
  const seen = new Map();
  assertCursorsAdvance(seen, { 1: "C1" });
  assertCursorsAdvance(seen, { 1: "C2" });
  assert.throws(() => assertCursorsAdvance(seen, { 1: "C1" }), /cursor C1 twice/);
});

test("distinct PRs do not share cursor history", () => {
  const seen = new Map();
  assertCursorsAdvance(seen, { 1: "C1", 2: "C1" });
  assert.throws(() => assertCursorsAdvance(seen, { 2: "C1" }), /PR 2 returned cursor C1 twice/);
});

// Review round 3: owner/repo/extra silently queried owner/repo.
test("a slug must be exactly owner/repo", () => {
  assert.deepEqual(parseRepoSlug("o/r"), { owner: "o", repo: "r" });
  for (const bad of ["o/r/extra", "o/", "/r", "o", "", "o//r"]) {
    assert.throws(() => parseRepoSlug(bad), /exactly owner\/repo|must match/, `accepted ${bad}`);
  }
});

// Review: `list owner/repo` with no numbers exited 0 with no output, which
// reads exactly like "no unresolved threads".
test("list refuses an empty PR set at both layers", () => {
  assert.throws(() => buildListQuery("o", "r", []), /no PR numbers given/);
  assert.throws(() => buildResolveMutation([]), /no thread ids given/);
});
