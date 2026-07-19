import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ROUND_COMMENT_MARKER } from "../scripts/review-rounds.mjs";
import {
  FORCE_DISPATCH_LABEL,
  PUSH_WARN_THRESHOLD,
  computeRoundGateDecision,
  runRoundGate,
} from "../scripts/review-round-gate.mjs";

const botAliases = ["cursor", "cursor-bugbot", "cursor[bot]", "cursor-bugbot[bot]"];
const debounceMs = 600_000;
const maxAgeMs = 86_400_000;

const loadFixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/review-rounds/${name}`, import.meta.url)), "utf8"));

function botReview(headSha, at) {
  return { id: `review-${at}`, author: { login: "cursor" }, commit_id: headSha, submitted_at: at };
}

function openThreads(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index + 1}`,
    isResolved: false,
    comments: { nodes: [{ author: { login: "cursor" }, path: `src/file-${index + 1}.ts` }] },
  }));
}

function decide(overrides = {}) {
  return computeRoundGateDecision({
    headSha: "head-1",
    headCommittedAt: "2026-07-18T11:59:00.000Z",
    now: "2026-07-18T12:00:00.000Z",
    reviews: [botReview("head-1", "2026-07-18T12:00:00.000Z")],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
    ...overrides,
  });
}

test("first current-head bot activity opens round 1 and writes an owned ledger", () => {
  const result = decide();
  assert.equal(result.decision.action, "open");
  assert.equal(result.telemetry.round, 1);
  assert.equal(result.telemetry.dispatch, false);
  assert.equal(result.telemetry.pushes, 0);
  assert.match(result.commentBody, new RegExp(ROUND_COMMENT_MARKER));
  assert.match(result.commentBody, /Transactional review round/);
});

test("a push during an open round updates the head but never dispatches", () => {
  const opened = decide();
  const pushed = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-2",
    headCommittedAt: "2026-07-18T12:01:00.000Z",
    now: "2026-07-18T12:01:30.000Z",
    reviews: [],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(pushed.telemetry.dispatch, false);
  assert.equal(pushed.telemetry.pushes, 1);
  assert.equal(pushed.state.headSha, "head-2");
});

test("micro-push telemetry warns once pushes exceed the batch threshold", () => {
  let body = decide().commentBody;
  let result;
  for (let push = 1; push <= PUSH_WARN_THRESHOLD + 1; push += 1) {
    result = computeRoundGateDecision({
      ledgerBody: body,
      headSha: `head-${push + 1}`,
      headCommittedAt: `2026-07-18T12:0${push}:00.000Z`,
      now: `2026-07-18T12:0${push}:30.000Z`,
      reviews: [],
      threads: openThreads(2),
      botAliases,
      debounceMs,
      maxAgeMs,
    });
    body = result.commentBody;
  }
  assert.equal(result.telemetry.pushes, PUSH_WARN_THRESHOLD + 1);
  assert.equal(result.telemetry.batchWarning, true);
  assert.match(result.summary, /exceeds the batch rule/);
  assert.equal(result.telemetry.dispatch, false, "an open round never dispatches on a push");
});

test("resolving every round thread dispatches only after the debounce elapses", () => {
  const opened = decide();
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const early = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:09:59.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(early.telemetry.dispatch, false);

  const late = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:10:00.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(late.telemetry.dispatch, true);
  assert.equal(late.telemetry.reason, "round-complete");
});

test("the force-dispatch label bypasses the debounce", () => {
  const opened = decide();
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const forced = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:00:05.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    forceDispatch: true,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(forced.telemetry.dispatch, true);
  assert.equal(forced.telemetry.reason, "force-label");
});

test("unresolved round threads are surfaced in the summary, not hidden", () => {
  const result = decide();
  assert.equal(result.telemetry.unresolvedCount, 2);
  assert.match(result.summary, /Unresolved round threads/);
  assert.match(result.summary, /src\/file-1\.ts/);
});

test("a corrupt ledger body is treated as no prior round (recovery)", () => {
  const corrupt = `noise\n<!-- ${ROUND_COMMENT_MARKER}\n{"version":1,"status":"broken"}\n-->\ntail`;
  const result = computeRoundGateDecision({
    ledgerBody: corrupt,
    headSha: "head-1",
    headCommittedAt: "2026-07-18T11:59:00.000Z",
    now: "2026-07-18T12:00:00.000Z",
    reviews: [botReview("head-1", "2026-07-18T12:00:00.000Z")],
    threads: openThreads(1),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(result.priorState, null);
  assert.equal(result.decision.action, "open");
  assert.equal(result.telemetry.round, 1);
});

test("a valid ledger body resumes the prior round (persistence round-trip)", () => {
  const opened = decide();
  const resumed = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:02:00.000Z",
    reviews: [],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(resumed.priorState.round, 1);
  assert.equal(resumed.telemetry.round, 1);
});

function replayThroughDriver(fixture) {
  const threads = openThreads(fixture.initialThreadCount);
  const resolved = threads.map((thread) => ({ ...thread, isResolved: true }));
  const commitTimeByHead = new Map(fixture.commits.map(([sha, at]) => [sha, at]));
  const commits = fixture.commits.map(([headSha, now]) => ({ headSha, now, review: null }));
  const reviews = fixture.botActivityAt.map((now) => {
    const headSha = commits.findLast((commit) => Date.parse(commit.now) <= Date.parse(now))?.headSha;
    if (!headSha) throw new Error(`fixture bot activity precedes commits: ${now}`);
    return { headSha, now, review: botReview(headSha, now) };
  });
  const events = [...commits, ...reviews].sort((a, b) => Date.parse(a.now) - Date.parse(b.now));

  let body = "";
  let dispatches = 0;
  for (const { headSha, now, review } of events) {
    const result = computeRoundGateDecision({
      ledgerBody: body,
      headSha,
      headCommittedAt: commitTimeByHead.get(headSha) ?? null,
      now,
      reviews: review ? [review] : [],
      threads,
      botAliases,
      debounceMs,
      maxAgeMs,
    });
    body = result.commentBody;
    if (result.telemetry.dispatch) dispatches += 1;
  }

  const settled = computeRoundGateDecision({
    ledgerBody: body,
    headSha: fixture.commits.at(-1)[0],
    headCommittedAt: fixture.commits.at(-1)[1],
    now: fixture.settledAt,
    reviews: [],
    threads: resolved,
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  if (settled.telemetry.dispatch) dispatches += 1;
  return { dispatches, settled };
}

for (const name of ["pr-1852.json", "pr-1923.json"]) {
  test(`driver replay of ${name} collapses churn to <=3 dispatched rounds with no thread left unreviewed`, () => {
    const fixture = loadFixture(name);
    const { dispatches, settled } = replayThroughDriver(fixture);
    assert.ok(dispatches >= 1, "expected at least one dispatch");
    assert.ok(dispatches <= 3, `expected <=3 dispatches, got ${dispatches}`);
    assert.equal(settled.telemetry.unresolvedCount, 0, "no thread left unreviewed at settle");
  });
}

function fakeGithub({ existingComments = [], threads = [], labels = [], draft = false } = {}) {
  const calls = { created: [], updated: [], graphql: 0 };
  const listComments = () => {};
  const listReviews = () => {};
  const listReviewComments = () => {};
  const listForRef = () => {};
  listComments.__data = existingComments;
  listReviews.__data = [];
  listReviewComments.__data = [];
  listForRef.__data = [];
  const github = {
    paginate: async (fn) => fn.__data ?? [],
    graphql: async () => {
      calls.graphql += 1;
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } } };
    },
    rest: {
      pulls: {
        get: async () => ({ data: { draft, head: { sha: "head-1" }, labels } }),
        listReviews,
        listReviewComments,
      },
      issues: {
        listComments,
        createComment: async (args) => calls.created.push(args),
        updateComment: async (args) => calls.updated.push(args),
        addLabels: async () => {},
        removeLabel: async () => {},
      },
      repos: {
        getCommit: async () => ({ data: { commit: { committer: { date: "2026-07-18T11:59:00.000Z" } } } }),
      },
      checks: { listForRef },
    },
  };
  return { github, calls };
}

const context = { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } };
const core = { notice() {}, info() {}, warning() {}, setFailed() {} };

test("runRoundGate creates an owned ledger comment and does not dispatch in shadow mode", async () => {
  const { github, calls } = fakeGithub({ threads: openThreads(2) });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.ok(result, "expected a decision");
  assert.equal(calls.created.length, 1, "one ledger comment created");
  assert.match(calls.created[0].body, new RegExp(ROUND_COMMENT_MARKER));
  // Shadow mode: the ONLY comment is the ledger — no @coderabbitai/@codex trigger.
  assert.ok(!calls.created.some((c) => /@coderabbitai|@codex/.test(c.body)), "no dispatch trigger in shadow mode");
});

test("runRoundGate updates the existing ledger comment instead of creating a new one", async () => {
  const seed = decide().commentBody;
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 99, body: seed }],
    threads: openThreads(2),
  });
  await runRoundGate({ github, context, core, env: {} });
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].comment_id, 99);
});

test("runRoundGate skips draft pull requests", async () => {
  const { github, calls } = fakeGithub({ draft: true, threads: openThreads(1) });
  const result = await runRoundGate({ github, context, core, env: {} });
  assert.equal(result, null);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 0);
});

test("runRoundGate honors the force-dispatch label but stays shadow without enforcement", async () => {
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 5, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
  });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.equal(result.telemetry.dispatch, true);
  assert.equal(result.telemetry.reason, "force-label");
  assert.ok(!calls.created.some((c) => /@coderabbitai|@codex/.test(c.body)), "shadow mode suppresses trigger even when forced");
});
